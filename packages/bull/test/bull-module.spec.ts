import "reflect-metadata";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Inject, Injectable, Module, Reflector, Scope } from "@bunest/common";
import { BunestFactory } from "@bunest/core";
import {
  BULL_CONFIG_DEFAULT_TOKEN,
  BULL_MODULE_ON_QUEUE_EVENT,
  BULL_MODULE_QUEUE,
  BULL_MODULE_QUEUE_PROCESS,
  type BullJob,
  BullMetadataAccessor,
  BullModule,
  type BullModuleOptions,
  type BullOptionsFactory,
  type BullQueue,
  BullQueueEvents,
  BullQueueGlobalEvents,
  type BullRootModuleOptions,
  getQueueOptionsToken,
  getQueueToken,
  getSharedConfigToken,
  InjectQueue,
  JOB_REF,
  MissingBullSharedConfigurationError,
  OnGlobalQueueActive,
  OnGlobalQueueCleaned,
  OnGlobalQueueCompleted,
  OnGlobalQueueDrained,
  OnGlobalQueueError,
  OnGlobalQueueFailed,
  OnGlobalQueuePaused,
  OnGlobalQueueProgress,
  OnGlobalQueueRemoved,
  OnGlobalQueueResumed,
  OnGlobalQueueStalled,
  OnGlobalQueueWaiting,
  OnQueueActive,
  OnQueueCleaned,
  OnQueueCompleted,
  OnQueueDrained,
  OnQueueError,
  OnQueueEvent,
  OnQueueFailed,
  OnQueuePaused,
  OnQueueProgress,
  OnQueueRemoved,
  OnQueueResumed,
  OnQueueStalled,
  OnQueueWaiting,
  Process,
  Processor,
  type SharedBullConfigurationFactory,
} from "../src/index";

