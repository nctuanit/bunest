import "reflect-metadata";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
} from "bun:test";
import {
  BullMQExplorer,
  BullModule,
  OnWorkerEvent,
  Processor,
  QueueEvents,
  QueueEventsHost,
  QueueEventsListener,
  WorkerHost,
  getFlowProducerToken,
  getQueueToken,
  type Job,
  type NestWorkerOptions,
} from "../../../../packages/queues/src";
import { Test, describeConformance } from "../../_helpers/index";

const workerCtorSpy = mock((..._args: unknown[]) => {});
const workerOnSpy = mock((..._args: unknown[]) => {});

class MockWorker {
  constructor(...args: unknown[]) {
    workerCtorSpy(...args);
  }
  on = workerOnSpy;
  off = mock(() => {});
  close = mock(async () => {});
}

describeConformance(
  "BullExplorer (BullMQExplorer)",
  {
    upstreamPath: "bull/packages/bullmq/lib/test/bull.explorer.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-006"],
    notes:
      "Upstream commit 2686e032f369682b4f93bdcd1cbbe2b45b34bce6. Runs offline using BullModule.workerClass = MockWorker instead of mocking the external `bullmq` package, exercising Bunest's BullMQExplorer.",
  },
  () => {
    beforeEach(() => {
      workerCtorSpy.mockClear();
      workerOnSpy.mockClear();
      BullModule.workerClass = MockWorker;
    });

    afterEach(() => {
      BullModule.workerClass = undefined;
      BullModule.queueClass = undefined;
      BullModule.flowProducerClass = undefined;
    });

    describe("handleProcessor", () => {
      const queueName = "test_queue";
      const connection = { host: "localhost", port: 6380 };

      @Processor(queueName)
      class FixtureProcessor extends WorkerHost {
        async process(_job: Job<any, any>, _token?: string): Promise<any> {}
      }

      it("should instantiate Bull worker based on the processor class", async () => {
        const moduleRef = await Test.createTestingModule({
          imports: [
            BullModule.registerQueue({ name: queueName, connection }),
          ],
          providers: [FixtureProcessor],
        }).compile({ logger: false });

        try {
          await moduleRef.init();
          const instance = moduleRef.get(FixtureProcessor);

          expect(workerCtorSpy).toHaveBeenCalledWith(
            queueName,
            expect.any(Function),
            expect.objectContaining({ connection }),
          );
          expect(instance.worker).toBeDefined();
        } finally {
          await moduleRef.close();
        }
      });

      it("should instantiate Bull worker with the appropriate worker options", async () => {
        const workerOptions: NestWorkerOptions = { concurrency: 3 };

        @Processor(queueName, workerOptions)
        class ProcessorWithConcurrency extends WorkerHost {
          async process(_job: Job<any, any>, _token?: string): Promise<any> {}
        }

        const moduleRef = await Test.createTestingModule({
          imports: [
            BullModule.registerQueue({ name: queueName, connection }),
          ],
          providers: [ProcessorWithConcurrency],
        }).compile({ logger: false });

        try {
          await moduleRef.init();

          expect(workerCtorSpy).toHaveBeenCalledWith(
            queueName,
            expect.any(Function),
            expect.objectContaining({
              concurrency: 3,
              connection,
            }),
          );
        } finally {
          await moduleRef.close();
        }
      });

      // BUNEST_BUG: Expected BullMQExplorer to forward queue `telemetry` option to the Worker constructor, actual drops `telemetry` because packages/queues/src/adapters/bullmq.adapter.ts (BullMQExplorer.registerProcessor) only copies `connection`, `prefix`, and `concurrency` from queueOpts into mergedWorkerOpts.
      it.skip("should pass telemetry option to the worker constructor", async () => {
        const mockTelemetry = {
          instrumentJob: mock(() => {}),
          tracer: {
            startSpan: mock(() => {}),
            currentSpan: mock(() => {}),
            withSpan: mock(() => {}),
            withContext: mock(() => {}),
            bind: mock(() => {}),
          },
          contextManager: {
            active: mock(() => {}),
            with: mock(() => {}),
            bind: mock(() => {}),
            getMetadata: mock(() => {}),
            fromMetadata: mock(() => {}),
          },
        };

        const moduleRef = await Test.createTestingModule({
          imports: [
            BullModule.registerQueue({
              name: queueName,
              connection,
              telemetry: mockTelemetry,
            }),
          ],
          providers: [FixtureProcessor],
        }).compile({ logger: false });

        try {
          await moduleRef.init();

          expect(workerCtorSpy).toHaveBeenCalledWith(
            queueName,
            expect.any(Function),
            expect.objectContaining({
              connection,
              telemetry: mockTelemetry,
            }),
          );
        } finally {
          await moduleRef.close();
        }
      });

      // BUNEST_BUG: Expected BullMQExplorer to forward queue `skipVersionCheck` option to the Worker constructor, actual drops `skipVersionCheck` because packages/queues/src/adapters/bullmq.adapter.ts (BullMQExplorer.registerProcessor) only copies `connection`, `prefix`, and `concurrency` from queueOpts into mergedWorkerOpts.
      it.skip("should pass skipVersionCheck option to the worker constructor", async () => {
        const moduleRef = await Test.createTestingModule({
          imports: [
            BullModule.registerQueue({
              name: queueName,
              connection,
              skipVersionCheck: true,
            }),
          ],
          providers: [FixtureProcessor],
        }).compile({ logger: false });

        try {
          await moduleRef.init();

          expect(workerCtorSpy).toHaveBeenCalledWith(
            queueName,
            expect.any(Function),
            expect.objectContaining({
              connection,
              skipVersionCheck: true,
            }),
          );
        } finally {
          await moduleRef.close();
        }
      });

      it("should let worker options override the queue skipVersionCheck option", async () => {
        @Processor(queueName, { skipVersionCheck: false })
        class ProcessorOverridingSkipVersionCheck extends WorkerHost {
          async process(_job: Job<any, any>): Promise<any> {}
        }

        const moduleRef = await Test.createTestingModule({
          imports: [
            BullModule.registerQueue({
              name: queueName,
              connection,
              skipVersionCheck: true,
            }),
          ],
          providers: [ProcessorOverridingSkipVersionCheck],
        }).compile({ logger: false });

        try {
          await moduleRef.init();

          expect(workerCtorSpy).toHaveBeenCalledWith(
            queueName,
            expect.any(Function),
            expect.objectContaining({ skipVersionCheck: false }),
          );
        } finally {
          await moduleRef.close();
        }
      });

      // BUNEST_BUG: Expected BullMQExplorer to pass `backendFactory` from worker options as the 4th argument to Worker constructor, actual constructs `new WorkerCtor(queueName, processor, mergedWorkerOpts)` with only 3 args in packages/queues/src/adapters/bullmq.adapter.ts (BullMQExplorer.registerProcessor).
      it.skip("should pass backendFactory to the worker constructor when provided in worker options", async () => {
        const mockBackendFactory = mock(() => ({}));
        const workerOptions: NestWorkerOptions = {
          backendFactory: mockBackendFactory,
        };

        @Processor(queueName, workerOptions)
        class ProcessorWithBackendFactory extends WorkerHost {
          async process(_job: Job<any, any>): Promise<any> {}
        }

        const moduleRef = await Test.createTestingModule({
          imports: [
            BullModule.registerQueue({ name: queueName, connection }),
          ],
          providers: [ProcessorWithBackendFactory],
        }).compile({ logger: false });

        try {
          await moduleRef.init();

          expect(workerCtorSpy).toHaveBeenCalledWith(
            queueName,
            expect.any(Function),
            expect.objectContaining({ connection }),
            mockBackendFactory,
          );
        } finally {
          await moduleRef.close();
        }
      });

      // BUNEST_BUG: Expected BullMQExplorer to inherit `backendFactory` from queue options and pass it as the 4th argument to Worker constructor, actual drops `queueOpts.backendFactory` and passes only 3 args in packages/queues/src/adapters/bullmq.adapter.ts (BullMQExplorer.registerProcessor).
      it.skip("should inherit backendFactory from queue options when not provided in worker options", async () => {
        const mockBackendFactory = mock(() => ({}));

        const moduleRef = await Test.createTestingModule({
          imports: [
            BullModule.registerQueue({
              name: queueName,
              connection,
              backendFactory: mockBackendFactory,
            }),
          ],
          providers: [FixtureProcessor],
        }).compile({ logger: false });

        try {
          await moduleRef.init();

          expect(workerCtorSpy).toHaveBeenCalledWith(
            queueName,
            expect.any(Function),
            expect.objectContaining({ connection }),
            mockBackendFactory,
          );
        } finally {
          await moduleRef.close();
        }
      });

      it('should default to "default" queue name when registering processor without queue name', async () => {
        @Processor({})
        class DefaultQueueProcessor extends WorkerHost {
          async process(_job: Job<any, any>): Promise<any> {}
        }

        const localModule = await Test.createTestingModule({
          imports: [BullModule.registerQueue({ connection })],
          providers: [DefaultQueueProcessor],
        }).compile({ logger: false });

        try {
          await localModule.init();

          expect(workerCtorSpy).toHaveBeenCalledWith(
            "default",
            expect.any(Function),
            expect.objectContaining({ connection }),
          );
        } finally {
          await localModule.close();
        }
      });
    });

    describe("registerWorkers", () => {
      const queueName = "test_queue";

      @Processor(queueName)
      class AliasedProcessor extends WorkerHost {
        async process(_job: Job<any, any>, _token?: string): Promise<any> {}

        @OnWorkerEvent("completed")
        onCompleted() {}
      }

      // BUNEST_BUG: Expected a single Worker (and single @OnWorkerEvent binding) when a @Processor class is also registered via a `useExisting` alias, actual creates 2 workers because BullMQExplorer.register() (packages/queues/src/adapters/bullmq.adapter.ts) does not filter out `useExisting` alias wrappers or deduplicate by provider instance.
      it.skip("should create a single worker for a processor registered with useExisting", async () => {
        const testingModule = await Test.createTestingModule({
          imports: [
            BullModule.registerQueue({
              name: queueName,
              connection: { host: "localhost", port: 6380 },
            }),
          ],
          providers: [
            AliasedProcessor,
            { provide: "PROCESSOR_ALIAS", useExisting: AliasedProcessor },
          ],
        }).compile({ logger: false });

        try {
          await testingModule.init();

          expect(workerCtorSpy).toHaveBeenCalledTimes(1);
          expect(workerOnSpy).toHaveBeenCalledTimes(1);
        } finally {
          await testingModule.close();
        }
      });
    });

    describe("registerQueueEventListeners", () => {
      const queueName = "test_queue";
      const connection = { host: "localhost", port: 6380 };

      @QueueEventsListener(queueName)
      class EventsListener extends QueueEventsHost {}

      it("should instantiate Bull queue events classes", async () => {
        const moduleRef = await Test.createTestingModule({
          imports: [
            BullModule.registerQueue({ name: queueName, connection }),
          ],
          providers: [EventsListener],
        }).compile({ logger: false });

        try {
          await moduleRef.init();
          const listener = moduleRef.get(EventsListener);

          expect(listener.queueEvents).toBeInstanceOf(QueueEvents);
          expect(listener.queueEvents.name).toBe(queueName);
        } finally {
          await moduleRef.close();
        }
      });

      // BUNEST_BUG: Expected a single QueueEvents instance when a @QueueEventsListener class is also registered via a `useExisting` alias, actual instantiates 2 QueueEvents instances because BullMQExplorer.register() (packages/queues/src/adapters/bullmq.adapter.ts) does not filter out `useExisting` alias wrappers or deduplicate by provider instance.
      it.skip("should instantiate queue events once for a listener registered with useExisting", async () => {
        const testingModule = await Test.createTestingModule({
          imports: [
            BullModule.registerQueue({ name: queueName, connection }),
          ],
          providers: [
            EventsListener,
            { provide: "LISTENER_ALIAS", useExisting: EventsListener },
          ],
        }).compile({ logger: false });

        try {
          await testingModule.init();
          const explorer = testingModule.get(BullMQExplorer);
          const allQueueEvents = (explorer as any)
            .allQueueEvents as QueueEvents[];

          expect(allQueueEvents).toHaveLength(1);
        } finally {
          await testingModule.close();
        }
      });

      // BUNEST_BUG: Expected QueueEvents to receive queue `connection` and `telemetry` options, actual is undefined because BullMQExplorer.registerQueueEventsListener (packages/queues/src/adapters/bullmq.adapter.ts) calls `new QueueEvents(listenerMeta.queueName)` without options and QueueEvents (packages/queues/src/hosts/queue-events-host.class.ts) accepts only `name: string`.
      it.skip("should pass telemetry option to queue events constructor", async () => {
        const mockTelemetry = {
          instrumentJob: mock(() => {}),
          tracer: {},
          contextManager: {},
        };

        const moduleRef = await Test.createTestingModule({
          imports: [
            BullModule.registerQueue({
              name: queueName,
              connection,
              telemetry: mockTelemetry,
            }),
          ],
          providers: [EventsListener],
        }).compile({ logger: false });

        try {
          await moduleRef.init();
          const listener = moduleRef.get(EventsListener);

          expect((listener.queueEvents as any).opts).toEqual(
            expect.objectContaining({
              connection,
              telemetry: mockTelemetry,
            }),
          );
        } finally {
          await moduleRef.close();
        }
      });

      // BUNEST_BUG: Expected QueueEvents to receive queue `connection` and `skipVersionCheck` options, actual is undefined because BullMQExplorer.registerQueueEventsListener (packages/queues/src/adapters/bullmq.adapter.ts) calls `new QueueEvents(listenerMeta.queueName)` without options and QueueEvents (packages/queues/src/hosts/queue-events-host.class.ts) accepts only `name: string`.
      it.skip("should pass skipVersionCheck option to queue events constructor", async () => {
        const moduleRef = await Test.createTestingModule({
          imports: [
            BullModule.registerQueue({
              name: queueName,
              connection,
              skipVersionCheck: true,
            }),
          ],
          providers: [EventsListener],
        }).compile({ logger: false });

        try {
          await moduleRef.init();
          const listener = moduleRef.get(EventsListener);

          expect((listener.queueEvents as any).opts).toEqual(
            expect.objectContaining({
              connection,
              skipVersionCheck: true,
            }),
          );
        } finally {
          await moduleRef.close();
        }
      });

      // BUNEST_BUG: Expected QueueEvents to receive `backendFactory` from queue options, actual is undefined because BullMQExplorer.registerQueueEventsListener (packages/queues/src/adapters/bullmq.adapter.ts) calls `new QueueEvents(listenerMeta.queueName)` without backendFactory and QueueEvents (packages/queues/src/hosts/queue-events-host.class.ts) accepts only `name: string`.
      it.skip("should pass backendFactory to queue events constructor", async () => {
        const mockBackendFactory = mock(() => ({}));

        const moduleRef = await Test.createTestingModule({
          imports: [
            BullModule.registerQueue({
              name: queueName,
              connection,
              backendFactory: mockBackendFactory,
            }),
          ],
          providers: [EventsListener],
        }).compile({ logger: false });

        try {
          await moduleRef.init();
          const listener = moduleRef.get(EventsListener);

          expect((listener.queueEvents as any).backendFactory).toBe(
            mockBackendFactory,
          );
        } finally {
          await moduleRef.close();
        }
      });
    });

    describe("getQueueOptions", () => {
      // BUNEST_BUG: Expected public BullMQExplorer.getQueueOptions(queueToken, queueName) to read options from the resolved queue provider (`queueRef.opts`), actual method in packages/queues/src/adapters/bullmq.adapter.ts is private with signature `(queueName, configKey?)` and returns `{}` when passed `(queueToken, "test")`.
      it.skip("should return options associated with the given queue", async () => {
        const queueToken = getQueueToken("test");
        const queueOptions = {
          connection: { host: "localhost", port: 65793 },
          sharedConnection: true,
        };
        const moduleRef = await Test.createTestingModule({
          imports: [
            BullModule.registerQueue({ name: "test", ...queueOptions }),
          ],
        })
          .overrideProvider(queueToken)
          .useValue({ opts: queueOptions })
          .compile({ logger: false });

        try {
          const explorer = moduleRef.get(BullMQExplorer) as any;

          expect(typeof explorer.getQueueOptions).toBe("function");
          const queueOpts = explorer.getQueueOptions(queueToken, "test");
          expect(queueOpts).toBeDefined();
          expect(queueOpts).toEqual(expect.objectContaining(queueOptions));
        } finally {
          await moduleRef.close();
        }
      });
    });

    describe("getFlowProducerOptions", () => {
      // BUNEST_BUG: Expected public BullMQExplorer.getFlowProducerOptions(flowProducerToken, name) to return options associated with the given FlowProducer, actual method does not exist on BullMQExplorer in packages/queues/src/adapters/bullmq.adapter.ts.
      it.skip("should return options associated with the given flowProducer", async () => {
        const flowProducerToken = getFlowProducerToken("test");
        const flowProducerOptions = {
          connection: { host: "localhost", port: 65793 },
          sharedConnection: true,
        };
        const moduleRef = await Test.createTestingModule({
          imports: [
            BullModule.registerFlowProducer({
              name: "test",
              ...flowProducerOptions,
            }),
          ],
        })
          .overrideProvider(flowProducerToken)
          .useValue({ opts: flowProducerOptions })
          .compile({ logger: false });

        try {
          const explorer = moduleRef.get(BullMQExplorer) as any;

          expect(typeof explorer.getFlowProducerOptions).toBe("function");
          const flowProducerOpts = explorer.getFlowProducerOptions(
            flowProducerToken,
            "test",
          );
          expect(flowProducerOpts).toBeDefined();
          expect(flowProducerOpts).toEqual(
            expect.objectContaining(flowProducerOptions),
          );
        } finally {
          await moduleRef.close();
        }
      });
    });
  },
);
