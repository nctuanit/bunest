import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { Controller, Get, Injectable, Module } from "@bunest/common";
import { BunestFactory } from "@bunest/core";
import {
  admitsSeries,
  CALLER_METADATA_KEY,
  Counter,
  createObserveModule,
  defaultTraceIdGenerator,
  Gauge,
  JOB_TRACE_CONTEXT_OPTION_KEY,
  JOB_TRACE_OPTION_KEY,
  MAX_SERIES_PER_METRIC,
  Objective,
  OBJECTIVES_METADATA,
  objectiveProblems,
  OBSERVE_OPTIONS,
  openTelemetryTraceIdGenerator,
  REQUEST_ID_PATTERN,
  SPAN_COLLAPSED_TAG,
  stringifyLabel,
  Summary,
  toDeclaredObjective,
  TRACE_CONTEXT_KEY,
  TRACE_REGISTRY_KEY,
  TracerService,
  TraceSpanDelegate,
  UNFINISHED_SPANS_TAG,
  unknownObjectiveFields,
  UNRECORDED_SPANS_TAG,
} from "../src/index";
import { ObserveAgentSharedBuffer } from "../src/agent/observe-agent.buffer";
import { collapseRepeatedSpans } from "../src/services/collapse-repeated-spans.util";
import { LogRedactor } from "../src/utils/log-redactor";

