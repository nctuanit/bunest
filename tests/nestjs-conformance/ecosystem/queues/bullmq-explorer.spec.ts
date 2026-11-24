import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
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
} from "../../../../packages/jobs/src/queues";
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
          imports: [BullModule.registerQueue({ name: queueName, connection })],
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
          imports: [BullModule.registerQueue({ name: queueName, connection })],
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

      it("should pass telemetry option to the worker constructor", async () => {
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

      it("should pass skipVersionCheck option to the worker constructor", async () => {
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

      it("should pass backendFactory to the worker constructor when provided in worker options", async () => {
        const mockBackendFactory = mock(() => ({}));
        const workerOptions: NestWorkerOptions = {
          backendFactory: mockBackendFactory,
        };

        @Processor(queueName, workerOptions)
        class ProcessorWithBackendFactory extends WorkerHost {
          async process(_job: Job<any, any>): Promise<any> {}
        }

        const moduleRef = await Test.createTestingModule({
          imports: [BullModule.registerQueue({ name: queueName, connection })],
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

      it("should inherit backendFactory from queue options when not provided in worker options", async () => {
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

      it("should create a single worker for a processor registered with useExisting", async () => {
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
          imports: [BullModule.registerQueue({ name: queueName, connection })],
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

      it("should instantiate queue events once for a listener registered with useExisting", async () => {
        const testingModule = await Test.createTestingModule({
          imports: [BullModule.registerQueue({ name: queueName, connection })],
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

      it("should pass telemetry option to queue events constructor", async () => {
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

      it("should pass skipVersionCheck option to queue events constructor", async () => {
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

      it("should pass backendFactory to queue events constructor", async () => {
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
      it("should return options associated with the given queue", async () => {
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
      it("should return options associated with the given flowProducer", async () => {
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
