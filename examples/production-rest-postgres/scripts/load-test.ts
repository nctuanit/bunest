/**
 * Reproducible HTTP load test & soak runner for `examples/production-rest-postgres`.
 *
 * Supports both quick smoke load tests (e.g. `--duration=10s`) and the full
 * Week 3 2-hour soak gate (`--duration=2h`).
 *
 * Example:
 *   bun run --cwd examples/production-rest-postgres load \
 *     --url=http://127.0.0.1:3000 \
 *     --duration=2h \
 *     --concurrency=20 \
 *     --metrics-token="$METRICS_TOKEN" \
 *     --output=load-report.json
 */
import { strictAssert as assert } from "@bunest/core";

interface LoadOptions {
  url: string;
  durationMs: number;
  concurrency: number;
  metricsToken?: string;
  p95LimitMs: number;
  errorRateLimit: number;
  outputPath?: string;
}

function parseDurationMs(raw: string): number {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(raw.trim());
  if (!match) {
    throw new Error(`Invalid duration "${raw}". Use e.g. 10s, 5m, 2h.`);
  }
  const value = Number(match[1]);
  const unit = match[2];
  switch (unit) {
    case "ms":
      return Math.round(value);
    case "s":
      return Math.round(value * 1000);
    case "m":
      return Math.round(value * 60_000);
    case "h":
      return Math.round(value * 3_600_000);
    default:
      throw new Error(`Unsupported unit: ${unit}`);
  }
}