describe("@bunest/observe", () => {
  describe("Custom Metrics (Counter, Gauge, Summary)", () => {
    it("tracks Counter increments, sorted labels, deltas via increase/markFlushed, and series cap", () => {
      expect(stringifyLabel({ b: 2, a: "x" })).toBe('{"a":"x","b":2}');
      expect(MAX_SERIES_PER_METRIC).toBe(1000);

      const counter = new Counter<"method" | "status">(
        "http_requests",
        "Total HTTP requests",
        ["method", "status"],
      );
      counter.increment({ status: 200, method: "GET" });
      counter.increment({ method: "GET", status: 200 }, 4);
      expect(counter.getValue({ method: "GET", status: 200 })).toBe(5);
      expect(counter.increase['{"method":"GET","status":200}']).toBe(5);

      counter.markFlushed();
      expect(counter.increase).toEqual({});
      counter.increment({ method: "GET", status: 200 }, 2);
      expect(counter.increase['{"method":"GET","status":200}']).toBe(2);

      // Ignores NaN / Infinity safely
      counter.increment({ method: "GET", status: 200 }, Number.NaN);
      expect(counter.getValue({ method: "GET", status: 200 })).toBe(7);

      // Cardinality cap
      const bag: Record<string, number> = {};
      const state = { warned: false };
      for (let i = 0; i < MAX_SERIES_PER_METRIC; i++) {
        expect(admitsSeries("m", bag, `k${i}`, state)).toBe(true);
        bag[`k${i}`] = i;
      }
      expect(admitsSeries("m", bag, "overflow", state)).toBe(false);
      expect(state.warned).toBe(true);
      expect(admitsSeries("m", bag, "k0", state)).toBe(true);
    });

    it("tracks Gauge setValue, increment, decrement, and kind", () => {
      const gauge = new Gauge("active_connections", {
        description: "Open sockets",
        initialValue: 10,
        kind: "additive",
      });
      expect(gauge.kind).toBe("additive");
      expect(gauge.getValue()).toBe(10);
      gauge.increment(5);
      expect(gauge.getValue()).toBe(15);
      gauge.decrement(3);
      expect(gauge.getValue()).toBe(12);
      gauge.setValue(42);
      expect(gauge.getValue()).toBe(42);
    });

    it("computes Summary quantiles (p50, p95, p99), observations, total, maximum, and resets on markFlushed", () => {
      const summary = new Summary<"route">("request_duration_ms", {
        labels: ["route"],
        sampleSize: 100,
      });
      for (let i = 1; i <= 100; i++) {
        summary.observe(i, "route");
      }
      expect(summary.observations.route).toBe(100);
      expect(summary.total.route).toBe(5050);
      expect(summary.maximum.route).toBe(100);
      expect(summary.p50.route).toBe(50);
      expect(summary.p95.route).toBe(95);
      expect(summary.p99.route).toBe(99);
      expect(summary.value.route).toBe(50);

      summary.markFlushed();
      expect(summary.observations).toEqual({});
    });
  });

  describe("Objectives & Trace IDs & Redaction", () => {
    it("attaches @Objective metadata and validates SLO bounds", () => {
      class DemoController {
        @Objective({ availability: 99.9, latency: { underMs: 250, target: 99 } })
        @Objective({ availability: 99.5, windowDays: 14, name: "Fallback SLO" })
        handle() {}
      }
      const meta = Reflect.getMetadata(
        OBJECTIVES_METADATA,
        DemoController.prototype.handle,
      );
      expect(meta).toHaveLength(2);
      expect(meta[0].availability).toBe(99.9);
      expect(meta[1].windowDays).toBe(14);

      expect(objectiveProblems({ availability: 99.9 })).toEqual([]);
      expect(objectiveProblems({})).toContain(
        "declares neither availability nor latency",
      );
      expect(objectiveProblems({ availability: 50 }).length).toBeGreaterThan(0);
      expect(
        unknownObjectiveFields({
          availability: 99.9,
          extra: 1,
        } as any),
      ).toEqual(["extra"]);
      expect(
        toDeclaredObjective({
          availability: 99.9,
          extra: 1,
        } as any),
      ).toEqual({ availability: 99.9 });
    });

    it("generates UUIDv7, validates x-request-id, and parses W3C traceparent", () => {
      expect(REQUEST_ID_PATTERN.test("req-123_abc.4")).toBe(true);
      expect(REQUEST_ID_PATTERN.test("bad id with space")).toBe(false);

      expect(
        defaultTraceIdGenerator({ headers: { "x-request-id": "req-42" } }),
      ).toBe("req-42");

      const generated = defaultTraceIdGenerator({
        headers: { "x-request-id": "invalid\nheader" },
      });
      expect(generated).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );

      const otelId = openTelemetryTraceIdGenerator({
        headers: {
          traceparent:
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
        },
      });
      expect(otelId).toBe("4bf92f35-77b3-4da6-a3ce-929d0e0e4736");
    });

    it("redacts secrets in messages & attributes and collapses repeated spans", () => {
      const redactor = new LogRedactor({ keys: ["customSecret"] });
      expect(
        redactor.redactMessage(
          "Authorization: Bearer tok_secret123 postgres://admin:p4ssw0rd@db.internal/app",
        ),
      ).toBe(
        "Authorization: [REDACTED] postgres://admin:[REDACTED]@db.internal/app",
      );
      expect(
        redactor.redactAttributes({
          user: "alice",
          apiKey: "sk-123",
          customSecret: "top-secret",
        }),
      ).toEqual({
        user: "alice",
        apiKey: "[REDACTED]",
        customSecret: "[REDACTED]",
      });

      const siblings = Array.from({ length: 10 }, (_, i) => ({
        origin: "auto" as const,
        className: "Pipe",
        methodKey: "transform",
        duration: i + 1,
        children: [],
      }));
      const collapsed = collapseRepeatedSpans(siblings, {
        threshold: 5,
        keepSlowest: 2,
      });
      expect(collapsed).toHaveLength(3); // 2 slowest + 1 collapsed summary
      expect(collapsed[2]?.tags?.[SPAN_COLLAPSED_TAG]).toBe(8);
    });

    it("exports all required constants and TraceSpanDelegate", () => {
      expect(OBSERVE_OPTIONS).toBe("OBSERVE_OPTIONS");
      expect(CALLER_METADATA_KEY).toBe("#caller");
      expect(TRACE_REGISTRY_KEY).toBe("#registryKey");
      expect(TRACE_CONTEXT_KEY).toBe("#traceContext");
      expect(JOB_TRACE_OPTION_KEY).toBe("observeTraceId");
      expect(JOB_TRACE_CONTEXT_OPTION_KEY).toBe("observeTraceparent");
      expect(UNFINISHED_SPANS_TAG).toBe("observe.unfinishedSpans");
      expect(UNRECORDED_SPANS_TAG).toBe("observe.unrecordedSpans");

      const tags: Record<string, string | number | boolean> = {};
      const span = new TraceSpanDelegate("s1", "work", tags);
      span.setTag("k", "v").addTags({ count: 3, ok: true });
      expect(span.id).toBe("s1");
      expect(span.name).toBe("work");
      expect(tags).toEqual({ k: "v", count: 3, ok: true });
    });
  });

  describe("createObserveModule & BunestFactory integration", () => {
    it("instruments providers, traces HTTP requests via ALS, supports manual spans, attributes, and custom metrics", async () => {
      const { ObserveInstrument, ObserveModule } = createObserveModule<{
        tenantId: string;
      }>();

      @Injectable()
      class WorkService {
        constructor(private readonly tracer: TracerService<{ tenantId: string }>) {}

        async doWork(input: string): Promise<{ result: string; traceId: string | null; tenant: string | undefined }> {
          this.tracer.setAttribute("tenantId", "acme");
          this.tracer.setOperationId("orders.process");
          const c = this.tracer.counter("orders_processed");
          c.increment();
          const result = await this.tracer.createSpan("compute", async (span) => {
            span.setTag("input", input);
            const active = await this.tracer.activeSpan();
            active.setTag("nested", true);
            return `processed:${input}`;
          });
          return {
            result,
            traceId: this.tracer.currentTraceId(),
            tenant: this.tracer.getAttribute("tenantId"),
          };
        }
      }

      @Controller("orders")
      class OrdersController {
        constructor(private readonly work: WorkService) {}

        @Get("run")
        run() {
          return this.work.doWork("item-1");
        }
      }

      @Module({
        imports: [
          ObserveModule.forRoot({
            serviceId: "orders-api",
            runtimeMetrics: false,
            flushInterval: 0,
            shutdownFlushTimeout: 0,
          }),
        ],
        controllers: [OrdersController],
        providers: [WorkService],
      })
      class AppModule {}

      const app = await BunestFactory.create(AppModule, {
        instrument: ObserveInstrument,
        logger: false,
      });
      await app.init();

      const res = await app.inject({
        method: "GET",
        url: "/orders/run",
        headers: { "x-request-id": "trace-e2e-1" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toEqual({
        result: "processed:item-1",
        traceId: "trace-e2e-1",
        tenant: "acme",
      });

      const buffer = app.get(ObserveAgentSharedBuffer);
      const traces = buffer.getBufferedTraces();
      expect(traces.length).toBeGreaterThanOrEqual(1);
      const snap = traces[0]!;
      expect(snap.traceId).toBe("trace-e2e-1");
      expect("operationId" in snap && snap.operationId).toBe("orders.process");

      const tracer = app.get(TracerService);
      expect(tracer.counter("orders_processed").getValue()).toBe(1);

      await app.close();
    });

    it("supports ObserveModule.forRootAsync with useFactory", async () => {
      const { ObserveModule } = createObserveModule();

      @Module({
        imports: [
          ObserveModule.forRootAsync({
            useFactory: async () => ({
              serviceId: "async-service",
              enabled: false,
            }),
          }),
        ],
      })
      class AsyncAppModule {}

      const app = await BunestFactory.createApplicationContext(AsyncAppModule, {
        logger: false,
      });
      const tracer = app.get(TracerService);
      expect(tracer.currentTraceId()).toBeNull();
      await app.close();
    });
  });
});
