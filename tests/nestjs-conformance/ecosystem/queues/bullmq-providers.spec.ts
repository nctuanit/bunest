import { afterEach, beforeEach, expect, it, mock } from "bun:test";
import {
  BullModule,
  type BullQueueProcessorCallback,
} from "../../../../packages/jobs/src/queues";
import { Test, TestingModule, describeConformance } from "../../_helpers/index";

const workerCtorSpy = mock((..._args: unknown[]) => {});

class MockQueue {
  opts: unknown;
  constructor(
    public readonly name: string,
    opts?: unknown,
  ) {
    this.opts = opts;
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

describeConformance(
  "Queue processors (bull.providers)",
  {
    upstreamPath: "bull/packages/bullmq/lib/test/bull.providers.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Upstream commit 2686e032f369682b4f93bdcd1cbbe2b45b34bce6. Runs offline using BullModule.queueClass / BullModule.workerClass spies instead of vi.mock('bullmq').",
  },
  () => {
    const queueName = "telemetry-queue";
    const telemetry = { tracer: {}, contextManager: {} };
    let moduleRef: TestingModule | undefined;

    beforeEach(() => {
      workerCtorSpy.mockClear();
      BullModule.queueClass = MockQueue;
      BullModule.workerClass = MockWorker;
    });

    afterEach(async () => {
      if (moduleRef) {
        await moduleRef.close();
        moduleRef = undefined;
      }
      BullModule.queueClass = undefined;
      BullModule.workerClass = undefined;
    });

    it("should pass telemetry from the queue options to every worker", async () => {
      const callback = mock(
        async () => undefined,
      ) as BullQueueProcessorCallback;
      const path = "/path/to/processor.js";

      moduleRef = await Test.createTestingModule({
        imports: [
          BullModule.registerQueue({
            name: queueName,
            telemetry,
            processors: [
              callback,
              path,
              { callback, concurrency: 2 },
              { path, concurrency: 2 },
            ],
          }),
        ],
      }).compile({ logger: false });

      expect(workerCtorSpy).toHaveBeenCalledTimes(4);
      for (const [, , opts] of workerCtorSpy.mock.calls) {
        expect(opts).toEqual(expect.objectContaining({ telemetry }));
      }
    });

    it("should pass skipVersionCheck from the queue options to every worker", async () => {
      const callback = mock(
        async () => undefined,
      ) as BullQueueProcessorCallback;
      const path = "/path/to/processor.js";

      moduleRef = await Test.createTestingModule({
        imports: [
          BullModule.registerQueue({
            name: queueName,
            skipVersionCheck: true,
            processors: [
              callback,
              path,
              { callback, concurrency: 2 },
              { path, concurrency: 2 },
            ],
          }),
        ],
      }).compile({ logger: false });

      expect(workerCtorSpy).toHaveBeenCalledTimes(4);
      for (const [, , opts] of workerCtorSpy.mock.calls) {
        expect(opts).toEqual(
          expect.objectContaining({ skipVersionCheck: true }),
        );
      }
    });

    it("should pass skipVersionCheck from the root options to every worker", async () => {
      moduleRef = await Test.createTestingModule({
        imports: [
          BullModule.forRoot({ connection: {}, skipVersionCheck: true }),
          BullModule.registerQueue({
            name: queueName,
            processors: [
              mock(async () => undefined) as BullQueueProcessorCallback,
            ],
          }),
        ],
      }).compile({ logger: false });

      expect(workerCtorSpy).toHaveBeenCalledWith(
        queueName,
        expect.any(Function),
        expect.objectContaining({ skipVersionCheck: true }),
        undefined,
      );
    });

    it("should let processor options override skipVersionCheck", async () => {
      moduleRef = await Test.createTestingModule({
        imports: [
          BullModule.registerQueue({
            name: queueName,
            skipVersionCheck: true,
            processors: [
              {
                callback: mock(
                  async () => undefined,
                ) as BullQueueProcessorCallback,
                skipVersionCheck: false,
              },
            ],
          }),
        ],
      }).compile({ logger: false });

      expect(workerCtorSpy).toHaveBeenCalledWith(
        queueName,
        expect.any(Function),
        expect.objectContaining({ skipVersionCheck: false }),
        undefined,
      );
    });

    it("should pass telemetry from the root options to every worker", async () => {
      moduleRef = await Test.createTestingModule({
        imports: [
          BullModule.forRoot({ connection: {}, telemetry }),
          BullModule.registerQueue({
            name: queueName,
            processors: [
              mock(async () => undefined) as BullQueueProcessorCallback,
            ],
          }),
        ],
      }).compile({ logger: false });

      expect(workerCtorSpy).toHaveBeenCalledWith(
        queueName,
        expect.any(Function),
        expect.objectContaining({ telemetry }),
        undefined,
      );
    });
  },
);
