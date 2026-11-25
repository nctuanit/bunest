import { describe, expect, it } from "bun:test";
import { CacheService } from "../../packages/cache/src";
import { RedisCacheStore } from "../../packages/cache/src/redis";
import type { Job } from "../../packages/jobs/src/queues";
import { RedisQueueDriver } from "../../packages/jobs/src/redis";

const REDIS_URL = Bun.env.REDIS_URL;
const REDIS_STOP_CMD = Bun.env.REDIS_STOP_CMD;
const REDIS_START_CMD = Bun.env.REDIS_START_CMD;

async function runShell(cmd: string): Promise<void> {
  const proc = Bun.spawn(["sh", "-c", cmd], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Command failed (${code}): ${cmd}\n${stderr}`);
  }
}

function makeJob<TData>(
  queue: string,
  id: string,
  name: string,
  data: TData,
  maxAttempts = 2,
): Job<TData> {
  const now = Date.now();
  return {
    id,
    queue,
    name,
    data,
    status: "waiting",
    priority: 0,
    attemptsMade: 0,
    maxAttempts,
    createdAt: now,
    updatedAt: now,
    processAfter: now,
    stacktrace: [],
  };
}

describe.skipIf(!REDIS_URL)(
  "Real Redis Integration & Fault-Injection Suite (@bunest/cache/redis + @bunest/jobs/redis)",
  () => {
    it("verifies RedisCacheStore TTL, tag/prefix invalidation, and CacheService.wrap() stampede dedup", async () => {
      const prefix = `bunest:smoke:cache:${Date.now()}:`;
      const store = new RedisCacheStore({
        url: REDIS_URL!,
        keyPrefix: prefix,
        defaultTtlMs: 10_000,
      });
      const cache = new CacheService(store);

      try {
        await cache.set("user:1", { id: 1, role: "admin" }, { ttlMs: 5_000, tags: ["users"] });
        expect(await cache.get<{ id: number; role: string }>("user:1")).toEqual({
          id: 1,
          role: "admin",
        });

        // Stampede protection: concurrent wrap() calls invoke factory once
        let factoryCalls = 0;
        const [a, b, c] = await Promise.all([
          cache.wrap("expensive:key", async () => {
            factoryCalls++;
            await Bun.sleep(40);
            return { computed: 42 };
          }, 5_000),
          cache.wrap("expensive:key", async () => {
            factoryCalls++;
            await Bun.sleep(40);
            return { computed: 42 };
          }, 5_000),
          cache.wrap("expensive:key", async () => {
            factoryCalls++;
            await Bun.sleep(40);
            return { computed: 42 };
          }, 5_000),
        ]);
        expect(factoryCalls).toBe(1);
        expect(a).toEqual({ computed: 42 });
        expect(b).toEqual({ computed: 42 });
        expect(c).toEqual({ computed: 42 });

        // Tag invalidation
        await cache.invalidateTag("users");
        expect(await cache.get("user:1")).toBeUndefined();

        // Short TTL expiry
        await cache.set("ephemeral", "gone-soon", 80);
        expect(await cache.get<string>("ephemeral")).toBe("gone-soon");
        await Bun.sleep(130);
        expect(await cache.get<string>("ephemeral")).toBeUndefined();
      } finally {
        await store.close?.();
      }
    });

    it("verifies RedisQueueDriver Lua atomic dequeue, lease expiry/stalled reclaim, retry, and DLQ", async () => {
      const prefix = `bunest:smoke:queue:${Date.now()}`;
      const queueName = "orders";
      const driver = new RedisQueueDriver(REDIS_URL!, {
        prefix,
        lockDurationMs: 150,
        stalledIntervalMs: 0,
        maxStalledCount: 1,
      });

      try {
        // 1. Enqueue & ack happy path
        const okJob = makeJob(queueName, "job-ok-1", "process", { orderId: 101 }, 2);
        await driver.enqueue(queueName, okJob);
        const leased = await driver.dequeue<{ orderId: number }>(queueName);
        expect(leased?.id).toBe("job-ok-1");
        expect(leased?.leaseToken).toBeDefined();

        const acked = await driver.ack(
          queueName,
          leased!.id,
          { done: true },
          leased!.leaseToken,
        );
        expect(acked?.status).toBe("completed");

        // 2. Crashed worker simulation -> lease expires -> reclaimStalledJobs re-queues job
        const stallJob = makeJob(queueName, "job-stall-1", "process", { orderId: 202 }, 2);
        await driver.enqueue(queueName, stallJob);
        const leasedStall = await driver.dequeue(queueName);
        expect(leasedStall?.id).toBe("job-stall-1");

        // Wait past lockDurationMs without renewing or acking
        await Bun.sleep(220);
        const reclaim1 = await driver.reclaimStalledJobs(queueName);
        expect(reclaim1.reclaimed.map((j) => j.id)).toContain("job-stall-1");

        // Stale worker token must be rejected
        const staleAck = await driver.ack(
          queueName,
          "job-stall-1",
          { stale: true },
          leasedStall!.leaseToken,
        );
        expect(staleAck).toBeNull();

        // New worker picks up reclaimed job, fails it -> moves to DLQ on max attempts
        const leasedAgain = await driver.dequeue(queueName);
        expect(leasedAgain?.id).toBe("job-stall-1");
        await driver.moveToDeadLetter(
          queueName,
          leasedAgain!.id,
          new Error("permanent failure"),
          leasedAgain!.leaseToken,
        );
        const dlq = await driver.getDeadLetterJobs(queueName);
        expect(dlq.map((j) => j.id)).toContain("job-stall-1");
      } finally {
        await driver.close();
      }
    });

    it.skipIf(!REDIS_STOP_CMD || !REDIS_START_CMD)(
      "recovers cleanly after a live Redis outage (stop -> error -> start -> reconnect)",
      async () => {
        const prefix = `bunest:smoke:outage:${Date.now()}:`;
        const store = new RedisCacheStore({
          url: REDIS_URL!,
          keyPrefix: prefix,
        });

        try {
          await store.set("before-outage", { ok: true }, 60_000);
          expect(await store.get("before-outage")).toEqual({ ok: true });

          // Inject outage
          await runShell(REDIS_STOP_CMD!);
          await Bun.sleep(300);

          let threw = false;
          try {
            await Promise.race([
              store.get("before-outage"),
              Bun.sleep(2_000).then(() => {
                throw new Error("redis outage timeout");
              }),
            ]);
          } catch {
            threw = true;
          }
          expect(threw).toBe(true);
        } finally {
          // Always restart Redis so container is never left down
          await runShell(REDIS_START_CMD!);
          await store.close?.();
        }

        // Wait for Redis to become reachable again and verify fresh client recovers
        let recovered = false;
        for (let attempt = 0; attempt < 20; attempt++) {
          const probe = new RedisCacheStore({
            url: REDIS_URL!,
            keyPrefix: prefix,
          });
          try {
            await probe.set("after-outage", { recovered: true }, 10_000);
            const val = await probe.get<{ recovered: boolean }>("after-outage");
            if (val?.recovered) {
              recovered = true;
              await probe.close?.();
              break;
            }
          } catch {
            // retry until Redis finishes booting
          } finally {
            await probe.close?.();
          }
          await Bun.sleep(250);
        }

        expect(recovered).toBe(true);
      },
      30_000,
    );
  },
);
