import { describe, expect, it } from "bun:test";
import { Test } from "@bunest/testing";
import { AppModule } from "../src/app.module";

describe("Task Scheduling (NestJS 27-scheduling E2E)", () => {
  it("runs declarative @Interval and @Timeout jobs and manages dynamic cron jobs via SchedulerRegistry", async () => {
    const mod = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const app = mod.createBunestApplication();
    const client = mod.createTestClient(app);
    await app.init();

    try {
      // Wait for warmup timeout (15ms) and at least 2 interval ticks (30ms each)
      await Bun.sleep(95);

      const status = (await (await client.get("/tasks/status")).json()) as {
        intervalRuns: number;
        warmupCompleted: boolean;
      };
      expect(status.warmupCompleted).toBe(true);
      expect(status.intervalRuns).toBeGreaterThanOrEqual(2);

      // Declarative jobs registered in SchedulerRegistry
      const jobsBefore = (await (await client.get("/tasks/jobs")).json()) as {
        crons: string[];
        intervals: string[];
        timeouts: string[];
      };
      expect(jobsBefore.crons).toContain("notifications");
      expect(jobsBefore.intervals).toContain("heartbeat");
      expect(jobsBefore.timeouts).toContain("warmup");

      // Register a dynamic cron job at runtime
      const addRes = await client.post("/tasks/cron", {
        json: { name: "nightly-cleanup", expression: "0 0 * * *" },
      });
      expect(addRes.status).toBe(201);
      const added = (await addRes.json()) as { name: string; nextDate: string };
      expect(added.name).toBe("nightly-cleanup");
      expect(Date.parse(added.nextDate)).toBeGreaterThan(Date.now());

      const jobsAfterAdd = (await (await client.get("/tasks/jobs")).json()) as {
        crons: string[];
      };
      expect(jobsAfterAdd.crons).toContain("nightly-cleanup");

      // Delete dynamic cron job
      const delRes = await client.delete("/tasks/cron/nightly-cleanup");
      expect(delRes.status).toBe(200);
      const jobsAfterDel = (await (await client.get("/tasks/jobs")).json()) as {
        crons: string[];
      };
      expect(jobsAfterDel.crons).not.toContain("nightly-cleanup");
    } finally {
      await app.close();
    }
  });
});
