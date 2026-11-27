import { describe, expect, it } from "bun:test";
import { Controller, Module } from "@bunest/core";
import { Test } from "@bunest/testing";
import {
  EventPattern,
  GrpcServer,
  InMemoryBroker,
  InMemoryClientProxy,
  InMemoryServer,
  KafkaClientProxy,
  KafkaContext,
  KafkaServer,
  MessagePattern,
  MicroserviceModule,
  MqttServer,
  NatsTransportServer,
  RabbitMqClientProxy,
  RabbitMqTransportServer,
  RedisClientProxy,
  RedisTransportServer,
  RpcException,
  RpcTimeoutException,
  TcpClientProxy,
  TcpServer,
  Transport,
  type KafkaClientLike,
  type KafkaConsumerLike,
  type KafkaEachMessagePayload,
  type KafkaProducerLike,
  type KafkaProducerRecord,
  type MqttClientLike,
  type MqttMessageListener,
  type MqttQoS,
  type NatsMessageLike,
  type NatsTransportClientLike,
  type RabbitMqChannelLike,
  type RabbitMqMessageLike,
  type RedisTransportClientLike,
} from "../src/index";

// ---------------------------------------------------------------------------
// 1. ClientProxy requestTimeout & maxPendingRequests (PR #18591)
// ---------------------------------------------------------------------------

describe("ClientProxy requestTimeout & maxPendingRequests (PR #18591)", () => {
  it("rejects with RpcTimeoutException using requestTimeout and cleans up pendingRequestCount", async () => {
    const broker = new InMemoryBroker();
    const server = new InMemoryServer({ channel: "timeout-test", broker });
    server.addMessageHandler("slow.op", async () => {
      await Bun.sleep(200);
      return "too-late";
    });
    await server.listen();

    const client = new InMemoryClientProxy({
      channel: "timeout-test",
      broker,
      requestTimeout: 30,
    });

    await expect(client.send("slow.op", {})).rejects.toBeInstanceOf(
      RpcTimeoutException,
    );
    expect(client.pendingRequestCount).toBe(0);

    await client.close();
    await server.close();
  });

  it("enforces maxPendingRequests cap and recovers once in-flight requests settle", async () => {
    const broker = new InMemoryBroker();
    const server = new InMemoryServer({ channel: "cap-test", broker });
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const gate1 = new Promise<void>((r) => {
      releaseFirst = r;
    });
    const gate2 = new Promise<void>((r) => {
      releaseSecond = r;
    });

    server.addMessageHandler("work", async (data: unknown) => {
      const { id } = data as { id: number };
      if (id === 1) await gate1;
      if (id === 2) await gate2;
      return { done: id };
    });
    await server.listen();

    const client = new InMemoryClientProxy({
      channel: "cap-test",
      broker,
      requestTimeout: 2000,
      maxPendingRequests: 2,
    });

    const p1 = client.send("work", { id: 1 });
    const p2 = client.send("work", { id: 2 });
    expect(client.pendingRequestCount).toBe(2);

    // Third concurrent request must reject immediately
    await expect(client.send("work", { id: 3 })).rejects.toThrow(
      /Max pending requests limit \(2\) reached/,
    );
    expect(client.pendingRequestCount).toBe(2);

    // Complete first request -> capacity opens for a new request
    releaseFirst();
    expect(await p1).toEqual({ done: 1 });
    expect(client.pendingRequestCount).toBe(1);

    const p3 = client.send("work", { id: 3 });
    expect(await p3).toEqual({ done: 3 });

    releaseSecond();
    expect(await p2).toEqual({ done: 2 });
    expect(client.pendingRequestCount).toBe(0);

    await client.close();
    await server.close();
  });

  it("clears timers and rejects in-flight requests cleanly on close() over live TCP", async () => {
    const server = new TcpServer({ port: 0 });
    server.addMessageHandler("hang", async () => {
      await Bun.sleep(5000);
      return "never";
    });
    await server.listen();

    const client = new TcpClientProxy({
      host: "127.0.0.1",
      port: server.port!,
      requestTimeout: 10_000,
      maxPendingRequests: 1,
    });
    await client.connect();

    const pending = client.send("hang", {});
    expect(client.pendingRequestCount).toBe(1);

    // Second request immediately rejected by cap
    await expect(client.send("hang", {})).rejects.toThrow(
      /Max pending requests limit \(1\) reached/,
    );

    await client.close();
    await expect(pending).rejects.toThrow(/closed/i);
    expect(client.pendingRequestCount).toBe(0);

    await server.close();
  });
});

