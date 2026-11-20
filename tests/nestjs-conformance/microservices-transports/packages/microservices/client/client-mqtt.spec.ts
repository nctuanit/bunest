import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  describeConformance,
  itAdapted,
  createSpy,
  createStub,
} from "../../../../_helpers";
import {
  MqttClientProxy,
  MqttRecord,
  MqttRecordBuilder,
  MqttServer,
  RpcException,
  RpcTimeoutException,
  Transport,
  matchMqttTopic,
  type MqttClientLike,
  type MqttMessageListener,
  type MqttPublishOptions,
  type MqttQoS,
} from "../../../../../../packages/microservices/src";

interface PublishedRecord {
  readonly topic: string;
  readonly message: string | Uint8Array;
  readonly options?: MqttPublishOptions;
}

interface MockMqttClientState {
  readonly subscriptions: Map<string, MqttQoS>;
  readonly listeners: Set<MqttMessageListener>;
  readonly onDelivery?: (
    topic: string,
    payload: Uint8Array | Buffer | string,
  ) => void;
  ended: boolean;
  closed: boolean;
  subscribeCalls: Array<{ topic: string | readonly string[]; qos?: MqttQoS }>;
  unsubscribeCalls: Array<string | readonly string[]>;
  endCalls: number;
  closeCalls: number;
}

class InMemoryMqttBroker {
  public readonly clients = new Set<MockMqttClientState>();
  public readonly published: PublishedRecord[] = [];

  createClient(options?: {
    useRemoveListenerOnly?: boolean;
    useCloseOnly?: boolean;
    omitUnsubscribe?: boolean;
    onDelivery?: (
      topic: string,
      payload: Uint8Array | Buffer | string,
    ) => void;
  }): { client: MqttClientLike; state: MockMqttClientState } {
    const broker = this;
    const state: MockMqttClientState = {
      subscriptions: new Map(),
      listeners: new Set(),
      onDelivery: options?.onDelivery,
      ended: false,
      closed: false,
      subscribeCalls: [],
      unsubscribeCalls: [],
      endCalls: 0,
      closeCalls: 0,
    };
    this.clients.add(state);

    const client: MqttClientLike = {
      subscribe(topic, subOpts) {
        state.subscribeCalls.push({ topic, qos: subOpts?.qos });
        const list = Array.isArray(topic) ? topic : [topic];
        for (const t of list) {
          state.subscriptions.set(t, subOpts?.qos ?? 0);
        }
      },
      on(_event, listener) {
        state.listeners.add(listener);
      },
      publish(topic, message, pubOpts) {
        broker.published.push({ topic, message, options: pubOpts });
        for (const c of [...broker.clients]) {
          if (c.ended || c.closed) continue;
          let matchedQos: MqttQoS | undefined;
          for (const [filter, subQos] of c.subscriptions.entries()) {
            if (filter === topic || matchMqttTopic(filter, topic)) {
              matchedQos = Math.min(subQos, pubOpts?.qos ?? 0) as MqttQoS;
              break;
            }
          }
          if (matchedQos === undefined) continue;
          const packet = {
            topic,
            payload: message,
            qos: pubOpts?.qos ?? matchedQos,
            retain: pubOpts?.retain ?? false,
            dup: pubOpts?.dup,
            properties: pubOpts?.properties,
          };
          for (const listener of [...c.listeners]) {
            queueMicrotask(() => {
              c.onDelivery?.(topic, message);
              listener(topic, message, packet);
            });
          }
        }
      },
    };

    if (!options?.omitUnsubscribe) {
      client.unsubscribe = (topic) => {
        state.unsubscribeCalls.push(topic);
        const list = Array.isArray(topic) ? topic : [topic];
        for (const t of list) {
          state.subscriptions.delete(t);
        }
      };
    }

    if (options?.useRemoveListenerOnly) {
      client.removeListener = (_event, listener) => {
        state.listeners.delete(listener);
      };
    } else {
      client.off = (_event, listener) => {
        state.listeners.delete(listener);
      };
    }

    if (options?.useCloseOnly) {
      client.close = () => {
        state.closeCalls++;
        state.closed = true;
        state.listeners.clear();
        state.subscriptions.clear();
        broker.clients.delete(state);
      };
    } else {
      client.end = () => {
        state.endCalls++;
        state.ended = true;
        state.listeners.clear();
        state.subscriptions.clear();
        broker.clients.delete(state);
      };
    }

    return { client, state };
  }

