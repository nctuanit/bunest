import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  describeConformance,
  itAdapted,
  createSpy,
  createStub,
} from "../../../../_helpers";
import { HttpException } from "../../../../../../packages/core/src/common";
import {
  KAFKA_CORRELATION_ID_HEADER,
  KAFKA_REPLY_PARTITION_HEADER,
  KAFKA_REPLY_TOPIC_HEADER,
  KafkaContext,
  KafkaServer,
  RpcException,
  Transport,
  type KafkaClientLike,
  type KafkaConsumerLike,
  type KafkaEachMessagePayload,
  type KafkaProducerLike,
  type KafkaProducerRecord,
  type RpcResponseEnvelope,
} from "../../../../../../packages/microservices/src";

interface MockKafkaHarness {
  readonly client: KafkaClientLike;
  readonly consumer: KafkaConsumerLike;
  readonly producer: KafkaProducerLike;
  readonly subscriptions: Array<{
    topic?: string | RegExp;
    topics?: ReadonlyArray<string | RegExp>;
    fromBeginning?: boolean;
  }>;
  readonly sentRecords: KafkaProducerRecord[];
  readonly committedOffsets: Array<{
    topic: string;
    partition: number;
    offset: string;
  }>;
  readonly callOrder: string[];
  consumerGroupId?: string;
  autoCommit?: boolean;
  eachMessage?: (payload: KafkaEachMessagePayload) => Promise<void>;
  consumerConnectCalls: number;
  consumerDisconnectCalls: number;
  consumerStopCalls: number;
  producerConnectCalls: number;
  producerDisconnectCalls: number;
  runCalls: number;
}

function createKafkaHarness(): MockKafkaHarness {
  const harness: MockKafkaHarness = {
    client: null as unknown as KafkaClientLike,
    consumer: null as unknown as KafkaConsumerLike,
    producer: null as unknown as KafkaProducerLike,
    subscriptions: [],
    sentRecords: [],
    committedOffsets: [],
    callOrder: [],
    consumerGroupId: undefined,
    autoCommit: undefined,
    eachMessage: undefined,
    consumerConnectCalls: 0,
    consumerDisconnectCalls: 0,
    consumerStopCalls: 0,
    producerConnectCalls: 0,
    producerDisconnectCalls: 0,
    runCalls: 0,
  };

  const consumer: KafkaConsumerLike = {
    async connect() {
      harness.consumerConnectCalls++;
      harness.callOrder.push("consumer.connect");
    },
    async disconnect() {
      harness.consumerDisconnectCalls++;
      harness.callOrder.push("consumer.disconnect");
    },
    async stop() {
      harness.consumerStopCalls++;
      harness.callOrder.push("consumer.stop");
    },
    async subscribe(sub) {
      harness.subscriptions.push(sub);
      harness.callOrder.push("consumer.subscribe");
    },
    async run(cfg) {
      harness.runCalls++;
      harness.autoCommit = cfg.autoCommit;
      harness.eachMessage = cfg.eachMessage;
      harness.callOrder.push("consumer.run");
    },
    async commitOffsets(offsets) {
      harness.committedOffsets.push(...offsets);
    },
  };

  const producer: KafkaProducerLike = {
    async connect() {
      harness.producerConnectCalls++;
      harness.callOrder.push("producer.connect");
    },
    async disconnect() {
      harness.producerDisconnectCalls++;
      harness.callOrder.push("producer.disconnect");
    },
    async send(record) {
      harness.sentRecords.push(record);
    },
  };

  const client: KafkaClientLike = {
    consumer(cfg) {
      harness.consumerGroupId = cfg.groupId;
      return consumer;
    },
    producer() {
      return producer;
    },
  };

  Object.assign(harness, { client, consumer, producer });
  return harness;
}

function parseReplyEnvelope(record: KafkaProducerRecord): RpcResponseEnvelope {
  const raw = record.messages[0]!.value;
  return JSON.parse(String(raw)) as RpcResponseEnvelope;
}

