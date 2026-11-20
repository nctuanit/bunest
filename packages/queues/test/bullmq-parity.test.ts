import "reflect-metadata";
import { afterEach, describe, expect, it } from "bun:test";
import { Inject, Injectable, Module, Scope } from "@bunest/common";
import { Test } from "@bunest/testing";
import {
  BULL_CONFIG_DEFAULT_TOKEN,
  BullMQModule,
  BullModule,
  BullRegistrar,
  FlowProducer,
  InjectFlowProducer,
  InjectQueue,
  JOB_REF,
  MemoryQueueDriver,
  OnQueueEvent,
  OnWorkerEvent,
  Processor,
  ProcessorDecoratorService,
  Queue,
  QueueEvents,
  QueueEventsHost,
  QueueEventsListener,
  QueueModule,
  WorkerHost,
  getFlowProducerOptionsToken,
  getFlowProducerToken,
  getQueueOptionsToken,
  getQueueToken,
  getSharedConfigToken,
  type BullRootModuleOptions,
  type Job,
  type JobHandler,
  type QueueModuleOptions,
  type QueueModuleOptionsFactory,
  type RegisterFlowProducerOptions,
  type RegisterFlowProducerOptionsFactory,
  type RegisterQueueOptions,
  type RegisterQueueOptionsFactory,
  type SharedBullConfigurationFactory,
} from "../src/index";

async function waitUntil(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 2500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
}

