import "reflect-metadata";
import { afterEach, describe, expect, it } from "bun:test";
import {
  createSandbox,
  describeConformance,
  expectCalledOnce,
  expectNotCalled,
  itAdapted,
} from "../../../../_helpers";
import {
  BadRequestException,
  HttpException,
  HttpStatus,
} from "../../../../../../packages/common/src";
import {
  RedisClientProxy,
  RedisRecordBuilder,
  RedisServer,
  RedisTransportAdapter,
  RedisTransportServer,
  RpcException,
  Transport,
  type RedisTransportClientLike,
  type RpcContext,
  type RpcEventEnvelope,
  type RpcRequestEnvelope,
  type RpcResponseEnvelope,
} from "../../../../../../packages/microservices/src";

interface PublishedMessage {
  readonly channel: string;
  readonly message: string;
}

function createMockRedisTransport(config?: {
  omitUnsubscribe?: boolean;
  subscribeImpl?: (
    channel: string,
    listener: (message: string, channel: string) => void,
  ) => Promise<void> | void;
}) {
  const channels = new Map<
    string,
    Set<(message: string, channel: string) => void>
  >();
  const subscribedChannels: string[] = [];
  const unsubscribedChannels: string[] = [];
  const published: PublishedMessage[] = [];

  const makeClient = (): RedisTransportClientLike => {
    const client: RedisTransportClientLike = {
      subscribe(channel, listener) {
        subscribedChannels.push(channel);
        const register = () => {
          let set = channels.get(channel);
          if (!set) {
            set = new Set();
            channels.set(channel, set);
          }
          set.add(listener);
        };
        if (config?.subscribeImpl) {
          const res = config.subscribeImpl(channel, listener);
          if (res && typeof (res as Promise<void>).then === "function") {
            return (res as Promise<void>).then(() => {
              register();
            });
          }
          register();
          return;
        }
        register();
      },
      publish(channel, message) {
        published.push({ channel, message });
        const listeners = [...(channels.get(channel) ?? [])];
        for (const fn of listeners) {
          fn(message, channel);
        }
        return listeners.length;
      },
    };

    if (!config?.omitUnsubscribe) {
      client.unsubscribe = (channel) => {
        unsubscribedChannels.push(channel);
        channels.delete(channel);
      };
    }

    return client;
  };

  const deliver = async (channel: string, raw: string | Uint8Array) => {
    const listeners = [...(channels.get(channel) ?? [])];
    for (const fn of listeners) {
      fn(raw as unknown as string, channel);
    }
    // RedisTransportServer invokes `void this.onMessage(...)`, so flush microtasks
    for (let i = 0; i < 8; i += 1) {
      await Promise.resolve();
    }
  };

  return {
    channels,
    subscribedChannels,
    unsubscribedChannels,
    published,
    makeClient,
    deliver,
  };
}

