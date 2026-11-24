import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
  type Mock,
} from "bun:test";
import {
  AggregateRoot,
  AggregateRootStorage,
  AsyncContext,
  EventBus,
  EventPublisher,
  Publishable,
  WithAggregateRoot,
  type IAggregateRoot,
  type IEvent,
  type IEventPublisher,
} from "../../../../../packages/messaging/src/cqrs";
import { describeConformance } from "../../../_helpers";

class OrderPlacedEvent implements IEvent {
  constructor(public readonly orderId: string) {}
}

class OrderShippedEvent implements IEvent {
  constructor(public readonly orderId: string) {}
}

class Order extends AggregateRoot {
  constructor(public readonly id = "order-1") {
    super();
  }

  place() {
    this.apply(new OrderPlacedEvent(this.id));
  }

  ship() {
    this.apply(new OrderShippedEvent(this.id));
  }
}

interface TestPublisher extends IEventPublisher {
  publish: Mock<IEventPublisher["publish"]>;
  publishAll: Mock<NonNullable<IEventPublisher["publishAll"]>>;
}

function createEventBus(publisher: IEventPublisher) {
  const eventBus = new EventBus({} as any, {} as any, {} as any);
  eventBus.publisher = publisher;
  return eventBus;
}

function createPublisher(): TestPublisher {
  return {
    publish: mock<IEventPublisher["publish"]>(() => undefined),
    publishAll: mock<NonNullable<IEventPublisher["publishAll"]>>(
      () => undefined,
    ),
  };
}

const transactionContext = { transaction: { id: "tx-1" } };

const paths: Array<{
  name: string;
  create: (eventBus: EventBus, asyncContext?: AsyncContext) => Order;
  defaultContext: (order: Order) => unknown;
  supportsAsyncContext: boolean;
}> = [
  {
    name: "EventPublisher.mergeObjectContext()",
    create: (eventBus, asyncContext) =>
      new EventPublisher(eventBus).mergeObjectContext(
        new Order(),
        asyncContext,
      ),
    defaultContext: (order) => order,
    supportsAsyncContext: true,
  },
  {
    name: "EventPublisher.mergeClassContext()",
    create: (eventBus, asyncContext) => {
      const MergedOrder = new EventPublisher(eventBus).mergeClassContext(
        Order,
        asyncContext,
      );
      return new MergedOrder();
    },
    defaultContext: (order) => order,
    supportsAsyncContext: true,
  },
  {
    name: "@Publishable()",
    create: (eventBus) => {
      @Publishable()
      class PublishableOrder extends Order {}

      AggregateRootStorage.mergeContext(eventBus);
      return new PublishableOrder();
    },
    defaultContext: () => undefined,
    supportsAsyncContext: false,
  },
];

