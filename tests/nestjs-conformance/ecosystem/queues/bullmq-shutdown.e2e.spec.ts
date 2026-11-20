import "reflect-metadata";
import { expect, it } from "bun:test";
import { Module } from "../../../../packages/common/src";
import { NestFactory } from "../../../../packages/core/src";
import {
  BullModule,
  InjectQueue,
  MemoryQueueDriver,
  Processor,
  Queue,
  WorkerHost,
  getQueueToken,
  type Job,
} from "../../../../packages/queues/src";
import { describeConformance } from "../../_helpers/index";

/**
 * In-memory driver that preserves bucket state across `close()` so the test
 * can inspect persisted target queue counts after `app.close()`, mirroring
 * upstream Redis inspection via a fresh `new Queue(targetName, { connection })`.
 */
class InspectableMemoryQueueDriver extends MemoryQueueDriver {
  override close(): void {
    // Keep buckets intact for post-close count verification; caller invokes `dispose()`.
  }

  dispose(): void {
    super.close();
  }
}

describeConformance(
  "BullModule Shutdown (e2e)",
  {
    upstreamPath: "bull/packages/bullmq/e2e/shutdown.e2e-spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Upstream commit 2686e032f369682b4f93bdcd1cbbe2b45b34bce6. Runs offline against an in-memory InspectableMemoryQueueDriver instead of external Redis.",
  },
  () => {
    // A job that is still running when the application closes should finish
    // against open queues: the worker drains it before any queue is closed.
    // BUNEST_BUG: Expected active job on source queue to successfully add a child job to target queue during app.close() (`outcome: { added: true }` and 1 waiting job), actual fails with `Queue "shutdown_target" is closed and cannot accept jobs.` because BullMQExplorer.onModuleDestroy() (packages/queues/src/adapters/bullmq.adapter.ts) calls QueueRegistry.closeAll() (packages/queues/src/queue.module.ts), closing all queues concurrently in onModuleDestroy instead of draining workers in onModuleDestroy and closing queues in onApplicationShutdown.
    it.skip("should let an active job add to another queue while the app closes", async () => {
      const sourceName = "shutdown_source";
      const targetName = "shutdown_target";
      const driver = new InspectableMemoryQueueDriver();

      let releaseJob!: () => void;
      const jobReleased = new Promise<void>(
        (resolve) => (releaseJob = resolve),
      );
      let jobStarted!: () => void;
      const started = new Promise<void>((resolve) => (jobStarted = resolve));
      const outcome: { added?: boolean; error?: string } = {};

      @Processor(sourceName)
      class SourceProcessor extends WorkerHost {
        constructor(@InjectQueue(targetName) private readonly target: Queue) {
          super();
        }

        async process(job: Job): Promise<void> {
          jobStarted();
          await jobReleased;
          try {
            await this.target.add("child", { parent: job.id });
            outcome.added = true;
          } catch (err) {
            outcome.error = (err as Error).message;
          }
        }
      }

      @Module({
        imports: [
          BullModule.forRoot({ driver }),
          BullModule.registerQueue(
            { name: sourceName },
            { name: targetName },
          ),
        ],
        providers: [SourceProcessor],
      })
      class AppModule {}

      const app = await NestFactory.createApplicationContext(AppModule, {
        logger: false,
      });

      const graceTimer = setTimeout(() => releaseJob(), 200);
      if (typeof (graceTimer as { unref?: () => void }).unref === "function") {
        (graceTimer as { unref: () => void }).unref();
      }

      try {
        const source = app.get<Queue>(getQueueToken(sourceName));
        const target = app.get<Queue>(getQueueToken(targetName));

        // Release the job once the target queue has been closed, or after a grace
        // period if the application waits for the job first.
        const closeTarget = target.close.bind(target);
        target.close = async (timeoutMs?: number) => {
          await closeTarget(timeoutMs);
          releaseJob();
        };

        await source.add("parent", {});
        await started;
        await app.close();

        expect(outcome).toEqual({ added: true });

        const check = new Queue({ name: targetName, driver });
        try {
          const counts = await check.getCounts();
          expect(counts.waiting).toBe(1);
        } finally {
          await check.close();
        }
      } finally {
        clearTimeout(graceTimer);
        releaseJob();
        await app.close().catch(() => {});
        driver.dispose();
      }
    });
  },
);
