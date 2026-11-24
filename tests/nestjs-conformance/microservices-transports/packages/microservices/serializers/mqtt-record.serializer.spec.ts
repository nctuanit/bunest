import { describe, expect, it } from "bun:test";
import {
  MqttClientProxy,
  MqttRecord,
  MqttRecordBuilder,
  type MqttClientLike,
  type MqttPublishOptions,
} from "../../../../../../packages/microservices/src";
import { describeConformance, itAdapted } from "../../../../_helpers";

describeConformance(
  "MqttRecordSerializer & MqttRecordBuilder",
  {
    upstreamPath:
      "packages/microservices/test/serializers/mqtt-record.serializer.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Tests Bunest's exported MqttRecord & MqttRecordBuilder fidelity alongside MQTT transport serialization; missing standalone MqttRecordSerializer class and record unwrapping in MqttClientProxy are flagged as BUNEST_BUG.",
  },
  () => {
    describe("MqttRecordBuilder", () => {
      it("should build MqttRecord with data, qos, dup, retain, and properties", () => {
        const mqttMessage = new MqttRecordBuilder()
          .setData({ value: "string" })
          .setQoS(1)
          .setDup(true)
          .setRetain(true)
          .setProperties({ userProperties: { key: "value" } })
          .build();

        expect(mqttMessage).toBeInstanceOf(MqttRecord);
        expect(mqttMessage.data).toEqual({ value: "string" });
        expect(mqttMessage.options).toEqual({
          qos: 1,
          dup: true,
          retain: true,
          properties: { userProperties: { key: "value" } },
        });
      });

      it("should preserve initial constructor data and allow chaining options without mutating prior references", () => {
        const mqttMessage = new MqttRecordBuilder({ value: "string" })
          .setQoS(2)
          .setProperties({ contentType: "application/json" })
          .build();

        expect(mqttMessage.data).toEqual({ value: "string" });
        expect(mqttMessage.options).toEqual({
          qos: 2,
          properties: { contentType: "application/json" },
        });
      });

      it("should support undefined options when only data is provided", () => {
        const record = new MqttRecordBuilder({ random: true }).build();
        expect(record).toBeInstanceOf(MqttRecord);
        expect(record.data).toEqual({ random: true });
        expect(record.options).toBeUndefined();
      });

      it("should distinguish MqttRecord instances from plain objects with matching shape", () => {
        const plain = { data: "x", options: { qos: 1 } };
        const record = new MqttRecord("x", { qos: 1 });
        expect(plain instanceof MqttRecord).toBe(false);
        expect(record instanceof MqttRecord).toBe(true);
      });
    });

    describe("MQTT client serialization behavior", () => {
      itAdapted(
        "ADR-001",
        "should JSON-serialize plain event payloads with explicit emitWithOptions()",
        async () => {
          const published: Array<{
            topic: string;
            message: string | Uint8Array;
            options?: MqttPublishOptions;
          }> = [];
          const mockClient: MqttClientLike = {
            publish(topic, message, options) {
              published.push({ topic, message, options });
            },
            subscribe() {},
            on() {},
          };
          const proxy = new MqttClientProxy({ client: mockClient });
          await proxy.emitWithOptions(
            "pattern",
            { value: "string" },
            { qos: 1, dup: true, retain: true, properties: { k: "v" } },
          );
          await proxy.close();

          expect(published).toHaveLength(1);
          expect(published[0]!.topic).toBe("pattern");
          expect(JSON.parse(String(published[0]!.message))).toEqual({
            type: "event",
            pattern: "pattern",
            data: { value: "string" },
          });
          expect(published[0]!.options).toEqual({
            qos: 1,
            dup: true,
            retain: true,
            properties: { k: "v" },
          });
        },
      );

      // BUNEST_BUG: @bunest/microservices exports MqttRecord and MqttRecordBuilder (packages/microservices/src/records.ts), but does NOT export MqttRecordSerializer and MqttClientProxy.emit()/send() do not unwrap MqttRecord instances into MQTT publish options + plain data payload (packages/microservices/src/transports/mqtt.transport.ts).
      it.skip("should export MqttRecordSerializer and unwrap MqttRecord in outgoing packets and replies", async () => {
        const mod =
          (await import("../../../../../../packages/microservices/src")) as Record<
            string,
            unknown
          >;
        const MqttRecordSerializer = mod.MqttRecordSerializer as
          (new () => { serialize(packet: unknown): unknown }) | undefined;
        expect(MqttRecordSerializer).toBeDefined();
        const instance = new MqttRecordSerializer!();

        const mqttMessage = new MqttRecordBuilder()
          .setData({ value: "string" })
          .setQoS(1)
          .setDup(true)
          .setRetain(true)
          .setProperties({})
          .build();

        expect(
          instance.serialize({ pattern: "pattern", data: mqttMessage }),
        ).toEqual(
          JSON.stringify({ pattern: "pattern", data: { value: "string" } }),
        );
        expect(
          instance.serialize({
            response: mqttMessage,
            isDisposed: true,
            id: "1",
          }),
        ).toEqual(
          JSON.stringify({
            response: { value: "string" },
            isDisposed: true,
            id: "1",
          }),
        );
        // Should not mutate record
        expect(mqttMessage.data).toEqual({ value: "string" });
        expect(mqttMessage.options?.qos).toBe(1);
        // Plain object should not be unwrapped
        const plainReply = {
          response: { data: "x", options: { qos: 1 } },
          isDisposed: true,
        };
        expect(instance.serialize(plainReply)).toBe(JSON.stringify(plainReply));
        expect(instance.serialize(undefined)).toBeUndefined();
        expect(instance.serialize(null)).toBe("null");
      });

      // BUNEST_BUG: MqttClientProxy.emit() does not unwrap MqttRecord instances into data + publish options (packages/microservices/src/transports/mqtt.transport.ts:433-449, 520-525).
      it.skip("should unwrap MqttRecord automatically when passed to MqttClientProxy.emit()", async () => {
        const published: Array<{
          topic: string;
          message: string | Uint8Array;
          options?: MqttPublishOptions;
        }> = [];
        const mockClient: MqttClientLike = {
          publish(topic, message, options) {
            published.push({ topic, message, options });
          },
          subscribe() {},
          on() {},
        };
        const proxy = new MqttClientProxy({ client: mockClient });
        const record = new MqttRecordBuilder({ value: "string" })
          .setQoS(1)
          .setRetain(true)
          .build();

        await proxy.emit("pattern", record);
        await proxy.close();

        expect(JSON.parse(String(published[0]!.message))).toEqual({
          type: "event",
          pattern: "pattern",
          data: { value: "string" },
        });
        expect(published[0]!.options?.qos).toBe(1);
        expect(published[0]!.options?.retain).toBe(true);
      });
    });
  },
);
