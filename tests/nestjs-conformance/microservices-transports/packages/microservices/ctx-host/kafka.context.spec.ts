import { beforeEach, describe, expect, it } from "bun:test";
import {
  KafkaContext,
  Transport,
  type KafkaHeaderMap,
  type KafkaMessageLike,
} from "../../../../../../packages/microservices/src";
import {
  createSpy,
  describeConformance,
  itAdapted,
} from "../../../../_helpers";

describeConformance(
  "KafkaContext",
  {
    upstreamPath: "packages/microservices/test/ctx-host/kafka.context.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Bunest KafkaContext accepts a structured params object instead of a 6-7 element kafkajs tuple and exposes getTopic/getPartition/getOffset/getKey/getHeaders/getMessage/heartbeat/commitOffset.",
  },
  () => {
    const rawMessage: KafkaMessageLike = {
      key: "order-1",
      value: JSON.stringify({ amount: 42 }),
      headers: { "x-request-id": "trace-1", "x-tenant": Buffer.from("acme") },
      offset: "17",
      timestamp: "1700000000000",
    };
    const rawHeaders: KafkaHeaderMap = {
      "x-request-id": "trace-1",
      "x-tenant": Buffer.from("acme"),
    };
    const normalizedHeaders: Readonly<Record<string, string>> = {
      "x-request-id": "trace-1",
      "x-tenant": "acme",
    };

    let heartbeatSpy: ReturnType<typeof createSpy<() => Promise<void>>>;
    let commitOffsetSpy: ReturnType<typeof createSpy<() => Promise<void>>>;
    let context: KafkaContext;

    beforeEach(() => {
      heartbeatSpy = createSpy(async () => {});
      commitOffsetSpy = createSpy(async () => {});
      context = new KafkaContext({
        pattern: "orders.created",
        topic: "orders.created",
        partition: 3,
        offset: "17",
        key: "order-1",
        headers: normalizedHeaders,
        rawHeaders,
        rawMessage,
        heartbeat: heartbeatSpy,
        commitOffset: commitOffsetSpy,
      });
    });

    describe("getTopic", () => {
      it("should return topic", () => {
        expect(context.getTopic()).toBe("orders.created");
        expect(context.topic).toBe("orders.created");
        expect(context.transport).toBe(Transport.KAFKA);
        expect(context.pattern).toBe("orders.created");
      });
    });

    describe("getPartition", () => {
      it("should return partition", () => {
        expect(context.getPartition()).toBe(3);
        expect(context.partition).toBe(3);
      });
    });

    describe("getMessage", () => {
      it("should return original message", () => {
        expect(context.getMessage()).toBe(rawMessage);
        expect(context.rawMessage).toBe(rawMessage);
      });
    });

    describe("getOffset / getKey / getHeaders", () => {
      it("should return offset, key, normalized headers, and rawHeaders", () => {
        expect(context.getOffset()).toBe("17");
        expect(context.getKey()).toBe("order-1");
        expect(context.getHeaders()).toEqual({
          "x-request-id": "trace-1",
          "x-tenant": "acme",
        });
        expect(context.rawHeaders).toBe(rawHeaders);
      });

      it("should support null key", () => {
        const ctxNullKey = new KafkaContext({
          pattern: "events",
          topic: "events",
          partition: 0,
          offset: "0",
          key: null,
          headers: {},
          rawHeaders: {},
          rawMessage: { value: null },
          commitOffset: async () => {},
        });
        expect(ctxNullKey.getKey()).toBeNull();
      });
    });

    describe("heartbeat and commitOffset", () => {
      itAdapted(
        "ADR-001",
        "should invoke heartbeat callback via async heartbeat() method",
        async () => {
          await context.heartbeat();
          expect(heartbeatSpy.calledOnce).toBe(true);
        },
      );

      it("should gracefully no-op heartbeat() when heartbeat callback is omitted", async () => {
        const ctxNoHeartbeat = new KafkaContext({
          pattern: "t",
          topic: "t",
          partition: 0,
          offset: "0",
          key: null,
          headers: {},
          rawHeaders: {},
          rawMessage: { value: "x" },
          commitOffset: commitOffsetSpy,
        });
        await expect(ctxNoHeartbeat.heartbeat()).resolves.toBeUndefined();
      });

      it("should invoke commitOffset callback via commitOffset()", async () => {
        await context.commitOffset();
        expect(commitOffsetSpy.calledOnce).toBe(true);
      });
    });

    describe("metadata", () => {
      itAdapted(
        "ADR-001",
        "should expose topic, partition, offset, key, and headers on metadata property",
        () => {
          expect(context.metadata).toEqual({
            topic: "orders.created",
            partition: 3,
            offset: "17",
            key: "order-1",
            headers: {
              "x-request-id": "trace-1",
              "x-tenant": "acme",
            },
          });
        },
      );

      // BUNEST_BUG: NestJS KafkaContext exposes getMetadata(), getConsumer(), getProducer(), and getHeartbeat() methods (packages/microservices/src/transports/kafka.transport.ts lacks these methods on KafkaContext).
      it.skip("should expose NestJS KafkaContext getConsumer(), getProducer(), getHeartbeat(), and getMetadata() methods", () => {
        const anyCtx = context as unknown as Record<string, unknown>;
        expect(typeof anyCtx.getConsumer).toBe("function");
        expect(typeof anyCtx.getProducer).toBe("function");
        expect(typeof anyCtx.getHeartbeat).toBe("function");
        expect(typeof anyCtx.getMetadata).toBe("function");
      });
    });
  },
);