describe("@bunest/queues — NestJS @nestjs/bullmq v12 Parity", () => {
  afterEach(() => {
    BullModule.queueClass = undefined;
    BullModule.workerClass = undefined;
    BullModule.flowProducerClass = undefined;
  });

  it("exports all NestJS BullMQ token helpers and constants with default handling", () => {
    expect(BULL_CONFIG_DEFAULT_TOKEN).toBe("BULLMQ_CONFIG(default)");
    expect(JOB_REF).toBe("REQUEST");

    expect(getQueueToken()).toBe("bunest:queues:queue:default");
    expect(getQueueToken("audio")).toBe("bunest:queues:queue:audio");

    expect(getQueueOptionsToken()).toBe("BullMQQueueOptions_default");
    expect(getQueueOptionsToken("audio")).toBe("BullMQQueueOptions_audio");

    expect(getFlowProducerToken()).toBe("BullFlowProducer_default");
    expect(getFlowProducerToken("video-flow")).toBe(
      "BullFlowProducer_video-flow",
    );

    expect(getFlowProducerOptionsToken()).toBe(
      "BullMQFlowProducerOptions_default",
    );
    expect(getFlowProducerOptionsToken("video-flow")).toBe(
      "BullMQFlowProducerOptions_video-flow",
    );

    expect(getSharedConfigToken()).toBe(BULL_CONFIG_DEFAULT_TOKEN);
    expect(getSharedConfigToken("secondary")).toBe("BULLMQ_CONFIG(secondary)");
  });

  it("supports BullModule.forRoot + registerQueue + WorkerHost + @OnWorkerEvent + @QueueEventsListener/QueueEventsHost", async () => {
    const workerEvents: string[] = [];
    const queueEventsLog: Array<{ event: string; jobId: string; extra?: unknown }> = [];
    const processedTokens: Array<string | undefined> = [];

    @Processor("audio", { concurrency: 2 })
    class AudioProcessor extends WorkerHost {
      async process(job: Job<{ file: string }>, token?: string): Promise<string> {
        processedTokens.push(token);
        if (job.data.file === "corrupt.mp3") {
          throw new Error("corrupt-audio");
        }
        return `transcoded:${job.data.file}`;
      }

      @OnWorkerEvent("active")
      onActive(job: Job) {
        workerEvents.push(`active:${job.name}`);
      }

      @OnWorkerEvent("completed")
      onCompleted(job: Job, result: string) {
        workerEvents.push(`completed:${job.name}:${result}`);
      }

      @OnWorkerEvent("failed")
      onFailed(job: Job, err: Error) {
        workerEvents.push(`failed:${job.name}:${err.message}`);
      }
    }

    @QueueEventsListener("audio")
    class AudioEventsListener extends QueueEventsHost {
      @OnQueueEvent("added")
      onAdded(args: { jobId: string; name: string }) {
        queueEventsLog.push({ event: "added", jobId: args.jobId, extra: args.name });
      }

      @OnQueueEvent("completed")
      onCompleted(args: { jobId: string; returnvalue: string }) {
        queueEventsLog.push({
          event: "completed",
          jobId: args.jobId,
          extra: args.returnvalue,
        });
      }

      @OnQueueEvent("failed")
      onFailed(args: { jobId: string; failedReason: string }) {
        queueEventsLog.push({
          event: "failed",
          jobId: args.jobId,
          extra: args.failedReason,
        });
      }
    }

    @Injectable()
    class AudioProducer {
      constructor(
        @InjectQueue("audio")
        public readonly queue: Queue<{ file: string }, string>,
      ) {}
    }

    const mod = await Test.createTestingModule({
      imports: [
        BullModule.forRoot({
          prefix: "test-bull",
          defaultJobOptions: { attempts: 1 },
        }),
        BullModule.registerQueue({ name: "audio" }),
      ],
      providers: [AudioProcessor, AudioEventsListener, AudioProducer],
    }).compile();

    // Before init, WorkerHost.worker and QueueEventsHost.queueEvents throw descriptive errors
    const processor = mod.get(AudioProcessor);
    const eventsListener = mod.get(AudioEventsListener);
    expect(() => processor.worker).toThrow(/not yet been initialized/i);
    expect(() => eventsListener.queueEvents).toThrow(/not yet been initialized/i);

    const app = mod.createBunestApplication();
    await app.init();

    // After init, both host handles are initialized
    expect(processor.worker.name).toBe("audio");
    expect(eventsListener.queueEvents).toBeInstanceOf(QueueEvents);

    const producer = mod.get(AudioProducer);
    const okJob = await producer.queue.add("transcode", { file: "song.mp3" });
    const badJob = await producer.queue.add("transcode", { file: "corrupt.mp3" });

    await waitUntil(
      () =>
        workerEvents.some((e) => e.startsWith("completed:")) &&
        workerEvents.some((e) => e.startsWith("failed:")),
    );

    expect(workerEvents).toContain("active:transcode");
    expect(workerEvents).toContain("completed:transcode:transcoded:song.mp3");
    expect(workerEvents).toContain("failed:transcode:corrupt-audio");
    expect(processedTokens).toHaveLength(2);

    expect(
      queueEventsLog.some(
        (e) =>
          e.event === "completed" &&
          e.jobId === okJob.id &&
          e.extra === "transcoded:song.mp3",
      ),
    ).toBe(true);
    expect(
      queueEventsLog.some(
        (e) =>
          e.event === "failed" &&
          e.jobId === badJob.id &&
          e.extra === "corrupt-audio",
      ),
    ).toBe(true);
    expect(
      queueEventsLog.some((e) => e.event === "added" && e.jobId === okJob.id),
    ).toBe(true);

    await app.close();
  });

  it("supports all 4 @Processor overloads including Scope.REQUEST + @Inject(JOB_REF)", async () => {
    const seenJobIds: string[] = [];
    const seenInstances = new Set<object>();

    @Processor({ name: "scoped-jobs", scope: Scope.REQUEST }, { concurrency: 2 })
    class ScopedJobProcessor extends WorkerHost {
      constructor(
        @Inject(JOB_REF) public readonly currentJob: Job<{ seq: number }>,
      ) {
        super();
      }

      async process(job: Job<{ seq: number }>): Promise<number> {
        seenInstances.add(this);
        seenJobIds.push(this.currentJob.id);
        expect(this.currentJob.id).toBe(job.id);
        return job.data.seq * 10;
      }
    }

    @Injectable()
    class ScopedProducer {
      constructor(
        @InjectQueue("scoped-jobs")
        public readonly queue: Queue<{ seq: number }, number>,
      ) {}
    }

    const mod = await Test.createTestingModule({
      imports: [
        BullModule.forRoot({}),
        BullModule.registerQueue({ name: "scoped-jobs" }),
      ],
      providers: [ScopedJobProcessor, ScopedProducer],
    }).compile();

    const app = mod.createBunestApplication();
    await app.init();

    const producer = mod.get(ScopedProducer);
    const j1 = await producer.queue.add("run", { seq: 1 });
    const j2 = await producer.queue.add("run", { seq: 2 });

    await waitUntil(async () => {
      const a = await producer.queue.getJob(j1.id);
      const b = await producer.queue.getJob(j2.id);
      return a?.status === "completed" && b?.status === "completed";
    });

    expect(seenJobIds).toContain(j1.id);
    expect(seenJobIds).toContain(j2.id);
    expect(seenInstances.size).toBe(2);
    expect((await producer.queue.getJob(j1.id))?.returnValue).toBe(10);
    expect((await producer.queue.getJob(j2.id))?.returnValue).toBe(20);

    await app.close();
  });

  it("supports BullRegistrar with extraOptions: { manualRegistration: true }", async () => {
    const processed: string[] = [];

    @Processor("manual-q")
    class ManualProcessor extends WorkerHost {
      async process(job: Job<{ msg: string }>): Promise<string> {
        processed.push(job.data.msg);
        return job.data.msg;
      }
    }

    const mod = await Test.createTestingModule({
      imports: [
        BullModule.forRoot({
          extraOptions: { manualRegistration: true },
        }),
        BullModule.registerQueue({ name: "manual-q" }),
      ],
      providers: [ManualProcessor],
    }).compile();

    const app = mod.createBunestApplication();
    await app.init();

    const queue = mod.get<Queue<{ msg: string }, string>>(
      getQueueToken("manual-q"),
    );
    const proc = mod.get(ManualProcessor);
    const registrar = mod.get(BullRegistrar);

    await queue.add("hello", { msg: "deferred-1" });
    await Bun.sleep(25);

    // Must NOT have processed yet because manualRegistration is true!
    expect(processed).toEqual([]);
    expect(() => proc.worker).toThrow(/not yet been initialized/i);

    // Manually trigger registration -> immediately binds worker & drains waiting job
    registrar.register();
    await waitUntil(() => processed.length === 1);

    expect(processed).toEqual(["deferred-1"]);
    expect(proc.worker.name).toBe("manual-q");

    // Calling register() again is safely idempotent
    registrar.register();

    await app.close();
  });

  it("supports ProcessorDecoratorService instrumentation wrapping worker execution", async () => {
    const traceLog: string[] = [];

    @Injectable()
    class TracingProcessorDecorator extends ProcessorDecoratorService {
      override decorate<TData = any, TResult = any>(
        processor: JobHandler<TData, TResult>,
      ): JobHandler<TData, TResult> {
        return async (job, token) => {
          traceLog.push(`start:${job.name}`);
          const res = await processor(job, token);
          traceLog.push(`end:${job.name}`);
          return res;
        };
      }
    }

    @Processor("traced")
    class TracedProcessor extends WorkerHost {
      async process(job: Job<{ v: number }>): Promise<number> {
        traceLog.push(`run:${job.data.v}`);
        return job.data.v + 1;
      }
    }

    const mod = await Test.createTestingModule({
      imports: [
        BullModule.forRoot({}),
        BullModule.registerQueue({ name: "traced" }),
      ],
      providers: [TracedProcessor],
    })
      .overrideProvider(ProcessorDecoratorService)
      .useClass(TracingProcessorDecorator)
      .compile();

    const app = mod.createBunestApplication();
    await app.init();

    const q = mod.get<Queue<{ v: number }, number>>(getQueueToken("traced"));
    const job = await q.add("compute", { v: 41 });
    await waitUntil(async () => (await q.getJob(job.id))?.status === "completed");

    expect((await q.getJob(job.id))?.returnValue).toBe(42);
    expect(traceLog).toEqual(["start:compute", "run:41", "end:compute"]);

    await app.close();
  });

  it("supports BullModule.forRoot(configKey), forRootAsync, registerQueueAsync (useFactory/useClass/useExisting), and inline processors", async () => {
    const inlineLog: string[] = [];

    @Injectable()
    class SharedBullConfigFactory implements SharedBullConfigurationFactory {
      createSharedConfiguration(): BullRootModuleOptions {
        return {
          prefix: "async-root",
          defaultJobOptions: { attempts: 2 },
        };
      }
    }

    @Injectable()
    class QueueOptsClassFactory implements RegisterQueueOptionsFactory {
      createRegisterQueueOptions(): RegisterQueueOptions {
        return {
          name: "q-class",
          processors: [
            async (job) => {
              inlineLog.push(`class:${job.name}`);
              return "ok-class";
            },
          ],
        };
      }
    }

    @Injectable()
    class QueueOptsExistingFactory implements RegisterQueueOptionsFactory {
      createRegisterQueueOptions(): RegisterQueueOptions {
        return {
          name: "q-existing",
          processors: [
            {
              concurrency: 2,
              callback: async (job) => {
                inlineLog.push(`existing:${job.name}`);
                return "ok-existing";
              },
            },
          ],
        };
      }
    }

    @Module({
      providers: [QueueOptsExistingFactory],
      exports: [QueueOptsExistingFactory],
    })
    class ExistingOptsModule {}

    const mod = await Test.createTestingModule({
      imports: [
        BullModule.forRootAsync({
          useClass: SharedBullConfigFactory,
        }),
        BullModule.forRoot("secondary", {
          prefix: "secondary-prefix",
          defaultJobOptions: { attempts: 4 },
        }),
        BullModule.forRootAsync("tertiary", {
          useFactory: () => ({ prefix: "tertiary-prefix" }),
        }),
        BullModule.registerQueueAsync(
          {
            name: "q-factory",
            configKey: "secondary",
            useFactory: () => ({
              processors: [
                async (job) => {
                  inlineLog.push(`factory:${job.name}`);
                  return "ok-factory";
                },
              ],
            }),
          },
          {
            name: "q-class",
            useClass: QueueOptsClassFactory,
          },
          {
            name: "q-existing",
            imports: [ExistingOptsModule],
            useExisting: QueueOptsExistingFactory,
          },
        ),
      ],
    }).compile();

    const app = mod.createBunestApplication();
    await app.init();

    // Verify named shared config tokens
    const secondaryCfg = mod.get<BullRootModuleOptions>(
      getSharedConfigToken("secondary"),
    );
    expect(secondaryCfg.prefix).toBe("secondary-prefix");
    const tertiaryCfg = mod.get<BullRootModuleOptions>(
      getSharedConfigToken("tertiary"),
    );
    expect(tertiaryCfg.prefix).toBe("tertiary-prefix");

    const qFactory = mod.get<Queue>(getQueueToken("q-factory"));
    const qClass = mod.get<Queue>(getQueueToken("q-class"));
    const qExisting = mod.get<Queue>(getQueueToken("q-existing"));

    const j1 = await qFactory.add("f1", {});
    const j2 = await qClass.add("c1", {});
    const j3 = await qExisting.add("e1", {});

    // q-factory inherits attempts: 4 from "secondary" configKey!
    expect(j1.maxAttempts).toBe(4);
    // q-class inherits attempts: 2 from default forRootAsync!
    expect(j2.maxAttempts).toBe(2);

    await waitUntil(async () => {
      const a = await qFactory.getJob(j1.id);
      const b = await qClass.getJob(j2.id);
      const c = await qExisting.getJob(j3.id);
      return (
        a?.status === "completed" &&
        b?.status === "completed" &&
        c?.status === "completed"
      );
    });

    expect(inlineLog).toContain("factory:f1");
    expect(inlineLog).toContain("class:c1");
    expect(inlineLog).toContain("existing:e1");

    await app.close();
  });

  it("supports registerFlowProducer, registerFlowProducerAsync, @InjectFlowProducer, and DAG parent-child execution", async () => {
    const executionOrder: string[] = [];
    let observedChildrenValues: Record<string, unknown> = {};

    @Processor("children-q")
    class ChildProcessor extends WorkerHost {
      async process(job: Job<{ part: string }>): Promise<string> {
        await Bun.sleep(10);
        executionOrder.push(`child:${job.data.part}`);
        return `res:${job.data.part}`;
      }
    }

    @Processor("parent-q")
    class ParentProcessor extends WorkerHost {
      async process(job: Job<{ title: string }>): Promise<string> {
        executionOrder.push(`parent:${job.data.title}`);
        observedChildrenValues = (await job.getChildrenValues?.()) ?? {};
        return `done:${job.data.title}`;
      }
    }

    @Injectable()
    class FlowFactory implements RegisterFlowProducerOptionsFactory {
      createRegisterQueueOptions(): RegisterFlowProducerOptions {
        return { prefix: "custom-flow" };
      }
    }

    @Injectable()
    class WorkflowService {
      constructor(
        @InjectFlowProducer("pipeline")
        public readonly flowProducer: FlowProducer,
        @InjectFlowProducer("async-pipeline")
        public readonly asyncFlowProducer: FlowProducer,
      ) {}
    }

    const mod = await Test.createTestingModule({
      imports: [
        BullModule.forRoot({}),
        BullModule.registerQueue({ name: "children-q" }, { name: "parent-q" }),
        BullModule.registerFlowProducer({ name: "pipeline" }),
        BullModule.registerFlowProducerAsync({
          name: "async-pipeline",
          useClass: FlowFactory,
        }),
      ],
      providers: [ChildProcessor, ParentProcessor, WorkflowService],
    }).compile();

    const app = mod.createBunestApplication();
    await app.init();

    const svc = mod.get(WorkflowService);
    expect(svc.flowProducer).toBeInstanceOf(FlowProducer);
    expect(svc.asyncFlowProducer).toBeInstanceOf(FlowProducer);
    expect(svc.asyncFlowProducer.opts.prefix).toBe("custom-flow");

    const tree = await svc.flowProducer.add({
      name: "finalize",
      queueName: "parent-q",
      data: { title: "report" },
      children: [
        { name: "fetch", queueName: "children-q", data: { part: "A" } },
        { name: "fetch", queueName: "children-q", data: { part: "B" } },
      ],
    });

    expect(tree.children).toHaveLength(2);
    const fetched = await svc.flowProducer.getFlow({
      queueName: "parent-q",
      id: tree.job.id,
    });
    expect(fetched?.job.id).toBe(tree.job.id);

    await waitUntil(() => executionOrder.includes("parent:report"));

    // Parent MUST run strictly after both children completed!
    expect(executionOrder.indexOf("child:A")).toBeLessThan(
      executionOrder.indexOf("parent:report"),
    );
    expect(executionOrder.indexOf("child:B")).toBeLessThan(
      executionOrder.indexOf("parent:report"),
    );
    expect(Object.values(observedChildrenValues).sort()).toEqual([
      "res:A",
      "res:B",
    ]);

    await app.close();
  });

  it("supports custom BullModule queueClass, workerClass, and flowProducerClass setters", async () => {
    class CustomQueue {
      constructor(
        public readonly name: string,
        public readonly opts: unknown,
      ) {}
    }
    class CustomWorker {
      public closed = false;
      constructor(
        public readonly name: string,
        public readonly processor: Function,
        public readonly opts: unknown,
      ) {}
      on() {}
      off() {}
      async close() {
        this.closed = true;
      }
    }
    class CustomFlowProducer {
      public closed = false;
      constructor(public readonly opts: unknown) {}
      async close() {
        this.closed = true;
      }
    }

    BullModule.queueClass = CustomQueue;
    BullModule.workerClass = CustomWorker;
    BullModule.flowProducerClass = CustomFlowProducer;

    @Processor("pro-q")
    class ProProcessor extends WorkerHost<CustomWorker> {
      async process(job: Job): Promise<string> {
        return `pro:${job.name}`;
      }
    }

    const mod = await Test.createTestingModule({
      imports: [
        BullMQModule.forRoot({ prefix: "pro" }),
        BullMQModule.registerQueue({ name: "pro-q" }),
        BullMQModule.registerFlowProducer({ name: "pro-flow" }),
      ],
      providers: [ProProcessor],
    }).compile();

    const app = mod.createBunestApplication();
    await app.init();

    const q = mod.get<CustomQueue>(getQueueToken("pro-q"));
    const fp = mod.get<CustomFlowProducer>(getFlowProducerToken("pro-flow"));
    const proc = mod.get(ProProcessor);

    expect(q).toBeInstanceOf(CustomQueue);
    expect(fp).toBeInstanceOf(CustomFlowProducer);
    expect(proc.worker).toBeInstanceOf(CustomWorker);

    const out = await proc.worker.processor({ id: "1", name: "job1", data: {} });
    expect(out).toBe("pro:job1");

    await app.close();
    expect(proc.worker.closed).toBe(true);
    expect(fp.closed).toBe(true);
  });

  it("supports QueueModule.forRootAsync and QueueModule.registerQueueAsync with WorkerHost", async () => {
    @Injectable()
    class QueueRootFactory implements QueueModuleOptionsFactory {
      createQueueOptions(): QueueModuleOptions {
        return {
          driver: new MemoryQueueDriver(),
          defaultJobOptions: { attempts: 2 },
        };
      }
    }

    const results: string[] = [];

    @Processor("async-native")
    class NativeWorkerHost extends WorkerHost {
      async process(job: Job<{ text: string }>): Promise<string> {
        results.push(job.data.text);
        return `native:${job.data.text}`;
      }
    }

    const mod = await Test.createTestingModule({
      imports: [
        QueueModule.forRootAsync({
          useClass: QueueRootFactory,
        }),
        QueueModule.registerQueueAsync({
          name: "async-native",
          useFactory: () => ({ concurrency: 2 }),
        }),
      ],
      providers: [NativeWorkerHost],
    }).compile();

    const app = mod.createBunestApplication();
    await app.init();

    const q = mod.get<Queue<{ text: string }, string>>(
      getQueueToken("async-native"),
    );
    const job = await q.add("ping", { text: "pong" });
    await waitUntil(() => results.includes("pong"));

    expect((await q.getJob(job.id))?.returnValue).toBe("native:pong");
    expect(job.maxAttempts).toBe(2);

    await app.close();
  });

  it("prevents FlowProducer multi-child premature parent enqueue race and immediate-dequeue childrenValues race", async () => {
    // Custom driver whose enqueue() delays child #2 by 25ms so child #1 (0ms + removeOnComplete)
    // finishes while child #2 is still being registered inside FlowProducer.add().
    class SlowSecondChildDriver extends MemoryQueueDriver {
      override async enqueue<TData = unknown, TResult = unknown>(
        queueName: string,
        job: Job<TData, TResult>,
      ): Promise<Job<TData, TResult>> {
        if (queueName === "race-child-slow") {
          await Bun.sleep(25);
        }
        return await super.enqueue(queueName, job);
      }
    }

    const driver = new SlowSecondChildDriver();
    const fastChildQueue = new Queue<{ id: string }, string>({
      name: "race-child-fast",
      driver,
      concurrency: 2,
    });
    const slowChildQueue = new Queue<{ id: string }, string>({
      name: "race-child-slow",
      driver,
      concurrency: 2,
    });
    const parentQueue = new Queue<{ title: string }, string>({
      name: "race-parent",
      driver,
      concurrency: 1,
    });

    const registry = new Map<string, Queue<any, any>>([
      ["race-child-fast", fastChildQueue],
      ["race-child-slow", slowChildQueue],
      ["race-parent", parentQueue],
    ]);

    const order: string[] = [];
    let syncChildrenValuesAtDequeue: Record<string, unknown> | undefined;
    let asyncChildrenValuesAtDequeue: Record<string, unknown> | undefined;

    // Child #1 completes immediately (synchronous return) with removeOnComplete: true
    fastChildQueue.process("fast", (job) => {
      order.push(`fast:${job.data.id}`);
      return `fast-result:${job.data.id}`;
    });

    // Child #2 runs after its delayed enqueue
    slowChildQueue.process("slow", async (job) => {
      await Bun.sleep(15);
      order.push(`slow:${job.data.id}`);
      return `slow-result:${job.data.id}`;
    });

    // Parent reads childrenValues IMMEDIATELY upon dequeue without sleeping
    parentQueue.process("combine", async (job) => {
      order.push(`parent:${job.data.title}`);
      syncChildrenValuesAtDequeue = job.childrenValues
        ? { ...job.childrenValues }
        : undefined;
      asyncChildrenValuesAtDequeue = await job.getChildrenValues?.();
      return "combined";
    });

    const fp = new FlowProducer(
      { prefix: "race" },
      { get: (name) => registry.get(name) },
      driver,
    );

    const tree = await fp.add({
      name: "combine",
      queueName: "race-parent",
      data: { title: "final" },
      children: [
        {
          name: "fast",
          queueName: "race-child-fast",
          data: { id: "1" },
          opts: { removeOnComplete: true },
        },
        {
          name: "slow",
          queueName: "race-child-slow",
          data: { id: "2" },
        },
      ],
    });

    await waitUntil(() => order.includes("parent:final"));

    expect(order).toEqual(["fast:1", "slow:2", "parent:final"]);
    expect(syncChildrenValuesAtDequeue).toBeDefined();
    expect(Object.values(syncChildrenValuesAtDequeue!).sort()).toEqual([
      "fast-result:1",
      "slow-result:2",
    ]);
    expect(Object.values(asyncChildrenValuesAtDequeue!).sort()).toEqual([
      "fast-result:1",
      "slow-result:2",
    ]);
    expect((await parentQueue.getJob(tree.job.id))?.returnValue).toBe("combined");

    await fp.close();
    await fastChildQueue.close();
    await slowChildQueue.close();
    await parentQueue.close();
  });
});
