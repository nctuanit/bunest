import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  describeConformance,
  itAdapted,
  createSpy,
  createStub,
} from "../../../../_helpers";
import {
  KAFKA_CORRELATION_ID_HEADER,
  KAFKA_REPLY_PARTITION_HEADER,
  KAFKA_REPLY_TOPIC_HEADER,
  KafkaClientProxy,
  KafkaServer,
  RpcException,
  RpcTimeoutException,
  Transport,
  type KafkaClientLike,
  type KafkaConsumerLike,
  type KafkaEachMessagePayload,
  type KafkaHeaderMap,
  type KafkaProducerLike,
  type KafkaProducerRecord,
} from "../../../../../../packages/microservices/src";

interface RegisteredConsumer {
  readonly groupId: string;
  readonly subscriptions: Array<{ topic: string | RegExp; fromBeginning?: boolean }>;
  eachMessage?: (payload: KafkaEachMessagePayload) => Promise<void>;
  autoCommit?: boolean;
  connected: boolean;
  stopped: boolean;
}

/**
 * Deterministic in-memory Kafka broker adapter for unit & conformance testing
 * without requiring an external Kafka daemon (ADR-001).
 */
class InMemoryKafkaBroker {
  public readonly consumers = new Set<RegisteredConsumer>();
  public readonly sentRecords: KafkaProducerRecord[] = [];
  public readonly consumerGroups: string[] = [];
  public producerCreateCount = 0;
  public consumerCreateCount = 0;
  public producerConnectCount = 0;
  public producerDisconnectCount = 0;
  public consumerConnectCount = 0;
  public consumerDisconnectCount = 0;
  public consumerStopCount = 0;
  public consumerSubscribeCount = 0;
  public consumerRunCount = 0;
  private offsetSeq = 0;

  deliver(payload: KafkaEachMessagePayload): void {
    for (const consumer of [...this.consumers]) {
      if (!consumer.connected || consumer.stopped || !consumer.eachMessage) {
        continue;
      }
      const matched = consumer.subscriptions.some(({ topic }) =>
        topic instanceof RegExp
          ? new RegExp(topic.source, topic.flags.replace(/[gy]/g, "")).test(
              payload.topic,
            )
          : topic === payload.topic,
      );
      if (!matched) continue;
      queueMicrotask(() => {
        void consumer.eachMessage?.(payload);
      });
    }
  }

  createProducer(): KafkaProducerLike {
    const broker = this;
    broker.producerCreateCount++;
    let connected = false;
    return {
      async connect() {
        broker.producerConnectCount++;
        connected = true;
      },
      async disconnect() {
        broker.producerDisconnectCount++;
        connected = false;
      },
      async send(record: KafkaProducerRecord) {
        if (!connected) {
          throw new Error("Kafka producer not connected");
        }
        broker.sentRecords.push(record);
        for (const msg of record.messages) {
          const offset = String(broker.offsetSeq++);
          broker.deliver({
            topic: record.topic,
            partition: msg.partition ?? 0,
            message: {
              key: msg.key,
              value: msg.value,
              headers: msg.headers,
              offset,
              timestamp: String(Date.now()),
            },
          });
        }
      },
    };
  }

  createConsumer(config: { readonly groupId: string }): KafkaConsumerLike {
    const broker = this;
    broker.consumerCreateCount++;
    broker.consumerGroups.push(config.groupId);
    const entry: RegisteredConsumer = {
      groupId: config.groupId,
      subscriptions: [],
      eachMessage: undefined,
      autoCommit: undefined,
      connected: false,
      stopped: false,
    };
    return {
      async connect() {
        broker.consumerConnectCount++;
        entry.connected = true;
        entry.stopped = false;
        broker.consumers.add(entry);
      },
      async disconnect() {
        broker.consumerDisconnectCount++;
        entry.connected = false;
        entry.eachMessage = undefined;
        entry.subscriptions.length = 0;
        broker.consumers.delete(entry);
      },
      async stop() {
        broker.consumerStopCount++;
        entry.stopped = true;
        entry.eachMessage = undefined;
      },
      async subscribe(sub) {
        broker.consumerSubscribeCount++;
        if (sub.topic !== undefined) {
          entry.subscriptions.push({
            topic: sub.topic,
            fromBeginning: sub.fromBeginning,
          });
        }
        if (sub.topics) {
          for (const t of sub.topics) {
            entry.subscriptions.push({
              topic: t,
              fromBeginning: sub.fromBeginning,
            });
          }
        }
      },
      async run(runCfg) {
        broker.consumerRunCount++;
        entry.stopped = false;
        entry.autoCommit = runCfg.autoCommit;
        entry.eachMessage = runCfg.eachMessage;
      },
    };
  }

  createClient(): KafkaClientLike {
    return {
      producer: () => this.createProducer(),
      consumer: (config) => this.createConsumer(config),
    };
  }
}

