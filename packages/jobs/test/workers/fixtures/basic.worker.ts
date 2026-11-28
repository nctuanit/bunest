import {
  BadRequestException,
  ClsService,
  DomainException,
} from "@bunest/core";
import {
  defineWorker,
  isMainThread,
  isWorkerThread,
  transferable,
  type WorkerTaskContext,
} from "../../../src/workers";

const workerCls = new ClsService({ generateId: false });
const broadcasts: Array<{ event: string; payload: unknown }> = [];
let initializedFlag = false;

export default defineWorker(
  {
    add: ({ a, b }: { a: number; b: number }) => a + b,

    echo: (value: unknown) => value,

    threadInfo: (_payload: unknown, ctx: WorkerTaskContext) => ({
      isMainThread: isMainThread(),
      isWorkerThread: isWorkerThread(),
      workerId: ctx.workerId,
      initData: ctx.initData,
      initializedFlag,
      preloaded:
        (globalThis as Record<string, unknown>).__BUNEST_PRELOAD_OK === true,
      envMarker: Bun.env.BUNEST_WORKER_TEST_ENV ?? null,
      argvTail: Bun.argv.slice(-2),
    }),

    clsCheck: (_payload: unknown, ctx: WorkerTaskContext) => ({
      requestId: workerCls.get("requestId"),
      tenantId: workerCls.get("tenantId"),
      traceparent: ctx.traceparent,
      carrierValues: ctx.cls?.values ?? null,
    }),

    progress: async (steps: number, ctx: WorkerTaskContext) => {
      for (let i = 1; i <= steps; i++) {
        ctx.reportProgress(Math.round((i / steps) * 100));
        await Bun.sleep(2);
      }
      return { done: steps };
    },

    transferBuffer: (input: Uint8Array) => {
      const out = new Uint8Array(input.length);
      for (let i = 0; i < input.length; i++) {
        out[i] = input[i]! ^ 0xff;
      }
      return transferable(out, [out.buffer]);
    },

    throwHttp: () => {
      throw new BadRequestException("Invalid worker input");
    },

    throwDomain: () => {
      throw new DomainException({
        code: "QUOTA_EXCEEDED",
        kind: "rate_limited",
        message: "Quota reached in worker",
        details: { limit: 10 },
      });
    },

    throwTypeError: () => {
      throw new TypeError("Bad type in worker");
    },

    slowCooperative: async (delayMs: number, ctx: WorkerTaskContext) => {
      const start = Date.now();
      while (Date.now() - start < delayMs) {
        if (ctx.signal.aborted) {
          return { cancelled: true };
        }
        await Bun.sleep(5);
      }
      return { cancelled: false };
    },

    infiniteLoop: () => {
      // Simulates hung synchronous CPU work
      // eslint-disable-next-line no-constant-condition
      while (true) {
        // busy spin
      }
    },

    crashWorker: () => {
      process.exit(42);
    },

    getBroadcasts: () => [...broadcasts],

    // Sandboxed queue job handler example
    "heavy-compute": ({ n }: { n: number }) => ({ doubled: n * 2 }),
  },
  {
    clsService: workerCls,
    onInit: async () => {
      // Simulate async initialization to test Bun's startup message buffering
      await Bun.sleep(15);
      initializedFlag = true;
    },
    onBroadcast: (event, payload) => {
      broadcasts.push({ event, payload });
    },
  },
);