describeConformance(
  "ServerKafka (KafkaServer)",
  {
    upstreamPath: "packages/microservices/test/server/server-kafka.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008"],
    notes:
      "Adapted to Bunest's zero-dependency client-injected KafkaServer, Promise-based handlers, KafkaContext, and RpcResponseEnvelope replies.",
  },
  () => {
    let harness: MockKafkaHarness;
    let activeServers: KafkaServer[];

    const track = (server: KafkaServer): KafkaServer => {
      activeServers.push(server);
      return server;
    };

    beforeEach(() => {
      harness = createKafkaHarness();
      activeServers = [];
    });

    afterEach(async () => {
      for (const s of activeServers) {
        await s.close().catch(() => {});
      }
    });

    describe("constructor, options & handler registration", () => {
      itAdapted(
        ["ADR-001", "ADR-008"],
        "initializes defaults (groupId, fromBeginning=false, autoCommit=true, isListening=false)",
        async () => {
          const server = track(new KafkaServer({ client: harness.client }));
          expect(server.transport).toBe(Transport.KAFKA);
          expect(server.isListening).toBe(false);

          server.addMessageHandler("orders.get", () => "ok");
          await server.listen();

          expect(harness.consumerGroupId).toBe("bunest-kafka-server");
          expect(harness.subscriptions).toEqual([
            { topic: "orders.get", fromBeginning: false },
          ]);
          expect(harness.autoCommit).toBe(true);
          expect(server.isListening).toBe(true);
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "applies custom groupId, fromBeginning, and autoCommit options",
        async () => {
          const server = track(
            new KafkaServer({
              client: harness.client,
              groupId: "billing-workers",
              fromBeginning: true,
              autoCommit: false,
            }),
          );
          server.addMessageHandler("billing.charge", () => "charged");
          await server.listen();

          expect(harness.consumerGroupId).toBe("billing-workers");
          expect(harness.subscriptions).toEqual([
            { topic: "billing.charge", fromBeginning: true },
          ]);
          expect(harness.autoCommit).toBe(false);
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "registers exact string, canonical object, and RegExp message/event handlers and rejects duplicate message patterns",
        () => {
          const server = track(new KafkaServer({ client: harness.client }));
          const msgHandler = () => "ok";
          const regexHandler = () => "rx";
          const ev1 = () => {};
          const ev2 = () => {};

          server.addMessageHandler("test.topic", msgHandler);
          server.addMessageHandler(/^dyn\.[a-z]+$/g, regexHandler);
          server.addMessageHandler({ b: 2, a: 1 }, () => "obj");
          server.addEventHandler("audit.log", ev1);
          server.addEventHandler("audit.log", ev2);
          server.addEventHandler(/^metrics\..+/g, ev1);

          expect(server.getMessageHandler("test.topic")).toBe(msgHandler);
          expect(server.getMessageHandler({ a: 1, b: 2 })).toBeDefined();
          expect(server.getEventHandlers("audit.log")).toEqual([ev1, ev2]);

          const patterns = server.getRegisteredPatterns();
          expect(patterns.messagePatterns).toEqual([
            "test.topic",
            "/^dyn\\.[a-z]+$/g",
            '{"a":1,"b":2}',
          ]);
          expect(patterns.eventPatterns).toEqual([
            "audit.log",
            "/^metrics\\..+/g",
          ]);

          // Duplicate string, object, and RegExp message patterns must throw
          expect(() =>
            server.addMessageHandler("test.topic", () => "dup"),
          ).toThrow(/Duplicate @MessagePattern\(test\.topic\)/);
          expect(() =>
            server.addMessageHandler({ a: 1, b: 2 }, () => "dup"),
          ).toThrow(/Duplicate @MessagePattern/);
          expect(() =>
            server.addMessageHandler(/^dyn\.[a-z]+$/g, () => "dup"),
          ).toThrow(/Duplicate @MessagePattern/);
        },
      );
    });

    describe("listen", () => {
      itAdapted(
        ["ADR-001", "ADR-008"],
        "throws an explicit error when neither options.consumer nor options.client is provided",
        async () => {
          const server = track(new KafkaServer({}));
          await expect(server.listen()).rejects.toThrow(
            "KafkaServer requires either `options.consumer` or `options.client`.",
          );
          expect(server.isListening).toBe(false);
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "is idempotent when called multiple times while listening",
        async () => {
          const server = track(new KafkaServer({ client: harness.client }));
          server.addMessageHandler("orders.create", () => "ok");

          await server.listen();
          await server.listen();

          expect(harness.consumerConnectCalls).toBe(1);
          expect(harness.producerConnectCalls).toBe(1);
          expect(harness.subscriptions).toHaveLength(1);
          expect(harness.runCalls).toBe(1);
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "connects consumer & producer, subscribes distinct string & RegExp topics (stripping g/y flags), and starts consumer.run",
        async () => {
          const server = track(new KafkaServer({ client: harness.client }));
          server.addMessageHandler("shared.topic", () => "msg");
          server.addEventHandler("shared.topic", () => {});
          server.addEventHandler("events.only", () => {});
          server.addMessageHandler(/^rx\.[a-z]+$/gy, () => "rx-msg");
          server.addEventHandler(/^rx\.[a-z]+$/gy, () => {});
          server.addEventHandler(/^audit\..+/i, () => {});

          await server.listen();

          expect(harness.consumerConnectCalls).toBe(1);
          expect(harness.producerConnectCalls).toBe(1);
          expect(harness.runCalls).toBe(1);

          const stringSubs = harness.subscriptions
            .filter((s) => typeof s.topic === "string")
            .map((s) => s.topic);
          const regexSubs = harness.subscriptions
            .filter((s) => s.topic instanceof RegExp)
            .map((s) => s.topic as RegExp);

          expect(stringSubs).toEqual(["shared.topic", "events.only"]);
          expect(regexSubs).toHaveLength(2);
          expect(regexSubs[0]!.source).toBe("^rx\\.[a-z]+$");
          expect(regexSubs[0]!.flags).toBe("");
          expect(regexSubs[1]!.source).toBe("^audit\\..+");
          expect(regexSubs[1]!.flags).toBe("i");
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "does not call consumer.subscribe when no handlers are registered, but still connects and calls consumer.run",
        async () => {
          const server = track(new KafkaServer({ client: harness.client }));
          await server.listen();

          expect(harness.consumerConnectCalls).toBe(1);
          expect(harness.producerConnectCalls).toBe(1);
          expect(harness.subscriptions).toHaveLength(0);
          expect(harness.runCalls).toBe(1);
          expect(server.isListening).toBe(true);
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "supports directly injected consumer (with or without producer) without options.client",
        async () => {
          const server = track(new KafkaServer({ consumer: harness.consumer }));
          const received: unknown[] = [];
          server.addEventHandler("ev.only", (data) => {
            received.push(data);
          });

          await server.listen();
          expect(harness.consumerConnectCalls).toBe(1);
          expect(harness.producerConnectCalls).toBe(0);

          await harness.eachMessage!({
            topic: "ev.only",
            partition: 0,
            message: { value: JSON.stringify({ n: 7 }) },
          });
          expect(received).toEqual([{ n: 7 }]);
        },
      );
    });

    describe("handleMessage — request-reply", () => {
      const correlationId = "696fa0a9-1827-4e59-baef-f3628173fe4f";
      const replyTopic = "test.topic.reply";

      itAdapted(
        ["ADR-001", "ADR-008"],
        "routes request-reply messages, forwards key & replyPartition, and publishes RpcResponseEnvelope",
        async () => {
          const server = track(new KafkaServer({ client: harness.client }));
          server.addMessageHandler("test.topic", (data) => ({
            received: data,
          }));
          await server.listen();

          await harness.eachMessage!({
            topic: "test.topic",
            partition: 1,
            message: {
              key: Buffer.from("order-key-1"),
              offset: "42",
              value: Buffer.from(JSON.stringify({ amount: 99 })),
              headers: {
                [KAFKA_CORRELATION_ID_HEADER]: Buffer.from(correlationId),
                [KAFKA_REPLY_TOPIC_HEADER]: Buffer.from(replyTopic),
                [KAFKA_REPLY_PARTITION_HEADER]: Buffer.from("3"),
              },
            },
          });

          expect(harness.sentRecords).toHaveLength(1);
          const sent = harness.sentRecords[0]!;
          expect(sent.topic).toBe(replyTopic);
          expect(sent.messages[0]!.key).toBe("order-key-1");
          expect(sent.messages[0]!.partition).toBe(3);
          expect(sent.messages[0]!.headers).toEqual({
            [KAFKA_CORRELATION_ID_HEADER]: correlationId,
          });
          expect(parseReplyEnvelope(sent)).toEqual({
            type: "response",
            id: correlationId,
            response: { received: { amount: 99 } },
            isDisposed: true,
          });
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "omits reply partition when kafka_replyPartition is absent, empty, or non-numeric",
        async () => {
          const server = track(new KafkaServer({ client: harness.client }));
          server.addMessageHandler("test.topic", () => "ok");
          await server.listen();

          for (const partitionHeader of [undefined, "", "not-a-number"]) {
            const headers: Record<string, string | undefined> = {
              [KAFKA_CORRELATION_ID_HEADER]: correlationId,
              [KAFKA_REPLY_TOPIC_HEADER]: replyTopic,
            };
            if (partitionHeader !== undefined) {
              headers[KAFKA_REPLY_PARTITION_HEADER] = partitionHeader;
            }
            await harness.eachMessage!({
              topic: "test.topic",
              partition: 0,
              message: { value: '"hi"', headers },
            });
          }

          expect(harness.sentRecords).toHaveLength(3);
          for (const record of harness.sentRecords) {
            expect(record.messages[0]!.partition).toBeUndefined();
          }
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "matches stateful /g RegExp patterns repeatedly and prefers exact matches over RegExp matches",
        async () => {
          const server = track(new KafkaServer({ client: harness.client }));
          server.addMessageHandler("jobs.special", () => "exact-hit");
          server.addMessageHandler(/^jobs\.[a-z]+$/g, (_d, ctx) => ({
            regexHit: (ctx as KafkaContext).getTopic(),
          }));
          await server.listen();

          const sendReq = async (topic: string, cid: string) => {
            await harness.eachMessage!({
              topic,
              partition: 0,
              message: {
                value: "{}",
                headers: {
                  [KAFKA_CORRELATION_ID_HEADER]: cid,
                  [KAFKA_REPLY_TOPIC_HEADER]: `${topic}.reply`,
                },
              },
            });
          };

          await sendReq("jobs.special", "c1");
          await sendReq("jobs.alpha", "c2");
          await sendReq("jobs.beta", "c3");

          expect(parseReplyEnvelope(harness.sentRecords[0]!).response).toBe(
            "exact-hit",
          );
          expect(parseReplyEnvelope(harness.sentRecords[1]!).response).toEqual({
            regexHit: "jobs.alpha",
          });
          expect(parseReplyEnvelope(harness.sentRecords[2]!).response).toEqual({
            regexHit: "jobs.beta",
          });
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "matches string patterns that look like JSON literals (e.g. 'true') and preserves JSON-like correlationId as text",
        async () => {
          const server = track(new KafkaServer({ client: harness.client }));
          server.addMessageHandler("true", () => "bool-topic");
          await server.listen();

          const jsonCid = '{"length":200000000}';
          await harness.eachMessage!({
            topic: "true",
            partition: 0,
            message: {
              value: "null",
              headers: {
                [KAFKA_CORRELATION_ID_HEADER]: Buffer.from(jsonCid),
                [KAFKA_REPLY_TOPIC_HEADER]: Buffer.from("true.reply"),
              },
            },
          });

          const sent = harness.sentRecords[0]!;
          expect(sent.messages[0]!.headers?.[KAFKA_CORRELATION_ID_HEADER]).toBe(
            jsonCid,
          );
          expect(parseReplyEnvelope(sent).id).toBe(jsonCid);
          expect(parseReplyEnvelope(sent).response).toBe("bool-topic");
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "populates KafkaContext getters, raw headers, array headers, heartbeat(), and commitOffset() (including BigInt & non-numeric fallback)",
        async () => {
          const server = track(new KafkaServer({ client: harness.client }));
          const heartbeatSpy = createSpy(async () => {});
          let capturedCtx: KafkaContext | undefined;

          server.addMessageHandler("ctx.topic", async (_data, ctx) => {
            capturedCtx = ctx as KafkaContext;
            await capturedCtx.heartbeat();
            await capturedCtx.commitOffset();
            return "ctx-ok";
          });
          await server.listen();

          const rawMsg = {
            key: new TextEncoder().encode("k-99"),
            offset: "9007199254740993", // exceeds Number.MAX_SAFE_INTEGER to verify BigInt increment
            value: new TextEncoder().encode('{"hello":"world"}'),
            headers: {
              [KAFKA_CORRELATION_ID_HEADER]: correlationId,
              [KAFKA_REPLY_TOPIC_HEADER]: replyTopic,
              "x-str": "plain",
              "x-buf": Buffer.from("from-buf"),
              "x-arr": [Buffer.from("first"), Buffer.from("second")],
              "x-empty-arr": [] as string[],
              "x-undef": undefined,
            },
          };

          await harness.eachMessage!({
            topic: "ctx.topic",
            partition: 4,
            message: rawMsg,
            heartbeat: heartbeatSpy,
          });

          expect(capturedCtx).toBeInstanceOf(KafkaContext);
          expect(capturedCtx!.transport).toBe(Transport.KAFKA);
          expect(capturedCtx!.pattern).toBe("ctx.topic");
          expect(capturedCtx!.getTopic()).toBe("ctx.topic");
          expect(capturedCtx!.getPartition()).toBe(4);
          expect(capturedCtx!.getOffset()).toBe("9007199254740993");
          expect(capturedCtx!.getKey()).toBe("k-99");
          expect(capturedCtx!.getMessage()).toBe(rawMsg);
          expect(capturedCtx!.rawHeaders).toBe(rawMsg.headers);
          expect(capturedCtx!.getHeaders()).toEqual({
            [KAFKA_CORRELATION_ID_HEADER]: correlationId,
            [KAFKA_REPLY_TOPIC_HEADER]: replyTopic,
            "x-str": "plain",
            "x-buf": "from-buf",
            "x-arr": "first",
          });
          expect(capturedCtx!.metadata).toEqual({
            topic: "ctx.topic",
            partition: 4,
            offset: "9007199254740993",
            key: "k-99",
            headers: capturedCtx!.getHeaders(),
          });
          expect(heartbeatSpy.calledOnce).toBe(true);
          expect(harness.committedOffsets).toEqual([
            { topic: "ctx.topic", partition: 4, offset: "9007199254740994" },
          ]);

          // Non-numeric offset falls back to raw offset, and missing heartbeat is a safe no-op
          await harness.eachMessage!({
            topic: "ctx.topic",
            partition: 0,
            message: {
              offset: "non-numeric",
              value: "null",
              headers: {
                [KAFKA_CORRELATION_ID_HEADER]: correlationId,
                [KAFKA_REPLY_TOPIC_HEADER]: replyTopic,
              },
            },
          });
          expect(harness.committedOffsets[1]).toEqual({
            topic: "ctx.topic",
            partition: 0,
            offset: "non-numeric",
          });

          // Missing offset defaults to "0" -> commits "1"
          await harness.eachMessage!({
            topic: "ctx.topic",
            partition: 2,
            message: {
              value: "null",
              headers: {
                [KAFKA_CORRELATION_ID_HEADER]: correlationId,
                [KAFKA_REPLY_TOPIC_HEADER]: replyTopic,
              },
            },
          });
          expect(harness.committedOffsets[2]).toEqual({
            topic: "ctx.topic",
            partition: 2,
            offset: "1",
          });
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "decodes JSON, raw non-JSON string, Buffer, Uint8Array, and null message values",
        async () => {
          const server = track(new KafkaServer({ client: harness.client }));
          const seen: unknown[] = [];
          server.addMessageHandler("decode.topic", (data) => {
            seen.push(data);
            return data;
          });
          await server.listen();

          const values: Array<string | Buffer | Uint8Array | null> = [
            JSON.stringify({ nested: [1, 2] }),
            "raw non-json string",
            Buffer.from("plain-buffer-text"),
            new TextEncoder().encode('{"uint8":true}'),
            null,
          ];

          for (let i = 0; i < values.length; i++) {
            await harness.eachMessage!({
              topic: "decode.topic",
              partition: 0,
              message: {
                value: values[i]!,
                headers: {
                  [KAFKA_CORRELATION_ID_HEADER]: `cid-${i}`,
                  [KAFKA_REPLY_TOPIC_HEADER]: "decode.topic.reply",
                },
              },
            });
          }

          expect(seen).toEqual([
            { nested: [1, 2] },
            "raw non-json string",
            "plain-buffer-text",
            { uint8: true },
            null,
          ]);
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "replies with 404 serialized RpcException when no message handler matches the topic",
        async () => {
          const server = track(new KafkaServer({ client: harness.client }));
          await server.listen();

          await harness.eachMessage!({
            topic: "unknown.topic",
            partition: 0,
            message: {
              value: '"payload"',
              headers: {
                [KAFKA_CORRELATION_ID_HEADER]: correlationId,
                [KAFKA_REPLY_TOPIC_HEADER]: "unknown.topic.reply",
              },
            },
          });

          expect(harness.sentRecords).toHaveLength(1);
          const env = parseReplyEnvelope(harness.sentRecords[0]!);
          expect(env.type).toBe("response");
          expect(env.id).toBe(correlationId);
          expect(env.isDisposed).toBe(true);
          expect(env.error?.isRpcException).toBe(true);
          expect(env.error?.status).toBe(404);
          expect(env.error?.message).toContain("unknown.topic");
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "serializes RpcException, HttpException, generic Error, and non-Error thrown values cleanly",
        async () => {
          const server = track(new KafkaServer({ client: harness.client }));
          server.addMessageHandler("err.rpc.obj", () => {
            throw new RpcException({ status: 400, message: "bad input" });
          });
          server.addMessageHandler("err.rpc.str", () => {
            throw new RpcException("simple rpc error");
          });
          server.addMessageHandler("err.http", () => {
            throw new HttpException({ reason: "forbidden" }, 403);
          });
          server.addMessageHandler("err.generic", () => {
            throw new RangeError("out of bounds");
          });
          server.addMessageHandler("err.nonError", () => {
            throw "raw string throw";
          });
          await server.listen();

          const invoke = async (topic: string) => {
            await harness.eachMessage!({
              topic,
              partition: 0,
              message: {
                value: "null",
                headers: {
                  [KAFKA_CORRELATION_ID_HEADER]: topic,
                  [KAFKA_REPLY_TOPIC_HEADER]: `${topic}.reply`,
                },
              },
            });
            return parseReplyEnvelope(
              harness.sentRecords[harness.sentRecords.length - 1]!,
            );
          };

          const r1 = await invoke("err.rpc.obj");
          expect(r1.error).toEqual({
            message: "bad input",
            name: "RpcException",
            status: 400,
            details: { status: 400, message: "bad input" },
            isRpcException: true,
          });

          const r2 = await invoke("err.rpc.str");
          expect(r2.error).toEqual({
            message: "simple rpc error",
            name: "RpcException",
            isRpcException: true,
          });

          const r3 = await invoke("err.http");
          expect(r3.error?.isRpcException).toBe(true);
          expect(r3.error?.status).toBe(403);
          expect(r3.error?.details).toEqual({ reason: "forbidden" });

          const r4 = await invoke("err.generic");
          expect(r4.error).toEqual({
            message: "out of bounds",
            name: "RangeError",
            isRpcException: false,
          });

          const r5 = await invoke("err.nonError");
          expect(r5.error).toEqual({
            message: "raw string throw",
            isRpcException: false,
          });
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "executes request handler cleanly without throwing when server has no producer configured",
        async () => {
          const server = track(new KafkaServer({ consumer: harness.consumer }));
          const handler = createSpy(() => "result");
          server.addMessageHandler("no.prod", handler);
          await server.listen();

          await expect(
            harness.eachMessage!({
              topic: "no.prod",
              partition: 0,
              message: {
                value: '"hello"',
                headers: {
                  [KAFKA_CORRELATION_ID_HEADER]: correlationId,
                  [KAFKA_REPLY_TOPIC_HEADER]: "no.prod.reply",
                },
              },
            }),
          ).resolves.toBeUndefined();
          expect(handler.calledOnce).toBe(true);
          expect(harness.sentRecords).toHaveLength(0);
        },
      );
    });

    describe("handleMessage — events & error isolation", () => {
      itAdapted(
        ["ADR-001", "ADR-008"],
        "dispatches to event handlers when correlationId or replyTopic header is absent",
        async () => {
          const server = track(new KafkaServer({ client: harness.client }));
          const seen: unknown[] = [];
          server.addEventHandler("user.events", (data) => {
            seen.push(data);
          });
          await server.listen();

          // 1. Neither header present
          await harness.eachMessage!({
            topic: "user.events",
            partition: 0,
            message: { value: JSON.stringify({ step: 1 }), headers: {} },
          });
          // 2. correlationId present, replyTopic absent
          await harness.eachMessage!({
            topic: "user.events",
            partition: 0,
            message: {
              value: JSON.stringify({ step: 2 }),
              headers: { [KAFKA_CORRELATION_ID_HEADER]: "cid-only" },
            },
          });

          expect(seen).toEqual([{ step: 1 }, { step: 2 }]);
          expect(harness.sentRecords).toHaveLength(0);
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "invokes all matching exact & RegExp event handlers and isolates exceptions thrown by any handler",
        async () => {
          const server = track(new KafkaServer({ client: harness.client }));
          const log: string[] = [];

          server.addEventHandler("audit.login", () => {
            log.push("exact-1");
            throw new Error("boom in exact-1");
          });
          server.addEventHandler("audit.login", (data, ctx) => {
            log.push(
              `exact-2:${(data as { u: string }).u}:${(ctx as KafkaContext).getTopic()}`,
            );
          });
          server.addEventHandler(/^audit\..+$/g, (_data, ctx) => {
            log.push(`regex:${(ctx as KafkaContext).pattern}`);
          });

          await server.listen();

          await expect(
            harness.eachMessage!({
              topic: "audit.login",
              partition: 0,
              message: { value: JSON.stringify({ u: "alice" }) },
            }),
          ).resolves.toBeUndefined();

          // Second dispatch verifies /g RegExp does not skip matches due to lastIndex
          await harness.eachMessage!({
            topic: "audit.login",
            partition: 0,
            message: { value: JSON.stringify({ u: "bob" }) },
          });

          expect(log).toEqual([
            "exact-1",
            "exact-2:alice:audit.login",
            "regex:/^audit\\..+$/g",
            "exact-1",
            "exact-2:bob:audit.login",
            "regex:/^audit\\..+$/g",
          ]);
        },
      );

      it("does not dispatch server reply envelopes on `<topic>.reply` to a regex event handler matching the request namespace", async () => {
        const server = track(new KafkaServer({ client: harness.client }));
        const regexEventHandler = createSpy();
        server.addEventHandler(/^test\..+$/, regexEventHandler);
        await server.listen();

        await harness.eachMessage!({
          topic: "test.topic.reply",
          partition: 0,
          message: {
            value: JSON.stringify({
              type: "response",
              id: "cid-1",
              response: "ok",
              isDisposed: true,
            }),
            headers: {
              [KAFKA_CORRELATION_ID_HEADER]: Buffer.from("cid-1"),
            },
          },
        });

        expect(regexEventHandler.notCalled).toBe(true);
      });
    });

    describe("close", () => {
      itAdapted(
        ["ADR-001", "ADR-008"],
        "sets isListening=false, stops & disconnects consumer before disconnecting producer, and supports re-listen",
        async () => {
          const server = track(new KafkaServer({ client: harness.client }));
          server.addMessageHandler("orders.get", () => "ok");
          await server.listen();
          harness.callOrder.length = 0;

          await server.close();

          expect(server.isListening).toBe(false);
          expect(harness.callOrder).toEqual([
            "consumer.stop",
            "consumer.disconnect",
            "producer.disconnect",
          ]);

          // Can listen again cleanly after close
          await server.listen();
          expect(server.isListening).toBe(true);
          expect(harness.consumerConnectCalls).toBe(2);
          expect(harness.producerConnectCalls).toBe(2);
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "closes cleanly when consumer.stop is omitted or producer is absent",
        async () => {
          const disconnectSpy = createSpy(async () => {});
          const minimalConsumer: KafkaConsumerLike = {
            connect: async () => {},
            disconnect: disconnectSpy,
            subscribe: async () => {},
            run: async () => {},
          };
          const server = track(new KafkaServer({ consumer: minimalConsumer }));
          await server.listen();

          await expect(server.close()).resolves.toBeUndefined();
          expect(disconnectSpy.calledOnce).toBe(true);
          expect(server.isListening).toBe(false);
        },
      );

      it("still disconnects producer when consumer.disconnect() rejects", async () => {
        const consumerDisconnect = createStub().rejects(
          new Error("consumer disconnect error"),
        );
        const producerDisconnect = createStub().resolves(undefined);
        const server = track(
          new KafkaServer({
            consumer: {
              ...harness.consumer,
              disconnect: consumerDisconnect,
            },
            producer: {
              ...harness.producer,
              disconnect: producerDisconnect,
            },
          }),
        );
        await server.listen();

        await expect(server.close()).rejects.toThrow(
          "consumer disconnect error",
        );
        expect(producerDisconnect.calledOnce).toBe(true);
      });
    });

    describe("setPreRequestHook & unwrap", () => {
      itAdapted(
        ["ADR-001", "ADR-008"],
        "setPreRequestHook returns this for chaining and unwrap() returns server instance",
        () => {
          const server = track(new KafkaServer({ client: harness.client }));
          const hook = createSpy();
          expect(server.setPreRequestHook(hook)).toBe(server);
          expect(server.setPreRequestHook(undefined)).toBe(server);
          expect(server.unwrap()).toBe(server);
        },
      );

      it("invokes setPreRequestHook({ pattern, data, ctx }) before executing a Kafka message handler", async () => {
        const server = track(new KafkaServer({ client: harness.client }));
        const hook = createSpy();
        server.setPreRequestHook(hook);
        server.addMessageHandler("hook.topic", (d) => ({ echoed: d }));
        await server.listen();

        await harness.eachMessage!({
          topic: "hook.topic",
          partition: 0,
          message: {
            value: JSON.stringify({ n: 1 }),
            headers: {
              [KAFKA_CORRELATION_ID_HEADER]: "cid-hook",
              [KAFKA_REPLY_TOPIC_HEADER]: "hook.topic.reply",
            },
          },
        });

        expect(hook.calledOnce).toBe(true);
        expect(hook.firstCall?.args[0]).toMatchObject({
          pattern: "hook.topic",
          data: { n: 1 },
        });
      });
    });
  },
);
