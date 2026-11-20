import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  BadRequestException,
  HttpException,
} from "../../../../../../packages/common/src";
import {
  createSandbox,
  createSpy,
  createStub,
  describeConformance,
  itAdapted,
  type SinonLikeStub,
  type SpySandbox,
} from "../../../../_helpers";
import {
  RabbitMqClientProxy,
  RabbitMqServer,
  RabbitMqTransportAdapter,
  RabbitMqTransportServer,
  RmqRecordBuilder,
  RpcException,
  Transport,
  createTransportServer,
  type RabbitMqChannelLike,
  type RabbitMqMessageLike,
  type RpcContext,
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
  readonly consumers: Map<string, RegisteredConsumer[]>;
  deliver(queue: string, msg: RabbitMqMessageLike): Promise<void>;
  getLastConsumer(queue: string): RegisteredConsumer | undefined;
}

function createMockChannel(options?: {
  readonly autoDeliver?: boolean;
  readonly omitAck?: boolean;
  readonly omitNack?: boolean;
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
    ) => Promise<{ consumerTag?: string } | void> | { consumerTag?: string } | void
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
  const nack = createStub<
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

  const channel: RabbitMqChannelLike = {
    assertQueue,
    consume,
    sendToQueue,
    ...(options?.omitAck ? {} : { ack }),
    ...(options?.omitNack ? {} : { nack }),
    ...(options?.omitCancel ? {} : { cancel }),
  };

  return {
    channel,
    assertQueue,
    consume,
    sendToQueue,
    ack,
    nack,
    cancel,
    consumers,
    deliver,
    getLastConsumer(queue: string) {
      const list = consumers.get(queue);
      return list && list.length > 0 ? list[list.length - 1] : undefined;
    },
  };
}

function makeRequestMsg(
  pattern: string,
  data: unknown,
  options?: {
    readonly id?: string;
    readonly correlationId?: string;
    readonly replyTo?: string;
    readonly asBytes?: boolean;
  },
): RabbitMqMessageLike {
  const envelope: RpcRequestEnvelope = {
    type: "request",
    id: options?.id ?? "req_1",
    pattern,
    data,
  };
  const json = JSON.stringify(envelope);
  return {
    content: options?.asBytes ? new TextEncoder().encode(json) : json,
    properties:
      options?.correlationId !== undefined || options?.replyTo !== undefined
        ? {
            correlationId: options?.correlationId,
            replyTo: options?.replyTo,
          }
        : undefined,
  };
}

function makeEventMsg(
  pattern: string,
  data: unknown,
  options?: {
    readonly asBytes?: boolean;
    readonly replyTo?: string;
    readonly correlationId?: string;
  },
): RabbitMqMessageLike {
  const envelope: RpcEventEnvelope = {
    type: "event",
    pattern,
    data,
  };
  const json = JSON.stringify(envelope);
  return {
    content: options?.asBytes ? new TextEncoder().encode(json) : json,
    properties:
      options?.replyTo !== undefined || options?.correlationId !== undefined
        ? {
            replyTo: options?.replyTo,
            correlationId: options?.correlationId,
          }
        : undefined,
  };
}

function parseResponse(content: Uint8Array | string): RpcResponseEnvelope {
  const text =
    typeof content === "string" ? content : Buffer.from(content).toString("utf8");
  return JSON.parse(text) as RpcResponseEnvelope;
}

