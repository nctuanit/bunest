import { describe, expect, it } from "bun:test";
import { Test } from "@bunest/testing";
import {
  ClientsModule,
  GrpcServer,
  InMemoryServer,
  KAFKA_CORRELATION_ID_HEADER,
  KAFKA_REPLY_TOPIC_HEADER,
  KafkaClientProxy,
  KafkaContext,
  KafkaServer,
  MqttClientProxy,
  MqttContext,
  MqttServer,
  NatsServer,
  RabbitMqServer,
  RedisClientProxy,
  RedisServer,
  RpcException,
  TcpServer,
  Transport,
  matchMqttTopic,
  type KafkaClientLike,
  type KafkaConsumerLike,
  type KafkaEachMessagePayload,
  type KafkaProducerLike,
  type KafkaProducerRecord,
  type MqttClientLike,
  type MqttMessageListener,
  type MqttPublishOptions,
  type MqttQoS,
  type RedisTransportClientLike,
} from "../src/index";

// ---------------------------------------------------------------------------
// 1. Redis Per-Client Reply Inbox Isolation Regression Test
// ---------------------------------------------------------------------------

describe("Redis RPC Per-Client Reply Inbox Isolation", () => {
  it("routes replies exclusively to each client's unique reply inbox without broadcasting/leaking across concurrent clients", async () => {
    const channelSubs = new Map<
      string,
      Set<(message: string, channel: string) => void>
    >();
    const clientADeliveries: Array<{ channel: string; message: string }> = [];
    const clientBDeliveries: Array<{ channel: string; message: string }> = [];

    const makeScopedRedisClient = (
      deliveryLog?: Array<{ channel: string; message: string }>,
    ): RedisTransportClientLike => ({
      subscribe(channel, listener) {
        let set = channelSubs.get(channel);
        if (!set) {
          set = new Set();
          channelSubs.set(channel, set);
        }
        const wrapped = (msg: string, ch: string) => {
          deliveryLog?.push({ channel: ch, message: msg });
          listener(msg, ch);
        };
        set.add(wrapped);
      },
      unsubscribe(channel) {
        channelSubs.delete(channel);
      },
      publish(channel, message) {
        const listeners = [...(channelSubs.get(channel) ?? [])];
        for (const fn of listeners) {
          fn(message, channel);
        }
        return listeners.length;
      },
    });

    const serverRedis = makeScopedRedisClient();
    const server = new RedisServer({
      pubClient: serverRedis,
      subClient: serverRedis,
      channelPrefix: "iso",
    });

    server.addMessageHandler("orders.get", async (data) => {
      const { clientTag, delayMs } = data as {
        clientTag: string;
        delayMs: number;
      };
      await Bun.sleep(delayMs);
      return { owner: clientTag, secret: `secret-for-${clientTag}` };
    });

    await server.listen();

    const clientA = new RedisClientProxy({
      pubClient: serverRedis,
      subClient: makeScopedRedisClient(clientADeliveries),
      channelPrefix: "iso",
      clientId: "client-a",
    });
    const clientB = new RedisClientProxy({
      pubClient: serverRedis,
      subClient: makeScopedRedisClient(clientBDeliveries),
      channelPrefix: "iso",
      clientId: "client-b",
    });

    // Unique per-client reply channels
    expect(clientA.replyChannel).toBe("iso:reply:client-a");
    expect(clientB.replyChannel).toBe("iso:reply:client-b");
    expect(clientA.replyChannel).not.toBe(clientB.replyChannel);

    // Concurrent calls to the SAME pattern "orders.get"
    const [resA1, resB1, resA2, resB2] = await Promise.all([
      clientA.send<{ owner: string; secret: string }>("orders.get", {
        clientTag: "A1",
        delayMs: 30,
      }),
      clientB.send<{ owner: string; secret: string }>("orders.get", {
        clientTag: "B1",
        delayMs: 5,
      }),
      clientA.send<{ owner: string; secret: string }>("orders.get", {
        clientTag: "A2",
        delayMs: 10,
      }),
      clientB.send<{ owner: string; secret: string }>("orders.get", {
        clientTag: "B2",
        delayMs: 20,
      }),
    ]);

    expect(resA1).toEqual({ owner: "A1", secret: "secret-for-A1" });
    expect(resA2).toEqual({ owner: "A2", secret: "secret-for-A2" });
    expect(resB1).toEqual({ owner: "B1", secret: "secret-for-B1" });
    expect(resB2).toEqual({ owner: "B2", secret: "secret-for-B2" });

    // Crucial isolation check: clientA NEVER saw clientB's replies and vice versa!
    expect(clientADeliveries).toHaveLength(2);
    expect(clientBDeliveries).toHaveLength(2);
    expect(
      clientADeliveries.every((d) => d.channel === "iso:reply:client-a"),
    ).toBe(true);
    expect(
      clientBDeliveries.every((d) => d.channel === "iso:reply:client-b"),
    ).toBe(true);
    expect(
      clientADeliveries.some((d) => d.message.includes("secret-for-B")),
    ).toBe(false);
    expect(
      clientBDeliveries.some((d) => d.message.includes("secret-for-A")),
    ).toBe(false);

    // Closing clientA unsubscribes ONLY clientA's inbox — clientB keeps working cleanly!
    await clientA.close();
    const resB3 = await clientB.send<{ owner: string }>("orders.get", {
      clientTag: "B3",
      delayMs: 5,
    });
    expect(resB3.owner).toBe("B3");

    await clientB.close();
    await server.close();
  });
});

