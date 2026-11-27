import { describe, expect, it } from "bun:test";
import {
  AgentErrorTraceStore,
  BunestFactory,
  ClsModule,
  ClsService,
  Controller,
  Get,
  Injectable,
  Logger,
  Module,
  Scope,
  buildAgentErrorTrace,
  diagnosticsChannel,
  getAmbientTraceparent,
  hasSubscribers,
} from "@bunest/core";
import { HttpClient } from "@bunest/core/client";
import {
  DevtoolsModule,
  DevtoolsService,
  HTTP_CLIENT_REQUEST_DIAGNOSTICS_CHANNEL,
  InMemorySpanExporter,
  JOBS_ENQUEUE_DIAGNOSTICS_CHANNEL,
  JOBS_PROCESS_DIAGNOSTICS_CHANNEL,
  MetricsModule,
  MetricsRegistry,
  ORM_QUERY_DIAGNOSTICS_CHANNEL,
  ORM_TRANSACTION_DIAGNOSTICS_CHANNEL,
  OTLP_AGGREGATION_TEMPORALITY_CUMULATIVE,
  ObservabilityLogger,
  ObservabilityModule,
  OtelAutoInstrumentation,
  OtlpHttpMetricsExporter,
  RPC_CLIENT_DIAGNOSTICS_CHANNEL,
  RPC_SERVER_DIAGNOSTICS_CHANNEL,
  Tracer,
  detectGraphCycles,
  formatTraceParent,
  renderDevtoolsHtml,
  type DevtoolsApplicationGraph,
  type OtlpExportMetricsServiceRequest,
} from "../src";