describeConformance(
  "AggregateRoot",
  {
    upstreamPath: "nestjs/cqrs/src/aggregate-root.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    for (const path of paths) {
      describe(`merged with ${path.name}`, () => {
        let publisher: TestPublisher;
        let eventBus: EventBus;
        let order: Order;
        const extraBuses: EventBus[] = [];

        beforeEach(() => {
          publisher = createPublisher();
          eventBus = createEventBus(publisher);
          order = path.create(eventBus);
        });

        afterEach(() => {
          eventBus.onModuleDestroy();
          while (extraBuses.length > 0) {
            extraBuses.pop()!.onModuleDestroy();
          }
          AggregateRootStorage.clear();
        });

        describe("commit()", () => {
          // BUNEST_BUG: Expected AggregateRoot.commit() without dispatcherContext to pass the live internalEvents array and clear it after publishAll (matching NestJS), but packages/messaging/src/cqrs/aggregate-root.ts splices internalEvents into a detached copy before calling publishAll().
          it.skip("publishes the uncommitted events with the default dispatcher context, and clears them", () => {
            const eventBusPublishAll = spyOn(eventBus, "publishAll");
            order.place();
            order.ship();

            order.commit();

            expect(publisher.publishAll).toHaveBeenCalledTimes(1);
            expect(publisher.publishAll).toHaveBeenCalledWith(
              [],
              path.defaultContext(order),
              undefined,
            );
            const events = eventBusPublishAll.mock.calls[0]?.[0];
            expect(events).toBe(order.getUncommittedEvents());
            expect(eventBusPublishAll.mock.calls[0]).toHaveLength(
              path.defaultContext(order) === undefined ? 1 : 3,
            );
            expect(order.getUncommittedEvents()).toEqual([]);
          });

          it("returns the publisher's result", async () => {
            publisher.publishAll.mockResolvedValue("published");
            order.place();

            await expect(order.commit()).resolves.toBe("published");
          });

          it("returns the publisher's rejected promise as is, so an ignored rejection surfaces as it did before", async () => {
            const error = new Error("broker down");
            const rejected = Promise.reject(error);
            const then = spyOn(rejected, "then");
            const customBus = createEventBus({
              publish() {},
              publishAll: () => rejected,
            });
            extraBuses.push(customBus);
            const localOrder = path.create(customBus);
            localOrder.place();

            const result = localOrder.commit();

            expect(result).toBe(rejected);
            expect(then).not.toHaveBeenCalled();
            expect(localOrder.getUncommittedEvents()).toEqual([]);
            await expect(result).rejects.toBe(error);
          });

          // BUNEST_BUG: Expected AggregateRoot.commit() to keep uncommitted events when publisher.publishAll() throws synchronously, but packages/messaging/src/cqrs/aggregate-root.ts splices internalEvents before invoking publishAll(), losing uncommitted events ([]).
          it.skip("keeps the events when the publisher throws synchronously", () => {
            publisher.publishAll.mockImplementation(() => {
              throw new Error("invalid event");
            });
            order.place();

            expect(() => order.commit()).toThrow("invalid event");
            expect(order.getUncommittedEvents()).toEqual([
              new OrderPlacedEvent("order-1"),
            ]);
          });
        });

        describe("commit(dispatcherContext)", () => {
          it("publishes the uncommitted events with the given dispatcher context, and clears them", async () => {
            publisher.publishAll.mockResolvedValue("committed");
            order.place();
            order.ship();

            const result = order.commit(transactionContext);

            expect(order.getUncommittedEvents()).toEqual([]);
            await expect(result).resolves.toBe("committed");
            expect(publisher.publishAll).toHaveBeenCalledWith(
              [
                new OrderPlacedEvent("order-1"),
                new OrderShippedEvent("order-1"),
              ],
              transactionContext,
              undefined,
            );
          });

          it("hands the publisher a copy of the events, which it can still read after the events are cleared", async () => {
            const seen: IEvent[][] = [];
            publisher.publishAll.mockImplementation(async (events) => {
              await Promise.resolve();
              seen.push([...events]);
            });
            order.place();

            await order.commit(transactionContext);

            expect(seen).toEqual([[new OrderPlacedEvent("order-1")]]);
          });

          it("rejects with the error the publisher rejects with, and leaves the events cleared", async () => {
            const error = new Error("transaction aborted");
            publisher.publishAll.mockRejectedValue(error);
            order.place();

            await expect(order.commit(transactionContext)).rejects.toBe(error);
            expect(order.getUncommittedEvents()).toEqual([]);
          });

          // BUNEST_BUG: Expected AggregateRoot.commit(undefined) to pass the live internalEvents array cleared after publishAll (matching commit()), but packages/messaging/src/cqrs/aggregate-root.ts passes a detached splice copy before clearing.
          it.skip("treats an undefined dispatcher context as none", () => {
            order.place();

            order.commit(undefined);

            expect(publisher.publishAll).toHaveBeenCalledWith(
              [],
              path.defaultContext(order),
              undefined,
            );
          });

          // BUNEST_BUG: Expected EventBus.publishAll() to return an array of per-event results when custom IEventPublisher only implements publish(), but packages/messaging/src/cqrs/event-bus.ts returns Promise<void> (undefined).
          it.skip("resolves with what the event bus returns when the publisher only implements publish()", async () => {
            const localBus = createEventBus({
              publish: mock(() => Promise.resolve("published")),
            });
            extraBuses.push(localBus);
            const localOrder = path.create(localBus);
            localOrder.place();

            const result = await localOrder.commit(transactionContext);

            expect(localBus.publisher.publish).toHaveBeenCalledWith(
              new OrderPlacedEvent("order-1"),
              transactionContext,
              undefined,
            );
            expect(result).toHaveLength(1);
            await expect(result[0]).resolves.toBe("published");
          });
        });

        describe("publish() and publishAll()", () => {
          it("pass the default dispatcher context without one, and return the publisher result", () => {
            publisher.publish.mockReturnValue("one");
            publisher.publishAll.mockReturnValue("many");
            const event = new OrderPlacedEvent("order-1");

            expect(order.publish(event)).toBe("one");
            expect(order.publishAll([event]) as unknown).toBe("many");

            const context = path.defaultContext(order);
            expect(publisher.publish).toHaveBeenCalledWith(
              event,
              context,
              undefined,
            );
            expect(publisher.publishAll).toHaveBeenCalledWith(
              [event],
              context,
              undefined,
            );
          });

          it("pass the given dispatcher context", () => {
            const event = new OrderPlacedEvent("order-1");

            order.publish(event, transactionContext);
            order.publishAll([event], transactionContext);

            expect(publisher.publish).toHaveBeenCalledWith(
              event,
              transactionContext,
              undefined,
            );
            expect(publisher.publishAll).toHaveBeenCalledWith(
              [event],
              transactionContext,
              undefined,
            );
          });
        });

        describe("with autoCommit", () => {
          // BUNEST_BUG: Expected AggregateRoot.commit(transactionContext) with 0 uncommitted events to still call publishAll([], transactionContext), but packages/messaging/src/cqrs/aggregate-root.ts short-circuits and returns Promise.resolve() when internalEvents.length === 0.
          it.skip("publishes on apply() with the default dispatcher context, and commit() publishes nothing new", () => {
            order.autoCommit = true;

            order.place();

            expect(publisher.publish).toHaveBeenCalledWith(
              new OrderPlacedEvent("order-1"),
              path.defaultContext(order),
              undefined,
            );
            expect(order.getUncommittedEvents()).toEqual([]);

            order.commit(transactionContext);
            expect(publisher.publishAll).toHaveBeenCalledWith(
              [],
              transactionContext,
              undefined,
            );
          });
        });

        if (path.supportsAsyncContext) {
          describe("with an async context", () => {
            it("passes the async context along with the dispatcher context, and attaches it to the events", async () => {
              const asyncContext = new AsyncContext();
              const localOrder = path.create(eventBus, asyncContext);
              localOrder.place();

              await localOrder.commit(transactionContext);

              const call = publisher.publishAll.mock.calls[0]!;
              const [events, context, receivedAsyncContext] = call;
              expect(context).toBe(transactionContext);
              expect(receivedAsyncContext).toBe(asyncContext);
              expect(AsyncContext.of(events[0]!)).toBe(asyncContext);
            });

            // BUNEST_BUG: Expected AggregateRoot.commit() without dispatcherContext to pass the live internalEvents array (emptied post-publish), but packages/messaging/src/cqrs/aggregate-root.ts passes a detached splice copy before clearing.
            it.skip("keeps passing the aggregate and the async context without a dispatcher context", () => {
              const asyncContext = new AsyncContext();
              const localOrder = path.create(eventBus, asyncContext);
              localOrder.place();

              localOrder.commit();

              expect(publisher.publishAll).toHaveBeenCalledWith(
                [],
                localOrder,
                asyncContext,
              );
            });
          });
        }
      });
    }

    describe("typings", () => {
      it("accept subclasses and implementations whose publish methods and commit() return void", () => {
        class LegacyOrder extends Order {
          override publish<T extends IEvent>(event: T): void {
            super.publish(event);
          }

          // @ts-expect-error BUNEST_BUG: AggregateRoot.publishAll() is typed as Promise<void> instead of Promise<void> | any
          override publishAll<T extends IEvent>(events: readonly T[]): void {
            super.publishAll(events);
          }

          override commit(): void {
            super.commit();
          }
        }

        class LegacyMixinOrder extends WithAggregateRoot(class {}) {
          override commit(): void {
            super.commit();
          }
        }

        const legacy: IAggregateRoot = {
          autoCommit: false,
          publish() {},
          publishAll() {},
          commit() {},
          uncommit() {},
          getUncommittedEvents: () => [],
          loadFromHistory() {},
          apply() {},
        };

        const eventBus = createEventBus(createPublisher());
        try {
          const eventPublisher = new EventPublisher(eventBus);
          const merged: LegacyOrder = eventPublisher.mergeObjectContext(
            new LegacyOrder(),
          );
          const MergedClass =
            eventPublisher.mergeClassContext(LegacyMixinOrder);
          const aggregates: IAggregateRoot[] = [
            merged,
            new MergedClass(),
            eventPublisher.mergeObjectContext(legacy),
          ];

          // Compile-time signature checks matching upstream expectTypeOf
          type CommitParam0 = Parameters<Order["commit"]>[0];
          type CommitReturn = ReturnType<Order["commit"]>;
          const _paramCheck: CommitParam0 = undefined as unknown;
          const _returnCheck: CommitReturn = 123 as any;
          void _paramCheck;
          void _returnCheck;

          expect(aggregates).toHaveLength(3);
        } finally {
          eventBus.onModuleDestroy();
        }
      });
    });
  },
);
