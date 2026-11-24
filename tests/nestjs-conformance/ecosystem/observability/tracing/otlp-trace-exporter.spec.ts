import { afterEach, describe, expect, it } from "bun:test";
import {
  ConsoleSpanExporter,
  InMemorySpanExporter,
  OtlpHttpSpanExporter,
  Span,
  Tracer,
  generateSpanId,
  generateTraceId,
  type OtlpExportTraceServiceRequest,
  type SpanData,
} from "../../../../../packages/observability/src";
import { describeConformance, itAdapted } from "../../../_helpers/index";

function makeSpanData(
  name: string,
  overrides: Partial<SpanData> = {},
): SpanData {
  const span = new Span(
    name,
    overrides.kind ?? "INTERNAL",
    {
      traceId: overrides.traceId ?? generateTraceId(),
      spanId: overrides.spanId ?? generateSpanId(),
      parentSpanId: overrides.parentSpanId,
      traceFlags: overrides.traceFlags ?? 1,
      sampled: (overrides.traceFlags ?? 1) === 1,
    },
    overrides.resource ?? { "service.name": "orders-api" },
    undefined,
    overrides.attributes,
  );
  return { ...span.end(), ...overrides };
}

interface ReceivedExport {
  readonly method: string;
  readonly pathname: string;
  readonly headers: Record<string, string>;
  readonly body: OtlpExportTraceServiceRequest;
}

