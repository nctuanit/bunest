import { describe, expect, it } from "bun:test";
import {
  NatsClientProxy,
  NatsRecord,
  NatsRecordBuilder,
  type NatsTransportClientLike,
} from "../../../../../../packages/microservices/src";
import { describeConformance, itAdapted } from "../../../../_helpers";

describeConformance(
  "NatsRecordSerializer & NatsRecordBuilder",
  {
    upstreamPath:
      "packages/microservices/test/serializers/nats-record.serializer.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Tests Bunest's exported NatsRecord & NatsRecordBuilder across all payload primitives/objects/Buffers and headers; missing standalone NatsRecordSerializer class and record unwrapping in NatsClientProxy are flagged as BUNEST_BUG.",
  },
  () => {
    describe("NatsRecordBuilder", () => {
      it("should build NatsRecord for undefined, null, string, number, Buffer, array, and object payloads", () => {
        const cases: Array<[string, unknown]> = [
          ["undefined", undefined],
          ["null", null],
          ["string", "string"],
          ["number", 12345],
          ["buffer", Buffer.from("buffer")],
          ["array", [1, 2, 3, 4, 5]],
          ["object", { prop: "value" }],
        ];

        for (const [, payload] of cases) {
          const rec = new NatsRecordBuilder().setData(payload).build();
          expect(rec).toBeInstanceOf(NatsRecord);
          expect(rec.data).toEqual(payload);
          expect(rec.headers).toBeUndefined();
        }
      });

      it("should attach custom headers via setHeaders() without mutating the headers reference", () => {
        const headers = { "1": "header_1", "x-response": "enabled" };
        const natsMessage = new NatsRecordBuilder()
          .setHeaders(headers)
          .setData({ value: "string" })
          .build();

        expect(natsMessage).toBeInstanceOf(NatsRecord);
        expect(natsMessage.data).toEqual({ value: "string" });
        expect(natsMessage.headers).toBe(headers);
      });

      it("should accept initial data in constructor and allow chaining setHeaders()", () => {
        const headers = { "x-trace-id": "tr-1" };
        const rec = new NatsRecordBuilder({ value: "string" })
          .setHeaders(headers)
          .build();

        expect(rec.data).toEqual({ value: "string" });
        expect(rec.headers).toBe(headers);
      });

      it("should distinguish NatsRecord instances from plain objects with data/headers properties", () => {
        const plain = { data: "x", headers: { "x-response": "enabled" } };
        const record = new NatsRecord("x", { "x-response": "enabled" });
        expect(plain instanceof NatsRecord).toBe(false);
        expect(record instanceof NatsRecord).toBe(true);
      });
    });

    describe("NATS client serialization behavior", () => {
      itAdapted(
        "ADR-001",
        "should JSON-serialize primitive, Buffer, array, and object event payloads via NatsClientProxy.emit()",
        async () => {
          const published: Array<{
            subject: string;
            data: string | Uint8Array;
          }> = [];
          const mockNats: NatsTransportClientLike = {
            publish(subject, data) {
              published.push({ subject, data });
            },
            subscribe() {},
          };
          const proxy = new NatsClientProxy({ client: mockNats });

          const payloads: unknown[] = [
            undefined,
            null,
            "string",
            12345,
            Buffer.from("buffer"),
            [1, 2, 3, 4, 5],
            { prop: "value" },
          ];
          for (const data of payloads) {
            await proxy.emit("events.test", data);
          }
          await proxy.close();

          expect(published).toHaveLength(payloads.length);
          for (let i = 0; i < payloads.length; i++) {
            expect(published[i]!.subject).toBe("events.test");
            expect(published[i]!.data).toBe(
              JSON.stringify({
                type: "event",
                pattern: "events.test",
                data: payloads[i],
              }),
            );
          }
        },
      );

      it("should export NatsRecordSerializer and unwrap NatsRecord packets and replies with headers", async () => {
        const mod =
          (await import("../../../../../../packages/microservices/src")) as Record<
            string,
            unknown
          >;
        const NatsRecordSerializer = mod.NatsRecordSerializer as
          | (new () => {
              serialize(packet: unknown): {
                headers: unknown;
                data: string | Uint8Array;
              };
            })
          | undefined;
        expect(NatsRecordSerializer).toBeDefined();
        const instance = new NatsRecordSerializer!();

        const natsHeaders = { "1": "header_1" };
        const natsMessage = new NatsRecordBuilder()
          .setHeaders(natsHeaders)
          .setData({ value: "string" })
          .build();

        expect(instance.serialize({ data: natsMessage })).toEqual({
          headers: natsHeaders,
          data: JSON.stringify({ data: { value: "string" } }),
        });

        expect(
          instance.serialize({
            response: natsMessage,
            isDisposed: true,
            id: "1",
          }),
        ).toEqual({
          headers: natsHeaders,
          data: JSON.stringify({
            response: { value: "string" },
            isDisposed: true,
            id: "1",
          }),
        });

        // Should not mutate unwrapped record
        expect(natsMessage.data).toEqual({ value: "string" });
        expect(natsMessage.headers).toBe(natsHeaders);
        // Undefined and null packets
        expect(instance.serialize(undefined)).toEqual({
          headers: undefined,
          data: JSON.stringify({}),
        });
        expect(instance.serialize(null)).toEqual({
          headers: undefined,
          data: JSON.stringify({ data: undefined }),
        });
      });

      it("should unwrap NatsRecord data and forward headers in NatsClientProxy.emit()", async () => {
        const published: Array<{
          subject: string;
          data: string | Uint8Array;
          options?: Record<string, unknown>;
        }> = [];
        const mockNats: NatsTransportClientLike = {
          publish(subject, data, options) {
            published.push({ subject, data, options });
          },
          subscribe() {},
        };
        const proxy = new NatsClientProxy({ client: mockNats });
        const record = new NatsRecordBuilder({ value: "string" })
          .setHeaders({ "x-custom": "1" })
          .build();

        await proxy.emit("subj", record);
        await proxy.close();

        expect(JSON.parse(String(published[0]!.data))).toEqual({
          type: "event",
          pattern: "subj",
          data: { value: "string" },
        });
        expect(
          (published[0]!.options as { headers?: Record<string, string> })
            ?.headers,
        ).toEqual({ "x-custom": "1" });
      });
    });
  },
);
