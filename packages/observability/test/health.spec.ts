import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { BunestFactory, Module } from "@bunest/core";
import {
  CustomHealthIndicator,
  EventLoopHealthIndicator,
  HealthModule,
  MemoryHealthIndicator,
  QueueHealthIndicator,
  SqlHealthIndicator,
} from "../src";

describe("HealthModule & Built-in Health Indicators", () => {
  it("returns 200 OK for healthy /health and /ready endpoints across all built-in indicators", async () => {
    const memory = new MemoryHealthIndicator();
    const eventLoop = new EventLoopHealthIndicator(500);
    const sql = new SqlHealthIndicator({ healthCheck: async () => true });
    const queue = new QueueHealthIndicator(
      {
        getCounts: async () => ({
          waiting: 2,
          active: 1,
          failed: 0,
          deadLetter: 0,
        }),
      },
      { maxDeadLetter: 5, maxWaiting: 100 },
    );
    const custom = new CustomHealthIndicator(async () => true);

    @Module({
      imports: [
        HealthModule.forRoot({
          livenessPath: "/health",
          readinessPath: "/ready",
          livenessIndicators: [
            () => memory.checkHeap("memory_heap", 10 * 1024 * 1024 * 1024),
            () => eventLoop.check("event_loop"),
          ],
          readinessIndicators: [
            () => sql.check("postgres"),
            () => queue.check("jobs_queue"),
            () => custom.check("external_api"),
          ],
        }),
      ],
    })
    class HealthyApp {}

    const app = await BunestFactory.create(HealthyApp, { logger: false });
    try {
      const liveRes = await app.fetch(new Request("http://localhost/health"));
      expect(liveRes.status).toBe(200);
      const liveBody = (await liveRes.json()) as Record<string, any>;
      expect(liveBody.status).toBe("ok");
      expect(liveBody.details.memory_heap.status).toBe("up");
      expect(liveBody.details.event_loop.status).toBe("up");

      const readyRes = await app.fetch(new Request("http://localhost/ready"));
      expect(readyRes.status).toBe(200);
      const readyBody = (await readyRes.json()) as Record<string, any>;
      expect(readyBody.status).toBe("ok");
      expect(readyBody.details.postgres.status).toBe("up");
      expect(readyBody.details.jobs_queue.status).toBe("up");
      expect(readyBody.details.external_api.status).toBe("up");
      expect(Object.keys(readyBody.error)).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("returns 503 Service Unavailable with per-indicator details on failing or timed-out indicators", async () => {
    const failingSql = new SqlHealthIndicator({
      healthCheck: async () => {
        throw new Error("ECONNREFUSED 5432");
      },
    });
    const overloadedQueue = new QueueHealthIndicator(
      { getCounts: () => ({ deadLetter: 12, waiting: 3 }) },
      { maxDeadLetter: 5 },
    );
    const tinyMemory = new MemoryHealthIndicator();

    @Module({
      imports: [
        HealthModule.forRoot({
          timeoutMs: 40,
          livenessPath: "/health/live",
          readinessPath: "/health/ready",
          livenessIndicators: [
            async () => {
              await Bun.sleep(200);
              return { slow: { status: "up" } };
            },
          ],
          readinessIndicators: [
            () => failingSql.check("db"),
            () => overloadedQueue.check("queue"),
            () => tinyMemory.checkRSS("memory_rss", 1),
          ],
        }),
      ],
    })
    class UnhealthyApp {}

    const app = await BunestFactory.create(UnhealthyApp, { logger: false });
    try {
      // Timed-out indicator -> 503
      const timeoutRes = await app.fetch(
        new Request("http://localhost/health/live"),
      );
      expect(timeoutRes.status).toBe(503);
      const timeoutBody = (await timeoutRes.json()) as Record<string, any>;
      expect(timeoutBody.status).toBe("error");
      expect(timeoutBody.error.indicator_0.status).toBe("down");
      expect(timeoutBody.error.indicator_0.message).toContain("timed out");

      // Failing DB + overloaded queue + RSS threshold -> 503 with detailed breakdown
      const failRes = await app.fetch(
        new Request("http://localhost/health/ready"),
      );
      expect(failRes.status).toBe(503);
      const failBody = (await failRes.json()) as Record<string, any>;
      expect(failBody.status).toBe("error");
      expect(failBody.error.db.status).toBe("down");
      expect(failBody.error.db.message).toContain("ECONNREFUSED");
      expect(failBody.error.queue.status).toBe("down");
      expect(failBody.error.queue.message).toContain("deadLetter");
      expect(failBody.error.memory_rss.status).toBe("down");
    } finally {
      await app.close();
    }
  });
});