describeConformance(
  "ServerRMQ (RabbitMqTransportServer)",
  {
    upstreamPath: "packages/microservices/test/server/server-rmq.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008"],
    notes:
      "Bunest uses zero-dependency client-injected RabbitMqChannelLike and Promise-based handler dispatch instead of amqplib/amqp-connection-manager & RxJS Observables.",
  },
  () => {
    let harness: MockRabbitMqChannelHarness;
    let server: RabbitMqTransportServer;
    let activeServers: RabbitMqTransportServer[];
    let activeClients: RabbitMqClientProxy[];
    let sandbox: SpySandbox;

    const trackServer = (s: RabbitMqTransportServer): RabbitMqTransportServer => {
      activeServers.push(s);
      return s;
    };

    const trackClient = (c: RabbitMqClientProxy): RabbitMqClientProxy => {
      activeClients.push(c);
      return c;
    };

    beforeEach(() => {
      sandbox = createSandbox();
      activeServers = [];
      activeClients = [];
      harness = createMockChannel();
      server = trackServer(
        new RabbitMqTransportServer({
          channel: harness.channel,
          queue: "tasks.queue",
        }),
      );
    });

    afterEach(async () => {
      for (const c of activeClients.splice(0)) {
        try {
          await c.close();
        } catch {
          // Ignore teardown errors
        }
      }
      for (const s of activeServers.splice(0)) {
        try {
          await s.close();
        } catch {
          // Ignore teardown errors from intentionally failing channel mocks
        }
      }
      sandbox.restore();
    });

    describe("constructor, aliases & handler registration", () => {
      it("should expose Transport.RABBITMQ, RabbitMqServer alias, adapter, and factory", () => {
        expect(server.transport).toBe(Transport.RABBITMQ);
        expect(server.isListening).toBe(false);
        expect(RabbitMqServer).toBe(RabbitMqTransportServer);
        expect(RabbitMqTransportAdapter.Server).toBe(RabbitMqTransportServer);

        const created = createTransportServer({
          transport: Transport.RABBITMQ,
          options: { channel: harness.channel, queue: "factory.q" },
        });
        expect(created).toBeInstanceOf(RabbitMqTransportServer);
        trackServer(created as RabbitMqTransportServer);
      });

      it("should register string, object (canonically sorted), RegExp, and numeric-looking string message handlers", () => {
        const strHandler = createSpy(() => "str");
        const objHandler = createSpy(() => "obj");
        const regexHandler = createSpy(() => "rx");
        const numStrHandler = createSpy(() => "num");

        server.addMessageHandler("user.get", strHandler);
        server.addMessageHandler({ role: "user", cmd: "create" }, objHandler);
        server.addMessageHandler(/^order\.\d+$/, regexHandler);
        server.addMessageHandler("1.0", numStrHandler);

        expect(server.getMessageHandler("user.get")).toBe(strHandler);
        expect(
          server.getMessageHandler({ cmd: "create", role: "user" }),
        ).toBe(objHandler);
        expect(server.getMessageHandler(/^order\.\d+$/)).toBe(regexHandler);
        expect(server.getMessageHandler("1.0")).toBe(numStrHandler);
        expect(server.getRegisteredPatterns().messagePatterns).toEqual([
          "user.get",
          '{"cmd":"create","role":"user"}',
          "/^order\\.\\d+$/",
          "1.0",
        ]);
      });

      it("should reject duplicate message handlers for identical or canonically equivalent object patterns", () => {
        server.addMessageHandler("math.sum", () => 1);
        expect(() => server.addMessageHandler("math.sum", () => 2)).toThrow(
          /Duplicate @MessagePattern\(math\.sum\)/,
        );

        server.addMessageHandler({ b: 2, a: 1 }, () => 1);
        expect(() =>
          server.addMessageHandler({ a: 1, b: 2 }, () => 2),
        ).toThrow(/Duplicate @MessagePattern/);
      });

      it("should register multiple event handlers for the same string or object pattern", () => {
        const h1 = createSpy();
        const h2 = createSpy();
        const objEvent = createSpy();

        server.addEventHandler("user.created", h1);
        server.addEventHandler("user.created", h2);
        server.addEventHandler({ domain: "billing", event: "paid" }, objEvent);

        expect(server.getEventHandlers("user.created")).toEqual([h1, h2]);
        expect(
          server.getEventHandlers({ event: "paid", domain: "billing" }),
        ).toEqual([objEvent]);
        expect(server.getEventHandlers("missing")).toEqual([]);
        expect(server.getRegisteredPatterns().eventPatterns).toEqual([
          "user.created",
          '{"domain":"billing","event":"paid"}',
        ]);
      });
    });

    describe("listen", () => {
      it("should assertQueue and consume with default noAck: false and mark isListening = true", async () => {
        await server.listen();

        expect(server.isListening).toBe(true);
        expect(harness.assertQueue.calledOnceWith("tasks.queue")).toBe(true);
        expect(harness.consume.calledOnce).toBe(true);
        expect(harness.consume.firstCall?.args[0]).toBe("tasks.queue");
        expect(typeof harness.consume.firstCall?.args[1]).toBe("function");
        expect(harness.consume.firstCall?.args[2]).toEqual({ noAck: false });
        expect(harness.assertQueue.calledBefore(harness.consume)).toBe(true);
      });

      it("should pass noAck: true to consume() when configured", async () => {
        const noAckServer = trackServer(
          new RabbitMqTransportServer({
            channel: harness.channel,
            queue: "fast.queue",
            noAck: true,
          }),
        );

        await noAckServer.listen();

        expect(noAckServer.isListening).toBe(true);
        expect(harness.consume.firstCall?.args[2]).toEqual({ noAck: true });
      });

      it("should be idempotent when already listening", async () => {
        await server.listen();
        await server.listen();
        await server.listen();

        expect(harness.assertQueue.callCount).toBe(1);
        expect(harness.consume.callCount).toBe(1);
      });

      it("should remain not listening and allow retry when assertQueue or consume rejects", async () => {
        harness.assertQueue.onFirstCall().rejects(new Error("PRECONDITION_FAILED"));
        await expect(server.listen()).rejects.toThrow("PRECONDITION_FAILED");
        expect(server.isListening).toBe(false);
        expect(harness.consume.notCalled).toBe(true);

        harness.consume.onFirstCall().rejects(new Error("NOT_FOUND"));
        await expect(server.listen()).rejects.toThrow("NOT_FOUND");
        expect(server.isListening).toBe(false);

        await server.listen();
        expect(server.isListening).toBe(true);
        expect(harness.consume.callCount).toBe(2);
      });

      it("should support re-listening after close() and consume again", async () => {
        await server.listen();
        expect(server.isListening).toBe(true);
        expect(harness.consume.callCount).toBe(1);

        await server.close();
        expect(server.isListening).toBe(false);
        expect(harness.cancel.calledOnceWith("amq.ctag-1")).toBe(true);

        await server.listen();
        expect(server.isListening).toBe(true);
        expect(harness.assertQueue.callCount).toBe(2);
        expect(harness.consume.callCount).toBe(2);

        await server.close();
        expect(harness.cancel.callCount).toBe(2);
        expect(harness.cancel.secondCall?.args).toEqual(["amq.ctag-2"]);
      });

      // BUNEST_BUG: RabbitMqTransportServer.listen() has no single-flight or closing guard, so concurrent listen() calls register duplicate consumers and calling close() while assertQueue() is pending still proceeds to consume() and sets isListening = true (packages/microservices/src/transports/broker.transports.ts).
      it.skip("should not consume when close() runs while listen() is awaiting assertQueue()", async () => {
        let releaseAssert!: () => void;
        harness.assertQueue.onFirstCall().callsFake(
          (queue) =>
            new Promise<{ queue: string }>((resolve) => {
              releaseAssert = () => resolve({ queue });
            }),
        );

        const listening = server.listen();
        await server.close();
        releaseAssert();
        await listening;

        expect(harness.consume.notCalled).toBe(true);
        expect(server.isListening).toBe(false);
      });
    });

    describe("close", () => {
      it("should cancel stored consumerTag and set isListening = false", async () => {
        await server.listen();
        await server.close();

        expect(server.isListening).toBe(false);
        expect(harness.cancel.calledOnceWith("amq.ctag-1")).toBe(true);
      });

      it("should not call cancel a second time on repeated close()", async () => {
        await server.listen();
        await server.close();
        await server.close();

        expect(harness.cancel.callCount).toBe(1);
      });

      it("should safely close a server that never listened", async () => {
        await expect(server.close()).resolves.toBeUndefined();
        expect(server.isListening).toBe(false);
        expect(harness.cancel.notCalled).toBe(true);
      });

      it("should tolerate channels without cancel() or consume() returning no consumerTag", async () => {
        const noCancelHarness = createMockChannel({ omitCancel: true });
        const s1 = trackServer(
          new RabbitMqTransportServer({
            channel: noCancelHarness.channel,
            queue: "nocancel.q",
          }),
        );
        await s1.listen();
        await expect(s1.close()).resolves.toBeUndefined();
        expect(s1.isListening).toBe(false);

        const noTagHarness = createMockChannel({ omitConsumerTag: true });
        const s2 = trackServer(
          new RabbitMqTransportServer({
            channel: noTagHarness.channel,
            queue: "notag.q",
          }),
        );
        await s2.listen();
        await expect(s2.close()).resolves.toBeUndefined();
        expect(noTagHarness.cancel.notCalled).toBe(true);
      });

      // BUNEST_BUG: RabbitMqTransportServer.close() does not catch channel.cancel() rejections/throws and clears `this.consumerTag` only after `await cancel()`, so a closed channel error fails close() and leaks stale consumerTag (packages/microservices/src/transports/broker.transports.ts).
      it.skip("should still complete close() and clear consumerTag when channel.cancel() rejects or throws", async () => {
        await server.listen();
        harness.cancel.rejects(new Error("Channel closed"));

        await expect(server.close()).resolves.toBeUndefined();
        expect(server.isListening).toBe(false);

        harness.cancel.resetHistory();
        await expect(server.close()).resolves.toBeUndefined();
        expect(harness.cancel.notCalled).toBe(true);
      });
    });

    describe("onMessage — malformed, non-envelope & edge payloads", () => {
      it("should nack(msg, false, false) without throwing on malformed JSON when noAck is false", async () => {
        const handler = createSpy(() => "ok");
        server.addMessageHandler("test", handler);
        await server.listen();

        const malformed: RabbitMqMessageLike = {
          content: "{invalid-json",
          properties: { correlationId: "1", replyTo: "reply.q" },
        };

        await expect(
          harness.deliver("tasks.queue", malformed),
        ).resolves.toBeUndefined();

        expect(handler.notCalled).toBe(true);
        expect(harness.nack.calledOnceWith(malformed, false, false)).toBe(true);
        expect(harness.ack.notCalled).toBe(true);
        expect(harness.sendToQueue.notCalled).toBe(true);
      });

      it("should not call nack on malformed JSON when noAck is true", async () => {
        const noAckServer = trackServer(
          new RabbitMqTransportServer({
            channel: harness.channel,
            queue: "noack.q",
            noAck: true,
          }),
        );
        await noAckServer.listen();

        const malformed: RabbitMqMessageLike = { content: "not-json" };
        await expect(
          harness.deliver("noack.q", malformed),
        ).resolves.toBeUndefined();

        expect(harness.nack.notCalled).toBe(true);
        expect(harness.ack.notCalled).toBe(true);
      });

      it("should nack valid JSON that lacks an RpcEnvelope 'type' discriminator when noAck is false", async () => {
        await server.listen();

        const noTypeMsg: RabbitMqMessageLike = {
          content: JSON.stringify({ pattern: "test", data: 123 }),
        };
        const primitiveMsg: RabbitMqMessageLike = {
          content: JSON.stringify("plain-string"),
        };

        await harness.deliver("tasks.queue", noTypeMsg);
        await harness.deliver("tasks.queue", primitiveMsg);

        expect(harness.nack.callCount).toBe(2);
        expect(harness.nack.firstCall?.args).toEqual([noTypeMsg, false, false]);
        expect(harness.nack.secondCall?.args).toEqual([
          primitiveMsg,
          false,
          false,
        ]);
        expect(harness.ack.notCalled).toBe(true);
      });

      it("should tolerate missing channel.nack when handling malformed messages with noAck: false", async () => {
        const noNackHarness = createMockChannel({ omitNack: true });
        const s = trackServer(
          new RabbitMqTransportServer({
            channel: noNackHarness.channel,
            queue: "nonack.q",
          }),
        );
        await s.listen();

        await expect(
          noNackHarness.deliver("nonack.q", { content: "{{bad" }),
        ).resolves.toBeUndefined();
      });

      it("should decode both Uint8Array/Buffer and string message content including UTF-8", async () => {
        server.addMessageHandler("greet", (data) => `hi:${String(data)}`);
        await server.listen();

        await harness.deliver(
          "tasks.queue",
          makeRequestMsg("greet", "thế-giới", {
            id: "u1",
            correlationId: "c1",
            replyTo: "reply.q",
            asBytes: true,
          }),
        );
        await harness.deliver(
          "tasks.queue",
          makeRequestMsg("greet", "world", {
            id: "u2",
            correlationId: "c2",
            replyTo: "reply.q",
            asBytes: false,
          }),
        );

        expect(harness.sendToQueue.callCount).toBe(2);
        expect(parseResponse(harness.sendToQueue.firstCall!.args[1]).response).toBe(
          "hi:thế-giới",
        );
        expect(parseResponse(harness.sendToQueue.secondCall!.args[1]).response).toBe(
          "hi:world",
        );
      });

      it("should ignore response envelopes delivered to the request queue without invoking handlers", async () => {
        const handler = createSpy();
        server.addMessageHandler("", handler);
        await server.listen();

        const strayResponse: RabbitMqMessageLike = {
          content: JSON.stringify({
            type: "response",
            id: "resp_1",
            response: "stray",
            isDisposed: true,
          } satisfies RpcResponseEnvelope),
        };
        await harness.deliver("tasks.queue", strayResponse);

        expect(handler.notCalled).toBe(true);
        expect(harness.sendToQueue.notCalled).toBe(true);
        expect(harness.ack.calledOnceWith(strayResponse)).toBe(true);
      });

      // BUNEST_BUG: RabbitMqTransportServer.onMessage() directly reads `msg.content` without checking for `null` (AMQP broker consumer-cancel notification), throwing an unhandled TypeError (packages/microservices/src/transports/broker.transports.ts).
      it.skip("should handle null consumer-cancelled delivery gracefully without throwing", async () => {
        await server.listen();
        const consumer = harness.getLastConsumer("tasks.queue");
        expect(consumer).toBeDefined();

        await expect(
          Promise.resolve(
            consumer!.handler(null as unknown as RabbitMqMessageLike),
          ),
        ).resolves.toBeUndefined();
      });
    });

    describe("onMessage — request dispatch, replies & error serialization", () => {
      itAdapted(
        ["ADR-001", "ADR-008"],
        "should dispatch request to matching handler with RpcContext metadata, reply to replyTo, and ack when noAck is false",
        async () => {
          let capturedCtx: RpcContext | undefined;
          server.addMessageHandler("math.double", async (data, ctx) => {
            capturedCtx = ctx;
            await Promise.resolve();
            return (data as number) * 2;
          });
          await server.listen();

          const msg = makeRequestMsg("math.double", 21, {
            id: "env_1",
            correlationId: "corr_1",
            replyTo: "client.reply.1",
          });
          await harness.deliver("tasks.queue", msg);

          expect(capturedCtx).toEqual({
            transport: Transport.RABBITMQ,
            pattern: "math.double",
            metadata: {
              queue: "tasks.queue",
              correlationId: "corr_1",
              replyTo: "client.reply.1",
            },
          });

          expect(harness.sendToQueue.calledOnce).toBe(true);
          const [replyQueue, rawBody, sendOpts] = harness.sendToQueue.firstCall!.args;
          expect(replyQueue).toBe("client.reply.1");
          expect(sendOpts).toEqual({ correlationId: "corr_1" });
          expect(parseResponse(rawBody)).toEqual({
            type: "response",
            id: "corr_1",
            response: 42,
            isDisposed: true,
          });
          expect(harness.ack.calledOnceWith(msg)).toBe(true);
          expect(harness.nack.notCalled).toBe(true);
        },
      );

      it("should fall back to envelope.id when properties.correlationId is absent", async () => {
        server.addMessageHandler("ping", () => "pong");
        await server.listen();

        const msg = makeRequestMsg("ping", null, {
          id: "env_fallback_9",
          replyTo: "client.reply.2",
        });
        await harness.deliver("tasks.queue", msg);

        const [, rawBody, sendOpts] = harness.sendToQueue.firstCall!.args;
        expect(sendOpts).toEqual({ correlationId: "env_fallback_9" });
        expect(parseResponse(rawBody)).toEqual({
          type: "response",
          id: "env_fallback_9",
          response: "pong",
          isDisposed: true,
        });
      });

      it("should dispatch structured object pattern requests by canonical normalized key", async () => {
        const handler = createSpy((data: unknown) => ({ received: data }));
        server.addMessageHandler({ role: "user", cmd: "create" }, handler);
        await server.listen();

        const msg = makeRequestMsg(
          '{"cmd":"create","role":"user"}',
          { name: "Ada" },
          { id: "obj_1", correlationId: "obj_1", replyTo: "reply.obj" },
        );
        await harness.deliver("tasks.queue", msg);

        expect(handler.calledOnce).toBe(true);
        expect(parseResponse(harness.sendToQueue.firstCall!.args[1]).response).toEqual({
          received: { name: "Ada" },
        });
      });

      it("should skip sending reply when properties.replyTo is absent, while still invoking handler and acking", async () => {
        const handler = createSpy(() => "computed");
        server.addMessageHandler("no.reply", handler);
        await server.listen();

        const msg = makeRequestMsg("no.reply", { x: 1 }, { id: "nr_1" });
        await harness.deliver("tasks.queue", msg);

        expect(handler.calledOnce).toBe(true);
        expect(harness.sendToQueue.notCalled).toBe(true);
        expect(harness.ack.calledOnceWith(msg)).toBe(true);
      });

      it("should not call ack when noAck is true, and tolerate missing channel.ack when noAck is false", async () => {
        const noAckServer = trackServer(
          new RabbitMqTransportServer({
            channel: harness.channel,
            queue: "autoack.q",
            noAck: true,
          }),
        );
        noAckServer.addMessageHandler("ok", () => "done");
        await noAckServer.listen();

        await harness.deliver(
          "autoack.q",
          makeRequestMsg("ok", null, {
            id: "a1",
            correlationId: "a1",
            replyTo: "reply.a1",
          }),
        );
        expect(harness.sendToQueue.calledOnce).toBe(true);
        expect(harness.ack.notCalled).toBe(true);

        const noAckFnHarness = createMockChannel({ omitAck: true });
        const s2 = trackServer(
          new RabbitMqTransportServer({
            channel: noAckFnHarness.channel,
            queue: "noackfn.q",
          }),
        );
        s2.addMessageHandler("ok", () => "done");
        await s2.listen();

        await expect(
          noAckFnHarness.deliver(
            "noackfn.q",
            makeRequestMsg("ok", null, {
              id: "a2",
              correlationId: "a2",
              replyTo: "reply.a2",
            }),
          ),
        ).resolves.toBeUndefined();
        expect(noAckFnHarness.sendToQueue.calledOnce).toBe(true);
      });

      it("should reply with 404 RpcException error envelope when no message handler is registered", async () => {
        await server.listen();

        const msg = makeRequestMsg("missing.pattern", { a: 1 }, {
          id: "m1",
          correlationId: "corr_missing",
          replyTo: "reply.missing",
        });
        await harness.deliver("tasks.queue", msg);

        expect(harness.sendToQueue.calledOnce).toBe(true);
        const [replyQueue, rawBody, sendOpts] = harness.sendToQueue.firstCall!.args;
        expect(replyQueue).toBe("reply.missing");
        expect(sendOpts).toEqual({ correlationId: "corr_missing" });
        const res = parseResponse(rawBody);
        expect(res.type).toBe("response");
        expect(res.id).toBe("corr_missing");
        expect(res.isDisposed).toBe(true);
        expect(res.error?.isRpcException).toBe(true);
        expect(res.error?.status).toBe(404);
        expect(res.error?.message).toContain("missing.pattern");
      });

      it("should not call nack when handler is missing and noAck is true", async () => {
        const noAckServer = trackServer(
          new RabbitMqTransportServer({
            channel: harness.channel,
            queue: "missing.noack.q",
            noAck: true,
          }),
        );
        await noAckServer.listen();

        await harness.deliver(
          "missing.noack.q",
          makeRequestMsg("unknown.cmd", {}, {
            id: "u1",
            correlationId: "u1",
            replyTo: "reply.u1",
          }),
        );

        expect(harness.nack.notCalled).toBe(true);
        expect(harness.sendToQueue.calledOnce).toBe(true);
        expect(parseResponse(harness.sendToQueue.firstCall!.args[1]).error?.status).toBe(
          404,
        );
      });

      // BUNEST_BUG: When no @MessagePattern handler exists and `noAck` is `false`, RabbitMqTransportServer.onMessage() calls `channel.ack(msg)` instead of `channel.nack(msg, false, false)` (upstream ServerRMQ nacks without requeue on missing handlers) (packages/microservices/src/transports/broker.transports.ts).
      it.skip("should negative acknowledge without requeue when message handler does not exist and noAck is false", async () => {
        await server.listen();

        const msg = makeRequestMsg("unknown.cmd", {}, {
          id: "m_nack",
          correlationId: "m_nack",
          replyTo: "reply.m_nack",
        });
        await harness.deliver("tasks.queue", msg);

        expect(harness.nack.calledOnceWith(msg, false, false)).toBe(true);
        expect(harness.ack.notCalled).toBe(true);
        expect(harness.sendToQueue.calledOnce).toBe(true);
      });

      it("should serialize RpcException, HttpException, generic Error, and non-Error thrown values", async () => {
        server.addMessageHandler("err.rpc.str", () => {
          throw new RpcException("bad rpc input");
        });
        server.addMessageHandler("err.rpc.obj", () => {
          throw new RpcException({ status: 409, code: "CONFLICT", message: "Duplicate" });
        });
        server.addMessageHandler("err.http", () => {
          throw new BadRequestException("invalid field");
        });
        server.addMessageHandler("err.http.custom", () => {
          throw new HttpException({ reason: "quota" }, 429);
        });
        server.addMessageHandler("err.generic", () => {
          throw new TypeError("null deref");
        });
        server.addMessageHandler("err.nonError", () => {
          throw "plain-string-error";
        });
        await server.listen();

        const patterns = [
          "err.rpc.str",
          "err.rpc.obj",
          "err.http",
          "err.http.custom",
          "err.generic",
          "err.nonError",
        ];
        for (const p of patterns) {
          await harness.deliver(
            "tasks.queue",
            makeRequestMsg(p, null, { id: p, correlationId: p, replyTo: "reply.err" }),
          );
        }

        expect(harness.sendToQueue.callCount).toBe(6);
        const responses = harness.sendToQueue.args.map(([, body]) =>
          parseResponse(body),
        );

        expect(responses[0]!.error).toEqual({
          message: "bad rpc input",
          name: "RpcException",
          isRpcException: true,
        });
        expect(responses[1]!.error).toEqual({
          message: "Duplicate",
          name: "RpcException",
          status: 409,
          details: { status: 409, code: "CONFLICT", message: "Duplicate" },
          isRpcException: true,
        });
        expect(responses[2]!.error?.isRpcException).toBe(true);
        expect(responses[2]!.error?.status).toBe(400);
        expect(responses[2]!.error?.name).toBe("BadRequestException");

        expect(responses[3]!.error?.isRpcException).toBe(true);
        expect(responses[3]!.error?.status).toBe(429);
        expect(responses[3]!.error?.details).toEqual({ reason: "quota" });

        expect(responses[4]!.error).toEqual({
          message: "null deref",
          name: "TypeError",
          isRpcException: false,
        });
        expect(responses[5]!.error).toEqual({
          message: "plain-string-error",
          isRpcException: false,
        });
        expect(harness.ack.callCount).toBe(6);
      });

      it("should nack(msg, false, false) when sendToQueue throws/rejects while replying and noAck is false", async () => {
        server.addMessageHandler("reply.boom", () => "value");
        await server.listen();

        harness.sendToQueue.onFirstCall().rejects(new Error("Channel closed"));
        const msg1 = makeRequestMsg("reply.boom", null, {
          id: "b1",
          correlationId: "b1",
          replyTo: "reply.q",
        });
        await expect(
          harness.deliver("tasks.queue", msg1),
        ).resolves.toBeUndefined();

        expect(harness.nack.calledOnceWith(msg1, false, false)).toBe(true);
        expect(harness.ack.notCalled).toBe(true);

        harness.sendToQueue.onSecondCall().throws(new Error("Sync write error"));
        const msg2 = makeRequestMsg("reply.boom", null, {
          id: "b2",
          correlationId: "b2",
          replyTo: "reply.q",
        });
        await expect(
          harness.deliver("tasks.queue", msg2),
        ).resolves.toBeUndefined();

        expect(harness.nack.callCount).toBe(2);
        expect(harness.nack.secondCall?.args).toEqual([msg2, false, false]);
        expect(harness.ack.notCalled).toBe(true);
      });

      it("should not call nack when sendToQueue rejects while replying and noAck is true", async () => {
        const noAckServer = trackServer(
          new RabbitMqTransportServer({
            channel: harness.channel,
            queue: "reply.boom.noack",
            noAck: true,
          }),
        );
        noAckServer.addMessageHandler("reply.boom", () => "value");
        await noAckServer.listen();

        harness.sendToQueue.rejects(new Error("Channel closed"));
        await expect(
          harness.deliver(
            "reply.boom.noack",
            makeRequestMsg("reply.boom", null, {
              id: "b3",
              correlationId: "b3",
              replyTo: "reply.q",
            }),
          ),
        ).resolves.toBeUndefined();

        expect(harness.nack.notCalled).toBe(true);
        expect(harness.ack.notCalled).toBe(true);
      });

      // BUNEST_BUG: RabbitMqTransportServer.onMessage() does not unwrap RmqRecord / RmqRecordBuilder responses returned by handlers, serializing `{ data, options }` directly into `response.response` and dropping record options (e.g., priority, headers, persistent) instead of forwarding them to `channel.sendToQueue` while preserving request `correlationId` (packages/microservices/src/transports/broker.transports.ts & packages/microservices/src/interfaces.ts).
      it.skip("should unwrap RmqRecord response data and forward options to sendToQueue while preserving request correlationId", async () => {
        const recordOptions = {
          priority: 5,
          headers: { "x-reply": "yes" },
          correlationId: "ignored-override",
        };
        server.addMessageHandler("record.reply", () =>
          new RmqRecordBuilder({ value: "test" })
            .setOptions(recordOptions as Record<string, unknown>)
            .build(),
        );
        await server.listen();

        await harness.deliver(
          "tasks.queue",
          makeRequestMsg("record.reply", null, {
            id: "rec_1",
            correlationId: "orig-corr-id",
            replyTo: "reply.rec",
          }),
        );

        const [replyQueue, rawBody, sendOpts] = harness.sendToQueue.firstCall!.args;
        expect(replyQueue).toBe("reply.rec");
        expect(parseResponse(rawBody)).toEqual({
          type: "response",
          id: "orig-corr-id",
          response: { value: "test" },
          isDisposed: true,
        });
        expect(sendOpts).toMatchObject({
          priority: 5,
          headers: { "x-reply": "yes" },
          correlationId: "orig-corr-id",
        });
      });

      // BUNEST_BUG: RabbitMqTransportServer.onMessage() only populates `metadata` with `{ queue, correlationId, replyTo }` and drops AMQP `msg.properties.headers` (packages/microservices/src/transports/broker.transports.ts & packages/microservices/src/interfaces.ts).
      it.skip("should expose incoming message headers in RpcContext.metadata", async () => {
        let capturedCtx: RpcContext | undefined;
        server.addEventHandler("traced.event", (_data, ctx) => {
          capturedCtx = ctx;
        });
        await server.listen();

        const msg = {
          ...makeEventMsg("traced.event", { ok: true }),
          properties: {
            correlationId: "c-hdr",
            headers: { "x-request-id": "trace-1" },
          },
        } as unknown as RabbitMqMessageLike;

        await harness.deliver("tasks.queue", msg);
        expect(capturedCtx?.metadata).toMatchObject({
          headers: { "x-request-id": "trace-1" },
        });
      });
    });

    describe("onMessage — event dispatch", () => {
      it("should dispatch event envelope to all matching handlers in order, skip reply, and ack when noAck is false", async () => {
        const calls: string[] = [];
        let capturedCtx: RpcContext | undefined;

        server.addEventHandler("order.paid", async (data, ctx) => {
          capturedCtx = ctx;
          await Promise.resolve();
          calls.push(`h1:${(data as { id: string }).id}`);
        });
        server.addEventHandler("order.paid", (data) => {
          calls.push(`h2:${(data as { id: string }).id}`);
        });
        await server.listen();

        const msg = makeEventMsg(
          "order.paid",
          { id: "ord_9" },
          { replyTo: "should.not.reply", correlationId: "evt_corr" },
        );
        await harness.deliver("tasks.queue", msg);

        expect(calls).toEqual(["h1:ord_9", "h2:ord_9"]);
        expect(capturedCtx).toEqual({
          transport: Transport.RABBITMQ,
          pattern: "order.paid",
          metadata: {
            queue: "tasks.queue",
            correlationId: "evt_corr",
            replyTo: "should.not.reply",
          },
        });
        expect(harness.sendToQueue.notCalled).toBe(true);
        expect(harness.ack.calledOnceWith(msg)).toBe(true);
      });

      it("should isolate errors thrown by individual event handlers so remaining handlers still run", async () => {
        const executed: string[] = [];

        server.addEventHandler("audit.log", () => {
          executed.push("first");
          throw new Error("sync boom");
        });
        server.addEventHandler("audit.log", async () => {
          executed.push("second");
          throw new Error("async boom");
        });
        server.addEventHandler("audit.log", () => {
          executed.push("third");
        });
        await server.listen();

        const msg = makeEventMsg("audit.log", { event: "login" });
        await expect(
          harness.deliver("tasks.queue", msg),
        ).resolves.toBeUndefined();

        expect(executed).toEqual(["first", "second", "third"]);
        expect(harness.ack.calledOnceWith(msg)).toBe(true);
        expect(harness.nack.notCalled).toBe(true);
      });

      it("should dispatch structured object event patterns and respect noAck: true", async () => {
        const noAckServer = trackServer(
          new RabbitMqTransportServer({
            channel: harness.channel,
            queue: "evt.noack.q",
            noAck: true,
          }),
        );
        const received: unknown[] = [];
        noAckServer.addEventHandler({ entity: "user", action: "deleted" }, (d) => {
          received.push(d);
        });
        await noAckServer.listen();

        await harness.deliver(
          "evt.noack.q",
          makeEventMsg('{"action":"deleted","entity":"user"}', { userId: 42 }),
        );
        // Unknown event with noAck: true should not nack
        await harness.deliver("evt.noack.q", makeEventMsg("no.such.event", {}));

        expect(received).toEqual([{ userId: 42 }]);
        expect(harness.ack.notCalled).toBe(true);
        expect(harness.nack.notCalled).toBe(true);
      });

      // BUNEST_BUG: When no @EventPattern handler exists and `noAck` is `false`, RabbitMqTransportServer.onMessage() calls `channel.ack(msg)` instead of `channel.nack(msg, false, false)` (upstream ServerRMQ.handleEvent nacks without requeue on unknown events when noAck is false) (packages/microservices/src/transports/broker.transports.ts).
      it.skip("should negative acknowledge without requeue when event handler does not exist and noAck is false", async () => {
        await server.listen();

        const msg = makeEventMsg("unhandled.event", { test: true });
        await harness.deliver("tasks.queue", msg);

        expect(harness.nack.calledOnceWith(msg, false, false)).toBe(true);
        expect(harness.ack.notCalled).toBe(true);
      });
    });

    describe("setPreRequestHook, unwrap, wildcards & end-to-end integration", () => {
      it("should invoke setPreRequestHook via super.dispatchMessage before executing message handler", async () => {
        const order: string[] = [];
        const returned = server.setPreRequestHook(({ pattern, data, ctx }) => {
          order.push(`hook:${pattern}:${JSON.stringify(data)}:${ctx.transport}`);
        });
        expect(returned).toBe(server);

        server.addMessageHandler("work.run", (data) => {
          order.push(`handler:${JSON.stringify(data)}`);
          return "completed";
        });
        await server.listen();

        const msg = makeRequestMsg(
          "work.run",
          { step: 1 },
          { id: "h1", correlationId: "h1", replyTo: "reply.hook" },
        );
        await harness.deliver("tasks.queue", msg);

        expect(order).toEqual([
          'hook:work.run:{"step":1}:RABBITMQ',
          'handler:{"step":1}',
        ]);
        expect(parseResponse(harness.sendToQueue.firstCall!.args[1]).response).toBe(
          "completed",
        );

        // Clearing the hook stops invocations
        server.setPreRequestHook(undefined);
        await harness.deliver(
          "tasks.queue",
          makeRequestMsg(
            "work.run",
            { step: 2 },
            { id: "h2", correlationId: "h2", replyTo: "reply.hook" },
          ),
        );
        expect(order).toEqual([
          'hook:work.run:{"step":1}:RABBITMQ',
          'handler:{"step":1}',
          'handler:{"step":2}',
        ]);
      });

      it("should serialize error and skip handler when setPreRequestHook throws", async () => {
        const handler = createSpy(() => "never");
        server.setPreRequestHook(() => {
          throw new RpcException({ status: 401, message: "Unauthenticated" });
        });
        server.addMessageHandler("protected.op", handler);
        await server.listen();

        const msg = makeRequestMsg("protected.op", null, {
          id: "p1",
          correlationId: "p1",
          replyTo: "reply.prot",
        });
        await harness.deliver("tasks.queue", msg);

        expect(handler.notCalled).toBe(true);
        const res = parseResponse(harness.sendToQueue.firstCall!.args[1]);
        expect(res.error).toEqual({
          message: "Unauthenticated",
          name: "RpcException",
          status: 401,
          details: { status: 401, message: "Unauthenticated" },
          isRpcException: true,
        });
        expect(harness.ack.calledOnceWith(msg)).toBe(true);
      });

      it("should expose unwrap() on RabbitMqTransportServer", () => {
        expect(typeof server.unwrap).toBe("function");
        expect(server.unwrap()).toBeDefined();
      });

      // BUNEST_BUG: RabbitMqTransportServer inherits base `MicroserviceTransportServer.unwrap()` which returns `this` instead of overriding it to return the underlying injected `RabbitMqChannelLike` (packages/microservices/src/transports/broker.transports.ts).
      it.skip("should return the underlying RabbitMqChannelLike from unwrap()", () => {
        expect(server.unwrap<RabbitMqChannelLike>()).toBe(harness.channel);
      });

      // BUNEST_BUG: RabbitMqTransportServer does not support AMQP wildcard topic pattern matching (`*` single-segment and `#` multi-segment, `wildcards: true`) unlike NestJS ServerRMQ and Bunest MqttServer (packages/microservices/src/transports/broker.transports.ts & packages/microservices/src/interfaces.ts).
      it.skip("should match AMQP wildcard patterns (* and #) when wildcards option is enabled", async () => {
        const wildcardServer = trackServer(
          new RabbitMqTransportServer({
            channel: harness.channel,
            queue: "topic.q",
            ...({ wildcards: true } as Record<string, unknown>),
          }),
        );
        const singleWildcard = createSpy(() => "single-match");
        const multiWildcard = createSpy(() => "multi-match");

        wildcardServer.addMessageHandler("user.*", singleWildcard);
        wildcardServer.addMessageHandler("app.#.error", multiWildcard);
        await wildcardServer.listen();

        await harness.deliver(
          "topic.q",
          makeRequestMsg("user.created", { id: 1 }, {
            id: "w1",
            correlationId: "w1",
            replyTo: "reply.w",
          }),
        );
        await harness.deliver(
          "topic.q",
          makeRequestMsg("app.db.pool.error", { code: 500 }, {
            id: "w2",
            correlationId: "w2",
            replyTo: "reply.w",
          }),
        );

        expect(singleWildcard.calledOnce).toBe(true);
        expect(multiWildcard.calledOnce).toBe(true);
      });

      itAdapted(
        ["ADR-001", "ADR-008"],
        "should handle concurrent client requests, events, and acks end-to-end with RabbitMqClientProxy",
        async () => {
          const e2eHarness = createMockChannel({ autoDeliver: true });
          const e2eServer = trackServer(
            new RabbitMqServer({
              channel: e2eHarness.channel,
              queue: "rpc.e2e",
            }),
          );
          const receivedEvents: unknown[] = [];

          e2eServer.addMessageHandler("compute.square", async (n) => {
            await Promise.resolve();
            return (n as number) * (n as number);
          });
          e2eServer.addEventHandler("compute.logged", (d) => {
            receivedEvents.push(d);
          });
          await e2eServer.listen();

          const e2eClient = trackClient(
            new RabbitMqClientProxy({
              channel: e2eHarness.channel,
              queue: "rpc.e2e",
            }),
          );

          const results = await Promise.all([
            e2eClient.send<number>("compute.square", 3),
            e2eClient.send<number>("compute.square", 7),
            e2eClient.send<number>("compute.square", 11),
          ]);
          expect(results).toEqual([9, 49, 121]);

          await e2eClient.emit("compute.logged", { count: 3 });
          expect(receivedEvents).toEqual([{ count: 3 }]);
          expect(e2eHarness.ack.callCount).toBe(4);
        },
      );
    });
  },
);
