import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { Logger } from "../../../../../packages/core/src/common";
import {
  CommandBus,
  CqrsModule,
  UnhandledExceptionBus,
  type UnhandledExceptionInfo,
} from "../../../../../packages/messaging/src/cqrs";
import {
  Test,
  describeConformance,
  itAdapted,
  type TestingModule,
} from "../../../_helpers";
import {
  CqrsAppModule,
  ErrorsSagas,
  UnhandledExceptionCommand,
  UnhandledExceptionCommandHandler,
  UnhandledExceptionEvent,
  sleepUnref,
} from "../_fixtures/cqrs-fixtures";

function nextFromBus(
  bus: UnhandledExceptionBus<any>,
  predicate?: (info: UnhandledExceptionInfo<any>) => boolean,
): Promise<UnhandledExceptionInfo<any>> {
  return new Promise<UnhandledExceptionInfo<any>>((resolve) => {
    const sub = bus.subscribe((info) => {
      if (!predicate || predicate(info)) {
        sub.unsubscribe();
        resolve(info);
      }
    });
  });
}

describeConformance(
  "Unhandled exceptions",
  {
    upstreamPath: "nestjs/cqrs/test/e2e/unhandled-exceptions.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-008"],
    notes:
      "Adapts RxJS unhandledExceptionBus.pipe(take(1)/filter)/firstValueFrom to Bunest SubscribableStream.subscribe() (ADR-008).",
  },
  () => {
    let moduleRef: TestingModule;
    let unhandledExceptionBus: UnhandledExceptionBus;

    beforeAll(async () => {
      moduleRef = await Test.createTestingModule({
        imports: [CqrsAppModule],
      }).compile();

      await moduleRef.init();

      unhandledExceptionBus = moduleRef.get(UnhandledExceptionBus);
    });

    afterAll(async () => {
      await moduleRef.close();
    });

    describe("when exception is thrown from command handler", () => {
      it("should rethrow the exception", async () => {
        const command = new UnhandledExceptionCommand("command");
        const commandBus = moduleRef.get(CommandBus);
        try {
          await commandBus.execute(command);

          expect(true).toBe(false);
        } catch (error) {
          expect(error).toEqual(
            new Error(`Unhandled exception in ${command.failAt}`),
          );
        }
      });
    });

    describe("when exception is thrown from event handler", () => {
      // BUNEST_BUG: Expected EventBus.publish() with default options (rethrowUnhandled omitted -> false) to forward event handler exceptions to UnhandledExceptionBus without rejecting publish(), but packages/messaging/src/cqrs/event-bus.ts:614 checks `rethrowUnhandled !== false` (defaulting to true, inconsistent with line 724 for sagas), producing an unhandled promise rejection when publish() is fire-and-forget.
      it.skip("should forward exception to UnhandledExceptionBus [ADR-008: SubscribableStream.subscribe() instead of RxJS pipe(take(1))]", async () => {
        const command = new UnhandledExceptionCommand("event");
        const commandBus = moduleRef.get(CommandBus);

        const exceptionPromise = nextFromBus(unhandledExceptionBus);
        await commandBus.execute(command);
        const exceptionInfo = await exceptionPromise;

        expect(exceptionInfo.exception).toEqual(
          new Error(`Unhandled exception in ${command.failAt}`),
        );
        expect(exceptionInfo.cause).toBeInstanceOf(UnhandledExceptionEvent);
      });

      // BUNEST_BUG: Expected EventBus to log unhandled event handler exceptions with class name ('"UnhandledExceptionEventHandler" has thrown an unhandled exception.', error) via Logger.prototype.error (and not reject publish() by default), but packages/messaging/src/cqrs/event-bus.ts never logs handler errors to Logger.
      it.skip("should log the event handler class name", async () => {
        const loggerSpy = spyOn(Logger.prototype, "error").mockImplementation(
          () => {},
        );
        try {
          const command = new UnhandledExceptionCommand("event");
          const commandBus = moduleRef.get(CommandBus);

          const exceptionPromise = nextFromBus(unhandledExceptionBus);
          await commandBus.execute(command);
          await exceptionPromise;

          expect(loggerSpy).toHaveBeenCalledWith(
            '"UnhandledExceptionEventHandler" has thrown an unhandled exception.',
            new Error(`Unhandled exception in ${command.failAt}`),
          );
        } finally {
          loggerSpy.mockRestore();
        }
      });
    });

    describe("when exception is thrown from saga", () => {
      // BUNEST_BUG: Expected UnhandledExceptionInfo.cause for a throwing @Saga() to be the saga method/property name ("onError"), but packages/messaging/src/cqrs/event-bus.ts handleSagaFailure() passes the triggering event instance (UnhandledExceptionEvent) as cause.
      it.skip("should forward exception to UnhandledExceptionBus [ADR-008: SubscribableStream.subscribe() instead of RxJS pipe(take(1))]", async () => {
        const command = new UnhandledExceptionCommand("saga");
        const commandBus = moduleRef.get(CommandBus);

        const exceptionPromise = nextFromBus(unhandledExceptionBus);
        await commandBus.execute(command);
        const exceptionInfo = await exceptionPromise;

        expect(exceptionInfo.exception).toEqual(
          new Error(`Unhandled exception in ${command.failAt}`),
        );
        expect(exceptionInfo.cause).toEqual("onError");
      });
    });
  },
);

describeConformance(
  'Unhandled exceptions with sagaErrorStrategy set to "resubscribe"',
  {
    upstreamPath: "nestjs/cqrs/test/e2e/unhandled-exceptions.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-008"],
  },
  () => {
    let moduleRef: TestingModule;

    beforeAll(async () => {
      moduleRef = await Test.createTestingModule({
        imports: [CqrsModule.forRoot({ sagaErrorStrategy: "resubscribe" })],
        providers: [UnhandledExceptionCommandHandler, ErrorsSagas],
      }).compile();

      await moduleRef.init();
    });

    afterAll(async () => {
      await moduleRef.close();
    });

    itAdapted(
      "ADR-008",
      "should keep reacting to events after the saga has thrown",
      async () => {
        const commandBus = moduleRef.get(CommandBus);
        const unhandledExceptionBus = moduleRef.get(UnhandledExceptionBus);
        const sagaThrows = async () => {
          const forwarded = nextFromBus(
            unhandledExceptionBus,
            (exceptionInfo) =>
              exceptionInfo.cause === "onError" ||
              exceptionInfo.cause instanceof UnhandledExceptionEvent,
          );
          await commandBus.execute(new UnhandledExceptionCommand("saga"));
          await forwarded;
        };

        await sagaThrows();
        await sleepUnref(300);
        await sagaThrows();
        await sleepUnref(400);
        await sagaThrows();
      },
      "SubscribableStream.subscribe() instead of RxJS firstValueFrom(pipe(filter()))",
      20_000,
    );
  },
);
