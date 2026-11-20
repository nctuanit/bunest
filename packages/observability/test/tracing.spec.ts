import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import {
  Body,
  BunestFactory,
  Controller,
  Injectable,
  Module,
  Post,
} from "@bunest/core";
import {
  ConsoleSpanExporter,
  InMemorySpanExporter,
  ObservabilityLogger,
  OtlpHttpSpanExporter,
  Tracer,
  TracingModule,
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
} from "../src";

describe("Distributed Tracing, W3C Trace Context & Correlated Logging", () => {
  it("parses, validates, and formats W3C traceparent, tracestate, and baggage", () => {
    const traceId = generateTraceId();
    const spanId = generateSpanId();
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(spanId).toMatch(/^[0-9a-f]{16}$/);

    const formatted = formatTraceParent({ traceId, spanId, sampled: true });
    expect(formatted).toBe(`00-${traceId}-${spanId}-01`);

    const parsed = parseTraceParent(formatted.toUpperCase());
    expect(parsed).toEqual({
      version: "00",
      traceId,
      spanId,
      traceFlags: 1,
      sampled: true,
    });

    // Future version 01 with extra fields is accepted per W3C spec
    expect(
      parseTraceParent(`01-${traceId}-${spanId}-00-extra`)?.sampled,
    ).toBe(false);

    // Invalid traceparents MUST return null
    for (const bad of [
      "",
      null,
      undefined,
      "invalid",
      `ff-${traceId}-${spanId}-01`, // version ff forbidden
      `00-00000000000000000000000000000000-${spanId}-01`, // zero traceId
      `00-${traceId}-0000000000000000-01`, // zero spanId
      `00-${traceId}-${spanId}-01-extra`, // v00 extra fields forbidden
      `00-xyz-${spanId}-01`,
    ]) {
      expect(parseTraceParent(bad)).toBeNull();
    }

    const ts = parseTraceState("vendor1=val1, vendor2=val2");
    expect(ts).toEqual({ vendor1: "val1", vendor2: "val2" });
    expect(formatTraceState(ts)).toBe("vendor1=val1,vendor2=val2");

    const bag = parseBaggage("tenant=acme,user%20id=u%2F1;prop=ignored");
    expect(bag).toEqual({ tenant: "acme", "user id": "u/1" });
    expect(formatBaggage({ tenant: "acme" })).toBe("tenant=acme");

    // Dangerous prototype-pollution keys MUST be stripped from tracestate & baggage
    const safeTraceState = parseTraceState(
      "__proto__=1,constructor=2,prototype=3,vendor=ok",
    );
    expect(Object.keys(safeTraceState)).toEqual(["vendor"]);
    expect(safeTraceState.vendor).toBe("ok");

    const safeBaggage = parseBaggage(
      "__proto__=1,constructor=2,prototype=3,%5F%5Fproto%5F%5F=4,safe=ok",
    );
    expect(Object.keys(safeBaggage)).toEqual(["safe"]);
    expect(safeBaggage.safe).toBe("ok");
  });

  it("propagates a single W3C traceId with parent-child spans across HTTP -> DB -> async Queue job and correlates logs", async () => {
    const memoryExporter = new InMemorySpanExporter();
    const logLines: string[] = [];
    const obsLogger = new ObservabilityLogger({
      serviceName: "orders-api",
      context: "OrdersFlow",
      json: true,
      writer: (line) => logLines.push(line),
    });

    const queuedJobs: Array<{
      payload: { orderId: string };
      headers: Record<string, string>;
    }> = [];

    @Injectable()
    class FakeDbService {
      constructor(private readonly tracer: Tracer) {}

      async insertOrder(item: string) {
        return this.tracer.startActiveSpan(
          "db.insert_order",
          {
            kind: "CLIENT",
            attributes: { "db.system": "sqlite", "db.operation": "INSERT" },
          },
          async (span) => {
            await Bun.sleep(2);
            span.addEvent("row_inserted", { item });
            obsLogger.log("order persisted", {
              item,
              password: "super-secret-password",
              apiKey: "sk_secret_123",
            });
            return { orderId: "ord_101", item };
          },
        );
      }
    }

    @Injectable()
    class FakeQueueProducer {
      constructor(private readonly tracer: Tracer) {}

      async enqueueNotification(orderId: string) {
        return this.tracer.startActiveSpan(
          "queue.enqueue",
          { kind: "PRODUCER", attributes: { "messaging.system": "bunest" } },
          async () => {
            const headers: Record<string, string> = {};
            injectTraceContext(headers);
            queuedJobs.push({ payload: { orderId }, headers });
          },
        );
      }
    }

    @Controller("/orders")
    class OrdersController {
      constructor(
        private readonly db: FakeDbService,
        private readonly queue: FakeQueueProducer,
      ) {}

      @Post()
      async create(@Body() body: { item: string }) {
        const order = await this.db.insertOrder(body.item);
        await this.queue.enqueueNotification(order.orderId);
        return order;
      }
    }

    @Module({
      imports: [
        TracingModule.forRoot({
          serviceName: "orders-api",
          exporter: memoryExporter,
          registerGlobalInterceptor: true,
        }),
      ],
      controllers: [OrdersController],
      providers: [FakeDbService, FakeQueueProducer],
    })
    class OrdersAppModule {}

    const app = await BunestFactory.create(OrdersAppModule, { logger: false });
    const tracer = app.get(Tracer);

    const incomingTraceId = generateTraceId();
    const incomingSpanId = generateSpanId();
    const incomingHeader = formatTraceParent({
      traceId: incomingTraceId,
      spanId: incomingSpanId,
      sampled: true,
    });

    try {
      const res = await app.fetch(
        new Request("http://localhost/orders", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            traceparent: incomingHeader,
            "x-request-id": "req-e2e-42",
          },
          body: JSON.stringify({ item: "espresso" }),
        }),
      );

      expect(res.status).toBe(201);
      const outTraceParent = parseTraceParent(res.headers.get("traceparent"));
      expect(outTraceParent?.traceId).toBe(incomingTraceId);
      expect(res.headers.get("x-request-id")).toBe("req-e2e-42");

      // Simulate async background Queue worker picking up job outside HTTP ALS context
      expect(queuedJobs).toHaveLength(1);
      expect(traceContextStorage.getCurrentSpanContext()).toBeUndefined();

      const job = queuedJobs[0]!;
      const extractedParent = extractTraceContext(job.headers);
      expect(extractedParent?.traceId).toBe(incomingTraceId);

      await tracer.startActiveSpan(
        "queue.process_notification",
        {
          kind: "CONSUMER",
          parentContext: extractedParent,
          attributes: { "order.id": job.payload.orderId },
        },
        async () => {
          await Bun.sleep(2);
          obsLogger.child("QueueWorker").log("notification sent", {
            orderId: job.payload.orderId,
          });
        },
      );

      const spans = memoryExporter.findByTraceId(incomingTraceId);
      expect(spans).toHaveLength(4);

      const httpSpan = spans.find((s) => s.name === "HTTP POST /orders")!;
      const dbSpan = spans.find((s) => s.name === "db.insert_order")!;
      const enqueueSpan = spans.find((s) => s.name === "queue.enqueue")!;
      const workerSpan = spans.find(
        (s) => s.name === "queue.process_notification",
      )!;

      // Full parent-child hierarchy under the single traceId!
      expect(httpSpan.parentSpanId).toBe(incomingSpanId);
      expect(httpSpan.attributes["http.status_code"]).toBe(201);
      expect(dbSpan.parentSpanId).toBe(httpSpan.spanId);
      expect(enqueueSpan.parentSpanId).toBe(httpSpan.spanId);
      expect(workerSpan.parentSpanId).toBe(enqueueSpan.spanId);

      // Correlated structured JSON logs have exact traceId/spanId/requestId + secret redaction!
      expect(logLines).toHaveLength(2);
      const dbLog = JSON.parse(logLines[0]!) as Record<string, any>;
      expect(dbLog.traceId).toBe(incomingTraceId);
      expect(dbLog.spanId).toBe(dbSpan.spanId);
      expect(dbLog.requestId).toBe("req-e2e-42");
      expect(dbLog.service).toBe("orders-api");
      expect(dbLog.meta.item).toBe("espresso");
      expect(dbLog.meta.password).toBe("[REDACTED]");
      expect(dbLog.meta.apiKey).toBe("[REDACTED]");

      const workerLog = JSON.parse(logLines[1]!) as Record<string, any>;
      expect(workerLog.traceId).toBe(incomingTraceId);
      expect(workerLog.spanId).toBe(workerSpan.spanId);
      expect(workerLog.context).toBe("QueueWorker");
    } finally {
      await app.close();
    }
  });

  it("exports OpenTelemetry OTLP/HTTP JSON batches and ConsoleSpanExporter lines cleanly", async () => {
    const sentPayloads: Array<{ url: string; body: any; headers: any }> = [];
    const mockFetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      sentPayloads.push({
        url: String(input),
        headers: init?.headers,
        body: JSON.parse(String(init?.body ?? "{}")),
      });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const consoleLines: string[] = [];
    const consoleExporter = new ConsoleSpanExporter({
      writer: (line) => consoleLines.push(line),
    });
    const otlpExporter = new OtlpHttpSpanExporter({
      endpoint: "http://otel-collector.local:4318/v1/traces",
      headers: { "x-otel-key": "test" },
      maxBatchSize: 10,
      flushIntervalMs: 0,
      fetchImpl: mockFetch,
    });

    const tracer = new Tracer({
      serviceName: "billing-svc",
      serviceVersion: "1.2.3",
      exporters: [consoleExporter, otlpExporter],
    });

    await tracer.startActiveSpan("charge.card", async (span) => {
      span.setAttribute("amount", 4999);
      span.setAttribute("currency", "USD");
    });

    await tracer.flush();
    await tracer.onModuleDestroy();

    expect(consoleLines).toHaveLength(1);
    expect(JSON.parse(consoleLines[0]!).name).toBe("charge.card");

    expect(sentPayloads).toHaveLength(1);
    expect(sentPayloads[0]!.url).toBe(
      "http://otel-collector.local:4318/v1/traces",
    );
    const rs = sentPayloads[0]!.body.resourceSpans[0];
    expect(rs.resource.attributes).toContainEqual({
      key: "service.name",
      value: { stringValue: "billing-svc" },
    });
    const exportedSpan = rs.scopeSpans[0].spans[0];
    expect(exportedSpan.name).toBe("charge.card");
    expect(exportedSpan.attributes).toContainEqual({
      key: "amount",
      value: { intValue: "4999" },
    });
  });

  it("isolates async rejecting and sync throwing SpanExporters without unhandledRejection leaks", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    const healthy = new InMemorySpanExporter();
    const tracer = new Tracer({
      exporters: [
        {
          export() {
            throw new Error("sync exporter failure");
          },
        },
        {
          async export() {
            await Promise.resolve();
            throw new Error("async exporter rejection");
          },
        },
        healthy,
      ],
    });

    try {
      const value = await tracer.startActiveSpan("safe.op", async () => 42);
      expect(value).toBe(42);
      await Bun.sleep(15);
      expect(unhandled).toHaveLength(0);
      expect(healthy.findByName("safe.op")).toHaveLength(1);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });
});