// ---------------------------------------------------------------------------
// 2. Kafka Transport Tests (Request-Reply, RegExp, KafkaContext, Events)
// ---------------------------------------------------------------------------

class MockKafkaBroker {
  private readonly consumers = new Set<{
    groupId: string;
    subscriptions: Array<string | RegExp>;
    eachMessage?: (payload: KafkaEachMessagePayload) => Promise<void>;
    disconnected: boolean;
  }>();
  public readonly committedOffsets: Array<{
    topic: string;
    partition: number;
    offset: string;
  }> = [];
  public heartbeats = 0;
  public readonly sentRecords: KafkaProducerRecord[] = [];
  private offsetSeq = 0;

  createClient(): KafkaClientLike {
    const broker = this;
    return {
      producer(): KafkaProducerLike {
        let connected = false;
        return {
          async connect() {
            connected = true;
          },
          async disconnect() {
            connected = false;
          },
          async send(record: KafkaProducerRecord) {
            if (!connected) {
              throw new Error("Kafka producer not connected");
            }
            broker.sentRecords.push(record);

            for (const msg of record.messages) {
              const offset = String(broker.offsetSeq++);
              const partition = msg.partition ?? 0;

              for (const consumer of [...broker.consumers]) {
                if (consumer.disconnected || !consumer.eachMessage) continue;
                const matched = consumer.subscriptions.some((sub) =>
                  sub instanceof RegExp
                    ? sub.test(record.topic)
                    : sub === record.topic,
                );
                if (!matched) continue;

                const payload: KafkaEachMessagePayload = {
                  topic: record.topic,
                  partition,
                  message: {
                    key: msg.key,
                    value: msg.value,
                    headers: msg.headers,
                    offset,
                    timestamp: String(Date.now()),
                  },
                  heartbeat: async () => {
                    broker.heartbeats++;
                  },
                };
                // Deliver asynchronously like a real broker
                queueMicrotask(() => {
                  void consumer.eachMessage?.(payload);
                });
              }
            }
          },
        };
      },
      consumer(config: { readonly groupId: string }): KafkaConsumerLike {
        const entry = {
          groupId: config.groupId,
          subscriptions: [] as Array<string | RegExp>,
          eachMessage: undefined as
            ((payload: KafkaEachMessagePayload) => Promise<void>) | undefined,
          disconnected: false,
        };
        return {
          async connect() {
            entry.disconnected = false;
            broker.consumers.add(entry);
          },
          async disconnect() {
            entry.disconnected = true;
            broker.consumers.delete(entry);
          },
          async subscribe(sub) {
            if (sub.topic !== undefined) {
              entry.subscriptions.push(sub.topic);
            }
            if (sub.topics) {
              entry.subscriptions.push(...sub.topics);
            }
          },
          async run(runCfg) {
            entry.eachMessage = runCfg.eachMessage;
          },
          async commitOffsets(offsets) {
            broker.committedOffsets.push(...offsets);
          },
          async stop() {
            entry.eachMessage = undefined;
          },
        };
      },
    };
  }
}

