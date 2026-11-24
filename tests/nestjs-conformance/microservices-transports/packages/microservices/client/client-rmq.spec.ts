import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  createSandbox,
  createStub,
  describeConformance,
  itAdapted,
  type SinonLikeStub,
  type SpySandbox,
} from "../../../../_helpers";
import {
  ClientsModule,
  RabbitMqClientProxy,
  RabbitMqTransportAdapter,
  RabbitMqTransportServer,
  RmqRecord,
  RmqRecordBuilder,
  RpcException,
  RpcTimeoutException,
  Transport,
  createClientProxy,
  type RabbitMqChannelLike,
  type RabbitMqMessageLike,
  type RpcEventEnvelope,
  type RpcRequestEnvelope,
  type RpcResponseEnvelope,
} from "../../../../../../packages/microservices/src";

interface RegisteredConsumer {
  readonly tag: string;
  readonly queue: string;
  readonly options?: Record<string, unknown>;
  readonly handler: (msg: RabbitMqMessageLike) => Promise<void> | void;
}

interface MockRabbitMqChannelHarness {
  readonly channel: RabbitMqChannelLike;
  readonly assertQueue: SinonLikeStub<
    [queue: string, options?: Record<string, unknown>],
    Promise<{ queue: string }> | { queue: string }
  >;
  readonly consume: SinonLikeStub<
    [
      queue: string,
      onMessage: (msg: RabbitMqMessageLike) => Promise<void> | void,
      options?: Record<string, unknown>,
    ],
    Promise<{ consumerTag?: string } | void> | { consumerTag?: string } | void
  >;
  readonly sendToQueue: SinonLikeStub<
    [
      queue: string,
      content: Uint8Array | string,
      options?: {
        correlationId?: string;
        replyTo?: string;
        persistent?: boolean;
      },
    ],
    Promise<boolean | void> | boolean | void
  >;
  readonly ack: SinonLikeStub<[msg: RabbitMqMessageLike], void>;
  readonly nack: SinonLikeStub<
    [msg: RabbitMqMessageLike, allUpTo?: boolean, requeue?: boolean],
    void
  >;
  readonly cancel: SinonLikeStub<[consumerTag: string], Promise<void> | void>;
  readonly close: SinonLikeStub<[], Promise<void> | void>;
  readonly consumers: Map<string, RegisteredConsumer[]>;
  deliver(queue: string, msg: RabbitMqMessageLike): Promise<void>;
  getLastConsumer(queue: string): RegisteredConsumer | undefined;
}

function createMockChannel(options?: {
  readonly autoDeliver?: boolean;
  readonly omitCancel?: boolean;
  readonly omitConsumerTag?: boolean;
}): MockRabbitMqChannelHarness {
  const consumers = new Map<string, RegisteredConsumer[]>();
  let tagSeq = 0;

  const assertQueue = createStub<
    (
      queue: string,
      opts?: Record<string, unknown>,
    ) => Promise<{ queue: string }> | { queue: string }
  >((queue) => {
    if (!consumers.has(queue)) {
      consumers.set(queue, []);
    }
    return { queue };
  });

  const consume = createStub<
    (
      queue: string,
      onMessage: (msg: RabbitMqMessageLike) => Promise<void> | void,
      opts?: Record<string, unknown>,
    ) =>
      Promise<{ consumerTag?: string } | void> | { consumerTag?: string } | void
  >((queue, onMessage, opts) => {
    const tag = `amq.ctag-${++tagSeq}`;
    const list = consumers.get(queue) ?? [];
    list.push({ tag, queue, options: opts, handler: onMessage });
    consumers.set(queue, list);
    return options?.omitConsumerTag ? undefined : { consumerTag: tag };
  });

  const deliver = async (
    queue: string,
    msg: RabbitMqMessageLike,
  ): Promise<void> => {
    const list = consumers.get(queue) ?? [];
    for (const consumer of [...list]) {
      await consumer.handler(msg);
    }
  };

  const sendToQueue = createStub<
    (
      queue: string,
      content: Uint8Array | string,
      opts?: {
        correlationId?: string;
        replyTo?: string;
        persistent?: boolean;
      },
    ) => Promise<boolean | void> | boolean | void
  >(async (queue, content, opts) => {
    if (options?.autoDeliver) {
      await deliver(queue, {
        content,
        properties: {
          correlationId: opts?.correlationId,
          replyTo: opts?.replyTo,
        },
      });
    }
    return true;
  });

  const ack = createStub<(msg: RabbitMqMessageLike) => void>();
  const nack =
    createStub<
      (msg: RabbitMqMessageLike, allUpTo?: boolean, requeue?: boolean) => void
    >();
  const cancel = createStub<(consumerTag: string) => Promise<void> | void>(
    (consumerTag) => {
      for (const list of consumers.values()) {
        const idx = list.findIndex((c) => c.tag === consumerTag);
        if (idx !== -1) {
          list.splice(idx, 1);
        }
      }
    },
  );
  const close = createStub<() => Promise<void> | void>();

  const channel: RabbitMqChannelLike = {
    assertQueue,
    consume,
    sendToQueue,
    ack,
    nack,
    ...(options?.omitCancel ? {} : { cancel }),
    close,
  };

  return {
    channel,
    assertQueue,
    consume,
    sendToQueue,
    ack,
    nack,
    cancel,
    close,
    consumers,
    deliver,
    getLastConsumer(queue: string) {
      const list = consumers.get(queue);
      return list && list.length > 0 ? list[list.length - 1] : undefined;
    },
  };
}

