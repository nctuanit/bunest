import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  spyOn,
} from "bun:test";
import { Logger } from "../../../../../packages/core/src/common";
import {
  ContextIdFactory,
  createContextId,
  type BunestApplication,
} from "../../../../../packages/core/src";
import {
  EventEmitter2,
  EventEmitterReadinessWatcher,
} from "../../../../../packages/messaging/src/events";
import { Test, describeConformance } from "../../../_helpers";
import {
  CUSTOM_DECORATOR_EVENT,
  CustomEventDecoratorConsumer,
  EventsAppModule,
  EventsControllerConsumer,
  EventsProviderAliasedConsumer,
  EventsProviderConsumer,
  EventsProviderDurableRequestScopedConsumer,
  EventsProviderPrependConsumer,
  EventsProviderPriorityConsumer,
  EventsProviderRequestScopedConsumer,
  RequestScopedEventPayload,
  TEST_EVENT_MULTIPLE_PAYLOAD,
  TEST_EVENT_PAYLOAD,
  TEST_EVENT_STRING_PAYLOAD,
  TEST_PROVIDER_TOKEN,
} from "../_fixtures/events-fixtures";

describeConformance(
  "EventEmitterModule - e2e",
  {
    upstreamPath: "nestjs/event-emitter/tests/e2e/module-e2e.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-012"],
    notes:
      "Adapts eventemitter2 import to native @bunest/events EventEmitter2 and declares explicit Scope.REQUEST on EventsProviderRequestScopedConsumer (ADR-012).",
  },
  () => {
    let app: BunestApplication;
    const durableContextId = createContextId();

    beforeAll(() => {
      ContextIdFactory.apply({
        attach: (contextId, _request) => (info) => {
          return info.isTreeDurable ? durableContextId : contextId;
        },
      });
    });

    afterAll(() => {
      ContextIdFactory.reset();
    });

    beforeEach(async () => {
      EventsProviderRequestScopedConsumer.injectedEventPayload =
        new RequestScopedEventPayload();
      EventsProviderDurableRequestScopedConsumer.injectedEventPayload =
        new RequestScopedEventPayload();

      const module = await Test.createTestingModule({
        imports: [EventsAppModule],
      }).compile();

      app = module.createNestApplication();
    });

    afterEach(async () => {
      await app?.close();
    });

    it(`should emit a "test-event" event to providers`, async () => {
      const eventsConsumerRef = app.get(EventsProviderConsumer);
      await app.init();

      expect(eventsConsumerRef.eventPayload).toEqual(TEST_EVENT_PAYLOAD);
    });

    it(`should emit a "stacked-event" event to providers`, async () => {
      const eventsConsumerRef = app.get(EventsProviderConsumer);
      await app.init();

      expect(eventsConsumerRef.stackedEventCalls).toEqual(2);
    });

    it(`aliased providers should receive an event only once`, async () => {
      const eventsConsumerRef = app.get(EventsProviderAliasedConsumer);
      await app.init();

      expect(eventsConsumerRef.setEventPayloadCalls).toBe(1);
    });

    it(`event subscribers are separate per each app instance`, async () => {
      const eventsConsumerRef = app.get(EventsProviderAliasedConsumer);

      await app.init();

      const module2 = await Test.createTestingModule({
        imports: [EventsAppModule],
      }).compile();
      const app2 = module2.createNestApplication();
      try {
        await app2.init();
        expect(eventsConsumerRef.setEventPayloadCalls).toBe(1);
      } finally {
        await app2.close();
      }
    });

    it(`should emit a "test-event" event to controllers`, async () => {
      const eventsConsumerRef = app.get(EventsControllerConsumer);
      await app.init();

      expect(eventsConsumerRef.eventPayload).toEqual(TEST_EVENT_PAYLOAD);
    });

    it("should run listeners from the highest priority to the lowest", async () => {
      const eventsConsumerRef = app.get(EventsProviderPriorityConsumer);
      await app.init();

      expect(eventsConsumerRef.calls).toEqual(["high", "normal", "negative"]);
    });

    it("should be able to specify a consumer be prepended via OnEvent decorator options", async () => {
      const eventsConsumerRef = app.get(EventsProviderPrependConsumer);
      const prependListenerSpy = spyOn(
        app.get(EventEmitter2),
        "prependListener",
      );
      try {
        await app.init();

        expect(eventsConsumerRef.eventPayload).toEqual(TEST_EVENT_PAYLOAD);
        expect(prependListenerSpy).toHaveBeenCalled();
      } finally {
        prependListenerSpy.mockRestore();
      }
    });

    it("should work with null prototype provider value", async () => {
      await app.close();
      const moduleWithNullProvider = await Test.createTestingModule({
        imports: [EventsAppModule],
      })
        .overrideProvider(TEST_PROVIDER_TOKEN)
        .useFactory({
          factory: () => {
            const testObject = { a: 13, b: 7 };
            Object.setPrototypeOf(testObject, null);
            return testObject;
          },
        })
        .compile();
      app = moduleWithNullProvider.createNestApplication();
      await expect(app.init()).resolves.toBeDefined();
    });

    it("should be able to emit a request-scoped event with a single payload", async () => {
      await app.init();

      expect(
        EventsProviderRequestScopedConsumer.injectedEventPayload.objectValue,
      ).toEqual(TEST_EVENT_PAYLOAD);
    });

    it("should be able to emit a durable request-scoped event with a single payload", async () => {
      await app.init();
      await new Promise((resolve) => setImmediate(resolve));

      expect(
        EventsProviderDurableRequestScopedConsumer.injectedEventPayload
          .objectValue,
      ).toEqual(TEST_EVENT_PAYLOAD);
    });

    it("should be able to emit a request-scoped event with a string payload", async () => {
      await app.init();

      expect(
        EventsProviderRequestScopedConsumer.injectedEventPayload.stringValue,
      ).toEqual(TEST_EVENT_STRING_PAYLOAD);
    });

    it("should be able to emit a durable request-scoped event with a string payload", async () => {
      await app.init();
      await new Promise((resolve) => setImmediate(resolve));

      expect(
        EventsProviderDurableRequestScopedConsumer.injectedEventPayload
          .stringValue,
      ).toEqual(TEST_EVENT_STRING_PAYLOAD);
    });

    it("should be able to emit a request-scoped event with multiple payloads", async () => {
      await app.init();

      expect(
        EventsProviderRequestScopedConsumer.injectedEventPayload.arrayValue,
      ).toEqual(TEST_EVENT_MULTIPLE_PAYLOAD);
    });

    it("should be able to emit a durable request-scoped event with multiple payloads", async () => {
      await app.init();
      await new Promise((resolve) => setImmediate(resolve));

      expect(
        EventsProviderDurableRequestScopedConsumer.injectedEventPayload
          .arrayValue,
      ).toEqual(TEST_EVENT_MULTIPLE_PAYLOAD);
    });

    it("should work with non array metadata", async () => {
      await app.init();

      const emitter = app.get(EventEmitter2);
      const customConsumer = app.get(CustomEventDecoratorConsumer);

      // callback called synchronously
      emitter.emit(CUSTOM_DECORATOR_EVENT);

      expect(customConsumer.isEmitted).toBeTruthy();
    });

    it("should be able to gracefully recover when an unexpected error occurs from provider", async () => {
      const eventsConsumerRef = app.get(EventsProviderConsumer);
      await app.init();

      const emitter = app.get(EventEmitter2);
      const result = emitter.emit("error-handling.provider");

      expect(eventsConsumerRef.errorHandlingCalls).toEqual(1);
      expect(result).toBeTruthy();
    });

    it("should be able to gracefully recover when an unexpected error occurs from provider and suppressErrors is true", async () => {
      const eventsConsumerRef = app.get(EventsProviderConsumer);
      await app.init();

      const emitter = app.get(EventEmitter2);
      const result = emitter.emit("error-handling-suppressed.provider");

      expect(eventsConsumerRef.errorHandlingCalls).toEqual(1);
      expect(result).toBeTruthy();
    });

    it("should be able to gracefully recover when an unexpected error occurs from request scoped", async () => {
      await app.init();

      const eventEmitter = app.get(EventEmitter2);
      const result = eventEmitter.emit("error-handling.request-scoped");

      expect(result).toBeTruthy();
    });

    it("should be able to gracefully recover when an unexpected error occurs from request scoped and suppressErrors is true", async () => {
      await app.init();

      const eventEmitter = app.get(EventEmitter2);
      const result = eventEmitter.emit(
        "error-handling-suppressed.request-scoped",
      );

      expect(result).toBeTruthy();
    });

    it("should log instead of rejecting when request scoped instantiation fails and suppressErrors is true", async () => {
      await app.init();
      const errorSpy = spyOn(Logger.prototype, "error").mockImplementation(
        () => {},
      );
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", onUnhandled);

      try {
        app
          .get(EventEmitter2)
          .emit("instantiation-error-handling-suppressed.request-scoped");
        await new Promise((resolve) => setTimeout(resolve, 50));
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }

      try {
        expect(unhandled).toHaveLength(0);
        expect(errorSpy).toHaveBeenCalledWith(
          "This is a test instantiation error",
          expect.any(String),
        );
      } finally {
        errorSpy.mockRestore();
      }
    });

    it("should throw when request scoped instantiation fails and suppressErrors is false", async () => {
      await app.init();

      await expect(
        app
          .get(EventEmitter2)
          .emitAsync("instantiation-error-throwing.request-scoped"),
      ).rejects.toThrow("This is a test instantiation error");
    });

    it("should throw when an unexpected error occurs from provider and suppressErrors is false", async () => {
      await app.init();

      const eventEmitter = app.get(EventEmitter2);
      await expect(
        eventEmitter.emitAsync("error-throwing.provider"),
      ).rejects.toThrow("This is a test error");
    });

    it("should throw when an unexpected error occurs from request scoped and suppressErrors is false", async () => {
      await app.init();

      const eventEmitter = app.get(EventEmitter2);
      await expect(
        eventEmitter.emitAsync("error-throwing.request-scoped"),
      ).rejects.toThrow("This is a test error");
    });

    it("should be able to wait until the event emitter is ready", async () => {
      const eventsConsumerRef = app.get(EventsControllerConsumer);
      await app.init();

      const eventEmitterWatcher = app.get(EventEmitterReadinessWatcher);
      await expect(
        eventEmitterWatcher.waitUntilReady(),
      ).resolves.toBeUndefined();
      expect(eventsConsumerRef.eventPayload).toEqual(TEST_EVENT_PAYLOAD);
    });

    it("should throw when an unexpected error occurs from durable request scoped and suppressErrors is false", async () => {
      await app.init();

      const eventEmitter = app.get(EventEmitter2);
      await expect(
        eventEmitter.emitAsync("error-throwing.durable-request-scoped"),
      ).rejects.toThrow("This is a test error");
    });

    it("should load durable provider once for different event emissions", async () => {
      await app.init();
      const eventEmitter = app.get(EventEmitter2);
      const [durableInstance] = await eventEmitter.emitAsync("durable");
      const [durableInstance2] = await eventEmitter.emitAsync("durable");
      expect(durableInstance).toBe(durableInstance2);
    });

    it("should load non-durable provider anew for different event emissions", async () => {
      await app.init();
      const eventEmitter = app.get(EventEmitter2);
      const [notDurableInstance] = await eventEmitter.emitAsync("not-durable");
      const [notDurableInstance2] = await eventEmitter.emitAsync("not-durable");
      expect(notDurableInstance).not.toBe(notDurableInstance2);
    });
  },
);