describe("KafkaServer & KafkaClientProxy", () => {
  it("supports request-reply correlation, RegExp topic patterns, KafkaContext, emit(), and error propagation", async () => {
    const broker = new MockKafkaBroker();
    const kafkaClient = broker.createClient();

    const server = new KafkaServer({
      client: kafkaClient,
      groupId: "orders-group",
      autoCommit: false,
    });

    const eventsSeen: Array<{
      topic: string;
      pattern: string;
      key: string | null;
      headerTrace: string | undefined;
      data: unknown;
    }> = [];

    server.addMessageHandler("orders.create", async (data, ctx) => {
      const kCtx = ctx as KafkaContext;
      await kCtx.heartbeat();
      await kCtx.commitOffset();
      const input = data as { sku: string; qty: number };
      if (input.qty <= 0) {
        throw new RpcException({
          status: 400,
          message: "qty must be positive",
        });
      }
      return {
        orderId: `ord_${input.sku}`,
        topic: kCtx.getTopic(),
        partition: kCtx.getPartition(),
        offset: kCtx.getOffset(),
        key: kCtx.getKey(),
        trace: kCtx.getHeaders()["x-trace"],
      };
    });

    // RegExp message pattern matching dynamic tenant topics
    server.addMessageHandler(/^billing\.[a-z]+\.charge$/, (data, ctx) => {
      const kCtx = ctx as KafkaContext;
      return { chargedTopic: kCtx.topic, payload: data };
    });

    // RegExp event pattern
    server.addEventHandler(/^audit\..+/, (data, ctx) => {
      const kCtx = ctx as KafkaContext;
      eventsSeen.push({
        topic: kCtx.topic,
        pattern: kCtx.pattern,
        key: kCtx.key,
        headerTrace: kCtx.headers["x-trace"],
        data,
      });
    });

    await server.listen();

    const client = new KafkaClientProxy({
      client: kafkaClient,
      groupId: "gateway-client",
    });
    client.subscribeToResponseOf("orders.create");
    await client.connect();

    // 1. Request-reply with key, partition, custom headers, heartbeat & commitOffset
    const created = await client.sendRecord<{
      orderId: string;
      topic: string;
      partition: number;
      offset: string;
      key: string | null;
      trace: string;
    }>("orders.create", {
      key: "tenant-1",
      partition: 2,
      headers: { "x-trace": "trace-abc" },
      value: { sku: "KFK", qty: 3 },
    });

    expect(created.orderId).toBe("ord_KFK");
    expect(created.topic).toBe("orders.create");
    expect(created.partition).toBe(2);
    expect(created.key).toBe("tenant-1");
    expect(created.trace).toBe("trace-abc");
    expect(broker.heartbeats).toBe(1);
    expect(broker.committedOffsets).toHaveLength(1);
    expect(broker.committedOffsets[0]!.topic).toBe("orders.create");

    // Verify kafka_correlationId and kafka_replyTopic headers were transmitted
    const reqRecord = broker.sentRecords.find(
      (r) => r.topic === "orders.create",
    );
    expect(
      reqRecord?.messages[0]?.headers?.[KAFKA_CORRELATION_ID_HEADER],
    ).toBeTruthy();
    expect(reqRecord?.messages[0]?.headers?.[KAFKA_REPLY_TOPIC_HEADER]).toBe(
      "orders.create.reply",
    );

    // 2. RegExp topic pattern matching via standard send()
    const charged = await client.send("billing.acme.charge", { cents: 500 });
    expect(charged).toEqual({
      chargedTopic: "billing.acme.charge",
      payload: { cents: 500 },
    });

    // 3. RpcException propagation
    await expect(
      client.send("orders.create", { sku: "BAD", qty: 0 }),
    ).rejects.toThrow("qty must be positive");

    // 4. Fire-and-forget emit() & emitRecord() matching RegExp event handler
    await client.emit("audit.login", { userId: "u_1" });
    await client.emitRecord("audit.logout", {
      key: "u_1",
      headers: { "x-trace": "t_2" },
      value: { reason: "manual" },
    });
    await Bun.sleep(20);

    expect(eventsSeen).toHaveLength(2);
    expect(eventsSeen[0]!.topic).toBe("audit.login");
    expect(eventsSeen[0]!.data).toEqual({ userId: "u_1" });
    expect(eventsSeen[1]!.topic).toBe("audit.logout");
    expect(eventsSeen[1]!.key).toBe("u_1");
    expect(eventsSeen[1]!.headerTrace).toBe("t_2");

    // 5. Graceful disconnect via ClientsModule too
    const mod = await Test.createTestingModule({
      imports: [
        ClientsModule.register([
          {
            name: "KAFKA_SVC",
            transport: Transport.KAFKA,
            options: { client: kafkaClient },
          },
        ]),
      ],
    }).compile();
    await mod.init();
    const diClient = mod.get<KafkaClientProxy>("KAFKA_SVC");
    expect(diClient).toBeInstanceOf(KafkaClientProxy);
    expect(await diClient.send("billing.beta.charge", { cents: 100 })).toEqual({
      chargedTopic: "billing.beta.charge",
      payload: { cents: 100 },
    });

    await mod.close();
    await client.close();
    await server.close();
    expect(server.isListening).toBe(false);
  });

  it("single-flights concurrent KafkaClientProxy.send() connects, handles stateful /g RegExp topics, retries sendRecord(), and serializes undefined safely", async () => {
    let consumerConnectCalls = 0;
    let producerConnectCalls = 0;
    const baseBroker = new MockKafkaBroker();
    const baseClient = baseBroker.createClient();

    const countingClient: KafkaClientLike = {
      producer() {
        const p = baseClient.producer();
        return {
          ...p,
          async connect() {
            producerConnectCalls++;
            await Bun.sleep(10);
            await p.connect();
          },
        };
      },
      consumer(cfg) {
        const c = baseClient.consumer(cfg);
        return {
          ...c,
          async connect() {
            consumerConnectCalls++;
            await Bun.sleep(10);
            await c.connect();
          },
        };
      },
    };

    const server = new KafkaServer({ client: baseClient, groupId: "sf-srv" });
    let retryCount = 0;
    // Stateful /g regex MUST match repeatedly without lastIndex bug
    server.addMessageHandler(/^dyn\.[a-z]+$/g, (data) => ({ echoed: data }));
    server.addMessageHandler("flaky.rec", () => {
      retryCount++;
      if (retryCount === 1) {
        throw new Error("transient-kafka-fault");
      }
      return { ok: true, retryCount };
    });
    await server.listen();

    const client = new KafkaClientProxy({ client: countingClient });
    // Fire 3 concurrent sends BEFORE calling connect()
    const [r1, r2, r3] = await Promise.all([
      client.send("dyn.alpha", undefined),
      client.send("dyn.beta", { n: 2 }),
      client.send("dyn.gamma", { n: 3 }),
    ]);

    expect(r1).toEqual({ echoed: null });
    expect(r2).toEqual({ echoed: { n: 2 } });
    expect(r3).toEqual({ echoed: { n: 3 } });
    expect(producerConnectCalls).toBe(1);
    expect(consumerConnectCalls).toBe(1);

    const recRes = await client.sendRecord<{ ok: boolean; retryCount: number }>(
      "flaky.rec",
      { key: "k1", value: { try: 1 } },
      { retries: 2, retryDelayMs: 5 },
    );
    expect(recRes).toEqual({ ok: true, retryCount: 2 });

    await client.close();
    await server.close();
  });
});

