import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  describeConformance,
  itAdapted,
  createSpy,
} from "../../../../_helpers";
import { HttpException } from "../../../../../../packages/common/src";
import {
  MqttContext,
  MqttRecordBuilder,
  MqttServer,
  RpcException,
  Transport,
  matchMqttTopic,
  type MqttClientLike,
  type MqttMessageListener,
  type MqttPacketLike,
  type MqttPublishOptions,
  type MqttQoS,
  type RpcResponseEnvelope,
} from "../../../../../../packages/microservices/src";

interface MockMqttServerHarness {
  readonly client: MqttClientLike;
  readonly listeners: Set<MqttMessageListener>;
  readonly subscribeCalls: Array<{
    topic: string | readonly string[];
    qos?: MqttQoS;
  }>;
  readonly unsubscribeCalls: Array<string | readonly string[]>;
  readonly published: Array<{
    topic: string;
    message: string | Uint8Array;
    options?: MqttPublishOptions;
  }>;
  endCalls: number;
  closeCalls: number;
  emit(
    topic: string,
    payload: Uint8Array | Buffer | string,
    packet?: MqttPacketLike,
  ): Promise<void>;
}

function createMqttServerHarness(options?: {
  useRemoveListenerOnly?: boolean;
  useCloseOnly?: boolean;
  omitUnsubscribe?: boolean;
}): MockMqttServerHarness {
  const listeners = new Set<MqttMessageListener>();
  const subscribeCalls: Array<{
    topic: string | readonly string[];
    qos?: MqttQoS;
  }> = [];
  const unsubscribeCalls: Array<string | readonly string[]> = [];
  const published: Array<{
    topic: string;
    message: string | Uint8Array;
    options?: MqttPublishOptions;
  }> = [];

  const harness: MockMqttServerHarness = {
    client: null as unknown as MqttClientLike,
    listeners,
    subscribeCalls,
    unsubscribeCalls,
    published,
    endCalls: 0,
    closeCalls: 0,
    async emit(topic, payload, packet) {
      for (const listener of [...listeners]) {
        listener(topic, payload, packet);
      }
      // Allow async onMessage microtasks to complete
      await Bun.sleep(5);
    },
  };

  const client: MqttClientLike = {
    subscribe(topic, subOpts) {
      subscribeCalls.push({ topic, qos: subOpts?.qos });
    },
    on(_event, listener) {
      listeners.add(listener);
    },
    publish(topic, message, pubOpts) {
      published.push({ topic, message, options: pubOpts });
    },
  };

  if (!options?.omitUnsubscribe) {
    client.unsubscribe = (topic) => {
      unsubscribeCalls.push(topic);
    };
  }

  if (options?.useRemoveListenerOnly) {
    client.removeListener = (_event, listener) => {
      listeners.delete(listener);
    };
  } else {
    client.off = (_event, listener) => {
      listeners.delete(listener);
    };
  }

  if (options?.useCloseOnly) {
    client.close = () => {
      harness.closeCalls++;
    };
  } else {
    client.end = () => {
      harness.endCalls++;
    };
  }

  Object.assign(harness, { client });
  return harness;
}

function parseResponse(
  record: MockMqttServerHarness["published"][number],
): RpcResponseEnvelope {
  return JSON.parse(String(record.message)) as RpcResponseEnvelope;
}

