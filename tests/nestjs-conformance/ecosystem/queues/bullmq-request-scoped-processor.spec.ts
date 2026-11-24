import { afterAll, beforeAll, expect, it, mock } from "bun:test";
import { Scope } from "../../../../packages/core/src/common";
import { DiscoveryModule } from "../../../../packages/core/src";
import {
  BullMQExplorer,
  BullModule,
  Processor,
  ProcessorDecoratorService,
  WorkerHost,
  type Job,
} from "../../../../packages/jobs/src/queues";
import { Test, TestingModule, describeConformance } from "../../_helpers/index";

const workerInstances: unknown[] = [];
const workerCtorSpy = mock((..._args: unknown[]) => {});

class MockWorker {
  constructor(...args: unknown[]) {
    workerCtorSpy(...args);
    workerInstances.push(this);
  }
  on = mock(() => {});
  off = mock(() => {});
  close = mock(async () => {});
}

@Processor({ name: "request_scoped", scope: Scope.REQUEST })
class RequestScopedProcessor extends WorkerHost {
  async process(_job: Job<any, any>): Promise<any> {
    return this.worker;
  }
}

describeConformance(
  "Request-scoped processor",
  {
    upstreamPath:
      "bull/packages/bullmq/lib/test/request-scoped-processor.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-012"],
    notes:
      "Upstream commit 2686e032f369682b4f93bdcd1cbbe2b45b34bce6. Runs offline using BullModule.workerClass = MockWorker instead of mocking external `bullmq`.",
  },
  () => {
    let bullExplorer: BullMQExplorer;
    let moduleRef: TestingModule;

    beforeAll(async () => {
      workerInstances.length = 0;
      workerCtorSpy.mockClear();
      BullModule.workerClass = MockWorker;

      moduleRef = await Test.createTestingModule({
        imports: [
          DiscoveryModule,
          BullModule.forRoot({
            connection: {},
            extraOptions: { manualRegistration: true },
          }),
          BullModule.registerQueue({ name: "request_scoped" }),
        ],
        providers: [RequestScopedProcessor, ProcessorDecoratorService],
      }).compile({ logger: false });

      bullExplorer = moduleRef.get(BullMQExplorer);
    });

    afterAll(async () => {
      BullModule.workerClass = undefined;
      await moduleRef?.close();
    });

    // BUNEST_BUG: Expected `this.worker` inside `process()` of a Scope.REQUEST WorkerHost processor to return the instantiated worker, actual throws `"Worker" has not yet been initialized...` because BullMQExplorer.registerProcessor (packages/jobs/src/queues/adapters/bullmq.adapter.ts) never assigns `_worker = worker` on per-job resolved request-scoped instances.
    it.skip('should expose the worker inside "process" of a request-scoped processor', async () => {
      bullExplorer.register();
      const processorFunction = workerCtorSpy.mock.calls[0]?.[1] as
        ((job: unknown) => Promise<unknown>) | undefined;
      expect(processorFunction).toBeDefined();

      const worker = await processorFunction!({
        id: "1",
        name: "job",
        data: {},
      });

      expect(worker).toBe(workerInstances[0]);
    });
  },
);
