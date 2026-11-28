import { describe, expect, it } from "bun:test";
import { diagnosticsChannel } from "@bunest/core";
import {
  InMemorySpanExporter,
  OtelAutoInstrumentation,
  Tracer,
  WORKERS_DISPATCH_DIAGNOSTICS_CHANNEL,
  WorkerPoolHealthIndicator,
  type WorkerPoolHealthSnapshotLike,
} from "../src";

describe("@bunest/observability — Bun Workers tracing & health", () => {
  it("records OTel spans from bunest:workers:dispatch events", () => {
    const exporter = new InMemorySpanExporter();
    const tracer = new Tracer({ serviceName: "workers-test", exporter });
    const auto = new OtelAutoInstrumentation(tracer);

    try {
      const ch = diagnosticsChannel(WORKERS_DISPATCH_DIAGNOSTICS_CHANNEL);
      ch.publish({
        phase: "end",
        pool: "crypto",
        task: "sha256",
        taskId: "crypto-1",
        workerId: "crypto-w1",
        queueWaitMs: 1.5,
        durationMs: 12.4,
        status: "completed",
      });

      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      expect(spans[0]!.name).toBe("workers.run crypto/sha256");
      expect(spans[0]!.status.code).toBe("OK");
      expect(spans[0]!.attributes["worker.pool"]).toBe("crypto");
      expect(spans[0]!.attributes["worker.task"]).toBe("sha256");
      expect(spans[0]!.attributes["worker.thread_id"]).toBe("crypto-w1");
      expect(spans[0]!.attributes["worker.queue_wait_ms"]).toBe(1.5);
    } finally {
      auto.stop();
    }
  });

  it("marks WorkerPoolHealthIndicator down when pool is saturated, crashed, or closed", async () => {
    let snapshot: WorkerPoolHealthSnapshotLike = {
      name: "crypto",
      healthy: true,
      closed: false,
      totalWorkers: 2,
      activeWorkers: 1,
      idleWorkers: 1,
      queuedTasks: 5,
      maxQueueSize: 100,
      maxThreads: 4,
      consecutiveCrashes: 0,
      queueUtilization: 0.05,
    };

    const indicator = new WorkerPoolHealthIndicator(
      { getHealthSnapshot: () => snapshot },
      { maxQueueUtilization: 0.8, maxConsecutiveCrashes: 2 },
    );

    const healthyRes = await indicator.check("workers");
    expect(healthyRes.workers!.status).toBe("up");

    snapshot = { ...snapshot, queueUtilization: 0.9, queuedTasks: 90 };
    const saturatedRes = await indicator.check("workers");
    expect(saturatedRes.workers!.status).toBe("down");
    expect(String(saturatedRes.workers!.message)).toContain("queueUtilization");

    snapshot = { ...snapshot, queueUtilization: 0.1, closed: true, healthy: false };
    const closedRes = await indicator.check("workers");
    expect(closedRes.workers!.status).toBe("down");
    expect(String(closedRes.workers!.message)).toContain("closed");
  });
});
