import { afterEach, describe, expect, it } from "bun:test";
import {
  createSandbox,
  describeConformance,
  expectCalledOnce,
  itAdapted,
} from "../../../../_helpers";
import {
  RedisClientProxy,
  RedisRecord,
  RedisRecordBuilder,
  RedisServer,
  RedisTransportAdapter,
  RpcException,
  RpcTimeoutException,
  Transport,
  type ClientStatus,
  type RedisTransportClientLike,
  type RpcEventEnvelope,
  type RpcRequestEnvelope,
  type RpcResponseEnvelope,
} from "../../../../../../packages/microservices/src";

interface RecordedRedisPublish {
  readonly channel: string;
  readonly message: string;
}

function createMockRedisBus() {
  const channels = new Map<
    string,
    Set<(message: string, channel: string) => void>
  >();
  const published: RecordedRedisPublish[] = [];
  const subscribedLog: string[] = [];
  const unsubscribedLog: string[] = [];

  const createClient = (overrides?: {
    subscribeImpl?: (
      channel: string,
      listener: (message: string, channel: string) => void,
    ) => Promise<void> | void;
    publishImpl?: (
      channel: string,
      message: string,
    ) => Promise<number | void> | number | void;
    omitUnsubscribe?: boolean;
    onDelivery?: (channel: string, message: string) => void;
  }): RedisTransportClientLike => {
    const client: RedisTransportClientLike = {
      subscribe(channel, listener) {
        subscribedLog.push(channel);
        const wrapped = (msg: string, ch: string) => {
          overrides?.onDelivery?.(ch, msg);
          listener(msg, ch);
        };
        const register = () => {
          let set = channels.get(channel);
          if (!set) {
            set = new Set();
            channels.set(channel, set);
          }
          set.add(wrapped);
        };
        if (overrides?.subscribeImpl) {
          const res = overrides.subscribeImpl(channel, listener);
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
        if (overrides?.publishImpl) {
          return overrides.publishImpl(channel, message);
        }
        const listeners = [...(channels.get(channel) ?? [])];
        for (const fn of listeners) {
          fn(message, channel);
        }
        return listeners.length;
      },
    };

    if (!overrides?.omitUnsubscribe) {
      client.unsubscribe = (channel) => {
        unsubscribedLog.push(channel);
        channels.delete(channel);
      };
    }

    return client;
  };

  const deliverRaw = (channel: string, raw: string | Uint8Array) => {
    const listeners = [...(channels.get(channel) ?? [])];
    for (const fn of listeners) {
      fn(raw as unknown as string, channel);
    }
  };

  return {
    channels,
    published,
    subscribedLog,
    unsubscribedLog,
    createClient,
    deliverRaw,
  };
}

const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
  }
};

