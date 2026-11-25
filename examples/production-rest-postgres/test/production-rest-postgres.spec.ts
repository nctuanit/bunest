import { describe, expect, it } from "bun:test";
import { loadAppConfig, redactSecrets } from "../src/config";
import { HealthService } from "../src/health.service";
import { MetricsService } from "../src/metrics.service";
import type { DataSource } from "@bunest/orm";

describe("production-rest-postgres — config & secret redaction", () => {
  it("redacts PostgreSQL passwords and Bearer tokens from log strings", () => {
    const raw =
      "Failed connecting to postgres://appuser:s3cr3tP@ss@db.internal:5432/prod with Authorization: Bearer tok_live_abc123456";
    const safe = redactSecrets(raw);
    expect(safe).not.toContain("s3cr3tP@ss");
    expect(safe).not.toContain("tok_live_abc123456");
    expect(safe).toContain("postgres://appuser:[REDACTED]@");
    expect(safe).toContain("Bearer [REDACTED]");
  });

  it("requires DATABASE_URL and applies safe production defaults", () => {
    expect(() => loadAppConfig({})).toThrow(/DATABASE_URL is required/);
    const cfg = loadAppConfig({
      DATABASE_URL: "postgres://user:pass@127.0.0.1:5432/app",
    });
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.port).toBe(3000);
    expect(cfg.dbPoolMax).toBe(10);
    expect(cfg.bodyLimitBytes).toBe(1024 * 1024);
    expect(cfg.trustProxy).toContain("127.0.0.1");
  });
});

describe("production-rest-postgres — HealthService & MetricsService", () => {
  const baseConfig = loadAppConfig({
    DATABASE_URL: "postgres://user:pass@127.0.0.1:5432/app",
    READY_DB_TIMEOUT_MS: "200",
  });

  it("keeps /live ok independently of DB and flips /ready to 503 on DB error or shutdown", async () => {
    let dbUp = true;
    const fakeDs = {
      driver: {
        ping: async () => {
          if (!dbUp) throw new Error("connection refused");
          return true;
        },
      },
    } as unknown as DataSource;

    const health = new HealthService(fakeDs, baseConfig);
    expect(health.liveness().status).toBe("ok");

    const okReady = await health.readiness();
    expect(okReady.ready).toBe(true);
    expect(okReady.database).toBe("up");

    dbUp = false;
    expect(health.liveness().status).toBe("ok");
    const downReady = await health.readiness();
    expect(downReady.ready).toBe(false);
    expect(downReady.reason).toBe("database_unavailable");

    dbUp = true;
    const recoveredReady = await health.readiness();
    expect(recoveredReady.ready).toBe(true);

    health.beginShutdown();
    const drainingReady = await health.readiness();
    expect(drainingReady.ready).toBe(false);
    expect(drainingReady.reason).toBe("shutting_down");
  });

  it("tracks in-flight requests, drains cleanly, and renders Prometheus metrics", async () => {
    const metrics = new MetricsService(baseConfig);
    try {
      metrics.beginRequest();
      expect(metrics.getInFlightCount()).toBe(1);

      const drainPromise = metrics.waitForDrain(1000);
      metrics.endRequest(201, 12.5);
      expect(await drainPromise).toBe(true);
      expect(metrics.getInFlightCount()).toBe(0);

      const prom = metrics.renderPrometheus();
      expect(prom).toContain("bunest_http_requests_total 1");
      expect(prom).toContain("bunest_http_requests_5xx_total 0");
      expect(prom).toContain("bunest_process_resident_memory_bytes");
      expect(prom).toContain("bunest_event_loop_lag_ms");
    } finally {
      metrics.onModuleDestroy();
    }
  });
});