describe("Observability Wave 2 — Auto-Instrumentation, OTLP Metrics, CLS Logger & Devtools", () => {
  describe("1. Zero-Config Cross-Subsystem OTel Auto-Instrumentation", () => {
    it("subscribes to ORM, Jobs, RPC, and HttpClient diagnosticsChannel events, registers ambient traceparent, and cleans up on destroy", async () => {
      const exporter = new InMemorySpanExporter();

      @Module({
        imports: [
          ObservabilityModule.forRoot({
            tracing: { serviceName: "auto-test-svc", exporter },
            autoInstrument: true,
          }),
        ],
      })
      class AppModule {}

      const app = await BunestFactory.create(AppModule, { logger: false });
      const tracer = app.get(Tracer);
      const autoInst = app.get(OtelAutoInstrumentation);

      expect(autoInst.isActive).toBe(true);
      expect(hasSubscribers(ORM_QUERY_DIAGNOSTICS_CHANNEL)).toBe(true);
      expect(hasSubscribers(ORM_TRANSACTION_DIAGNOSTICS_CHANNEL)).toBe(true);
      expect(hasSubscribers(JOBS_ENQUEUE_DIAGNOSTICS_CHANNEL)).toBe(true);
      expect(hasSubscribers(JOBS_PROCESS_DIAGNOSTICS_CHANNEL)).toBe(true);
      expect(hasSubscribers(RPC_CLIENT_DIAGNOSTICS_CHANNEL)).toBe(true);
      expect(hasSubscribers(RPC_SERVER_DIAGNOSTICS_CHANNEL)).toBe(true);
      expect(hasSubscribers(HTTP_CLIENT_REQUEST_DIAGNOSTICS_CHANNEL)).toBe(true);

      try {
        let rootTraceId = "";
        let rootSpanId = "";
        let capturedOutboundHeader: string | null = null;
        let capturedJobTraceparent: string | undefined;

        await tracer.startActiveSpan("HTTP GET /orders", async (rootSpan) => {
          rootTraceId = rootSpan.traceId;
          rootSpanId = rootSpan.spanId;

          // Ambient traceparent provider should expose active span's W3C traceparent
          const expectedTp = formatTraceParent(rootSpan.context);
          expect(getAmbientTraceparent()).toBe(expectedTp);

          // 1a. ORM query & transaction events
          diagnosticsChannel(ORM_QUERY_DIAGNOSTICS_CHANNEL).publish({
            sql: "SELECT id, total FROM orders WHERE tenant_id = $1",
            dialect: "postgres",
            durationMs: 14.5,
            rowCount: 3,
            dataSource: "primary",
          });
          diagnosticsChannel(ORM_QUERY_DIAGNOSTICS_CHANNEL).publish({
            sql: "INSERT INTO orders (id) VALUES ($1)",
            dialect: "postgres",
            durationMs: 6.2,
            error: new Error("unique_violation"),
          });
          diagnosticsChannel(ORM_TRANSACTION_DIAGNOSTICS_CHANNEL).publish({
            phase: "begin",
            isolationLevel: "SERIALIZABLE",
          });
          diagnosticsChannel(ORM_TRANSACTION_DIAGNOSTICS_CHANNEL).publish({
            phase: "commit",
            isolationLevel: "SERIALIZABLE",
            propagation: "REQUIRED",
            durationMs: 22.1,
            dataSource: "primary",
          });

          // 1b. Jobs enqueue (inside active trace)
          capturedJobTraceparent = getAmbientTraceparent();
          diagnosticsChannel(JOBS_ENQUEUE_DIAGNOSTICS_CHANNEL).publish({
            queue: "emails",
            jobId: "job-101",
            jobName: "send-receipt",
            groupId: "tenant-a",
            traceparent: capturedJobTraceparent,
            durationMs: 2.3,
          });

          // 1c. RPC client call
          diagnosticsChannel(RPC_CLIENT_DIAGNOSTICS_CHANNEL).publish({
            phase: "end",
            kind: "request",
            pattern: "inventory.reserve",
            transport: "TCP",
            durationMs: 9.8,
            traceparent: expectedTp,
          });

          // 1d. Real @bunest/core HttpClient call (auto-injects traceparent + emits diagnosticsChannel)
          const httpClient = new HttpClient({
            fetch: (async (_input: unknown, init?: RequestInit) => {
              capturedOutboundHeader = new Headers(init?.headers).get(
                "traceparent",
              );
              return new Response(JSON.stringify({ ok: true }), {
                status: 200,
                headers: { "content-type": "application/json" },
              });
            }) as unknown as typeof fetch,
          });
          const res = await httpClient.get("https://api.example.test/v1/items");
          expect(res.status).toBe(200);
          expect(capturedOutboundHeader).toBe(expectedTp);
        });

        // Outside root span: ambient traceparent must be undefined
        expect(getAmbientTraceparent()).toBeUndefined();

        // 1e. Downstream background worker processes job & RPC server handles call (linked via traceparent!)
        diagnosticsChannel(JOBS_PROCESS_DIAGNOSTICS_CHANNEL).publish({
          queue: "emails",
          jobId: "job-101",
          jobName: "send-receipt",
          groupId: "tenant-a",
          traceparent: capturedJobTraceparent,
          durationMs: 31.4,
          status: "completed",
        });

        diagnosticsChannel(RPC_SERVER_DIAGNOSTICS_CHANNEL).publish({
          phase: "error",
          kind: "request",
          pattern: "inventory.reserve",
          transport: "TCP",
          durationMs: 4.5,
          traceparent: capturedJobTraceparent,
          error: new Error("out of stock"),
        });

        const spans = exporter.getFinishedSpans();

        const ormSelect = spans.find(
          (s) =>
            s.attributes["db.system"] === "postgres" &&
            s.attributes["db.operation"] === "SELECT",
        );
        expect(ormSelect).toBeDefined();
        expect(ormSelect?.kind).toBe("CLIENT");
        expect(ormSelect?.traceId).toBe(rootTraceId);
        expect(ormSelect?.parentSpanId).toBe(rootSpanId);
        expect(ormSelect?.attributes["db.statement"]).toContain("SELECT id, total");
        expect(ormSelect?.durationMs).toBeCloseTo(14.5, 1);
        expect(ormSelect?.status.code).toBe("OK");

        const ormErr = spans.find(
          (s) =>
            s.attributes["db.system"] === "postgres" &&
            s.attributes["db.operation"] === "INSERT",
        );
        expect(ormErr?.status.code).toBe("ERROR");
        expect(ormErr?.events.some((e) => e.name === "exception")).toBe(true);

        const ormTx = spans.find(
          (s) => s.attributes["db.operation"] === "TRANSACTION",
        );
        expect(ormTx).toBeDefined();
        expect(ormTx?.attributes["db.transaction.phase"]).toBe("commit");
        expect(ormTx?.durationMs).toBeCloseTo(22.1, 1);

        const jobProducer = spans.find((s) => s.kind === "PRODUCER");
        expect(jobProducer).toBeDefined();
        expect(jobProducer?.traceId).toBe(rootTraceId);
        expect(jobProducer?.attributes["messaging.system"]).toBe("bunest.jobs");
        expect(jobProducer?.attributes["messaging.destination.name"]).toBe("emails");
        expect(jobProducer?.attributes["bunest.job.id"]).toBe("job-101");

        const jobConsumer = spans.find((s) => s.kind === "CONSUMER");
        expect(jobConsumer).toBeDefined();
        expect(jobConsumer?.traceId).toBe(rootTraceId);
        expect(jobConsumer?.parentSpanId).toBe(rootSpanId);
        expect(jobConsumer?.attributes["messaging.system"]).toBe("bunest.jobs");
        expect(jobConsumer?.attributes["messaging.destination.name"]).toBe("emails");
        expect(jobConsumer?.durationMs).toBeCloseTo(31.4, 1);

        const rpcClientSpan = spans.find(
          (s) => s.kind === "CLIENT" && s.attributes["rpc.method"] === "inventory.reserve",
        );
        expect(rpcClientSpan?.attributes["rpc.system"]).toBe("TCP");
        expect(rpcClientSpan?.traceId).toBe(rootTraceId);

        const rpcServerSpan = spans.find(
          (s) => s.kind === "SERVER" && s.attributes["rpc.method"] === "inventory.reserve",
        );
        expect(rpcServerSpan?.traceId).toBe(rootTraceId);
        expect(rpcServerSpan?.parentSpanId).toBe(rootSpanId);
        expect(rpcServerSpan?.status.code).toBe("ERROR");

        const httpClientSpan = spans.find(
          (s) => s.attributes["url.full"] === "https://api.example.test/v1/items",
        );
        expect(httpClientSpan).toBeDefined();
        expect(httpClientSpan?.kind).toBe("CLIENT");
        expect(httpClientSpan?.traceId).toBe(rootTraceId);
        expect(httpClientSpan?.attributes["http.request.method"]).toBe("GET");
        expect(httpClientSpan?.attributes["http.response.status_code"]).toBe(200);
      } finally {
        await app.close();
      }

      // After module destroy: all subscriptions & ambient provider must be cleaned up!
      expect(autoInst.isActive).toBe(false);
      expect(hasSubscribers(ORM_QUERY_DIAGNOSTICS_CHANNEL)).toBe(false);
      expect(hasSubscribers(JOBS_ENQUEUE_DIAGNOSTICS_CHANNEL)).toBe(false);
      expect(hasSubscribers(RPC_CLIENT_DIAGNOSTICS_CHANNEL)).toBe(false);
      expect(hasSubscribers(HTTP_CLIENT_REQUEST_DIAGNOSTICS_CHANNEL)).toBe(false);
      expect(getAmbientTraceparent()).toBeUndefined();
    });

    it("supports ObservabilityModule.forRootAsync({ useFactory: () => ({ autoInstrument: true }) })", async () => {
      const exporter = new InMemorySpanExporter();

      @Module({
        imports: [
          ObservabilityModule.forRootAsync({
            useFactory: async () => ({
              tracing: { serviceName: "async-auto-svc", exporter },
              autoInstrument: true,
            }),
          }),
        ],
      })
      class AsyncAppModule {}

      const app = await BunestFactory.create(AsyncAppModule, { logger: false });
      try {
        expect(hasSubscribers(ORM_QUERY_DIAGNOSTICS_CHANNEL)).toBe(true);
        diagnosticsChannel(ORM_QUERY_DIAGNOSTICS_CHANNEL).publish({
          sql: "SELECT 1",
          dialect: "sqlite",
          durationMs: 1.2,
        });
        expect(exporter.getFinishedSpans().length).toBe(1);
        expect(exporter.getFinishedSpans()[0]?.attributes["db.system"]).toBe("sqlite");
      } finally {
        await app.close();
      }
      expect(hasSubscribers(ORM_QUERY_DIAGNOSTICS_CHANNEL)).toBe(false);
    });
  });

  describe("2. Zero-Dep OtlpHttpMetricsExporter", () => {
    it("exports Counter (sum), Gauge (gauge), and Histogram (non-cumulative bucketCounts) in OTLP/HTTP JSON format and flushes on shutdown", async () => {
      const registry = new MetricsRegistry();
      const counter = registry.createCounter({
        name: "orders_created_total",
        help: "Total created orders",
        labelNames: ["region"],
      });
      counter.inc({ region: "us-east" }, 7);

      const gauge = registry.createGauge({
        name: "active_connections",
        help: "Open connections",
        labelNames: ["pool"],
      });
      gauge.set({ pool: "primary" }, 12);

      const histogram = registry.createHistogram({
        name: "order_latency_seconds",
        help: "Order latency",
        labelNames: ["method"],
        buckets: [0.1, 0.5, 1.0],
      });
      // Buckets: <=0.1 (1), (0.1, 0.5] (2), (0.5, 1.0] (1), >1.0 (1) -> total 5
      histogram.observe({ method: "POST" }, 0.05);
      histogram.observe({ method: "POST" }, 0.2);
      histogram.observe({ method: "POST" }, 0.4);
      histogram.observe({ method: "POST" }, 0.8);
      histogram.observe({ method: "POST" }, 2.5);

      const sentRequests: Array<{
        url: string;
        headers: Record<string, string>;
        body: OtlpExportMetricsServiceRequest;
      }> = [];

      const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
        sentRequests.push({
          url: String(input),
          headers: (init?.headers as Record<string, string>) ?? {},
          body: JSON.parse(String(init?.body)) as OtlpExportMetricsServiceRequest,
        });
        return new Response("{}", { status: 200 });
      }) as typeof fetch;

      const exporter = new OtlpHttpMetricsExporter(registry, {
        endpoint: "http://otel-collector:4318/v1/metrics",
        headers: { authorization: "Bearer test-key" },
        intervalMs: 0,
        serviceName: "billing-api",
        serviceVersion: "2.1.0",
        fetchImpl: mockFetch,
      });

      await exporter.flush();
      expect(sentRequests).toHaveLength(1);
      expect(sentRequests[0]!.url).toBe("http://otel-collector:4318/v1/metrics");
      expect(sentRequests[0]!.headers["content-type"]).toBe("application/json");
      expect(sentRequests[0]!.headers.authorization).toBe("Bearer test-key");

      const rm = sentRequests[0]!.body.resourceMetrics[0]!;
      expect(
        rm.resource.attributes.find((a) => a.key === "service.name")?.value.stringValue,
      ).toBe("billing-api");
      expect(
        rm.resource.attributes.find((a) => a.key === "service.version")?.value.stringValue,
      ).toBe("2.1.0");

      const metrics = rm.scopeMetrics[0]!.metrics;
      const sumMetric = metrics.find((m) => m.name === "orders_created_total");
      expect(sumMetric?.sum?.isMonotonic).toBe(true);
      expect(sumMetric?.sum?.aggregationTemporality).toBe(
        OTLP_AGGREGATION_TEMPORALITY_CUMULATIVE,
      );
      expect(sumMetric?.sum?.dataPoints[0]?.asDouble).toBe(7);
      expect(sumMetric?.sum?.dataPoints[0]?.attributes).toEqual([
        { key: "region", value: { stringValue: "us-east" } },
      ]);

      const gaugeMetric = metrics.find((m) => m.name === "active_connections");
      expect(gaugeMetric?.gauge?.dataPoints[0]?.asDouble).toBe(12);
      expect(gaugeMetric?.gauge?.dataPoints[0]?.attributes).toEqual([
        { key: "pool", value: { stringValue: "primary" } },
      ]);

      const histMetric = metrics.find((m) => m.name === "order_latency_seconds");
      expect(histMetric?.histogram?.aggregationTemporality).toBe(
        OTLP_AGGREGATION_TEMPORALITY_CUMULATIVE,
      );
      const dp = histMetric!.histogram!.dataPoints[0]!;
      expect(dp.count).toBe("5");
      expect(dp.sum).toBeCloseTo(3.95, 5);
      expect(dp.explicitBounds).toEqual([0.1, 0.5, 1.0]);
      // Non-cumulative OTel bucketCounts: [<=0.1, (0.1,0.5], (0.5,1.0], +Inf]
      expect(dp.bucketCounts).toEqual(["1", "2", "1", "1"]);

      // Graceful shutdown performs a final flush
      counter.inc({ region: "us-east" }, 3);
      await exporter.shutdown();
      expect(sentRequests).toHaveLength(2);
      const lastSum = sentRequests[1]!.body.resourceMetrics[0]!.scopeMetrics[0]!.metrics.find(
        (m) => m.name === "orders_created_total",
      );
      expect(lastSum?.sum?.dataPoints[0]?.asDouble).toBe(10);
    });

    it("wires OtlpHttpMetricsExporter in MetricsModule and flushes gracefully on app.close()", async () => {
      let flushCalls = 0;
      const mockFetch = (async () => {
        flushCalls++;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch;

      @Module({
        imports: [
          MetricsModule.forRoot({
            exposeEndpoint: false,
            otlpExporter: {
              endpoint: "http://otel.local:4318/v1/metrics",
              intervalMs: 0,
              serviceName: "metrics-mod-svc",
              fetchImpl: mockFetch,
            },
          }),
        ],
      })
      class MetricsApp {}

      const app = await BunestFactory.create(MetricsApp, { logger: false });
      const reg = app.get(MetricsRegistry);
      reg.createCounter({ name: "jobs_done", help: "Jobs done" }).inc();
      await app.close();

      expect(flushCalls).toBe(1);
    });
  });

  describe("3. ObservabilityLogger CLS Auto-Enrichment & Global Registration", () => {
    it("merges active ClsService keys alongside traceId/spanId, redacts secrets, and wires global Logger via ObservabilityModule", async () => {
      const lines: string[] = [];
      const prevGlobal = Logger.staticInstanceRef;

      @Module({
        imports: [
          ClsModule.forRoot({ global: true }),
          ObservabilityModule.forRoot({
            tracing: { serviceName: "cls-log-svc" },
            logging: {
              serviceName: "cls-log-svc",
              clsKeys: ["tenantId", "userId", "correlationId", "apiKey"],
              registerGlobalLogger: true,
              writer: (line) => lines.push(line),
            },
          }),
        ],
      })
      class LoggingApp {}

      const app = await BunestFactory.create(LoggingApp, { logger: false });
      const cls = app.get(ClsService);
      const tracer = app.get(Tracer);
      const obsLogger = app.get(ObservabilityLogger);

      try {
        expect(Logger.staticInstanceRef).toBe(obsLogger);

        await cls.run(
          async () => {
            await tracer.startActiveSpan("checkout.submit", async () => {
              // Standard Nest-style Logger routes through global ObservabilityLogger
              const svcLogger = new Logger("CheckoutService");
              svcLogger.log("order submitted");

              // Child logger inherits clsKeys + adds persistent bindings + call fields
              const child = obsLogger.child({ component: "payments" });
              child.info(
                { orderId: "ord-9", password: "super-secret-password" },
                "payment authorized",
              );
            });
          },
          {
            tenantId: "acme-corp",
            userId: "usr-42",
            correlationId: "corr-999",
            apiKey: "sk-live-secret-12345",
          },
        );

        const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
        const orderLog = parsed.find((p) => p.message === "order submitted");
        expect(orderLog).toBeDefined();
        expect(orderLog?.tenantId).toBe("acme-corp");
        expect(orderLog?.userId).toBe("usr-42");
        expect(orderLog?.correlationId).toBe("corr-999");
        expect(orderLog?.apiKey).toBe("[REDACTED]");
        expect(typeof orderLog?.traceId).toBe("string");
        expect(typeof orderLog?.spanId).toBe("string");

        const paymentLog = parsed.find((p) => p.message === "payment authorized");
        expect(paymentLog).toBeDefined();
        expect(paymentLog?.component).toBe("payments");
        expect(paymentLog?.orderId).toBe("ord-9");
        expect(paymentLog?.tenantId).toBe("acme-corp");
        expect(paymentLog?.password).toBe("[REDACTED]");
        expect(paymentLog?.apiKey).toBe("[REDACTED]");
      } finally {
        await app.close();
      }

      // Previous global logger is restored cleanly on module destroy
      expect(Logger.staticInstanceRef).toBe(prevGlobal);
    });
  });

  describe("4. Local Devtools Upgrades — Live Error Traces & Cycle Highlighting", () => {
    it("exposes live AgentErrorTraceStore traces in /_devtools/errors, /_devtools/graph, and the HTML Errors tab", async () => {
      @Controller("/boom")
      class BoomController {
        @Get("fail")
        fail() {
          const err = new Error("Database pool exhausted") as Error & {
            code?: string;
            fixes?: string[];
          };
          err.code = "BUNEST_E901";
          throw err;
        }
      }

      const errorStore = new AgentErrorTraceStore();
      errorStore.record(
        buildAgentErrorTrace({
          method: "POST",
          path: "/orders",
          statusCode: 500,
          stage: "handler",
          controller: "OrdersController",
          handler: "create",
          error: Object.assign(new Error("Missing provider PaymentGateway"), {
            code: "BUNEST_E001",
            fixes: [
              "Add PaymentGateway to providers[] in OrdersModule",
              "Export PaymentGateway from PaymentsModule",
            ],
          }),
        }),
      );

      @Module({
        imports: [DevtoolsModule.forRoot({ enabled: true })],
        controllers: [BoomController],
        providers: [{ provide: AgentErrorTraceStore, useValue: errorStore }],
      })
      class DevtoolsErrorsApp {}

      const app = await BunestFactory.create(DevtoolsErrorsApp, { logger: false });
      try {
        // JSON /_devtools/errors endpoint
        const errorsRes = await app.fetch(
          new Request("http://localhost/_devtools/errors"),
        );
        expect(errorsRes.status).toBe(200);
        const errorsJson = (await errorsRes.json()) as {
          count: number;
          errors: Array<{
            code?: string;
            path: string;
            message: string;
            fixes?: string[];
          }>;
        };
        expect(errorsJson.count).toBe(1);
        expect(errorsJson.errors[0]?.path).toBe("/orders");
        expect(errorsJson.errors[0]?.message).toContain("PaymentGateway");

        // JSON /_devtools/graph also exposes errors & cycles arrays
        const graphRes = await app.fetch(
          new Request("http://localhost/_devtools/graph"),
        );
        const graphJson = (await graphRes.json()) as DevtoolsApplicationGraph;
        expect(graphJson.errors?.length).toBe(1);
        expect(Array.isArray(graphJson.cycles)).toBe(true);

        // HTML viewer contains Errors tab, error message, route, and suggested fixes
        const htmlRes = await app.fetch(new Request("http://localhost/_devtools"));
        expect(htmlRes.status).toBe(200);
        const html = await htmlRes.text();
        expect(html).toContain("Errors (1)");
        expect(html).toContain("/_devtools/errors");
        expect(html).toContain("panel-errors");
        expect(html).toContain("/orders");
        expect(html).toContain("Missing provider PaymentGateway");
        expect(html).toContain("OrdersController#create");
        // Zero external scripts / inline handlers
        expect(html).not.toMatch(/<script[^>]+src=/i);
        expect(html).not.toMatch(/\son(?:click|change|input|load)=/i);
      } finally {
        await app.close();
      }
    });

    it("reads error traces directly from app.enableDevDiagnostics() when attached", async () => {
      @Controller("/fault")
      class FaultController {
        @Get()
        broken() {
          throw new Error("Unexpected crash");
        }
      }

      @Module({
        imports: [DevtoolsModule.forRoot({ enabled: true })],
        controllers: [FaultController],
      })
      class LiveDiagApp {}

      const app = await BunestFactory.create(LiveDiagApp, { logger: false });
      app.enableDevDiagnostics({ allowInProduction: true });
      app.get(DevtoolsService).attachApplication(app);

      try {
        const failRes = await app.fetch(new Request("http://localhost/fault"));
        expect(failRes.status).toBe(500);

        const errorsRes = await app.fetch(
          new Request("http://localhost/_devtools/errors"),
        );
        const body = (await errorsRes.json()) as {
          count: number;
          errors: Array<{ path: string; message: string }>;
        };
        expect(body.count).toBeGreaterThanOrEqual(1);
        expect(body.errors[0]?.path).toBe("/fault");
        expect(body.errors[0]?.message).toContain("Unexpected crash");
      } finally {
        await app.close();
      }
    });

    it("detects circular module and provider dependency cycles and highlights them in red in the SVG graph", () => {
      const cyclicGraph: DevtoolsApplicationGraph = {
        generatedAt: "2026-11-27T00:00:00.000Z",
        modules: [
          {
            id: "mod-a",
            name: "AlphaModule",
            isGlobal: false,
            isDynamic: false,
            imports: ["mod-b"],
            exports: [],
            reExports: [],
            controllers: [],
            providers: ["ServiceA"],
          },
          {
            id: "mod-b",
            name: "BetaModule",
            isGlobal: false,
            isDynamic: false,
            imports: ["mod-a"],
            exports: [],
            reExports: [],
            controllers: [],
            providers: ["ServiceB"],
          },
        ],
        edges: [
          { from: "mod-a", to: "mod-b", type: "import" },
          { from: "mod-b", to: "mod-a", type: "import" },
          {
            from: "mod-a::ServiceA",
            to: "ServiceB",
            type: "provider-dependency",
          },
          {
            from: "mod-b::ServiceB",
            to: "ServiceA",
            type: "provider-dependency",
          },
        ],
        providers: [
          {
            id: "mod-a::ServiceA",
            moduleId: "mod-a",
            moduleName: "AlphaModule",
            token: "ServiceA",
            kind: "class",
            scope: Scope.SINGLETON,
            isExported: true,
            dependencies: ["ServiceB"],
          },
          {
            id: "mod-b::ServiceB",
            moduleId: "mod-b",
            moduleName: "BetaModule",
            token: "ServiceB",
            kind: "class",
            scope: Scope.SINGLETON,
            isExported: true,
            dependencies: ["ServiceA"],
          },
        ],
        controllers: [],
        routes: [],
      };

      const cycles = detectGraphCycles(cyclicGraph);
      expect(cycles).toHaveLength(2);
      expect(cycles.some((c) => c.kind === "module" && c.labels.includes("AlphaModule"))).toBe(
        true,
      );
      expect(cycles.some((c) => c.kind === "provider" && c.labels.includes("ServiceA"))).toBe(
        true,
      );

      const html = renderDevtoolsHtml(cyclicGraph, { basePath: "/_devtools" });
      expect(html).toContain("dg-cycle");
      expect(html).toContain("dg-edge-cycle");
      expect(html).toContain('data-cycle="true"');
      expect(html).toContain("url(#arrow-cycle)");
      expect(html).toContain("Circular dependencies detected (2)");
      expect(html).toContain("AlphaModule → BetaModule → AlphaModule");
      expect(html).toContain("ServiceA → ServiceB → ServiceA");
    });
  });
});