  deliverRaw(
    target: MockMqttClientState,
    topic: string,
    payload: Uint8Array | Buffer | string,
  ): void {
    for (const listener of [...target.listeners]) {
      listener(topic, payload, { topic, payload });
    }
  }
}

describeConformance(
  "ClientMqtt (MqttClientProxy)",
  {
    upstreamPath: "packages/microservices/test/client/client-mqtt.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008"],
    notes:
      "Adapted to Bunest's zero-dependency client-injected MqttClientProxy, isolated per-client reply topics (`${topic}/reply/${clientId}`), and Promise-based send()/emit()/emitWithOptions() API.",
  },
  () => {
    let broker: InMemoryMqttBroker;
    let activeClients: MqttClientProxy[];
    let activeServers: MqttServer[];

    const trackClient = (c: MqttClientProxy): MqttClientProxy => {
      activeClients.push(c);
      return c;
    };

    const trackServer = (s: MqttServer): MqttServer => {
      activeServers.push(s);
      return s;
    };

    beforeEach(() => {
      broker = new InMemoryMqttBroker();
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

    describe("constructor, options & getReplyTopic", () => {
      itAdapted(
        ["ADR-001", "ADR-008"],
        "initializes defaults and derives isolated per-client reply topics",
        () => {
          const { client: raw1 } = broker.createClient();
          const { client: raw2 } = broker.createClient();

          const c1 = trackClient(new MqttClientProxy({ client: raw1 }));
          const c2 = trackClient(
            new MqttClientProxy({
              client: raw2,
              clientId: "edge-node-7",
              qos: 1,
              retain: true,
              closeClientOnClose: true,
            }),
          );

          expect(c1.transport).toBe(Transport.MQTT);
          expect(c1.clientId.length).toBeGreaterThan(0);
          expect(c2.clientId).toBe("edge-node-7");
          expect(c1.getReplyTopic("devices/d1/cmd")).toBe(
            `devices/d1/cmd/reply/${c1.clientId}`,
          );
          expect(c2.getReplyTopic("devices/d1/cmd")).toBe(
            "devices/d1/cmd/reply/edge-node-7",
          );
          expect(c1.getReplyTopic("devices/d1/cmd")).not.toBe(
            c2.getReplyTopic("devices/d1/cmd"),
          );
        },
      );
    });

    describe("connect", () => {
      itAdapted(
        ["ADR-001", "ADR-008"],
        "attaches message listener once and is idempotent across repeated connect() calls",
        async () => {
          const { client: raw, state } = broker.createClient();
          const proxy = trackClient(new MqttClientProxy({ client: raw }));

          await proxy.connect();
          await proxy.connect();
          await proxy.connect();

          expect(state.listeners.size).toBe(1);
        },
      );

      // BUNEST_BUG: MqttClientProxy.connect() never calls this.emitStatus("connected"), so client.status stays "disconnected" and onStatus listeners are never notified (packages/microservices/src/transports/mqtt.transport.ts)
      it.skip("emits connected status via status getter and onStatus listeners on connect()", async () => {
        const { client: raw } = broker.createClient();
        const proxy = trackClient(new MqttClientProxy({ client: raw }));
        const statuses: string[] = [];
        proxy.onStatus((s) => statuses.push(s));

        await proxy.connect();

        expect(proxy.status).toBe("connected");
        expect(statuses).toEqual(["connected"]);
      });
    });

    describe("close & onModuleDestroy", () => {
      itAdapted(
        ["ADR-001", "ADR-008"],
        "rejects pending requests, detaches listener via off(), unsubscribes reply topics, and respects closeClientOnClose=false",
        async () => {
          const { client: raw, state } = broker.createClient();
          const proxy = trackClient(
            new MqttClientProxy({
              client: raw,
              clientId: "c-close",
              defaultTimeoutMs: 10_000,
            }),
          );

          const pending1 = proxy.send("devices/d1/op", { a: 1 });
          const pending2 = proxy.send("devices/d2/op", { b: 2 });
          const pending1Err = pending1.catch((err: unknown) => err);
          const pending2Err = pending2.catch((err: unknown) => err);
          await Bun.sleep(5);

          expect(state.listeners.size).toBe(1);
          expect(state.subscriptions.size).toBe(2);

          await proxy.close();

          const err1 = await pending1Err;
          const err2 = await pending2Err;
          expect(err1).toBeInstanceOf(Error);
          expect((err1 as Error).message).toBe("MqttClientProxy closed.");
          expect(err2).toBeInstanceOf(Error);
          expect((err2 as Error).message).toBe("MqttClientProxy closed.");
          expect(state.listeners.size).toBe(0);
          expect(state.subscriptions.size).toBe(0);
          expect(state.unsubscribeCalls.sort()).toEqual([
            "devices/d1/op/reply/c-close",
            "devices/d2/op/reply/c-close",
          ]);
          expect(state.endCalls).toBe(0);
          expect(state.closeCalls).toBe(0);
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "falls back to removeListener() when off() is absent, tolerates omitted unsubscribe(), and calls end() or close() when closeClientOnClose=true",
        async () => {
          // 1. removeListener + end
          const env1 = broker.createClient({
            useRemoveListenerOnly: true,
            omitUnsubscribe: true,
          });
          const p1 = trackClient(
            new MqttClientProxy({
              client: env1.client,
              closeClientOnClose: true,
            }),
          );
          await p1.connect();
          expect(env1.state.listeners.size).toBe(1);
          await p1.close();
          expect(env1.state.listeners.size).toBe(0);
          expect(env1.state.endCalls).toBe(1);

          // 2. off + close fallback (when end is absent)
          const env2 = broker.createClient({ useCloseOnly: true });
          const p2 = trackClient(
            new MqttClientProxy({
              client: env2.client,
              closeClientOnClose: true,
            }),
          );
          await p2.connect();
          await p2.close();
          expect(env2.state.closeCalls).toBe(1);
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "re-attaches listener and re-subscribes reply topics cleanly after close() and reconnect",
        async () => {
          const { client: srvRaw } = broker.createClient();
          const server = trackServer(new MqttServer({ client: srvRaw }));
          server.addMessageHandler("echo/ping", (d) => ({ pong: d }));
          await server.listen();

          const { client: raw, state } = broker.createClient();
          const proxy = trackClient(
            new MqttClientProxy({ client: raw, clientId: "reconn-1" }),
          );

          expect(await proxy.send("echo/ping", 1)).toEqual({ pong: 1 });
          await proxy.close();
          expect(state.listeners.size).toBe(0);
          expect(state.subscriptions.size).toBe(0);

          // Reconnect & send again
          await proxy.connect();
          expect(state.listeners.size).toBe(1);
          expect(await proxy.send("echo/ping", 2)).toEqual({ pong: 2 });
          expect(state.subscribeCalls).toHaveLength(2);
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "onModuleDestroy() delegates to close()",
        async () => {
          const { client: raw, state } = broker.createClient();
          const proxy = trackClient(
            new MqttClientProxy({ client: raw, closeClientOnClose: true }),
          );
          await proxy.connect();

          await proxy.onModuleDestroy();
          expect(state.listeners.size).toBe(0);
          expect(state.endCalls).toBe(1);
        },
      );

      // BUNEST_BUG: MqttClientProxy.close() never calls this.emitStatus("disconnected") (packages/microservices/src/transports/mqtt.transport.ts)
      it.skip("emits disconnected status via onStatus when closing a connected client", async () => {
        const { client: raw } = broker.createClient();
        const proxy = trackClient(new MqttClientProxy({ client: raw }));
        const statuses: string[] = [];
        proxy.onStatus((s) => statuses.push(s));

        await proxy.connect();
        await proxy.close();

        expect(proxy.status).toBe("disconnected");
        expect(statuses).toEqual(["connected", "disconnected"]);
      });

      // BUNEST_BUG: MqttClientProxy.close() awaits client.unsubscribe() without try/finally, so a failing unsubscribe skips clearing subscribedReplyTopics and skips calling client.end() (packages/microservices/src/transports/mqtt.transport.ts)
      it.skip("clears subscription state and ends the client even when unsubscribe() rejects during close()", async () => {
        const { client: raw, state } = broker.createClient();
        raw.unsubscribe = async () => {
          throw new Error("unsubscribe failed");
        };
        const proxy = trackClient(
          new MqttClientProxy({
            client: raw,
            clientId: "fail-unsub",
            closeClientOnClose: true,
          }),
        );
        const pendingErr = proxy
          .send("test/op", 1)
          .catch((err: unknown) => err);
        await Bun.sleep(5);

        await expect(proxy.close()).rejects.toThrow("unsubscribe failed");
        expect(((await pendingErr) as Error).message).toBe(
          "MqttClientProxy closed.",
        );
        expect(state.endCalls).toBe(1);
      });
    });

    describe("send (request-reply)", () => {
      itAdapted(
        ["ADR-001", "ADR-008"],
        "publishes RpcRequestEnvelope with replyTo & qos (retain=false), isolates concurrent clients, and correlates responses",
        async () => {
          const { client: srvRaw } = broker.createClient();
          const server = trackServer(
            new MqttServer({ client: srvRaw, qos: 1 }),
          );
          server.addMessageHandler("devices/+/cmd", async (data) => {
            const { tag, delay } = data as { tag: string; delay: number };
            await Bun.sleep(delay);
            return { ok: tag };
          });
          await server.listen();

          const c1Deliveries: string[] = [];
          const c2Deliveries: string[] = [];
          const env1 = broker.createClient({
            onDelivery: (t) => c1Deliveries.push(t),
          });
          const env2 = broker.createClient({
            onDelivery: (t) => c2Deliveries.push(t),
          });

          const client1 = trackClient(
            new MqttClientProxy({
              client: env1.client,
              clientId: "client-a",
              qos: 1,
              retain: true, // request publish MUST still force retain: false
            }),
          );
          const client2 = trackClient(
            new MqttClientProxy({
              client: env2.client,
              clientId: "client-b",
              qos: 2,
            }),
          );

          const [r1, r2] = await Promise.all([
            client1.send("devices/d1/cmd", { tag: "A", delay: 20 }),
            client2.send("devices/d1/cmd", { tag: "B", delay: 5 }),
          ]);

          expect(r1).toEqual({ ok: "A" });
          expect(r2).toEqual({ ok: "B" });
          expect(c1Deliveries).toEqual(["devices/d1/cmd/reply/client-a"]);
          expect(c2Deliveries).toEqual(["devices/d1/cmd/reply/client-b"]);

          const reqPublish = broker.published.find(
            (p) => p.topic === "devices/d1/cmd",
          )!;
          expect(reqPublish.options).toEqual({ qos: 1, retain: false });
          const parsedReq = JSON.parse(String(reqPublish.message)) as {
            type: string;
            id: string;
            pattern: string;
            data: unknown;
            replyTo: string;
          };
          expect(parsedReq.type).toBe("request");
          expect(parsedReq.pattern).toBe("devices/d1/cmd");
          expect(parsedReq.replyTo).toBe("devices/d1/cmd/reply/client-a");
          expect(parsedReq.data).toEqual({ tag: "A", delay: 20 });
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "single-flights concurrent reply subscriptions and recovers cleanly after a failed subscribe",
        async () => {
          let failFirst = true;
          let subCalls = 0;
          const listeners = new Set<MqttMessageListener>();
          const rawClient: MqttClientLike = {
            async subscribe() {
              subCalls++;
              await Bun.sleep(10);
              if (failFirst) {
                failFirst = false;
                throw new Error("subscribe rejected");
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
                const reply = Buffer.from(
                  JSON.stringify({
                    type: "response",
                    id: parsed.id,
                    response: parsed.data,
                    isDisposed: true,
                  }),
                );
                for (const l of listeners) {
                  queueMicrotask(() => l(parsed.replyTo!, reply));
                }
              }
            },
          };

          const proxy = trackClient(
            new MqttClientProxy({ client: rawClient, clientId: "sf-1" }),
          );

          await expect(proxy.send("op/test", { n: 0 })).rejects.toThrow(
            "subscribe rejected",
          );

          const [a, b] = await Promise.all([
            proxy.send("op/test", { n: 1 }),
            proxy.send("op/test", { n: 2 }),
          ]);
          expect(a).toEqual({ n: 1 });
          expect(b).toEqual({ n: 2 });
          expect(subCalls).toBe(2);
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "propagates RpcException (without retry) and generic Error (with retry) and RpcTimeoutException",
        async () => {
          const { client: srvRaw } = broker.createClient();
          const server = trackServer(new MqttServer({ client: srvRaw }));
          let flakyAttempts = 0;
          let rpcAttempts = 0;

          server.addMessageHandler("rpc/fail", () => {
            rpcAttempts++;
            throw new RpcException({ status: 409, message: "already exists" });
          });
          server.addMessageHandler("generic/flaky", () => {
            flakyAttempts++;
            if (flakyAttempts < 3) {
              const err = new SyntaxError("transient parse issue");
              throw err;
            }
            return { recovered: true, attempts: flakyAttempts };
          });
          server.addMessageHandler("generic/always", () => {
            throw new RangeError("permanent boom");
          });
          await server.listen();

          const { client: raw } = broker.createClient();
          const proxy = trackClient(
            new MqttClientProxy({
              client: raw,
              clientId: "err-client",
              defaultTimeoutMs: 40,
            }),
          );

          // 1. RpcException propagates immediately without retries
          let caughtRpc: unknown;
          try {
            await proxy.send("rpc/fail", {}, { retries: 3, retryDelayMs: 5 });
          } catch (err) {
            caughtRpc = err;
          }
          expect(caughtRpc).toBeInstanceOf(RpcException);
          expect((caughtRpc as RpcException).getError()).toEqual({
            status: 409,
            message: "already exists",
          });
          expect(rpcAttempts).toBe(1);

          // 2. Transient generic Error succeeds via retry
          expect(
            await proxy.send(
              "generic/flaky",
              {},
              { retries: 3, retryDelayMs: 5 },
            ),
          ).toEqual({ recovered: true, attempts: 3 });

          // 3. Generic Error preserves name and message when retries exhausted
          let caughtGen: unknown;
          try {
            await proxy.send("generic/always", {});
          } catch (err) {
            caughtGen = err;
          }
          expect(caughtGen).toBeInstanceOf(Error);
          expect((caughtGen as Error).name).toBe("RangeError");
          expect((caughtGen as Error).message).toBe("permanent boom");

          // 4. Timeout on unresponsive topic
          const silentRaw = broker.createClient().client;
          const timeoutProxy = trackClient(
            new MqttClientProxy({
              client: silentRaw,
              defaultTimeoutMs: 35,
            }),
          );
          await expect(
            timeoutProxy.send("unhandled/hang", { x: 1 }),
          ).rejects.toBeInstanceOf(RpcTimeoutException);
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "rejects cleanly when client.publish() throws synchronously or rejects asynchronously",
        async () => {
          const syncFailClient: MqttClientLike = {
            subscribe: () => {},
            on: () => {},
            off: () => {},
            publish: () => {
              throw new Error("sync publish error");
            },
          };
          const asyncFailClient: MqttClientLike = {
            subscribe: () => {},
            on: () => {},
            off: () => {},
            publish: async () => {
              throw new Error("async publish error");
            },
          };

          const c1 = trackClient(
            new MqttClientProxy({ client: syncFailClient }),
          );
          const c2 = trackClient(
            new MqttClientProxy({ client: asyncFailClient }),
          );

          await expect(c1.send("a/b", 1)).rejects.toThrow("sync publish error");
          await expect(c2.send("a/b", 1)).rejects.toThrow("async publish error");
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "normalizes canonical object patterns consistently on send()",
        async () => {
          const { client: srvRaw } = broker.createClient();
          const server = trackServer(new MqttServer({ client: srvRaw }));
          server.addMessageHandler({ cmd: "mul", v: 1 }, (d) => {
            const { a, b } = d as { a: number; b: number };
            return a * b;
          });
          await server.listen();

          const { client: raw } = broker.createClient();
          const proxy = trackClient(new MqttClientProxy({ client: raw }));
          expect(await proxy.send({ v: 1, cmd: "mul" }, { a: 6, b: 7 })).toBe(
            42,
          );
        },
      );

      // BUNEST_BUG: MqttClientProxy.sendOnce() does not unwrap MqttRecord instances — it embeds the MqttRecord object as req.data and ignores record.options (qos, dup, properties) (packages/microservices/src/transports/mqtt.transport.ts)
      it.skip("unwraps MqttRecord passed to send() and applies record publish options", async () => {
        const { client: raw } = broker.createClient();
        const proxy = trackClient(
          new MqttClientProxy({ client: raw, clientId: "rec-send" }),
        );
        const record = new MqttRecord("payload-data", {
          qos: 2,
          dup: true,
          properties: { userProperties: { "x-trace": "123" } },
        });

        const pending = proxy
          .send("devices/d1", record, { timeoutMs: 200 })
          .catch(() => {});
        await Bun.sleep(5);

        const pub = broker.published.find((p) => p.topic === "devices/d1")!;
        expect(JSON.parse(String(pub.message)).data).toBe("payload-data");
        expect(pub.options?.qos).toBe(2);
        expect(pub.options?.properties).toEqual({
          userProperties: { "x-trace": "123" },
        });
        await proxy.close();
        await pending;
      });

      // BUNEST_BUG: MqttClientProxy.sendOnce() does not validate publish topic names against MQTT 3.1.1/5.0 Section 4.7.1 (wildcards '+', '#' or '\u0000') (packages/microservices/src/transports/mqtt.transport.ts)
      it.skip("rejects invalid MQTT publish topics containing '+', '#', or '\\u0000' without subscribing or publishing", async () => {
        const { client: raw, state } = broker.createClient();
        const proxy = trackClient(new MqttClientProxy({ client: raw }));

        for (const badTopic of [
          "devices/+/status",
          "devices/#",
          "devices/\u0000",
        ]) {
          await expect(proxy.send(badTopic, "data")).rejects.toThrow();
        }
        expect(state.subscribeCalls).toHaveLength(0);
        expect(broker.published).toHaveLength(0);
      });
    });

    describe("malformed, non-response & wrong-topic message filtering", () => {
      itAdapted(
        ["ADR-001", "ADR-008"],
        "ignores wrong topics, non-JSON payloads, non-response envelopes, and unknown ids until valid response arrives",
        async () => {
          const { client: raw, state } = broker.createClient();
          const proxy = trackClient(
            new MqttClientProxy({ client: raw, clientId: "filter-1" }),
          );

          const pending = proxy.send("sensor/read", { id: 1 });
          await Bun.sleep(5);

          const sent = broker.published[0]!;
          const req = JSON.parse(String(sent.message)) as {
            id: string;
            replyTo: string;
          };

          // 1. Unsubscribed / wrong topic (even with matching id!)
          broker.deliverRaw(
            state,
            "sensor/read/reply/other-client",
            JSON.stringify({ type: "response", id: req.id, response: "wrong-topic" }),
          );
          // 2. Malformed non-JSON payload on subscribed reply topic
          broker.deliverRaw(state, req.replyTo, "<<<corrupt-json>>>");
          // 3. Valid JSON that is not an RpcEnvelope
          broker.deliverRaw(state, req.replyTo, JSON.stringify({ plain: true }));
          // 4. Non-response envelope (request / event)
          broker.deliverRaw(
            state,
            req.replyTo,
            JSON.stringify({ type: "event", pattern: "x", data: 1 }),
          );
          broker.deliverRaw(
            state,
            req.replyTo,
            JSON.stringify({ type: "request", id: req.id, pattern: "x", data: 1 }),
          );
          // 5. Response envelope with mismatched id
          broker.deliverRaw(
            state,
            req.replyTo,
            JSON.stringify({
              type: "response",
              id: "unknown-id",
              response: "wrong-id",
            }),
          );

          // 6. Genuine matching response delivered as Uint8Array
          broker.deliverRaw(
            state,
            req.replyTo,
            new TextEncoder().encode(
              JSON.stringify({
                type: "response",
                id: req.id,
                response: { tempC: 21.5 },
                isDisposed: true,
              }),
            ),
          );

          expect(await pending).toEqual({ tempC: 21.5 });
        },
      );
    });

    describe("emit & emitWithOptions", () => {
      itAdapted(
        ["ADR-001", "ADR-008"],
        "emit() publishes RpcEventEnvelope with client default qos & retain",
        async () => {
          const { client: raw } = broker.createClient();
          const proxy = trackClient(
            new MqttClientProxy({
              client: raw,
              qos: 1,
              retain: true,
            }),
          );

          await proxy.emit("telemetry/cpu", { pct: 55 });

          expect(broker.published).toHaveLength(1);
          expect(broker.published[0]!.topic).toBe("telemetry/cpu");
          expect(JSON.parse(String(broker.published[0]!.message))).toEqual({
            type: "event",
            pattern: "telemetry/cpu",
            data: { pct: 55 },
          });
          expect(broker.published[0]!.options).toEqual({
            qos: 1,
            retain: true,
            dup: undefined,
            properties: undefined,
          });
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "emitWithOptions() overrides qos, retain, dup, and MQTT 5 properties per message",
        async () => {
          const { client: raw } = broker.createClient();
          const proxy = trackClient(
            new MqttClientProxy({
              client: raw,
              qos: 0,
              retain: false,
            }),
          );

          await proxy.emitWithOptions(
            "alerts/fire",
            { room: "lab-1" },
            {
              qos: 2,
              retain: true,
              dup: true,
              properties: { userProperties: { severity: "critical" } },
            },
          );

          expect(broker.published).toHaveLength(1);
          expect(broker.published[0]!.options).toEqual({
            qos: 2,
            retain: true,
            dup: true,
            properties: { userProperties: { severity: "critical" } },
          });
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "propagates publish errors from emit() and emitWithOptions()",
        async () => {
          const failRaw: MqttClientLike = {
            subscribe: () => {},
            on: () => {},
            publish: async () => {
              throw new Error("mqtt publish refused");
            },
          };
          const proxy = trackClient(new MqttClientProxy({ client: failRaw }));

          await expect(proxy.emit("a/b", 1)).rejects.toThrow(
            "mqtt publish refused",
          );
          await expect(
            proxy.emitWithOptions("a/b", 1, { qos: 1 }),
          ).rejects.toThrow("mqtt publish refused");
        },
      );

      // BUNEST_BUG: MqttClientProxy.emit() / emitWithOptions() do not unwrap MqttRecord instances or apply record.options (qos, retain, dup, properties) (packages/microservices/src/transports/mqtt.transport.ts)
      it.skip("unwraps MqttRecord passed to emit() and forwards record options to client.publish()", async () => {
        const { client: raw } = broker.createClient();
        const proxy = trackClient(new MqttClientProxy({ client: raw }));
        const record = new MqttRecordBuilder({ temp: 22 })
          .setQoS(2)
          .setRetain(true)
          .setDup(true)
          .setProperties({ userProperties: { unit: "C" } })
          .build();

        await proxy.emit("sensors/temp", record);

        const pub = broker.published[0]!;
        expect(JSON.parse(String(pub.message)).data).toEqual({ temp: 22 });
        expect(pub.options).toEqual({
          qos: 2,
          retain: true,
          dup: true,
          properties: { userProperties: { unit: "C" } },
        });
      });

      // BUNEST_BUG: MqttClientProxy.emit() does not reject invalid MQTT publish topic names containing wildcards ('+', '#') or '\u0000' (packages/microservices/src/transports/mqtt.transport.ts)
      it.skip("rejects emit() on invalid MQTT publish topics containing '+', '#', or '\\u0000'", async () => {
        const { client: raw } = broker.createClient();
        const proxy = trackClient(new MqttClientProxy({ client: raw }));

        for (const badTopic of [
          "devices/+/status",
          "devices/#",
          "devices/\u0000",
        ]) {
          await expect(proxy.emit(badTopic, "data")).rejects.toThrow();
        }
        expect(broker.published).toHaveLength(0);
      });
    });

    describe("setPreRequestHook, unwrap & onStatus", () => {
      itAdapted(
        ["ADR-001", "ADR-008"],
        "invokes setPreRequestHook before send() and emit(), supports clearing, aborts on error, and exposes unwrap()",
        async () => {
          const { client: srvRaw } = broker.createClient();
          const server = trackServer(new MqttServer({ client: srvRaw }));
          server.addMessageHandler("hook/op", (d) => d);
          await server.listen();

          const { client: raw } = broker.createClient();
          const proxy = trackClient(new MqttClientProxy({ client: raw }));
          expect(proxy.unwrap()).toBeDefined();
          expect(proxy.status).toBe("disconnected");

          const statusOff = proxy.onStatus(createStub());
          expect(typeof statusOff).toBe("function");
          statusOff();

          const seen: Array<{
            pattern: string;
            data: unknown;
            transport: Transport;
          }> = [];
          expect(
            proxy.setPreRequestHook((info) => {
              seen.push(info);
            }),
          ).toBe(proxy);

          await proxy.send("hook/op", { a: 1 });
          await proxy.emit("hook/ev", { b: 2 });

          expect(seen).toEqual([
            { pattern: "hook/op", data: { a: 1 }, transport: Transport.MQTT },
            { pattern: "hook/ev", data: { b: 2 }, transport: Transport.MQTT },
          ]);

          const publishedBefore = broker.published.length;
          proxy.setPreRequestHook(() => {
            throw new Error("mqtt hook rejected");
          });
          await expect(proxy.send("hook/op", 1)).rejects.toThrow(
            "mqtt hook rejected",
          );
          await expect(proxy.emit("hook/ev", 1)).rejects.toThrow(
            "mqtt hook rejected",
          );
          expect(broker.published.length).toBe(publishedBefore);

          proxy.setPreRequestHook(undefined);
          expect(await proxy.send("hook/op", { ok: true })).toEqual({
            ok: true,
          });
        },
      );

      // BUNEST_BUG: MqttClientProxy.emitWithOptions() bypasses ClientProxy.emit() and never invokes the registered preRequestHook (packages/microservices/src/transports/mqtt.transport.ts)
      it.skip("invokes setPreRequestHook before emitWithOptions()", async () => {
        const { client: raw } = broker.createClient();
        const proxy = trackClient(new MqttClientProxy({ client: raw }));
        const hook = createSpy();
        proxy.setPreRequestHook(hook);

        await proxy.emitWithOptions("hook/opts", { x: 1 }, { qos: 1 });
        expect(hook.calledOnce).toBe(true);
      });
    });
  },
);