describeConformance(
  "ServerRedis (RedisTransportServer)",
  {
    upstreamPath: "packages/microservices/test/server/server-redis.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008"],
    notes:
      "Bunest uses client-injected RedisTransportClientLike (zero ioredis driver dependency), prefixed pub/sub channels (<prefix>:<pattern>), and Promise-based message/event handlers.",
  },
  () => {
    const sandbox = createSandbox();
    const activeServers: RedisTransportServer[] = [];

    const track = (server: RedisTransportServer): RedisTransportServer => {
      activeServers.push(server);
      return server;
    };

    afterEach(async () => {
      sandbox.restore();
      while (activeServers.length > 0) {
        await activeServers.pop()?.close();
      }
    });

    describe("constructor & handler registration", () => {
      it("sets Transport.REDIS and exposes RedisServer and RedisTransportAdapter.Server aliases", () => {
        const transport = createMockRedisTransport();
        const server = track(
          new RedisTransportServer({ pubClient: transport.makeClient() }),
        );

        expect(server.transport).toBe(Transport.REDIS);
        expect(server.isListening).toBe(false);
        expect(RedisServer).toBe(RedisTransportServer);
        expect(RedisTransportAdapter.Server).toBe(RedisTransportServer);
        expect(server.unwrap<RedisTransportServer>()).toBe(server);
      });

      it("registers string, RegExp, and structured object patterns and rejects duplicate message handlers", () => {
        const transport = createMockRedisTransport();
        const server = track(
          new RedisTransportServer({ pubClient: transport.makeClient() }),
        );

        const h1 = () => "ok";
        const e1 = () => {};
        const e2 = () => {};

        server.addMessageHandler("users.get", h1);
        server.addMessageHandler({ cmd: "sum", v: 1 }, h1);
        server.addMessageHandler(/^metrics\./, h1);
        server.addEventHandler("users.created", e1);
        server.addEventHandler("users.created", e2);

        expect(server.getMessageHandler("users.get")).toBe(h1);
        expect(server.getMessageHandler({ v: 1, cmd: "sum" })).toBe(h1);
        expect(server.getMessageHandler(/^metrics\./)).toBe(h1);
        expect(server.getEventHandlers("users.created")).toEqual([e1, e2]);
        expect(server.getRegisteredPatterns()).toEqual({
          messagePatterns: ["users.get", '{"cmd":"sum","v":1}', "/^metrics\\./"],
          eventPatterns: ["users.created"],
        });

        expect(() => server.addMessageHandler("users.get", () => 2)).toThrow(
          /Duplicate @MessagePattern\(users\.get\)/,
        );
        expect(() =>
          server.addMessageHandler({ v: 1, cmd: "sum" }, () => 3),
        ).toThrow(/Duplicate @MessagePattern/);
      });
    });

    describe("listen() & close()", () => {
      it("subscribes unique channels on subClient with default 'bunest:rpc' or custom channelPrefix", async () => {
        const transport = createMockRedisTransport();
        const pubClient = transport.makeClient();
        const subClient = transport.makeClient();
        const pubSubSpy = sandbox.spy(pubClient, "subscribe");
        const subSubSpy = sandbox.spy(subClient, "subscribe");

        const server = track(
          new RedisTransportServer({ pubClient, subClient }),
        );
        server.addMessageHandler("math.add", () => 1);
        server.addEventHandler("math.add", () => {});
        server.addEventHandler("math.logged", () => {});

        await server.listen();
        expect(server.isListening).toBe(true);
        expectNotCalled(pubSubSpy);
        expect(subSubSpy.callCount).toBe(2);
        expect(transport.subscribedChannels).toEqual([
          "bunest:rpc:math.add",
          "bunest:rpc:math.logged",
        ]);

        // listen() is idempotent
        await server.listen();
        expect(subSubSpy.callCount).toBe(2);
      });

      it("defaults subClient to pubClient when omitted and applies custom channelPrefix", async () => {
        const transport = createMockRedisTransport();
        const shared = transport.makeClient();
        const server = track(
          new RedisTransportServer({
            pubClient: shared,
            channelPrefix: "svc:v2",
          }),
        );
        server.addMessageHandler("ping", () => "pong");
        await server.listen();

        expect(transport.subscribedChannels).toEqual(["svc:v2:ping"]);
      });

      it("unsubscribes all channels on close(), resets isListening, and supports re-listening", async () => {
        const transport = createMockRedisTransport();
        const server = track(
          new RedisTransportServer({
            pubClient: transport.makeClient(),
            channelPrefix: "app",
          }),
        );
        server.addMessageHandler("a", () => 1);
        server.addEventHandler("b", () => {});
        await server.listen();

        await server.close();
        expect(server.isListening).toBe(false);
        expect(transport.unsubscribedChannels).toEqual(["app:a", "app:b"]);

        // Repeated close must be idempotent
        await server.close();
        expect(transport.unsubscribedChannels).toEqual(["app:a", "app:b"]);

        // Re-listening after close subscribes existing + newly added patterns
        server.addMessageHandler("c", () => 3);
        await server.listen();
        expect(server.isListening).toBe(true);
        expect(transport.subscribedChannels).toEqual([
          "app:a",
          "app:b",
          "app:a",
          "app:c",
          "app:b",
        ]);
      });

      it("closes cleanly when subClient omits optional unsubscribe()", async () => {
        const transport = createMockRedisTransport({ omitUnsubscribe: true });
        const server = track(
          new RedisTransportServer({ pubClient: transport.makeClient() }),
        );
        server.addMessageHandler("x", () => 1);
        await server.listen();
        await expect(server.close()).resolves.toBeUndefined();
        expect(server.isListening).toBe(false);
      });

      // BUNEST_BUG: RedisTransportServer.listen() pushes channel onto subscribedChannels BEFORE awaiting subClient.subscribe(); if subscribe() rejects and listen() is retried, subscribedChannels contains duplicate entries and close() calls unsubscribe() twice (packages/microservices/src/transports/broker.transports.ts).
      it.skip("does not record failed channels in subscribedChannels when subscribe() rejects", async () => {
        let shouldFail = true;
        const transport = createMockRedisTransport({
          subscribeImpl: async () => {
            if (shouldFail) {
              shouldFail = false;
              throw new Error("NOPERM");
            }
          },
        });
        const server = track(
          new RedisTransportServer({
            pubClient: transport.makeClient(),
            channelPrefix: "retry",
          }),
        );
        server.addMessageHandler("op", () => "ok");

        await expect(server.listen()).rejects.toThrow("NOPERM");
        expect(server.isListening).toBe(false);

        await server.listen();
        await server.close();
        expect(transport.unsubscribedChannels).toEqual(["retry:op"]);
      });
    });

    describe("onMessage() — request-reply dispatch", () => {
      itAdapted(
        ["ADR-001", "ADR-008"],
        "dispatches request to handler with RpcContext and publishes response to envelope.replyTo",
        async () => {
          const transport = createMockRedisTransport();
          const pubClient = transport.makeClient();
          const subClient = transport.makeClient();
          const server = track(
            new RedisTransportServer({
              pubClient,
              subClient,
              channelPrefix: "svc",
            }),
          );

          let capturedCtx: RpcContext | undefined;
          server.addMessageHandler("orders.get", async (data, ctx) => {
            capturedCtx = ctx;
            await Promise.resolve();
            return { found: data };
          });
          await server.listen();

          await transport.deliver(
            "svc:orders.get",
            JSON.stringify({
              type: "request",
              id: "req-1",
              pattern: "orders.get",
              data: { id: "ord_9" },
              replyTo: "svc:reply:client-7",
            } satisfies RpcRequestEnvelope),
          );

          expect(capturedCtx).toEqual({
            transport: Transport.REDIS,
            pattern: "orders.get",
            metadata: { channel: "svc:orders.get" },
          });
          expect(transport.published).toHaveLength(1);
          expect(transport.published[0]?.channel).toBe("svc:reply:client-7");
          expect(JSON.parse(transport.published[0]!.message)).toEqual({
            type: "response",
            id: "req-1",
            response: { found: { id: "ord_9" } },
            isDisposed: true,
          });
        },
      );

      it("falls back to <prefix>:<pattern>.reply when envelope.replyTo is omitted", async () => {
        const transport = createMockRedisTransport();
        const server = track(
          new RedisTransportServer({
            pubClient: transport.makeClient(),
            channelPrefix: "fallback",
          }),
        );
        server.addMessageHandler("math.inc", (n) => (n as number) + 1);
        await server.listen();

        await transport.deliver(
          "fallback:math.inc",
          JSON.stringify({
            type: "request",
            id: "req-fb",
            pattern: "math.inc",
            data: 41,
          } satisfies RpcRequestEnvelope),
        );

        expect(transport.published).toHaveLength(1);
        expect(transport.published[0]?.channel).toBe("fallback:math.inc.reply");
        expect(JSON.parse(transport.published[0]!.message)).toEqual({
          type: "response",
          id: "req-fb",
          response: 42,
          isDisposed: true,
        });
      });

      it("decodes Uint8Array payloads delivered to subscribe listener", async () => {
        const encoder = new TextEncoder();
        const transport = createMockRedisTransport();
        const server = track(
          new RedisTransportServer({ pubClient: transport.makeClient() }),
        );
        server.addMessageHandler("utf8", (d) => ({ got: d }));
        await server.listen();

        await transport.deliver(
          "bunest:rpc:utf8",
          encoder.encode(
            JSON.stringify({
              type: "request",
              id: "req-u8",
              pattern: "utf8",
              data: "résumé",
              replyTo: "bunest:rpc:reply:c1",
            } satisfies RpcRequestEnvelope),
          ),
        );

        expect(transport.published).toHaveLength(1);
        expect(JSON.parse(transport.published[0]!.message)).toEqual({
          type: "response",
          id: "req-u8",
          response: { got: "résumé" },
          isDisposed: true,
        });
      });

      it("ignores malformed JSON, non-envelope payloads, and response envelopes", async () => {
        const transport = createMockRedisTransport();
        const server = track(
          new RedisTransportServer({ pubClient: transport.makeClient() }),
        );
        const handlerSpy = sandbox.spy(() => "never");
        server.addMessageHandler("test", handlerSpy);
        await server.listen();

        await transport.deliver("bunest:rpc:test", "{{broken-json");
        await transport.deliver(
          "bunest:rpc:test",
          JSON.stringify({ id: "1", data: "no-type" }),
        );
        await transport.deliver(
          "bunest:rpc:test",
          JSON.stringify({
            type: "response",
            id: "1",
            response: "loop",
            isDisposed: true,
          } satisfies RpcResponseEnvelope),
        );

        expectNotCalled(handlerSpy);
        expect(transport.published).toHaveLength(0);
      });

      it("publishes 404 RpcException when request arrives for a pattern with no message handler", async () => {
        const transport = createMockRedisTransport();
        const server = track(
          new RedisTransportServer({ pubClient: transport.makeClient() }),
        );
        const eventSpy = sandbox.spy();
        server.addEventHandler("event.only", eventSpy);
        await server.listen();

        await transport.deliver(
          "bunest:rpc:event.only",
          JSON.stringify({
            type: "request",
            id: "req-404",
            pattern: "event.only",
            data: null,
            replyTo: "bunest:rpc:reply:c404",
          } satisfies RpcRequestEnvelope),
        );

        expectNotCalled(eventSpy);
        expect(transport.published).toHaveLength(1);
        const reply = JSON.parse(
          transport.published[0]!.message,
        ) as RpcResponseEnvelope;
        expect(reply.id).toBe("req-404");
        expect(reply.error?.isRpcException).toBe(true);
        expect(reply.error?.status).toBe(404);
        expect(reply.error?.message).toContain("event.only");
      });

      // BUNEST_BUG: RedisTransportServer.onMessage() does not unwrap RedisRecord returned by a message handler; it serializes the raw { data, options } wrapper inside envelope.response (packages/microservices/src/transports/broker.transports.ts).
      it.skip("unwraps RedisRecord returned by a message handler into response data", async () => {
        const transport = createMockRedisTransport();
        const server = track(
          new RedisTransportServer({ pubClient: transport.makeClient() }),
        );
        server.addMessageHandler("rec.get", () =>
          new RedisRecordBuilder({ ok: true })
            .setOptions({ headers: { "x-ver": "1" } })
            .build(),
        );
        await server.listen();

        await transport.deliver(
          "bunest:rpc:rec.get",
          JSON.stringify({
            type: "request",
            id: "req-rec",
            pattern: "rec.get",
            data: null,
            replyTo: "bunest:rpc:reply:rec",
          } satisfies RpcRequestEnvelope),
        );

        const reply = JSON.parse(
          transport.published[0]!.message,
        ) as RpcResponseEnvelope;
        expect(reply.response).toEqual({ ok: true });
      });

      // BUNEST_BUG: RedisTransportServer does not support NestJS wildcards/psubscribe option to match wildcard channel patterns like "users.*" against concrete channels like "users.created" (packages/microservices/src/transports/broker.transports.ts & interfaces.ts).
      it.skip("supports wildcard pattern subscriptions (psubscribe) routing concrete channels", async () => {
        const transport = createMockRedisTransport();
        const server = track(
          new RedisTransportServer({
            pubClient: transport.makeClient(),
            channelPrefix: "wc",
          }),
        );
        const handler = sandbox.spy((data: unknown) => ({ handled: data }));
        server.addMessageHandler("users.*", handler);
        await server.listen();

        await transport.deliver(
          "wc:users.created",
          JSON.stringify({
            type: "request",
            id: "req-wc",
            pattern: "users.created",
            data: { id: 1 },
            replyTo: "wc:reply:c1",
          } satisfies RpcRequestEnvelope),
        );

        expectCalledOnce(handler);
        expect(transport.published).toHaveLength(1);
      });
    });

    describe("onMessage() — error serialization", () => {
      it("serializes RpcException (string & object), HttpException, Error, and non-Error values", async () => {
        const transport = createMockRedisTransport();
        const server = track(
          new RedisTransportServer({ pubClient: transport.makeClient() }),
        );

        server.addMessageHandler("err.rpc.str", () => {
          throw new RpcException("denied");
        });
        server.addMessageHandler("err.rpc.obj", () => {
          throw new RpcException({ status: 422, message: "invalid", code: "E1" });
        });
        server.addMessageHandler("err.http", () => {
          throw new BadRequestException("bad-req");
        });
        server.addMessageHandler("err.http.custom", () => {
          throw new HttpException({ detail: "locked" }, HttpStatus.FORBIDDEN);
        });
        server.addMessageHandler("err.generic", () => {
          throw new RangeError("out of bounds");
        });
        server.addMessageHandler("err.primitive", () => {
          throw 503;
        });
        await server.listen();

        const invoke = async (pattern: string): Promise<RpcResponseEnvelope> => {
          const before = transport.published.length;
          await transport.deliver(
            `bunest:rpc:${pattern}`,
            JSON.stringify({
              type: "request",
              id: `id-${pattern}`,
              pattern,
              data: null,
              replyTo: `bunest:rpc:reply:${pattern}`,
            } satisfies RpcRequestEnvelope),
          );
          expect(transport.published.length).toBe(before + 1);
          return JSON.parse(
            transport.published[before]!.message,
          ) as RpcResponseEnvelope;
        };

        expect((await invoke("err.rpc.str")).error).toEqual({
          message: "denied",
          name: "RpcException",
          isRpcException: true,
        });

        expect((await invoke("err.rpc.obj")).error).toEqual({
          message: "invalid",
          name: "RpcException",
          status: 422,
          details: { status: 422, message: "invalid", code: "E1" },
          isRpcException: true,
        });

        const httpRes = await invoke("err.http");
        expect(httpRes.error?.isRpcException).toBe(true);
        expect(httpRes.error?.status).toBe(400);
        expect(httpRes.error?.name).toBe("BadRequestException");

        const customHttp = await invoke("err.http.custom");
        expect(customHttp.error?.isRpcException).toBe(true);
        expect(customHttp.error?.status).toBe(403);
        expect(customHttp.error?.details).toEqual({ detail: "locked" });

        expect((await invoke("err.generic")).error).toEqual({
          message: "out of bounds",
          name: "RangeError",
          isRpcException: false,
        });

        expect((await invoke("err.primitive")).error).toEqual({
          message: "503",
          isRpcException: false,
        });
      });
    });

    describe("onMessage() — event dispatch & error isolation", () => {
      it("dispatches events to multiple handlers in order and isolates sync/async errors without publishing replies", async () => {
        const transport = createMockRedisTransport();
        const server = track(
          new RedisTransportServer({
            pubClient: transport.makeClient(),
            channelPrefix: "ev",
          }),
        );
        const log: string[] = [];

        server.addEventHandler("audit.recorded", (data, ctx) => {
          log.push(`h1:${JSON.stringify(data)}:${ctx.transport}`);
        });
        server.addEventHandler("audit.recorded", () => {
          log.push("h2:sync-throw");
          throw new Error("sync boom");
        });
        server.addEventHandler("audit.recorded", async () => {
          log.push("h3:async-reject");
          throw new Error("async boom");
        });
        server.addEventHandler("audit.recorded", (_data, ctx) => {
          log.push(`h4:${ctx.pattern}:${String(ctx.metadata?.channel)}`);
        });
        await server.listen();

        await transport.deliver(
          "ev:audit.recorded",
          JSON.stringify({
            type: "event",
            pattern: "audit.recorded",
            data: { seq: 1 },
          } satisfies RpcEventEnvelope),
        );

        expect(log).toEqual([
          'h1:{"seq":1}:REDIS',
          "h2:sync-throw",
          "h3:async-reject",
          "h4:audit.recorded:ev:audit.recorded",
        ]);
        expect(transport.published).toHaveLength(0);
      });

      it("silently ignores event envelopes delivered to a message-only channel", async () => {
        const transport = createMockRedisTransport();
        const server = track(
          new RedisTransportServer({ pubClient: transport.makeClient() }),
        );
        const msgSpy = sandbox.spy(() => "msg");
        server.addMessageHandler("rpc.only", msgSpy);
        await server.listen();

        await transport.deliver(
          "bunest:rpc:rpc.only",
          JSON.stringify({
            type: "event",
            pattern: "rpc.only",
            data: "ignored",
          } satisfies RpcEventEnvelope),
        );

        expectNotCalled(msgSpy);
        expect(transport.published).toHaveLength(0);
      });
    });

    describe("setPreRequestHook()", () => {
      it("invokes preRequestHook via dispatchMessage and serializes hook errors without calling handler", async () => {
        const transport = createMockRedisTransport();
        const server = track(
          new RedisTransportServer({ pubClient: transport.makeClient() }),
        );
        const trace: string[] = [];

        expect(
          server.setPreRequestHook(({ pattern, data, ctx }) => {
            trace.push(`hook:${pattern}:${ctx.transport}:${String(data)}`);
            if (data === "reject") {
              throw new RpcException({ status: 403, message: "Forbidden" });
            }
          }),
        ).toBe(server);

        server.addMessageHandler("secure.call", (data) => {
          trace.push(`handler:${String(data)}`);
          return { ok: data };
        });
        await server.listen();

        await transport.deliver(
          "bunest:rpc:secure.call",
          JSON.stringify({
            type: "request",
            id: "1",
            pattern: "secure.call",
            data: "pass",
            replyTo: "bunest:rpc:reply:1",
          } satisfies RpcRequestEnvelope),
        );
        expect(trace).toEqual(["hook:secure.call:REDIS:pass", "handler:pass"]);
        expect(
          (JSON.parse(transport.published[0]!.message) as RpcResponseEnvelope)
            .response,
        ).toEqual({ ok: "pass" });

        await transport.deliver(
          "bunest:rpc:secure.call",
          JSON.stringify({
            type: "request",
            id: "2",
            pattern: "secure.call",
            data: "reject",
            replyTo: "bunest:rpc:reply:2",
          } satisfies RpcRequestEnvelope),
        );
        expect(trace).toEqual([
          "hook:secure.call:REDIS:pass",
          "handler:pass",
          "hook:secure.call:REDIS:reject",
        ]);
        const errReply = JSON.parse(
          transport.published[1]!.message,
        ) as RpcResponseEnvelope;
        expect(errReply.error?.status).toBe(403);
        expect(errReply.error?.isRpcException).toBe(true);

        // Clearing hook restores direct execution
        server.setPreRequestHook(undefined);
        await transport.deliver(
          "bunest:rpc:secure.call",
          JSON.stringify({
            type: "request",
            id: "3",
            pattern: "secure.call",
            data: "reject",
            replyTo: "bunest:rpc:reply:3",
          } satisfies RpcRequestEnvelope),
        );
        expect(
          (JSON.parse(transport.published[2]!.message) as RpcResponseEnvelope)
            .response,
        ).toEqual({ ok: "reject" });
      });
    });

    describe("end-to-end client-server roundtrip", () => {
      it("routes structured patterns, RpcExceptions, and events between RedisClientProxy and RedisServer", async () => {
        const transport = createMockRedisTransport();
        const pub = transport.makeClient();
        const sub = transport.makeClient();
        const server = track(
          new RedisServer({
            pubClient: pub,
            subClient: sub,
            channelPrefix: "e2e",
          }),
        );
        const events: unknown[] = [];

        server.addMessageHandler({ cmd: "mul" }, (data) => {
          const { a, b } = data as { a: number; b: number };
          return a * b;
        });
        server.addMessageHandler("div", (data) => {
          const { a, b } = data as { a: number; b: number };
          if (b === 0) throw new RpcException("division by zero");
          return a / b;
        });
        server.addEventHandler("audit", (e) => {
          events.push(e);
        });
        await server.listen();

        const client = new RedisClientProxy({
          pubClient: pub,
          subClient: transport.makeClient(),
          channelPrefix: "e2e",
          clientId: "e2e-client",
        });

        try {
          expect(
            await client.send<number>({ cmd: "mul" }, { a: 7, b: 6 }),
          ).toBe(42);
          await expect(
            client.send("div", { a: 1, b: 0 }),
          ).rejects.toThrow("division by zero");

          await client.emit("audit", { op: "mul" });
          await Bun.sleep(5);
          expect(events).toEqual([{ op: "mul" }]);
        } finally {
          await client.close();
        }
      });
    });
  },
);
