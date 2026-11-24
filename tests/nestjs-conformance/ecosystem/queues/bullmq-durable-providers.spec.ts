import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import {
  Inject,
  Injectable,
  REQUEST,
  Scope,
} from "../../../../packages/core/src/common";
import {
  ContextIdFactory,
  DiscoveryModule,
  createContextId,
} from "../../../../packages/core/src";
import {
  BullMQExplorer,
  BullModule,
  Processor,
  ProcessorDecoratorService,
  WorkerHost,
  type Job,
} from "../../../../packages/jobs/src/queues";
import { Test, TestingModule, describeConformance } from "../../_helpers/index";

const workerCtorSpy = mock((..._args: unknown[]) => {});

class MockWorker {
  constructor(...args: unknown[]) {
    workerCtorSpy(...args);
  }
  on = mock(() => {});
  off = mock(() => {});
  close = mock(async () => {});
}

@Injectable({ scope: Scope.REQUEST, durable: true })
class DurableDependency {
  static counter = 0;
  public readonly counter: number;
  constructor(@Inject(REQUEST) public readonly job: any) {
    this.counter = DurableDependency.counter;
    DurableDependency.counter++;
  }
}

@Injectable({ scope: Scope.REQUEST, durable: false })
class NonDurableDependency {
  static counter = 0;
  public readonly counter: number;
  constructor() {
    this.counter = NonDurableDependency.counter;
    NonDurableDependency.counter++;
  }
}

@Processor({ scope: Scope.REQUEST })
class ProcessorWithDurableDependency extends WorkerHost {
  constructor(
    private readonly durableDependency: DurableDependency,
    private readonly nonDurableDependency: NonDurableDependency,
  ) {
    super();
  }
  async process(_job: Job<any, any>, _token?: string): Promise<any> {
    return [this.durableDependency, this.nonDurableDependency];
  }
}

describeConformance(
  "BullExplorer — Durable Providers",
  {
    upstreamPath: "bull/packages/bullmq/lib/test/durable-providers.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-012"],
    notes:
      "Upstream commit 2686e032f369682b4f93bdcd1cbbe2b45b34bce6. Runs offline using BullModule.workerClass = MockWorker instead of mocking external `bullmq`, testing durable ContextIdStrategy resolution inside request-scoped processors.",
  },
  () => {
    let bullExplorer: BullMQExplorer;
    let moduleRef: TestingModule;

    beforeAll(async () => {
      workerCtorSpy.mockClear();
      DurableDependency.counter = 0;
      NonDurableDependency.counter = 0;
      BullModule.workerClass = MockWorker;

      moduleRef = await Test.createTestingModule({
        imports: [
          DiscoveryModule,
          BullModule.forRoot({
            connection: {},
            extraOptions: { manualRegistration: true },
          }),
          BullModule.registerQueue({}),
        ],
        providers: [
          DurableDependency,
          NonDurableDependency,
          ProcessorWithDurableDependency,
          ProcessorDecoratorService,
        ],
      }).compile({ logger: false });

      bullExplorer = moduleRef.get(BullMQExplorer);
    });

    afterAll(async () => {
      ContextIdFactory.reset();
      BullModule.workerClass = undefined;
      await moduleRef?.close();
    });

    describe("registerWorkers", () => {
      const durableContextId = createContextId();
      const mockJobRef = { id: "X", name: "job", data: {} };

      beforeAll(() => {
        ContextIdFactory.apply({
          attach: (contextId, request) => ({
            resolve: (info) => {
              return info.isTreeDurable ? durableContextId : contextId;
            },
            payload: request,
          }),
        });
      });

      afterAll(() => {
        ContextIdFactory.reset();
      });

      it("should load durable processor dependencies", async () => {
        bullExplorer.register();
        const processorFunction = workerCtorSpy.mock.calls[0]?.[1] as
          | ((
              job: unknown,
            ) => Promise<[DurableDependency, NonDurableDependency]>)
          | undefined;
        expect(processorFunction).toBeDefined();

        const [durable1, nonDurable1] = await processorFunction!(mockJobRef);
        const [durable2, nonDurable2] = await processorFunction!(mockJobRef);

        expect(durable1).toBe(durable2);
        expect(nonDurable1).not.toBe(nonDurable2);
      });

      it("should inject the request dependency", async () => {
        const durableDependency = await moduleRef.resolve(
          DurableDependency,
          durableContextId,
        );
        expect(durableDependency.job).toBeDefined();
        expect(durableDependency.job.id).toBe(mockJobRef.id);
      });
    });
  },
);
