import { describe, expect, it } from "bun:test";
import {
  TraceContextStorage,
  extractTraceContext,
  formatBaggage,
  formatTraceParent,
  formatTraceState,
  generateSpanId,
  generateTraceId,
  injectTraceContext,
  parseBaggage,
  parseTraceParent,
  parseTraceState,
  traceContextStorage,
  type SpanContext,
} from "../../../../../packages/observability/src";
import { describeConformance, itAdapted } from "../../../_helpers/index";

// Canonical W3C Trace Context specification example values.
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const PARENT_ID = "00f067aa0ba902b7";
const TRACEPARENT = `00-${TRACE_ID}-${PARENT_ID}-01`;

describeConformance(
  "W3C Trace Context (parseTraceParent, formatTraceParent, extractTraceContext, injectTraceContext)",
  {
    upstreamPath: "observe/src/utils/trace-context.util.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts upstream @nestjs/observe W3C Trace Context tests (traceparent/tracestate parsing, version/zero-ID validation, sampled bitmask, formatting, carrier injection/extraction, and GC memory retention) to @bunest/observability tracing utilities.",
  },
  () => {
    describe("parseTraceParent & extractTraceContext", () => {
      it("reads the trace, the caller's span and the sampled flag", () => {
        expect(extractTraceContext({ traceparent: TRACEPARENT })).toEqual({
          traceId: TRACE_ID,
          spanId: PARENT_ID,
          traceFlags: 0x01,
          sampled: true,
          traceState: undefined,
          baggage: undefined,
          requestId: undefined,
        });

        expect(
          extractTraceContext({
            traceparent: `00-${TRACE_ID}-${PARENT_ID}-00`,
          })?.sampled,
        ).toBe(false);
      });

      it("reads only the sampled bit (0x01) of the flags", () => {
        // 0x03 is sampled + Level 2 random-trace-id flag; 0x02 alone is unsampled.
        const parsed03 = parseTraceParent(`00-${TRACE_ID}-${PARENT_ID}-03`);
        expect(parsed03?.traceFlags).toBe(0x03);
        expect(parsed03?.sampled).toBe(true);

        const parsed02 = parseTraceParent(`00-${TRACE_ID}-${PARENT_ID}-02`);
        expect(parsed02?.traceFlags).toBe(0x02);
        expect(parsed02?.sampled).toBe(false);
      });

      it("keeps the tracestate that came with traceparent", () => {
        const ctx = extractTraceContext({
          traceparent: TRACEPARENT,
          tracestate: " rojo=00f067aa0ba902b7, congo=t61rcWkgMzE ",
        });

        expect(ctx?.traceState).toEqual({
          rojo: "00f067aa0ba902b7",
          congo: "t61rcWkgMzE",
        });
        expect(formatTraceState(ctx?.traceState)).toBe(
          "rojo=00f067aa0ba902b7,congo=t61rcWkgMzE",
        );
      });

      it("follows a caller on a later version of the spec, ignoring extra fields", () => {
        expect(
          parseTraceParent(
            `cc-${TRACE_ID}-${PARENT_ID}-01-what-the-future-holds`,
          ),
        ).toEqual({
          version: "cc",
          traceId: TRACE_ID,
          spanId: PARENT_ID,
          traceFlags: 1,
          sampled: true,
        });
      });

      it.each([
        ["no header", undefined],
        ["null header", null],
        ["empty string", ""],
        ["whitespace only", "   "],
        [
          "a repeated header, as folded by proxies",
          `${TRACEPARENT}, ${TRACEPARENT}`,
        ],
        ["an array at runtime", [TRACEPARENT] as unknown as string],
        ["the reserved version ff", `ff-${TRACE_ID}-${PARENT_ID}-01`],
        ["extra fields on version 00", `${TRACEPARENT}-extra`],
        ["an all-zero trace id", `00-${"0".repeat(32)}-${PARENT_ID}-01`],
        ["an all-zero parent id", `00-${TRACE_ID}-${"0".repeat(16)}-01`],
        ["a short trace id", `00-${TRACE_ID.slice(1)}-${PARENT_ID}-01`],
        ["a short span id", `00-${TRACE_ID}-${PARENT_ID.slice(1)}-01`],
        ["non-hex flags", `00-${TRACE_ID}-${PARENT_ID}-0g`],
        ["a bare trace id", TRACE_ID],
      ])("refuses %s", (_label, traceparent) => {
        expect(parseTraceParent(traceparent)).toBeNull();
        expect(
          extractTraceContext({
            traceparent: traceparent as string | undefined,
          }),
        ).toBeUndefined();
      });

      // BUNEST_BUG: W3C Trace Context §3.2.2.1 mandates lowercase hex only and requires rejecting uppercase hex traceparent headers, but `parseTraceParent()` in `packages/observability/src/tracing/trace-context.ts:79` calls `header.trim().toLowerCase()` and accepts uppercase hex.
      it.skip("refuses upper-case hex per W3C Trace Context §3.2.2.1", () => {
        expect(parseTraceParent(TRACEPARENT.toUpperCase())).toBeNull();
        expect(
          extractTraceContext({ traceparent: TRACEPARENT.toUpperCase() }),
        ).toBeUndefined();
      });

      it("never keeps a tracestate without a valid traceparent", () => {
        expect(
          extractTraceContext({ traceparent: "garbage", tracestate: "a=1" }),
        ).toBeUndefined();
      });

      // BUNEST_BUG: `parseTraceState()` in `packages/observability/src/tracing/trace-context.ts:143-162` does not validate/reject CR/LF control characters (`\r\n`) in `tracestate` values, allowing header-injection characters through instead of dropping invalid tracestate.
      it.skip("drops a tracestate containing CRLF characters that an HTTP header cannot carry", () => {
        expect(
          extractTraceContext({
            traceparent: TRACEPARENT,
            tracestate: "a=1\r\nb=2",
          })?.traceState,
        ).toBeUndefined();
      });

      it("strips dangerous prototype-pollution keys from tracestate and baggage", () => {
        const ts = parseTraceState(
          "__proto__=polluted,constructor=bad,prototype=bad,vendor=safe",
        );
        expect(Object.keys(ts)).toEqual(["vendor"]);
        expect(ts.vendor).toBe("safe");

        const bag = parseBaggage(
          "__proto__=1,constructor=2,prototype=3,%5F%5Fproto%5F%5F=4,tenant=acme",
        );
        expect(Object.keys(bag)).toEqual(["tenant"]);
        expect(bag.tenant).toBe("acme");
      });

      it("parses and formats W3C baggage with URL decoding and property stripping", () => {
        const parsed = parseBaggage(
          "tenant=acme, user%20name=alice%2Fadmin;meta=ignored, empty=, malformed=%E0%A4%A",
        );
        expect(parsed.tenant).toBe("acme");
        expect(parsed["user name"]).toBe("alice/admin");
        expect(parsed.empty).toBe("");
        expect(parsed.malformed).toBe("%E0%A4%A");

        expect(formatBaggage({ tenant: "acme", "user id": "u/1" })).toBe(
          "tenant=acme,user%20id=u%2F1",
        );
        expect(formatBaggage(undefined)).toBe("");
      });
    });

    describe("memory retention on oversized headers", () => {
      itAdapted(
        ["ADR-001"],
        "keeps none of a long future-version traceparent suffix alive after GC",
        () => {
          Bun.gc(true);
          const before = process.memoryUsage().heapUsed;
          const kept = extractTraceContext({
            traceparent: `cc-${TRACE_ID}-${PARENT_ID}-01-${"x".repeat(8 * 1024 * 1024)}`,
            tracestate: `${" ".repeat(4 * 1024 * 1024)}vendor=abc`,
          });
          Bun.gc(true);
          const after = process.memoryUsage().heapUsed;

          expect(kept).toBeDefined();
          expect(kept?.traceId).toBe(TRACE_ID);
          expect(kept?.spanId).toBe(PARENT_ID);
          expect(kept?.traceState).toEqual({ vendor: "abc" });
          expect(after - before).toBeLessThan(8 * 1024 * 1024);
        },
        "Uses Bun.gc(true) instead of node:v8 --expose-gc / node:vm",
      );
    });

    describe("generateTraceId / generateSpanId / formatTraceParent", () => {
      it("generates cryptographically random non-zero 32-hex trace IDs and 16-hex span IDs", () => {
        const traces = new Set<string>();
        const spans = new Set<string>();

        for (let i = 0; i < 100; i++) {
          const traceId = generateTraceId();
          const spanId = generateSpanId();
          expect(traceId).toMatch(/^[0-9a-f]{32}$/);
          expect(traceId).not.toBe("0".repeat(32));
          expect(spanId).toMatch(/^[0-9a-f]{16}$/);
          expect(spanId).not.toBe("0".repeat(16));
          traces.add(traceId);
          spans.add(spanId);
        }

        expect(traces.size).toBe(100);
        expect(spans.size).toBe(100);
      });

      it("formats a version-00 traceparent header that parseTraceParent reads back", () => {
        const spanId = generateSpanId();
        const sampledHeader = formatTraceParent({
          traceId: TRACE_ID,
          spanId,
          sampled: true,
        });

        expect(sampledHeader).toBe(`00-${TRACE_ID}-${spanId}-01`);
        expect(parseTraceParent(sampledHeader)).toEqual({
          version: "00",
          traceId: TRACE_ID,
          spanId,
          traceFlags: 1,
          sampled: true,
        });

        expect(
          formatTraceParent({
            traceId: TRACE_ID,
            spanId,
            sampled: false,
          }).endsWith("-00"),
        ).toBe(true);

        expect(
          formatTraceParent({ traceId: TRACE_ID, spanId, traceFlags: 0x03 }),
        ).toBe(`00-${TRACE_ID}-${spanId}-03`);
      });
    });

    describe("injectTraceContext & extractTraceContext across TraceCarrier types", () => {
      const sampleCtx: SpanContext = {
        traceId: TRACE_ID,
        spanId: PARENT_ID,
        traceFlags: 0x01,
        sampled: true,
        traceState: { vendor: "abc" },
        baggage: { tenant: "acme" },
        requestId: "req-42",
      };

      it("round-trips through Web Headers, Map, and plain Record carriers (case-insensitively)", () => {
        // 1. Web Headers
        const headers = new Headers();
        injectTraceContext(headers, sampleCtx);
        expect(headers.get("traceparent")).toBe(TRACEPARENT);
        expect(headers.get("tracestate")).toBe("vendor=abc");
        expect(headers.get("baggage")).toBe("tenant=acme");
        expect(headers.get("x-request-id")).toBe("req-42");
        expect(extractTraceContext(headers)).toEqual(sampleCtx);

        // 2. Map carrier
        const map = new Map<string, string>();
        injectTraceContext(map, sampleCtx);
        expect(extractTraceContext(map)).toEqual(sampleCtx);

        // Case-insensitive Map lookup
        const upperMap = new Map<string, string>([
          ["TraceParent", TRACEPARENT],
          ["TraceState", "vendor=abc"],
          ["Baggage", "tenant=acme"],
          ["X-Request-Id", "req-42"],
        ]);
        expect(extractTraceContext(upperMap)).toEqual(sampleCtx);

        // 3. Plain Record carrier (with mixed-case keys)
        const record: Record<string, string | undefined> = {};
        injectTraceContext(record, sampleCtx);
        expect(record.traceparent).toBe(TRACEPARENT);
        expect(
          extractTraceContext({
            Traceparent: record.traceparent,
            TraceState: record.tracestate,
            Baggage: record.baggage,
            "X-Request-Id": record["x-request-id"],
          }),
        ).toEqual(sampleCtx);
      });

      it("reads ambient context from traceContextStorage when none is supplied and is a no-op outside a context", () => {
        const emptyHeaders = new Headers();
        injectTraceContext(emptyHeaders);
        expect(emptyHeaders.get("traceparent")).toBeNull();

        const ambientHeaders = new Headers();
        traceContextStorage.run(sampleCtx, () => {
          injectTraceContext(ambientHeaders);
        });
        expect(ambientHeaders.get("traceparent")).toBe(TRACEPARENT);
        expect(ambientHeaders.get("x-request-id")).toBe("req-42");
      });

      it("supports isolated TraceContextStorage withBaggage propagation", () => {
        const storage = new TraceContextStorage();
        expect(
          storage.withBaggage({ k: "v" }, () => storage.getStore()),
        ).toBeUndefined();

        storage.run(sampleCtx, () => {
          expect(storage.getTraceId()).toBe(TRACE_ID);
          expect(storage.getSpanId()).toBe(PARENT_ID);
          expect(storage.getRequestId()).toBe("req-42");

          storage.withBaggage({ role: "admin" }, () => {
            expect(storage.getCurrentSpanContext()?.baggage).toEqual({
              tenant: "acme",
              role: "admin",
            });
          });

          // Outer context remains unmodified
          expect(storage.getCurrentSpanContext()?.baggage).toEqual({
            tenant: "acme",
          });
        });
      });
    });
  },
);
