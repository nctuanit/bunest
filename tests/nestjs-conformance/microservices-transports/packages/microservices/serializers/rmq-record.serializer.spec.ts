import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import {
  RabbitMqClientProxy,
  RmqRecord,
  RmqRecordBuilder,
  type RabbitMqChannelLike,
  type RmqRecordOptions,
} from "../../../../../../packages/microservices/src";
import {
  describeConformance,
  itAdapted,
} from "../../../../_helpers";

describeConformance(
  "RmqRecordSerializer & RmqRecordBuilder",
  {
    upstreamPath:
      "packages/microservices/test/serializers/rmq-record.serializer.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Tests Bunest's exported RmqRecord & RmqRecordBuilder fidelity; missing standalone RmqRecordSerializer class and RmqRecord unwrapping in RabbitMqClientProxy are flagged as BUNEST_BUG.",
  },
  () => {
    describe("RmqRecordBuilder", () => {
      it("should build RmqRecord instance with data and options", () => {
        const options: RmqRecordOptions = {
          appId: "app",
          persistent: true,
          priority: 5,
          headers: { key: "value" },
          expiration: "60000",
          contentType: "application/json",
          messageId: "msg-1",
        };
        const rmqMessage = new RmqRecordBuilder()
          .setData({ value: "string" })
          .setOptions(options)
          .build();

        expect(rmqMessage).toBeInstanceOf(RmqRecord);
        expect(rmqMessage.data).toEqual({ value: "string" });
        expect(rmqMessage.options).toBe(options);
      });

      it("should accept initial data in constructor and preserve options reference", () => {
        const options: RmqRecordOptions = {
          priority: 5,
          headers: { key: "value" },
        };
        const rmqMessage = new RmqRecordBuilder({ value: "string" })
          .setOptions(options)
          .build();

        expect(rmqMessage.data).toEqual({ value: "string" });
        expect(rmqMessage.options).toBe(options);
      });

      it("should allow building a record with no options", () => {
        const record = new RmqRecordBuilder({ random: true }).build();
        expect(record).toBeInstanceOf(RmqRecord);
        expect(record.data).toEqual({ random: true });
        expect(record.options).toBeUndefined();
      });

      it("should distinguish RmqRecord instances from plain objects with matching keys", () => {
        const plain = { data: "x", options: { priority: 1 } };
        const record = new RmqRecord("x", { priority: 1 });
        expect(plain instanceof RmqRecord).toBe(false);
        expect(record instanceof RmqRecord).toBe(true);
      });
    });

    describe("RabbitMQ client serialization behavior", () => {
      itAdapted(
        "ADR-001",
        "should JSON-serialize plain event payloads via RabbitMqClientProxy.emit()",
        async () => {
          const sent: Array<{
            queue: string;
            content: Uint8Array | string;
            options?: Record<string, unknown>;
          }> = [];
          const mockChannel: RabbitMqChannelLike = {
            assertQueue: (queue) => ({ queue }),
            consume: () => ({ consumerTag: "ctag" }),
            sendToQueue(queue, content, options) {
              sent.push({ queue, content, options });
              return true;
            },
          };
          const proxy = new RabbitMqClientProxy({
            channel: mockChannel,
            queue: "test-queue",
          });
          await proxy.emit("test", { random: true });
          await proxy.close();

          expect(sent).toHaveLength(1);
          expect(sent[0]!.queue).toBe("test-queue");
          expect(JSON.parse(String(sent[0]!.content))).toEqual({
            type: "event",
            pattern: "test",
            data: { random: true },
          });
        },
      );

      // BUNEST_BUG: @bunest/microservices exports RmqRecord and RmqRecordBuilder (packages/microservices/src/records.ts), but does NOT export RmqRecordSerializer (needed for NestJS serializer parity).
      it.skip("should export RmqRecordSerializer and unwrap RmqRecord in request and reply packets", async () => {
        const mod = (await import(
          "../../../../../../packages/microservices/src"
        )) as Record<string, unknown>;
        const RmqRecordSerializer = mod.RmqRecordSerializer as
          | (new () => { serialize(packet: unknown): unknown })
          | undefined;
        expect(RmqRecordSerializer).toBeDefined();
        const instance = new RmqRecordSerializer!();

        const rmqMessage = new RmqRecordBuilder()
          .setData({ value: "string" })
          .setOptions({ appId: "app", persistent: true })
          .build();

        expect(instance.serialize({ pattern: "test", data: rmqMessage })).toEqual(
          {
            pattern: "test",
            options: { appId: "app", persistent: true },
            data: { value: "string" },
          },
        );

        const plainPacket = { pattern: "test", data: { random: true } };
        expect(instance.serialize(plainPacket)).toBe(plainPacket);
        expect(instance.serialize(undefined)).toBeUndefined();
        expect(instance.serialize(null)).toBeNull();

        const replyRecord = new RmqRecordBuilder({ value: "string" })
          .setOptions({ priority: 5, headers: { key: "value" } })
          .build();
        expect(
          instance.serialize({ response: replyRecord, isDisposed: true }),
        ).toEqual({
          response: { value: "string" },
          isDisposed: true,
          options: { priority: 5, headers: { key: "value" } },
        });
        expect(replyRecord.data).toEqual({ value: "string" });
      });

      // BUNEST_BUG: RabbitMqClientProxy.emit() and send() do not unwrap RmqRecord instances into sendToQueue options and unwrapped data payload (packages/microservices/src/transports/broker.transports.ts:597-650).
      it.skip("should unwrap RmqRecord data and forward AMQP options in RabbitMqClientProxy.emit()", async () => {
        const sent: Array<{
          queue: string;
          content: Uint8Array | string;
          options?: Record<string, unknown>;
        }> = [];
        const mockChannel: RabbitMqChannelLike = {
          assertQueue: (queue) => ({ queue }),
          consume: () => ({ consumerTag: "ctag" }),
          sendToQueue(queue, content, options) {
            sent.push({ queue, content, options });
            return true;
          },
        };
        const proxy = new RabbitMqClientProxy({
          channel: mockChannel,
          queue: "test-queue",
        });
        const record = new RmqRecordBuilder({ value: "string" })
          .setOptions({ persistent: true, priority: 5 })
          .build();

        await proxy.emit("test", record);
        await proxy.close();

        expect(JSON.parse(String(sent[0]!.content))).toEqual({
          type: "event",
          pattern: "test",
          data: { value: "string" },
        });
        expect(sent[0]!.options).toMatchObject({
          persistent: true,
          priority: 5,
        });
      });
    });
  },
);