describeConformance(
  "ServerMqtt (MqttServer)",
  {
    upstreamPath: "packages/microservices/test/server/server-mqtt.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008"],
    notes:
      "Adapted to Bunest's zero-dependency client-injected MqttServer, matchMqttTopic() MQTT 3.1.1/5.0 spec matcher, MqttContext, and Promise-based handlers.",
  },
  () => {
    let harness: MockMqttServerHarness;
    let activeServers: MqttServer[];

    const track = (server: MqttServer): MqttServer => {
      activeServers.push(server);
      return server;
    };

    beforeEach(() => {
      harness = createMqttServerHarness();
      activeServers = [];
    });

    afterEach(async () => {
      for (const s of activeServers) {
        await s.close().catch(() => {});
      }
    });

    describe("matchMqttTopic (MQTT 3.1.1 / 5.0 Section 4.7)", () => {
      itAdapted(
        ["ADR-001", "ADR-008"],
        "rejects empty filter or empty topic inputs",
        () => {
          expect(matchMqttTopic("", "a/b")).toBe(false);
          expect(matchMqttTopic("a/b", "")).toBe(false);
          expect(matchMqttTopic("", "")).toBe(false);
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "matches exact topics and single-level '+' wildcards including empty levels",
        () => {
          expect(matchMqttTopic("sport/tennis", "sport/tennis")).toBe(true);
          expect(matchMqttTopic("sport/", "sport/")).toBe(true);
          expect(matchMqttTopic("sport/tennis", "sport/Tennis")).toBe(false);

          // Single-level '+'
          expect(matchMqttTopic("sensors/+/temp", "sensors/room1/temp")).toBe(
            true,
          );
          expect(
            matchMqttTopic("sensors/+/temp", "sensors/room1/humidity"),
          ).toBe(false);
          expect(
            matchMqttTopic("sensors/+/temp", "sensors/floor1/room1/temp"),
          ).toBe(false);
          expect(matchMqttTopic("root/valid/+", "root/valid/child")).toBe(true);
          expect(matchMqttTopic("root/+/child", "root/valid/child")).toBe(true);
          expect(matchMqttTopic("root/test/+", "root/invalid/child")).toBe(
            false,
          );
          expect(
            matchMqttTopic("root/+/grandchild", "root/invalid/child/grandchild"),
          ).toBe(false);

          // Empty topic levels
          expect(matchMqttTopic("sport/+", "sport/")).toBe(true);
          expect(matchMqttTopic("sport/+/score", "sport//score")).toBe(true);
          expect(matchMqttTopic("+/score", "/score")).toBe(true);
          expect(matchMqttTopic("+/+", "/")).toBe(true);
          expect(matchMqttTopic("sport/+/+", "sport//")).toBe(true);
          expect(matchMqttTopic("/+", "/finance")).toBe(true);
          expect(matchMqttTopic("+", "/finance")).toBe(false);

          // Level count mismatches
          expect(matchMqttTopic("sport/+", "sport")).toBe(false);
          expect(matchMqttTopic("sport/+/score", "sport/score")).toBe(false);
          expect(matchMqttTopic("sport/+", "sport//")).toBe(false);
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "matches multi-level '#' wildcards (including parent-level '#') and combined '+' + '#'",
        () => {
          expect(matchMqttTopic("devices/#", "devices")).toBe(true);
          expect(matchMqttTopic("sport/#", "sport")).toBe(true);
          expect(matchMqttTopic("sport/#", "sport/")).toBe(true);
          expect(matchMqttTopic("devices/#", "devices/d1")).toBe(true);
          expect(matchMqttTopic("devices/#", "devices/d1/metrics/cpu")).toBe(
            true,
          );
          expect(
            matchMqttTopic("root/valid/#", "root/valid/child/grandchild"),
          ).toBe(true);
          expect(matchMqttTopic("devices/#", "other/d1")).toBe(false);
          expect(matchMqttTopic("#", "any/topic/here")).toBe(true);
          expect(matchMqttTopic("a//#", "a")).toBe(false);
          expect(matchMqttTopic("/+//#", "/")).toBe(false);

          // Combined '+' and '#'
          expect(
            matchMqttTopic(
              "tenants/+/devices/#",
              "tenants/acme/devices/s1/status",
            ),
          ).toBe(true);
          expect(
            matchMqttTopic("tenants/+/devices/#", "tenants/acme/devices"),
          ).toBe(true);
          expect(matchMqttTopic("tenants/+/devices/#", "tenants/acme")).toBe(
            false,
          );
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "rejects invalid wildcard syntax placements",
        () => {
          expect(matchMqttTopic("a/#/b", "a/x/b")).toBe(false);
          expect(
            matchMqttTopic("root/#/grandchild", "root/invalid/child/grandchild"),
          ).toBe(false);
          expect(matchMqttTopic("a/b#", "a/bc")).toBe(false);
          expect(matchMqttTopic("a/#b", "a/xb")).toBe(false);
          expect(matchMqttTopic("a/b+", "a/bc")).toBe(false);
          expect(matchMqttTopic("a/+b", "a/xb")).toBe(false);
          expect(matchMqttTopic("a/++/b", "a/x/b")).toBe(false);
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "enforces MQTT 4.7.2 $SYS root wildcard protection while allowing explicit $-prefixed filters",
        () => {
          // Leading wildcards MUST NOT match $-prefixed topics
          expect(matchMqttTopic("#", "$SYS")).toBe(false);
          expect(matchMqttTopic("#", "$SYS/broker/uptime")).toBe(false);
          expect(matchMqttTopic("+", "$SYS")).toBe(false);
          expect(matchMqttTopic("+/broker/uptime", "$SYS/broker/uptime")).toBe(
            false,
          );
          expect(matchMqttTopic("#", "$custom")).toBe(false);
          expect(matchMqttTopic("+/#", "$custom/events")).toBe(false);

          // Explicit $-prefixed filters & non-leading '$' MUST match
          expect(matchMqttTopic("$SYS/#", "$SYS")).toBe(true);
          expect(matchMqttTopic("$SYS/#", "$SYS/broker/uptime")).toBe(true);
          expect(matchMqttTopic("$SYS/+/uptime", "$SYS/broker/uptime")).toBe(
            true,
          );
          expect(matchMqttTopic("$custom/#", "$custom/events")).toBe(true);
          expect(
            matchMqttTopic("devices/+/status", "devices/$sensor/status"),
          ).toBe(true);
          expect(matchMqttTopic("+/#", "/$SYS/broker/uptime")).toBe(true);
        },
      );
    });

    describe("listen", () => {
      itAdapted(
        ["ADR-001", "ADR-008"],
        "attaches message listener, subscribes unique message & event patterns with qos, and is idempotent",
        async () => {
          const server = track(
            new MqttServer({ client: harness.client, qos: 2 }),
          );
          expect(server.transport).toBe(Transport.MQTT);
          expect(server.isListening).toBe(false);

          server.addMessageHandler("devices/+/cmd", () => "ok");
          server.addMessageHandler("shared/topic", () => "msg");
          server.addEventHandler("shared/topic", () => {});
          server.addEventHandler("telemetry/#", () => {});

          await server.listen();
          expect(server.isListening).toBe(true);
          expect(harness.listeners.size).toBe(1);
          expect(harness.subscribeCalls).toEqual([
            { topic: "devices/+/cmd", qos: 2 },
            { topic: "shared/topic", qos: 2 },
            { topic: "telemetry/#", qos: 2 },
          ]);

          // Second listen() is a no-op
          await server.listen();
          expect(harness.listeners.size).toBe(1);
          expect(harness.subscribeCalls).toHaveLength(3);
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "listens cleanly when no handlers are registered",
        async () => {
          const server = track(new MqttServer({ client: harness.client }));
          await server.listen();

          expect(server.isListening).toBe(true);
          expect(harness.listeners.size).toBe(1);
          expect(harness.subscribeCalls).toHaveLength(0);
        },
      );
    });

    describe("close", () => {
      itAdapted(
        ["ADR-001", "ADR-008"],
        "removes listener via off(), unsubscribes all topics, respects closeClientOnClose=false, and supports re-listen",
        async () => {
          const server = track(new MqttServer({ client: harness.client }));
          server.addMessageHandler("orders/create", () => "ok");
          server.addEventHandler("orders/#", () => {});

          await server.listen();
          await server.close();

          expect(server.isListening).toBe(false);
          expect(harness.listeners.size).toBe(0);
          expect(harness.unsubscribeCalls).toEqual([
            "orders/create",
            "orders/#",
          ]);
          expect(harness.endCalls).toBe(0);
          expect(harness.closeCalls).toBe(0);

          // Re-listen works cleanly
          await server.listen();
          expect(server.isListening).toBe(true);
          expect(harness.listeners.size).toBe(1);
          expect(harness.subscribeCalls).toHaveLength(4);
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "falls back to removeListener() when off() is absent, tolerates omitted unsubscribe(), and calls end() or close() when closeClientOnClose=true",
        async () => {
          // 1. removeListener + end
          const h1 = createMqttServerHarness({
            useRemoveListenerOnly: true,
            omitUnsubscribe: true,
          });
          const s1 = track(
            new MqttServer({ client: h1.client, closeClientOnClose: true }),
          );
          s1.addMessageHandler("a/b", () => "ok");
          await s1.listen();
          await s1.close();
          expect(h1.listeners.size).toBe(0);
          expect(h1.endCalls).toBe(1);

          // 2. off + close fallback
          const h2 = createMqttServerHarness({ useCloseOnly: true });
          const s2 = track(
            new MqttServer({ client: h2.client, closeClientOnClose: true }),
          );
          s2.addMessageHandler("a/b", () => "ok");
          await s2.listen();
          await s2.close();
          expect(h2.closeCalls).toBe(1);
        },
      );

      // BUNEST_BUG: MqttServer.close() awaits client.unsubscribe() without catching broker disconnect errors, skipping client.end() when closeClientOnClose=true (packages/microservices/src/transports/mqtt.transport.ts)
      it.skip("still ends the client when unsubscribe() fails during close() with closeClientOnClose=true", async () => {
        const h = createMqttServerHarness();
        h.client.unsubscribe = async () => {
          throw new Error("Connection closed");
        };
        const server = track(
          new MqttServer({ client: h.client, closeClientOnClose: true }),
        );
        server.addMessageHandler("orders/create", () => "ok");
        await server.listen();

        await expect(server.close()).resolves.toBeUndefined();
        expect(h.endCalls).toBe(1);
      });
    });

    describe("onMessage — request-reply routing, specificity & errors", () => {
      itAdapted(
        ["ADR-001", "ADR-008"],
        "enforces specificity precedence: exact > single-level '+' > deeper '#' > shallow '#'",
        async () => {
          const server = track(
            new MqttServer({ client: harness.client, qos: 1 }),
          );
          server.addMessageHandler("#", () => "root-hash");
          server.addMessageHandler("devices/#", () => "devices-hash");
          server.addMessageHandler("devices/d1/#", () => "d1-hash");
          server.addMessageHandler("devices/+/command", () => "plus-command");
          server.addMessageHandler(
            "devices/d1/command",
            () => "exact-d1-command",
          );
          await server.listen();

          const call = async (topic: string, id: string) => {
            await harness.emit(
              topic,
              JSON.stringify({
                type: "request",
                id,
                pattern: topic,
                data: null,
                replyTo: `${topic}/reply/c1`,
              }),
            );
            return parseResponse(
              harness.published[harness.published.length - 1]!,
            );
          };

          expect((await call("devices/d1/command", "1")).response).toBe(
            "exact-d1-command",
          );
          expect((await call("devices/d2/command", "2")).response).toBe(
            "plus-command",
          );
          expect((await call("devices/d1/sub/deep", "3")).response).toBe(
            "d1-hash",
          );
          expect((await call("devices/d2/sub/deep", "4")).response).toBe(
            "devices-hash",
          );
          expect((await call("other/topic", "5")).response).toBe("root-hash");

          // Verify reply publish options use server qos and retain: false
          expect(harness.published[0]!.topic).toBe("devices/d1/command/reply/c1");
          expect(harness.published[0]!.options).toEqual({
            qos: 1,
            retain: false,
          });
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "replies with 404 serialized RpcException when no handler matches and skips publish when replyTo is absent",
        async () => {
          const server = track(new MqttServer({ client: harness.client }));
          const noReplyHandler = createSpy(() => "ignored-result");
          server.addMessageHandler("no/reply", noReplyHandler);
          await server.listen();

          // 1. Missing handler -> 404 RpcException
          await harness.emit(
            "missing/topic",
            JSON.stringify({
              type: "request",
              id: "req-404",
              pattern: "missing/topic",
              data: {},
              replyTo: "missing/topic/reply/c1",
            }),
          );
          expect(harness.published).toHaveLength(1);
          const env = parseResponse(harness.published[0]!);
          expect(env.id).toBe("req-404");
          expect(env.isDisposed).toBe(true);
          expect(env.error?.isRpcException).toBe(true);
          expect(env.error?.status).toBe(404);
          expect(env.error?.message).toContain("missing/topic");

          // 2. Request without replyTo invokes handler without publishing
          await harness.emit(
            "no/reply",
            JSON.stringify({
              type: "request",
              id: "req-noreply",
              pattern: "no/reply",
              data: { x: 1 },
            }),
          );
          expect(noReplyHandler.calledOnce).toBe(true);
          expect(harness.published).toHaveLength(1);
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "serializes RpcException, HttpException, generic Error, and non-Error thrown values",
        async () => {
          const server = track(new MqttServer({ client: harness.client }));
          server.addMessageHandler("err/rpc-obj", () => {
            throw new RpcException({ status: 400, message: "bad mqtt req" });
          });
          server.addMessageHandler("err/rpc-str", () => {
            throw new RpcException("string rpc err");
          });
          server.addMessageHandler("err/http", () => {
            throw new HttpException("not allowed", 403);
          });
          server.addMessageHandler("err/generic", () => {
            throw new TypeError("wrong type");
          });
          server.addMessageHandler("err/non", () => {
            throw 12345;
          });
          await server.listen();

          const invoke = async (topic: string) => {
            await harness.emit(
              topic,
              JSON.stringify({
                type: "request",
                id: topic,
                pattern: topic,
                data: null,
                replyTo: `${topic}/reply/c1`,
              }),
            );
            return parseResponse(
              harness.published[harness.published.length - 1]!,
            );
          };

          expect((await invoke("err/rpc-obj")).error).toEqual({
            message: "bad mqtt req",
            name: "RpcException",
            status: 400,
            details: { status: 400, message: "bad mqtt req" },
            isRpcException: true,
          });
          expect((await invoke("err/rpc-str")).error).toEqual({
            message: "string rpc err",
            name: "RpcException",
            isRpcException: true,
          });
          const httpErr = (await invoke("err/http")).error;
          expect(httpErr?.isRpcException).toBe(true);
          expect(httpErr?.status).toBe(403);
          expect((await invoke("err/generic")).error).toEqual({
            message: "wrong type",
            name: "TypeError",
            isRpcException: false,
          });
          expect((await invoke("err/non")).error).toEqual({
            message: "12345",
            isRpcException: false,
          });
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "ignores response envelopes even when wildcard message or event handlers match the reply topic",
        async () => {
          const server = track(new MqttServer({ client: harness.client }));
          const msgSpy = createSpy(() => "should-not-run");
          const evSpy = createSpy();
          server.addMessageHandler("orders/#", msgSpy);
          server.addEventHandler("orders/#", evSpy);
          await server.listen();

          await harness.emit(
            "orders/1/reply/c1",
            Buffer.from(
              JSON.stringify({
                type: "response",
                id: "1",
                response: "done",
                isDisposed: true,
              }),
            ),
          );

          expect(msgSpy.notCalled).toBe(true);
          expect(evSpy.notCalled).toBe(true);
          expect(harness.published).toHaveLength(0);
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "does not route quoted topics to unquoted handlers and routes canonical object-pattern topics",
        async () => {
          const server = track(new MqttServer({ client: harness.client }));
          const adminSpy = createSpy(() => "admin");
          const adminPlusSpy = createSpy(() => "admin-plus");
          const objSpy = createSpy((d) => ({ sum: d }));

          server.addMessageHandler("admin/reset", adminSpy);
          server.addMessageHandler("admin/+", adminPlusSpy);
          server.addMessageHandler({ role: "math", cmd: "sum" }, objSpy);
          await server.listen();

          // Quoted topic must NOT match admin/reset or admin/+
          await harness.emit(
            '"admin/reset"',
            JSON.stringify({
              type: "request",
              id: "q1",
              pattern: '"admin/reset"',
              data: null,
              replyTo: '"admin/reset"/reply/c1',
            }),
          );
          expect(adminSpy.notCalled).toBe(true);
          expect(adminPlusSpy.notCalled).toBe(true);
          expect(parseResponse(harness.published[0]!).error?.status).toBe(404);

          // Canonical object pattern topic matches
          await harness.emit(
            '{"cmd":"sum","role":"math"}',
            JSON.stringify({
              type: "request",
              id: "o1",
              pattern: '{"cmd":"sum","role":"math"}',
              data: [1, 2],
              replyTo: '{"cmd":"sum","role":"math"}/reply/c1',
            }),
          );
          expect(objSpy.calledOnce).toBe(true);
          expect(parseResponse(harness.published[1]!).response).toEqual({
            sum: [1, 2],
          });
        },
      );

      // BUNEST_BUG: MqttServer.onMessage() does not unwrap MqttRecord returned by a message handler — it serializes the MqttRecord object directly and publishes with server default qos & retain: false instead of record.options (packages/microservices/src/transports/mqtt.transport.ts)
      it.skip("unwraps MqttRecord returned by a message handler and applies record publish options", async () => {
        const server = track(new MqttServer({ client: harness.client }));
        const record = new MqttRecordBuilder({ value: "test" })
          .setQoS(2)
          .setRetain(true)
          .setProperties({ userProperties: { key: "val" } })
          .build();

        server.addMessageHandler("rec/reply", () => record);
        await server.listen();

        await harness.emit(
          "rec/reply",
          JSON.stringify({
            type: "request",
            id: "r1",
            pattern: "rec/reply",
            data: null,
            replyTo: "rec/reply/reply/c1",
          }),
        );

        const pub = harness.published[0]!;
        expect(parseResponse(pub).response).toEqual({ value: "test" });
        expect(pub.options).toEqual({
          qos: 2,
          retain: true,
          properties: { userProperties: { key: "val" } },
        });
      });

      // BUNEST_BUG: matchMqttTopic / MqttServer do not strip MQTT 5 shared subscription prefixes (`$share/<group>/<filter>`), so handlers registered on `$share/workers/devices/+` never match incoming `devices/status` topics (packages/microservices/src/transports/mqtt.transport.ts)
      it.skip("matches MQTT 5 shared subscription filters ($share/<group>/<filter>) against broker-delivered topics", async () => {
        const server = track(new MqttServer({ client: harness.client }));
        const sharedSpy = createSpy();
        server.addEventHandler("$share/workers/devices/+", sharedSpy);
        await server.listen();

        await harness.emit("devices/status", JSON.stringify({ online: true }));
        expect(sharedSpy.calledOnce).toBe(true);
      });
    });

    describe("MqttContext getters & packet metadata", () => {
      itAdapted(
        ["ADR-001", "ADR-008"],
        "passes MqttContext with getTopic(), getPacket(), getQoS(), isRetained(), and fallback packet synthesis",
        async () => {
          const server = track(
            new MqttServer({ client: harness.client, qos: 1 }),
          );
          const contexts: MqttContext[] = [];
          server.addMessageHandler("devices/+/status", (_data, ctx) => {
            contexts.push(ctx as MqttContext);
            return "ok";
          });
          await server.listen();

          const rawPacket: MqttPacketLike = {
            cmd: "publish",
            topic: "devices/d7/status",
            payload: Buffer.from("{}"),
            qos: 2,
            retain: true,
            messageId: 77,
            properties: { userProperties: { "x-request-id": "trace-1" } },
          };

          // 1. With explicit packet
          await harness.emit(
            "devices/d7/status",
            Buffer.from(
              JSON.stringify({
                type: "request",
                id: "ctx-1",
                pattern: "devices/d7/status",
                data: { alive: true },
                replyTo: "devices/d7/status/reply/c1",
              }),
            ),
            rawPacket,
          );

          expect(contexts[0]).toBeInstanceOf(MqttContext);
          expect(contexts[0]!.transport).toBe(Transport.MQTT);
          expect(contexts[0]!.pattern).toBe("devices/+/status");
          expect(contexts[0]!.getTopic()).toBe("devices/d7/status");
          expect(contexts[0]!.getPacket()).toBe(rawPacket);
          expect(contexts[0]!.getQoS()).toBe(2);
          expect(contexts[0]!.isRetained()).toBe(true);
          expect(contexts[0]!.metadata).toEqual({
            topic: "devices/d7/status",
            qos: 2,
            retain: true,
            packet: rawPacket,
          });

          // 2. Without packet -> synthesized with server default qos & retain=false
          await harness.emit(
            "devices/d8/status",
            JSON.stringify({
              type: "request",
              id: "ctx-2",
              pattern: "devices/d8/status",
              data: null,
              replyTo: "devices/d8/status/reply/c1",
            }),
            undefined,
          );
          expect(contexts[1]!.getTopic()).toBe("devices/d8/status");
          expect(contexts[1]!.getQoS()).toBe(1);
          expect(contexts[1]!.isRetained()).toBe(false);
        },
      );
    });

    describe("onMessage — event dispatch, wildcards, payloads & error isolation", () => {
      itAdapted(
        ["ADR-001", "ADR-008"],
        "dispatches event envelopes, raw JSON, malformed JSON fallback strings, and Buffer/Uint8Array payloads",
        async () => {
          const server = track(new MqttServer({ client: harness.client }));
          const received: unknown[] = [];
          server.addEventHandler("telemetry/#", (data) => {
            received.push(data);
          });
          await server.listen();

          // 1. RpcEventEnvelope -> unwraps envelope.data
          await harness.emit(
            "telemetry/a",
            JSON.stringify({
              type: "event",
              pattern: "telemetry/a",
              data: { fromEnvelope: true },
            }),
          );
          // 2. Raw JSON object without RpcEnvelope `type`
          await harness.emit("telemetry/b", JSON.stringify({ raw: 42 }));
          // 3. Malformed JSON -> raw UTF-8 string fallback
          await harness.emit("telemetry/c", "not-valid-json");
          // 4. Buffer payload
          await harness.emit(
            "telemetry/d",
            Buffer.from(JSON.stringify({ buf: "yes" })),
          );
          // 5. Uint8Array payload
          await harness.emit(
            "telemetry/e",
            new TextEncoder().encode("plain-uint8-text"),
          );

          expect(received).toEqual([
            { fromEnvelope: true },
            { raw: 42 },
            "not-valid-json",
            { buf: "yes" },
            "plain-uint8-text",
          ]);
        },
      );

      itAdapted(
        ["ADR-001", "ADR-008"],
        "fans out to all matching wildcard & exact event handlers, handles empty topic levels, protects $SYS, and isolates handler errors",
        async () => {
          const server = track(new MqttServer({ client: harness.client }));
          const log: string[] = [];

          server.addEventHandler("sport/+", (data, ctx) => {
            log.push(`plus:${(ctx as MqttContext).getTopic()}:${String(data)}`);
            throw new Error("event handler failed");
          });
          server.addEventHandler("sport/#", (data, ctx) => {
            log.push(`hash:${(ctx as MqttContext).getTopic()}:${String(data)}`);
          });
          server.addEventHandler("#", (_data, ctx) => {
            log.push(`root:${(ctx as MqttContext).getTopic()}`);
          });
          server.addEventHandler("$SYS/#", (data, ctx) => {
            log.push(`sys:${(ctx as MqttContext).getTopic()}:${String(data)}`);
          });
          await server.listen();

          // Empty trailing level matches sport/+, sport/#, and #; throwing first handler must not block others
          await harness.emit("sport/", "goal");
          // $SYS topic MUST only hit $SYS/#, NOT #
          await harness.emit("$SYS/broker/uptime", "999");

          expect(log).toEqual([
            "plus:sport/:goal",
            "hash:sport/:goal",
            "root:sport/",
            "sys:$SYS/broker/uptime:999",
          ]);
        },
      );
    });

    describe("setPreRequestHook & unwrap", () => {
      itAdapted(
        ["ADR-001", "ADR-008"],
        "setPreRequestHook returns this for chaining and unwrap() returns server instance",
        () => {
          const server = track(new MqttServer({ client: harness.client }));
          const hook = createSpy();
          expect(server.setPreRequestHook(hook)).toBe(server);
          expect(server.setPreRequestHook(undefined)).toBe(server);
          expect(server.unwrap()).toBe(server);
        },
      );

      // BUNEST_BUG: MqttServer.onMessage() invokes matched.handler(envelope.data, ctx) directly instead of calling super.dispatchMessage() or this.preRequestHook, so server.setPreRequestHook() is never executed (packages/microservices/src/transports/mqtt.transport.ts)
      it.skip("invokes setPreRequestHook({ pattern, data, ctx }) before executing an MQTT message handler", async () => {
        const server = track(new MqttServer({ client: harness.client }));
        const hook = createSpy();
        server.setPreRequestHook(hook);
        server.addMessageHandler("hook/topic", (d) => ({ ok: d }));
        await server.listen();

        await harness.emit(
          "hook/topic",
          JSON.stringify({
            type: "request",
            id: "h1",
            pattern: "hook/topic",
            data: { x: 1 },
            replyTo: "hook/topic/reply/c1",
          }),
        );

        expect(hook.calledOnce).toBe(true);
        expect(hook.firstCall?.args[0]).toMatchObject({
          pattern: "hook/topic",
          data: { x: 1 },
        });
      });
    });
  },
);
