import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { MetadataScanner } from "../../../../packages/core/src";
import {
  BullModule,
  BullRegistrar,
  FlowProducer,
  OnQueueEvent,
  OnWorkerEvent,
  Processor,
  Queue,
  QueueEvents,
  QueueEventsHost,
  QueueEventsListener,
  WorkerHost,
  getFlowProducerToken,
  getQueueToken,
  type Job,
} from "../../../../packages/jobs/src/queues";
import {
  Test,
  TestingModule,
  describeConformance,
  itAdapted,
} from "../../_helpers/index";

function waitForQueueEvent(
  queueEvents: QueueEvents,
  event: string,
  timeoutMs = 3000,
): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      queueEvents.off(event, listener);
      reject(new Error(`Timed out waiting for queue event "${event}"`));
    }, timeoutMs);
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
    const listener = (...args: unknown[]) => {
      clearTimeout(timer);
      queueEvents.off(event, listener);
      resolve(args);
    };
    queueEvents.on(event, listener);
  });
}

describeConformance(
  "BullModule (e2e)",
  {
    upstreamPath: "bull/packages/bullmq/e2e/module.e2e-spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-006"],
    notes:
      "Upstream commit 2686e032f369682b4f93bdcd1cbbe2b45b34bce6. Runs completely offline using @bunest/queues in-memory MemoryQueueDriver instead of external Redis on port 6380; awaits QueueEvents 'completed' instead of BullMQ Job#waitUntilFinished.",
  },
  () => {
    describe("registerQueue", () => {
      let moduleRef: TestingModule;

      describe("single configuration", () => {
        beforeAll(async () => {
          moduleRef = await Test.createTestingModule({
            imports: [
              BullModule.registerQueue({
                name: "test",
                connection: {
                  host: "0.0.0.0",
                  port: 6380,
                  db: 1,
                },
              }),
            ],
          }).compile({ logger: false });
        });
        afterAll(async () => {
          await moduleRef?.close();
        });
        it("should inject the queue with the given name", () => {
          const queue = moduleRef.get<Queue>(getQueueToken("test"));

          expect(queue).toBeDefined();
          expect(queue.name).toEqual("test");
        });
      });

      describe("multiple configurations", () => {
        beforeAll(async () => {
          moduleRef = await Test.createTestingModule({
            imports: [
              BullModule.registerQueue(
                {
                  name: "test1",
                  connection: {
                    host: "0.0.0.0",
                    port: 6380,
                    db: 1,
                  },
                },
                {
                  name: "test2",
                  connection: {
                    host: "0.0.0.0",
                    port: 6380,
                    db: 1,
                  },
                },
              ),
            ],
          }).compile({ logger: false });
        });
        afterAll(async () => {
          await moduleRef?.close();
        });
        it('should inject the queue with name "test1"', () => {
          const queue = moduleRef.get<Queue>(getQueueToken("test1"));
          expect(queue).toBeDefined();
          expect(queue.name).toEqual("test1");
        });
        it('should inject the queue with name "test2"', () => {
          const queue = moduleRef.get<Queue>(getQueueToken("test2"));
          expect(queue).toBeDefined();
          expect(queue.name).toEqual("test2");
        });
      });
    });

    describe("registerFlowProducer", () => {
      let moduleRef: TestingModule;

      describe("single configuration", () => {
        beforeAll(async () => {
          moduleRef = await Test.createTestingModule({
            imports: [
              BullModule.registerFlowProducer({
                name: "test",
                connection: {
                  host: "0.0.0.0",
                  port: 6380,
                  db: 1,
                },
              }),
            ],
          }).compile({ logger: false });
        });
        afterAll(async () => {
          await moduleRef?.close();
        });
        it("should inject the flowProducer with the given name", () => {
          const flowProducer = moduleRef.get<FlowProducer>(
            getFlowProducerToken("test"),
          );

          expect(flowProducer).toBeDefined();
          expect(flowProducer.opts.name).toEqual("test");
        });
      });

      describe("multiple configurations", () => {
        beforeAll(async () => {
          moduleRef = await Test.createTestingModule({
            imports: [
              BullModule.registerFlowProducer(
                {
                  name: "test1",
                  connection: {
                    host: "0.0.0.0",
                    port: 6380,
                    db: 1,
                  },
                },
                {
                  name: "test2",
                  connection: {
                    host: "0.0.0.0",
                    port: 6380,
                    db: 1,
                  },
                },
              ),
            ],
          }).compile({ logger: false });
        });
        afterAll(async () => {
          await moduleRef?.close();
        });
        it('should inject the flowProducer with name "test1"', () => {
          const flowProducer = moduleRef.get<FlowProducer>(
            getFlowProducerToken("test1"),
          );
          expect(flowProducer).toBeDefined();
          expect(flowProducer.opts.name).toEqual("test1");
        });
        it('should inject the flowProducer with name "test2"', () => {
          const flowProducer = moduleRef.get<FlowProducer>(
            getFlowProducerToken("test2"),
          );
          expect(flowProducer).toBeDefined();
          expect(flowProducer.opts.name).toEqual("test2");
        });
      });
    });

    describe("forRoot + registerQueue", () => {
      let moduleRef: TestingModule;

      describe("single configuration", () => {
        beforeAll(async () => {
          moduleRef = await Test.createTestingModule({
            imports: [
              BullModule.forRoot({
                connection: {
                  host: "0.0.0.0",
                  port: 6380,
                  db: 1,
                },
              }),
              BullModule.registerQueue({
                name: "test",
              }),
            ],
          }).compile({ logger: false });
        });
        afterAll(async () => {
          await moduleRef?.close();
        });

        it("should inject the queue with the given name", () => {
          const queue = moduleRef.get<Queue>(getQueueToken("test"));
          expect(queue).toBeDefined();
          expect(queue.name).toEqual("test");
        });
      });

      describe("multiple configurations", () => {
        beforeAll(async () => {
          moduleRef = await Test.createTestingModule({
            imports: [
              BullModule.forRoot({
                connection: {
                  host: "0.0.0.0",
                  port: 6380,
                  db: 1,
                },
              }),
              BullModule.registerQueue({ name: "test1" }, { name: "test2" }),
            ],
          }).compile({ logger: false });
        });
        afterAll(async () => {
          await moduleRef?.close();
        });
        it('should inject the queue with name "test1"', () => {
          const queue = moduleRef.get<Queue>(getQueueToken("test1"));

          expect(queue).toBeDefined();
          expect(queue.name).toEqual("test1");
        });
        it('should inject the queue with name "test2"', () => {
          const queue = moduleRef.get<Queue>(getQueueToken("test2"));

          expect(queue).toBeDefined();
          expect(queue.name).toEqual("test2");
        });
      });
    });

    describe("forRoot + registerFlowProducer", () => {
      let moduleRef: TestingModule;

      describe("single configuration", () => {
        beforeAll(async () => {
          moduleRef = await Test.createTestingModule({
            imports: [
              BullModule.forRoot({
                connection: {
                  host: "0.0.0.0",
                  port: 6380,
                  db: 1,
                },
              }),
              BullModule.registerFlowProducer({
                name: "test",
              }),
            ],
          }).compile({ logger: false });
        });
        afterAll(async () => {
          await moduleRef?.close();
        });

        it("should inject the flowProducer with the given name", () => {
          const flowProducer = moduleRef.get<FlowProducer>(
            getFlowProducerToken("test"),
          );
          expect(flowProducer).toBeDefined();
          expect(flowProducer.opts.name).toEqual("test");
        });
      });

      describe("multiple configurations", () => {
        beforeAll(async () => {
          moduleRef = await Test.createTestingModule({
            imports: [
              BullModule.forRoot({
                connection: {
                  host: "0.0.0.0",
                  port: 6380,
                  db: 1,
                },
              }),
              BullModule.registerFlowProducer(
                { name: "test1" },
                { name: "test2" },
              ),
            ],
          }).compile({ logger: false });
        });
        afterAll(async () => {
          await moduleRef?.close();
        });
        it('should inject the flowProducer with name "test1"', () => {
          const flowProducer = moduleRef.get<FlowProducer>(
            getFlowProducerToken("test1"),
          );

          expect(flowProducer).toBeDefined();
          expect(flowProducer.opts.name).toEqual("test1");
        });
        it('should inject the flowProducer with name "test2"', () => {
          const flowProducer = moduleRef.get<FlowProducer>(
            getFlowProducerToken("test2"),
          );

          expect(flowProducer).toBeDefined();
          expect(flowProducer.opts.name).toEqual("test2");
        });
      });
    });

    describe("registerQueueAsync", () => {
      let moduleRef: TestingModule;

      describe("single configuration", () => {
        describe("useFactory", () => {
          beforeAll(async () => {
            moduleRef = await Test.createTestingModule({
              imports: [
                BullModule.registerQueueAsync({
                  name: "test",
                  useFactory: () => ({
                    connection: {
                      host: "0.0.0.0",
                      port: 6380,
                      db: 1,
                    },
                  }),
                }),
              ],
            }).compile({ logger: false });
          });
          afterAll(async () => {
            await moduleRef?.close();
          });
          it("should inject the queue with the given name", () => {
            const queue = moduleRef.get<Queue>(getQueueToken("test"));
            expect(queue).toBeDefined();
            expect(queue.name).toEqual("test");
          });
        });
      });

      describe("multiple configurations", () => {
        describe("useFactory", () => {
          beforeAll(async () => {
            moduleRef = await Test.createTestingModule({
              imports: [
                BullModule.registerQueueAsync(
                  {
                    name: "test1",
                    useFactory: () => ({
                      connection: {
                        host: "0.0.0.0",
                        port: 6380,
                        db: 1,
                      },
                    }),
                  },
                  {
                    name: "test2",
                    useFactory: () => ({
                      connection: {
                        host: "0.0.0.0",
                        port: 6380,
                        db: 1,
                      },
                    }),
                  },
                ),
              ],
            }).compile({ logger: false });
          });
          afterAll(async () => {
            await moduleRef?.close();
          });
          it('should inject the queue with name "test1"', () => {
            const queue = moduleRef.get<Queue>(getQueueToken("test1"));
            expect(queue).toBeDefined();
            expect(queue.name).toEqual("test1");
          });
          it('should inject the queue with name "test2"', () => {
            const queue = moduleRef.get<Queue>(getQueueToken("test2"));
            expect(queue).toBeDefined();
            expect(queue.name).toEqual("test2");
          });
        });
      });
    });

    describe("registerFlowProducerAsync", () => {
      describe("single configuration", () => {
        describe("useFactory", () => {
          it("should inject the flowProducer with the given name", async () => {
            const moduleRef = await Test.createTestingModule({
              imports: [
                BullModule.registerFlowProducerAsync({
                  name: "test",
                  useFactory: () => ({
                    connection: {
                      host: "0.0.0.0",
                      port: 6380,
                      db: 1,
                    },
                  }),
                }),
              ],
            }).compile({ logger: false });

            try {
              const flowProducer = moduleRef.get<FlowProducer>(
                getFlowProducerToken("test"),
              );
              expect(flowProducer).toBeDefined();
              expect(flowProducer.opts.name).toEqual("test");
            } finally {
              await moduleRef.close();
            }
          });
        });
      });

      describe("multiple configurations", () => {
        describe("useFactory", () => {
          it('should inject the flowProducer with name "test1" and "test2"', async () => {
            const moduleRef = await Test.createTestingModule({
              imports: [
                BullModule.registerFlowProducerAsync(
                  {
                    name: "test1",
                    useFactory: () => ({
                      connection: {
                        host: "0.0.0.0",
                        port: 6380,
                        db: 1,
                      },
                    }),
                  },
                  {
                    name: "test2",
                    useFactory: () => ({
                      connection: {
                        host: "0.0.0.0",
                        port: 6380,
                        db: 1,
                      },
                    }),
                  },
                ),
              ],
            }).compile({ logger: false });

            try {
              const fp1 = moduleRef.get<FlowProducer>(
                getFlowProducerToken("test1"),
              );
              const fp2 = moduleRef.get<FlowProducer>(
                getFlowProducerToken("test2"),
              );
              expect(fp1).toBeDefined();
              expect(fp1.opts.name).toEqual("test1");
              expect(fp2).toBeDefined();
              expect(fp2.opts.name).toEqual("test2");
            } finally {
              await moduleRef.close();
            }
          });
        });
      });
    });

    describe("forRootAsync + registerQueueAsync", () => {
      describe("single configuration", () => {
        describe("useFactory", () => {
          let moduleRef: TestingModule;
          let processorWasCalled = false;
          let processorCall: Promise<void>;

          beforeAll(async () => {
            let onProcessorCall!: () => void;
            processorCall = new Promise<void>((resolve) => {
              onProcessorCall = resolve;
            });

            moduleRef = await Test.createTestingModule({
              imports: [
                BullModule.forRootAsync({
                  useFactory: () => ({
                    connection: {
                      host: "0.0.0.0",
                      port: 6380,
                      db: 1,
                    },
                  }),
                }),
                BullModule.registerQueueAsync({
                  name: "test",
                  useFactory: () => ({
                    processors: [
                      async (_job) => {
                        processorWasCalled = true;
                        onProcessorCall();
                      },
                    ],
                  }),
                }),
              ],
            }).compile({ logger: false });
          });
          afterAll(async () => {
            await moduleRef?.close();
          });

          it("should inject the queue with the given name", () => {
            const queue = moduleRef.get<Queue>(getQueueToken("test"));

            expect(queue).toBeDefined();
            expect(queue.name).toEqual("test");
          });

          it("should trigger the processor function", async () => {
            const queue = moduleRef.get<Queue>(getQueueToken("test"));
            await queue.add("job_name", { test: true });

            await processorCall;

            expect(processorWasCalled).toBeTruthy();
          });
        });
      });

      describe("multiple configurations", () => {
        describe("useFactory", () => {
          it('should inject the queues "test1" (registerQueueAsync without factory) and "test2" (registerQueue)', async () => {
            const moduleRef = await Test.createTestingModule({
              imports: [
                BullModule.forRootAsync({
                  useFactory: () => ({
                    connection: {
                      host: "0.0.0.0",
                      port: 6380,
                      db: 1,
                    },
                  }),
                }),
                BullModule.registerQueueAsync({ name: "test1" }),
                BullModule.registerQueue({ name: "test2" }),
              ],
            }).compile({ logger: false });

            try {
              const queue1 = moduleRef.get<Queue>(getQueueToken("test1"));
              expect(queue1).toBeDefined();
              expect(queue1.name).toEqual("test1");

              const queue2 = moduleRef.get<Queue>(getQueueToken("test2"));
              expect(queue2).toBeDefined();
              expect(queue2.name).toEqual("test2");
            } finally {
              await moduleRef.close();
            }
          });
        });
      });
    });

    describe("forRootAsync + registerQueueAsync (empty processors & shared configs)", () => {
      describe("single configuration", () => {
        describe("useFactory", () => {
          let moduleRef: TestingModule;

          beforeAll(async () => {
            moduleRef = await Test.createTestingModule({
              imports: [
                BullModule.forRootAsync({
                  useFactory: () => ({
                    connection: {
                      host: "0.0.0.0",
                      port: 6380,
                      db: 1,
                    },
                  }),
                }),
                BullModule.registerQueueAsync({
                  name: "test",
                  useFactory: () => ({
                    processors: [],
                  }),
                }),
              ],
            }).compile({ logger: false });
          });
          afterAll(async () => {
            await moduleRef?.close();
          });
          it("should inject the queue with the given name", () => {
            const queue = moduleRef.get<Queue>(getQueueToken("test"));

            expect(queue).toBeDefined();
            expect(queue.name).toEqual("test");
          });
        });
      });

      describe("multiple shared configurations", () => {
        describe("useFactory", () => {
          it('should inject shared-config queues "test1" and "test2"', async () => {
            const moduleRef = await Test.createTestingModule({
              imports: [
                BullModule.forRootAsync({
                  useFactory: () => ({
                    connection: {
                      host: "0.0.0.0",
                      port: 6380,
                      db: 1,
                    },
                  }),
                }),
                BullModule.registerQueueAsync({ name: "test1" }),
                BullModule.registerQueue({ name: "test2" }),
              ],
            }).compile({ logger: false });

            try {
              const queue1 = moduleRef.get<Queue>(getQueueToken("test1"));
              expect(queue1).toBeDefined();
              expect(queue1.name).toEqual("test1");

              const queue2 = moduleRef.get<Queue>(getQueueToken("test2"));
              expect(queue2).toBeDefined();
              expect(queue2.name).toEqual("test2");
            } finally {
              await moduleRef.close();
            }
          });
        });
      });
    });

    describe("full flow (job handling)", () => {
      const queueName = "full_flow_queue";

      it("should process jobs with the given processors", async () => {
        const processorCalledSpy = mock(() => {});
        const queueCompletedEventSpy = mock(() => {});
        const workerCompletedEventSpy = mock(() => {});

        @QueueEventsListener(queueName)
        class EventsListener extends QueueEventsHost {
          @OnQueueEvent("completed")
          onCompleted() {
            queueCompletedEventSpy();
          }
        }

        @Processor(queueName)
        class TestProcessor extends WorkerHost {
          async process(_job: Job<any, any>): Promise<any> {
            await Bun.sleep(20);
            processorCalledSpy();
          }

          @OnWorkerEvent("completed")
          onCompleted() {
            workerCompletedEventSpy();
          }
        }

        const testingModule = await Test.createTestingModule({
          imports: [
            BullModule.registerQueue({
              name: queueName,
              connection: {
                host: "0.0.0.0",
                port: 6380,
                db: 1,
              },
            }),
          ],
          providers: [EventsListener, TestProcessor],
        }).compile({ logger: false });

        let closed = false;
        try {
          await testingModule.init();

          const queue = testingModule.get<Queue>(getQueueToken(queueName));
          const queueEvents = testingModule.get(EventsListener).queueEvents;
          const completedPromise = waitForQueueEvent(queueEvents, "completed");

          await queue.add("job_name", { test: true });
          await completedPromise;

          await testingModule.close();
          closed = true;

          expect(processorCalledSpy).toHaveBeenCalled();
          expect(queueCompletedEventSpy).toHaveBeenCalled();
          expect(workerCompletedEventSpy).toHaveBeenCalled();
        } finally {
          if (!closed) {
            await testingModule.close();
          }
        }
      });
    });

    describe("manual registration", () => {
      const queueName = "a_queue";

      it("should manually register workers - forRoot", async () => {
        const processorCalledSpy = mock(() => {});
        const queueCompletedEventSpy = mock(() => {});
        const workerCompletedEventSpy = mock(() => {});

        @QueueEventsListener(queueName)
        class EventsListener extends QueueEventsHost {
          @OnQueueEvent("completed")
          onCompleted() {
            queueCompletedEventSpy();
          }
        }

        @Processor(queueName)
        class TestProcessor extends WorkerHost {
          async process(_job: Job<any, any>): Promise<any> {
            await Bun.sleep(20);
            processorCalledSpy();
          }

          @OnWorkerEvent("completed")
          onCompleted() {
            workerCompletedEventSpy();
          }
        }

        const testingModule = await Test.createTestingModule({
          imports: [
            BullModule.forRoot({
              connection: {
                host: "0.0.0.0",
                port: 6380,
                db: 1,
              },
              extraOptions: {
                manualRegistration: true,
              },
            }),
            BullModule.registerQueue({
              name: queueName,
            }),
          ],
          providers: [EventsListener, TestProcessor],
        }).compile({ logger: false });

        try {
          await testingModule.init();

          expect(() => testingModule.get(TestProcessor).worker).toThrow(
            '"Worker" has not yet been initialized. Make sure to interact with worker instances after the "onModuleInit" lifecycle hook is triggered for example, in the "onApplicationBootstrap" hook, or if "manualRegistration" is set to true make sure to call "BullRegistrar.register()"',
          );
          expect(() => testingModule.get(EventsListener).queueEvents).toThrow(
            '"QueueEvents" class has not yet been initialized. Make sure to interact with queue events instances after the "onModuleInit" lifecycle hook is triggered, for example, in the "onApplicationBootstrap" hook, or if "manualRegistration" is set to true make sure to call "BullRegistrar.register()"',
          );

          const bullRegistrar = testingModule.get(BullRegistrar);
          bullRegistrar.register();

          const processorWorker = testingModule.get(TestProcessor).worker;
          const queueEvents = testingModule.get(EventsListener).queueEvents;

          expect(processorWorker).toBeDefined();
          expect(queueEvents).toBeDefined();
        } finally {
          await testingModule.close();
        }
      });

      it("should manually register workers - forRootAsync", async () => {
        const processorCalledSpy = mock(() => {});
        const queueCompletedEventSpy = mock(() => {});
        const workerCompletedEventSpy = mock(() => {});

        @QueueEventsListener(queueName)
        class EventsListener extends QueueEventsHost {
          @OnQueueEvent("completed")
          onCompleted() {
            queueCompletedEventSpy();
          }
        }

        @Processor(queueName)
        class TestProcessor extends WorkerHost {
          async process(_job: Job<any, any>): Promise<any> {
            await Bun.sleep(20);
            processorCalledSpy();
          }

          @OnWorkerEvent("completed")
          onCompleted() {
            workerCompletedEventSpy();
          }
        }

        const testingModule = await Test.createTestingModule({
          imports: [
            BullModule.forRootAsync({
              useFactory: () => ({
                connection: {
                  host: "0.0.0.0",
                  port: 6380,
                  db: 1,
                },
              }),
              extraOptions: {
                manualRegistration: true,
              },
            }),
            BullModule.registerQueue({
              name: queueName,
            }),
          ],
          providers: [EventsListener, TestProcessor],
        }).compile({ logger: false });

        try {
          await testingModule.init();

          expect(() => testingModule.get(TestProcessor).worker).toThrow(
            '"Worker" has not yet been initialized. Make sure to interact with worker instances after the "onModuleInit" lifecycle hook is triggered for example, in the "onApplicationBootstrap" hook, or if "manualRegistration" is set to true make sure to call "BullRegistrar.register()"',
          );
          expect(() => testingModule.get(EventsListener).queueEvents).toThrow(
            '"QueueEvents" class has not yet been initialized. Make sure to interact with queue events instances after the "onModuleInit" lifecycle hook is triggered, for example, in the "onApplicationBootstrap" hook, or if "manualRegistration" is set to true make sure to call "BullRegistrar.register()"',
          );

          const bullRegistrar = testingModule.get(BullRegistrar);
          bullRegistrar.register();

          const processorWorker = testingModule.get(TestProcessor).worker;
          const queueEvents = testingModule.get(EventsListener).queueEvents;

          expect(processorWorker).toBeDefined();
          expect(queueEvents).toBeDefined();
        } finally {
          await testingModule.close();
        }
      });
    });

    describe("handles all kind of valid processors providers", () => {
      @Processor("test_processor_registering")
      class MyProcessorA extends WorkerHost {
        async process(_job: Job<any, any>): Promise<any> {}
      }

      @Processor("test_processor_registering")
      class MyProcessorB extends WorkerHost {
        async process(_job: Job<any, any>): Promise<any> {}
      }

      @Processor("test_processor_registering")
      class MyProcessorC extends WorkerHost {
        async process(_job: Job<any, any>): Promise<any> {}
      }

      let testingModule: TestingModule;
      let metadataScanner: MetadataScanner;

      beforeAll(async () => {
        testingModule = await Test.createTestingModule({
          imports: [
            BullModule.registerQueue({
              name: "test_processor_registering",
              connection: {
                host: "0.0.0.0",
                port: 6380,
                db: 1,
              },
            }),
          ],
          providers: [
            {
              provide: "A",
              useClass: MyProcessorA,
            },
            {
              provide: "B",
              useValue: new MyProcessorB(),
            },
            {
              provide: "C",
              useFactory: () => new MyProcessorC(),
            },
          ],
        }).compile({ logger: false });

        metadataScanner = testingModule.get(MetadataScanner);
        await testingModule.init();
      });

      afterAll(async () => {
        await testingModule?.close();
      });

      itAdapted(
        ["ADR-006"],
        "discovers processor metadata via class-level MetadataRegistry (MetadataScanner available in container)",
        () => {
          expect(metadataScanner).toBeInstanceOf(MetadataScanner);
          expect(testingModule.get<MyProcessorA>("A").worker).toBeDefined();
        },
        "Bunest BullMQExplorer reads ADR-006 copy-on-write constructor metadata directly instead of scanning prototype methods with MetadataScanner#scanFromPrototype",
      );

      it("should reach the processor supplied with `useClass`", () => {
        const processorA = testingModule.get<MyProcessorA>("A");
        expect(processorA).toBeInstanceOf(MyProcessorA);
        expect(processorA.worker).toBeDefined();
        expect(processorA.worker.name).toBe("test_processor_registering");
      });

      it("should reach the processor supplied with `useValue`", () => {
        const processorB = testingModule.get<MyProcessorB>("B");
        expect(processorB).toBeInstanceOf(MyProcessorB);
        expect(processorB.worker).toBeDefined();
        expect(processorB.worker.name).toBe("test_processor_registering");
      });

      it("should reach the processor supplied with `useFactory`", () => {
        const processorC = testingModule.get<MyProcessorC>("C");
        expect(processorC).toBeInstanceOf(MyProcessorC);
        expect(processorC.worker).toBeDefined();
        expect(processorC.worker.name).toBe("test_processor_registering");
      });
    });
  },
);
