import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
  spyOn,
} from "bun:test";
import { Logger } from "../../../../../packages/core/src/common";
import {
  CommandBus,
  EventBus,
  UnhandledExceptionBus,
  type CqrsModuleOptions,
  type ISaga,
} from "../../../../../packages/messaging/src/cqrs";
import { describeConformance, itAdapted } from "../../../_helpers";

class OrderEvent {
  constructor(public readonly valid: boolean) {}
}

class InitCommand {}

const LOOP_GUARD = 1000;

async function flushMicrotasks(ticks = 6): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    await Promise.resolve();
  }
}

async function advanceTimersByTimeAsync(ms: number): Promise<void> {
  jest.advanceTimersByTime(ms);
  await flushMicrotasks();
}

describeConformance(
  "EventBus",
  {
    upstreamPath: "nestjs/cqrs/src/event-bus.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-008"],
    notes:
      "Adapts RxJS Observable sagas (pipe/map/defer/shareReplay/startWith/combineLatest) to Bunest zero-RxJS Promise/AsyncIterable @Saga() functions (ADR-008) and Vitest fake timers to Bun jest.useFakeTimers().",
  },
  () => {
    describe("when a saga throws", () => {
      let eventBus: EventBus;
      let executedCommands: unknown[];
      let errors: number;
      let loggerSpy: ReturnType<typeof spyOn>;

      const createEventBus = (options?: CqrsModuleOptions) => {
        const commandBus = {
          execute: async (command: unknown) => {
            executedCommands.push(command);
          },
        } as unknown as CommandBus;
        const unhandledExceptionBus = new UnhandledExceptionBus();
        eventBus = new EventBus(
          commandBus,
          {} as any,
          unhandledExceptionBus,
          options,
        );
        unhandledExceptionBus.subscribe(() => {
          errors++;
          if (errors === LOOP_GUARD) {
            eventBus.onModuleDestroy();
          }
        });
      };

      const registerSaga = (saga: ISaga<any>) => eventBus.registerSaga(saga);

      const throwOnInvalid: ISaga<OrderEvent> = (event: OrderEvent) => {
        if (!event.valid) {
          throw new Error("invalid order");
        }
        return { type: "command" };
      };

      beforeEach(() => {
        jest.useFakeTimers({ now: 1_700_000_000_000 });
        executedCommands = [];
        errors = 0;
        loggerSpy = spyOn(Logger.prototype, "error").mockImplementation(
          () => {},
        );
      });

      afterEach(() => {
        eventBus?.onModuleDestroy();
        loggerSpy.mockRestore();
        jest.useRealTimers();
      });

      describe("by default", () => {
        it("should stop reacting to later events [ADR-008: zero-RxJS saga function]", async () => {
          createEventBus();
          registerSaga(throwOnInvalid);

          await eventBus.publish(new OrderEvent(false));
          await advanceTimersByTimeAsync(60_000);
          await eventBus.publish(new OrderEvent(true));
          await advanceTimersByTimeAsync(0);

          expect(errors).toBe(1);
          expect(executedCommands).toHaveLength(0);
        });

        itAdapted(
          "ADR-008",
          "should run commands emitted before error once",
          async () => {
            createEventBus({ sagaErrorStrategy: "complete" });
            registerSaga(async function* (event: OrderEvent) {
              yield new InitCommand();
              if (!event.valid) {
                throw new Error("invalid order");
              }
            });

            await eventBus.publish(new OrderEvent(false));
            await advanceTimersByTimeAsync(60_000);
            await eventBus.publish(new OrderEvent(false));
            await advanceTimersByTimeAsync(60_000);

            expect(executedCommands).toHaveLength(1);
          },
          "zero-RxJS AsyncGenerator saga with sagaErrorStrategy: 'complete'",
        );
      });

      describe('with sagaErrorStrategy set to "resubscribe"', () => {
        beforeEach(() => createEventBus({ sagaErrorStrategy: "resubscribe" }));

        it("should keep reacting to events after errors on separate events [ADR-008: zero-RxJS saga resubscribe recovery]", async () => {
          registerSaga(throwOnInvalid);

          for (let i = 0; i < 12; i++) {
            await eventBus.publish(new OrderEvent(false));
            await advanceTimersByTimeAsync(60_000);
          }
          await eventBus.publish(new OrderEvent(true));
          await advanceTimersByTimeAsync(0);

          expect(errors).toBe(12);
          expect(executedCommands).toHaveLength(1);
          expect(loggerSpy).toHaveBeenCalledTimes(12);
        });

        itAdapted(
          "ADR-008",
          "should double the delay before each resubscription up to 30 seconds",
          async () => {
            const observedDelays: number[] = [];
            registerSaga(() => {
              throw new Error("fails on event");
            });

            // Trigger initial error (starts 100ms pause)
            await eventBus.publish(new OrderEvent(false));
            expect(errors).toBe(1);

            for (let round = 0; round < 12; round++) {
              let elapsed = 0;
              const step = 100;
              while (elapsed < 35_000) {
                await advanceTimersByTimeAsync(step);
                elapsed += step;
                const countBefore = errors;
                await eventBus.publish(new OrderEvent(false));
                if (errors > countBefore) {
                  observedDelays.push(elapsed);
                  break;
                }
              }
            }

            expect(observedDelays.slice(0, 12)).toEqual([
              100, 200, 400, 800, 1600, 3200, 6400, 12800, 25600, 30_000,
              30_000, 30_000,
            ]);
            expect(executedCommands).toHaveLength(0);
          },
          "zero-RxJS exponential backoff pause probing",
        );

        itAdapted(
          "ADR-008",
          "should keep growing the delay for errors less than a minute apart",
          async () => {
            const expectedBackoffs = [100, 200, 400, 800, 1600];
            registerSaga(throwOnInvalid);

            for (const expectedDelay of expectedBackoffs) {
              await eventBus.publish(new OrderEvent(false));

              // Still paused 1ms before backoff expires
              await advanceTimersByTimeAsync(expectedDelay - 1);
              const beforeCmds = executedCommands.length;
              await eventBus.publish(new OrderEvent(true));
              expect(executedCommands.length).toBe(beforeCmds);

              // Resumes once the backoff elapses
              await advanceTimersByTimeAsync(1);
              await eventBus.publish(new OrderEvent(true));
              expect(executedCommands.length).toBe(beforeCmds + 1);

              // Wait remaining time to total 10_000ms (< 60_000ms reset window)
              await advanceTimersByTimeAsync(10_000 - expectedDelay);
            }
          },
          "zero-RxJS growing backoff under 60s window",
        );

        itAdapted(
          "ADR-008",
          "should start again from 100 ms only once a full minute has passed",
          async () => {
            registerSaga(throwOnInvalid);

            // Error 1 -> 100ms pause
            await eventBus.publish(new OrderEvent(false));
            await advanceTimersByTimeAsync(99);
            await eventBus.publish(new OrderEvent(true));
            expect(executedCommands).toHaveLength(0);
            await advanceTimersByTimeAsync(1);
            await eventBus.publish(new OrderEvent(true));
            expect(executedCommands).toHaveLength(1);

            // Advance to 59_999ms total since Error 1 (< 60_000ms) -> Error 2 should pause 200ms
            await advanceTimersByTimeAsync(59_899);
            await eventBus.publish(new OrderEvent(false));
            await advanceTimersByTimeAsync(199);
            await eventBus.publish(new OrderEvent(true));
            expect(executedCommands).toHaveLength(1);
            await advanceTimersByTimeAsync(1);
            await eventBus.publish(new OrderEvent(true));
            expect(executedCommands).toHaveLength(2);

            // Advance to 60_000ms total since Error 2 -> Error 3 should reset pause to 100ms
            await advanceTimersByTimeAsync(59_800);
            await eventBus.publish(new OrderEvent(false));
            await advanceTimersByTimeAsync(99);
            await eventBus.publish(new OrderEvent(true));
            expect(executedCommands).toHaveLength(2);
            await advanceTimersByTimeAsync(1);
            await eventBus.publish(new OrderEvent(true));
            expect(executedCommands).toHaveLength(3);
          },
          "zero-RxJS 60s backoff reset boundary",
        );

        itAdapted(
          "ADR-008",
          "should start again from 100 ms after a minute without errors",
          async () => {
            const day = 24 * 60 * 60 * 1000;
            registerSaga(throwOnInvalid);

            for (let i = 0; i < 10; i++) {
              await eventBus.publish(new OrderEvent(false));
              // Verify pause is 100ms (not growing)
              await advanceTimersByTimeAsync(100);
              await advanceTimersByTimeAsync(day - 100);
            }
            await eventBus.publish(new OrderEvent(false));
            await advanceTimersByTimeAsync(5000);
            for (let i = 0; i < 20; i++) {
              await eventBus.publish(new OrderEvent(true));
              await advanceTimersByTimeAsync(1000);
            }

            expect(errors).toBe(11);
            expect(executedCommands).toHaveLength(20);
          },
          "zero-RxJS backoff reset after long quiet period",
        );

        itAdapted(
          "ADR-008",
          "should not reset the delay after a successful event",
          async () => {
            registerSaga(throwOnInvalid);

            // Error 1 -> 100ms backoff
            await eventBus.publish(new OrderEvent(false));
            await advanceTimersByTimeAsync(10_000);

            // Successful event does NOT reset backoff
            await eventBus.publish(new OrderEvent(true));
            expect(executedCommands).toHaveLength(1);

            // Error 2 (10s after Error 1) -> must pause 200ms (not 100ms)
            await eventBus.publish(new OrderEvent(false));
            await advanceTimersByTimeAsync(100);
            await eventBus.publish(new OrderEvent(true));
            expect(executedCommands).toHaveLength(1);

            await advanceTimersByTimeAsync(100);
            await eventBus.publish(new OrderEvent(true));
            expect(executedCommands).toHaveLength(2);
          },
          "zero-RxJS backoff persists across successful events",
        );

        itAdapted(
          "ADR-008",
          "should bound by time a saga that repeatedly fails during rapid event bursts",
          async () => {
            registerSaga(async function* (event: OrderEvent) {
              if (event.valid) {
                yield { type: "command" };
              } else {
                yield { type: "command" };
                throw new Error("invalid order");
              }
            });

            // Simulate repeated failing events every 50ms over 1000ms:
            // Error at 0ms (pause 100ms), error at 100ms (pause 200ms -> 300ms),
            // error at 300ms (pause 400ms -> 700ms), error at 700ms (pause 800ms -> 1500ms).
            for (let t = 0; t <= 1000; t += 50) {
              await eventBus.publish(new OrderEvent(false));
              if (t < 1000) {
                await advanceTimersByTimeAsync(50);
              }
            }

            expect(errors).toBe(4);
            expect(executedCommands).toHaveLength(4);
          },
          "zero-RxJS backoff bounds rapid failing saga events",
        );

        itAdapted(
          "ADR-008",
          "should let timers fire while a saga fails on a rejected promise",
          async () => {
            let errorsWhenTimerFired: number | undefined;
            setTimeout(() => {
              errorsWhenTimerFired = errors;
            }, 50);

            registerSaga(async () => {
              throw new Error("missing configuration");
            });

            await eventBus.publish(new OrderEvent(false));
            await advanceTimersByTimeAsync(50);
            expect(errorsWhenTimerFired).toBe(1);

            // Continue triggering past 100ms, 300ms, 700ms backoff windows
            await advanceTimersByTimeAsync(50);
            await eventBus.publish(new OrderEvent(false));
            await advanceTimersByTimeAsync(200);
            await eventBus.publish(new OrderEvent(false));
            await advanceTimersByTimeAsync(400);
            await eventBus.publish(new OrderEvent(false));
            await advanceTimersByTimeAsync(300);

            expect(errors).toBe(4);
          },
          "zero-RxJS rejected promise saga does not starve timers",
        );

        itAdapted(
          "ADR-008",
          "should run commands emitted before error again after every error recovery",
          async () => {
            registerSaga(async function* (event: OrderEvent) {
              yield new InitCommand();
              if (!event.valid) {
                throw new Error("invalid order");
              }
            });

            await eventBus.publish(new OrderEvent(false));
            await advanceTimersByTimeAsync(60_000);
            await eventBus.publish(new OrderEvent(false));
            await advanceTimersByTimeAsync(60_000);
            await eventBus.publish(new OrderEvent(true));
            await advanceTimersByTimeAsync(0);

            expect(
              executedCommands.filter(
                (command) => command instanceof InitCommand,
              ),
            ).toHaveLength(3);
          },
          "zero-RxJS AsyncGenerator saga re-runs after recovery",
        );
      });

      describe("with rethrowUnhandled set", () => {
        it("should rethrow instead of publishing or resubscribing [ADR-008: zero-RxJS rethrowUnhandled rejects publish() directly]", async () => {
          createEventBus({
            rethrowUnhandled: true,
            sagaErrorStrategy: "resubscribe",
          });
          registerSaga(throwOnInvalid);

          await expect(eventBus.publish(new OrderEvent(false))).rejects.toThrow(
            "invalid order",
          );
          await advanceTimersByTimeAsync(60_000);
          await eventBus.publish(new OrderEvent(true));
          await advanceTimersByTimeAsync(0);

          expect(errors).toBe(0);
          expect(executedCommands).toHaveLength(0);
        });
      });
    });
  },
);
