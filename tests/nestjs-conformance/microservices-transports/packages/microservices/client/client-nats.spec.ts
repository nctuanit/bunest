import "reflect-metadata";
import { afterEach, describe, expect, it } from "bun:test";
import {
  createSandbox,
  describeConformance,
  expectCalledOnce,
  itAdapted,
} from "../../../../_helpers";
import {
  NatsClientProxy,
  NatsRecord,
  NatsRecordBuilder,
  NatsTransportAdapter,
  RpcException,
  RpcTimeoutException,
  Transport,
  type ClientStatus,
  type NatsMessageLike,
  type NatsSubscriptionLike,
  type NatsTransportClientLike,
  type RpcEventEnvelope,
  type RpcRequestEnvelope,
  type RpcResponseEnvelope,
} from "../../../../../../packages/microservices/src";

interface RecordedPublish {
  readonly subject: string;
  readonly data: string | Uint8Array;
  readonly options?: { reply?: string };
}

interface RecordedRequest {
  readonly subject: string;
  readonly data: string | Uint8Array;
  readonly options?: { timeout?: number };
}

interface ActiveSubscription {
  readonly subject: string;
  readonly handler: (msg: NatsMessageLike) => Promise<void> | void;
  unsubscribed: boolean;
  unsubscribeCount: number;
}

function createMockNatsClient(config?: {
  withNativeRequest?: boolean;
  requestImpl?: (
    subject: string,
    data: string | Uint8Array,
    options?: { timeout?: number },
  ) => Promise<NatsMessageLike>;
  publishImpl?: (
    subject: string,
    data: string | Uint8Array,
    options?: { reply?: string },
  ) => Promise<void> | void;
  subscribeImpl?: (
    subject: string,
    handler: (msg: NatsMessageLike) => Promise<void> | void,
  ) => Promise<NatsSubscriptionLike | void> | NatsSubscriptionLike | void;
}) {
  const published: RecordedPublish[] = [];
  const requests: RecordedRequest[] = [];
  const subscriptions: ActiveSubscription[] = [];
  const subsBySubject = new Map<string, Set<ActiveSubscription>>();

  const client: NatsTransportClientLike = {
    publish(subject, data, options) {
      published.push({ subject, data, options });
      if (config?.publishImpl) {
        return config.publishImpl(subject, data, options);
      }
    },
    subscribe(subject, handler) {
      if (config?.subscribeImpl) {
        return config.subscribeImpl(subject, handler);
      }
      const record: ActiveSubscription = {
        subject,
        handler,
        unsubscribed: false,
        unsubscribeCount: 0,
      };
      subscriptions.push(record);
      let set = subsBySubject.get(subject);
      if (!set) {
        set = new Set();
        subsBySubject.set(subject, set);
      }
      set.add(record);
      return {
        unsubscribe() {
          record.unsubscribed = true;
          record.unsubscribeCount += 1;
          set?.delete(record);
        },
      };
    },
  };

  if (config?.withNativeRequest || config?.requestImpl) {
    client.request = async (subject, data, options) => {
      requests.push({ subject, data, options });
      if (config?.requestImpl) {
        return await config.requestImpl(subject, data, options);
      }
      const parsed = JSON.parse(String(data)) as RpcRequestEnvelope;
      return {
        subject: `_INBOX.reply.${parsed.id}`,
        data: JSON.stringify({
          type: "response",
          id: parsed.id,
          response: { ok: true, echo: parsed.data },
          isDisposed: true,
        } satisfies RpcResponseEnvelope),
      };
    };
  }

  const deliver = async (subject: string, data: string | Uint8Array) => {
    const targets = [...(subsBySubject.get(subject) ?? [])];
    for (const sub of targets) {
      await sub.handler({ subject, data });
    }
  };

  return {
    client,
    published,
    requests,
    subscriptions,
    deliver,
  };
}

const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
  }
};

