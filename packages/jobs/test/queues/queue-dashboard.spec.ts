import { describe, expect, it } from "bun:test";
import {
  Injectable,
  Module,
  type CanActivate,
  type ExecutionContext,
} from "@bunest/core";
import { Test } from "@bunest/testing";
import {
  InjectQueue,
  MemoryQueueDriver,
  Process,
  Processor,
  Queue,
  QueueDashboardModule,
  QueueModule,
  type Job,
  type QueueDashboardJobsResponse,
  type QueueDashboardQueuesResponse,
} from "../../src/queues";

async function waitUntil(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
}

describe("QueueDashboardModule (Zero-Dep Queue Admin Dashboard UI & JSON API)", () => {
  it("serves self-contained dark HTML UI and full JSON admin API (queues, jobs, retry, pause, resume)", async () => {
    let failExport = true;

    @Processor("emails")
    class EmailProcessor {
      @Process("send")
      async onSend(job: Job<{ to: string }>) {
        return `sent:${job.data.to}`;
      }
    }

    @Processor("exports")
    class ExportProcessor {
      @Process("csv")
      async onCsv(job: Job<{ report: string }>) {
        if (failExport) {
          throw new Error("export-storage-offline");
        }
        return `exported:${job.data.report}`;
      }
    }

    @Injectable()
    class Producers {
      constructor(
        @InjectQueue("emails") public readonly emails: Queue<{ to: string }, string>,
        @InjectQueue("exports")
        public readonly exportsQueue: Queue<{ report: string }, string>,
      ) {}
    }

    @Module({
      imports: [
        QueueModule.forRoot({ driver: new MemoryQueueDriver() }),
        QueueModule.registerQueue({ name: "emails" }, { name: "exports" }),
        QueueDashboardModule.forRoot({
          path: "/ops/queues",
          title: "Ops Queue Console",
        }),
      ],
      providers: [EmailProcessor, ExportProcessor, Producers],
    })
    class AppModule {}

    const mod = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const app = mod.createBunestApplication();
    await app.init();

    try {
      const producers = mod.get(Producers);
      await producers.emails.add("send", { to: "ada@bunest.dev" });
      const failedJob = await producers.exportsQueue.add(
        "csv",
        { report: "q4" },
        { attempts: 1 },
      );
      await producers.emails.add(
        "send",
        { to: "future@bunest.dev" },
        { delayMs: 30_000 },
      );

      await waitUntil(
        async () =>
          (await producers.emails.getCounts()).completed === 1 &&
          (await producers.exportsQueue.getCounts()).deadLetter === 1,
      );

      // 1. Self-contained zero-dep dark HTML UI
      const uiRes = await app.inject({ method: "GET", url: "/ops/queues" });
      expect(uiRes.statusCode).toBe(200);
      expect(uiRes.headers["content-type"]).toContain("text/html");
      const html = uiRes.body;
      expect(html).toContain("Ops Queue Console");
      expect(html).toContain("/ops/queues/api");
      expect(html).toContain("color-scheme: dark");
      expect(html).not.toMatch(/https?:\/\/[^\s"'<>]*(cdn|unpkg|jsdelivr)/i);

      // 2. List queues
      const queuesRes = await app.inject({
        method: "GET",
        url: "/ops/queues/api/queues",
      });
      expect(queuesRes.statusCode).toBe(200);
      const queuesBody = JSON.parse(queuesRes.body) as QueueDashboardQueuesResponse;
      expect(queuesBody.title).toBe("Ops Queue Console");
      expect(queuesBody.queues.map((q) => q.name)).toEqual(["emails", "exports"]);
      const emailSummary = queuesBody.queues[0]!;
      expect(emailSummary.counts.completed).toBe(1);
      expect(emailSummary.counts.delayed).toBe(1);

      // 3. List jobs with status filtering
      const dlqListRes = await app.inject({
        method: "GET",
        url: "/ops/queues/api/queues/exports/jobs?status=dead-letter",
      });
      expect(dlqListRes.statusCode).toBe(200);
      const dlqList = JSON.parse(dlqListRes.body) as QueueDashboardJobsResponse;
      expect(dlqList.jobs).toHaveLength(1);
      expect(dlqList.jobs[0]!.id).toBe(failedJob.id);
      expect(dlqList.jobs[0]!.failedReason).toBe("export-storage-offline");

      // Invalid status filter -> 400
      const badStatusRes = await app.inject({
        method: "GET",
        url: "/ops/queues/api/queues/exports/jobs?status=bogus",
      });
      expect(badStatusRes.statusCode).toBe(400);

      // 4. Pause and resume queue
      const pauseRes = await app.inject({
        method: "POST",
        url: "/ops/queues/api/queues/emails/pause",
      });
      expect(pauseRes.statusCode).toBe(200);
      expect(JSON.parse(pauseRes.body)).toEqual({
        ok: true,
        queue: "emails",
        isPaused: true,
      });
      expect(producers.emails.isPaused).toBe(true);

      const resumeRes = await app.inject({
        method: "POST",
        url: "/ops/queues/api/queues/emails/resume",
      });
      expect(resumeRes.statusCode).toBe(200);
      expect(JSON.parse(resumeRes.body)).toEqual({
        ok: true,
        queue: "emails",
        isPaused: false,
      });
      expect(producers.emails.isPaused).toBe(false);

      // 5. Retry dead-lettered job via admin API
      failExport = false;
      const retryRes = await app.inject({
        method: "POST",
        url: `/ops/queues/api/queues/exports/jobs/${encodeURIComponent(failedJob.id)}/retry`,
      });
      expect(retryRes.statusCode).toBe(200);
      expect(JSON.parse(retryRes.body).ok).toBe(true);

      await waitUntil(
        async () => (await producers.exportsQueue.getJob(failedJob.id))?.status === "completed",
      );
      expect(
        (await producers.exportsQueue.getJob(failedJob.id))?.returnValue,
      ).toBe("exported:q4");
    } finally {
      await app.close();
    }
  });

  it("enforces guards and queues allowlist on QueueDashboardModule", async () => {
    @Injectable()
    class AdminTokenGuard implements CanActivate {
      canActivate(context: ExecutionContext): boolean {
        const req = context.switchToHttp().getRequest<Request>();
        return req.headers.get("x-admin-token") === "super-secret";
      }
    }

    @Module({
      imports: [
        QueueModule.forRoot({ driver: new MemoryQueueDriver() }),
        QueueModule.registerQueue({ name: "public-q" }, { name: "hidden-q" }),
        QueueDashboardModule.forRoot({
          queues: ["public-q"],
          guards: [AdminTokenGuard],
        }),
      ],
      providers: [AdminTokenGuard],
    })
    class GuardedAppModule {}

    const mod = await Test.createTestingModule({
      imports: [GuardedAppModule],
    }).compile();
    const app = mod.createBunestApplication();
    await app.init();

    try {
      // Unauthenticated request blocked by guard
      const unauthUi = await app.inject({
        method: "GET",
        url: "/admin/queues",
      });
      expect(unauthUi.statusCode).toBe(403);

      const unauthApi = await app.inject({
        method: "GET",
        url: "/admin/queues/api/queues",
      });
      expect(unauthApi.statusCode).toBe(403);

      // Authenticated request sees only allowlisted queue
      const authApi = await app.inject({
        method: "GET",
        url: "/admin/queues/api/queues",
        headers: { "x-admin-token": "super-secret" },
      });
      expect(authApi.statusCode).toBe(200);
      const body = JSON.parse(authApi.body) as QueueDashboardQueuesResponse;
      expect(body.queues.map((q) => q.name)).toEqual(["public-q"]);

      // Accessing non-allowlisted queue returns 404
      const hiddenRes = await app.inject({
        method: "GET",
        url: "/admin/queues/api/queues/hidden-q/jobs",
        headers: { "x-admin-token": "super-secret" },
      });
      expect(hiddenRes.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