function parseArgs(argv: string[]): LoadOptions {
  const map = new Map<string, string>();
  for (const arg of argv) {
    if (arg.startsWith("--")) {
      const [k, v] = arg.slice(2).split("=", 2);
      if (k && v !== undefined) {
        map.set(k, v);
      }
    }
  }
  return {
    url: (map.get("url") ?? "http://127.0.0.1:3000").replace(/\/$/, ""),
    durationMs: parseDurationMs(map.get("duration") ?? "10s"),
    concurrency: Math.max(1, Number(map.get("concurrency") ?? 10)),
    metricsToken: map.get("metrics-token") ?? Bun.env.METRICS_TOKEN,
    p95LimitMs: Number(map.get("p95-limit-ms") ?? 200),
    errorRateLimit: Number(map.get("error-rate-limit") ?? 0.001),
    outputPath: map.get("output"),
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[idx] ?? 0;
}

async function sampleMetrics(
  baseUrl: string,
  token?: string,
): Promise<{ rssBytes: number; eventLoopLagMs: number } | null> {
  try {
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(`${baseUrl}/metrics`, { headers });
    if (!res.ok) return null;
    const text = await res.text();
    const rssMatch = /^bunest_process_resident_memory_bytes\s+([0-9.]+)/m.exec(
      text,
    );
    const lagMatch = /^bunest_event_loop_lag_ms\s+([0-9.]+)/m.exec(text);
    return {
      rssBytes: rssMatch ? Number(rssMatch[1]) : 0,
      eventLoopLagMs: lagMatch ? Number(lagMatch[1]) : 0,
    };
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(Bun.argv.slice(2));
  const startedAt = new Date().toISOString();
  const startMs = performance.now();
  const endMs = startMs + opts.durationMs;

  // Seed one item so GET /items/:id has a guaranteed valid target
  const seedRes = await fetch(`${opts.url}/items`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Load Test Seed Item", quantity: 1 }),
  });
  assert.equal(seedRes.status, 201, "Failed to seed item before load test");
  const seedItem = (await seedRes.json()) as { id: number };
  const knownIds: number[] = [seedItem.id];

  const latencies: number[] = [];
  let totalRequests = 0;
  let count2xx = 0;
  let count4xx = 0;
  let count5xx = 0;
  let networkErrors = 0;

  const rssSamples: Array<{ elapsedSec: number; rssMb: number; lagMs: number }> =
    [];
  const recordSample = async () => {
    const m = await sampleMetrics(opts.url, opts.metricsToken);
    if (m) {
      rssSamples.push({
        elapsedSec: Math.round((performance.now() - startMs) / 1000),
        rssMb: Math.round((m.rssBytes / (1024 * 1024)) * 100) / 100,
        lagMs: m.eventLoopLagMs,
      });
    }
  };
  await recordSample();
  const sampleInterval = setInterval(() => {
    void recordSample();
  }, Math.min(30_000, Math.max(2_000, Math.floor(opts.durationMs / 5))));

  const worker = async (workerId: number) => {
    let iter = 0;
    while (performance.now() < endMs) {
      iter++;
      const isWrite = iter % 4 === 0; // 25% POST /items, 75% GET /items/:id
      const reqStart = performance.now();
      try {
        let res: Response;
        if (isWrite) {
          res = await fetch(`${opts.url}/items`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              name: `load-w${workerId}-${iter}`,
              quantity: iter % 100,
            }),
          });
          if (res.status === 201) {
            const body = (await res.json()) as { id: number };
            if (knownIds.length < 200) {
              knownIds.push(body.id);
            }
          } else {
            await res.arrayBuffer();
          }
        } else {
          const id = knownIds[iter % knownIds.length]!;
          res = await fetch(`${opts.url}/items/${id}`);
          await res.arrayBuffer();
        }
        const elapsed = performance.now() - reqStart;
        latencies.push(elapsed);
        totalRequests++;
        if (res.status >= 500) count5xx++;
        else if (res.status >= 400) count4xx++;
        else count2xx++;
      } catch {
        const elapsed = performance.now() - reqStart;
        latencies.push(elapsed);
        totalRequests++;
        networkErrors++;
      }
    }
  };

  await Promise.all(
    Array.from({ length: opts.concurrency }, (_, i) => worker(i + 1)),
  );
  clearInterval(sampleInterval);
  await recordSample();

  const totalSec = (performance.now() - startMs) / 1000;
  latencies.sort((a, b) => a - b);

  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);
  const p99 = percentile(latencies, 99);
  const rps = totalRequests / Math.max(totalSec, 0.001);
  const error5xxRate =
    totalRequests > 0 ? (count5xx + networkErrors) / totalRequests : 0;

  const rssStartMb = rssSamples[0]?.rssMb ?? null;
  const rssEndMb = rssSamples[rssSamples.length - 1]?.rssMb ?? null;
  const maxLagMs =
    rssSamples.length > 0
      ? Math.max(...rssSamples.map((s) => s.lagMs))
      : null;

  const report = {
    startedAt,
    finishedAt: new Date().toISOString(),
    environment: {
      bunVersion: Bun.version,
      platform: process.platform,
      arch: process.arch,
      cpus: navigator.hardwareConcurrency,
    },
    command: `bun run --cwd examples/production-rest-postgres load --url=${opts.url} --duration=${opts.durationMs}ms --concurrency=${opts.concurrency}`,
    summary: {
      durationSec: Math.round(totalSec * 100) / 100,
      concurrency: opts.concurrency,
      totalRequests,
      throughputRps: Math.round(rps * 100) / 100,
      status2xx: count2xx,
      status4xx: count4xx,
      status5xx: count5xx,
      networkErrors,
      error5xxRate: Math.round(error5xxRate * 100_000) / 100_000,
      latencyMs: {
        p50: Math.round(p50 * 100) / 100,
        p95: Math.round(p95 * 100) / 100,
        p99: Math.round(p99 * 100) / 100,
      },
      rssMb: {
        start: rssStartMb,
        end: rssEndMb,
        samples: rssSamples,
      },
      maxEventLoopLagMs: maxLagMs,
    },
    gates: {
      p95UnderLimit: p95 < opts.p95LimitMs,
      p95LimitMs: opts.p95LimitMs,
      errorRateUnderLimit: error5xxRate < opts.errorRateLimit,
      errorRateLimit: opts.errorRateLimit,
    },
  };

  const json = JSON.stringify(report, null, 2);
  console.log(json);
  if (opts.outputPath) {
    await Bun.write(opts.outputPath, json + "\n");
  }

  if (!report.gates.p95UnderLimit || !report.gates.errorRateUnderLimit) {
    console.error("[load-test] FAILED performance/reliability gate!");
    process.exit(1);
  }
}

await main();
