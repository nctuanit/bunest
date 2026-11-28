import { describe, expect, it } from "bun:test";
import { BunestFactory, Module } from "@bunest/core";
import {
  BunRuntimeMetricsCollector,
  DnsCacheHealthIndicator,
  JscHeapHealthIndicator,
  MetricsModule,
  MetricsRegistry,
  OtlpHttpMetricsExporter,
  Span,
  Tracer,
  UdpStatsdExporter,
} from "../src/index";

describe("Wave 6 — @bunest/observability Bun 1.4.5 Telemetry (nanoseconds, bun:jsc, dns stats, UDP StatsD)", () => {
  it("Tracer spans preserve monotonic causal ordering across 1,000 consecutive spans and accurate explicit startTimeMs/endTimeMs", () => {
    const tracer = new Tracer({ serviceName: "bunest-test" });
    let prevEnd = 0n;
    for (let i = 0; i < 1000; i++) {
      const span = tracer.startSpan(`op.${i}`);
      if (i === 0) {
        span.addEvent("checkpoint");
      }
      const data = span.end();
      const startNs = BigInt(data.startTimeUnixNano);
      const endNs = BigInt(data.endTimeUnixNano);
      expect(endNs).toBeGreaterThanOrEqual(startNs);
      expect(startNs).toBeGreaterThanOrEqual(prevEnd);
      if (i === 0) {
        expect(data.events.length).toBe(1);
        expect(BigInt(data.events[0]!.timeUnixNano)).toBeGreaterThanOrEqual(
          startNs,
        );
      }
      prevEnd = endNs;
    }

    // Explicit startTimeMs in the past: toSpanData() durationMs must match end - start
    const pastStartMs = Date.now() - 2500;
    const explicitSpan = new Span(
      "explicit.op",
      "INTERNAL",
      {
        traceId: "a".repeat(32),
        spanId: "b".repeat(16),
        traceFlags: 1,
        sampled: true,
      },
      {},
      undefined,
      undefined,
      pastStartMs,
    );
    const liveSnap = explicitSpan.toSpanData();
    const liveDiffMs =
      Number(BigInt(liveSnap.endTimeUnixNano) - BigInt(liveSnap.startTimeUnixNano)) /
      1_000_000;
    expect(liveSnap.durationMs).toBeGreaterThanOrEqual(2400);
    expect(Math.abs(liveSnap.durationMs - liveDiffMs)).toBeLessThan(2);

    const ended = explicitSpan.end(pastStartMs + 3000);
    expect(ended.durationMs).toBe(3000);
    const otlp = explicitSpan.toOtlpSpan();
    expect(BigInt(otlp.endTimeUnixNano) - BigInt(otlp.startTimeUnixNano)).toBe(
      3_000_000_000n,
    );
  });

  it("JscHeapHealthIndicator & DnsCacheHealthIndicator report up and down statuses accurately", () => {
    const jscIndicator = new JscHeapHealthIndicator();
    const jscUp = jscIndicator.check("jsc", { maxCurrentBytes: "10gb" });
    expect(jscUp.jsc?.status).toBe("up");
    expect(Number(jscUp.jsc?.currentBytes)).toBeGreaterThan(0);

    const jscDownBytes = jscIndicator.check("jsc", { maxCurrentBytes: 1 });
    expect(jscDownBytes.jsc?.status).toBe("down");

    const jscDownObjects = jscIndicator.check("jsc", { maxObjectCount: 1 });
    expect(jscDownObjects.jsc?.status).toBe("down");

    const dnsIndicator = new DnsCacheHealthIndicator();
    const dnsUp = dnsIndicator.check("dns", { maxErrors: 1000 });
    expect(dnsUp.dns?.status).toBe("up");

    const bunDns = (
      Bun as unknown as {
        dns: { getCacheStats?: () => Record<string, number> };
      }
    ).dns;
    const origStats = bunDns.getCacheStats;
    try {
      bunDns.getCacheStats = () => ({
        cacheHitsCompleted: 1,
        cacheHitsInflight: 0,
        cacheMisses: 19,
        size: 5,
        errors: 4,
        totalCount: 20,
      });
      const dnsDownErrs = dnsIndicator.check("dns", { maxErrors: 2 });
      expect(dnsDownErrs.dns?.status).toBe("down");

      const dnsDownHitRate = dnsIndicator.check("dns", {
        minHitRate: 0.5,
        minSamples: 10,
      });
      expect(dnsDownHitRate.dns?.status).toBe("down");
    } finally {
      bunDns.getCacheStats = origStats;
    }
  });

  it("MetricsModule.forRoot({ collectRuntimeMetrics: true }) serves JSC & DNS gauges on /metrics and registers collector even with exposeEndpoint: false", async () => {
    @Module({
      imports: [MetricsModule.forRoot({ collectRuntimeMetrics: true })],
    })
    class MetricsHttpApp {}

    const app = await BunestFactory.create(MetricsHttpApp);
    try {
      const res = await app.inject({ method: "GET", url: "/metrics" });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain("bun_jsc_memory_current_bytes");
      expect(res.body).toContain("bun_jsc_heap_objects");
      expect(res.body).toContain("bun_dns_cache_size");
    } finally {
      await app.close();
    }

    @Module({
      imports: [
        MetricsModule.forRoot({
          exposeEndpoint: false,
          collectRuntimeMetrics: true,
        }),
      ],
    })
    class HeadlessMetricsApp {}

    const headless = await BunestFactory.create(HeadlessMetricsApp);
    try {
      const collector = headless.get(BunRuntimeMetricsCollector);
      const registry = headless.get(MetricsRegistry);
      expect(collector).toBeInstanceOf(BunRuntimeMetricsCollector);
      const prom = registry.toPrometheusText();
      expect(prom).toContain("bun_jsc_memory_current_bytes");
      expect(prom).toContain("bun_dns_cache_size");

      const otlp = new OtlpHttpMetricsExporter(registry, {
        endpoint: "http://127.0.0.1:4318/v1/metrics",
        intervalMs: 0,
      });
      const payload = otlp.buildOtlpPayload();
      const firstGauge = payload.resourceMetrics[0]?.scopeMetrics[0]?.metrics.find(
        (m) => m.name === "bun_jsc_memory_current_bytes",
      );
      expect(firstGauge?.gauge?.dataPoints[0]?.timeUnixNano).toBeDefined();
      expect(BigInt(firstGauge!.gauge!.dataPoints[0]!.timeUnixNano)).toBeGreaterThan(
        1_700_000_000_000_000_000n,
      );
    } finally {
      await headless.close();
    }
  });

  it("UdpStatsdExporter emits delta counters, gauges, histograms, multi-packet chunking, tag sanitization, IPv6, and rejects after close", async () => {
    const received: string[] = [];
    const server = await Bun.udpSocket({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(_socket, buf) {
          received.push(new TextDecoder().decode(buf));
        },
      },
    });

    const registry = new MetricsRegistry();
    const counter = registry.createCounter({
      name: "orders_created",
      help: "Orders created",
      labelNames: ["region"],
    });
    const gauge = registry.createGauge({
      name: "active_conns",
      help: "Active connections",
    });
    const hist = registry.createHistogram({
      name: "req_latency",
      help: "Request latency",
      buckets: [0.1, 1],
    });

    counter.inc({ region: "vn" }, 3);
    gauge.set(42);
    hist.observe(0.25);
    hist.observe(0.75);

    const exporter = new UdpStatsdExporter({
      host: "127.0.0.1",
      port: server.port,
      prefix: "bunest.",
      globalTags: { env: "test,prod\ninjected" },
      maxDatagramBytes: 256,
    });

    try {
      expect(await exporter.sendLines([])).toBe(0);

      // First flush sends delta=3 for counter, gauge=42, histogram count=2 & sum=1
      const packets1 = await exporter.flush(registry);
      expect(packets1).toBeGreaterThanOrEqual(1);
      await Bun.sleep(25);
      const joined1 = received.join("\n");
      expect(joined1).toContain(
        "bunest.orders_created:3|c|#env:test_prod_injected,region:vn",
      );
      expect(joined1).toContain("bunest.active_conns:42|g");
      expect(joined1).toContain("bunest.req_latency.count:2|c");
      expect(joined1).toContain("bunest.req_latency.sum:1|g");

      // Second flush without counter change must NOT re-emit counter delta
      received.length = 0;
      await exporter.flush(registry);
      await Bun.sleep(25);
      expect(received.join("\n")).not.toContain("orders_created");

      // Increment counter by 2 -> third flush emits delta=2 (not cumulative 5)
      received.length = 0;
      counter.inc({ region: "vn" }, 2);
      await exporter.flush(registry);
      await Bun.sleep(25);
      expect(received.join("\n")).toContain("bunest.orders_created:2|c");

      // Multi-packet chunking when total bytes exceed maxDatagramBytes (256)
      const manyLines = Array.from(
        { length: 20 },
        (_, i) => `bunest.chunk_metric_${i}:${i}|g|#tag:abcdefghijklmnop`,
      );
      const multiPackets = await exporter.sendLines(manyLines);
      expect(multiPackets).toBeGreaterThan(1);
    } finally {
      await exporter.close();
      server.close();
    }

    await expect(exporter.flush(registry)).rejects.toThrow(/closed/i);

    // Verify IPv6 (::1) UDP binding & transmission
    let v6Server: { readonly port: number; close(): void } | undefined;
    try {
      const v6Received: string[] = [];
      const sock = await Bun.udpSocket({
        hostname: "::1",
        port: 0,
        socket: {
          data(_socket, buf) {
            v6Received.push(new TextDecoder().decode(buf));
          },
        },
      });
      v6Server = sock;
      const v6Exporter = new UdpStatsdExporter({
        host: "::1",
        port: sock.port,
      });
      try {
        const sent = await v6Exporter.sendLines(["ipv6_metric:1|c"]);
        expect(sent).toBe(1);
        await Bun.sleep(25);
        expect(v6Received.join("\n")).toContain("ipv6_metric:1|c");
      } finally {
        await v6Exporter.close();
      }
    } finally {
      v6Server?.close();
    }
  });
});
