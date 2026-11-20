import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import {
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  REQUEST,
  Scope,
} from "@bunest/common";
import { BunestFactory, ContextIdFactory } from "@bunest/core";
import {
  EVENT_LISTENER_METADATA,
  EVENT_PAYLOAD,
  EventEmitter2,
  EventEmitterModule,
  EventEmitterReadinessWatcher,
  EventEmitterService,
  OnEvent,
  matchEventName,
  type EventPayloadHost,
  type ListenerHandle,
} from "../src";

describe("@bunest/events", () => {
  it("supports exact sync/async emission, once, off, prependListener, symbols, and listenerCount", async () => {
    const emitter = new EventEmitterService();
    const order: string[] = [];
    const symEvent = Symbol("custom.event");

    const second = (v: string) => {
      order.push(`second:${v}`);
      return "r2";
    };
    emitter.on("ping", second);
    emitter.prependListener("ping", (v: string) => {
      order.push(`first:${v}`);
      return "r1";
    });
    emitter.once("ping", (v: string) => {
      order.push(`once:${v}`);
      return "r-once";
    });
    emitter.on(symEvent, (n: number) => n * 2);

    expect(emitter.listenerCount("ping")).toBe(3);
    expect(emitter.emit("ping", "a")).toBe(true);
    expect(order).toEqual(["first:a", "second:a", "once:a"]);
    expect(emitter.listenerCount("ping")).toBe(2);

    const asyncResults = await emitter.emitAsync("ping", "b");
    expect(asyncResults).toEqual(["r1", "r2"]);

    expect(await emitter.emitAsync(symEvent, 21)).toEqual([42]);

    emitter.off("ping", second);
    expect(emitter.listenerCount("ping")).toBe(1);
    expect(emitter.emit("no-listeners")).toBe(false);

    emitter.removeAllListeners();
    expect(emitter.listenerCount()).toBe(0);
  });

  it("matches single-segment (*) and multi-segment (**) wildcards accurately", async () => {
    expect(matchEventName("order.*", "order.created", true, ".")).toBe(true);
    expect(matchEventName("order.*", "order.item.created", true, ".")).toBe(false);
    expect(matchEventName("order.*", "order", true, ".")).toBe(false);

    expect(matchEventName("order.**", "order.created", true, ".")).toBe(true);
    expect(matchEventName("order.**", "order.item.created", true, ".")).toBe(true);
    expect(matchEventName("order.**", "order", true, ".")).toBe(false);

    expect(matchEventName("order.**.paid", "order.paid", true, ".")).toBe(true);
    expect(matchEventName("order.**.paid", "order.eu.item.paid", true, ".")).toBe(true);
    expect(matchEventName("a.**.b.**", "a.b.c", true, ".")).toBe(true);
    expect(matchEventName("a.**.b.**", "a.x.y.b.z.w", true, ".")).toBe(true);
    expect(matchEventName("a.**.b.**", "a.b", true, ".")).toBe(false);
    expect(matchEventName("**", "anything.at.all", true, ".")).toBe(true);
    expect(matchEventName("order.*", "order.created", false, ".")).toBe(false);

    // { async: true } defers listener execution asynchronously during sync emit()
    const asyncEmitter = new EventEmitterService();
    const asyncEvents: string[] = [];
    asyncEmitter.on(
      "deferred",
      () => {
        asyncEvents.push("listener");
      },
      { async: true },
    );
    asyncEmitter.emit("deferred");
    asyncEvents.push("after-emit");
    expect(asyncEvents).toEqual(["after-emit"]);
    await Promise.resolve();
    expect(asyncEvents).toEqual(["after-emit", "listener"]);

    const emitter = new EventEmitterService({ wildcard: true, delimiter: "." });
    const received: string[] = [];

    emitter.on("order.*", (id: string) => {
      received.push(`single:${id}`);
      return "single";
    });
    emitter.on("order.**", async (id: string) => {
      await Bun.sleep(2);
      received.push(`multi:${id}`);
      return "multi";
    });

    const res1 = await emitter.emitAsync("order.created", "1");
    expect(res1).toEqual(["single", "multi"]);

    const res2 = await emitter.emitAsync("order.line.updated", "2");
    expect(res2).toEqual(["multi"]);
    expect(received).toEqual(["single:1", "multi:1", "multi:2"]);
  });

  it("isolates errors when suppressErrors or ignoreErrors is enabled, and propagates otherwise", async () => {
    const strict = new EventEmitterService();
    strict.on("boom", () => {
      throw new Error("listener-failed");
    });

    expect(() => strict.emit("boom")).toThrow("listener-failed");
    await expect(strict.emitAsync("boom")).rejects.toThrow("listener-failed");

    // Per-listener suppressErrors isolates failures while allowing sibling listeners to complete
    const partial = new EventEmitterService();
    const seen: string[] = [];
    partial.on(
      "job",
      async () => {
        throw new Error("suppressed-error");
      },
      { suppressErrors: true },
    );
    partial.on("job", async () => {
      await Bun.sleep(2);
      seen.push("sibling-ran");
      return "ok";
    });

    const results = await partial.emitAsync("job");
    expect(results).toEqual([undefined, "ok"]);
    expect(seen).toEqual(["sibling-ran"]);

    // Global ignoreErrors
    const tolerant = new EventEmitterService({ ignoreErrors: true });
    tolerant.on("err", () => {
      throw new Error("ignored");
    });
    expect(tolerant.emit("err")).toBe(true);
    expect(await tolerant.emitAsync("err")).toEqual([undefined]);
  });

  it("auto-discovers @OnEvent() across providers and controllers (including inheritance) and unregisters on app.close()", async () => {
    const log: string[] = [];

    @Injectable()
    class BaseAuditListener {
      @OnEvent("user.created")
      handleBase(payload: { id: string }) {
        log.push(`base:${payload.id}`);
        return `base:${payload.id}`;
      }
    }

    @Injectable()
    class ExtendedAuditListener extends BaseAuditListener {
      @OnEvent(["order.*", "billing.**"], { prependListener: true })
      async handleOrders(payload: { id: string }) {
        await Bun.sleep(2);
        log.push(`ext:${payload.id}`);
        return `ext:${payload.id}`;
      }
    }

    @Controller("/events-demo")
    class EventsController {
      constructor(private readonly emitter: EventEmitterService) {}

      @OnEvent("user.created")
      onUserCreated(payload: { id: string }) {
        log.push(`ctrl:${payload.id}`);
        return `ctrl:${payload.id}`;
      }

      @Get("trigger")
      async trigger() {
        return await this.emitter.emitAsync("user.created", { id: "u_9" });
      }
    }

    @Module({
      imports: [EventEmitterModule.forRoot({ wildcard: true })],
      controllers: [EventsController],
      providers: [ExtendedAuditListener],
    })
    class AppModule {}

    const app = await BunestFactory.create(AppModule);
    await app.init();

    const emitter = app.get(EventEmitterService);
    expect(emitter.listenerCount("user.created")).toBe(2);
    expect(emitter.listenerCount("order.placed")).toBe(1);

    const res = await app.fetch(new Request("http://localhost/events-demo/trigger"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(["base:u_9", "ctrl:u_9"]);

    const orderRes = await emitter.emitAsync("order.placed", { id: "o_1" });
    expect(orderRes).toEqual(["ext:o_1"]);
    const billingRes = await emitter.emitAsync("billing.invoice.paid", {
      id: "inv_2",
    });
    expect(billingRes).toEqual(["ext:inv_2"]);

    // Closing app unregisters all discovered @OnEvent listeners cleanly
    await app.close();
    expect(emitter.listenerCount("user.created")).toBe(0);
    expect(emitter.listenerCount("order.placed")).toBe(0);
    expect(emitter.emit("user.created", { id: "after-close" })).toBe(false);
  });

  it("exposes full EventEmitter2 surface: addListener, removeListener, many, prepend*, *Any, listeners, hasListeners, maxListeners, objectify, newListener/removeListener, waitFor, listenTo/stopListeningTo", async () => {
    expect(EventEmitter2).toBe(EventEmitterService);
    expect(EVENT_LISTENER_METADATA).toBe("EVENT_LISTENER_METADATA");
    expect(EVENT_PAYLOAD).toBe(REQUEST);

    const lifecycleEvents: string[] = [];
    const emitter = new EventEmitter2({
      wildcard: true,
      delimiter: ".",
      newListener: true,
      removeListener: true,
      maxListeners: 20,
      verboseMemoryLeak: true,
    });

    expect(emitter.getMaxListeners()).toBe(20);
    emitter.setMaxListeners(15);
    expect(emitter.getMaxListeners()).toBe(15);

    emitter.on("newListener", (ev: string) => lifecycleEvents.push(`new:${String(ev)}`));
    emitter.on("removeListener", (ev: string) => lifecycleEvents.push(`rem:${String(ev)}`));

    // many + prependMany + prependOnceListener
    const calls: string[] = [];
    const manyFn = (v: string) => calls.push(`many:${v}`);
    emitter.many("task", 2, manyFn);
    emitter.prependMany("task", 2, (v: string) => calls.push(`pmany:${v}`));
    emitter.prependOnceListener("task", (v: string) => calls.push(`ponce:${v}`));

    expect(emitter.hasListeners("task")).toBe(true);
    expect(emitter.hasListeners("unknown")).toBe(false);
    expect(emitter.listeners("task")).toHaveLength(3);

    emitter.emit("task", "1");
    emitter.emit("task", "2");
    emitter.emit("task", "3");
    expect(calls).toEqual([
      "ponce:1",
      "pmany:1",
      "many:1",
      "pmany:2",
      "many:2",
    ]);
    expect(emitter.listenerCount("task")).toBe(0);
    expect(lifecycleEvents).toContain("new:task");
    expect(lifecycleEvents).toContain("rem:task");

    // addListener, removeListener, objectify handle, array namespace events, eventNames(true)
    const nsSeen: string[] = [];
    const addFn = (v: string) => nsSeen.push(`add:${v}`);
    emitter.addListener(["user", "profile", "updated"], addFn);
    const handle = emitter.on(
      ["user", "profile", "updated"],
      (v: string) => nsSeen.push(`obj:${v}`),
      { objectify: true },
    ) as ListenerHandle;

    expect(emitter.eventNames(true)).toContainEqual(["user", "profile", "updated"]);
    emitter.emit(["user", "profile", "updated"], "v1");
    expect(nsSeen).toEqual(["add:v1", "obj:v1"]);

    handle.off();
    emitter.removeListener(["user", "profile", "updated"], addFn);
    expect(emitter.listeners(["user", "profile", "updated"])).toHaveLength(0);

    // onAny, prependAny, offAny, listenersAny
    const anyLog: string[] = [];
    const anySecond = (ev: string | symbol | string[], val: number) =>
      anyLog.push(`any2:${String(ev)}:${val}`);
    const anyFirst = (ev: string | symbol | string[], val: number) =>
      anyLog.push(`any1:${String(ev)}:${val}`);
    emitter.onAny(anySecond);
    emitter.prependAny(anyFirst);
    expect(emitter.listenersAny()).toEqual([anyFirst, anySecond]);

    await emitter.emitAsync("metric.cpu", 99);
    expect(anyLog).toEqual(["any1:metric.cpu:99", "any2:metric.cpu:99"]);

    emitter.offAny(anyFirst);
    expect(emitter.listenersAny()).toEqual([anySecond]);
    emitter.offAny(anySecond);

    // waitFor with filter, timeout, handleError, cancel, and static EventEmitter2.once
    const filteredPromise = emitter.waitFor("num", (n: number) => n > 10);
    emitter.emit("num", 5);
    emitter.emit("num", 42, "extra");
    expect(await filteredPromise).toEqual([42, "extra"]);

    const timeoutPromise = emitter.waitFor("never", 20);
    await expect(timeoutPromise).rejects.toThrow("timeout");

    const cancelPromise = emitter.waitFor("never-2");
    cancelPromise.cancel("aborted-by-test");
    await expect(cancelPromise).rejects.toThrow("aborted-by-test");

    const errHandledOk = emitter.waitFor("cb", { handleError: true });
    emitter.emit("cb", null, "payload-ok");
    expect(await errHandledOk).toEqual(["payload-ok"]);

    const errHandledFail = emitter.waitFor("cb", { handleError: true });
    emitter.emit("cb", new Error("cb-boom"));
    await expect(errHandledFail).rejects.toThrow("cb-boom");

    const staticOnce = EventEmitter2.once(emitter, "ready");
    emitter.emit("ready", "go");
    expect(await staticOnce).toEqual(["go"]);

    // listenTo & stopListeningTo
    const source = new EventEmitter2();
    const bridged: string[] = [];
    emitter.on("local.ping", (v: string) => bridged.push(v));
    emitter.listenTo(source, { "remote.ping": "local.ping" });
    source.emit("remote.ping", "hello");
    expect(bridged).toEqual(["hello"]);

    expect(emitter.stopListeningTo(source, "remote.ping")).toBe(true);
    source.emit("remote.ping", "ignored");
    expect(bridged).toEqual(["hello"]);
    expect(emitter.stopListeningTo(source)).toBe(false);

    // Unhandled "error" event throws unless ignoreErrors: true
    const strictErr = new EventEmitter2();
    expect(() => strictErr.emit("error", new Error("unhandled-err"))).toThrow(
      "unhandled-err",
    );
    const safeErr = new EventEmitter2({ ignoreErrors: true });
    expect(safeErr.emit("error", new Error("ignored-err"))).toBe(false);
  });

  it("supports EventEmitter2 DI injection, EventEmitterReadinessWatcher, @OnEvent priority ordering, and EVENT_LISTENER_METADATA", async () => {
    const order: string[] = [];

    @Injectable()
    class PriorityListeners {
      @OnEvent("pipeline", { priority: 1 })
      low() {
        order.push("low");
      }

      @OnEvent("pipeline", { priority: 10 })
      high() {
        order.push("high");
      }

      @OnEvent("pipeline", { priority: 5, prependListener: true })
      prependedLow() {
        order.push("prepend-5");
      }

      @OnEvent("pipeline", { priority: 20, prependListener: true })
      prependedHigh() {
        order.push("prepend-20");
      }
    }

    @Injectable()
    class ConsumerService {
      constructor(
        public readonly emitter: EventEmitter2,
        public readonly readiness: EventEmitterReadinessWatcher,
      ) {}
    }

    // Verify EVENT_LISTENER_METADATA is attached to the method function (NestJS compatibility)
    const methodMeta = Reflect.getOwnMetadata(
      EVENT_LISTENER_METADATA,
      PriorityListeners.prototype.high,
    );
    expect(methodMeta).toHaveLength(1);
    expect(methodMeta[0].event).toBe("pipeline");
    expect(methodMeta[0].options?.priority).toBe(10);

    @Module({
      imports: [EventEmitterModule.forRoot()],
      providers: [PriorityListeners, ConsumerService],
    })
    class AppModule {}

    const app = await BunestFactory.createApplicationContext(AppModule);
    const consumer = app.get(ConsumerService);
    const watcher = app.get(EventEmitterReadinessWatcher);

    expect(consumer.emitter).toBe(app.get(EventEmitterService));
    expect(consumer.emitter).toBe(app.get(EventEmitter2));
    await expect(watcher.waitUntilReady()).resolves.toBeUndefined();

    await consumer.emitter.emitAsync("pipeline");
    expect(order).toEqual(["prepend-20", "prepend-5", "high", "low"]);

    await app.close();

    // Standalone EventEmitterReadinessWatcher setErrored
    const failingWatcher = new EventEmitterReadinessWatcher();
    failingWatcher.setErrored(new Error("init-boom"));
    await expect(failingWatcher.waitUntilReady()).rejects.toThrow("init-boom");
  });

  it("supports request-scoped @OnEvent listeners with EVENT_PAYLOAD and inheritRequestContextId", async () => {
    const seenPayloads: Array<{ payload: unknown; instanceId: number }> = [];
    let nextId = 0;

    @Injectable({ scope: Scope.REQUEST })
    class ScopedEventHandler {
      readonly id = ++nextId;

      constructor(
        @Inject(EVENT_PAYLOAD)
        public readonly eventPayload: unknown,
      ) {}

      @OnEvent("audit.log")
      handle(payload: { msg: string }) {
        seenPayloads.push({ payload: this.eventPayload, instanceId: this.id });
        return { id: this.id, msg: payload.msg };
      }
    }

    // 1. Default (inheritRequestContextId: false): wraps payload in EventPayloadHost<T>
    const attachedHosts: unknown[] = [];
    ContextIdFactory.apply({
      attach(contextId, request) {
        attachedHosts.push(request);
        return () => contextId;
      },
    });

    @Module({
      imports: [EventEmitterModule.forRoot({ inheritRequestContextId: false })],
      providers: [ScopedEventHandler],
    })
    class DefaultScopeApp {}

    const app1 = await BunestFactory.createApplicationContext(DefaultScopeApp);
    try {
      const emitter1 = app1.get(EventEmitter2);
      const reqObj = { msg: "first" };
      const res1 = await emitter1.emitAsync("audit.log", reqObj);
      const res2 = await emitter1.emitAsync("audit.log", reqObj);
      expect(res1).toEqual([{ id: 1, msg: "first" }]);
      expect(res2).toEqual([{ id: 2, msg: "first" }]);
      expect(seenPayloads[0]?.payload).toBe(reqObj);
      const host = attachedHosts[0] as EventPayloadHost<typeof reqObj>;
      expect(host).toEqual({ payload: reqObj });
    } finally {
      ContextIdFactory.reset();
      await app1.close();
    }

    // 2. inheritRequestContextId: true reuses the existing ContextId for the emitted request object
    @Module({
      imports: [EventEmitterModule.forRoot({ inheritRequestContextId: true })],
      providers: [ScopedEventHandler],
    })
    class InheritScopeApp {}

    const app2 = await BunestFactory.createApplicationContext(InheritScopeApp);
    try {
      const emitter2 = app2.get(EventEmitter2);
      const sharedReq = { msg: "inherited" };
      const existingCtx = ContextIdFactory.getByRequest(sharedReq);
      const resA = await emitter2.emitAsync("audit.log", sharedReq);
      const resB = await emitter2.emitAsync("audit.log", sharedReq);

      // Both emissions inherit the SAME ContextId -> SAME request-scoped instance!
      expect(resA).toEqual(resB);
      expect(ContextIdFactory.getByRequest(sharedReq)).toBe(existingCtx);
    } finally {
      await app2.close();
    }
  });
});