describeConformance(
  "ClientNats (NatsClientProxy)",
  {
    upstreamPath: "packages/microservices/test/client/client-nats.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008"],
    notes:
      "Bunest uses client-injected NatsTransportClientLike (zero @nats-io/transport-node driver dependency) and Promise-based send()/emit() instead of RxJS Observables.",
  },
  () => {
    const sandbox = createSandbox();
    const activeClients: NatsClientProxy[] = [];

    const track = (client: NatsClientProxy): NatsClientProxy => {
      activeClients.push(client);
      return client;
    };

    afterEach(async () => {
      sandbox.restore();
      while (activeClients.length > 0) {
        const c = activeClients.pop();
        await c?.close();
      }
    });

    describe("constructor & options", () => {
      it("exposes Transport.NATS and matches NatsTransportAdapter.Client", () => {
        const mock = createMockNatsClient();
        const client = track(new NatsClientProxy({ client: mock.client }));

        expect(client.transport).toBe(Transport.NATS);
        expect(NatsTransportAdapter.Client).toBe(NatsClientProxy);
      });

      it("uses unprefixed subjects by default and prefixes with '.' when subjectPrefix is set", async () => {
        const plainMock = createMockNatsClient({ withNativeRequest: true });
        const prefixedMock = createMockNatsClient({ withNativeRequest: true });

        const plainClient = track(
          new NatsClientProxy({ client: plainMock.client }),
        );
        const prefixedClient = track(
          new NatsClientProxy({
            client: prefixedMock.client,
            subjectPrefix: "svc.orders",
          }),
        );

        await plainClient.send("math.sum", [1, 2]);
        await prefixedClient.send("math.sum", [1, 2]);

        expect(plainMock.requests[0]?.subject).toBe("math.sum");
        expect(prefixedMock.requests[0]?.subject).toBe("svc.orders.math.sum");
      });

      it("respects defaultTimeoutMs and floors/clamps values via ClientProxy", async () => {
        const mock = createMockNatsClient({ withNativeRequest: true });
        const client = track(
          new NatsClientProxy({
            client: mock.client,
            defaultTimeoutMs: 1234.9,
          }),
        );

        await client.send("ping", "hello");
        expect(mock.requests[0]?.options?.timeout).toBe(1234);

        const clampedMock = createMockNatsClient({ withNativeRequest: true });
        const clampedClient = track(
          new NatsClientProxy({
            client: clampedMock.client,
            defaultTimeoutMs: 0,
          }),
        );
        await clampedClient.send("ping", "hello");
        expect(clampedMock.requests[0]?.options?.timeout).toBe(1);
      });
    });

    describe("connect & close", () => {
      it("resolves connect() and close() idempotently", async () => {
        const mock = createMockNatsClient();
        const client = track(new NatsClientProxy({ client: mock.client }));

        await expect(client.connect()).resolves.toBeUndefined();
        await expect(client.connect()).resolves.toBeUndefined();
        await expect(client.close()).resolves.toBeUndefined();
        await expect(client.close()).resolves.toBeUndefined();
      });

      it("delegates onModuleDestroy() to close()", async () => {
        const mock = createMockNatsClient();
        const client = track(new NatsClientProxy({ client: mock.client }));
        const closeSpy = sandbox.spy(client, "close");

        await client.onModuleDestroy();
        expectCalledOnce(closeSpy);
      });

      // BUNEST_BUG: NatsClientProxy.connect() and NatsClientProxy.close() are empty no-ops and never call emitStatus("connected") / emitStatus("disconnected"), so client.status stays "disconnected" and onStatus() listeners never fire (packages/microservices/src/transports/broker.transports.ts).
      it.skip("transitions client status and notifies onStatus listeners on connect() and close()", async () => {
        const mock = createMockNatsClient();
        const client = track(new NatsClientProxy({ client: mock.client }));
        const statuses: ClientStatus[] = [];
        const unsubscribe = client.onStatus((status) => statuses.push(status));

        expect(client.status).toBe("disconnected");
        await client.connect();
        expect(client.status).toBe("connected");

        await client.close();
        expect(client.status).toBe("disconnected");
        expect(statuses).toEqual(["connected", "disconnected"]);
        unsubscribe();
      });

      // BUNEST_BUG: NatsClientProxy.close() is an empty no-op and does not track, cancel/reject pending fallback _INBOX.* requests, clear their timers, or unsubscribe their inbox subscriptions (packages/microservices/src/transports/broker.transports.ts).
      it.skip("rejects pending fallback inbox requests and unsubscribes their inboxes on close()", async () => {
        const mock = createMockNatsClient({ withNativeRequest: false });
        const client = track(
          new NatsClientProxy({ client: mock.client, defaultTimeoutMs: 5000 }),
        );

        const pending = client.send("slow.op", { a: 1 });
        await flushMicrotasks();
        expect(mock.subscriptions).toHaveLength(1);

        await client.close();

        await expect(pending).rejects.toThrow(/closed/i);
        expect(mock.subscriptions[0]?.unsubscribed).toBe(true);
      });
    });

    describe("send() via native client.request() path", () => {
      itAdapted(
        ["ADR-001", "ADR-008"],
        "sends RpcRequestEnvelope, passes timeout, and resolves response payload",
        async () => {
          const mock = createMockNatsClient({
            requestImpl: async (subject, data, options) => {
              const envelope = JSON.parse(String(data)) as RpcRequestEnvelope;
              expect(subject).toBe("svc.orders.get");
              expect(envelope.type).toBe("request");
              expect(envelope.pattern).toBe("orders.get");
              expect(envelope.data).toEqual({ id: 42 });
              expect(envelope.id).toMatch(/^nats_\d+_/);
              expect(options).toEqual({ timeout: 250 });

              return {
                subject: `_INBOX.${envelope.id}`,
                data: JSON.stringify({
                  type: "response",
                  id: envelope.id,
                  response: { id: 42, total: 99 },
                  isDisposed: true,
                } satisfies RpcResponseEnvelope),
              };
            },
          });

          const client = track(
            new NatsClientProxy({
              client: mock.client,
              subjectPrefix: "svc",
              defaultTimeoutMs: 1000,
            }),
          );

          const res = await client.send(
            "orders.get",
            { id: 42 },
            { timeoutMs: 250 },
          );
          expect(res).toEqual({ id: 42, total: 99 });
          expect(mock.requests).toHaveLength(1);
        },
      );

      it("decodes Uint8Array reply payloads as UTF-8 JSON", async () => {
        const encoder = new TextEncoder();
        const mock = createMockNatsClient({
          requestImpl: async (_subject, data) => {
            const req = JSON.parse(String(data)) as RpcRequestEnvelope;
            return {
              subject: "_INBOX.bin",
              data: encoder.encode(
                JSON.stringify({
                  type: "response",
                  id: req.id,
                  response: { text: "héllo-nats" },
                  isDisposed: true,
                } satisfies RpcResponseEnvelope),
              ),
            };
          },
        });

        const client = track(new NatsClientProxy({ client: mock.client }));
        expect(await client.send("utf8.echo", null)).toEqual({
          text: "héllo-nats",
        });
      });

      it("rejects with malformed response error when reply JSON is invalid", async () => {
        const mock = createMockNatsClient({
          requestImpl: async () => ({
            subject: "_INBOX.bad",
            data: "{not-valid-json",
          }),
        });
        const client = track(new NatsClientProxy({ client: mock.client }));

        await expect(client.send("bad.json", {})).rejects.toThrow(
          "Received malformed NATS RPC response.",
        );
      });

      it("rejects with malformed response error when reply envelope is not type 'response'", async () => {
        const mock = createMockNatsClient({
          requestImpl: async () => ({
            subject: "_INBOX.wrongtype",
            data: JSON.stringify({
              type: "event",
              pattern: "bad.type",
              data: "x",
            }),
          }),
        });
        const client = track(new NatsClientProxy({ client: mock.client }));

        await expect(client.send("bad.type", {})).rejects.toThrow(
          "Received malformed NATS RPC response.",
        );
      });

      it("propagates serialized RpcException (string and object payloads)", async () => {
        const mock = createMockNatsClient({
          requestImpl: async (_subject, data) => {
            const req = JSON.parse(String(data)) as RpcRequestEnvelope;
            const rpcErr =
              req.data === "string"
                ? new RpcException("invalid input")
                : new RpcException({
                    status: 422,
                    message: "Validation error",
                    code: "E_INVALID",
                  });
            return {
              subject: "_INBOX.err",
              data: JSON.stringify({
                type: "response",
                id: req.id,
                error: rpcErr.toSerialized(),
                isDisposed: true,
              } satisfies RpcResponseEnvelope),
            };
          },
        });

        const client = track(new NatsClientProxy({ client: mock.client }));

        let stringErr: unknown;
        try {
          await client.send("op", "string");
        } catch (err) {
          stringErr = err;
        }
        expect(stringErr).toBeInstanceOf(RpcException);
        expect((stringErr as RpcException).getError()).toBe("invalid input");

        let objErr: unknown;
        try {
          await client.send("op", "object");
        } catch (err) {
          objErr = err;
        }
        expect(objErr).toBeInstanceOf(RpcException);
        expect((objErr as RpcException).message).toBe("Validation error");
        expect((objErr as RpcException).getError()).toEqual({
          status: 422,
          message: "Validation error",
          code: "E_INVALID",
        });
      });

      it("propagates generic remote Error preserving name and message", async () => {
        const mock = createMockNatsClient({
          requestImpl: async (_subject, data) => {
            const req = JSON.parse(String(data)) as RpcRequestEnvelope;
            return {
              subject: "_INBOX.err",
              data: JSON.stringify({
                type: "response",
                id: req.id,
                error: {
                  message:
                    req.data === "empty" ? "" : "Database connection reset",
                  name: req.data === "empty" ? undefined : "RangeError",
                  isRpcException: false,
                },
                isDisposed: true,
              } satisfies RpcResponseEnvelope),
            };
          },
        });

        const client = track(new NatsClientProxy({ client: mock.client }));

        let caught: unknown;
        try {
          await client.send("op", "named");
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(Error);
        expect(caught).not.toBeInstanceOf(RpcException);
        expect((caught as Error).name).toBe("RangeError");
        expect((caught as Error).message).toBe("Database connection reset");

        await expect(client.send("op", "empty")).rejects.toThrow(
          "Remote RPC error",
        );
      });

      it("rejects with RpcTimeoutException when native client.request() hangs past timeoutMs", async () => {
        const mock = createMockNatsClient({
          requestImpl: () => new Promise<NatsMessageLike>(() => {}),
        });
        const client = track(
          new NatsClientProxy({ client: mock.client, defaultTimeoutMs: 25 }),
        );

        let caught: unknown;
        try {
          await client.send("slow.native", {});
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(RpcTimeoutException);
        expect((caught as RpcTimeoutException).pattern).toBe("slow.native");
        expect((caught as RpcTimeoutException).timeoutMs).toBe(25);
      });
    });

    describe("send() via fallback _INBOX.<id> subscribe+publish path", () => {
      it("subscribes to unique random _INBOX.<id> inboxes and publishes with reply option", async () => {
        const mock = createMockNatsClient({
          publishImpl: (_subject, data, options) => {
            const req = JSON.parse(String(data)) as RpcRequestEnvelope;
            queueMicrotask(() => {
              void mock.deliver(
                options!.reply!,
                JSON.stringify({
                  type: "response",
                  id: req.id,
                  response: req.data,
                  isDisposed: true,
                } satisfies RpcResponseEnvelope),
              );
            });
          },
        });

        const client = track(
          new NatsClientProxy({ client: mock.client, subjectPrefix: "app" }),
        );

        const [first, second] = await Promise.all([
          client.send("echo", "one"),
          client.send("echo", "two"),
        ]);

        expect(first).toBe("one");
        expect(second).toBe("two");
        expect(mock.subscriptions).toHaveLength(2);

        const [inbox1, inbox2] = mock.subscriptions.map((s) => s.subject);
        expect(inbox1).toMatch(/^_INBOX\.nats_1_[0-9a-f]{8}$/);
        expect(inbox2).toMatch(/^_INBOX\.nats_2_[0-9a-f]{8}$/);
        expect(inbox1).not.toBe(inbox2);
        expect(mock.published[0]?.subject).toBe("app.echo");
        expect(mock.published[0]?.options?.reply).toBe(inbox1);
        expect(mock.published[1]?.options?.reply).toBe(inbox2);
        expect(mock.subscriptions[0]?.unsubscribed).toBe(true);
        expect(mock.subscriptions[1]?.unsubscribed).toBe(true);
      });

      it("decodes Uint8Array replies on fallback inbox and handles async subscribe()", async () => {
        const encoder = new TextEncoder();
        const unsubSpy = sandbox.spy();
        const inboxHandlers = new Map<
          string,
          (msg: NatsMessageLike) => Promise<void> | void
        >();

        const clientLike: NatsTransportClientLike = {
          async subscribe(subject, handler) {
            await Promise.resolve();
            inboxHandlers.set(subject, handler);
            return { unsubscribe: unsubSpy };
          },
          publish(_subject, data, options) {
            const req = JSON.parse(String(data)) as RpcRequestEnvelope;
            const handler = inboxHandlers.get(options!.reply!);
            queueMicrotask(() => {
              void handler?.({
                subject: options!.reply!,
                data: encoder.encode(
                  JSON.stringify({
                    type: "response",
                    id: req.id,
                    response: 123,
                    isDisposed: true,
                  } satisfies RpcResponseEnvelope),
                ),
              });
            });
          },
        };

        const client = track(new NatsClientProxy({ client: clientLike }));
        expect(await client.send<number>("compute", { x: 1 })).toBe(123);
        expectCalledOnce(unsubSpy);
      });

      it("ignores malformed JSON and non-response packets on inbox until valid response arrives", async () => {
        let capturedReply = "";
        let capturedId = "";
        const mock = createMockNatsClient({
          publishImpl: (_subject, data, options) => {
            const req = JSON.parse(String(data)) as RpcRequestEnvelope;
            capturedReply = options!.reply!;
            capturedId = req.id;
          },
        });

        const client = track(
          new NatsClientProxy({ client: mock.client, defaultTimeoutMs: 500 }),
        );
        const promise = client.send("resilient", { n: 7 });
        await flushMicrotasks();

        // Noise packets should be ignored without unsubscribing
        await mock.deliver(capturedReply, "{broken-json");
        await mock.deliver(capturedReply, JSON.stringify({ hello: "world" }));
        await mock.deliver(
          capturedReply,
          JSON.stringify({
            type: "event",
            pattern: "noise",
            data: null,
          } satisfies RpcEventEnvelope),
        );
        expect(mock.subscriptions[0]?.unsubscribed).toBe(false);

        // Now deliver the valid response
        await mock.deliver(
          capturedReply,
          JSON.stringify({
            type: "response",
            id: capturedId,
            response: "ok-after-noise",
            isDisposed: true,
          } satisfies RpcResponseEnvelope),
        );

        expect(await promise).toBe("ok-after-noise");
        expect(mock.subscriptions[0]?.unsubscribed).toBe(true);
      });

      it("unsubscribes inbox and rejects when publish throws synchronously or rejects asynchronously", async () => {
        const syncErr = new Error("max_payload size exceeded");
        const syncMock = createMockNatsClient({
          publishImpl: () => {
            throw syncErr;
          },
        });
        const syncClient = track(
          new NatsClientProxy({ client: syncMock.client }),
        );

        await expect(syncClient.send("big", "payload")).rejects.toBe(syncErr);
        expect(syncMock.subscriptions[0]?.unsubscribed).toBe(true);

        const asyncErr = new Error("nats disconnected");
        const asyncMock = createMockNatsClient({
          publishImpl: () => Promise.reject(asyncErr),
        });
        const asyncClient = track(
          new NatsClientProxy({ client: asyncMock.client }),
        );

        await expect(asyncClient.send("big", "payload")).rejects.toBe(asyncErr);
        expect(asyncMock.subscriptions[0]?.unsubscribed).toBe(true);
      });

      it("rejects without publishing when subscribe() fails", async () => {
        const subErr = new Error("subscribe permission denied");
        const mock = createMockNatsClient({
          subscribeImpl: () => Promise.reject(subErr),
        });
        const client = track(new NatsClientProxy({ client: mock.client }));

        await expect(client.send("denied", {})).rejects.toBe(subErr);
        expect(mock.published).toHaveLength(0);
      });

      it("unsubscribes inbox and rejects with RpcTimeoutException when no reply arrives", async () => {
        const mock = createMockNatsClient();
        const client = track(
          new NatsClientProxy({ client: mock.client, defaultTimeoutMs: 25 }),
        );

        let caught: unknown;
        try {
          await client.send("silent.op", {});
        } catch (err) {
          caught = err;
        }

        expect(caught).toBeInstanceOf(RpcTimeoutException);
        expect((caught as RpcTimeoutException).pattern).toBe("silent.op");
        // ClientProxy.runWithTimeout timer fires right before sendOnce's inner timer;
        // yield one tick so sendOnce's timeout handler completes inbox cleanup.
        await Bun.sleep(10);
        expect(mock.subscriptions[0]?.unsubscribed).toBe(true);
      });

      it("propagates RpcException and generic Error on fallback inbox and unsubscribes", async () => {
        const mock = createMockNatsClient({
          publishImpl: (_subject, data, options) => {
            const req = JSON.parse(String(data)) as RpcRequestEnvelope;
            queueMicrotask(() => {
              const errorPayload =
                req.data === "rpc"
                  ? new RpcException({
                      status: 403,
                      message: "Forbidden",
                    }).toSerialized()
                  : {
                      message: "Boom",
                      name: "TypeError",
                      isRpcException: false,
                    };
              void mock.deliver(
                options!.reply!,
                JSON.stringify({
                  type: "response",
                  id: req.id,
                  error: errorPayload,
                  isDisposed: true,
                } satisfies RpcResponseEnvelope),
              );
            });
          },
        });

        const client = track(new NatsClientProxy({ client: mock.client }));

        await expect(client.send("err.op", "rpc")).rejects.toBeInstanceOf(
          RpcException,
        );
        expect(mock.subscriptions[0]?.unsubscribed).toBe(true);

        let caught: unknown;
        try {
          await client.send("err.op", "generic");
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(Error);
        expect(caught).not.toBeInstanceOf(RpcException);
        expect((caught as Error).name).toBe("TypeError");
        expect((caught as Error).message).toBe("Boom");
        expect(mock.subscriptions[1]?.unsubscribed).toBe(true);
      });

      // BUNEST_BUG: NatsClientProxy fallback inbox subscription does not check response.id === req.id, so a response envelope with a mismatched correlation id erroneously resolves the request instead of being ignored (packages/microservices/src/transports/broker.transports.ts).
      it.skip("ignores response envelopes whose id does not match the request id", async () => {
        let capturedReply = "";
        let capturedId = "";
        const mock = createMockNatsClient({
          publishImpl: (_subject, data, options) => {
            const req = JSON.parse(String(data)) as RpcRequestEnvelope;
            capturedReply = options!.reply!;
            capturedId = req.id;
          },
        });

        const client = track(
          new NatsClientProxy({ client: mock.client, defaultTimeoutMs: 500 }),
        );
        const promise = client.send("strict.id", "payload");
        await flushMicrotasks();

        await mock.deliver(
          capturedReply,
          JSON.stringify({
            type: "response",
            id: "wrong-correlation-id",
            response: "wrong-reply",
            isDisposed: true,
          } satisfies RpcResponseEnvelope),
        );
        expect(mock.subscriptions[0]?.unsubscribed).toBe(false);

        await mock.deliver(
          capturedReply,
          JSON.stringify({
            type: "response",
            id: capturedId,
            response: "correct-reply",
            isDisposed: true,
          } satisfies RpcResponseEnvelope),
        );

        expect(await promise).toBe("correct-reply");
      });
    });

    describe("retries & error classification", () => {
      it("retries transient transport errors and timeouts up to options.retries", async () => {
        let attempts = 0;
        const mock = createMockNatsClient({
          requestImpl: async (_subject, data) => {
            attempts += 1;
            if (attempts < 3) {
              throw new Error(`transient-${attempts}`);
            }
            const req = JSON.parse(String(data)) as RpcRequestEnvelope;
            return {
              subject: "_INBOX.ok",
              data: JSON.stringify({
                type: "response",
                id: req.id,
                response: { attempts },
                isDisposed: true,
              } satisfies RpcResponseEnvelope),
            };
          },
        });

        const client = track(new NatsClientProxy({ client: mock.client }));
        const res = await client.send(
          "flaky",
          {},
          { retries: 3, retryDelayMs: 5 },
        );
        expect(res).toEqual({ attempts: 3 });
        expect(attempts).toBe(3);
      });

      it("throws the final error once all retry attempts are exhausted", async () => {
        let attempts = 0;
        const mock = createMockNatsClient({
          publishImpl: () => {
            attempts += 1;
            throw new Error(`fail-${attempts}`);
          },
        });

        const client = track(new NatsClientProxy({ client: mock.client }));
        await expect(
          client.send("always.fail", {}, { retries: 2, retryDelayMs: 1 }),
        ).rejects.toThrow("fail-3");
        expect(attempts).toBe(3);
      });

      it("does not retry non-retryable RpcException business errors", async () => {
        let attempts = 0;
        const mock = createMockNatsClient({
          requestImpl: async (_subject, data) => {
            attempts += 1;
            const req = JSON.parse(String(data)) as RpcRequestEnvelope;
            return {
              subject: "_INBOX.biz",
              data: JSON.stringify({
                type: "response",
                id: req.id,
                error: new RpcException("business failure").toSerialized(),
                isDisposed: true,
              } satisfies RpcResponseEnvelope),
            };
          },
        });

        const client = track(new NatsClientProxy({ client: mock.client }));
        await expect(
          client.send("biz.op", {}, { retries: 3, retryDelayMs: 1 }),
        ).rejects.toThrow("business failure");
        expect(attempts).toBe(1);
      });
    });

    describe("emit() (dispatchEvent)", () => {
      it("publishes RpcEventEnvelope with optional subjectPrefix", async () => {
        const mock = createMockNatsClient();
        const client = track(
          new NatsClientProxy({ client: mock.client, subjectPrefix: "events" }),
        );

        await client.emit("user.created", { id: "u1" });

        expect(mock.published).toHaveLength(1);
        expect(mock.published[0]?.subject).toBe("events.user.created");
        expect(mock.published[0]?.options).toBeUndefined();
        expect(JSON.parse(String(mock.published[0]?.data))).toEqual({
          type: "event",
          pattern: "user.created",
          data: { id: "u1" },
        });
      });

      it("propagates errors thrown or rejected by client.publish()", async () => {
        const mock = createMockNatsClient({
          publishImpl: () => Promise.reject(new Error("publish failed")),
        });
        const client = track(new NatsClientProxy({ client: mock.client }));

        await expect(client.emit("user.deleted", { id: "u1" })).rejects.toThrow(
          "publish failed",
        );
      });
    });

    describe("structured patterns, preRequestHook & unwrap", () => {
      it("normalizes structured object patterns with canonical key sorting in send() and emit()", async () => {
        const mock = createMockNatsClient({ withNativeRequest: true });
        const client = track(new NatsClientProxy({ client: mock.client }));

        await client.send({ cmd: "sum", v: 1 }, [1, 2]);
        await client.send({ v: 1, cmd: "sum" }, [3, 4]);
        await client.emit({ b: 2, a: 1 }, "evt");

        expect(mock.requests[0]?.subject).toBe('{"cmd":"sum","v":1}');
        expect(mock.requests[1]?.subject).toBe('{"cmd":"sum","v":1}');
        expect(mock.published[0]?.subject).toBe('{"a":1,"b":2}');
        expect(
          (JSON.parse(String(mock.published[0]?.data)) as RpcEventEnvelope)
            .pattern,
        ).toBe('{"a":1,"b":2}');
      });

      it("invokes setPreRequestHook before send() and emit(), supports clearing and aborts on hook error", async () => {
        const mock = createMockNatsClient({ withNativeRequest: true });
        const client = track(new NatsClientProxy({ client: mock.client }));
        const seen: Array<{
          pattern: string;
          data: unknown;
          transport: Transport;
        }> = [];

        const chained = client.setPreRequestHook((ctx) => {
          seen.push(ctx);
        });
        expect(chained).toBe(client);

        await client.send({ cmd: "ping" }, { n: 1 });
        await client.emit("audit.log", { ok: true });

        expect(seen).toEqual([
          {
            pattern: '{"cmd":"ping"}',
            data: { n: 1 },
            transport: Transport.NATS,
          },
          {
            pattern: "audit.log",
            data: { ok: true },
            transport: Transport.NATS,
          },
        ]);

        client.setPreRequestHook(() => {
          throw new Error("blocked by hook");
        });
        await expect(client.send("blocked", {})).rejects.toThrow(
          "blocked by hook",
        );
        expect(mock.requests).toHaveLength(1);

        client.setPreRequestHook(undefined);
        await expect(client.send("allowed", {})).resolves.toBeDefined();
        expect(mock.requests).toHaveLength(2);
      });

      it("exposes unwrap() returning the proxy instance", () => {
        const mock = createMockNatsClient();
        const client = track(new NatsClientProxy({ client: mock.client }));
        expect(client.unwrap<NatsClientProxy>()).toBe(client);
      });
    });

    describe("NatsRecord & headers parity", () => {
      it("builds NatsRecord with data and headers via NatsRecordBuilder", () => {
        const record = new NatsRecordBuilder({ id: 1 })
          .setHeaders({ "x-version": "1.0.0" })
          .build();

        expect(record).toBeInstanceOf(NatsRecord);
        expect(record.data).toEqual({ id: 1 });
        expect(record.headers).toEqual({ "x-version": "1.0.0" });
      });

      // BUNEST_BUG: NatsClientProxy.sendOnce() does not unwrap NatsRecord instances; it serializes the raw { data, headers } record wrapper into envelope.data and does not pass record.headers in publish/request options (packages/microservices/src/transports/broker.transports.ts).
      it.skip("unwraps NatsRecord data and forwards headers on send()", async () => {
        const mock = createMockNatsClient({
          publishImpl: (_subject, data, options) => {
            const req = JSON.parse(String(data)) as RpcRequestEnvelope;
            queueMicrotask(() => {
              void mock.deliver(
                options!.reply!,
                JSON.stringify({
                  type: "response",
                  id: req.id,
                  response: "ok",
                  isDisposed: true,
                } satisfies RpcResponseEnvelope),
              );
            });
          },
        });

        const client = track(new NatsClientProxy({ client: mock.client }));
        const record = new NatsRecordBuilder("payload")
          .setHeaders({ "x-trace": "t-1" })
          .build();

        await client.send("test", record);

        const sent = JSON.parse(
          String(mock.published[0]?.data),
        ) as RpcRequestEnvelope;
        expect(sent.data).toBe("payload");
        expect(
          (mock.published[0]?.options as { headers?: Record<string, string> })
            ?.headers,
        ).toEqual({ "x-trace": "t-1" });
      });

      // BUNEST_BUG: NatsClientProxy.dispatchEvent() does not unwrap NatsRecord instances; it serializes the raw { data, headers } record wrapper into envelope.data and does not pass record.headers in publish options (packages/microservices/src/transports/broker.transports.ts).
      it.skip("unwraps NatsRecord data and forwards headers on emit()", async () => {
        const mock = createMockNatsClient();
        const client = track(new NatsClientProxy({ client: mock.client }));
        const record = new NatsRecord("event-data", { "x-version": "2.0.0" });

        await client.emit("events.test", record);

        const sent = JSON.parse(
          String(mock.published[0]?.data),
        ) as RpcEventEnvelope;
        expect(sent.data).toBe("event-data");
        expect(
          (mock.published[0]?.options as { headers?: Record<string, string> })
            ?.headers,
        ).toEqual({ "x-version": "2.0.0" });
      });
    });
  },
);
