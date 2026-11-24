import { describe, expect, it } from "bun:test";
import { Injectable, Module, subscribe, unsubscribe } from "@bunest/core";
import { Test } from "@bunest/testing";
import {
  ClientProxyTransport,
  InMemoryOutboxStore,
  NonRetryableMessageError,
  OnOutboxMessage,
  OUTBOX_MODULE_OPTIONS,
  Outbox,
  OutboxDeadLetters,
  OutboxError,
  type OutboxEvent,
  OutboxEvents,
  type OutboxHandlerContext,
  OutboxInbox,
  type OutboxMessage,
  OutboxModule,
  OutboxNoHandlerError,
  OutboxPublishTimeoutError,
  OutboxRelay,
  OutboxStorage,
  OutboxTransactionRequiredError,
  OutboxTransport,
  toKafkaRecord,
} from "../../src/outbox/index";
import { uuidv7 } from "../../src/outbox/utils";

describe("@bunest/outbox core module & runtime", () => {
  it("validates UUIDv7 ordering and format", () => {
    const ids = Array.from({ length: 50 }, () => uuidv7());
    for (const id of ids) {
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
    expect(ids).toEqual([...ids].sort());
  });

  it("delivers @OnOutboxMessage handlers via local transport with inbox deduplication", async () => {
    const received: Array<{
      payload: unknown;
      consumer: string;
      attempt: number;
    }> = [];

    @Injectable()
    class OrderHandlers {
      @OnOutboxMessage("order.placed", { consumer: "email-sender" })
      async handleEmail(
        payload: { orderId: string },
        ctx: OutboxHandlerContext,
      ): Promise<void> {
        received.push({
          payload,
          consumer: ctx.consumer,
          attempt: ctx.attempt,
        });
      }

      @OnOutboxMessage(["order.placed", "order.updated"], {
        consumer: "audit-log",
      })
      async handleAudit(
        payload: { orderId: string },
        ctx: OutboxHandlerContext,
      ): Promise<void> {
        received.push({
          payload,
          consumer: ctx.consumer,
          attempt: ctx.attempt,
        });
      }
    }

    const store = new InMemoryOutboxStore();

    @Injectable()
    class StoreRegistrar {
      constructor(storage: OutboxStorage) {
        storage.registerSource({ messages: store, inbox: store });
      }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [
        OutboxModule.forRoot({
          relay: { enabled: false, lease: "5s", pollInterval: "50ms" },
        }),
      ],
      providers: [OrderHandlers, StoreRegistrar],
    }).compile();

    await moduleRef.init();

    const outbox = moduleRef.get(Outbox);
    const relay = moduleRef.get(OutboxRelay);
    const events = moduleRef.get(OutboxEvents);

    const emitted: OutboxEvent[] = [];
    const sub = events.events$.subscribe((ev) => emitted.push(ev));

    const diagEvents: unknown[] = [];
    const diagListener = (msg: unknown) => diagEvents.push(msg);
    subscribe("nestjs:outbox:published", diagListener);

    try {
      const msg = await store.transaction((tx) =>
        outbox.add(tx, {
          topic: "order.placed",
          payload: { orderId: "ord-1" },
          key: "ord-1",
          headers: { "x-trace": "t1" },
        }),
      );

      expect(msg.topic).toBe("order.placed");
      expect(msg.key).toBe("ord-1");
      expect(msg.headers).toEqual({ "x-trace": "t1" });

      const result = await relay.runOnce();
      expect(result).toEqual({
        claimed: 1,
        published: 1,
        retried: 0,
        deadLettered: 0,
        released: 0,
        leaseLost: 0,
      });

      expect(received).toHaveLength(2);
      expect(received.map((r) => r.consumer).sort()).toEqual([
        "audit-log",
        "email-sender",
      ]);
      expect(emitted).toHaveLength(1);
      expect(emitted[0]!.type).toBe("published");
      expect(diagEvents).toHaveLength(1);

      // Stats show empty queue
      const stats = await relay.stats();
      expect(stats.pending).toBe(0);
      expect(stats.deadLetters).toBe(0);
      expect(stats.lagMs).toBe(0);
      expect(stats.inFlight).toBe(0);
    } finally {
      sub.unsubscribe();
      unsubscribe("nestjs:outbox:published", diagListener);
      await moduleRef.close();
    }
  });

  it("retries transient failures with backoff and dead-letters after budget exhaustion or NonRetryableMessageError", async () => {
    let calls = 0;

    class FlakyTransport extends OutboxTransport {
      async publish(message: OutboxMessage): Promise<void> {
        calls++;
        if (message.topic === "bad.msg") {
          throw new NonRetryableMessageError("invalid schema");
        }
        throw new Error(`broker down #${calls}`);
      }
    }

    const store = new InMemoryOutboxStore();

    @Injectable()
    class StoreRegistrar {
      constructor(storage: OutboxStorage) {
        storage.registerSource({ messages: store, inbox: store });
      }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [
        OutboxModule.forRoot({
          transports: { broker: FlakyTransport },
          relay: { enabled: false },
          retry: {
            attempts: 2,
            backoff: { delay: 1, factor: 1, maxDelay: 1, jitter: "none" },
          },
        }),
      ],
      providers: [StoreRegistrar],
    }).compile();

    await moduleRef.init();

    const outbox = moduleRef.get(Outbox);
    const relay = moduleRef.get(OutboxRelay);
    const deadLetters = moduleRef.get(OutboxDeadLetters);
    const events = moduleRef.get(OutboxEvents);

    const seenTypes: string[] = [];
    events.events$.subscribe((ev) => seenTypes.push(ev.type));

    const [bad, transient] = await store.transaction((tx) =>
      outbox.add(tx, [
        { topic: "bad.msg", payload: { x: 1 } },
        { topic: "retry.msg", payload: { x: 2 }, key: "k1" },
      ]),
    );

    const run1 = await relay.runOnce();
    expect(run1.deadLettered).toBe(1);
    expect(run1.retried).toBe(1);

    // Wait past 1ms backoff
    await new Promise((r) => setTimeout(r, 15));

    const run2 = await relay.runOnce();
    expect(run2.deadLettered).toBe(1);

    expect(seenTypes).toEqual([
      "dead-lettered",
      "retry-scheduled",
      "dead-lettered",
    ]);

    const list = await deadLetters.list();
    expect(list).toHaveLength(2);

    const badDl = await deadLetters.get(bad!.id);
    expect(badDl?.reason).toBe("rejected");
    expect(badDl?.attempts).toBe(1);

    const transDl = await deadLetters.get(transient!.id);
    expect(transDl?.reason).toBe("exhausted");
    expect(transDl?.attempts).toBe(2);
    expect(transDl?.history).toHaveLength(2);

    // Requeue & purge
    expect(await deadLetters.requeue(bad!.id)).toBe(1);
    expect((await deadLetters.list()).length).toBe(1);
    expect(await deadLetters.purge({ all: true })).toBe(1);
    expect(await deadLetters.list()).toHaveLength(0);

    await moduleRef.close();
  });

  it("aborts timed-out publishes with OutboxPublishTimeoutError and handles missing local handlers", async () => {
    let aborted = false;
    const slowTransport: OutboxTransport = {
      publish(_message, { signal }) {
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(signal.reason);
          });
        });
      },
    };

    const store = new InMemoryOutboxStore();
    const events = new OutboxEvents();
    const collected: OutboxEvent[] = [];
    events.events$.subscribe((e) => collected.push(e));

    const relay = new OutboxRelay({
      store,
      transports: { slow: slowTransport },
      route: () => "slow",
      relay: { enabled: false, lease: 500, publishTimeout: 25 },
      retry: false,
      events,
    });

    await store.transaction((tx) => {
      store.add(tx, [
        {
          id: uuidv7(),
          topic: "slow.topic",
          payload: {},
          headers: {},
          key: null,
          createdAt: Date.now(),
          availableAt: 0,
          attempts: 0,
          lastError: null,
        },
      ]);
    });

    const res = await relay.runOnce();
    expect(res.deadLettered).toBe(1);
    expect(aborted).toBe(true);
    expect(collected[0]?.type).toBe("dead-lettered");
    if (collected[0]?.type === "dead-lettered") {
      expect(collected[0].error).toBeInstanceOf(OutboxPublishTimeoutError);
      expect(collected[0].error).toBeInstanceOf(OutboxError);
    }

    const noHandler = new OutboxNoHandlerError("missing.topic");
    expect(noHandler.topic).toBe("missing.topic");
    expect(noHandler).toBeInstanceOf(OutboxError);
  });

  it("supports ClientProxyTransport (Promise & Subscribable clients) and Kafka detection", async () => {
    const emitted: Array<{ pattern: unknown; data: unknown }> = [];
    const kafkaEmitted: Array<{ pattern: unknown; data: unknown }> = [];

    const plainClient = {
      emit(pattern: unknown, data: unknown) {
        emitted.push({ pattern, data });
        return Promise.resolve();
      },
    };

    const kafkaClient = {
      subscribeToResponseOf(_pattern: unknown) {},
      emit(pattern: unknown, data: unknown) {
        kafkaEmitted.push({ pattern, data });
        return {
          subscribe(observer?: {
            next?: (v: unknown) => void;
            complete?: () => void;
          }) {
            observer?.next?.(undefined);
            observer?.complete?.();
            return { unsubscribe() {} };
          },
        };
      },
    };

    @Module({
      providers: [
        { provide: "PLAIN_CLIENT", useValue: plainClient },
        { provide: "KAFKA_CLIENT", useValue: kafkaClient },
      ],
      exports: ["PLAIN_CLIENT", "KAFKA_CLIENT"],
    })
    class ClientsMockModule {}

    const store = new InMemoryOutboxStore();

    @Injectable()
    class StoreRegistrar {
      constructor(storage: OutboxStorage) {
        storage.registerSource({ messages: store, inbox: store });
      }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [
        OutboxModule.forRootAsync({
          imports: [ClientsMockModule],
          transports: {
            plain: ClientProxyTransport("PLAIN_CLIENT"),
            kafka: ClientProxyTransport("KAFKA_CLIENT"),
          },
          useFactory: () => ({
            route: (msg) => (msg.topic.startsWith("k.") ? "kafka" : "plain"),
            relay: { enabled: false },
          }),
        }),
      ],
      providers: [StoreRegistrar],
    }).compile();

    await moduleRef.init();
    const outbox = moduleRef.get(Outbox);
    const relay = moduleRef.get(OutboxRelay);

    expect(moduleRef.get(OUTBOX_MODULE_OPTIONS)).toBeDefined();

    await store.transaction((tx) =>
      outbox.add(tx, [
        { topic: "user.created", payload: { id: 1 }, key: "u-1" },
        {
          topic: "k.event",
          payload: { id: 2 },
          key: "k-1",
          headers: { h: "v" },
        },
      ]),
    );

    const run = await relay.runOnce();
    expect(run.published).toBe(2);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.pattern).toBe("user.created");
    expect((emitted[0]!.data as { payload: unknown }).payload).toEqual({
      id: 1,
    });

    expect(kafkaEmitted).toHaveLength(1);
    expect(kafkaEmitted[0]!.pattern).toBe("k.event");
    const kafkaRecord = kafkaEmitted[0]!.data as {
      key: string | null;
      value: { payload: unknown };
      headers: Record<string, string>;
    };
    expect(kafkaRecord.key).toBe("k-1");
    expect(kafkaRecord.headers).toEqual({ h: "v" });
    expect(kafkaRecord.value.payload).toEqual({ id: 2 });

    // Direct toKafkaRecord helper
    const sampleMsg: OutboxMessage = {
      id: "id-1",
      topic: "t",
      payload: { a: 1 },
      headers: { k: "v" },
      key: "part-1",
      createdAt: 100,
      availableAt: 100,
      attempts: 0,
      lastError: null,
    };
    const rec = toKafkaRecord(sampleMsg, {
      id: sampleMsg.id,
      topic: sampleMsg.topic,
      key: sampleMsg.key,
      headers: sampleMsg.headers,
      createdAt: sampleMsg.createdAt,
      payload: sampleMsg.payload,
    });
    expect(rec.pattern).toBe("t");
    expect(rec.data.key).toBe("part-1");

    await moduleRef.close();
  });

  it("supports OutboxInbox.process(), processInTransaction(), prune() and refuses unstorable text / missing tx", async () => {
    const store = new InMemoryOutboxStore();
    const storage = new OutboxStorage();
    storage.registerSource({ messages: store, inbox: store });
    const inbox = new OutboxInbox(storage);
    const relay = new OutboxRelay({
      store,
      transports: {},
      relay: { enabled: false },
    });
    const outbox = new Outbox(storage, relay);

    // Outbox.add refuses null tx & unstorable characters
    expect(() =>
      outbox.add(null as unknown, { topic: "a", payload: {} }),
    ).toThrow(OutboxTransactionRequiredError);
    expect(() =>
      outbox.add({}, { topic: "a", payload: { bad: "hello\u0000world" } }),
    ).toThrow(TypeError);
    expect(() =>
      outbox.add({}, { topic: "a", payload: { bad: "\uD800" } }),
    ).toThrow(TypeError);

    // OutboxInbox.process deduplicates
    let runs = 0;
    const first = await inbox.process("billing", "m1", () => {
      runs++;
      return 42;
    });
    expect(first).toEqual({ duplicate: false, result: 42 });
    const second = await inbox.process("billing", "m1", () => {
      runs++;
      return 99;
    });
    expect(second).toEqual({ duplicate: true });
    expect(runs).toBe(1);

    // OutboxInbox.processInTransaction
    const txRes = await store.transaction((tx) =>
      inbox.processInTransaction(tx, "billing", "m2", () => "ok"),
    );
    expect(txRes).toEqual({ duplicate: false, result: "ok" });
    const dupRes = await store.transaction((tx) =>
      inbox.processInTransaction(tx, "billing", "m2", () => "again"),
    );
    expect(dupRes).toEqual({ duplicate: true });

    expect(() =>
      inbox.processInTransaction(null as unknown, "billing", "m3", () => 1),
    ).toThrow(OutboxTransactionRequiredError);

    // prune
    expect(await inbox.prune("0ms")).toBeGreaterThanOrEqual(0);
  });

  it("supports AsyncIterable on OutboxEvents.events$ and completes on shutdown", async () => {
    const events = new OutboxEvents();
    const received: OutboxEvent[] = [];

    const consumer = (async () => {
      for await (const ev of events.events$) {
        received.push(ev);
      }
    })();

    const msg: OutboxMessage = {
      id: "1",
      topic: "t",
      payload: null,
      headers: {},
      key: null,
      createdAt: 0,
      availableAt: 0,
      attempts: 0,
      lastError: null,
    };
    events.emit({ type: "lease-lost", message: msg });
    events.onApplicationShutdown();
    await consumer;

    expect(received).toHaveLength(1);
    expect(received[0]!.type).toBe("lease-lost");
  });

  it("enforces OutboxStorage production guard and rejects invalid store registrations", () => {
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const storage = new OutboxStorage();
      expect(() => storage.messages).toThrow(/NODE_ENV is "production"/);

      const allowed = new OutboxStorage({ allowInMemoryStorage: true });
      expect(allowed.messages).toBeInstanceOf(InMemoryOutboxStore);
    } finally {
      process.env.NODE_ENV = prevEnv;
    }

    const s = new OutboxStorage();
    expect(() => s.registerSource({} as never)).toThrow(TypeError);
    expect(() => s.registerSource({ bogus: {} } as never)).toThrow(TypeError);
    expect(() =>
      OutboxModule.forRoot({ store: new InMemoryOutboxStore() } as never),
    ).toThrow(/`store` is not an option/);
  });
});