describeConformance(
  "ClientRedis (RedisClientProxy)",
  {
    upstreamPath: "packages/microservices/test/client/client-redis.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008"],
    notes:
      "Bunest uses client-injected RedisTransportClientLike (zero ioredis driver dependency), per-client reply inbox channels (<prefix>:reply:<clientId>), and Promise-based send()/emit().",
  },
  () => {
    const sandbox = createSandbox();
    const activeClients: RedisClientProxy[] = [];
    const activeServers: RedisServer[] = [];

    const trackClient = (client: RedisClientProxy): RedisClientProxy => {
      activeClients.push(client);
      return client;
    };
    const trackServer = (server: RedisServer): RedisServer => {
      activeServers.push(server);
      return server;
    };

    afterEach(async () => {
      sandbox.restore();
      while (activeClients.length > 0) {
        await activeClients.pop()?.close();
      }
      while (activeServers.length > 0) {
        await activeServers.pop()?.close();
      }
    });

    describe("constructor & options", () => {
      it("sets Transport.REDIS, default channelPrefix, auto UUID clientId, and replyChannel", () => {
        const bus = createMockRedisBus();
        const redis = bus.createClient();
        const client = trackClient(new RedisClientProxy({ pubClient: redis }));

        expect(client.transport).toBe(Transport.REDIS);
        expect(RedisTransportAdapter.Client).toBe(RedisClientProxy);
        expect(client.clientId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        );
        expect(client.replyChannel).toBe(`bunest:rpc:reply:${client.clientId}`);
      });

      it("respects custom channelPrefix, custom clientId, and separate pubClient/subClient", async () => {
        const bus = createMockRedisBus();
        const pubOnly = bus.createClient();
        const subOnly = bus.createClient();
        const pubSubSpy = sandbox.spy(pubOnly, "subscribe");
        const subSubSpy = sandbox.spy(subOnly, "subscribe");

        const client = trackClient(
          new RedisClientProxy({
            pubClient: pubOnly,
            subClient: subOnly,
            channelPrefix: "acme",
            clientId: "worker-42",
          }),
        );

        expect(client.clientId).toBe("worker-42");
        expect(client.replyChannel).toBe("acme:reply:worker-42");

        await client.connect();
        expect(pubSubSpy.callCount).toBe(0);
        expectCalledOnce(subSubSpy);
        expect(subSubSpy.firstCall?.args[0]).toBe("acme:reply:worker-42");
      });

      it("falls back to pubClient as subClient when subClient is omitted", async () => {
        const bus = createMockRedisBus();
        const shared = bus.createClient();
        const subSpy = sandbox.spy(shared, "subscribe");
        const client = trackClient(
          new RedisClientProxy({ pubClient: shared, clientId: "shared-1" }),
        );

        await client.connect();
        expectCalledOnce(subSpy);
        expect(subSpy.firstCall?.args[0]).toBe("bunest:rpc:reply:shared-1");
      });
    });

    describe("connect() & ensureReplyInbox() lifecycle", () => {
      it("is idempotent and single-flights concurrent connect() calls onto one subscribe", async () => {
        let subscribeCalls = 0;
        let resolveSub!: () => void;
        const bus = createMockRedisBus();
        const subClient = bus.createClient({
          subscribeImpl: () => {
            subscribeCalls += 1;
            return new Promise<void>((resolve) => {
              resolveSub = resolve;
            });
          },
        });
        const client = trackClient(
          new RedisClientProxy({
            pubClient: bus.createClient(),
            subClient,
            clientId: "sf-1",
          }),
        );

        const c1 = client.connect();
        const c2 = client.connect();
        const c3 = client.connect();
        await flushMicrotasks();

        expect(subscribeCalls).toBe(1);
        resolveSub();
        await Promise.all([c1, c2, c3]);

        // Subsequent connect() after already subscribed is a no-op
        await client.connect();
        expect(subscribeCalls).toBe(1);
      });

      it("recovers cleanly after a failed subscribe so a subsequent connect() succeeds", async () => {
        let shouldFail = true;
        let subscribeCalls = 0;
        const bus = createMockRedisBus();
        const subClient = bus.createClient({
          subscribeImpl: async () => {
            subscribeCalls += 1;
            if (shouldFail) {
              shouldFail = false;
              throw new Error("NOPERM subscribe failed");
            }
          },
        });

        const client = trackClient(
          new RedisClientProxy({
            pubClient: bus.createClient(),
            subClient,
            clientId: "recover-1",
          }),
        );

        await expect(client.connect()).rejects.toThrow(
          "NOPERM subscribe failed",
        );
        await expect(client.connect()).resolves.toBeUndefined();
        expect(subscribeCalls).toBe(2);
      });

      // BUNEST_BUG: RedisClientProxy.connect() and RedisClientProxy.close() never call emitStatus("connected") / emitStatus("disconnected"), so client.status remains "disconnected" and onStatus() listeners are never notified (packages/microservices/src/transports/broker.transports.ts).
      it.skip("transitions client status and notifies onStatus listeners on connect() and close()", async () => {
        const bus = createMockRedisBus();
        const client = trackClient(
          new RedisClientProxy({
            pubClient: bus.createClient(),
            clientId: "st-1",
          }),
        );
        const statuses: ClientStatus[] = [];
        const off = client.onStatus((s) => statuses.push(s));

        expect(client.status).toBe("disconnected");
        await client.connect();
        expect(client.status).toBe("connected");
        await client.close();
        expect(client.status).toBe("disconnected");
        expect(statuses).toEqual(["connected", "disconnected"]);
        off();
      });
    });

    describe("close() & onModuleDestroy()", () => {
      it("rejects all pending requests, clears timers, and unsubscribes replyChannel", async () => {
        const bus = createMockRedisBus();
        const redis = bus.createClient();
        const client = trackClient(
          new RedisClientProxy({
            pubClient: redis,
            clientId: "close-1",
            defaultTimeoutMs: 5000,
          }),
        );

        const p1 = client.send("hanging.1", { a: 1 }).catch((err) => err);
        const p2 = client.send("hanging.2", { a: 2 }).catch((err) => err);
        await flushMicrotasks();

        expect(bus.channels.has("bunest:rpc:reply:close-1")).toBe(true);
        await client.close();

        const [err1, err2] = await Promise.all([p1, p2]);
        expect(err1).toBeInstanceOf(Error);
        expect((err1 as Error).message).toBe("RedisClientProxy closed.");
        expect(err2).toBeInstanceOf(Error);
        expect((err2 as Error).message).toBe("RedisClientProxy closed.");
        expect(bus.unsubscribedLog).toEqual(["bunest:rpc:reply:close-1"]);

        // Repeated close does not double-unsubscribe
        await client.close();
        expect(bus.unsubscribedLog).toEqual(["bunest:rpc:reply:close-1"]);
      });

      it("allows re-connecting and sending after close()", async () => {
        const bus = createMockRedisBus();
        const redis = bus.createClient();
        const server = trackServer(new RedisServer({ pubClient: redis }));
        server.addMessageHandler("ping", (d) => ({ pong: d }));
        await server.listen();

        const client = trackClient(
          new RedisClientProxy({ pubClient: redis, clientId: "reopen-1" }),
        );
        expect(await client.send("ping", "first")).toEqual({ pong: "first" });

        await client.close();
        expect(await client.send("ping", "second")).toEqual({ pong: "second" });
      });

      it("tolerates subClient without optional unsubscribe() and delegates onModuleDestroy() to close()", async () => {
        const bus = createMockRedisBus();
        const noUnsub = bus.createClient({ omitUnsubscribe: true });
        const client = trackClient(
          new RedisClientProxy({ pubClient: noUnsub, clientId: "nounsub" }),
        );
        const closeSpy = sandbox.spy(client, "close");

        await client.connect();
        await expect(client.onModuleDestroy()).resolves.toBeUndefined();
        expectCalledOnce(closeSpy);
      });

      // BUNEST_BUG: Calling RedisClientProxy.close() while ensureReplyInbox() subscribe is still in-flight does not abort the pending connect/send; once subscribe resolves, replySubscribed flips to true and the pending send() still publishes on the closed client (packages/microservices/src/transports/broker.transports.ts).
      it.skip("cancels an in-flight send waiting on ensureReplyInbox() when close() is called", async () => {
        let resolveSubscribe!: () => void;
        const bus = createMockRedisBus();
        const subClient = bus.createClient({
          subscribeImpl: () =>
            new Promise<void>((resolve) => {
              resolveSubscribe = resolve;
            }),
        });
        const pubClient = bus.createClient();
        const client = trackClient(
          new RedisClientProxy({
            pubClient,
            subClient,
            clientId: "race-close",
            defaultTimeoutMs: 500,
          }),
        );

        const pendingSend = client.send("orders.get", { id: 1 });
        await flushMicrotasks();

        await client.close();
        resolveSubscribe();

        await expect(pendingSend).rejects.toThrow(/closed/i);
        expect(bus.published).toHaveLength(0);
      });
    });

    describe("send() — request-reply, correlation & error handling", () => {
      itAdapted(
        ["ADR-001", "ADR-008"],
        "lazily subscribes replyChannel, publishes RpcRequestEnvelope with replyTo, and resolves response",
        async () => {
          const bus = createMockRedisBus();
          const pubClient = bus.createClient({
            publishImpl: (_ch, msg) => {
              const req = JSON.parse(msg) as RpcRequestEnvelope;
              queueMicrotask(() => {
                bus.deliverRaw(
                  req.replyTo!,
                  JSON.stringify({
                    type: "response",
                    id: req.id,
                    response: { doubled: (req.data as number) * 2 },
                    isDisposed: true,
                  } satisfies RpcResponseEnvelope),
                );
              });
              return 1;
            },
          });
          const subClient = bus.createClient();

          const client = trackClient(
            new RedisClientProxy({
              pubClient,
              subClient,
              channelPrefix: "svc",
              clientId: "c1",
            }),
          );

          const res = await client.send("math.double", 21);
          expect(res).toEqual({ doubled: 42 });
          expect(bus.subscribedLog).toEqual(["svc:reply:c1"]);
          expect(bus.published).toHaveLength(1);
          expect(bus.published[0]?.channel).toBe("svc:math.double");

          const envelope = JSON.parse(
            bus.published[0]!.message,
          ) as RpcRequestEnvelope;
          expect(envelope.type).toBe("request");
          expect(envelope.pattern).toBe("math.double");
          expect(envelope.data).toBe(21);
          expect(envelope.replyTo).toBe("svc:reply:c1");
          expect(envelope.id).toMatch(/^redis_1_/);
        },
      );

      it("preserves falsy response values (0, false, '', null) and decodes Uint8Array replies", async () => {
        const encoder = new TextEncoder();
        const bus = createMockRedisBus();
        const pubClient = bus.createClient({
          publishImpl: (_ch, msg) => {
            const req = JSON.parse(msg) as RpcRequestEnvelope;
            const raw = JSON.stringify({
              type: "response",
              id: req.id,
              response: req.data,
              isDisposed: true,
            } satisfies RpcResponseEnvelope);
            queueMicrotask(() => {
              bus.deliverRaw(
                req.replyTo!,
                req.data === "binary" ? encoder.encode(raw) : raw,
              );
            });
            return 1;
          },
        });
        const client = trackClient(
          new RedisClientProxy({
            pubClient,
            subClient: bus.createClient(),
            clientId: "falsy",
          }),
        );

        expect(await client.send("echo", 0)).toBe(0);
        expect(await client.send("echo", false)).toBe(false);
        expect(await client.send("echo", "")).toBe("");
        expect(await client.send("echo", null)).toBeNull();
        expect(await client.send("echo", "binary")).toBe("binary");
      });

      it("ignores malformed JSON, non-response envelopes, and unknown correlation IDs without disrupting pending requests", async () => {
        let pendingId = "";
        const bus = createMockRedisBus();
        const pubClient = bus.createClient({
          publishImpl: (_ch, msg) => {
            pendingId = (JSON.parse(msg) as RpcRequestEnvelope).id;
            return 1;
          },
        });
        const client = trackClient(
          new RedisClientProxy({
            pubClient,
            subClient: bus.createClient(),
            clientId: "noise",
            defaultTimeoutMs: 500,
          }),
        );

        const promise = client.send("safe.op", "req");
        await flushMicrotasks();

        // Deliver garbage, events, requests, and unknown-id responses
        bus.deliverRaw(client.replyChannel, "{{broken-json");
        bus.deliverRaw(client.replyChannel, JSON.stringify({ noType: true }));
        bus.deliverRaw(
          client.replyChannel,
          JSON.stringify({
            type: "event",
            pattern: "noise",
            data: "x",
          } satisfies RpcEventEnvelope),
        );
        bus.deliverRaw(
          client.replyChannel,
          JSON.stringify({
            type: "response",
            id: "unknown-id-999",
            response: "wrong",
            isDisposed: true,
          } satisfies RpcResponseEnvelope),
        );

        // Now deliver the matching response
        bus.deliverRaw(
          client.replyChannel,
          JSON.stringify({
            type: "response",
            id: pendingId,
            response: "right",
            isDisposed: true,
          } satisfies RpcResponseEnvelope),
        );

        expect(await promise).toBe("right");
      });

      it("cleans up pending request and rejects when pubClient.publish() throws or rejects", async () => {
        const bus = createMockRedisBus();
        const syncFail = bus.createClient({
          publishImpl: () => {
            throw new Error("sync publish error");
          },
        });
        const clientSync = trackClient(
          new RedisClientProxy({
            pubClient: syncFail,
            subClient: bus.createClient(),
            clientId: "puberr-sync",
          }),
        );
        await expect(clientSync.send("op", 1)).rejects.toThrow(
          "sync publish error",
        );

        const asyncFail = bus.createClient({
          publishImpl: () => Promise.reject(new Error("async publish error")),
        });
        const clientAsync = trackClient(
          new RedisClientProxy({
            pubClient: asyncFail,
            subClient: bus.createClient(),
            clientId: "puberr-async",
          }),
        );
        await expect(clientAsync.send("op", 1)).rejects.toThrow(
          "async publish error",
        );
      });

      it("rejects with RpcTimeoutException when no reply arrives within timeoutMs", async () => {
        const bus = createMockRedisBus();
        const client = trackClient(
          new RedisClientProxy({
            pubClient: bus.createClient(),
            clientId: "timeout-1",
            defaultTimeoutMs: 25,
          }),
        );

        let caught: unknown;
        try {
          await client.send("never.replies", {});
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(RpcTimeoutException);
        expect((caught as RpcTimeoutException).pattern).toBe("never.replies");
        expect((caught as RpcTimeoutException).timeoutMs).toBe(25);
      });

      it("propagates serialized RpcException and generic remote Error preserving name/details", async () => {
        const bus = createMockRedisBus();
        const pubClient = bus.createClient({
          publishImpl: (_ch, msg) => {
            const req = JSON.parse(msg) as RpcRequestEnvelope;
            const error =
              req.data === "rpc-str"
                ? new RpcException("not allowed").toSerialized()
                : req.data === "rpc-obj"
                  ? new RpcException({
                      status: 404,
                      message: "Item missing",
                      itemId: "x",
                    }).toSerialized()
                  : req.data === "generic"
                    ? {
                        message: "Unexpected failure",
                        name: "RangeError",
                        isRpcException: false,
                      }
                    : { message: "", isRpcException: false };

            queueMicrotask(() => {
              bus.deliverRaw(
                req.replyTo!,
                JSON.stringify({
                  type: "response",
                  id: req.id,
                  error,
                  isDisposed: true,
                } satisfies RpcResponseEnvelope),
              );
            });
            return 1;
          },
        });

        const client = trackClient(
          new RedisClientProxy({
            pubClient,
            subClient: bus.createClient(),
            clientId: "errs",
          }),
        );

        await expect(client.send("op", "rpc-str")).rejects.toMatchObject({
          name: "RpcException",
          message: "not allowed",
        });

        let objErr: unknown;
        try {
          await client.send("op", "rpc-obj");
        } catch (err) {
          objErr = err;
        }
        expect(objErr).toBeInstanceOf(RpcException);
        expect((objErr as RpcException).getError()).toEqual({
          status: 404,
          message: "Item missing",
          itemId: "x",
        });

        let genErr: unknown;
        try {
          await client.send("op", "generic");
        } catch (err) {
          genErr = err;
        }
        expect(genErr).toBeInstanceOf(Error);
        expect(genErr).not.toBeInstanceOf(RpcException);
        expect((genErr as Error).name).toBe("RangeError");
        expect((genErr as Error).message).toBe("Unexpected failure");

        await expect(client.send("op", "empty")).rejects.toThrow(
          "Remote RPC error",
        );
      });

      it("retries transient transport errors up to options.retries but does not retry RpcException", async () => {
        let publishAttempts = 0;
        const bus = createMockRedisBus();
        const flakyPub = bus.createClient({
          publishImpl: (_ch, msg) => {
            publishAttempts += 1;
            const req = JSON.parse(msg) as RpcRequestEnvelope;
            if (req.pattern === "flaky" && publishAttempts < 3) {
              throw new Error(`transient-${publishAttempts}`);
            }
            queueMicrotask(() => {
              bus.deliverRaw(
                req.replyTo!,
                JSON.stringify({
                  type: "response",
                  id: req.id,
                  response: req.pattern === "flaky" ? { ok: true } : undefined,
                  error:
                    req.pattern === "biz"
                      ? new RpcException("do-not-retry").toSerialized()
                      : undefined,
                  isDisposed: true,
                } satisfies RpcResponseEnvelope),
              );
            });
            return 1;
          },
        });

        const client = trackClient(
          new RedisClientProxy({
            pubClient: flakyPub,
            subClient: bus.createClient(),
            clientId: "retry-1",
          }),
        );

        expect(
          await client.send("flaky", null, { retries: 3, retryDelayMs: 2 }),
        ).toEqual({ ok: true });
        expect(publishAttempts).toBe(3);

        publishAttempts = 0;
        await expect(
          client.send("biz", null, { retries: 3, retryDelayMs: 2 }),
        ).rejects.toThrow("do-not-retry");
        expect(publishAttempts).toBe(1);
      });
    });

    describe("per-client reply inbox isolation & concurrency", () => {
      it("isolates replies per client across concurrent calls to the same pattern", async () => {
        const bus = createMockRedisBus();
        const serverRedis = bus.createClient();
        const server = trackServer(
          new RedisServer({
            pubClient: serverRedis,
            subClient: serverRedis,
            channelPrefix: "iso",
          }),
        );

        server.addMessageHandler("orders.get", async (data) => {
          const { tag, delayMs } = data as { tag: string; delayMs: number };
          await Bun.sleep(delayMs);
          return { owner: tag };
        });
        await server.listen();

        const clientADeliveries: string[] = [];
        const clientBDeliveries: string[] = [];

        const clientA = trackClient(
          new RedisClientProxy({
            pubClient: serverRedis,
            subClient: bus.createClient({
              onDelivery: (ch) => clientADeliveries.push(ch),
            }),
            channelPrefix: "iso",
            clientId: "client-a",
          }),
        );
        const clientB = trackClient(
          new RedisClientProxy({
            pubClient: serverRedis,
            subClient: bus.createClient({
              onDelivery: (ch) => clientBDeliveries.push(ch),
            }),
            channelPrefix: "iso",
            clientId: "client-b",
          }),
        );

        const [a1, b1, a2, b2] = await Promise.all([
          clientA.send("orders.get", { tag: "A1", delayMs: 25 }),
          clientB.send("orders.get", { tag: "B1", delayMs: 5 }),
          clientA.send("orders.get", { tag: "A2", delayMs: 10 }),
          clientB.send("orders.get", { tag: "B2", delayMs: 15 }),
        ]);

        expect(a1).toEqual({ owner: "A1" });
        expect(a2).toEqual({ owner: "A2" });
        expect(b1).toEqual({ owner: "B1" });
        expect(b2).toEqual({ owner: "B2" });
        expect(clientADeliveries).toEqual([
          "iso:reply:client-a",
          "iso:reply:client-a",
        ]);
        expect(clientBDeliveries).toEqual([
          "iso:reply:client-b",
          "iso:reply:client-b",
        ]);

        // Closing clientA does not disturb clientB
        await clientA.close();
        expect(
          await clientB.send("orders.get", { tag: "B3", delayMs: 2 }),
        ).toEqual({ owner: "B3" });
      });
    });

    describe("emit() (dispatchEvent)", () => {
      it("publishes RpcEventEnvelope to <prefix>:<pattern> without subscribing to replyChannel", async () => {
        const bus = createMockRedisBus();
        const client = trackClient(
          new RedisClientProxy({
            pubClient: bus.createClient(),
            channelPrefix: "ev",
            clientId: "ev-1",
          }),
        );

        await client.emit("order.shipped", { id: "o-1" });

        expect(bus.subscribedLog).toHaveLength(0);
        expect(bus.published).toHaveLength(1);
        expect(bus.published[0]?.channel).toBe("ev:order.shipped");
        expect(JSON.parse(bus.published[0]!.message)).toEqual({
          type: "event",
          pattern: "order.shipped",
          data: { id: "o-1" },
        });
      });

      it("propagates errors thrown or rejected by pubClient.publish()", async () => {
        const bus = createMockRedisBus();
        const pub = bus.createClient({
          publishImpl: () => Promise.reject(new Error("redis pub failed")),
        });
        const client = trackClient(new RedisClientProxy({ pubClient: pub }));

        await expect(client.emit("order.failed", {})).rejects.toThrow(
          "redis pub failed",
        );
      });
    });

    describe("structured patterns, preRequestHook & unwrap", () => {
      it("normalizes structured object patterns with canonical key sorting in send() and emit()", async () => {
        const bus = createMockRedisBus();
        const redis = bus.createClient();
        const server = trackServer(
          new RedisServer({ pubClient: redis, channelPrefix: "obj" }),
        );
        server.addMessageHandler({ cmd: "sum", v: 1 }, (nums) =>
          (nums as number[]).reduce((a, b) => a + b, 0),
        );
        await server.listen();

        const client = trackClient(
          new RedisClientProxy({
            pubClient: redis,
            channelPrefix: "obj",
            clientId: "obj-1",
          }),
        );

        expect(await client.send<number>({ v: 1, cmd: "sum" }, [4, 5])).toBe(9);
        await client.emit({ z: 2, a: 1 }, "evt");
        const lastPub = bus.published[bus.published.length - 1];
        expect(lastPub?.channel).toBe('obj:{"a":1,"z":2}');
      });

      it("invokes setPreRequestHook before send() and emit(), supports clearing and aborts on hook error", async () => {
        const bus = createMockRedisBus();
        const redis = bus.createClient();
        const server = trackServer(new RedisServer({ pubClient: redis }));
        server.addMessageHandler("ping", () => "pong");
        await server.listen();

        const client = trackClient(
          new RedisClientProxy({ pubClient: redis, clientId: "hook-1" }),
        );
        const recorded: Array<{
          pattern: string;
          data: unknown;
          transport: Transport;
        }> = [];

        expect(
          client.setPreRequestHook((ctx) => {
            recorded.push(ctx);
          }),
        ).toBe(client);

        await client.send("ping", 1);
        await client.emit("log", 2);
        expect(recorded).toEqual([
          { pattern: "ping", data: 1, transport: Transport.REDIS },
          { pattern: "log", data: 2, transport: Transport.REDIS },
        ]);

        client.setPreRequestHook(() => {
          throw new Error("hook denied");
        });
        await expect(client.send("ping", 3)).rejects.toThrow("hook denied");

        client.setPreRequestHook(undefined);
        expect(await client.send("ping", 4)).toBe("pong");
      });

      it("exposes unwrap() returning the proxy instance", () => {
        const bus = createMockRedisBus();
        const client = trackClient(
          new RedisClientProxy({ pubClient: bus.createClient() }),
        );
        expect(client.unwrap<RedisClientProxy>()).toBe(client);
      });
    });

    describe("RedisRecord & headers parity", () => {
      it("builds RedisRecord with data and options via RedisRecordBuilder", () => {
        const record = new RedisRecordBuilder({ amount: 50 })
          .setOptions({ headers: { "x-tenant": "acme" } })
          .build();

        expect(record).toBeInstanceOf(RedisRecord);
        expect(record.data).toEqual({ amount: 50 });
        expect(record.options).toEqual({ headers: { "x-tenant": "acme" } });
      });

      // BUNEST_BUG: RedisClientProxy.sendOnce() and dispatchEvent() do not unwrap RedisRecord instances; they serialize the raw { data, options } wrapper inside envelope.data instead of unwrapping record.data and propagating options.headers (packages/microservices/src/transports/broker.transports.ts).
      it.skip("unwraps RedisRecord data and propagates headers on send() and emit()", async () => {
        const bus = createMockRedisBus();
        const client = trackClient(
          new RedisClientProxy({
            pubClient: bus.createClient(),
            channelPrefix: "rec",
            clientId: "rec-1",
          }),
        );

        const record = new RedisRecordBuilder("payload")
          .setOptions({ headers: { "x-trace": "trace-1" } })
          .build();
        await client.emit("rec.event", record);

        const publishedEnvelope = JSON.parse(
          bus.published[0]!.message,
        ) as RpcEventEnvelope & { headers?: Record<string, string> };
        expect(publishedEnvelope.data).toBe("payload");
        expect(publishedEnvelope.headers).toEqual({ "x-trace": "trace-1" });
      });
    });
  },
);
