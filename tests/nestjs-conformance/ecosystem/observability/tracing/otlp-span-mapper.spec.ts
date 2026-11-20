import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import {
  InMemorySpanExporter,
  OtlpHttpSpanExporter,
  Span,
  Tracer,
  spanDataToOtlp,
  toOtlpAttributes,
  type OtlpAnyValue,
  type OtlpSpan,
  type SpanData,
  type SpanKind,
} from "../../../../../packages/observability/src";
import { describeConformance, itAdapted } from "../../../_helpers/index";

const TRACE_ID = "0193a1b2c3d47e5f8a9b0c1d2e3f4a5b";

function attributesOf(span: OtlpSpan): Record<string, OtlpAnyValue> {
  return Object.fromEntries(
    span.attributes.map(({ key, value }) => [key, value]),
  );
}

describeConformance(
  "OTLP Span Mapper (Span, spanDataToOtlp, toOtlpAttributes)",
  {
    upstreamPath: "observe/src/otlp/otlp-span.mapper.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts upstream @nestjs/observe OTLP span mapper conformance (parent-child span linkage, OTLP SpanKind/Status numeric enums, nanosecond timestamps, HTTP/DB/RPC/Queue attributes, exception events, and OTLP ExportTraceServiceRequest payload) to @bunest/observability Span & spanDataToOtlp.",
  },
  () => {
    describe("parent-child span hierarchy & kinds", () => {
      it("maps a SERVER span over its nested INTERNAL and CLIENT child spans with linked parentSpanIds", async () => {
        const memory = new InMemorySpanExporter();
        const tracer = new Tracer({
          serviceName: "orders-api",
          exporter: memory,
        });

        await tracer.startActiveSpan(
          "GET /orders/:id",
          {
            kind: "SERVER",
            attributes: {
              "http.request.method": "GET",
              "http.route": "/orders/:id",
              "http.response.status_code": 200,
              tenant: "acme",
            },
          },
          async () => {
            await tracer.startActiveSpan(
              "OrdersController.findOne",
              {
                kind: "INTERNAL",
                attributes: {
                  "code.function.name": "OrdersController.findOne",
                },
              },
              async () => {
                await tracer.startActiveSpan(
                  "OrdersService.findOne",
                  { kind: "INTERNAL" },
                  async () => {
                    await tracer.startActiveSpan(
                      "GET api.stripe.com",
                      {
                        kind: "CLIENT",
                        attributes: {
                          "http.request.method": "GET",
                          "url.full":
                            "https://api.stripe.com/v1/charges/ch_1",
                          "server.address": "api.stripe.com",
                          "server.port": 443,
                        },
                      },
                      async () => undefined,
                    );
                    await tracer.startActiveSpan(
                      "SELECT orders",
                      {
                        kind: "CLIENT",
                        attributes: {
                          "db.system": "postgresql",
                          "db.query.text":
                            'SELECT "id" FROM "orders" WHERE "id" = $1',
                        },
                      },
                      async () => undefined,
                    );
                    await tracer.startActiveSpan(
                      "price items",
                      {
                        kind: "INTERNAL",
                        attributes: {
                          "code.function.name": "OrdersService.findOne",
                          items: 3,
                        },
                      },
                      async () => undefined,
                    );
                  },
                );
              },
            );
          },
        );

        const otlpSpans = memory.getFinishedSpans().map(spanDataToOtlp);
        expect(otlpSpans).toHaveLength(6);

        const byName = new Map(otlpSpans.map((s) => [s.name, s]));
        const server = byName.get("GET /orders/:id")!;
        const controller = byName.get("OrdersController.findOne")!;
        const service = byName.get("OrdersService.findOne")!;
        const fetchSpan = byName.get("GET api.stripe.com")!;
        const query = byName.get("SELECT orders")!;
        const manual = byName.get("price items")!;

        // Single traceId across all spans
        expect(new Set(otlpSpans.map((s) => s.traceId)).size).toBe(1);
        expect(server.parentSpanId).toBeUndefined();
        expect(controller.parentSpanId).toBe(server.spanId);
        expect(service.parentSpanId).toBe(controller.spanId);
        for (const leaf of [fetchSpan, query, manual]) {
          expect(leaf.parentSpanId).toBe(service.spanId);
        }

        // OTLP SpanKind numeric enum values (INTERNAL=1, SERVER=2, CLIENT=3)
        expect(server.kind).toBe(2);
        expect(controller.kind).toBe(1);
        expect(fetchSpan.kind).toBe(3);
        expect(query.kind).toBe(3);
        expect(manual.kind).toBe(1);

        // HTTP & DB attributes encoded with typed OTLP AnyValue wrappers
        expect(attributesOf(server)).toEqual({
          "http.request.method": { stringValue: "GET" },
          "http.route": { stringValue: "/orders/:id" },
          "http.response.status_code": { intValue: "200" },
          tenant: { stringValue: "acme" },
        });
        expect(attributesOf(fetchSpan)["server.port"]).toEqual({
          intValue: "443",
        });
        expect(attributesOf(query)["db.system"]).toEqual({
          stringValue: "postgresql",
        });
        expect(attributesOf(manual).items).toEqual({ intValue: "3" });
      });

      it.each<[SpanKind, number]>([
        ["INTERNAL", 1],
        ["SERVER", 2],
        ["CLIENT", 3],
        ["PRODUCER", 4],
        ["CONSUMER", 5],
      ])("maps SpanKind %s to OTLP numeric kind %i", (kind, expected) => {
        const span = new Span(
          `op-${kind}`,
          kind,
          {
            traceId: TRACE_ID,
            spanId: "00f067aa0ba902b7",
            traceFlags: 1,
            sampled: true,
          },
          {},
        );
        const otlp = spanDataToOtlp(span.end());
        expect(otlp.kind).toBe(expected);
      });

      it("nests under a remote caller's parentSpanId and preserves traceId", async () => {
        const memory = new InMemorySpanExporter();
        const tracer = new Tracer({ exporter: memory });

        await tracer.startActiveSpan(
          "GET /orders",
          {
            kind: "SERVER",
            parentContext: {
              traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
              spanId: "00f067aa0ba902b7",
              traceFlags: 1,
              sampled: true,
              traceState: { vendor: "abc" },
            },
          },
          async () => {
            await tracer.startActiveSpan("child", async () => undefined);
          },
        );

        const otlpSpans = memory.getFinishedSpans().map(spanDataToOtlp);
        const server = otlpSpans.find((s) => s.name === "GET /orders")!;
        const child = otlpSpans.find((s) => s.name === "child")!;

        expect(server.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
        expect(server.parentSpanId).toBe("00f067aa0ba902b7");
        expect(child.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
        expect(child.parentSpanId).toBe(server.spanId);
      });
    });

    describe("timestamps & OTLP attribute encoding", () => {
      it("encodes startTimeUnixNano and endTimeUnixNano as nanosecond decimal strings", () => {
        const startMs = Date.parse("2026-10-29T12:00:00.000Z");
        const endMs = startMs + 42.5;
        const spanData: SpanData = {
          name: "timed.op",
          kind: "INTERNAL",
          traceId: TRACE_ID,
          spanId: "1111222233334444",
          traceFlags: 1,
          startTimeUnixNano: (BigInt(startMs) * 1_000_000n).toString(),
          endTimeUnixNano: (BigInt(Math.round(endMs * 1_000)) * 1_000n).toString(),
          durationMs: 42.5,
          attributes: {},
          events: [],
          status: { code: "OK" },
          resource: {},
        };

        const otlp = spanDataToOtlp(spanData);
        expect(otlp.startTimeUnixNano).toBe("1793275200000000000");
        expect(otlp.endTimeUnixNano).toBe("1793275200042500000");
        expect(
          BigInt(otlp.endTimeUnixNano) - BigInt(otlp.startTimeUnixNano),
        ).toBe(42_500_000n);
      });

      it("produces monotonic nanosecond timestamps on real Span lifecycle", async () => {
        const span = new Span(
          "real.clock",
          "INTERNAL",
          {
            traceId: TRACE_ID,
            spanId: "1111222233334444",
            traceFlags: 1,
            sampled: true,
          },
          {},
        );
        await Bun.sleep(5);
        const otlp = spanDataToOtlp(span.end());

        expect(otlp.startTimeUnixNano).toMatch(/^\d+$/);
        expect(otlp.endTimeUnixNano).toMatch(/^\d+$/);
        expect(BigInt(otlp.endTimeUnixNano)).toBeGreaterThanOrEqual(
          BigInt(otlp.startTimeUnixNano),
        );
      });

      it("encodes string, integer, double, boolean, and homogeneous array attributes to OtlpKeyValue[]", () => {
        const encoded = toOtlpAttributes({
          str: "hello",
          intVal: 42,
          negInt: -7,
          zero: 0,
          floatVal: 3.14,
          flag: true,
          off: false,
          tags: ["a", "b"],
          scores: [1, 2.5],
          flags: [true, false],
        });

        expect(encoded).toEqual([
          { key: "str", value: { stringValue: "hello" } },
          { key: "intVal", value: { intValue: "42" } },
          { key: "negInt", value: { intValue: "-7" } },
          { key: "zero", value: { intValue: "0" } },
          { key: "floatVal", value: { doubleValue: 3.14 } },
          { key: "flag", value: { boolValue: true } },
          { key: "off", value: { boolValue: false } },
          {
            key: "tags",
            value: {
              arrayValue: {
                values: [{ stringValue: "a" }, { stringValue: "b" }],
              },
            },
          },
          {
            key: "scores",
            value: {
              arrayValue: {
                values: [{ intValue: "1" }, { doubleValue: 2.5 }],
              },
            },
          },
          {
            key: "flags",
            value: {
              arrayValue: {
                values: [{ boolValue: true }, { boolValue: false }],
              },
            },
          },
        ]);
      });

      it("returns empty array for empty attributes object", () => {
        expect(toOtlpAttributes({})).toEqual([]);
      });
    });

    describe("status, events, and exception recording", () => {
      it("maps UNSET, OK, and ERROR status codes and optional status messages", () => {
        const makeSpan = (
          code: "UNSET" | "OK" | "ERROR",
          message?: string,
        ) => {
          const s = new Span(
            `status-${code}`,
            "SERVER",
            {
              traceId: TRACE_ID,
              spanId: "1111222233334444",
              traceFlags: 1,
              sampled: true,
            },
            {},
          );
          if (code !== "UNSET") {
            s.setStatus(code, message);
          }
          return spanDataToOtlp(s.end());
        };

        expect(makeSpan("UNSET").status).toEqual({ code: 0 });
        expect(makeSpan("OK").status).toEqual({ code: 1 });
        expect(makeSpan("ERROR", "items is not iterable").status).toEqual({
          code: 2,
          message: "items is not iterable",
        });
        expect(makeSpan("ERROR").status).toEqual({ code: 2 });
      });

      it("records Error exceptions as OTLP 'exception' event with type, message, and stacktrace", () => {
        const span = new Span(
          "OrdersController.findOne",
          "INTERNAL",
          {
            traceId: TRACE_ID,
            spanId: "aaaa1111bbbb2222",
            traceFlags: 1,
            sampled: true,
          },
          {},
        );

        const err = new TypeError("items is not iterable");
        span.recordException(err);
        const otlp = spanDataToOtlp(span.end());

        expect(otlp.status).toEqual({
          code: 2,
          message: "items is not iterable",
        });
        expect(otlp.events).toHaveLength(1);
        const ev = otlp.events[0]!;
        expect(ev.name).toBe("exception");
        expect(ev.timeUnixNano).toMatch(/^\d+$/);

        const evAttrs = Object.fromEntries(
          ev.attributes.map(({ key, value }) => [key, value]),
        );
        expect(evAttrs["exception.type"]).toEqual({ stringValue: "TypeError" });
        expect(evAttrs["exception.message"]).toEqual({
          stringValue: "items is not iterable",
        });
        expect(evAttrs["exception.stacktrace"]?.stringValue).toContain(
          "TypeError: items is not iterable",
        );
      });

      it("records non-Error thrown values cleanly", () => {
        const span = new Span(
          "non-error",
          "INTERNAL",
          {
            traceId: TRACE_ID,
            spanId: "aaaa1111bbbb2222",
            traceFlags: 1,
            sampled: true,
          },
          {},
        );

        span.recordException("raw failure string");
        const otlp = spanDataToOtlp(span.end());

        expect(otlp.status).toEqual({ code: 2, message: "raw failure string" });
        const evAttrs = Object.fromEntries(
          otlp.events[0]!.attributes.map(({ key, value }) => [key, value]),
        );
        expect(evAttrs["exception.type"]).toEqual({ stringValue: "string" });
        expect(evAttrs["exception.message"]).toEqual({
          stringValue: "raw failure string",
        });
        expect(evAttrs["exception.stacktrace"]).toBeUndefined();
      });

      it("maps custom span events with and without attributes", () => {
        const span = new Span(
          "events.op",
          "INTERNAL",
          {
            traceId: TRACE_ID,
            spanId: "aaaa1111bbbb2222",
            traceFlags: 1,
            sampled: true,
          },
          {},
        );

        span.addEvent("cache.miss");
        span.addEvent("db.retry", { attempt: 2, backoffMs: 12.5 });

        const otlp = spanDataToOtlp(span.end());
        expect(otlp.events).toHaveLength(2);
        expect(otlp.events[0]!.name).toBe("cache.miss");
        expect(otlp.events[0]!.attributes).toEqual([]);
        expect(otlp.events[1]!.name).toBe("db.retry");
        expect(otlp.events[1]!.attributes).toEqual([
          { key: "attempt", value: { intValue: "2" } },
          { key: "backoffMs", value: { doubleValue: 12.5 } },
        ]);
      });
    });

    describe("queue / job CONSUMER spans & RPC / GraphQL conventions", () => {
      itAdapted(
        ["ADR-001"],
        "maps a queue job CONSUMER span linked to the enqueuing trace",
        async () => {
          const memory = new InMemorySpanExporter();
          const tracer = new Tracer({ exporter: memory });

          await tracer.startActiveSpan(
            "emails send-receipt",
            {
              kind: "CONSUMER",
              parentContext: {
                traceId: TRACE_ID,
                spanId: "00f067aa0ba902b7",
                traceFlags: 1,
                sampled: true,
              },
              attributes: {
                "messaging.operation.type": "process",
                "messaging.destination.name": "emails",
                "messaging.message.id": "42",
                "job.attempts_made": 1,
                "job.wait_ms": 120,
              },
            },
            async () => {
              await tracer.startActiveSpan(
                "ReceiptsProcessor.process",
                { kind: "INTERNAL" },
                async () => undefined,
              );
            },
          );

          const [processor, run] = memory
            .getFinishedSpans()
            .map(spanDataToOtlp);
          expect(run!.name).toBe("emails send-receipt");
          expect(run!.kind).toBe(5); // CONSUMER
          expect(run!.traceId).toBe(TRACE_ID);
          expect(run!.parentSpanId).toBe("00f067aa0ba902b7");
          expect(attributesOf(run!)).toEqual({
            "messaging.operation.type": { stringValue: "process" },
            "messaging.destination.name": { stringValue: "emails" },
            "messaging.message.id": { stringValue: "42" },
            "job.attempts_made": { intValue: "1" },
            "job.wait_ms": { intValue: "120" },
          });
          expect(processor!.parentSpanId).toBe(run!.spanId);
        },
        "Models upstream jobSnapshotSpans using Bunest Tracer CONSUMER/INTERNAL spans",
      );

      it("maps RPC and GraphQL semantic attributes faithfully", () => {
        const rpcSpan = new Span(
          '{"cmd":"sum"}',
          "SERVER",
          {
            traceId: TRACE_ID,
            spanId: "1111111111111111",
            traceFlags: 1,
            sampled: true,
          },
          {},
          undefined,
          { "rpc.system": "tcp", "rpc.method": '{"cmd":"sum"}' },
        );
        rpcSpan.setStatus("ERROR", "boom");
        const rpcOtlp = rpcSpan.toOtlpSpan();
        expect(rpcOtlp.status).toEqual({ code: 2, message: "boom" });
        expect(attributesOf(rpcOtlp)).toEqual({
          "rpc.system": { stringValue: "tcp" },
          "rpc.method": { stringValue: '{"cmd":"sum"}' },
        });

        const gqlSpan = new Span(
          "Query.orders",
          "SERVER",
          {
            traceId: TRACE_ID,
            spanId: "2222222222222222",
            traceFlags: 1,
            sampled: true,
          },
          {},
          undefined,
          { "graphql.document": "{ orders { id } }", "http.route": "Query.orders" },
        );
        const gqlOtlp = gqlSpan.toOtlpSpan();
        expect(attributesOf(gqlOtlp)["graphql.document"]).toEqual({
          stringValue: "{ orders { id } }",
        });
      });
    });

    describe("Span immutability after end() & OTLP ExportTraceServiceRequest payload", () => {
      it("ignores mutations after end() and returns identical SpanData on repeated end()", () => {
        const span = new Span(
          "immutable.op",
          "INTERNAL",
          {
            traceId: TRACE_ID,
            spanId: "3333333333333333",
            traceFlags: 1,
            sampled: true,
          },
          { "service.name": "billing" },
        );
        span.setAttribute("before", "kept");
        const first = span.end();

        span.setAttribute("after", "ignored");
        span.setAttributes({ extra: 123 });
        span.addEvent("late.event");
        span.setStatus("ERROR", "too late");
        span.recordException(new Error("ignored"));
        const second = span.end();

        expect(second).toBe(first);
        expect(first.attributes).toEqual({ before: "kept" });
        expect(first.events).toHaveLength(0);
        expect(first.status).toEqual({ code: "UNSET" });
      });

      it("builds a valid OTLP ExportTraceServiceRequest envelope with resource and scope metadata", () => {
        const exporter = new OtlpHttpSpanExporter({
          endpoint: "http://127.0.0.1:0/v1/traces",
          flushIntervalMs: 0,
          scopeName: "custom-scope",
          scopeVersion: "2.3.4",
        });

        const span = new Span(
          "checkout",
          "SERVER",
          {
            traceId: TRACE_ID,
            spanId: "4444444444444444",
            traceFlags: 1,
            sampled: true,
          },
          { "service.name": "shop-api", "service.version": "1.0.0" },
        );
        const payload = exporter.buildOtlpPayload([span.end()]);

        expect(payload.resourceSpans).toHaveLength(1);
        expect(payload.resourceSpans[0]!.resource.attributes).toEqual([
          { key: "service.name", value: { stringValue: "shop-api" } },
          { key: "service.version", value: { stringValue: "1.0.0" } },
        ]);
        expect(payload.resourceSpans[0]!.scopeSpans[0]!.scope).toEqual({
          name: "custom-scope",
          version: "2.3.4",
        });
        expect(payload.resourceSpans[0]!.scopeSpans[0]!.spans).toHaveLength(1);
        expect(payload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.name).toBe(
          "checkout",
        );
      });
    });
  },
);