describe("@bunest/bull — 100% @nestjs/bull API Parity on @bunest/queues", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await Promise.resolve(cleanups.pop()!()).catch(() => {});
    }
  });

  test("exports exact NestJS Bull tokens, constants, and 24 queue event enum values", () => {
    expect(getQueueToken()).toBe("BullQueue_default");
    expect(getQueueToken("audio")).toBe("BullQueue_audio");
    expect(getQueueOptionsToken()).toBe("BullQueueOptions_default");
    expect(getQueueOptionsToken("audio")).toBe("BullQueueOptions_audio");
    expect(BULL_CONFIG_DEFAULT_TOKEN).toBe("BULL_CONFIG(default)");
    expect(getSharedConfigToken()).toBe("BULL_CONFIG(default)");
    expect(getSharedConfigToken("secondary")).toBe("BULL_CONFIG(secondary)");
    expect(JOB_REF).toBe("REQUEST");
    expect(BULL_MODULE_QUEUE).toBe("bull:module_queue");
    expect(BULL_MODULE_QUEUE_PROCESS).toBe("bull:module_queue_process");
    expect(BULL_MODULE_ON_QUEUE_EVENT).toBe("bull:module_on_queue_event");

    expect(Object.values(BullQueueEvents) as string[]).toEqual([
      "error",
      "waiting",
      "active",
      "stalled",
      "progress",
      "completed",
      "failed",
      "paused",
      "resumed",
      "cleaned",
      "drained",
      "removed",
    ]);
    expect(Object.values(BullQueueGlobalEvents) as string[]).toEqual([
      "global:error",
      "global:waiting",
      "global:active",
      "global:stalled",
      "global:progress",
      "global:completed",
      "global:failed",
      "global:paused",
      "global:resumed",
      "global:cleaned",
      "global:drained",
      "global:removed",
    ]);
  });

  test("BullModule.forRoot + registerQueue + @Processor + @Process + @InjectQueue + local/global/filtered event hooks", async () => {
    const events: string[] = [];

    @Processor("audio")
    class AudioProcessor {
      @Process()
      async handleDefault(job: BullJob<{ file: string }>) {
        await job.progress(50);
        await job.log(`transcoding ${job.data.file}`);
        await job.progress(100);
        return { ok: true, file: job.data.file };
      }

      @Process({ name: "compress", concurrency: 2 })
      handleCompress(
        job: BullJob<{ file: string }>,
        done?: (err?: Error | null, res?: any) => void,
      ) {
        if (job.data.file === "bad.mp3") {
          done?.(new Error("corrupt audio"));
          return;
        }
        done?.(null, { compressed: job.data.file });
      }

      @OnQueueWaiting()
      onWaiting(jobId: string) {
        events.push(`waiting:${jobId}`);
      }

      @OnQueueActive()
      onActive(job: BullJob) {
        events.push(`active:${job.name}`);
      }

      @OnQueueProgress()
      onProgress(job: BullJob, progress: number) {
        events.push(`progress:${job.name}:${progress}`);
      }

      @OnQueueCompleted()
      onCompleted(job: BullJob, result: any) {
        events.push(`completed:${job.name}:${JSON.stringify(result)}`);
      }

      @OnQueueCompleted({ name: "compress" })
      onCompressCompleted(job: BullJob) {
        events.push(`filtered-completed:${job.name}`);
      }

      @OnGlobalQueueCompleted({ name: "compress" })
      onGlobalCompressCompleted(job: BullJob) {
        events.push(`global-filtered-completed:${job.name}`);
      }

      @OnQueueFailed()
      onFailed(job: BullJob, err: Error) {
        events.push(`failed:${job.name}:${err.message}`);
      }

      @OnGlobalQueueFailed()
      onGlobalFailed(jobId: string, errMsg: string) {
        events.push(`global-failed:${jobId}:${errMsg}`);
      }

      @OnQueuePaused()
      onPaused() {
        events.push("paused");
      }

      @OnGlobalQueueResumed()
      onGlobalResumed() {
        events.push("global-resumed");
      }

      @OnQueueCleaned()
      onCleaned(jobs: BullJob[], type: string) {
        events.push(`cleaned:${jobs.length}:${type}`);
      }

      @OnQueueRemoved()
      onRemoved(job: BullJob) {
        events.push(`removed:${job.id}`);
      }

      @OnQueueDrained()
      onDrained() {
        events.push("drained");
      }

      @OnQueueError()
      onError(err: Error) {
        events.push(`error:${err.message}`);
      }
    }

    @Injectable()
    class AudioService {
      constructor(@InjectQueue("audio") public readonly queue: BullQueue) {}
    }

    @Module({
      imports: [
        BullModule.forRoot({
          prefix: "bunest-test",
          defaultJobOptions: { attempts: 1 },
        }),
        BullModule.registerQueue({ name: "audio" }),
      ],
      providers: [AudioProcessor, AudioService],
    })
    class AudioModule {}

    const app = await BunestFactory.create(AudioModule, { logger: false });
    cleanups.push(() => app.close());
    await app.init();

    const svc = app.get(AudioService);
    const job1 = await svc.queue.add({ file: "song.wav" });
    const res1 = await job1.finished();
    expect(res1).toEqual({ ok: true, file: "song.wav" });
    expect(job1.progress()).toBe(100);
    expect(await job1.isCompleted()).toBe(true);
    expect(await svc.queue.getJobLogs(job1.id)).toEqual({
      logs: ["transcoding song.wav"],
      count: 1,
    });

    const job2 = await svc.queue.add("compress", { file: "clip.mp3" });
    const res2 = await job2.finished();
    expect(res2).toEqual({ compressed: "clip.mp3" });

    const job3 = await svc.queue.add("compress", { file: "bad.mp3" });
    await expect(job3.finished()).rejects.toThrow("corrupt audio");
    expect(await job3.isFailed()).toBe(true);

    // Pause / resume / clean / remove
    await svc.queue.pause();
    expect(await svc.queue.isPaused()).toBe(true);
    await svc.queue.resume();
    expect(await svc.queue.isPaused()).toBe(false);

    const cleaned = await svc.queue.clean(0, "completed");
    expect(cleaned.length).toBeGreaterThanOrEqual(2);

    await job3.remove();

    const counts = await svc.queue.getJobCounts();
    expect(counts.completed).toBeGreaterThanOrEqual(2);
    expect(counts.failed).toBeGreaterThanOrEqual(1);

    // Verify all event handlers fired (including filtered local & global events!)
    expect(events).toContain("active:__default__");
    expect(events).toContain("progress:__default__:50");
    expect(events).toContain("progress:__default__:100");
    expect(events).toContain("filtered-completed:compress");
    expect(events).toContain("global-filtered-completed:compress");
    expect(events.some((e) => e.startsWith("failed:compress:corrupt audio"))).toBe(
      true,
    );
    expect(events.some((e) => e.startsWith("global-failed:"))).toBe(true);
    expect(events).toContain("paused");
    expect(events).toContain("global-resumed");
    expect(events.some((e) => e.startsWith("cleaned:"))).toBe(true);
    expect(events).toContain(`removed:${job3.id}`);
    expect(events).toContain("drained");
  });

  test("Scope.REQUEST @Processor injects per-job JOB_REF cleanly", async () => {
    const seenJobIds: string[] = [];

    @Processor({ name: "scoped-q", scope: Scope.REQUEST })
    class ScopedProcessor {
      constructor(@Inject(JOB_REF) private readonly jobRef: BullJob<{ v: number }>) {}

      @Process("compute")
      async compute(job: BullJob<{ v: number }>) {
        expect(this.jobRef.id).toBe(job.id);
        seenJobIds.push(String(this.jobRef.id));
        return job.data.v * 10;
      }
    }

    @Module({
      imports: [BullModule.registerQueue({ name: "scoped-q" })],
      providers: [ScopedProcessor],
    })
    class ScopedModule {}

    const app = await BunestFactory.create(ScopedModule, { logger: false });
    cleanups.push(() => app.close());
    await app.init();

    const queue = app.get<BullQueue>(getQueueToken("scoped-q"));
    const j1 = await queue.add("compute", { v: 2 }, { jobId: "req-1" });
    const j2 = await queue.add("compute", { v: 5 }, { jobId: "req-2" });

    expect(await j1.finished()).toBe(20);
    expect(await j2.finished()).toBe(50);
    expect(seenJobIds.sort()).toEqual(["req-1", "req-2"]);
  });

  test("forRootAsync, named configKey, registerQueueAsync (useFactory/useClass/useExisting), MissingBullSharedConfigurationError, and inline/separate processors", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "bunest-bull-proc-"));
    cleanups.push(() => rmSync(tmpDir, { recursive: true, force: true }));
    const separateProcFile = join(tmpDir, "sep-processor.ts");
    writeFileSync(
      separateProcFile,
      `export default async function(job: { data: { n: number } }) { return job.data.n + 100; }\n`,
      "utf8",
    );

    @Injectable()
    class SharedCfgFactory implements SharedBullConfigurationFactory {
      createSharedConfiguration(): BullRootModuleOptions {
        return {
          prefix: "shared-alt",
          defaultJobOptions: { priority: 3 },
        };
      }
    }

    @Injectable()
    class QueueCfgFactory implements BullOptionsFactory {
      createBullOptions(): BullModuleOptions {
        return {
          processors: [
            {
              name: "inline",
              concurrency: 2,
              callback: async (job) => `inline:${job.data.x}`,
            },
            {
              name: "separate",
              path: separateProcFile,
            },
          ],
        };
      }
    }

    @Module({
      imports: [
        BullModule.forRootAsync("alt", { useClass: SharedCfgFactory }),
        BullModule.registerQueueAsync(
          {
            name: "async-factory",
            configKey: "alt",
            useFactory: () => ({
              processors: [async (job) => `default:${job.data.msg}`],
            }),
          },
          {
            name: "async-class",
            configKey: "alt",
            useClass: QueueCfgFactory,
          },
        ),
      ],
    })
    class AsyncBullAppModule {}

    const app = await BunestFactory.create(AsyncBullAppModule, {
      logger: false,
    });
    cleanups.push(() => app.close());
    await app.init();

    const q1 = app.get<BullQueue>(getQueueToken("async-factory"));
    expect(q1.options.prefix).toBe("shared-alt");
    const r1 = await (await q1.add({ msg: "hi" })).finished();
    expect(r1).toBe("default:hi");

    const q2 = app.get<BullQueue>(getQueueToken("async-class"));
    expect(q2.options.prefix).toBe("shared-alt");
    const r2 = await (await q2.add("inline", { x: 7 })).finished();
    expect(r2).toBe("inline:7");
    const r3 = await (await q2.add("separate", { n: 23 })).finished();
    expect(r3).toBe(123);

    // Missing named configKey throws MissingBullSharedConfigurationError
    @Module({
      imports: [
        BullModule.registerQueue({ name: "broken", configKey: "does-not-exist" }),
      ],
    })
    class BrokenConfigModule {}

    await expect(
      BunestFactory.create(BrokenConfigModule, { logger: false }),
    ).rejects.toThrow(MissingBullSharedConfigurationError);
  });

  test("all 25 queue hook decorators attach exact metadata read by BullMetadataAccessor", () => {
    const accessor = new BullMetadataAccessor(new Reflector());

    @Processor("meta-q")
    class AllHooksProcessor {
      @Process("task") task() {}
      @OnQueueEvent("active") evDirect() {}
      @OnQueueError() e1() {}
      @OnQueueWaiting() e2() {}
      @OnQueueActive() e3() {}
      @OnQueueStalled() e4() {}
      @OnQueueProgress() e5() {}
      @OnQueueCompleted({ id: "99" }) e6() {}
      @OnQueueFailed() e7() {}
      @OnQueuePaused() e8() {}
      @OnQueueResumed() e9() {}
      @OnQueueCleaned() e10() {}
      @OnQueueDrained() e11() {}
      @OnQueueRemoved() e12() {}
      @OnGlobalQueueError() g1() {}
      @OnGlobalQueueWaiting() g2() {}
      @OnGlobalQueueActive() g3() {}
      @OnGlobalQueueStalled() g4() {}
      @OnGlobalQueueProgress() g5() {}
      @OnGlobalQueueCompleted({ name: "task" }) g6() {}
      @OnGlobalQueueFailed() g7() {}
      @OnGlobalQueuePaused() g8() {}
      @OnGlobalQueueResumed() g9() {}
      @OnGlobalQueueCleaned() g10() {}
      @OnGlobalQueueDrained() g11() {}
      @OnGlobalQueueRemoved() g12() {}
    }

    expect(accessor.isQueueComponent(AllHooksProcessor)).toBe(true);
    expect(accessor.getQueueComponentMetadata(AllHooksProcessor)).toEqual({
      name: "meta-q",
    });

    const proto = AllHooksProcessor.prototype;
    expect(accessor.isProcessor(proto.task)).toBe(true);
    expect(accessor.getProcessMetadata(proto.task)).toEqual({ name: "task" });

    expect(accessor.getListenerMetadata(proto.evDirect)?.eventName).toBe("active");
    expect(accessor.getListenerMetadata(proto.e1)?.eventName).toBe(BullQueueEvents.ERROR);
    expect(accessor.getListenerMetadata(proto.e2)?.eventName).toBe(BullQueueEvents.WAITING);
    expect(accessor.getListenerMetadata(proto.e3)?.eventName).toBe(BullQueueEvents.ACTIVE);
    expect(accessor.getListenerMetadata(proto.e4)?.eventName).toBe(BullQueueEvents.STALLED);
    expect(accessor.getListenerMetadata(proto.e5)?.eventName).toBe(BullQueueEvents.PROGRESS);
    expect(accessor.getListenerMetadata(proto.e6)).toEqual({
      eventName: BullQueueEvents.COMPLETED,
      id: "99",
    });
    expect(accessor.getListenerMetadata(proto.e7)?.eventName).toBe(BullQueueEvents.FAILED);
    expect(accessor.getListenerMetadata(proto.e8)?.eventName).toBe(BullQueueEvents.PAUSED);
    expect(accessor.getListenerMetadata(proto.e9)?.eventName).toBe(BullQueueEvents.RESUMED);
    expect(accessor.getListenerMetadata(proto.e10)?.eventName).toBe(BullQueueEvents.CLEANED);
    expect(accessor.getListenerMetadata(proto.e11)?.eventName).toBe(BullQueueEvents.DRAINED);
    expect(accessor.getListenerMetadata(proto.e12)?.eventName).toBe(BullQueueEvents.REMOVED);

    expect(accessor.getListenerMetadata(proto.g1)?.eventName).toBe(BullQueueGlobalEvents.ERROR);
    expect(accessor.getListenerMetadata(proto.g2)?.eventName).toBe(BullQueueGlobalEvents.WAITING);
    expect(accessor.getListenerMetadata(proto.g3)?.eventName).toBe(BullQueueGlobalEvents.ACTIVE);
    expect(accessor.getListenerMetadata(proto.g4)?.eventName).toBe(BullQueueGlobalEvents.STALLED);
    expect(accessor.getListenerMetadata(proto.g5)?.eventName).toBe(BullQueueGlobalEvents.PROGRESS);
    expect(accessor.getListenerMetadata(proto.g6)).toEqual({
      eventName: BullQueueGlobalEvents.COMPLETED,
      name: "task",
    });
    expect(accessor.getListenerMetadata(proto.g7)?.eventName).toBe(BullQueueGlobalEvents.FAILED);
    expect(accessor.getListenerMetadata(proto.g8)?.eventName).toBe(BullQueueGlobalEvents.PAUSED);
    expect(accessor.getListenerMetadata(proto.g9)?.eventName).toBe(BullQueueGlobalEvents.RESUMED);
    expect(accessor.getListenerMetadata(proto.g10)?.eventName).toBe(BullQueueGlobalEvents.CLEANED);
    expect(accessor.getListenerMetadata(proto.g11)?.eventName).toBe(BullQueueGlobalEvents.DRAINED);
    expect(accessor.getListenerMetadata(proto.g12)?.eventName).toBe(BullQueueGlobalEvents.REMOVED);
  });
});