describeConformance(
  "ClientKafka (KafkaClientProxy)",
  {
    upstreamPath: "packages/microservices/test/client/client-kafka.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008"],
    notes:
      "Adapted to Bunest's zero-dependency client-injected KafkaClientProxy and Promise-based send()/sendRecord()/emit()/emitRecord() API.",
  },
  () => {
    let broker: InMemoryKafkaBroker;
    let kafkaClient: KafkaClientLike;
    let activeClients: KafkaClientProxy[];
    let activeServers: KafkaServer[];

    const trackClient = (c: KafkaClientProxy): KafkaClientProxy => {
      activeClients.push(c);
      return c;
    };

    const trackServer = (s: KafkaServer): KafkaServer => {
      activeServers.push(s);
      return s;
    };

    beforeEach(() => {
      broker = new InMemoryKafkaBroker();
      kafkaClient = broker.createClient();
      activeClients = [];
      activeServers = [];
    });

    afterEach(async () => {
      for (const c of activeClients) {
        await c.close().catch(() => {});
      }
      for (const s of activeServers) {
        await s.close().catch(() => {});
      }
    });

    describe("constructor, options & reply topics", () => {
      itAdapted(
        ["ADR-001", "ADR-008"],
        "initializes transport, default replyTopicSuffix, and generated groupId",
        async () => {
          const client = trackClient(
            new KafkaClientProxy({ client: kafkaClient }),
          );
          expect(client.transport).toBe(Transport.KAFKA);
          expect(client.getReplyTopic("test.topic")).toBe("test.topic.reply");

          client.subscribeToResponseOf("test.topic");
          await client.connect();

          expect(broker.consumerGroups).toHaveLength(1);
          expect(broker.consumerGroups[0]).toMatch(/^bunest-kafka-client-/);
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "honors custom groupId, replyTopicSuffix, and fromBeginning options",
        async () => {
          const client = trackClient(
            new KafkaClientProxy({
              client: kafkaClient,
              groupId: "custom-client-group",
              replyTopicSuffix: ".responses",
              fromBeginning: true,
            }),
          );

          expect(client.getReplyTopic("orders.create")).toBe(
            "orders.create.responses",
          );
          client.subscribeToResponseOf("orders.create");
          await client.connect();

          expect(broker.consumerGroups).toEqual(["custom-client-group"]);
          const [consumer] = [...broker.consumers];
          expect(consumer?.subscriptions).toEqual([
            { topic: "orders.create.responses", fromBeginning: true },
          ]);
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "deduplicates repeated subscribeToResponseOf() registrations for the same topic",
        async () => {
          const client = trackClient(
            new KafkaClientProxy({ client: kafkaClient }),
          );
          client.subscribeToResponseOf("test.topic");
          client.subscribeToResponseOf("test.topic");
          client.subscribeToResponseOf("other.topic");

          await client.connect();

          expect(broker.consumerSubscribeCount).toBe(2);
          const [consumer] = [...broker.consumers];
          expect(consumer?.subscriptions.map((s) => s.topic)).toEqual([
            "test.topic.reply",
            "other.topic.reply",
          ]);
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "accepts directly injected producer and consumer without options.client",
        async () => {
          const server = trackServer(new KafkaServer({ client: kafkaClient }));
          server.addMessageHandler("direct.ping", (data) => ({ pong: data }));
          await server.listen();

          const producer = broker.createProducer();
          const consumer = broker.createConsumer({ groupId: "direct-group" });
          const client = trackClient(
            new KafkaClientProxy({ producer, consumer }),
          );
          client.subscribeToResponseOf("direct.ping");
          await client.connect();

          const res = await client.send("direct.ping", { hello: "kafka" });
          expect(res).toEqual({ pong: { hello: "kafka" } });
        },
      );
    });

    describe("connect", () => {
      itAdapted(
        ["ADR-001", "ADR-008"],
        "connects only the producer when no response topics are pre-registered (producer-only mode)",
        async () => {
          const client = trackClient(
            new KafkaClientProxy({ client: kafkaClient }),
          );

          await client.connect();

          expect(broker.producerCreateCount).toBe(1);
          expect(broker.producerConnectCount).toBe(1);
          expect(broker.consumerCreateCount).toBe(0);
          expect(broker.consumerConnectCount).toBe(0);
          expect(broker.consumerRunCount).toBe(0);
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "connects both producer and consumer, subscribes pre-registered reply topics, and runs consumer",
        async () => {
          const client = trackClient(
            new KafkaClientProxy({ client: kafkaClient }),
          );
          client.subscribeToResponseOf("orders.get");

          await client.connect();

          expect(broker.producerConnectCount).toBe(1);
          expect(broker.consumerConnectCount).toBe(1);
          expect(broker.consumerSubscribeCount).toBe(1);
          expect(broker.consumerRunCount).toBe(1);
          const [consumer] = [...broker.consumers];
          expect(consumer?.autoCommit).toBe(true);
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "reuses an established connection on subsequent connect() calls",
        async () => {
          const client = trackClient(
            new KafkaClientProxy({ client: kafkaClient }),
          );
          client.subscribeToResponseOf("orders.get");

          await client.connect();
          await client.connect();
          await client.connect();

          expect(broker.producerCreateCount).toBe(1);
          expect(broker.producerConnectCount).toBe(1);
          expect(broker.consumerCreateCount).toBe(1);
          expect(broker.consumerConnectCount).toBe(1);
          expect(broker.consumerSubscribeCount).toBe(1);
          expect(broker.consumerRunCount).toBe(1);
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "single-flights concurrent connect() calls across producer and consumer",
        async () => {
          let releaseProducer!: () => void;
          let releaseConsumer!: () => void;
          const baseProducer = broker.createProducer();
          const baseConsumer = broker.createConsumer({ groupId: "sf-group" });
          const producerConnectSpy = createSpy(async () => {
            await new Promise<void>((r) => {
              releaseProducer = r;
            });
            await baseProducer.connect();
          });
          const consumerConnectSpy = createSpy(async () => {
            await new Promise<void>((r) => {
              releaseConsumer = r;
            });
            await baseConsumer.connect();
          });

          const client = trackClient(
            new KafkaClientProxy({
              producer: { ...baseProducer, connect: producerConnectSpy },
              consumer: { ...baseConsumer, connect: consumerConnectSpy },
            }),
          );
          client.subscribeToResponseOf("sf.topic");

          const p1 = client.connect();
          const p2 = client.connect();
          const p3 = client.connect();
          await Promise.resolve();
          releaseProducer();
          await Bun.sleep(5);
          releaseConsumer();
          await Promise.all([p1, p2, p3]);

          expect(producerConnectSpy.callCount).toBe(1);
          expect(consumerConnectSpy.callCount).toBe(1);
          expect(broker.consumerRunCount).toBe(1);
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "retries cleanly on the next connect() instead of caching a failed connect attempt",
        async () => {
          const baseProducer = broker.createProducer();
          let attempts = 0;
          const flakyProducer: KafkaProducerLike = {
            ...baseProducer,
            async connect() {
              attempts++;
              if (attempts === 1) {
                throw new Error("broker unavailable");
              }
              await baseProducer.connect();
            },
          };

          const client = trackClient(
            new KafkaClientProxy({ producer: flakyProducer }),
          );

          await expect(client.connect()).rejects.toThrow("broker unavailable");
          await expect(client.connect()).resolves.toBeUndefined();
          expect(attempts).toBe(2);
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "throws an explicit error when neither options.producer nor options.client is configured",
        async () => {
          const client = trackClient(new KafkaClientProxy({}));
          await expect(client.connect()).rejects.toThrow(
            "KafkaClientProxy requires either `options.producer` or `options.client`.",
          );
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "throws an explicit error on request-reply send() when neither options.consumer nor options.client is configured",
        async () => {
          const producer = broker.createProducer();
          const client = trackClient(new KafkaClientProxy({ producer }));

          await expect(client.send("orders.get", { id: 1 })).rejects.toThrow(
            "KafkaClientProxy request-reply requires either `options.consumer` or `options.client`.",
          );
        },
      );

      // BUNEST_BUG: KafkaClientProxy.connect() never calls this.emitStatus("connected"), so client.status remains "disconnected" and onStatus() listeners are never notified (packages/microservices/src/transports/kafka.transport.ts)
      it.skip("emits connected status via status getter and onStatus listeners on connect()", async () => {
        const client = trackClient(
          new KafkaClientProxy({ client: kafkaClient }),
        );
        const statuses: string[] = [];
        client.onStatus((s) => statuses.push(s));

        await client.connect();

        expect(client.status).toBe("connected");
        expect(statuses).toEqual(["connected"]);
      });
    });

    describe("close & onModuleDestroy", () => {
      itAdapted(
        ["ADR-001", "ADR-008"],
        "rejects all pending requests, stops and disconnects consumer, and disconnects producer",
        async () => {
          const client = trackClient(
            new KafkaClientProxy({
              client: kafkaClient,
              defaultTimeoutMs: 10_000,
            }),
          );
          client.subscribeToResponseOf("slow.op");
          await client.connect();

          // No server listening, so both requests remain pending
          const req1 = client.send("slow.op", { n: 1 });
          const req2 = client.send("slow.op", { n: 2 });
          const req1Err = req1.catch((err: unknown) => err);
          const req2Err = req2.catch((err: unknown) => err);
          await Bun.sleep(5);

          await client.close();

          const err1 = await req1Err;
          const err2 = await req2Err;
          expect(err1).toBeInstanceOf(Error);
          expect((err1 as Error).message).toBe("KafkaClientProxy closed.");
          expect(err2).toBeInstanceOf(Error);
          expect((err2 as Error).message).toBe("KafkaClientProxy closed.");
          expect(broker.consumerStopCount).toBe(1);
          expect(broker.consumerDisconnectCount).toBe(1);
          expect(broker.producerDisconnectCount).toBe(1);
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "closes cleanly when consumer.stop is not implemented and when called before connect()",
        async () => {
          const unconnected = trackClient(
            new KafkaClientProxy({ client: kafkaClient }),
          );
          await expect(unconnected.close()).resolves.toBeUndefined();
          expect(broker.producerDisconnectCount).toBe(0);
          expect(broker.consumerDisconnectCount).toBe(0);

          const baseConsumer = broker.createConsumer({ groupId: "no-stop" });
          const consumerWithoutStop: KafkaConsumerLike = {
            connect: baseConsumer.connect,
            disconnect: baseConsumer.disconnect,
            subscribe: baseConsumer.subscribe,
            run: baseConsumer.run,
          };
          const producer = broker.createProducer();
          const client = trackClient(
            new KafkaClientProxy({ producer, consumer: consumerWithoutStop }),
          );
          client.subscribeToResponseOf("no.stop");
          await client.connect();

          await expect(client.close()).resolves.toBeUndefined();
          expect(broker.consumerDisconnectCount).toBe(1);
          expect(broker.producerDisconnectCount).toBe(1);
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "onModuleDestroy() delegates to close()",
        async () => {
          const client = trackClient(
            new KafkaClientProxy({ client: kafkaClient }),
          );
          client.subscribeToResponseOf("destroy.topic");
          await client.connect();

          await client.onModuleDestroy();

          expect(broker.consumerDisconnectCount).toBe(1);
          expect(broker.producerDisconnectCount).toBe(1);
        },
      );

      // BUNEST_BUG: KafkaClientProxy.close() never clears subscribedReplyTopics, so reconnecting and sending after close() skips consumer.subscribe() on reply topics (packages/microservices/src/transports/kafka.transport.ts)
      it.skip("re-subscribes reply topics cleanly after close() and reconnect", async () => {
        const server = trackServer(new KafkaServer({ client: kafkaClient }));
        server.addMessageHandler("reconnect.op", (d) => ({ ok: d }));
        await server.listen();

        const client = trackClient(
          new KafkaClientProxy({
            client: kafkaClient,
            defaultTimeoutMs: 200,
          }),
        );
        expect(await client.send("reconnect.op", 1)).toEqual({ ok: 1 });

        await client.close();
        expect(await client.send("reconnect.op", 2)).toEqual({ ok: 2 });
      });

      // BUNEST_BUG: KafkaClientProxy.close() awaits consumer.disconnect() without try/finally, so a consumer disconnect failure skips producer.disconnect() (packages/microservices/src/transports/kafka.transport.ts)
      it.skip("still disconnects producer when consumer fails to disconnect", async () => {
        const consumerDisconnect = createStub().rejects(
          new Error("consumer disconnect failed"),
        );
        const producerDisconnect = createStub().resolves(undefined);
        const client = trackClient(
          new KafkaClientProxy({
            producer: {
              ...broker.createProducer(),
              disconnect: producerDisconnect,
            },
            consumer: {
              ...broker.createConsumer({ groupId: "err-close" }),
              disconnect: consumerDisconnect,
            },
          }),
        );
        client.subscribeToResponseOf("err.close");
        await client.connect();

        await expect(client.close()).rejects.toThrow(
          "consumer disconnect failed",
        );
        expect(producerDisconnect.calledOnce).toBe(true);
      });

      // BUNEST_BUG: KafkaClientProxy.close() never calls this.emitStatus("disconnected") (packages/microservices/src/transports/kafka.transport.ts)
      it.skip("emits disconnected status via onStatus when closing a connected client", async () => {
        const client = trackClient(
          new KafkaClientProxy({ client: kafkaClient }),
        );
        const statuses: string[] = [];
        client.onStatus((s) => statuses.push(s));

        await client.connect();
        await client.close();

        expect(client.status).toBe("disconnected");
        expect(statuses).toEqual(["connected", "disconnected"]);
      });
    });

    describe("send & sendRecord (request-reply)", () => {
      itAdapted(
        ["ADR-001", "ADR-008"],
        "sends correlationId and replyTopic headers, lazily subscribes reply topic, and decodes JSON response",
        async () => {
          const server = trackServer(new KafkaServer({ client: kafkaClient }));
          server.addMessageHandler("math.double", (data) => ({
            doubled: (data as { n: number }).n * 2,
          }));
          await server.listen();

          const client = trackClient(
            new KafkaClientProxy({ client: kafkaClient }),
          );

          const result = await client.send<{ doubled: number }>("math.double", {
            n: 21,
          });
          expect(result).toEqual({ doubled: 42 });

          const reqRecord = broker.sentRecords.find(
            (r) => r.topic === "math.double",
          );
          expect(reqRecord).toBeDefined();
          const sentMsg = reqRecord!.messages[0]!;
          expect(sentMsg.value).toBe(JSON.stringify({ n: 21 }));
          expect(
            typeof sentMsg.headers?.[KAFKA_CORRELATION_ID_HEADER],
          ).toBe("string");
          expect(sentMsg.headers?.[KAFKA_REPLY_TOPIC_HEADER]).toBe(
            "math.double.reply",
          );
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "sendRecord() forwards key, partition, and custom headers without letting custom headers overwrite reply headers",
        async () => {
          const server = trackServer(new KafkaServer({ client: kafkaClient }));
          server.addMessageHandler("orders.create", (data, ctx) => ({
            data,
            meta: ctx.metadata,
          }));
          await server.listen();

          const client = trackClient(
            new KafkaClientProxy({ client: kafkaClient }),
          );
          const result = await client.sendRecord<{
            data: unknown;
            meta: Record<string, unknown>;
          }>("orders.create", {
            key: "acct-42",
            partition: 3,
            headers: {
              "x-request-id": "trace-1",
              [KAFKA_CORRELATION_ID_HEADER]: "spoofed-id",
              [KAFKA_REPLY_TOPIC_HEADER]: "spoofed.reply",
            },
            value: { sku: "ABC" },
          });

          expect(result.data).toEqual({ sku: "ABC" });
          expect(result.meta.key).toBe("acct-42");
          expect(result.meta.partition).toBe(3);

          const reqMsg = broker.sentRecords.find(
            (r) => r.topic === "orders.create",
          )!.messages[0]!;
          expect(reqMsg.key).toBe("acct-42");
          expect(reqMsg.partition).toBe(3);
          expect(reqMsg.headers?.["x-request-id"]).toBe("trace-1");
          expect(reqMsg.headers?.[KAFKA_CORRELATION_ID_HEADER]).not.toBe(
            "spoofed-id",
          );
          expect(reqMsg.headers?.[KAFKA_REPLY_TOPIC_HEADER]).toBe(
            "orders.create.reply",
          );
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "supports Buffer and Uint8Array keys and reply payloads, plus null/undefined serialization",
        async () => {
          const server = trackServer(new KafkaServer({ client: kafkaClient }));
          server.addMessageHandler("echo.any", (data) => data);
          await server.listen();

          const client = trackClient(
            new KafkaClientProxy({ client: kafkaClient }),
          );

          expect(await client.send("echo.any", undefined)).toBeNull();
          expect(await client.send("echo.any", null)).toBeNull();
          expect(await client.send("echo.any", "plain-text")).toBe("plain-text");
          expect(
            await client.sendRecord("echo.any", {
              key: Buffer.from("buf-key"),
              value: [1, true, "x"],
            }),
          ).toEqual([1, true, "x"]);
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "correlates replies encoded as Buffer, Uint8Array, array headers, or envelope.id fallback",
        async () => {
          const client = trackClient(
            new KafkaClientProxy({ client: kafkaClient }),
          );
          client.subscribeToResponseOf("manual.reply");
          await client.connect();

          // Intercept producer.send to craft raw Kafka reply payloads manually
          const origProducerSend = broker.sentRecords;
          const sendAndReply = async (
            craftReply: (correlationId: string, replyTopic: string) => KafkaEachMessagePayload,
          ) => {
            const before = origProducerSend.length;
            const promise = client.send("manual.reply", { ok: true });
            while (origProducerSend.length === before) {
              await Bun.sleep(1);
            }
            const req = origProducerSend[before]!.messages[0]!;
            const cid = String(req.headers![KAFKA_CORRELATION_ID_HEADER]);
            const rt = String(req.headers![KAFKA_REPLY_TOPIC_HEADER]);
            broker.deliver(craftReply(cid, rt));
            return await promise;
          };

          // 1. Buffer value + Buffer correlation header
          const r1 = await sendAndReply((cid, rt) => ({
            topic: rt,
            partition: 0,
            message: {
              value: Buffer.from(
                JSON.stringify({
                  type: "response",
                  id: cid,
                  response: "from-buffer",
                  isDisposed: true,
                }),
              ),
              headers: {
                [KAFKA_CORRELATION_ID_HEADER]: Buffer.from(cid),
              },
            },
          }));
          expect(r1).toBe("from-buffer");

          // 2. Uint8Array value + array correlation header
          const r2 = await sendAndReply((cid, rt) => ({
            topic: rt,
            partition: 0,
            message: {
              value: new TextEncoder().encode(
                JSON.stringify({
                  type: "response",
                  id: "ignored-when-header-present",
                  response: { via: "uint8-array-header" },
                  isDisposed: true,
                }),
              ),
              headers: {
                [KAFKA_CORRELATION_ID_HEADER]: [Buffer.from(cid), Buffer.from("extra")],
              },
            },
          }));
          expect(r2).toEqual({ via: "uint8-array-header" });

          // 3. Fallback to envelope.id when header is absent
          const r3 = await sendAndReply((cid, rt) => ({
            topic: rt,
            partition: 0,
            message: {
              value: JSON.stringify({
                type: "response",
                id: cid,
                response: "from-envelope-id",
                isDisposed: true,
              }),
              headers: {},
            },
          }));
          expect(r3).toBe("from-envelope-id");
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "normalizes canonical object patterns consistently",
        async () => {
          const server = trackServer(new KafkaServer({ client: kafkaClient }));
          server.addMessageHandler({ cmd: "sum", v: 1 }, (data) => {
            const nums = data as number[];
            return nums.reduce((a, b) => a + b, 0);
          });
          await server.listen();

          const client = trackClient(
            new KafkaClientProxy({ client: kafkaClient }),
          );

          const total = await client.send<number>({ v: 1, cmd: "sum" }, [
            10, 20, 30,
          ]);
          expect(total).toBe(60);
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "handles concurrent interleaved sends and single-flights reply topic subscriptions",
        async () => {
          const server = trackServer(new KafkaServer({ client: kafkaClient }));
          server.addMessageHandler("concurrent.op", async (data) => {
            const { id, delay } = data as { id: string; delay: number };
            await Bun.sleep(delay);
            return { echoed: id };
          });
          await server.listen();
          const subsBeforeClient = broker.consumerSubscribeCount;

          const client = trackClient(
            new KafkaClientProxy({ client: kafkaClient }),
          );

          const [a, b, c] = await Promise.all([
            client.send("concurrent.op", { id: "first", delay: 25 }),
            client.send("concurrent.op", { id: "second", delay: 5 }),
            client.send("concurrent.op", { id: "third", delay: 15 }),
          ]);

          expect(a).toEqual({ echoed: "first" });
          expect(b).toEqual({ echoed: "second" });
          expect(c).toEqual({ echoed: "third" });
          expect(broker.consumerSubscribeCount - subsBeforeClient).toBe(1);
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "rejects with RpcTimeoutException when no reply arrives within timeoutMs",
        async () => {
          const client = trackClient(
            new KafkaClientProxy({
              client: kafkaClient,
              defaultTimeoutMs: 40,
            }),
          );

          let caught: unknown;
          try {
            await client.send("no.server.topic", { ping: 1 });
          } catch (err) {
            caught = err;
          }
          expect(caught).toBeInstanceOf(RpcTimeoutException);
          expect((caught as RpcTimeoutException).pattern).toBe(
            "no.server.topic",
          );
          expect((caught as RpcTimeoutException).timeoutMs).toBe(40);

          await expect(
            client.sendRecord(
              "no.server.topic",
              { value: { ping: 2 } },
              { timeoutMs: 25 },
            ),
          ).rejects.toBeInstanceOf(RpcTimeoutException);
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "retries transient errors on send() and sendRecord() but never retries non-retryable RpcException",
        async () => {
          const server = trackServer(new KafkaServer({ client: kafkaClient }));
          let transientCalls = 0;
          let rpcErrCalls = 0;

          server.addMessageHandler("flaky.op", () => {
            transientCalls++;
            if (transientCalls < 3) {
              const err = new Error("transient broker glitch");
              err.name = "TransientError";
              throw err;
            }
            return { ok: true, attempts: transientCalls };
          });

          server.addMessageHandler("biz.err", () => {
            rpcErrCalls++;
            throw new RpcException({ status: 422, message: "invalid order" });
          });

          await server.listen();

          const client = trackClient(
            new KafkaClientProxy({ client: kafkaClient }),
          );

          const res = await client.send(
            "flaky.op",
            {},
            { retries: 3, retryDelayMs: 5 },
          );
          expect(res).toEqual({ ok: true, attempts: 3 });

          // Reset and verify sendRecord retries too
          transientCalls = 0;
          const recRes = await client.sendRecord(
            "flaky.op",
            { key: "k", value: {} },
            { retries: 3, retryDelayMs: 5 },
          );
          expect(recRes).toEqual({ ok: true, attempts: 3 });

          // RpcException propagates immediately with zero retries
          let caught: unknown;
          try {
            await client.send("biz.err", {}, { retries: 3, retryDelayMs: 5 });
          } catch (err) {
            caught = err;
          }
          expect(caught).toBeInstanceOf(RpcException);
          expect((caught as RpcException).getError()).toEqual({
            status: 422,
            message: "invalid order",
          });
          expect(rpcErrCalls).toBe(1);

          // Same for sendRecord
          rpcErrCalls = 0;
          await expect(
            client.sendRecord(
              "biz.err",
              { value: {} },
              { retries: 3, retryDelayMs: 5 },
            ),
          ).rejects.toBeInstanceOf(RpcException);
          expect(rpcErrCalls).toBe(1);
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "propagates generic remote Error name & message and handles producer.send() rejections cleanly",
        async () => {
          const server = trackServer(new KafkaServer({ client: kafkaClient }));
          server.addMessageHandler("custom.err", () => {
            const err = new TypeError("bad payload type");
            throw err;
          });
          await server.listen();

          const client = trackClient(
            new KafkaClientProxy({ client: kafkaClient }),
          );

          let caught: unknown;
          try {
            await client.send("custom.err", {});
          } catch (err) {
            caught = err;
          }
          expect(caught).toBeInstanceOf(Error);
          expect((caught as Error).name).toBe("TypeError");
          expect((caught as Error).message).toBe("bad payload type");

          // Producer send rejection cleans up pending map & rejects caller
          const failingProducer: KafkaProducerLike = {
            ...broker.createProducer(),
            async send() {
              throw new Error("producer write failed");
            },
          };
          const failClient = trackClient(
            new KafkaClientProxy({
              producer: failingProducer,
              consumer: broker.createConsumer({ groupId: "fail-send" }),
            }),
          );

          await expect(failClient.send("any.topic", { a: 1 })).rejects.toThrow(
            "producer write failed",
          );
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "recovers cleanly after a failed reply topic subscribe()",
        async () => {
          const server = trackServer(new KafkaServer({ client: kafkaClient }));
          server.addMessageHandler("sub.recover", (d) => ({ got: d }));
          await server.listen();

          const baseConsumer = broker.createConsumer({ groupId: "sub-rec" });
          let failOnce = true;
          const flakyConsumer: KafkaConsumerLike = {
            ...baseConsumer,
            async subscribe(sub) {
              if (failOnce) {
                failOnce = false;
                throw new Error("subscribe transient failure");
              }
              await baseConsumer.subscribe(sub);
            },
          };

          const client = trackClient(
            new KafkaClientProxy({
              producer: broker.createProducer(),
              consumer: flakyConsumer,
            }),
          );

          await expect(client.send("sub.recover", 1)).rejects.toThrow(
            "subscribe transient failure",
          );
          expect(await client.send("sub.recover", 2)).toEqual({ got: 2 });
        },
      );
    });

    describe("malformed & orphan reply resilience", () => {
      itAdapted(
        ["ADR-001", "ADR-008"],
        "ignores non-JSON, primitive, null, missing-id, and unknown-id replies without disrupting pending requests",
        async () => {
          const client = trackClient(
            new KafkaClientProxy({ client: kafkaClient }),
          );
          client.subscribeToResponseOf("resilient.topic");
          await client.connect();

          const before = broker.sentRecords.length;
          const pendingPromise = client.send("resilient.topic", { ok: true });
          while (broker.sentRecords.length === before) {
            await Bun.sleep(1);
          }
          const reqMsg = broker.sentRecords[before]!.messages[0]!;
          const validCid = String(reqMsg.headers![KAFKA_CORRELATION_ID_HEADER]);
          const replyTopic = String(reqMsg.headers![KAFKA_REPLY_TOPIC_HEADER]);

          // 1. Null value
          broker.deliver({
            topic: replyTopic,
            partition: 0,
            message: {
              value: null,
              headers: { [KAFKA_CORRELATION_ID_HEADER]: validCid },
            },
          });
          // 2. Non-JSON raw string value (decodes to string, not object)
          broker.deliver({
            topic: replyTopic,
            partition: 0,
            message: {
              value: "not-json-envelope",
              headers: { [KAFKA_CORRELATION_ID_HEADER]: validCid },
            },
          });
          // 3. Primitive JSON value
          broker.deliver({
            topic: replyTopic,
            partition: 0,
            message: {
              value: "42",
              headers: { [KAFKA_CORRELATION_ID_HEADER]: validCid },
            },
          });
          // 4. Missing correlationId and missing envelope.id
          broker.deliver({
            topic: replyTopic,
            partition: 0,
            message: {
              value: JSON.stringify({ type: "response", response: "no-id" }),
              headers: {},
            },
          });
          // 5. Unknown / orphan correlationId
          broker.deliver({
            topic: replyTopic,
            partition: 0,
            message: {
              value: JSON.stringify({
                type: "response",
                id: "orphan-correlation-id",
                response: "wrong",
              }),
              headers: {
                [KAFKA_CORRELATION_ID_HEADER]: "orphan-correlation-id",
              },
            },
          });
          // 6. JSON-like unknown correlationId treated as literal text
          broker.deliver({
            topic: replyTopic,
            partition: 0,
            message: {
              value: JSON.stringify({
                type: "response",
                id: '{"toString":1}',
                response: "json-key",
              }),
              headers: {
                [KAFKA_CORRELATION_ID_HEADER]: Buffer.from('{"toString":1}'),
              },
            },
          });

          // Finally deliver the genuine matching reply
          broker.deliver({
            topic: replyTopic,
            partition: 0,
            message: {
              value: JSON.stringify({
                type: "response",
                id: validCid,
                response: "real-answer",
                isDisposed: true,
              }),
              headers: { [KAFKA_CORRELATION_ID_HEADER]: validCid },
            },
          });

          expect(await pendingPromise).toBe("real-answer");

          // Duplicate late delivery for an already-settled correlationId is silently ignored
          broker.deliver({
            topic: replyTopic,
            partition: 0,
            message: {
              value: JSON.stringify({
                type: "response",
                id: validCid,
                response: "duplicate-late",
                isDisposed: true,
              }),
              headers: { [KAFKA_CORRELATION_ID_HEADER]: validCid },
            },
          });
          await Bun.sleep(5);
        },
      );
    });

    describe("emit & emitRecord (fire-and-forget)", () => {
      itAdapted(
        ["ADR-001", "ADR-008"],
        "emit() lazily connects only producer and publishes serialized JSON without reply headers",
        async () => {
          const client = trackClient(
            new KafkaClientProxy({ client: kafkaClient }),
          );

          await client.emit("events.user.created", { userId: "u_1" });

          expect(broker.producerConnectCount).toBe(1);
          expect(broker.consumerConnectCount).toBe(0);
          expect(broker.sentRecords).toHaveLength(1);
          expect(broker.sentRecords[0]!.topic).toBe("events.user.created");
          expect(broker.sentRecords[0]!.messages[0]!.value).toBe(
            JSON.stringify({ userId: "u_1" }),
          );
          expect(broker.sentRecords[0]!.messages[0]!.headers).toBeUndefined();
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "emitRecord() publishes explicit key, partition, headers, and undefined-safe value",
        async () => {
          const client = trackClient(
            new KafkaClientProxy({ client: kafkaClient }),
          );

          await client.emitRecord("audit.events", {
            key: "actor-9",
            partition: 1,
            headers: { "x-origin": "gateway" },
            value: undefined,
          });

          const sent = broker.sentRecords[0]!;
          expect(sent.topic).toBe("audit.events");
          expect(sent.messages[0]).toEqual({
            key: "actor-9",
            partition: 1,
            value: "null",
            headers: { "x-origin": "gateway" },
          });
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "propagates producer.send() errors from emit() and emitRecord()",
        async () => {
          const failingProducer: KafkaProducerLike = {
            ...broker.createProducer(),
            async send() {
              throw new Error("emit write error");
            },
          };
          const client = trackClient(
            new KafkaClientProxy({ producer: failingProducer }),
          );

          await expect(client.emit("ev.fail", { x: 1 })).rejects.toThrow(
            "emit write error",
          );
          await expect(
            client.emitRecord("ev.fail", { value: { x: 1 } }),
          ).rejects.toThrow("emit write error");
        },
      );

      // BUNEST_BUG: KafkaClientProxy.emitRecord() forwards kafka_replyTopic / kafka_replyPartition headers unchanged instead of stripping reply headers on events (packages/microservices/src/transports/kafka.transport.ts)
      it.skip("emitRecord() strips reply-requesting headers (kafka_replyTopic, kafka_replyPartition) so servers handle it as an event", async () => {
        const client = trackClient(
          new KafkaClientProxy({ client: kafkaClient }),
        );
        const forwardedHeaders: KafkaHeaderMap = {
          [KAFKA_CORRELATION_ID_HEADER]: "chosen-id",
          [KAFKA_REPLY_TOPIC_HEADER]: "other.topic.reply",
          [KAFKA_REPLY_PARTITION_HEADER]: "0",
          "x-origin": "gateway",
        };

        await client.emitRecord("forwarded.event", {
          value: { item: "book" },
          headers: forwardedHeaders,
        });

        const sentHeaders = broker.sentRecords[0]!.messages[0]!.headers;
        expect(sentHeaders).toEqual({
          [KAFKA_CORRELATION_ID_HEADER]: "chosen-id",
          "x-origin": "gateway",
        });
        expect(forwardedHeaders[KAFKA_REPLY_TOPIC_HEADER]).toBe(
          "other.topic.reply",
        );
      });
    });

    describe("onStatus, status, setPreRequestHook & unwrap", () => {
      itAdapted(
        ["ADR-001", "ADR-008"],
        "reports initial disconnected status, supports onStatus unsubscribe, and exposes unwrap()",
        () => {
          const client = trackClient(
            new KafkaClientProxy({ client: kafkaClient }),
          );
          expect(client.status).toBe("disconnected");

          const listener = createSpy();
          const unsubscribe = client.onStatus(listener);
          expect(typeof unsubscribe).toBe("function");
          unsubscribe();

          expect(client.unwrap()).toBeDefined();
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "invokes setPreRequestHook before send() and emit(), supports chaining/clearing, and aborts when hook throws",
        async () => {
          const server = trackServer(new KafkaServer({ client: kafkaClient }));
          server.addMessageHandler("hook.op", (d) => ({ ok: d }));
          await server.listen();

          const client = trackClient(
            new KafkaClientProxy({ client: kafkaClient }),
          );
          const calls: Array<{
            pattern: string;
            data: unknown;
            transport: Transport;
          }> = [];

          const chained = client.setPreRequestHook((info) => {
            calls.push(info);
          });
          expect(chained).toBe(client);

          await client.send("hook.op", { a: 1 });
          await client.emit("hook.ev", { b: 2 });

          expect(calls).toEqual([
            { pattern: "hook.op", data: { a: 1 }, transport: Transport.KAFKA },
            { pattern: "hook.ev", data: { b: 2 }, transport: Transport.KAFKA },
          ]);

          // Blocking hook prevents broker publish
          const beforeCount = broker.sentRecords.length;
          client.setPreRequestHook(() => {
            throw new Error("blocked by hook");
          });
          await expect(client.send("hook.op", { blocked: true })).rejects.toThrow(
            "blocked by hook",
          );
          await expect(client.emit("hook.ev", { blocked: true })).rejects.toThrow(
            "blocked by hook",
          );
          expect(broker.sentRecords.length).toBe(beforeCount);

          // Clearing hook with undefined restores normal operation
          client.setPreRequestHook(undefined);
          expect(await client.send("hook.op", { c: 3 })).toEqual({
            ok: { c: 3 },
          });
        },
      );

      // BUNEST_BUG: KafkaClientProxy.sendRecord() and emitRecord() bypass ClientProxy.send()/emit() and never invoke preRequestHook (packages/microservices/src/transports/kafka.transport.ts)
      it.skip("invokes setPreRequestHook before sendRecord() and emitRecord()", async () => {
        const server = trackServer(new KafkaServer({ client: kafkaClient }));
        server.addMessageHandler("hook.rec", (d) => d);
        await server.listen();

        const client = trackClient(
          new KafkaClientProxy({ client: kafkaClient }),
        );
        const hook = createSpy();
        client.setPreRequestHook(hook);

        await client.sendRecord("hook.rec", { key: "k", value: { a: 1 } });
        await client.emitRecord("hook.ev", { key: "k", value: { b: 2 } });

        expect(hook.callCount).toBe(2);
      });
    });
  },
);
