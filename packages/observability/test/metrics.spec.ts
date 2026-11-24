import { describe, expect, it } from "bun:test";
import {
  BadRequestException,
  BunestFactory,
  Controller,
  Get,
  Module,
  Param,
  Post,
  type CanActivate,
} from "@bunest/core";
import {
  MetricsModule,
  MetricsRegistry,
  PROMETHEUS_CONTENT_TYPE,
} from "../src";

describe("MetricsRegistry, HttpMetricsInterceptor & MetricsModule", () => {
  it("formats Counters, Gauges, and Histograms in Prometheus 0.0.4 text exposition with label escaping", () => {
    const registry = new MetricsRegistry();

    const counter = registry.createCounter({
      name: "jobs_processed_total",
      help: 'Total jobs "processed"\nwith newline',
      labelNames: ["queue", "status"],
    });
    counter.inc({ queue: 'email\\"main', status: "ok" }, 3);
    expect(counter.get({ queue: 'email\\"main', status: "ok" })).toBe(3);
    expect(() => counter.inc(-1)).toThrow();

    const gauge = registry.createGauge({
      name: "active_connections",
      help: "Current active connections",
    });
    gauge.set(10);
    gauge.inc(2);
    gauge.dec(5);
    expect(gauge.get()).toBe(7);

    const hist = registry.createHistogram({
      name: "query_duration_seconds",
      help: "DB query latency",
      labelNames: ["op"],
      buckets: [0.01, 0.1, 1],
    });
    hist.observe({ op: "select" }, 0.005);
    hist.observe({ op: "select" }, 0.05);
    hist.observe({ op: "select" }, 2.0);

    const text = registry.toPrometheusText();
    expect(text).toContain("# TYPE jobs_processed_total counter");
    expect(text).toContain(
      'jobs_processed_total{queue="email\\\\\\"main",status="ok"} 3',
    );
    expect(text).toContain("# TYPE active_connections gauge");
    expect(text).toContain("active_connections 7");
    expect(text).toContain("# TYPE query_duration_seconds histogram");
    expect(text).toContain(
      'query_duration_seconds_bucket{op="select",le="0.01"} 1',
    );
    expect(text).toContain(
      'query_duration_seconds_bucket{op="select",le="0.1"} 2',
    );
    expect(text).toContain(
      'query_duration_seconds_bucket{op="select",le="1"} 2',
    );
    expect(text).toContain(
      'query_duration_seconds_bucket{op="select",le="+Inf"} 3',
    );
    expect(text).toContain('query_duration_seconds_count{op="select"} 3');

    // Invalid metric & reserved `le` label rejected
    expect(() =>
      registry.createCounter({ name: "123-bad", help: "bad" }),
    ).toThrow();
    expect(() =>
      registry.createHistogram({
        name: "bad_hist",
        help: "bad",
        labelNames: ["le"],
      }),
    ).toThrow();
  });

  it("records HTTP counters/histograms/in-flight gauges and exposes /metrics endpoint (with optional guard)", async () => {
    @Controller("/items")
    class ItemsController {
      @Get(":id")
      findOne(@Param("id") id: string) {
        if (id === "bad") {
          throw new BadRequestException("bad id");
        }
        return { id };
      }

      @Post()
      create() {
        return { created: true };
      }
    }

    @Module({
      imports: [
        MetricsModule.forRoot({
          path: "/metrics",
          registerGlobalInterceptor: true,
        }),
      ],
      controllers: [ItemsController],
    })
    class AppModule {}

    const app = await BunestFactory.create(AppModule, { logger: false });
    try {
      expect(
        (await app.fetch(new Request("http://localhost/items/42"))).status,
      ).toBe(200);
      expect(
        (await app.fetch(new Request("http://localhost/items/99"))).status,
      ).toBe(200);
      expect(
        (await app.fetch(new Request("http://localhost/items/bad"))).status,
      ).toBe(400);
      expect(
        (
          await app.fetch(
            new Request("http://localhost/items", { method: "POST" }),
          )
        ).status,
      ).toBe(201);

      const scrape = await app.fetch(new Request("http://localhost/metrics"));
      expect(scrape.status).toBe(200);
      expect(scrape.headers.get("content-type")).toBe(PROMETHEUS_CONTENT_TYPE);
      const body = await scrape.text();

      // Normalized route template `/items/:id` (never high-cardinality `/items/42`!)
      expect(body).toContain(
        'http_requests_total{method="GET",route="/items/:id",status="200"} 2',
      );
      expect(body).toContain(
        'http_requests_total{method="GET",route="/items/:id",status="400"} 1',
      );
      expect(body).toContain(
        'http_requests_total{method="POST",route="/items",status="201"} 1',
      );
      expect(body).toContain(
        'http_request_duration_seconds_count{method="GET",route="/items/:id",status="200"} 2',
      );
      expect(body).toContain(
        'http_requests_in_flight{method="GET",route="/items/:id"} 0',
      );
    } finally {
      await app.close();
    }

    // Guarded /metrics endpoint
    const denyGuard: CanActivate = {
      canActivate(ctx) {
        const req = ctx.switchToHttp().getRequest<Request>();
        return req.headers.get("x-metrics-token") === "secret";
      },
    };

    @Module({
      imports: [MetricsModule.forRoot({ path: "/metrics", guard: denyGuard })],
    })
    class GuardedMetricsApp {}

    const guarded = await BunestFactory.create(GuardedMetricsApp, {
      logger: false,
    });
    try {
      expect(
        (await guarded.fetch(new Request("http://localhost/metrics"))).status,
      ).toBe(403);
      expect(
        (
          await guarded.fetch(
            new Request("http://localhost/metrics", {
              headers: { "x-metrics-token": "secret" },
            }),
          )
        ).status,
      ).toBe(200);
    } finally {
      await guarded.close();
    }
  });
});