function parseEnvelope<T = Record<string, unknown>>(
  content: Uint8Array | string,
): T {
  const text =
    typeof content === "string"
      ? content
      : Buffer.from(content).toString("utf8");
  return JSON.parse(text) as T;
}

describeConformance(
  "ClientRMQ (RabbitMqClientProxy)",
  {
    upstreamPath: "packages/microservices/test/client/client-rmq.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008"],
    notes:
      "Bunest uses zero-dependency client-injected RabbitMqChannelLike and Promise-based send()/emit() instead of amqplib/amqp-connection-manager & RxJS Observables.",
  },
  () => {
    let harness: MockRabbitMqChannelHarness;
    let client: RabbitMqClientProxy;
    let activeClients: RabbitMqClientProxy[];
    let activeServers: RabbitMqTransportServer[];
    let sandbox: SpySandbox;

    const trackClient = (c: RabbitMqClientProxy): RabbitMqClientProxy => {
      activeClients.push(c);
      return c;
    };

    const trackServer = (
      s: RabbitMqTransportServer,
    ): RabbitMqTransportServer => {
      activeServers.push(s);
      return s;
    };

    beforeEach(() => {
      sandbox = createSandbox();
      activeClients = [];
      activeServers = [];
      harness = createMockChannel();
      client = trackClient(
        new RabbitMqClientProxy({
          channel: harness.channel,
          queue: "jobs.rpc",
          replyQueue: "jobs.rpc.reply",
        }),
      );
    });

    afterEach(async () => {
      for (const c of activeClients.splice(0)) {
        try {
          await c.close();
        } catch {
          // Ignore teardown errors from intentionally failing channel mocks
        }
      }
      for (const s of activeServers.splice(0)) {
        try {
          await s.close();
        } catch {
          // Ignore teardown errors
        }
      }
      sandbox.restore();
    });

    describe("constructor & options", () => {
      it("should expose Transport.RABBITMQ and adapter/factory parity", () => {
        expect(client.transport).toBe(Transport.RABBITMQ);
        expect(RabbitMqTransportAdapter.Client).toBe(RabbitMqClientProxy);

        const created = createClientProxy({
          transport: Transport.RABBITMQ,
          options: { channel: harness.channel, queue: "factory.q" },
        });
        expect(created).toBeInstanceOf(RabbitMqClientProxy);
        trackClient(created as RabbitMqClientProxy);

        const dynMod = ClientsModule.register([
          {
            name: "RMQ_CLIENT",
            transport: Transport.RABBITMQ,
            options: { channel: harness.channel, queue: "module.q" },
          },
        ]);
        expect(dynMod.exports).toContain("RMQ_CLIENT");
        expect(dynMod.providers?.length).toBe(1);
      });

      it("should use custom replyQueue when provided", async () => {
        await client.connect();

        expect(harness.assertQueue.callCount).toBe(2);
        expect(harness.assertQueue.firstCall?.args).toEqual(["jobs.rpc"]);
        expect(harness.assertQueue.secondCall?.args).toEqual([
          "jobs.rpc.reply",
          { exclusive: true },
        ]);
        expect(harness.consume.firstCall?.args[0]).toBe("jobs.rpc.reply");
      });

      it("should auto-generate distinct `${queue}.reply.<id>` reply queues when replyQueue is omitted", async () => {
        const auto1 = trackClient(
          new RabbitMqClientProxy({
            channel: harness.channel,
            queue: "orders.rpc",
          }),
        );
        const auto2 = trackClient(
          new RabbitMqClientProxy({
            channel: harness.channel,
            queue: "orders.rpc",
          }),
        );

        await auto1.connect();
        await auto2.connect();

        const replyQ1 = harness.consume.firstCall?.args[0];
        const replyQ2 = harness.consume.secondCall?.args[0];
        expect(replyQ1).toMatch(/^orders\.rpc\.reply\.[0-9a-f-]{8}$/);
        expect(replyQ2).toMatch(/^orders\.rpc\.reply\.[0-9a-f-]{8}$/);
        expect(replyQ1).not.toBe(replyQ2);
      });

      it("should honor custom defaultTimeoutMs and reject with RpcTimeoutException", async () => {
        const fastTimeoutClient = trackClient(
          new RabbitMqClientProxy({
            channel: harness.channel,
            queue: "slow.rpc",
            replyQueue: "slow.rpc.reply",
            defaultTimeoutMs: 25,
          }),
        );

        const err = await fastTimeoutClient
          .send("slow.op", { value: 1 })
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(RpcTimeoutException);
        expect((err as RpcTimeoutException).pattern).toBe("slow.op");
        expect((err as RpcTimeoutException).timeoutMs).toBe(25);
      });
    });

    describe("connect", () => {
      it("should assert request queue, assert exclusive reply queue, and consume reply queue with noAck: true", async () => {
        await client.connect();

        expect(harness.assertQueue.callCount).toBe(2);
        expect(harness.assertQueue.getCall(0)?.args).toEqual(["jobs.rpc"]);
        expect(harness.assertQueue.getCall(1)?.args).toEqual([
          "jobs.rpc.reply",
          { exclusive: true },
        ]);
        expect(harness.consume.calledOnce).toBe(true);
        expect(harness.consume.firstCall?.args[0]).toBe("jobs.rpc.reply");
        expect(typeof harness.consume.firstCall?.args[1]).toBe("function");
        expect(harness.consume.firstCall?.args[2]).toEqual({ noAck: true });
      });

      it("should be idempotent when already connected", async () => {
        await client.connect();
        await client.connect();
        await client.connect();

        expect(harness.assertQueue.callCount).toBe(2);
        expect(harness.consume.callCount).toBe(1);
      });

      it("should handle async assertQueue and consume Promises", async () => {
        harness.assertQueue.callsFake(async (queue) => {
          await Promise.resolve();
          return { queue };
        });
        harness.consume.callsFake(async (queue, handler, opts) => {
          await Promise.resolve();
          const list = harness.consumers.get(queue) ?? [];
          list.push({ tag: "async-tag-1", queue, options: opts, handler });
          harness.consumers.set(queue, list);
          return { consumerTag: "async-tag-1" };
        });

        await client.connect();
        expect(harness.assertQueue.callCount).toBe(2);
        expect(harness.consume.callCount).toBe(1);

        await client.close();
        expect(harness.cancel.calledOnceWith("async-tag-1")).toBe(true);
      });

      it("should tolerate consume() returning void / undefined without consumerTag", async () => {
        const noTagHarness = createMockChannel({ omitConsumerTag: true });
        const noTagClient = trackClient(
          new RabbitMqClientProxy({
            channel: noTagHarness.channel,
            queue: "notag.rpc",
            replyQueue: "notag.rpc.reply",
          }),
        );

        await noTagClient.connect();
        expect(noTagHarness.consume.calledOnce).toBe(true);

        await noTagClient.close();
        expect(noTagHarness.cancel.notCalled).toBe(true);
      });

      it("should retry setup on next connect() instead of caching a failed assertQueue attempt", async () => {
        const brokerErr = new Error("broker unavailable");
        harness.assertQueue.onFirstCall().rejects(brokerErr);
        harness.assertQueue.callThrough();

        await expect(client.connect()).rejects.toThrow("broker unavailable");

        await client.connect();
        expect(harness.assertQueue.callCount).toBe(3);
        expect(harness.consume.calledOnce).toBe(true);
      });

      it("should retry setup on next connect() instead of caching a failed consume attempt", async () => {
        const setupErr = new Error("PRECONDITION_FAILED");
        harness.consume.onFirstCall().rejects(setupErr);
        harness.consume.callThrough();

        await expect(client.connect()).rejects.toThrow("PRECONDITION_FAILED");

        await client.connect();
        expect(harness.consume.callCount).toBe(2);
      });

      it("should wait for in-flight setup on concurrent connect() / send() calls (single-flight)", async () => {
        let releaseAssert!: () => void;
        harness.assertQueue.onFirstCall().callsFake(
          (queue) =>
            new Promise<{ queue: string }>((resolve) => {
              releaseAssert = () => resolve({ queue });
            }),
        );

        const firstConnect = client.connect();
        let secondResolvedEarly = false;
        const secondConnect = client.connect().then(() => {
          secondResolvedEarly = true;
        });

        await Promise.resolve();
        await Promise.resolve();
        expect(secondResolvedEarly).toBe(false);
        expect(harness.consume.notCalled).toBe(true);

        releaseAssert();
        await Promise.all([firstConnect, secondConnect]);
        expect(harness.consume.calledOnce).toBe(true);
      });

      it("should stop setup and avoid leaving an active consumer when close() runs while connecting", async () => {
        let releaseAssert!: () => void;
        harness.assertQueue.onFirstCall().callsFake(
          (queue) =>
            new Promise<{ queue: string }>((resolve) => {
              releaseAssert = () => resolve({ queue });
            }),
        );

        const connecting = client.connect();
        await client.close();
        releaseAssert();
        await connecting.catch(() => {});

        expect(harness.consumers.get("jobs.rpc.reply") ?? []).toHaveLength(0);
      });

      it("should emit 'connected' status on connect() and notify onStatus listeners", async () => {
        const statuses: string[] = [];
        const off = client.onStatus((s) => statuses.push(s));

        expect(client.status).toBe("disconnected");
        await client.connect();

        expect(client.status).toBe("connected");
        expect(statuses).toEqual(["connected"]);
        off();
      });
    });

    describe("send (request-reply & reply consumer)", () => {
      itAdapted(
        ["ADR-001", "ADR-008"],
        "should lazily initialize reply consumer on first send() and send JSON RpcRequestEnvelope with correlationId and replyTo",
        async () => {
          harness.sendToQueue.callsFake(async (queue, content, opts) => {
            expect(queue).toBe("jobs.rpc");
            const req = parseEnvelope<RpcRequestEnvelope>(content);
            expect(req.type).toBe("request");
            expect(req.pattern).toBe("math.add");
            expect(req.data).toEqual({ a: 2, b: 3 });
            expect(opts?.correlationId).toBe(req.id);
            expect(opts?.replyTo).toBe("jobs.rpc.reply");

            const reply: RpcResponseEnvelope = {
              type: "response",
              id: req.id,
              response: 5,
              isDisposed: true,
            };
            await harness.deliver("jobs.rpc.reply", {
              content: JSON.stringify(reply),
              properties: { correlationId: opts?.correlationId },
            });
            return true;
          });

          const res1 = await client.send<number>("math.add", { a: 2, b: 3 });
          const res2 = await client.send<number>("math.add", { a: 2, b: 3 });

          expect(res1).toBe(5);
          expect(res2).toBe(5);
          // Reply consumer initialized lazily once across both send() calls
          expect(harness.assertQueue.callCount).toBe(2);
          expect(harness.consume.callCount).toBe(1);
        },
      );

      it("should generate unique, non-prefix-derived correlationIds across requests", async () => {
        harness.sendToQueue.callsFake(async (_queue, content, opts) => {
          const req = parseEnvelope<RpcRequestEnvelope>(content);
          await harness.deliver("jobs.rpc.reply", {
            content: JSON.stringify({
              type: "response",
              id: req.id,
              response: "ok",
              isDisposed: true,
            } satisfies RpcResponseEnvelope),
            properties: { correlationId: opts?.correlationId },
          });
          return true;
        });

        await client.send("p", 1);
        await client.send("p", 2);
        await client.send("p", 3);

        const ids = harness.sendToQueue.args.map(
          ([, , opts]) => opts?.correlationId as string,
        );
        expect(new Set(ids).size).toBe(3);
        expect(ids[1]!.startsWith(ids[0]!.slice(1))).toBe(false);
        expect(ids[2]!.startsWith(ids[1]!.slice(1))).toBe(false);
      });

      it("should correlate reply via fallback envelope.id when properties.correlationId is absent", async () => {
        harness.sendToQueue.callsFake(async (_queue, content) => {
          const req = parseEnvelope<RpcRequestEnvelope>(content);
          await harness.deliver("jobs.rpc.reply", {
            content: JSON.stringify({
              type: "response",
              id: req.id,
              response: { fallback: true },
              isDisposed: true,
            } satisfies RpcResponseEnvelope),
          });
          return true;
        });

        const result = await client.send("fallback.id", "payload");
        expect(result).toEqual({ fallback: true });
      });

      it("should decode both Uint8Array/Buffer and string reply content including UTF-8", async () => {
        let call = 0;
        harness.sendToQueue.callsFake(async (_queue, content, opts) => {
          const req = parseEnvelope<RpcRequestEnvelope>(content);
          const payload = JSON.stringify({
            type: "response",
            id: req.id,
            response: call === 0 ? "héllo-bytes" : "héllo-string",
            isDisposed: true,
          } satisfies RpcResponseEnvelope);
          const wireContent =
            call++ === 0 ? new TextEncoder().encode(payload) : payload;
          await harness.deliver("jobs.rpc.reply", {
            content: wireContent,
            properties: { correlationId: opts?.correlationId },
          });
          return true;
        });

        expect(await client.send("utf8", 1)).toBe("héllo-bytes");
        expect(await client.send("utf8", 2)).toBe("héllo-string");
      });

      it("should resolve falsy, null, undefined, and nested responses accurately", async () => {
        const values: unknown[] = [
          0,
          false,
          "",
          null,
          undefined,
          [1, { a: 2 }],
        ];
        let idx = 0;
        harness.sendToQueue.callsFake(async (_queue, content, opts) => {
          const req = parseEnvelope<RpcRequestEnvelope>(content);
          await harness.deliver("jobs.rpc.reply", {
            content: JSON.stringify({
              type: "response",
              id: req.id,
              response: values[idx++],
              isDisposed: true,
            } satisfies RpcResponseEnvelope),
            properties: { correlationId: opts?.correlationId },
          });
          return true;
        });

        for (const expected of values) {
          expect(await client.send("falsy", expected)).toEqual(expected);
        }
      });

      it("should normalize structured object patterns canonically and support RegExp patterns", async () => {
        const capturedPatterns: string[] = [];
        harness.sendToQueue.callsFake(async (_queue, content, opts) => {
          const req = parseEnvelope<RpcRequestEnvelope>(content);
          capturedPatterns.push(req.pattern);
          await harness.deliver("jobs.rpc.reply", {
            content: JSON.stringify({
              type: "response",
              id: req.id,
              response: req.pattern,
              isDisposed: true,
            } satisfies RpcResponseEnvelope),
            properties: { correlationId: opts?.correlationId },
          });
          return true;
        });

        const resA = await client.send(
          { role: "user", cmd: "create", meta: { z: 2, a: 1 } },
          "data",
        );
        const resB = await client.send(
          { meta: { a: 1, z: 2 }, cmd: "create", role: "user" },
          "data",
        );
        const resRegex = await client.send(/^orders\.\d+$/i, "data");

        expect(resA).toBe(
          '{"cmd":"create","meta":{"a":1,"z":2},"role":"user"}',
        );
        expect(resB).toBe(resA);
        expect(resRegex).toBe("/^orders\\.\\d+$/i");
        expect(capturedPatterns).toEqual([resA, resA, "/^orders\\.\\d+$/i"]);
      });

      it("should send patterns longer than 255 bytes in the JSON queue body", async () => {
        const longPattern = "a".repeat(300);
        harness.sendToQueue.callsFake(async (_queue, content, opts) => {
          const req = parseEnvelope<RpcRequestEnvelope>(content);
          await harness.deliver("jobs.rpc.reply", {
            content: JSON.stringify({
              type: "response",
              id: req.id,
              response: req.pattern.length,
              isDisposed: true,
            } satisfies RpcResponseEnvelope),
            properties: { correlationId: opts?.correlationId },
          });
          return true;
        });

        expect(await client.send<number>(longPattern, "data")).toBe(300);
      });

      it("should ignore malformed JSON, non-response envelopes, unknown correlationIds, and 'error' correlationId", async () => {
        await client.connect();

        let capturedId = "";
        harness.sendToQueue.callsFake((_queue, content) => {
          capturedId = parseEnvelope<RpcRequestEnvelope>(content).id;
          return true;
        });

        const pending = client.send<string>("resilient", { ok: true });
        await Promise.resolve();
        await Promise.resolve();

        // Malformed JSON (string & bytes)
        await harness.deliver("jobs.rpc.reply", { content: "{broken-json" });
        await harness.deliver("jobs.rpc.reply", {
          content: new TextEncoder().encode("not-json"),
        });
        // Valid JSON without envelope `type`
        await harness.deliver("jobs.rpc.reply", {
          content: JSON.stringify({ id: capturedId, response: "wrong" }),
          properties: { correlationId: capturedId },
        });
        // Non-response envelope types ("request" / "event")
        await harness.deliver("jobs.rpc.reply", {
          content: JSON.stringify({
            type: "request",
            id: capturedId,
            pattern: "resilient",
            data: "ignored",
          }),
          properties: { correlationId: capturedId },
        });
        await harness.deliver("jobs.rpc.reply", {
          content: JSON.stringify({
            type: "event",
            pattern: "resilient",
            data: "ignored",
          }),
        });
        // Unknown correlationId
        await harness.deliver("jobs.rpc.reply", {
          content: JSON.stringify({
            type: "response",
            id: "unknown-id",
            response: "stray",
          }),
          properties: { correlationId: "unknown-id" },
        });
        // correlationId === "error" (upstream EventEmitter hazard regression)
        await harness.deliver("jobs.rpc.reply", {
          content: JSON.stringify({
            type: "response",
            id: "error",
            response: "hazard",
          }),
          properties: { correlationId: "error" },
        });

        // Finally deliver the real matching response
        await harness.deliver("jobs.rpc.reply", {
          content: JSON.stringify({
            type: "response",
            id: capturedId,
            response: "final-ok",
            isDisposed: true,
          } satisfies RpcResponseEnvelope),
          properties: { correlationId: capturedId },
        });

        expect(await pending).toBe("final-ok");
      });

      it("should not throw when the broker cancels the reply consumer with a null message", async () => {
        await client.connect();
        const consumer = harness.getLastConsumer("jobs.rpc.reply");
        expect(consumer).toBeDefined();

        expect(() =>
          consumer!.handler(null as unknown as RabbitMqMessageLike),
        ).not.toThrow();
      });

      it("should multiplex concurrent send() calls with out-of-order responses", async () => {
        await client.connect();

        const queued: Array<{ id: string; tag: string }> = [];
        harness.sendToQueue.callsFake((_queue, content) => {
          const req = parseEnvelope<RpcRequestEnvelope>(content);
          queued.push({ id: req.id, tag: req.data as string });
          return true;
        });

        const p1 = client.send<string>("echo", "first");
        const p2 = client.send<string>("echo", "second");
        const p3 = client.send<string>("echo", "third");

        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(queued).toHaveLength(3);

        // Reply in reverse order: 3 -> 1 -> 2
        for (const item of [queued[2]!, queued[0]!, queued[1]!]) {
          await harness.deliver("jobs.rpc.reply", {
            content: JSON.stringify({
              type: "response",
              id: item.id,
              response: `reply:${item.tag}`,
              isDisposed: true,
            } satisfies RpcResponseEnvelope),
            properties: { correlationId: item.id },
          });
        }

        expect(await Promise.all([p1, p2, p3])).toEqual([
          "reply:first",
          "reply:second",
          "reply:third",
        ]);
      });

      it("should propagate RpcException (string & structured object) and generic Error with name", async () => {
        let step = 0;
        harness.sendToQueue.callsFake(async (_queue, content, opts) => {
          const req = parseEnvelope<RpcRequestEnvelope>(content);
          const errors: NonNullable<RpcResponseEnvelope["error"]>[] = [
            new RpcException("invalid-token").toSerialized(),
            new RpcException({
              status: 422,
              code: "VALIDATION",
              message: "Bad payload",
            }).toSerialized(),
            {
              message: "boom-range",
              name: "RangeError",
              isRpcException: false,
            },
          ];
          await harness.deliver("jobs.rpc.reply", {
            content: JSON.stringify({
              type: "response",
              id: req.id,
              error: errors[step++],
              isDisposed: true,
            } satisfies RpcResponseEnvelope),
            properties: { correlationId: opts?.correlationId },
          });
          return true;
        });

        const err1 = await client.send("e1", {}).catch((e: unknown) => e);
        expect(err1).toBeInstanceOf(RpcException);
        expect((err1 as RpcException).getError()).toBe("invalid-token");
        expect((err1 as RpcException).message).toBe("invalid-token");

        const err2 = await client.send("e2", {}).catch((e: unknown) => e);
        expect(err2).toBeInstanceOf(RpcException);
        expect((err2 as RpcException).getError()).toEqual({
          status: 422,
          code: "VALIDATION",
          message: "Bad payload",
        });

        const err3 = await client.send("e3", {}).catch((e: unknown) => e);
        expect(err3).toBeInstanceOf(Error);
        expect(err3).not.toBeInstanceOf(RpcException);
        expect((err3 as Error).name).toBe("RangeError");
        expect((err3 as Error).message).toBe("boom-range");
      });

      it("should clean up pending entry and timer when sendToQueue rejects asynchronously", async () => {
        harness.sendToQueue.rejects(new Error("channel write failed"));

        await expect(client.send("write.fail", { x: 1 })).rejects.toThrow(
          "channel write failed",
        );

        const pendingMap = (
          client as unknown as { pending: Map<string, unknown> }
        ).pending;
        expect(pendingMap.size).toBe(0);
      });

      it("should not leave a pending entry behind when sendToQueue throws synchronously", async () => {
        harness.sendToQueue.throws(new Error("Publish error"));

        await expect(client.send("sync.fail", { x: 1 })).rejects.toThrow(
          "Publish error",
        );

        const pendingMap = (
          client as unknown as { pending: Map<string, unknown> }
        ).pending;
        expect(pendingMap.size).toBe(0);
      });

      it("should reject with RpcTimeoutException and ignore late replies after timeout", async () => {
        await client.connect();

        let capturedId = "";
        harness.sendToQueue.callsFake((_queue, content) => {
          capturedId = parseEnvelope<RpcRequestEnvelope>(content).id;
          return true;
        });

        const err = await client
          .send("timed.out", { id: 1 }, { timeoutMs: 25 })
          .catch((e: unknown) => e);

        expect(err).toBeInstanceOf(RpcTimeoutException);
        expect((err as RpcTimeoutException).pattern).toBe("timed.out");
        expect((err as RpcTimeoutException).timeoutMs).toBe(25);

        // Allow sendOnce's inner timeout timer (scheduled 1 microtask after ClientProxy.runWithTimeout) to fire and clean up
        await new Promise((resolve) => setTimeout(resolve, 25));

        const pendingMap = (
          client as unknown as { pending: Map<string, unknown> }
        ).pending;
        expect(pendingMap.size).toBe(0);

        // Late reply arriving after timeout must be silently ignored
        await expect(
          harness.deliver("jobs.rpc.reply", {
            content: JSON.stringify({
              type: "response",
              id: capturedId,
              response: "too-late",
              isDisposed: true,
            } satisfies RpcResponseEnvelope),
            properties: { correlationId: capturedId },
          }),
        ).resolves.toBeUndefined();
      });

      it("should retry transient transport and timeout errors, but never retry application RpcException", async () => {
        // 1. Transient sendToQueue error succeeds on attempt 3
        let transientAttempts = 0;
        harness.sendToQueue.callsFake(async (_queue, content, opts) => {
          transientAttempts++;
          if (transientAttempts < 3) {
            throw new Error(`transient-${transientAttempts}`);
          }
          const req = parseEnvelope<RpcRequestEnvelope>(content);
          await harness.deliver("jobs.rpc.reply", {
            content: JSON.stringify({
              type: "response",
              id: req.id,
              response: "recovered",
              isDisposed: true,
            } satisfies RpcResponseEnvelope),
            properties: { correlationId: opts?.correlationId },
          });
          return true;
        });

        const recovered = await client.send<string>(
          "retry.transient",
          {},
          { retries: 2, retryDelayMs: 5 },
        );
        expect(recovered).toBe("recovered");
        expect(transientAttempts).toBe(3);

        // 2. Timeout retries and resolves when second attempt replies in time
        let timeoutAttempts = 0;
        harness.sendToQueue.callsFake(async (_queue, content, opts) => {
          timeoutAttempts++;
          if (timeoutAttempts === 1) {
            return true; // Never reply on first attempt -> timeout
          }
          const req = parseEnvelope<RpcRequestEnvelope>(content);
          await harness.deliver("jobs.rpc.reply", {
            content: JSON.stringify({
              type: "response",
              id: req.id,
              response: "second-attempt-ok",
              isDisposed: true,
            } satisfies RpcResponseEnvelope),
            properties: { correlationId: opts?.correlationId },
          });
          return true;
        });

        const timeoutRecovered = await client.send<string>(
          "retry.timeout",
          {},
          { timeoutMs: 25, retries: 1, retryDelayMs: 5 },
        );
        expect(timeoutRecovered).toBe("second-attempt-ok");
        expect(timeoutAttempts).toBe(2);

        // 3. Application RpcException must NOT be retried
        let rpcErrAttempts = 0;
        harness.sendToQueue.callsFake(async (_queue, content, opts) => {
          rpcErrAttempts++;
          const req = parseEnvelope<RpcRequestEnvelope>(content);
          await harness.deliver("jobs.rpc.reply", {
            content: JSON.stringify({
              type: "response",
              id: req.id,
              error: new RpcException("business rule violated").toSerialized(),
              isDisposed: true,
            } satisfies RpcResponseEnvelope),
            properties: { correlationId: opts?.correlationId },
          });
          return true;
        });

        await expect(
          client.send("no.retry.rpc", {}, { retries: 3, retryDelayMs: 5 }),
        ).rejects.toBeInstanceOf(RpcException);
        expect(rpcErrAttempts).toBe(1);
      });

      it("should unwrap RmqRecord data and forward RmqRecordOptions to sendToQueue on send()", async () => {
        const record = new RmqRecordBuilder({ hello: "world" })
          .setOptions({
            persistent: true,
            priority: 5,
            headers: { "x-trace-id": "trace-1" },
          })
          .build();

        harness.sendToQueue.callsFake(async (_queue, content, opts) => {
          const req = parseEnvelope<RpcRequestEnvelope>(content);
          await harness.deliver("jobs.rpc.reply", {
            content: JSON.stringify({
              type: "response",
              id: req.id,
              response: "ok",
              isDisposed: true,
            } satisfies RpcResponseEnvelope),
            properties: { correlationId: opts?.correlationId },
          });
          return true;
        });

        await client.send("record.rpc", record);

        const [, rawContent, sendOpts] = harness.sendToQueue.firstCall!.args;
        const envelope = parseEnvelope<RpcRequestEnvelope>(rawContent);
        expect(envelope.data).toEqual({ hello: "world" });
        expect(sendOpts).toMatchObject({
          persistent: true,
          priority: 5,
          headers: { "x-trace-id": "trace-1" },
          replyTo: "jobs.rpc.reply",
        });
      });
    });

    describe("emit (dispatchEvent)", () => {
      it("should assert request queue and send JSON RpcEventEnvelope without initializing reply consumer", async () => {
        await client.emit("order.created", { orderId: "ord_1" });

        expect(harness.assertQueue.calledOnceWith("jobs.rpc")).toBe(true);
        expect(harness.consume.notCalled).toBe(true);
        expect(harness.sendToQueue.calledOnce).toBe(true);

        const [queue, rawContent] = harness.sendToQueue.firstCall!.args;
        expect(queue).toBe("jobs.rpc");
        const envelope = parseEnvelope<RpcEventEnvelope>(rawContent);
        expect(envelope).toEqual({
          type: "event",
          pattern: "order.created",
          data: { orderId: "ord_1" },
        });
      });

      it("should normalize structured object patterns canonically on emit()", async () => {
        await client.emit({ role: "user", cmd: "created" }, { id: 7 });

        const [, rawContent] = harness.sendToQueue.firstCall!.args;
        const envelope = parseEnvelope<RpcEventEnvelope>(rawContent);
        expect(envelope).toEqual({
          type: "event",
          pattern: '{"cmd":"created","role":"user"}',
          data: { id: 7 },
        });
      });

      it("should propagate errors when assertQueue or sendToQueue fails during emit()", async () => {
        harness.sendToQueue.rejects(new Error("emit write failed"));
        await expect(client.emit("evt.fail", "data")).rejects.toThrow(
          "emit write failed",
        );

        harness.sendToQueue.resetBehavior();
        harness.assertQueue.rejects(new Error("assert queue failed"));
        await expect(client.emit("evt.fail2", "data")).rejects.toThrow(
          "assert queue failed",
        );
      });

      it("should unwrap RmqRecord data and forward RmqRecordOptions to sendToQueue on emit()", async () => {
        const record = new RmqRecord(
          { event: "paid" },
          {
            persistent: true,
            headers: { "x-source": "billing" },
          },
        );

        await client.emit("invoice.paid", record);

        const [, rawContent, sendOpts] = harness.sendToQueue.firstCall!.args;
        const envelope = parseEnvelope<RpcEventEnvelope>(rawContent);
        expect(envelope).toEqual({
          type: "event",
          pattern: "invoice.paid",
          data: { event: "paid" },
        });
        expect(sendOpts).toMatchObject({
          persistent: true,
          headers: { "x-source": "billing" },
        });
      });
    });

    describe("close & onModuleDestroy", () => {
      it("should reject all pending requests, clear timers, and cancel reply consumer", async () => {
        await client.connect();

        const p1 = client
          .send("p1", 1, { timeoutMs: 10_000 })
          .catch((e: unknown) => e);
        const p2 = client
          .send("p2", 2, { timeoutMs: 10_000 })
          .catch((e: unknown) => e);
        await Promise.resolve();
        await Promise.resolve();

        await client.close();

        const [e1, e2] = await Promise.all([p1, p2]);
        expect(e1).toBeInstanceOf(Error);
        expect((e1 as Error).message).toBe("RabbitMqClientProxy closed.");
        expect(e2).toBeInstanceOf(Error);
        expect((e2 as Error).message).toBe("RabbitMqClientProxy closed.");
        expect(harness.cancel.calledOnceWith("amq.ctag-1")).toBe(true);

        const pendingMap = (
          client as unknown as { pending: Map<string, unknown> }
        ).pending;
        expect(pendingMap.size).toBe(0);
      });

      it("should be idempotent on repeated close() and not cancel consumer twice", async () => {
        await client.connect();
        await client.close();
        await client.close();

        expect(harness.cancel.callCount).toBe(1);
      });

      it("should handle channels without cancel() gracefully", async () => {
        const noCancelHarness = createMockChannel({ omitCancel: true });
        const noCancelClient = trackClient(
          new RabbitMqClientProxy({
            channel: noCancelHarness.channel,
            queue: "nocancel.q",
            replyQueue: "nocancel.reply",
          }),
        );

        await noCancelClient.connect();
        await expect(noCancelClient.close()).resolves.toBeUndefined();
      });

      it("should reset replyInitialized so re-connecting and sending after close() works cleanly", async () => {
        await client.connect();
        expect(harness.consume.callCount).toBe(1);

        await client.close();
        expect(harness.cancel.calledOnceWith("amq.ctag-1")).toBe(true);

        harness.sendToQueue.callsFake(async (_queue, content, opts) => {
          const req = parseEnvelope<RpcRequestEnvelope>(content);
          await harness.deliver("jobs.rpc.reply", {
            content: JSON.stringify({
              type: "response",
              id: req.id,
              response: "after-reconnect",
              isDisposed: true,
            } satisfies RpcResponseEnvelope),
            properties: { correlationId: opts?.correlationId },
          });
          return true;
        });

        const result = await client.send<string>("ping", "again");
        expect(result).toBe("after-reconnect");
        expect(harness.consume.callCount).toBe(2);

        await client.close();
        expect(harness.cancel.callCount).toBe(2);
        expect(harness.cancel.secondCall?.args).toEqual(["amq.ctag-2"]);
      });

      it("should fail pending requests even when channel.cancel() rejects", async () => {
        await client.connect();
        harness.cancel.rejects(new Error("Cancel failed"));

        const pending = client
          .send("inflight", 1, { timeoutMs: 10_000 })
          .catch((e: unknown) => e);
        await Promise.resolve();
        await Promise.resolve();

        await expect(client.close()).rejects.toThrow("Cancel failed");
        const pendingErr = await pending;
        expect(pendingErr).toBeInstanceOf(Error);
        expect((pendingErr as Error).message).toBe(
          "RabbitMqClientProxy closed.",
        );
      });

      it("should still reset replyInitialized and replyConsumerTag when channel.cancel() rejects", async () => {
        await client.connect();
        harness.cancel.onFirstCall().rejects(new Error("Cancel failed"));

        await expect(client.close()).rejects.toThrow("Cancel failed");

        harness.cancel.resetBehavior();
        await client.connect();
        expect(harness.consume.callCount).toBe(2);
      });

      it("should emit 'disconnected' status on close()", async () => {
        const statuses: string[] = [];
        const off = client.onStatus((s) => statuses.push(s));

        await client.connect();
        await client.close();

        expect(client.status).toBe("disconnected");
        expect(statuses).toEqual(["connected", "disconnected"]);
        off();
      });

      it("should delegate onModuleDestroy() to close()", async () => {
        await client.connect();
        const pending = client
          .send("destroy.test", 1, { timeoutMs: 10_000 })
          .catch((e: unknown) => e);
        await Promise.resolve();
        await Promise.resolve();

        await client.onModuleDestroy();

        const pendingErr = await pending;
        expect(pendingErr).toBeInstanceOf(Error);
        expect((pendingErr as Error).message).toBe(
          "RabbitMqClientProxy closed.",
        );
        expect(harness.cancel.calledOnceWith("amq.ctag-1")).toBe(true);
      });
    });

    describe("setPreRequestHook, unwrap & end-to-end round-trip", () => {
      it("should invoke setPreRequestHook before send() and emit() and allow clearing", async () => {
        const seen: Array<{
          pattern: string;
          data: unknown;
          transport: Transport;
        }> = [];

        const returned = client.setPreRequestHook((ctx) => {
          seen.push(ctx);
        });
        expect(returned).toBe(client);

        harness.sendToQueue.callsFake(async (_queue, content, opts) => {
          const env = parseEnvelope<RpcRequestEnvelope | RpcEventEnvelope>(
            content,
          );
          if (env.type === "request") {
            await harness.deliver("jobs.rpc.reply", {
              content: JSON.stringify({
                type: "response",
                id: env.id,
                response: "hooked",
                isDisposed: true,
              } satisfies RpcResponseEnvelope),
              properties: { correlationId: opts?.correlationId },
            });
          }
          return true;
        });

        expect(await client.send({ b: 2, a: 1 }, { payload: 10 })).toBe(
          "hooked",
        );
        await client.emit("audit.event", { ok: true });

        expect(seen).toEqual([
          {
            pattern: '{"a":1,"b":2}',
            data: { payload: 10 },
            transport: Transport.RABBITMQ,
          },
          {
            pattern: "audit.event",
            data: { ok: true },
            transport: Transport.RABBITMQ,
          },
        ]);

        // Clearing the hook stops invocations
        client.setPreRequestHook(undefined);
        await client.emit("audit.event", { ok: false });
        expect(seen).toHaveLength(2);
      });

      it("should abort send() and emit() without publishing when preRequestHook rejects", async () => {
        client.setPreRequestHook(() => {
          throw new Error("unauthorized");
        });

        await expect(client.send("secret.op", {})).rejects.toThrow(
          "unauthorized",
        );
        await expect(client.emit("secret.evt", {})).rejects.toThrow(
          "unauthorized",
        );
        expect(harness.sendToQueue.notCalled).toBe(true);
      });

      it("should expose unwrap() on RabbitMqClientProxy", () => {
        expect(typeof client.unwrap).toBe("function");
        expect(client.unwrap()).toBeDefined();
      });

      it("should return the underlying RabbitMqChannelLike from unwrap()", () => {
        expect(client.unwrap<RabbitMqChannelLike>()).toBe(harness.channel);
      });

      itAdapted(
        ["ADR-001", "ADR-008"],
        "should complete end-to-end RPC, events, and RpcException against RabbitMqTransportServer over shared channel",
        async () => {
          const e2eHarness = createMockChannel({ autoDeliver: true });
          const server = trackServer(
            new RabbitMqTransportServer({
              channel: e2eHarness.channel,
              queue: "e2e.jobs",
            }),
          );
          const events: unknown[] = [];

          server.addMessageHandler("invoice.total", (data) => {
            const { items } = data as { items: number[] };
            if (items.length === 0) {
              throw new RpcException({ status: 400, message: "Empty invoice" });
            }
            return { total: items.reduce((a, b) => a + b, 0) };
          });
          server.addEventHandler("invoice.audited", (data) => {
            events.push(data);
          });
          await server.listen();

          const e2eClient = trackClient(
            new RabbitMqClientProxy({
              channel: e2eHarness.channel,
              queue: "e2e.jobs",
            }),
          );

          expect(
            await e2eClient.send("invoice.total", { items: [10, 25, 5] }),
          ).toEqual({ total: 40 });

          const rpcErr = await e2eClient
            .send("invoice.total", { items: [] })
            .catch((e: unknown) => e);
          expect(rpcErr).toBeInstanceOf(RpcException);
          expect((rpcErr as RpcException).getError()).toEqual({
            status: 400,
            message: "Empty invoice",
          });

          await e2eClient.emit("invoice.audited", { id: "inv_1" });
          expect(events).toEqual([{ id: "inv_1" }]);
          expect(e2eHarness.ack.callCount).toBe(3);
        },
      );
    });
  },
);