// ---------------------------------------------------------------------------
// 3. MQTT Transport Tests (+ / # Wildcards, Per-Client Replies, MqttContext, QoS)
// ---------------------------------------------------------------------------

class MockMqttBroker {
  private readonly clients = new Set<{
    subscriptions: Map<string, MqttQoS>;
    listeners: Set<MqttMessageListener>;
    onDelivery?: (topic: string, payload: Uint8Array | Buffer | string) => void;
    ended: boolean;
  }>();
  public readonly published: Array<{
    topic: string;
    message: string | Uint8Array;
    options?: MqttPublishOptions;
  }> = [];

  createClient(
    onDelivery?: (topic: string, payload: Uint8Array | Buffer | string) => void,
  ): MqttClientLike {
    const broker = this;
    const state = {
      subscriptions: new Map<string, MqttQoS>(),
      listeners: new Set<MqttMessageListener>(),
      onDelivery,
      ended: false,
    };
    this.clients.add(state);

    return {
      subscribe(topic, options) {
        const list = Array.isArray(topic) ? topic : [topic];
        for (const t of list) {
          state.subscriptions.set(t, options?.qos ?? 0);
        }
      },
      unsubscribe(topic) {
        const list = Array.isArray(topic) ? topic : [topic];
        for (const t of list) {
          state.subscriptions.delete(t);
        }
      },
      on(_event, listener) {
        state.listeners.add(listener);
      },
      off(_event, listener) {
        state.listeners.delete(listener);
      },
      publish(topic, message, options) {
        broker.published.push({ topic, message, options });
        for (const c of [...broker.clients]) {
          if (c.ended) continue;
          let matchedQos: MqttQoS | undefined;
          for (const [filter, subQos] of c.subscriptions.entries()) {
            if (filter === topic || matchMqttTopic(filter, topic)) {
              matchedQos = Math.min(subQos, options?.qos ?? 0) as MqttQoS;
              break;
            }
          }
          if (matchedQos === undefined) continue;
          const packet = {
            topic,
            payload: message,
            qos: options?.qos ?? matchedQos,
            retain: options?.retain ?? false,
          };
          for (const listener of [...c.listeners]) {
            queueMicrotask(() => {
              c.onDelivery?.(topic, message);
              listener(topic, message, packet);
            });
          }
        }
      },
      end() {
        state.ended = true;
        state.listeners.clear();
        state.subscriptions.clear();
        broker.clients.delete(state);
      },
    };
  }
}

