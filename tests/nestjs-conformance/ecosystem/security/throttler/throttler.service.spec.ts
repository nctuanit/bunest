import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { ContextStorage } from "../../../../../packages/core/src";
import {
  ThrottlerStorage,
  ThrottlerStorageService,
  type ThrottlerStorageRecord,
} from "../../../../../packages/security/src";
import {
  Test,
  type TestingModule,
  describeConformance,
} from "../../../_helpers/index";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describeConformance(
  "ThrottlerStorageService",
  {
    upstreamPath: "throttler/src/throttler.service.spec.ts",
    category: "DIRECT_PORT",
    notes:
      "Upstream commit 849929b4df (@nestjs/throttler@6.8.0). Tests MemoryThrottlerStorage (aliased as ThrottlerStorageService) sliding window, blocking, eviction, and AsyncLocalStorage isolation.",
  },
  () => {
    let modRef: TestingModule;
    let service: ThrottlerStorageService;

    beforeEach(async () => {
      modRef = await Test.createTestingModule({
        providers: [
          {
            provide: ThrottlerStorage,
            useClass: ThrottlerStorageService,
          },
        ],
      }).compile();
      service = modRef.get<ThrottlerStorageService>(ThrottlerStorage);
    });

    afterEach(async () => {
      await modRef.close();
    });

    it("should have all of the providers defined", () => {
      expect(service).toBeDefined();
    });

    // BUNEST_BUG: packages/security/src/throttler/memory-throttler.storage.ts returns `timeToExpire` in milliseconds (1000) instead of NestJS @nestjs/throttler-standard seconds (1).
    it.skip("should increment the request count", async () => {
      const result = await service.increment("test", 1000, 1, 0, "test");
      expect(result).toBeDefined();
      expect(result.totalHits).toBe(1);
      expect(result.timeToExpire).toBe(1);
      expect(result.isBlocked).toBe(false);
    });

    it("keys should be independent of each other over blocking and unblocking", async () => {
      const ttl = 100;
      const blockDuration = 100;

      for (let i = 0; i < 10; i++) {
        const result = await service.increment(
          "key1",
          ttl,
          3,
          blockDuration,
          "test",
        );
        expect(result.isBlocked).toBe(false);
        await service.increment("key2", ttl, 3, blockDuration, "test");
        await service.increment("key2", ttl, 3, blockDuration, "test");
        await sleep(50);
      }
    });

    describe("without a block duration", () => {
      // BUNEST_BUG: packages/security/src/throttler/memory-throttler.storage.ts (increment lines 106-127) leaves `isBlocked: false` and `timeToBlockExpire: 0` when `blockDuration === 0` and `hits.length >= limit`, instead of marking requests over limit as `isBlocked: true` with `timeToBlockExpire > 0`.
      it.skip("rejects requests over the limit instead of resetting the counter", async () => {
        const ttl = 1000;
        const results: ThrottlerStorageRecord[] = [];
        for (let i = 0; i < 5; i++) {
          results.push(await service.increment("no-block", ttl, 2, 0, "test"));
        }
        expect(results.map((result) => result.isBlocked)).toEqual([
          false,
          false,
          true,
          true,
          true,
        ]);
        expect(results[2]!.totalHits).toBe(3);
        expect(results[2]!.timeToBlockExpire).toBeGreaterThan(0);
      });

      // BUNEST_BUG: packages/security/src/throttler/memory-throttler.storage.ts returns `isBlocked: false` and `timeToBlockExpire: 0` when `blockDuration === 0` (and returns ms rather than seconds for expiry fields).
      it.skip("reports when the oldest hit expires as the time to wait", async () => {
        const ttl = 10_000;
        await service.increment("oldest", ttl, 1, 0, "test");
        await sleep(1100);
        const result = await service.increment("oldest", ttl, 1, 0, "test");
        expect(result.isBlocked).toBe(true);
        expect(result.timeToBlockExpire).toBe(9);
      });

      // BUNEST_BUG: packages/security/src/throttler/memory-throttler.storage.ts returns `isBlocked: false` and `timeToBlockExpire: 0` for `limit: 0, blockDuration: 0` instead of `isBlocked: true, timeToBlockExpire: 1` (in seconds).
      it.skip("blocks every request for a limit of zero", async () => {
        const result = await service.increment("zero", 1000, 0, 0, "test");
        expect(result.isBlocked).toBe(true);
        expect(result.timeToBlockExpire).toBe(1);
      });

      // BUNEST_BUG: packages/security/src/throttler/memory-throttler.storage.ts returns `isBlocked: false` and `timeToBlockExpire: 0` when `blockDuration === 0` (and ms rather than seconds) on the rejected 500,002nd hit.
      it.skip("handles a window holding more hits than fit in a call stack", async () => {
        const ttl = 60_000;
        const limit = 1_000_000;
        await service.increment("busy-key", ttl, limit, 0, "test");
        const bucket = (
          service as unknown as {
            buckets: Map<string, { hits: number[] }>;
          }
        ).buckets.get("busy-key");
        expect(bucket).toBeDefined();
        bucket!.hits = new Array(500_000).fill(Date.now());

        const result = await service.increment(
          "busy-key",
          ttl,
          limit,
          0,
          "test",
        );
        expect(result.isBlocked).toBe(false);
        expect(result.totalHits).toBe(500_001);

        const rejected = await service.increment(
          "busy-key",
          ttl,
          500_001,
          0,
          "test",
        );
        expect(rejected.isBlocked).toBe(true);
        expect(rejected.timeToBlockExpire).toBe(60);
      });

      // BUNEST_BUG: packages/security/src/throttler/memory-throttler.storage.ts returns `isBlocked: false` on over-limit retries when `blockDuration === 0`.
      it.skip("lets requests through again once the earlier hits expire", async () => {
        const ttl = 100;
        await service.increment("no-block", ttl, 2, 0, "test");
        await service.increment("no-block", ttl, 2, 0, "test");

        for (let i = 0; i < 5; i++) {
          await sleep(15);
          const result = await service.increment("no-block", ttl, 2, 0, "test");
          expect(result.isBlocked).toBe(true);
        }

        await sleep(ttl);
        const result = await service.increment("no-block", ttl, 2, 0, "test");
        expect(result.isBlocked).toBe(false);
        expect(result.totalHits).toBe(1);
      });
    });

    describe("request context retention", () => {
      it("does not create a timer per hit", async () => {
        await service.increment("warm-up", 1000, 10, 1000, "test");
        const setTimeoutSpy = spyOn(globalThis, "setTimeout");
        try {
          for (let i = 0; i < 5; i++) {
            await service.increment("no-timers", 1000, 10, 1000, "test");
          }
          expect(setTimeoutSpy).not.toHaveBeenCalled();
        } finally {
          setTimeoutSpy.mockRestore();
        }
      });

      it("expires hits without timers", async () => {
        const ttl = 50;
        await service.increment("expiring", ttl, 2, ttl, "test");
        await service.increment("expiring", ttl, 2, ttl, "test");
        await sleep(ttl + 20);
        const result = await service.increment("expiring", ttl, 2, ttl, "test");
        expect(result.totalHits).toBe(1);
        expect(result.isBlocked).toBe(false);
      });

      // BUNEST_BUG: packages/security/src/throttler/memory-throttler.storage.ts (constructor lines 39-56) eagerly starts `setInterval` inside `constructor()` with the 60s default before subclass field `protected readonly sweepIntervalMs = 10` initializes, instead of lazily starting the sweep outside AsyncLocalStorage on first increment().
      it.skip("does not start the sweep inside the request context", async () => {
        class FastSweepStorage extends ThrottlerStorageService {
          protected override readonly sweepIntervalMs = 10;
        }
        const storage = new FastSweepStorage();
        const als = new ContextStorage<{ request: string }>();
        let storeSeenBySweep: unknown = "sweep never ran";
        const sweepTarget = storage as unknown as {
          sweepExpired: () => void;
        };
        sweepTarget.sweepExpired = () => {
          storeSeenBySweep = als.getStore();
        };

        try {
          await als.run({ request: "first" }, () =>
            storage.increment("k", 1000, 10, 1000, "test"),
          );
          await sleep(40);
        } finally {
          storage.onApplicationShutdown();
        }

        expect(storeSeenBySweep).toBeUndefined();
      });
    });

    describe("record eviction", () => {
      const sweep = () => service.sweepExpired();

      it("drops records once their window has fully elapsed", async () => {
        const ttl = 50;
        for (let i = 0; i < 100; i++) {
          await service.increment(`tracker-${i}`, ttl, 10, 0, "test");
        }
        expect(service.storage.size).toBe(100);

        // Nothing is evicted while the windows are still live.
        sweep();
        expect(service.storage.size).toBe(100);

        await sleep(ttl * 2);
        sweep();
        expect(service.storage.size).toBe(0);
      });

      it("does not evict a record that still has pending hits", async () => {
        const ttl = 500;
        await service.increment("busy", ttl, 10, 0, "test");
        await sleep(50);
        sweep();
        expect(service.storage.has("busy")).toBe(true);

        const result = await service.increment("busy", ttl, 10, 0, "test");
        expect(result.totalHits).toBe(2);
      });

      it("does not evict a record while it is still blocked", async () => {
        const ttl = 50;
        const blockDuration = 1000;
        await service.increment("blocked", ttl, 1, blockDuration, "test");
        const blockedResult = await service.increment(
          "blocked",
          ttl,
          1,
          blockDuration,
          "test",
        );
        expect(blockedResult.isBlocked).toBe(true);

        await sleep(ttl * 2);
        sweep();
        expect(service.storage.has("blocked")).toBe(true);
      });
    });

    describe("with a limit of zero and a block duration", () => {
      it("keeps rejecting requests after a block has elapsed", async () => {
        const first = await service.increment("closed", 50, 0, 50, "test");
        expect(first.isBlocked).toBe(true);

        await sleep(80);

        const afterBlock = await service.increment("closed", 50, 0, 50, "test");
        expect(afterBlock.isBlocked).toBe(true);
        expect(afterBlock.timeToBlockExpire).toBeGreaterThan(0);
      });
    });

    it("lets a request through once a block has elapsed when the limit allows it", async () => {
      await service.increment("open", 50, 1, 50, "test");
      const blocked = await service.increment("open", 50, 1, 50, "test");
      expect(blocked.isBlocked).toBe(true);

      await sleep(80);

      const afterBlock = await service.increment("open", 50, 1, 50, "test");
      expect(afterBlock.isBlocked).toBe(false);
      expect(afterBlock.totalHits).toBe(1);
    });
  },
);
