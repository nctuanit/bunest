import "reflect-metadata";
import { afterEach, describe, expect, it } from "bun:test";
import {
  BadRequestException,
  Controller,
  Get,
  Module,
  Param,
  Post,
  type CanActivate,
} from "../../../../../packages/common/src";
import {
  Counter,
  DEFAULT_HTTP_BUCKETS,
  Gauge,
  Histogram,
  MetricsModule,
  MetricsRegistry,
  PROMETHEUS_CONTENT_TYPE,
} from "../../../../../packages/observability/src";
import {
  createTestApp,
  describeConformance,
  itAdapted,
  type TestAppContext,
} from "../../../_helpers/index";

describeConformance(
  "Metrics Primitives (Counter, Gauge, Histogram, MetricsRegistry, MetricsModule)",
  {
    upstreamPath: "observe/src/custom-metrics/custom-metrics.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts upstream @nestjs/observe custom metrics semantics (Counter, Gauge, Summary -> Prometheus Histogram, label isolation, key-order invariance, non-finite handling, registry identity) to @bunest/observability open-standard Prometheus metrics.",
  },
  () => {
    describe("Counter", () => {
      it("starts at zero and counts up", () => {
        const counter = new Counter({ name: "logins", help: "Total logins" });

        expect(counter.get()).toBe(0);
        counter.inc();
        counter.inc();
        expect(counter.get()).toBe(2);
      });

      it("increments by an explicit amount", () => {
        const counter = new Counter({ name: "bytes", help: "Total bytes" });

        counter.inc(512);

        expect(counter.get()).toBe(512);
      });

      it("supports fractional positive increments", () => {
        const counter = new Counter({ name: "credits", help: "Credits used" });

        counter.inc(1.5);
        counter.inc(2.25);

        expect(counter.get()).toBe(3.75);
      });

      it("accepts zero increments without modifying total", () => {
        const counter = new Counter({ name: "events", help: "Events" });

        counter.inc(0);
        expect(counter.get()).toBe(0);

        counter.inc(5);
        counter.inc(0);
        expect(counter.get()).toBe(5);
      });

      it("resets accumulated values back to zero", () => {
        const counter = new Counter({ name: "orders", help: "Orders" });
        counter.inc(10);
        expect(counter.get()).toBe(10);

        counter.reset();
        expect(counter.get()).toBe(0);
      });

      describe("labels", () => {
        it("keeps a separate total per label", () => {
          const counter = new Counter({
            name: "requests",
            help: "HTTP requests",
            labelNames: ["route"],
          });

          counter.inc({ route: "/a" });
          counter.inc({ route: "/a" });
          counter.inc({ route: "/b" });

          expect(counter.get({ route: "/a" })).toBe(2);
          expect(counter.get({ route: "/b" })).toBe(1);
        });

        it("rejects an undeclared label key on increment and get", () => {
          const counter = new Counter({
            name: "requests",
            help: "HTTP requests",
            labelNames: ["route"],
          });

          expect(() => counter.inc({ method: "GET" })).toThrow(
            /Unknown metric label "method"/,
          );
          expect(() => counter.get({ method: "GET" })).toThrow(
            /Unknown metric label "method"/,
          );
        });

        it("reads back a label incremented by zero", () => {
          const counter = new Counter({
            name: "requests",
            help: "HTTP requests",
            labelNames: ["route"],
          });

          counter.inc({ route: "/a" }, 0);

          expect(counter.get({ route: "/a" })).toBe(0);
          expect(counter.formatPrometheus()).toContain('requests{route="/a"} 0');
        });

        itAdapted(
          ["ADR-001"],
          "returns zero for a declared label set that was never recorded",
          () => {
            const counter = new Counter({
              name: "requests",
              help: "HTTP requests",
              labelNames: ["route"],
            });

            expect(counter.get({ route: "/never" })).toBe(0);
          },
          "Prometheus Counter.get() returns 0 for unseen label combinations instead of throwing",
        );

        it("treats the same label set in any key order as one series", () => {
          const counter = new Counter({
            name: "requests",
            help: "HTTP requests",
            labelNames: ["route", "method"],
          });

          counter.inc({ route: "/a", method: "GET" });
          counter.inc({ method: "GET", route: "/a" });

          expect(counter.get({ method: "GET", route: "/a" })).toBe(2);
          expect(counter.get({ route: "/a", method: "GET" })).toBe(2);

          const seriesLines = counter
            .formatPrometheus()
            .split("\n")
            .filter((line) => !line.startsWith("#"));
          expect(seriesLines).toHaveLength(1);
        });

        it("coerces numeric and boolean label values to strings", () => {
          const counter = new Counter({
            name: "http_calls",
            help: "HTTP calls",
            labelNames: ["status", "cached"],
          });

          counter.inc({ status: 200, cached: true }, 3);

          expect(counter.get({ status: "200", cached: "true" })).toBe(3);
          expect(counter.formatPrometheus()).toContain(
            'http_calls{status="200",cached="true"} 3',
          );
        });

        it("defaults omitted declared labels to empty string", () => {
          const counter = new Counter({
            name: "requests",
            help: "HTTP requests",
            labelNames: ["route", "method"],
          });

          counter.inc({ route: "/a" });

          expect(counter.get({ route: "/a", method: "" })).toBe(1);
        });

        it("deduplicates repeated labelNames in constructor", () => {
          const counter = new Counter({
            name: "dedup_counter",
            help: "Dedup",
            labelNames: ["route", "route"],
          });

          expect(counter.labelNames).toEqual(["route"]);
        });
      });

      describe("invalid values & Prometheus exposition", () => {
        itAdapted(
          ["ADR-001"],
          "rejects negative and non-finite increments on a Prometheus Counter",
          () => {
            const counter = new Counter({ name: "orders", help: "Orders" });

            expect(() => counter.inc(-1)).toThrow(/negative or non-finite/);
            expect(() => counter.inc(Number.NaN)).toThrow(
              /negative or non-finite/,
            );
            expect(() => counter.inc(Number.POSITIVE_INFINITY)).toThrow(
              /negative or non-finite/,
            );
            expect(() => counter.inc(Number.NEGATIVE_INFINITY)).toThrow(
              /negative or non-finite/,
            );

            counter.inc(2);
            expect(counter.get()).toBe(2);
          },
          "Prometheus counters are strictly monotonic non-decreasing and reject negative/NaN/Infinity deltas",
        );

        it("treats null in place of delta as default increment of 1", () => {
          const counter = new Counter({ name: "orders", help: "Orders" });
          const NULL = null as unknown as number;

          expect(() => counter.inc(NULL)).not.toThrow();
          expect(counter.get()).toBe(1);
        });

        it("formats unlabelled counter at zero and escapes HELP and label values", () => {
          const unlabelled = new Counter({
            name: "idle_total",
            help: "Line1\nLine2\\slash",
          });
          expect(unlabelled.formatPrometheus()).toBe(
            "# HELP idle_total Line1\\nLine2\\\\slash\n# TYPE idle_total counter\nidle_total 0",
          );

          const labelled = new Counter({
            name: "jobs_total",
            help: "Jobs",
            labelNames: ["queue"],
          });
          labelled.inc({ queue: 'a"b\\c\nd' }, 4);
          expect(labelled.formatPrometheus()).toContain(
            'jobs_total{queue="a\\"b\\\\c\\nd"} 4',
          );
        });
      });
    });

    describe("Gauge", () => {
      it("starts at zero when constructed with name and help", () => {
        const gauge = new Gauge({ name: "queue_depth", help: "Queue depth" });

        expect(gauge.get()).toBe(0);
      });

      it("goes up and down", () => {
        const gauge = new Gauge({ name: "in_flight", help: "In flight" });

        gauge.inc();
        gauge.inc(4);
        gauge.dec(2);

        expect(gauge.get()).toBe(3);
      });

      it("can go negative", () => {
        const gauge = new Gauge({ name: "balance", help: "Balance" });

        gauge.dec(5);

        expect(gauge.get()).toBe(-5);
      });

      describe("set", () => {
        it("sets a value on a freshly created gauge", () => {
          const gauge = new Gauge({ name: "temperature", help: "Temp" });

          gauge.set(42);

          expect(gauge.get()).toBe(42);
        });

        it("sets a value of zero", () => {
          const gauge = new Gauge({ name: "temperature", help: "Temp" });
          gauge.set(10);

          gauge.set(0);

          expect(gauge.get()).toBe(0);
        });

        it("replaces rather than accumulates", () => {
          const gauge = new Gauge({ name: "temperature", help: "Temp" });

          gauge.set(10);
          gauge.set(20);

          expect(gauge.get()).toBe(20);
        });
      });

      describe("labels", () => {
        it("sets a value on a label that was never recorded", () => {
          const gauge = new Gauge({
            name: "connections",
            help: "DB connections",
            labelNames: ["pool"],
          });

          gauge.set({ pool: "main" }, 5);

          expect(gauge.get({ pool: "main" })).toBe(5);
        });

        it("keeps a separate level per label", () => {
          const gauge = new Gauge({
            name: "connections",
            help: "DB connections",
            labelNames: ["pool"],
          });

          gauge.inc({ pool: "read" }, 3);
          gauge.inc({ pool: "write" }, 1);
          gauge.dec({ pool: "read" }, 1);

          expect(gauge.get({ pool: "read" })).toBe(2);
          expect(gauge.get({ pool: "write" })).toBe(1);
        });

        it("treats the same label set in any key order as one series", () => {
          const gauge = new Gauge({
            name: "connections",
            help: "DB connections",
            labelNames: ["pool", "region"],
          });

          gauge.inc({ pool: "main", region: "us" }, 3);
          gauge.inc({ region: "us", pool: "main" }, 2);

          expect(gauge.get({ region: "us", pool: "main" })).toBe(5);
        });

        it("reads back a label sitting at zero", () => {
          const gauge = new Gauge({
            name: "connections",
            help: "DB connections",
            labelNames: ["pool"],
          });

          gauge.inc({ pool: "read" }, 5);
          gauge.dec({ pool: "read" }, 5);

          expect(gauge.get({ pool: "read" })).toBe(0);
        });

        it("rejects undeclared labels on set/inc/dec/get", () => {
          const gauge = new Gauge({
            name: "connections",
            help: "DB connections",
            labelNames: ["pool"],
          });

          expect(() => gauge.set({ unknown: "x" }, 1)).toThrow(
            /Unknown metric label "unknown"/,
          );
          expect(() => gauge.inc({ unknown: "x" }, 1)).toThrow(
            /Unknown metric label "unknown"/,
          );
          expect(() => gauge.dec({ unknown: "x" }, 1)).toThrow(
            /Unknown metric label "unknown"/,
          );
        });
      });

      it("treats null in place of inc/dec delta as default step of 1", () => {
        const gauge = new Gauge({ name: "level", help: "Level" });
        const NULL = null as unknown as number;
        gauge.set(5);

        expect(() => gauge.inc(NULL)).not.toThrow();
        expect(() => gauge.dec(NULL)).not.toThrow();
        expect(gauge.get()).toBe(5);
      });

      it("formats Prometheus special numeric values (-0, NaN, +Inf, -Inf) and resets cleanly", () => {
        const gauge = new Gauge({ name: "special", help: "Special" });

        gauge.set(-0);
        expect(gauge.formatPrometheus()).toContain("special 0");

        gauge.set(Number.NaN);
        expect(gauge.formatPrometheus()).toContain("special NaN");

        gauge.set(Number.POSITIVE_INFINITY);
        expect(gauge.formatPrometheus()).toContain("special +Inf");

        gauge.set(Number.NEGATIVE_INFINITY);
        expect(gauge.formatPrometheus()).toContain("special -Inf");

        gauge.reset();
        expect(gauge.get()).toBe(0);
      });
    });

    describe("Histogram (Prometheus distribution primitive)", () => {
      itAdapted(
        ["ADR-001"],
        "observes values into cumulative buckets and tracks exact count and sum",
        () => {
          const hist = new Histogram({
            name: "latency",
            help: "Request latency",
            buckets: [10, 50, 100],
          });

          hist.observe(10);
          hist.observe(20);
          hist.observe(30);
          hist.observe(150);

          const snap = hist.get();
          expect(snap).toBeDefined();
          expect(snap!.count).toBe(4);
          expect(snap!.sum).toBe(210);
          expect(snap!.buckets).toEqual({
            "10": 1,
            "50": 3,
            "100": 3,
            "+Inf": 4,
          });
        },
        "Bunest implements Prometheus Histogram (cumulative le buckets + exact sum/count) rather than Observe quantile Summary",
      );

      it("uses DEFAULT_HTTP_BUCKETS when buckets are omitted and sorts/deduplicates custom buckets", () => {
        const defaultHist = new Histogram({
          name: "http_dur",
          help: "HTTP duration",
        });
        expect(defaultHist.buckets).toEqual(DEFAULT_HTTP_BUCKETS);

        const customHist = new Histogram({
          name: "custom_dur",
          help: "Custom",
          buckets: [5, 1, 5, Number.NaN, Number.POSITIVE_INFINITY, 0.5],
        });
        expect(customHist.buckets).toEqual([0.5, 1, 5]);
      });

      it("stays bounded in memory over 20,000 observations with exact count and sum", () => {
        const hist = new Histogram({
          name: "latency_bounded",
          help: "Bounded latency",
          buckets: [100, 1000, 10_000],
        });

        let expectedSum = 0;
        for (let i = 0; i < 20_000; i++) {
          hist.observe(i);
          expectedSum += i;
        }

        const snap = hist.get();
        expect(snap!.count).toBe(20_000);
        expect(snap!.sum).toBe(expectedSum);
        expect(snap!.buckets["100"]).toBe(101);
        expect(snap!.buckets["+Inf"]).toBe(20_000);
      });

      it("keeps an independent distribution per label and is key-order invariant", () => {
        const hist = new Histogram({
          name: "route_latency",
          help: "Route latency",
          labelNames: ["route", "method"],
          buckets: [50, 500],
        });

        hist.observe({ route: "/a", method: "GET" }, 10);
        hist.observe({ method: "GET", route: "/a" }, 1000);
        hist.observe({ route: "/b", method: "POST" }, 25);

        expect(hist.get({ route: "/a", method: "GET" })?.count).toBe(2);
        expect(hist.get({ route: "/a", method: "GET" })?.sum).toBe(1010);
        expect(hist.get({ route: "/b", method: "POST" })?.count).toBe(1);
        expect(hist.get({ route: "/b", method: "POST" })?.sum).toBe(25);
        expect(hist.get({ route: "/missing", method: "GET" })).toBeUndefined();
      });

      it("ignores non-finite observations without throwing or poisoning sum/count", () => {
        const hist = new Histogram({
          name: "safe_latency",
          help: "Safe latency",
          buckets: [10, 50],
        });
        hist.observe(10);

        expect(() => hist.observe(Number.NaN)).not.toThrow();
        expect(() => hist.observe(Number.POSITIVE_INFINITY)).not.toThrow();
        expect(() => hist.observe(Number.NEGATIVE_INFINITY)).not.toThrow();
        hist.observe(30);

        const snap = hist.get()!;
        expect(snap.count).toBe(2);
        expect(snap.sum).toBe(40);
        expect(snap.buckets["10"]).toBe(1);
        expect(snap.buckets["50"]).toBe(2);
      });

      it("ignores non-number runtime values passed to observe without poisoning", () => {
        const hist = new Histogram({
          name: "runtime_safe",
          help: "Runtime safe",
          buckets: [10],
        });
        const unprintable: unknown[] = [
          { toString: 1 },
          Symbol("amount"),
          "not-a-number",
          undefined,
          null,
        ];

        for (const value of unprintable) {
          expect(() => hist.observe(value as number)).not.toThrow();
        }
        expect(hist.get()).toBeUndefined();
      });

      it("forbids reserved Prometheus label name 'le'", () => {
        expect(
          () =>
            new Histogram({
              name: "bad_hist",
              help: "Bad",
              labelNames: ["le"],
            }),
        ).toThrow(/reserved/);
      });

      it("measures elapsed time with startTimer() and merges override labels", async () => {
        const hist = new Histogram({
          name: "op_duration_seconds",
          help: "Op duration",
          labelNames: ["op", "status"],
          buckets: [0.001, 0.1, 1],
        });

        const stop = hist.startTimer({ op: "query" });
        await Bun.sleep(5);
        const elapsed = stop({ status: "ok" });

        expect(elapsed).toBeGreaterThanOrEqual(0);
        const snap = hist.get({ op: "query", status: "ok" });
        expect(snap?.count).toBe(1);
        expect(snap?.sum).toBeCloseTo(elapsed, 6);
      });

      it("starts a fresh distribution after reset() and formats Prometheus text", () => {
        const hist = new Histogram({
          name: "window_latency",
          help: "Latency",
          buckets: [25, 100],
        });
        hist.observe(10);
        hist.observe(20);

        hist.reset();
        expect(hist.get()).toBeUndefined();

        hist.observe(80);
        const text = hist.formatPrometheus();
        expect(text).toContain("# HELP window_latency Latency");
        expect(text).toContain("# TYPE window_latency histogram");
        expect(text).toContain('window_latency_bucket{le="25"} 0');
        expect(text).toContain('window_latency_bucket{le="100"} 1');
        expect(text).toContain('window_latency_bucket{le="+Inf"} 1');
        expect(text).toContain("window_latency_sum 80");
        expect(text).toContain("window_latency_count 1");
      });
    });

    describe("MetricsRegistry", () => {
      it("returns the same metric instance for the same name and type", () => {
        const registry = new MetricsRegistry();
        const c1 = registry.createCounter({ name: "orders", help: "Orders" });
        c1.inc(5);
        const c2 = registry.createCounter({ name: "orders", help: "Orders" });
        expect(c2).toBe(c1);
        expect(c2.get()).toBe(5);

        const g1 = registry.createGauge({ name: "depth", help: "Depth" });
        g1.set(3);
        expect(registry.createGauge({ name: "depth", help: "Depth" })).toBe(g1);

        const h1 = registry.createHistogram({ name: "lat", help: "Lat" });
        h1.observe(0.1);
        expect(registry.createHistogram({ name: "lat", help: "Lat" })).toBe(h1);
      });

      it("rejects registering the same name under a different metric type", () => {
        const registry = new MetricsRegistry();
        registry.createCounter({ name: "shared", help: "Counter" });

        expect(() =>
          registry.createGauge({ name: "shared", help: "Gauge" }),
        ).toThrow(/already registered as "counter"/);
        expect(() =>
          registry.createHistogram({ name: "shared", help: "Histogram" }),
        ).toThrow(/already registered as "counter"/);
      });

      it("validates Prometheus metric names and label names", () => {
        const registry = new MetricsRegistry();

        expect(() =>
          registry.createCounter({ name: "123_invalid", help: "bad" }),
        ).toThrow(/Invalid Prometheus metric name/);
        expect(() =>
          registry.createCounter({ name: "bad-name", help: "bad" }),
        ).toThrow(/Invalid Prometheus metric name/);
        expect(() =>
          registry.createCounter({
            name: "valid_name",
            help: "ok",
            labelNames: ["__reserved"],
          }),
        ).toThrow(/Invalid Prometheus label name/);
        expect(() =>
          registry.createCounter({
            name: "valid_name2",
            help: "ok",
            labelNames: ["bad-label"],
          }),
        ).toThrow(/Invalid Prometheus label name/);
      });

      it("supports getMetric, getMetrics, removeMetric, resetAll, clear, and toPrometheusText", () => {
        const registry = new MetricsRegistry();
        expect(registry.toPrometheusText()).toBe("");

        const c = registry.createCounter({ name: "c_one", help: "C1" });
        const g = registry.createGauge({ name: "g_one", help: "G1" });
        c.inc(2);
        g.set(7);

        expect(registry.getMetric("c_one")).toBe(c);
        expect(registry.getMetrics()).toHaveLength(2);

        const output = registry.toPrometheusText();
        expect(output).toContain("c_one 2");
        expect(output).toContain("g_one 7");
        expect(output.endsWith("\n")).toBe(true);

        registry.resetAll();
        expect(c.get()).toBe(0);
        expect(g.get()).toBe(0);

        expect(registry.removeMetric("c_one")).toBe(true);
        expect(registry.removeMetric("c_one")).toBe(false);
        expect(registry.getMetrics()).toHaveLength(1);

        registry.clear();
        expect(registry.getMetrics()).toHaveLength(0);
        expect(registry.toPrometheusText()).toBe("");
      });
    });

    describe("MetricsModule & HttpMetricsInterceptor", () => {
      const contexts: TestAppContext[] = [];

      afterEach(async () => {
        await Promise.all(contexts.splice(0).map((ctx) => ctx.close()));
      });

      it("records HTTP counters, latency histograms, and in-flight gauges and exposes /metrics", async () => {
        @Controller("/items")
        class ItemsController {
          @Get(":id")
          findOne(@Param("id") id: string) {
            if (id === "bad") {
              throw new BadRequestException("bad");
            }
            return { id };
          }

          @Post()
          create() {
            return { created: true };
          }
        }

        const ctx = await createTestApp(
          {
            imports: [
              MetricsModule.forRoot({
                path: "/metrics",
                registerGlobalInterceptor: true,
              }),
            ],
            controllers: [ItemsController],
          },
          { silentLogger: true },
        );
        contexts.push(ctx);

        await ctx.request().get("/items/1").expect(200);
        await ctx.request().get("/items/2").expect(200);
        await ctx.request().get("/items/bad").expect(400);
        await ctx.request().post("/items").expect(201);

        const res = await ctx.request().get("/metrics").expect(200);
        expect(res.headers["content-type"]).toBe(PROMETHEUS_CONTENT_TYPE);
        expect(res.headers["cache-control"]).toBe("no-store");
        expect(res.text).toContain(
          'http_requests_total{method="GET",route="/items/:id",status="200"} 2',
        );
        expect(res.text).toContain(
          'http_requests_total{method="GET",route="/items/:id",status="400"} 1',
        );
        expect(res.text).toContain(
          'http_requests_total{method="POST",route="/items",status="201"} 1',
        );
        expect(res.text).toContain(
          'http_requests_in_flight{method="GET",route="/items/:id"} 0',
        );
      });

      it("supports exposeEndpoint: false, custom registry, and endpoint guard", async () => {
        const sharedRegistry = new MetricsRegistry();
        sharedRegistry.createCounter({ name: "boot_total", help: "Boots" }).inc();

        const hidden = await createTestApp(
          {
            imports: [
              MetricsModule.forRoot({
                exposeEndpoint: false,
                registry: sharedRegistry,
              }),
            ],
          },
          { silentLogger: true },
        );
        contexts.push(hidden);

        expect(hidden.moduleRef.get(MetricsRegistry)).toBe(sharedRegistry);
        await hidden.request().get("/metrics").expect(404);

        const tokenGuard: CanActivate = {
          canActivate(context) {
            const req = context.switchToHttp().getRequest<Request>();
            return req.headers.get("x-token") === "allow";
          },
        };

        const guarded = await createTestApp(
          {
            imports: [
              MetricsModule.forRoot({
                path: "/internal/metrics",
                guard: tokenGuard,
                registry: sharedRegistry,
              }),
            ],
          },
          { silentLogger: true },
        );
        contexts.push(guarded);

        await guarded.request().get("/internal/metrics").expect(403);
        const ok = await guarded
          .request()
          .get("/internal/metrics")
          .set("x-token", "allow")
          .expect(200);
        expect(ok.text).toContain("boot_total 1");
      });
    });
  },
);