describe("MQTT Topic Wildcard Matcher & MqttServer / MqttClientProxy", () => {
  it("implements full MQTT 3.1.1/5.0 wildcard matching (+, #, parent #, invalid syntax, $SYS protection)", () => {
    // Single-level '+'
    expect(matchMqttTopic("sensors/+/temp", "sensors/room1/temp")).toBe(true);
    expect(matchMqttTopic("sensors/+/temp", "sensors/room1/humidity")).toBe(
      false,
    );
    expect(matchMqttTopic("sensors/+/temp", "sensors/floor1/room1/temp")).toBe(
      false,
    );
    expect(matchMqttTopic("+/+", "a/b")).toBe(true);
    expect(matchMqttTopic("a/+/c", "a//c")).toBe(true);

    // Multi-level '#'
    expect(matchMqttTopic("devices/#", "devices")).toBe(true); // Parent level!
    expect(matchMqttTopic("devices/#", "devices/d1")).toBe(true);
    expect(matchMqttTopic("devices/#", "devices/d1/metrics/cpu")).toBe(true);
    expect(matchMqttTopic("devices/#", "other/d1")).toBe(false);
    expect(matchMqttTopic("#", "any/topic/here")).toBe(true);

    // Combined '+' and '#'
    expect(
      matchMqttTopic("tenants/+/devices/#", "tenants/acme/devices/s1/status"),
    ).toBe(true);
    expect(matchMqttTopic("tenants/+/devices/#", "tenants/acme/devices")).toBe(
      true,
    );

    // Invalid wildcard placements must return false
    expect(matchMqttTopic("a/#/b", "a/x/b")).toBe(false);
    expect(matchMqttTopic("a/b#", "a/bc")).toBe(false);
    expect(matchMqttTopic("a/b+", "a/bc")).toBe(false);

    // MQTT 4.7.2: root wildcards must NOT match $SYS system topics
    expect(matchMqttTopic("#", "$SYS/broker/clients")).toBe(false);
    expect(matchMqttTopic("+/broker/clients", "$SYS/broker/clients")).toBe(
      false,
    );
    expect(matchMqttTopic("$SYS/#", "$SYS/broker/clients")).toBe(true);
  });

  it("routes + and # wildcards, isolates per-client reply topics, preserves MqttContext & QoS, and disconnects cleanly", async () => {
    const broker = new MockMqttBroker();
    const serverClient = broker.createClient();

    const server = new MqttServer({
      client: serverClient,
      qos: 1,
      closeClientOnClose: true,
    });

    const telemetryEvents: Array<{
      filter: string;
      topic: string;
      qos: MqttQoS;
      retain: boolean;
      data: unknown;
    }> = [];

    // Register both '+' and '#' RPC handlers to verify specificity precedence
    server.addMessageHandler("devices/+/command", (data, ctx) => {
      const mCtx = ctx as MqttContext;
      return {
        matched: "single-level",
        topic: mCtx.getTopic(),
        qos: mCtx.getQoS(),
        payload: data,
      };
    });

    server.addMessageHandler("devices/#", (data, ctx) => {
      const mCtx = ctx as MqttContext;
      return {
        matched: "multi-level",
        topic: mCtx.getTopic(),
        qos: mCtx.getQoS(),
        payload: data,
      };
    });

    server.addEventHandler("telemetry/#", (data, ctx) => {
      const mCtx = ctx as MqttContext;
      telemetryEvents.push({
        filter: mCtx.pattern,
        topic: mCtx.topic,
        qos: mCtx.qos,
        retain: mCtx.isRetained(),
        data,
      });
    });

    await server.listen();

    const c1Replies: string[] = [];
    const c2Replies: string[] = [];

    const client1 = new MqttClientProxy({
      client: broker.createClient((t) => c1Replies.push(t)),
      clientId: "edge-1",
      qos: 1,
      closeClientOnClose: true,
    });
    const client2 = new MqttClientProxy({
      client: broker.createClient((t) => c2Replies.push(t)),
      clientId: "edge-2",
      qos: 2,
      closeClientOnClose: true,
    });

    // Per-client reply topic isolation
    expect(client1.getReplyTopic("devices/d1/command")).toBe(
      "devices/d1/command/reply/edge-1",
    );
    expect(client2.getReplyTopic("devices/d1/command")).toBe(
      "devices/d1/command/reply/edge-2",
    );

    // Concurrent calls on the SAME topic route to '+' (more specific than '#')
    // and each client receives only its own reply topic!
    const [r1, r2, rDeep] = await Promise.all([
      client1.send<{
        matched: string;
        topic: string;
        qos: number;
        payload: unknown;
      }>("devices/d1/command", { action: "reboot" }),
      client2.send<{
        matched: string;
        topic: string;
        qos: number;
        payload: unknown;
      }>("devices/d1/command", { action: "ping" }),
      client1.send<{ matched: string; topic: string }>(
        "devices/d1/sub/deep/info",
        { full: true },
      ),
    ]);

    expect(r1).toEqual({
      matched: "single-level",
      topic: "devices/d1/command",
      qos: 1,
      payload: { action: "reboot" },
    });
    expect(r2).toEqual({
      matched: "single-level",
      topic: "devices/d1/command",
      qos: 2,
      payload: { action: "ping" },
    });
    expect(rDeep.matched).toBe("multi-level");
    expect(rDeep.topic).toBe("devices/d1/sub/deep/info");

    // Verify per-client MQTT reply topic isolation: neither client received the other's replies
    expect(c1Replies.sort()).toEqual([
      "devices/d1/command/reply/edge-1",
      "devices/d1/sub/deep/info/reply/edge-1",
    ]);
    expect(c2Replies).toEqual(["devices/d1/command/reply/edge-2"]);

    // Verify QoS & retain options on events
    await client2.emitWithOptions(
      "telemetry/floor2/sensor9",
      { tempC: 23.5 },
      { qos: 2, retain: true },
    );
    await Bun.sleep(20);

    expect(telemetryEvents).toEqual([
      {
        filter: "telemetry/#",
        topic: "telemetry/floor2/sensor9",
        qos: 2,
        retain: true,
        data: { tempC: 23.5 },
      },
    ]);

    await client1.close();
    await client2.close();
    await server.close();
    expect(server.isListening).toBe(false);
  });

  it("single-flights concurrent MqttClientProxy reply subscriptions and recovers cleanly after a failed subscribe", async () => {
    let failFirstSubscribe = true;
    let subCalls = 0;
    const listeners = new Set<MqttMessageListener>();
    const brokerClient: MqttClientLike = {
      async subscribe(_topic) {
        subCalls++;
        await Bun.sleep(10);
        if (failFirstSubscribe) {
          failFirstSubscribe = false;
          throw new Error("temporary-sub-failure");
        }
      },
      on(_ev, l) {
        listeners.add(l);
      },
      off(_ev, l) {
        listeners.delete(l);
      },
      publish(_topic, msg) {
        const parsed = JSON.parse(String(msg)) as {
          id: string;
          replyTo?: string;
          data: unknown;
        };
        if (parsed.replyTo) {
          const reply = JSON.stringify({
            type: "response",
            id: parsed.id,
            response: parsed.data,
            isDisposed: true,
          });
          for (const l of listeners) {
            queueMicrotask(() => l(parsed.replyTo!, reply));
          }
        }
      },
    };

    const client = new MqttClientProxy({
      client: brokerClient,
      clientId: "sf-mqtt",
    });
    // First subscribe rejects -> MUST NOT poison subscribedReplyTopics
    await expect(client.send("t/op", { n: 0 })).rejects.toThrow(
      "temporary-sub-failure",
    );

    // Next 2 concurrent sends single-flight onto ONE subscribe call and both succeed!
    const [a, b] = await Promise.all([
      client.send("t/op", { n: 1 }),
      client.send("t/op", { n: 2 }),
    ]);
    expect(a).toEqual({ n: 1 });
    expect(b).toEqual({ n: 2 });
    expect(subCalls).toBe(2); // 1 failed + 1 single-flight succeeded

    await client.close();
  });
});

