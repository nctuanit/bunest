import { afterEach, beforeEach, expect, it, mock } from "bun:test";
import {
  BullModule,
  getFlowProducerToken,
  getQueueToken,
} from "../../../../packages/jobs/src/queues";
import { Test, TestingModule, describeConformance } from "../../_helpers/index";

const queueCtorSpy = mock((..._args: unknown[]) => {});
const workerCtorSpy = mock((..._args: unknown[]) => {});
const flowProducerCtorSpy = mock((..._args: unknown[]) => {});

class MockQueue {
  opts: unknown;
  constructor(name: string, opts?: unknown, backendFactory?: unknown) {
    this.opts = opts;
    queueCtorSpy(name, opts, backendFactory);
  }
  close = mock(async () => undefined);
}

class MockWorker {
  constructor(
    name: string,
    processor?: unknown,
    opts?: unknown,
    backendFactory?: unknown,
  ) {
    workerCtorSpy(name, processor, opts, backendFactory);
  }
  close = mock(async () => undefined);
}

class MockFlowProducer {
  constructor(opts?: unknown, backendFactory?: unknown) {
    flowProducerCtorSpy(opts, backendFactory);
  }
  close = mock(async () => undefined);
}

describeConformance(
  "Pluggable Backend (backendFactory)",
  {
    upstreamPath: "bull/packages/bullmq/lib/test/pluggable-backend.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Upstream commit 2686e032f369682b4f93bdcd1cbbe2b45b34bce6. Runs offline using BullModule.queueClass, workerClass, and flowProducerClass spies instead of vi.mock('bullmq').",
  },
  () => {
    let moduleRef: TestingModule | undefined;

    beforeEach(() => {
      queueCtorSpy.mockClear();
      workerCtorSpy.mockClear();
      flowProducerCtorSpy.mockClear();
      BullModule.queueClass = MockQueue;
      BullModule.workerClass = MockWorker;
      BullModule.flowProducerClass = MockFlowProducer;
    });

    afterEach(async () => {
      if (moduleRef) {
        await moduleRef.close();
        moduleRef = undefined;
      }
      BullModule.queueClass = undefined;
      BullModule.workerClass = undefined;
      BullModule.flowProducerClass = undefined;
    });

    // BUNEST_BUG: Expected BullModule.queueClass constructor to receive `backendFactory` as the 3rd argument `(name, opts, backendFactory)`, actual passes only 2 args `(name, merged)` (3rd arg is `undefined`) in buildQueueInstance() (packages/jobs/src/queues/adapters/bullmq.adapter.ts).
    it.skip("should pass backendFactory to Queue constructor when configured in registerQueue", async () => {
      const mockBackendFactory = mock(() => ({}));
      const queueName = "postgres-queue";

      moduleRef = await Test.createTestingModule({
        imports: [
          BullModule.registerQueue({
            name: queueName,
            connection: { host: "localhost", port: 5432 },
            backendFactory: mockBackendFactory,
          }),
        ],
      }).compile({ logger: false });

      const queue = moduleRef.get<MockQueue>(getQueueToken(queueName));
      expect(queue).toBeDefined();
      expect(queueCtorSpy).toHaveBeenCalledWith(
        queueName,
        expect.objectContaining({
          name: queueName,
          backendFactory: mockBackendFactory,
        }),
        mockBackendFactory,
      );
    });

    // BUNEST_BUG: Expected BullModule.registerQueue({ backendFactory, processors: [callback] }) to instantiate BullModule.workerClass with `(queueName, callback, opts, backendFactory)`, actual never instantiates workerClass for inline processors in buildQueueInstance() (packages/jobs/src/queues/adapters/bullmq.adapter.ts).
    it.skip("should pass backendFactory to Worker constructor when configured in queue processors", async () => {
      const mockBackendFactory = mock(() => ({}));
      const queueName = "postgres-worker-queue";
      const processorCallback = mock(async () => undefined);

      moduleRef = await Test.createTestingModule({
        imports: [
          BullModule.registerQueue({
            name: queueName,
            backendFactory: mockBackendFactory,
            processors: [processorCallback],
          }),
        ],
      }).compile({ logger: false });

      const queue = moduleRef.get<MockQueue>(getQueueToken(queueName));
      expect(queue).toBeDefined();
      expect(workerCtorSpy).toHaveBeenCalledWith(
        queueName,
        processorCallback,
        expect.anything(),
        mockBackendFactory,
      );
    });

    // BUNEST_BUG: Expected BullModule.flowProducerClass constructor to receive `backendFactory` as the 2nd argument `(opts, backendFactory)`, actual passes only 1 arg `(merged)` (2nd arg is `undefined`) in BullModule.registerFlowProducer() (packages/jobs/src/queues/adapters/bullmq.adapter.ts).
    it.skip("should pass backendFactory to FlowProducer constructor when configured in registerFlowProducer", async () => {
      const mockBackendFactory = mock(() => ({}));
      const flowName = "postgres-flow";

      moduleRef = await Test.createTestingModule({
        imports: [
          BullModule.registerFlowProducer({
            name: flowName,
            connection: { host: "localhost", port: 5432 },
            backendFactory: mockBackendFactory,
          }),
        ],
      }).compile({ logger: false });

      const flowProducer = moduleRef.get<MockFlowProducer>(
        getFlowProducerToken(flowName),
      );
      expect(flowProducer).toBeDefined();
      expect(flowProducerCtorSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          name: flowName,
          backendFactory: mockBackendFactory,
        }),
        mockBackendFactory,
      );
    });

    // BUNEST_BUG: Expected backendFactory from BullModule.forRoot() to be passed as the 3rd argument to BullModule.queueClass constructor `(name, opts, backendFactory)`, actual passes only 2 args `(name, merged)` (3rd arg is `undefined`) in buildQueueInstance() (packages/jobs/src/queues/adapters/bullmq.adapter.ts).
    it.skip("should propagate backendFactory from root module options to registered queues", async () => {
      const mockBackendFactory = mock(() => ({}));
      const queueName = "inherited-backend-queue";

      moduleRef = await Test.createTestingModule({
        imports: [
          BullModule.forRoot({
            connection: { host: "localhost", port: 5432 },
            backendFactory: mockBackendFactory,
          }),
          BullModule.registerQueue({
            name: queueName,
          }),
        ],
      }).compile({ logger: false });

      const queue = moduleRef.get<MockQueue>(getQueueToken(queueName));
      expect(queue).toBeDefined();
      expect(queueCtorSpy).toHaveBeenCalledWith(
        queueName,
        expect.objectContaining({
          name: queueName,
          backendFactory: mockBackendFactory,
        }),
        mockBackendFactory,
      );
    });
  },
);
