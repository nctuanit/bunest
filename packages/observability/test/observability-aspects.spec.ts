import { describe, expect, test } from "bun:test";
import { Injectable, Module } from "@bunest/core";
import { BunestFactory } from "@bunest/core";
import {
  Counted,
  Counter,
  Histogram,
  InMemorySpanExporter,
  MetricsModule,
  MetricsRegistry,
  ObservabilityModule,
  Span,
  Timed,
  Trace,
  Tracer,
  TracingModule,
  traceContextStorage,
} from "../src";

describe("@bunest/observability Service-Level Method Aspect Decorators", () => {
  test("@Span and @Trace create nested parent-child spans, attach static/dynamic attributes, honor recordException, and preserve sync execution & Span class compatibility", async () => {
    const exporter = new InMemorySpanExporter();

    @Injectable()
    class RepoService {
      @Trace("repo.fetch_item", {
        attributes: (id: string) => ({ "item.id": id, layer: "repo" }),
      })
      async fetchItem(id: string): Promise<{ id: string; traceId?: string }> {
        await Bun.sleep(2);
        return {
          id,
          traceId: traceContextStorage.getCurrentSpanContext()?.traceId,
        };
      }
    }

    @Injectable()
    class OrderService {
      constructor(private readonly repo: RepoService) {}

      @Span("orders.place", {
        attributes: { domain: "orders", priority: 1, active: true },
      })
      async placeOrder(id: string): Promise<{ id: string; traceId?: string }> {
        return await this.repo.fetchItem(id);
      }

      @Span()
      computeSync(x: number): number {
        return x * 2;
      }

      @Span("orders.fail_recorded")
      async failRecorded(): Promise<never> {
        throw new Error("db unavailable");
      }

      @Span("orders.fail_unrecorded", { recordException: false })
      failUnrecorded(): never {
        throw new Error("expected domain error");
      }
    }

    @Module({
      imports: [
        ObservabilityModule.forRoot({
          tracing: { serviceName: "shop-api", exporter },
        }),
      ],
      providers: [RepoService, OrderService],
    })
    class AppModule {}

    const ctx = await BunestFactory.createApplicationContext(AppModule, {
      logger: false,
    });

    try {
      const orders = ctx.get(OrderService);
      const tracer = ctx.get(Tracer);

      // Backward compatibility of `Span` as a constructible class + instanceof + type!
      const manualSpan: Span = tracer.startSpan("manual.check");
      expect(manualSpan).toBeInstanceOf(Span);
      manualSpan.end();

      const constructedSpan = new Span(
        "direct.span",
        "INTERNAL",
        {
          traceId: "a".repeat(32),
          spanId: "b".repeat(16),
          traceFlags: 1,
          sampled: true,
        },
        {},
      );
      expect(constructedSpan).toBeInstanceOf(Span);

      // Nested @Span -> @Trace parent-child propagation
      const res = await orders.placeOrder("sku-42");
      expect(res.id).toBe("sku-42");
      expect(res.traceId).toMatch(/^[0-9a-f]{32}$/);

      const parentSpan = exporter.findByName("orders.place")[0]!;
      const childSpan = exporter.findByName("repo.fetch_item")[0]!;
      expect(parentSpan).toBeDefined();
      expect(childSpan).toBeDefined();
      expect(childSpan.traceId).toBe(parentSpan.traceId);
      expect(childSpan.parentSpanId).toBe(parentSpan.spanId);
      expect(parentSpan.attributes).toMatchObject({
        domain: "orders",
        priority: 1,
        active: true,
        "code.namespace": "OrderService",
        "code.function": "placeOrder",
      });
      expect(childSpan.attributes).toMatchObject({
        "item.id": "sku-42",
        layer: "repo",
      });
      expect(parentSpan.status.code).toBe("OK");
      expect(childSpan.status.code).toBe("OK");

      // Sync method stays strictly synchronous (not wrapped in a Promise)
      const syncResult = orders.computeSync(21);
      expect(syncResult).toBe(42);
      expect(exporter.findByName("OrderService.computeSync")).toHaveLength(1);

      // Error with default recordException: true records exception event + ERROR status
      await expect(orders.failRecorded()).rejects.toThrow("db unavailable");
      const errSpan = exporter.findByName("orders.fail_recorded")[0]!;
      expect(errSpan.status.code).toBe("ERROR");
      expect(errSpan.events.some((e) => e.name === "exception")).toBe(true);

      // Error with recordException: false sets ERROR status without recording exception event
      expect(() => orders.failUnrecorded()).toThrow("expected domain error");
      const unrecSpan = exporter.findByName("orders.fail_unrecorded")[0]!;
      expect(unrecSpan.status.code).toBe("ERROR");
      expect(unrecSpan.events).toHaveLength(0);
    } finally {
      await ctx.close();
    }
  });

  test("@Timed and @Counted record Prometheus histograms and invocation/error counters", async () => {
    @Injectable()
    class BillingService {
      @Timed("billing_charge_duration_seconds", { gateway: "stripe" })
      @Counted("billing_charge_total", { gateway: "stripe" })
      async charge(shouldFail = false): Promise<string> {
        await Bun.sleep(5);
        if (shouldFail) {
          throw new Error("card declined");
        }
        return "charged";
      }

      @Timed()
      @Counted()
      computeSync(fail = false): number {
        if (fail) {
          throw new Error("sync boom");
        }
        return 7;
      }
    }

    @Module({
      imports: [ObservabilityModule.forRoot()],
      providers: [BillingService],
    })
    class AppModule {}

    const ctx = await BunestFactory.createApplicationContext(AppModule, {
      logger: false,
    });

    try {
      const billing = ctx.get(BillingService);
      const registry = ctx.get(MetricsRegistry);

      expect(await billing.charge(false)).toBe("charged");
      expect(await billing.charge(false)).toBe("charged");
      await expect(billing.charge(true)).rejects.toThrow("card declined");

      const hist = registry.getMetric<Histogram>(
        "billing_charge_duration_seconds",
      )!;
      expect(hist).toBeDefined();
      const histSnap = hist.get({ gateway: "stripe" })!;
      expect(histSnap.count).toBe(3);
      expect(histSnap.sum).toBeGreaterThan(0);

      const invCounter = registry.getMetric<Counter>("billing_charge_total")!;
      const errCounter = registry.getMetric<Counter>(
        "billing_charge_errors_total",
      )!;
      expect(invCounter.get({ gateway: "stripe" })).toBe(3);
      expect(errCounter.get({ gateway: "stripe" })).toBe(1);

      // Default derived metric names + sync preservation
      expect(billing.computeSync(false)).toBe(7);
      expect(() => billing.computeSync(true)).toThrow("sync boom");

      const defaultHist = registry.getMetric<Histogram>(
        "billing_service_compute_sync_duration_seconds",
      )!;
      const defaultInv = registry.getMetric<Counter>(
        "billing_service_compute_sync_total",
      )!;
      const defaultErr = registry.getMetric<Counter>(
        "billing_service_compute_sync_errors_total",
      )!;
      expect(defaultHist.get()?.count).toBe(2);
      expect(defaultInv.get()).toBe(2);
      expect(defaultErr.get()).toBe(1);

      const prom = registry.toPrometheusText();
      expect(prom).toContain('billing_charge_total{gateway="stripe"} 3');
      expect(prom).toContain('billing_charge_errors_total{gateway="stripe"} 1');
    } finally {
      await ctx.close();
    }
  });

  test("works with standalone TracingModule + MetricsModule imports as well as plain ObservabilityModule", async () => {
    const exporter = new InMemorySpanExporter();

    @Injectable()
    class StandaloneService {
      @Span("standalone.work")
      @Counted("standalone_work")
      run(): string {
        return "done";
      }
    }

    @Module({
      imports: [
        TracingModule.forRoot({ exporter }),
        MetricsModule.forRoot({ exposeEndpoint: false }),
      ],
      providers: [StandaloneService],
    })
    class SplitAppModule {}

    const ctx = await BunestFactory.createApplicationContext(SplitAppModule, {
      logger: false,
    });

    try {
      const svc = ctx.get(StandaloneService);
      const registry = ctx.get(MetricsRegistry);
      expect(svc.run()).toBe("done");
      expect(exporter.findByName("standalone.work")).toHaveLength(1);
      expect(registry.getMetric<Counter>("standalone_work")?.get()).toBe(1);
    } finally {
      await ctx.close();
    }
  });
});