// ---------------------------------------------------------------------------
// 4. Hybrid app.connectMicroservice() Contract Verification Across All 8 Servers
// ---------------------------------------------------------------------------

describe("All 8 Microservice Servers Conform to { listen(): Promise<void>; close(): Promise<void> }", () => {
  it("exposes listen() and close() on Tcp, InMemory, Redis, Nats, RabbitMq, Grpc, Kafka, and Mqtt servers", () => {
    const noopRedis: RedisTransportClientLike = {
      publish: () => 0,
      subscribe: () => {},
    };
    const servers = [
      new TcpServer({ port: 0 }),
      new InMemoryServer(),
      new RedisServer({ pubClient: noopRedis }),
      new NatsServer({
        client: { publish: () => {}, subscribe: () => {} },
      }),
      new RabbitMqServer({
        channel: {
          assertQueue: (q) => ({ queue: q }),
          consume: () => {},
          sendToQueue: () => true,
        },
        queue: "q",
      }),
      new GrpcServer({ port: 0 }),
      new KafkaServer({
        producer: {
          connect: async () => {},
          disconnect: async () => {},
          send: async () => {},
        },
        consumer: {
          connect: async () => {},
          disconnect: async () => {},
          subscribe: async () => {},
          run: async () => {},
        },
      }),
      new MqttServer({
        client: {
          publish: () => {},
          subscribe: () => {},
          on: () => {},
        },
      }),
    ];

    expect(servers).toHaveLength(8);
    expect(servers.map((s) => s.transport)).toEqual([
      Transport.TCP,
      Transport.IN_MEMORY,
      Transport.REDIS,
      Transport.NATS,
      Transport.RABBITMQ,
      Transport.GRPC,
      Transport.KAFKA,
      Transport.MQTT,
    ]);

    for (const s of servers) {
      expect(typeof s.listen).toBe("function");
      expect(typeof s.close).toBe("function");
    }
  });
});