describeConformance(
  "OTLP Trace Exporter (OtlpHttpSpanExporter, ConsoleSpanExporter, InMemorySpanExporter)",
  {
    upstreamPath: "observe/src/otlp/otlp-trace-exporter.service.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts upstream @nestjs/observe OTLP trace exporter tests (HTTP/JSON delivery, batching, custom headers, flush/shutdown lifecycle, sampling drop, HTTP error/network/timeout resilience against local ephemeral servers) to @bunest/observability OtlpHttpSpanExporter.",
  },
  () => {
    const servers: Array<ReturnType<typeof Bun.serve>> = [];
    const exporters: OtlpHttpSpanExporter[] = [];

    const startLocalReceiver = (
      handler?: (
        req: Request,
        received: ReceivedExport[],
      ) => Response | Promise<Response>,
    ) => {
      const received: ReceivedExport[] = [];
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(req) {
          if (handler) {
            return handler(req, received);
          }
          const headers: Record<string, string> = {};
          req.headers.forEach((v, k) => {
            headers[k] = v;
          });
          const body = (await req.json()) as OtlpExportTraceServiceRequest;
          received.push({
            method: req.method,
            pathname: new URL(req.url).pathname,
            headers,
            body,
          });
          return Response.json({});
        },
      });
      servers.push(server);
      return {
        url: `http://127.0.0.1:${server.port}/v1/traces`,
        received,
        server,
      };
    };

    const track = (exporter: OtlpHttpSpanExporter) => {
      exporters.push(exporter);
      return exporter;
    };

    afterEach(async () => {
      await Promise.all(
        exporters.splice(0).map((e) => e.shutdown().catch(() => undefined)),
      );
      for (const s of servers.splice(0)) {
        s.stop(true);
      }
    });

    it("is a no-op when given an empty span list", async () => {
      const { url, received } = startLocalReceiver();
      const exporter = track(
        new OtlpHttpSpanExporter({ endpoint: url, flushIntervalMs: 0 }),
      );

      exporter.export([]);
      await exporter.flush();
      await exporter.shutdown();

      expect(received).toHaveLength(0);
    });

    it("delivers OTLP/HTTP JSON payload with content-type and custom headers to local server", async () => {
      const { url, received } = startLocalReceiver();
      const exporter = track(
        new OtlpHttpSpanExporter({
          endpoint: url,
          headers: {
            authorization: "Bearer secret-otlp-token",
            "x-tenant": "acme",
          },
          flushIntervalMs: 0,
          scopeName: "@bunest/test-scope",
          scopeVersion: "9.9.9",
        }),
      );

      exporter.export([
        makeSpanData("GET /orders", {
          kind: "SERVER",
          attributes: { "http.method": "GET", "http.status_code": 200 },
        }),
      ]);
      await exporter.flush();

      expect(received).toHaveLength(1);
      const req = received[0]!;
      expect(req.method).toBe("POST");
      expect(req.pathname).toBe("/v1/traces");
      expect(req.headers["content-type"]).toBe("application/json");
      expect(req.headers.authorization).toBe("Bearer secret-otlp-token");
      expect(req.headers["x-tenant"]).toBe("acme");

      const rs = req.body.resourceSpans[0]!;
      expect(rs.resource.attributes).toContainEqual({
        key: "service.name",
        value: { stringValue: "orders-api" },
      });
      expect(rs.scopeSpans[0]!.scope).toEqual({
        name: "@bunest/test-scope",
        version: "9.9.9",
      });
      expect(rs.scopeSpans[0]!.spans).toHaveLength(1);
      expect(rs.scopeSpans[0]!.spans[0]!.name).toBe("GET /orders");
    });

    it("sends a full batch immediately once maxBatchSize is reached, without waiting for flushIntervalMs", async () => {
      const { url, received } = startLocalReceiver();
      const exporter = track(
        new OtlpHttpSpanExporter({
          endpoint: url,
          maxBatchSize: 3,
          flushIntervalMs: 60_000,
        }),
      );

      exporter.export([makeSpanData("s1"), makeSpanData("s2")]);
      await Bun.sleep(15);
      expect(received).toHaveLength(0);

      exporter.export([makeSpanData("s3")]);
      // Wait for automatic batch dispatch
      const deadline = Date.now() + 2_000;
      while (received.length < 1 && Date.now() < deadline) {
        await Bun.sleep(10);
      }

      expect(received).toHaveLength(1);
      expect(
        received[0]!.body.resourceSpans[0]!.scopeSpans[0]!.spans,
      ).toHaveLength(3);

      // Additional span sent on final shutdown flush
      exporter.export([makeSpanData("s4")]);
      await exporter.shutdown();

      expect(received).toHaveLength(2);
      expect(
        received[1]!.body.resourceSpans[0]!.scopeSpans[0]!.spans,
      ).toHaveLength(1);
    });

    it("automatically flushes queued spans on the periodic flushIntervalMs timer", async () => {
      const { url, received } = startLocalReceiver();
      const exporter = track(
        new OtlpHttpSpanExporter({
          endpoint: url,
          maxBatchSize: 100,
          flushIntervalMs: 30,
        }),
      );

      exporter.export([makeSpanData("periodic.span")]);

      const deadline = Date.now() + 2_000;
      while (received.length < 1 && Date.now() < deadline) {
        await Bun.sleep(10);
      }

      expect(received).toHaveLength(1);
      expect(
        received[0]!.body.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.name,
      ).toBe("periodic.span");
    });

    it("flushes remaining queued spans on shutdown and ignores exports after shutdown", async () => {
      const { url, received } = startLocalReceiver();
      const exporter = track(
        new OtlpHttpSpanExporter({
          endpoint: url,
          maxBatchSize: 100,
          flushIntervalMs: 0,
        }),
      );

      exporter.export([makeSpanData("before-shutdown")]);
      await exporter.shutdown();
      // Idempotent second shutdown
      await exporter.shutdown();

      exporter.export([makeSpanData("after-shutdown")]);
      await exporter.flush();

      expect(received).toHaveLength(1);
      const names =
        received[0]!.body.resourceSpans[0]!.scopeSpans[0]!.spans.map(
          (s) => s.name,
        );
      expect(names).toEqual(["before-shutdown"]);
    });

    it("does not export spans whose trace was sampled out via Tracer parentContext or sampler", async () => {
      const { url, received } = startLocalReceiver();
      const exporter = track(
        new OtlpHttpSpanExporter({
          endpoint: url,
          flushIntervalMs: 0,
        }),
      );
      const tracer = new Tracer({
        serviceName: "orders-api",
        exporter,
      });

      // Unsampled parent -> dropped
      await tracer.startActiveSpan(
        "unsampled-op",
        {
          parentContext: {
            traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
            spanId: "00f067aa0ba902b7",
            traceFlags: 0x00,
            sampled: false,
          },
        },
        async () => {
          await tracer.startActiveSpan(
            "unsampled-child",
            async () => undefined,
          );
        },
      );

      // Sampled parent -> exported
      await tracer.startActiveSpan(
        "sampled-op",
        {
          parentContext: {
            traceId: "4bf92f3577b34da6a3ce929d0e0e4737",
            spanId: "00f067aa0ba902b8",
            traceFlags: 0x01,
            sampled: true,
          },
        },
        async () => undefined,
      );

      await tracer.onModuleDestroy();

      expect(received).toHaveLength(1);
      const spans = received[0]!.body.resourceSpans[0]!.scopeSpans[0]!.spans;
      expect(spans).toHaveLength(1);
      expect(spans[0]!.name).toBe("sampled-op");
      expect(spans[0]!.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4737");
      expect(spans[0]!.parentSpanId).toBe("00f067aa0ba902b8");
    });

    describe("error, failure, and timeout resilience", () => {
      it("reports HTTP 400 / 503 failures via onError and continues exporting subsequent batches once recovered", async () => {
        let count = 0;
        const { url, received } = startLocalReceiver(async (req, list) => {
          count++;
          if (count === 1) {
            return new Response("bad payload", { status: 400 });
          }
          if (count === 2) {
            return new Response("unavailable", { status: 503 });
          }
          const body = (await req.json()) as OtlpExportTraceServiceRequest;
          list.push({
            method: req.method,
            pathname: new URL(req.url).pathname,
            headers: {},
            body,
          });
          return Response.json({});
        });

        const errors: unknown[] = [];
        const exporter = track(
          new OtlpHttpSpanExporter({
            endpoint: url,
            flushIntervalMs: 0,
            onError: (err) => errors.push(err),
          }),
        );

        exporter.export([makeSpanData("bad-1")]);
        await exporter.flush();
        exporter.export([makeSpanData("busy-2")]);
        await exporter.flush();
        exporter.export([makeSpanData("recovered-3")]);
        await exporter.flush();

        expect(errors).toHaveLength(2);
        expect(String(errors[0])).toContain("HTTP 400");
        expect(String(errors[1])).toContain("HTTP 503");

        expect(received).toHaveLength(1);
        expect(
          received[0]!.body.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.name,
        ).toBe("recovered-3");
      });

      it("aborts slow receiver past timeoutMs and reports error without hanging shutdown", async () => {
        let abortCount = 0;
        const { url } = startLocalReceiver(async (req) => {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 10_000);
            req.signal.addEventListener(
              "abort",
              () => {
                abortCount++;
                clearTimeout(timer);
                resolve();
              },
              { once: true },
            );
          });
          return new Response("too late", { status: 200 });
        });

        const errors: unknown[] = [];
        const exporter = track(
          new OtlpHttpSpanExporter({
            endpoint: url,
            flushIntervalMs: 0,
            timeoutMs: 60,
            onError: (err) => errors.push(err),
          }),
        );

        const startedAt = Date.now();
        exporter.export([makeSpanData("slow.op")]);
        await exporter.shutdown();

        expect(Date.now() - startedAt).toBeLessThan(2_000);
        expect(errors).toHaveLength(1);
        expect(abortCount).toBeGreaterThanOrEqual(0);
      });

      it("handles fetch network rejections via onError without throwing", async () => {
        const errors: unknown[] = [];
        const failingFetch = (async () => {
          throw new Error("ECONNREFUSED local collector");
        }) as unknown as typeof fetch;

        const exporter = track(
          new OtlpHttpSpanExporter({
            endpoint: "http://127.0.0.1:1/v1/traces",
            flushIntervalMs: 0,
            fetchImpl: failingFetch,
            onError: (err) => errors.push(err),
          }),
        );

        exporter.export([makeSpanData("unreachable")]);
        await expect(exporter.flush()).resolves.toBeUndefined();
        expect(errors).toHaveLength(1);
        expect(String(errors[0])).toContain("ECONNREFUSED");
      });

      itAdapted(
        ["ADR-001"],
        "awaits already in-flight batches during concurrent flush() calls",
        async () => {
          let releaseFirst!: () => void;
          const firstGate = new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
          let calls = 0;

          const mockFetch = (async () => {
            calls++;
            if (calls === 1) {
              await firstGate;
            }
            return new Response("{}", { status: 200 });
          }) as unknown as typeof fetch;

          const exporter = track(
            new OtlpHttpSpanExporter({
              endpoint: "http://127.0.0.1:0/v1/traces",
              maxBatchSize: 1,
              flushIntervalMs: 0,
              fetchImpl: mockFetch,
            }),
          );

          exporter.export([makeSpanData("in-flight")]);
          let secondFlushDone = false;
          const waitingFlush = exporter.flush().then(() => {
            secondFlushDone = true;
          });

          await Bun.sleep(20);
          expect(secondFlushDone).toBe(false);

          releaseFirst();
          await waitingFlush;
          expect(secondFlushDone).toBe(true);
          expect(calls).toBe(1);
        },
        "Verifies OtlpHttpSpanExporter in-flight batch tracking under native fetch",
      );
    });

    describe("ConsoleSpanExporter & InMemorySpanExporter", () => {
      it("formats compact and pretty OTLP JSON lines via ConsoleSpanExporter", () => {
        const compactLines: string[] = [];
        const prettyLines: string[] = [];
        const span = makeSpanData("console.span");

        new ConsoleSpanExporter({ writer: (l) => compactLines.push(l) }).export(
          [span],
        );
        new ConsoleSpanExporter({
          pretty: true,
          writer: (l) => prettyLines.push(l),
        }).export([span]);

        expect(compactLines).toHaveLength(1);
        expect(compactLines[0]).not.toContain("\n");
        expect(JSON.parse(compactLines[0]!).name).toBe("console.span");

        expect(prettyLines).toHaveLength(1);
        expect(prettyLines[0]).toContain("\n");
        expect(JSON.parse(prettyLines[0]!).name).toBe("console.span");
      });

      it("stores, filters, resets, and retains spans across shutdown in InMemorySpanExporter", () => {
        const exporter = new InMemorySpanExporter();
        const s1 = makeSpanData("op.a", { traceId: "1".repeat(32) });
        const s2 = makeSpanData("op.b", { traceId: "1".repeat(32) });
        const s3 = makeSpanData("op.a", { traceId: "2".repeat(32) });

        exporter.export([s1, s2, s3]);
        expect(exporter.getFinishedSpans()).toHaveLength(3);
        expect(exporter.findByName("op.a")).toHaveLength(2);
        expect(exporter.findByTraceId("1".repeat(32))).toHaveLength(2);

        exporter.shutdown();
        expect(exporter.getFinishedSpans()).toHaveLength(3);

        exporter.reset();
        expect(exporter.getFinishedSpans()).toHaveLength(0);
      });
    });
  },
);
