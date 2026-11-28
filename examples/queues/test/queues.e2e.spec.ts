import { describe, expect, it } from "bun:test";
import { Test } from "@bunest/testing";
import { AppModule } from "../src/app.module";

async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

describe("Background Queues (NestJS 26-queues E2E)", () => {
  it("enqueues transcoding jobs, processes them via WorkerHost, records worker/queue events, and handles failures", async () => {
    const mod = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const app = mod.createBunestApplication();
    const client = mod.createTestClient(app);
    await app.init();

    try {
      // 1. Enqueue a valid audio transcode job
      const enqueueOk = await client.post("/audio/transcode", {
        json: { file: "podcast.wav", format: "ogg" },
      });
      expect(enqueueOk.status).toBe(201);
      const { jobId: okId } = (await enqueueOk.json()) as { jobId: string };

      // 2. Enqueue a failing corrupt job
      const enqueueBad = await client.post("/audio/transcode", {
        json: { file: "broken.corrupt", format: "mp3" },
      });
      expect(enqueueBad.status).toBe(201);
      const { jobId: badId } = (await enqueueBad.json()) as { jobId: string };

      // Wait until both jobs finish processing
      await waitUntil(async () => {
        const j1 = (await (await client.get(`/audio/jobs/${okId}`)).json()) as {
          status: string;
        };
        const j2 = (await (
          await client.get(`/audio/jobs/${badId}`)
        ).json()) as { status: string };
        return (
          j1.status === "completed" &&
          (j2.status === "failed" || j2.status === "dead-letter")
        );
      });

      const okJob = (await (
        await client.get(`/audio/jobs/${okId}`)
      ).json()) as {
        status: string;
        result: { outputFile: string; format: string };
      };
      expect(okJob.status).toBe("completed");
      expect(okJob.result.outputFile).toBe("podcast.ogg");
      expect(okJob.result.format).toBe("ogg");

      const badJob = (await (
        await client.get(`/audio/jobs/${badId}`)
      ).json()) as {
        status: string;
        failedReason: string;
      };
      expect(["failed", "dead-letter"]).toContain(badJob.status);
      expect(badJob.failedReason).toContain("broken.corrupt");

      // 3. Verify worker & queue lifecycle events
      const stats = (await (await client.get("/audio/stats")).json()) as {
        workerEvents: string[];
        queueEvents: Array<{ event: string; jobId: string }>;
      };
      expect(stats.workerEvents).toContain("active:transcode:podcast.wav");
      expect(stats.workerEvents).toContain("completed:transcode:podcast.ogg");
      expect(
        stats.workerEvents.some((e) => e.startsWith("failed:transcode:")),
      ).toBe(true);
      expect(
        stats.queueEvents.some((e) => e.event === "completed" && e.jobId === okId),
      ).toBe(true);
      expect(
        stats.queueEvents.some((e) => e.event === "failed" && e.jobId === badId),
      ).toBe(true);
    } finally {
      await app.close();
    }
  });
});