// ---------------------------------------------------------------------------
// 2. Opt-in Graceful Shutdown for RabbitMQ, MQTT, Redis, NATS
//    (PR #18525, #18513, #18505)
// ---------------------------------------------------------------------------

describe("Graceful Shutdown for RabbitMQ, MQTT, Redis, and NATS servers", () => {
  it("RabbitMqTransportServer: cancels consumer, waits for in-flight handler, then closes channel", async () => {
    const timeline: string[] = [];
    let deliveredHandler:
      | ((msg: RabbitMqMessageLike) => Promise<void> | void)
      | undefined;
    let releaseHandler!: () => void;
    const handlerGate = new Promise<void>((r) => {
      releaseHandler = r;
    });

    const channel: RabbitMqChannelLike = {
      assertQueue: (q) => ({ queue: q }),
      consume: (_q, onMsg) => {
        deliveredHandler = onMsg;
        return { consumerTag: "ctag-graceful" };
      },
      sendToQueue: () => true,
      ack: () => {
        timeline.push("ack");
      },
      cancel: async (tag) => {
        timeline.push(`cancel:${tag}`);
      },
      close: async () => {
        timeline.push("channel.close");
      },
    };

    const server = new RabbitMqTransportServer({
      channel,
      queue: "jobs",
      gracefulShutdown: true,
      gracePeriod: 2000,
    });
    server.addEventHandler("job.run", async () => {
      timeline.push("handler.start");
      await handlerGate;
      timeline.push("handler.end");
    });
    await server.listen();

    const msgPromise = deliveredHandler!({
      content: JSON.stringify({ type: "event", pattern: "job.run", data: {} }),
    });
    await Bun.sleep(5);

    const closePromise = server.close();
    await Bun.sleep(15);

    // Consumer cancelled, channel NOT closed yet while handler is in-flight
    expect(timeline).toEqual(["handler.start", "cancel:ctag-graceful"]);

    releaseHandler();
    await Promise.all([msgPromise, closePromise]);

    expect(timeline).toEqual([
      "handler.start",
      "cancel:ctag-graceful",
      "handler.end",
      "ack",
      "channel.close",
    ]);
  });

  it("RabbitMqTransportServer: bounds graceful shutdown by gracePeriod", async () => {
    let deliveredHandler:
      | ((msg: RabbitMqMessageLike) => Promise<void> | void)
      | undefined;
    let closedChannel = false;

    const channel: RabbitMqChannelLike = {
      assertQueue: (q) => ({ queue: q }),
      consume: (_q, onMsg) => {
        deliveredHandler = onMsg;
        return { consumerTag: "ctag-timeout" };
      },
      sendToQueue: () => true,
      cancel: async () => {},
      close: async () => {
        closedChannel = true;
      },
    };

    const server = new RabbitMqTransportServer({
      channel,
      queue: "jobs",
      gracefulShutdown: true,
      gracePeriod: 35,
    });
    server.addEventHandler("job.hang", async () => {
      await Bun.sleep(5000);
    });
    await server.listen();

    void deliveredHandler!({
      content: JSON.stringify({ type: "event", pattern: "job.hang", data: {} }),
    });
    await Bun.sleep(5);

    const start = Date.now();
    await server.close();
    const elapsed = Date.now() - start;

    expect(closedChannel).toBe(true);
    expect(elapsed).toBeLessThan(500);
  });

  it("MqttServer: unsubscribes, waits for in-flight handler, then closes client", async () => {
    const timeline: string[] = [];
    let listener: MqttMessageListener | undefined;
    let releaseHandler!: () => void;
    const gate = new Promise<void>((r) => {
      releaseHandler = r;
    });

    const mockMqtt: MqttClientLike = {
      publish: () => {},
      subscribe: () => {},
      unsubscribe: (topic) => {
        timeline.push(`unsubscribe:${String(topic)}`);
      },
      on: (_ev, fn) => {
        listener = fn;
      },
      off: () => {
        timeline.push("off");
      },
      end: () => {
        timeline.push("mqtt.end");
      },
    };

    const server = new MqttServer({
      client: mockMqtt,
      gracefulShutdown: true,
      gracePeriod: 2000,
    });
    server.addEventHandler("telemetry/data", async () => {
      timeline.push("handler.start");
      await gate;
      timeline.push("handler.end");
    });
    await server.listen();

    listener!(
      "telemetry/data",
      JSON.stringify({ type: "event", pattern: "telemetry/data", data: 1 }),
    );
    await Bun.sleep(5);

    const closePromise = server.close();
    await Bun.sleep(15);

    expect(timeline).toEqual([
      "handler.start",
      "off",
      "unsubscribe:telemetry/data",
    ]);

    releaseHandler();
    await closePromise;

    expect(timeline).toEqual([
      "handler.start",
      "off",
      "unsubscribe:telemetry/data",
      "handler.end",
      "mqtt.end",
    ]);
  });

  it("RedisTransportServer: unsubscribes, waits for in-flight handler, then closes client", async () => {
    const timeline: string[] = [];
    let listener: ((msg: string | Uint8Array, ch: string) => void) | undefined;
    let releaseHandler!: () => void;
    const gate = new Promise<void>((r) => {
      releaseHandler = r;
    });

    const mockRedis: RedisTransportClientLike = {
      publish: () => 1,
      subscribe: (_ch, fn) => {
        listener = fn;
      },
      unsubscribe: (ch) => {
        timeline.push(`unsubscribe:${ch}`);
      },
      quit: async () => {
        timeline.push("redis.quit");
      },
    };

    const server = new RedisTransportServer({
      pubClient: mockRedis,
      subClient: mockRedis,
      channelPrefix: "gs",
      gracefulShutdown: true,
      gracePeriod: 2000,
    });
    server.addEventHandler("evt.slow", async () => {
      timeline.push("handler.start");
      await gate;
      timeline.push("handler.end");
    });
    await server.listen();

    listener!(
      JSON.stringify({ type: "event", pattern: "evt.slow", data: "hi" }),
      "gs:evt.slow",
    );
    await Bun.sleep(5);

    const closePromise = server.close();
    await Bun.sleep(15);

    expect(timeline).toEqual(["handler.start", "unsubscribe:gs:evt.slow"]);

    releaseHandler();
    await closePromise;

    expect(timeline).toEqual([
      "handler.start",
      "unsubscribe:gs:evt.slow",
      "handler.end",
      "redis.quit",
    ]);
  });

  it("NatsTransportServer: unsubscribes, waits for in-flight handler, then drains/closes client", async () => {
    const timeline: string[] = [];
    let handlerFn: ((msg: NatsMessageLike) => Promise<void> | void) | undefined;
    let releaseHandler!: () => void;
    const gate = new Promise<void>((r) => {
      releaseHandler = r;
    });

    const mockNats: NatsTransportClientLike = {
      publish: () => {},
      subscribe: (_subject, fn) => {
        handlerFn = fn;
        return {
          unsubscribe: () => {
            timeline.push("sub.unsubscribe");
          },
        };
      },
      drain: async () => {
        timeline.push("nats.drain");
      },
    };

    const server = new NatsTransportServer({
      client: mockNats,
      gracefulShutdown: true,
      gracePeriod: 2000,
    });
    server.addEventHandler("orders.sync", async () => {
      timeline.push("handler.start");
      await gate;
      timeline.push("handler.end");
    });
    await server.listen();

    const msgPromise = handlerFn!({
      subject: "orders.sync",
      data: JSON.stringify({ type: "event", pattern: "orders.sync", data: 1 }),
    });
    await Bun.sleep(5);

    const closePromise = server.close();
    await Bun.sleep(15);

    expect(timeline).toEqual(["handler.start", "sub.unsubscribe"]);

    releaseHandler();
    await Promise.all([msgPromise, closePromise]);

    expect(timeline).toEqual([
      "handler.start",
      "sub.unsubscribe",
      "handler.end",
      "nats.drain",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 3. RabbitMQ nackOnInternalError & nackRequeue (PR #18686)
// ---------------------------------------------------------------------------

describe("RabbitMQ nackOnInternalError & nackRequeue (PR #18686)", () => {
  function makeMockChannel() {
    let consumerFn:
      | ((msg: RabbitMqMessageLike) => Promise<void> | void)
      | undefined;
    const acks: RabbitMqMessageLike[] = [];
    const nacks: Array<{
      msg: RabbitMqMessageLike;
      allUpTo?: boolean;
      requeue?: boolean;
    }> = [];

    const channel: RabbitMqChannelLike = {
      assertQueue: (q) => ({ queue: q }),
      consume: (_q, fn) => {
        consumerFn = fn;
        return { consumerTag: "ctag-1" };
      },
      sendToQueue: () => true,
      ack: (msg) => {
        acks.push(msg);
      },
      nack: (msg, allUpTo, requeue) => {
        nacks.push({ msg, allUpTo, requeue });
      },
      cancel: () => {},
    };

    return {
      channel,
      acks,
      nacks,
      deliver: (msg: RabbitMqMessageLike) => consumerFn!(msg),
    };
  }

  it("calls channel.nack(msg, false, false) on handler error when nackOnInternalError: true", async () => {
    const mock = makeMockChannel();
    const server = new RabbitMqTransportServer({
      channel: mock.channel,
      queue: "orders",
      noAck: false,
      nackOnInternalError: true,
    });
    server.addMessageHandler("fail.op", () => {
      throw new Error("internal boom");
    });
    await server.listen();

    await mock.deliver({
      content: JSON.stringify({
        type: "request",
        id: "1",
        pattern: "fail.op",
        data: {},
      }),
    });

    expect(mock.acks).toHaveLength(0);
    expect(mock.nacks).toHaveLength(1);
    expect(mock.nacks[0]!.allUpTo).toBe(false);
    expect(mock.nacks[0]!.requeue).toBe(false);

    await server.close();
  });

  it("respects nackRequeue: true when nackOnInternalError: true", async () => {
    const mock = makeMockChannel();
    const server = new RabbitMqTransportServer({
      channel: mock.channel,
      queue: "orders",
      noAck: false,
      nackOnInternalError: true,
      nackRequeue: true,
    });
    server.addMessageHandler("fail.op", () => {
      throw new RpcException("transient failure");
    });
    await server.listen();

    await mock.deliver({
      content: JSON.stringify({
        type: "request",
        id: "2",
        pattern: "fail.op",
        data: {},
      }),
    });

    expect(mock.acks).toHaveLength(0);
    expect(mock.nacks).toHaveLength(1);
    expect(mock.nacks[0]!.allUpTo).toBe(false);
    expect(mock.nacks[0]!.requeue).toBe(true);

    await server.close();
  });

  it("preserves default ack behavior when nackOnInternalError is false/omitted", async () => {
    const mock = makeMockChannel();
    const server = new RabbitMqTransportServer({
      channel: mock.channel,
      queue: "orders",
      noAck: false,
    });
    server.addMessageHandler("fail.op", () => {
      throw new Error("legacy behavior");
    });
    await server.listen();

    await mock.deliver({
      content: JSON.stringify({
        type: "request",
        id: "3",
        pattern: "fail.op",
        data: {},
      }),
    });

    expect(mock.acks).toHaveLength(1);
    expect(mock.nacks).toHaveLength(0);

    await server.close();
  });
});

// ---------------------------------------------------------------------------
// 4. KafkaServer opt-in topicConsumers (PR #16555)
// ---------------------------------------------------------------------------

describe("KafkaServer topicConsumers (PR #16555)", () => {
  it("creates one consumer per topic/regex, isolates slow handlers, warns once on invalid groupId, and disconnects in parallel", async () => {
    const createdGroupIds: string[] = [];
    const disconnectedInOrder: string[] = [];
    const committedByConsumer = new Map<string, string[]>();
    const activeConsumers = new Map<
      string,
      {
        groupId: string;
        subscriptions: Array<string | RegExp>;
        eachMessage?: (payload: KafkaEachMessagePayload) => Promise<void>;
      }
    >();

    let concurrentDisconnects = 0;
    let maxConcurrentDisconnects = 0;

    const mockClient: KafkaClientLike = {
      producer(): KafkaProducerLike {
        return {
          connect: async () => {},
          disconnect: async () => {},
          send: async (record: KafkaProducerRecord) => {
            for (const msg of record.messages) {
              for (const c of activeConsumers.values()) {
                const matched = c.subscriptions.some((s) =>
                  s instanceof RegExp
                    ? s.test(record.topic)
                    : s === record.topic,
                );
                if (matched && c.eachMessage) {
                  queueMicrotask(() => {
                    void c.eachMessage!({
                      topic: record.topic,
                      partition: 0,
                      message: {
                        key: msg.key,
                        value: msg.value,
                        headers: msg.headers,
                        offset: "5",
                      },
                    });
                  });
                }
              }
            }
          },
        };
      },
      consumer(cfg): KafkaConsumerLike {
        createdGroupIds.push(cfg.groupId);
        const state = {
          groupId: cfg.groupId,
          subscriptions: [] as Array<string | RegExp>,
          eachMessage: undefined as
            | ((payload: KafkaEachMessagePayload) => Promise<void>)
            | undefined,
        };
        return {
          connect: async () => {
            activeConsumers.set(cfg.groupId, state);
          },
          disconnect: async () => {
            concurrentDisconnects++;
            maxConcurrentDisconnects = Math.max(
              maxConcurrentDisconnects,
              concurrentDisconnects,
            );
            await Bun.sleep(15);
            concurrentDisconnects--;
            disconnectedInOrder.push(cfg.groupId);
            activeConsumers.delete(cfg.groupId);
          },
          subscribe: async (sub) => {
            if (sub.topic !== undefined) state.subscriptions.push(sub.topic);
          },
          run: async (runCfg) => {
            state.eachMessage = runCfg.eachMessage;
          },
          commitOffsets: async (offsets) => {
            const list = committedByConsumer.get(cfg.groupId) ?? [];
            for (const o of offsets) list.push(`${o.topic}:${o.offset}`);
            committedByConsumer.set(cfg.groupId, list);
          },
        };
      },
    };

    const server = new KafkaServer({
      client: mockClient,
      groupId: "svc",
      topicConsumers: true,
    });

    // Spy on logger.warn to verify deduplicated warning on whitespace/long groupId
    const warnings: string[] = [];
    (server as unknown as { logger: { warn: (m: string) => void } }).logger = {
      warn: (m: string) => {
        warnings.push(m);
      },
    };

    server.addMessageHandler("fast.topic", async (data, ctx) => {
      await (ctx as KafkaContext).commitOffset();
      return { fast: data };
    });
    server.addMessageHandler("slow.topic", async (data) => {
      await Bun.sleep(40);
      return { slow: data };
    });
    server.addEventHandler(/^dyn\.[a-z]+$/, () => {});
    server.addEventHandler("bad topic with spaces", () => {});

    await server.listen();

    expect(createdGroupIds).toContain("svc-fast.topic");
    expect(createdGroupIds).toContain("svc-slow.topic");
    expect(createdGroupIds).toContain("svc-/^dyn\\.[a-z]+$/");
    expect(createdGroupIds).toContain("svc-bad topic with spaces");
    expect(createdGroupIds).toHaveLength(4);

    // Warning emitted once for whitespace groupId
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("svc-bad topic with spaces");

    const client = new KafkaClientProxy({ client: mockClient });
    const [resFast, resSlow] = await Promise.all([
      client.send("fast.topic", { ok: 1 }),
      client.send("slow.topic", { ok: 2 }),
    ]);

    expect(resFast).toEqual({ fast: { ok: 1 } });
    expect(resSlow).toEqual({ slow: { ok: 2 } });
    // commitOffset routed to the per-topic consumer for fast.topic
    expect(committedByConsumer.get("svc-fast.topic")).toEqual(["fast.topic:6"]);

    await client.close();
    disconnectedInOrder.length = 0;
    maxConcurrentDisconnects = 0;
    await server.close();

    // All 4 topic consumers disconnected in parallel
    expect(disconnectedInOrder).toHaveLength(4);
    expect(maxConcurrentDisconnects).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// 5. Per-handler MQTT QoS override via extras.qos (PR #16286)
// ---------------------------------------------------------------------------

describe("MQTT per-handler QoS override via extras.qos (PR #16286)", () => {
  it("subscribes each topic with handler extras.qos from @MessagePattern/@EventPattern, falling back to server default", async () => {
    const subscriptions = new Map<string, MqttQoS>();
    const mockMqtt: MqttClientLike = {
      publish: () => {},
      subscribe: (topic, opts) => {
        const list = Array.isArray(topic) ? topic : [topic];
        for (const t of list) {
          subscriptions.set(t, opts?.qos ?? 0);
        }
      },
      unsubscribe: () => {},
      on: () => {},
      off: () => {},
    };

    @Controller()
    class SensorController {
      @MessagePattern("sensors/critical", { qos: 2 })
      handleCritical(data: unknown) {
        return data;
      }

      @MessagePattern("sensors/default")
      handleDefault(data: unknown) {
        return data;
      }

      @EventPattern("alerts/#", { qos: 1 })
      handleAlerts(_data: unknown) {}
    }

    @Module({
      imports: [
        MicroserviceModule.forRoot({
          transport: Transport.MQTT,
          options: {
            client: mockMqtt,
            qos: 0,
          },
        }),
      ],
      controllers: [SensorController],
    })
    class MqttTestModule {}

    const mod = await Test.createTestingModule({
      imports: [MqttTestModule],
    }).compile();
    await mod.init();

    expect(subscriptions.get("sensors/critical")).toBe(2);
    expect(subscriptions.get("sensors/default")).toBe(0);
    expect(subscriptions.get("alerts/#")).toBe(1);

    await mod.close();
  });
});

// ---------------------------------------------------------------------------
// 6. Redis transport returnBuffers (PR #16676)
// ---------------------------------------------------------------------------

describe("Redis transport returnBuffers option (PR #16676)", () => {
  it("preserves raw binary Uint8Array/Buffer payloads without UTF-8 conversion when returnBuffers: true", async () => {
    const channels = new Map<
      string,
      Set<(msg: string | Uint8Array, ch: string) => void>
    >();
    const mockRedis: RedisTransportClientLike = {
      subscribe(channel, listener) {
        let set = channels.get(channel);
        if (!set) {
          set = new Set();
          channels.set(channel, set);
        }
        set.add(listener);
      },
      unsubscribe(channel) {
        channels.delete(channel);
      },
      publish(channel, message) {
        for (const fn of channels.get(channel) ?? []) {
          fn(message, channel);
        }
        return 1;
      },
    };

    const server = new RedisTransportServer({
      pubClient: mockRedis,
      subClient: mockRedis,
      channelPrefix: "bin",
      returnBuffers: true,
    });

    const receivedRaw: Uint8Array[] = [];
    server.addEventHandler("raw.bytes", (data) => {
      receivedRaw.push(data as Uint8Array);
    });
    server.addMessageHandler("echo.buf", (data) => {
      const buf = data as Uint8Array;
      return Uint8Array.from([...buf, 0x99]);
    });

    await server.listen();

    // 1. Direct non-UTF8 binary payload delivered to Redis channel
    const rawBytes = new Uint8Array([0xff, 0x00, 0xfe, 0x80, 0x42]);
    for (const fn of channels.get("bin:raw.bytes") ?? []) {
      fn(rawBytes, "bin:raw.bytes");
    }
    await Bun.sleep(10);

    expect(receivedRaw).toHaveLength(1);
    expect(receivedRaw[0]).toBeInstanceOf(Uint8Array);
    expect([...receivedRaw[0]!]).toEqual([0xff, 0x00, 0xfe, 0x80, 0x42]);

    // 2. Binary RPC request-reply round-trip via RedisClientProxy with returnBuffers: true
    const client = new RedisClientProxy({
      pubClient: mockRedis,
      subClient: mockRedis,
      channelPrefix: "bin",
      returnBuffers: true,
    });
    const reply = await client.send<Uint8Array>(
      "echo.buf",
      new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
    );
    expect(reply).toBeInstanceOf(Uint8Array);
    expect([...reply]).toEqual([0xde, 0xad, 0xbe, 0xef, 0x99]);

    await client.close();
    await server.close();
  });
});

// ---------------------------------------------------------------------------
// 7. Consistent get server() getter across all 8 server classes (PR #17028)
// ---------------------------------------------------------------------------

describe("Consistent get server() getter across all 8 microservice server classes (PR #17028)", () => {
  it("exposes underlying server/client instance on all 8 server classes", async () => {
    // 1. TcpServer
    const tcp = new TcpServer({ port: 0 });
    expect(tcp.server).toBeUndefined();
    await tcp.listen();
    expect(tcp.server).toBeDefined();
    expect(tcp.server?.port).toBe(tcp.port);
    await tcp.close();
    expect(tcp.server).toBeUndefined();

    // 2. GrpcServer
    const grpc = new GrpcServer({ port: 0 });
    expect(grpc.server).toBeUndefined();
    await grpc.listen();
    expect(grpc.server).toBeDefined();
    expect(grpc.server?.port).toBe(grpc.port);
    await grpc.close();
    expect(grpc.server).toBeUndefined();

    // 3. RabbitMqTransportServer
    const rmqChannel: RabbitMqChannelLike = {
      assertQueue: (q) => ({ queue: q }),
      consume: () => ({ consumerTag: "t" }),
      sendToQueue: () => true,
    };
    const rmq = new RabbitMqTransportServer({
      channel: rmqChannel,
      queue: "q",
    });
    expect(rmq.server).toBe(rmqChannel);

    // 4. RedisTransportServer
    const redisSub: RedisTransportClientLike = {
      publish: () => 1,
      subscribe: () => {},
    };
    const redis = new RedisTransportServer({
      pubClient: redisSub,
      subClient: redisSub,
    });
    expect(redis.server).toBe(redisSub);

    // 5. NatsTransportServer
    const natsClient: NatsTransportClientLike = {
      publish: () => {},
      subscribe: () => ({ unsubscribe: () => {} }),
    };
    const nats = new NatsTransportServer({ client: natsClient });
    expect(nats.server).toBe(natsClient);

    // 6. MqttServer
    const mqttClient: MqttClientLike = {
      publish: () => {},
      subscribe: () => {},
      on: () => {},
    };
    const mqtt = new MqttServer({ client: mqttClient });
    expect(mqtt.server).toBe(mqttClient);

    // 7. KafkaServer
    const kafkaConsumer: KafkaConsumerLike = {
      connect: async () => {},
      disconnect: async () => {},
      subscribe: async () => {},
      run: async () => {},
    };
    const kafka = new KafkaServer({ consumer: kafkaConsumer });
    expect(kafka.server).toBe(kafkaConsumer);

    // 8. InMemoryServer
    const broker = new InMemoryBroker();
    const inMem = new InMemoryServer({ broker, channel: "srv-getter" });
    expect(inMem.server).toBe(broker);
  });
});
