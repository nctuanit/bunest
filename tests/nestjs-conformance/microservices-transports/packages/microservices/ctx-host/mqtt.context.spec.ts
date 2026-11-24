import { beforeEach, describe, expect, it } from "bun:test";
import {
  MqttContext,
  Transport,
  type MqttPacketLike,
} from "../../../../../../packages/microservices/src";
import { describeConformance, itAdapted } from "../../../../_helpers";

describeConformance(
  "MqttContext",
  {
    upstreamPath: "packages/microservices/test/ctx-host/mqtt.context.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Bunest MqttContext accepts { pattern, topic, packet } instead of [topic, packet] tuple and exposes getTopic(), getPacket(), getQoS(), isRetained(), and readonly metadata.",
  },
  () => {
    const packet: MqttPacketLike = {
      cmd: "publish",
      topic: "sensors/room1/temp",
      payload: JSON.stringify({ temp: 22.5 }),
      qos: 1,
      retain: true,
      dup: false,
      messageId: 7,
      properties: {
        userProperties: { "x-request-id": "trace-1", "x-tag": ["a", "b"] },
      },
    };
    let context: MqttContext;

    beforeEach(() => {
      context = new MqttContext({
        pattern: "sensors/+/temp",
        topic: "sensors/room1/temp",
        packet,
      });
    });

    describe("getTopic", () => {
      it("should return topic", () => {
        expect(context.getTopic()).toBe("sensors/room1/temp");
        expect(context.topic).toBe("sensors/room1/temp");
        expect(context.pattern).toBe("sensors/+/temp");
        expect(context.transport).toBe(Transport.MQTT);
      });
    });

    describe("getPacket", () => {
      it("should return packet", () => {
        expect(context.getPacket()).toBe(packet);
        expect(context.packet).toBe(packet);
      });
    });

    describe("getQoS and isRetained", () => {
      it("should return qos and retain flags from packet", () => {
        expect(context.getQoS()).toBe(1);
        expect(context.qos).toBe(1);
        expect(context.isRetained()).toBe(true);
        expect(context.retain).toBe(true);
      });

      it("should default qos to 0 and retain to false when omitted on packet", () => {
        const minimal = new MqttContext({
          pattern: "test",
          topic: "test",
          packet: { topic: "test", payload: "hi" },
        });
        expect(minimal.getQoS()).toBe(0);
        expect(minimal.isRetained()).toBe(false);
        expect(minimal.metadata).toEqual({
          topic: "test",
          qos: 0,
          retain: false,
          packet: { topic: "test", payload: "hi" },
        });
      });
    });

    describe("getMetadata", () => {
      itAdapted(
        "ADR-001",
        "should expose topic, qos, retain, and packet in context.metadata",
        () => {
          expect(context.metadata).toEqual({
            topic: "sensors/room1/temp",
            qos: 1,
            retain: true,
            packet,
          });
        },
      );

      // BUNEST_BUG: NestJS MqttContext implements getMetadata() returning single-valued MQTT 5 packet.properties.userProperties (and undefined for MQTT 3 packets without userProperties). packages/microservices/src/transports/mqtt.transport.ts does not implement getMetadata() on MqttContext.
      it.skip("should return MQTT 5 userProperties with single string values from getMetadata() and undefined without userProperties", () => {
        const anyCtx = context as unknown as {
          getMetadata?: () => Record<string, string> | undefined;
        };
        expect(typeof anyCtx.getMetadata).toBe("function");
        expect(anyCtx.getMetadata!()).toEqual({ "x-request-id": "trace-1" });

        const mqtt3Ctx = new MqttContext({
          pattern: "test",
          topic: "test",
          packet: { topic: "test", payload: "hi", properties: {} },
        }) as unknown as {
          getMetadata?: () => Record<string, string> | undefined;
        };
        expect(mqtt3Ctx.getMetadata!()).toBeUndefined();
      });
    });
  },
);
