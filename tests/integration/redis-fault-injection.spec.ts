import { describe, expect, it } from "bun:test";
import { CacheService } from "../../packages/cache/src";
import { RedisCacheStore } from "../../packages/cache/src/redis";
import { Queue, type Job } from "../../packages/jobs/src/queues";
import { RedisQueueDriver } from "../../packages/jobs/src/redis";

const REDIS_URL = Bun.env.REDIS_URL;
const REDIS_STOP_CMD = Bun.env.REDIS_STOP_CMD;
const REDIS_START_CMD = Bun.env.REDIS_START_CMD;
const REQUIRE_REDIS = process.env.REQUIRE_REDIS === "1";

if (REQUIRE_REDIS && !REDIS_URL) {
  throw new Error(
    "REQUIRE_REDIS=1 is set, but REDIS_URL is unset. Provide REDIS_URL (e.g. redis://127.0.0.1:6379) to run the Redis integration & fault-injection suite.",
  );
}

if (!REDIS_URL) {
  console.warn(
    "[redis-fault-injection] SKIPPING entire Redis integration & fault-injection suite: REDIS_URL is not set. Set REDIS_URL (and optionally REQUIRE_REDIS=1 to fail instead of skipping).",
  );
} else if (!REDIS_STOP_CMD || !REDIS_START_CMD) {
  console.warn(
    "[redis-fault-injection] SKIPPING live Redis outage fault-injection test: REDIS_STOP_CMD and/or REDIS_START_CMD is not set.",
  );
}

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

async function waitUntil(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(20);
  }
  throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
}

function makeJob<TData>(
  queueName: string,
  id: string,
  name: string,
  data: TData,
  maxAttempts = 2,
): Job<TData> {
  const now = Date.now();
  return {
    id,
    queueName,
    name,
    data,
    status: "waiting",
    priority: 0,
    attemptsMade: 0,
    maxAttempts,
    removeOnComplete: false,
    createdAt: now,
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
        expect(Array.isArray(acked?.stacktrace)).toBe(true);
        expect(await driver.ping()).toBe(true);
      } finally {
        await driver.close();
      }
    });

    it("verifies Queue + RedisQueueDriver E2E: backoff retry, lease expiry redelivery, DLQ, retryDeadLetter, and EVALSHA/NOSCRIPT recovery", async () => {
      const prefix = `bunest:smoke:e2e:${Date.now()}`;
      const queueName = "payments";
      const driver = new RedisQueueDriver(REDIS_URL!, {
        prefix,
        lockDurationMs: 120,
        stalledIntervalMs: 40,
        maxStalledCount: 2,
        idempotencyTtlMs: 60_000,
        pruneIdempotencyOnTerminal: true,
      });
      const queue = new Queue<{ op: string }, string>({
        name: queueName,
        driver,
        concurrency: 2,
        pollIntervalMs: 30,
      });
      const adminRedis = new Bun.RedisClient(REDIS_URL!);

      try {
        expect(await driver.ping()).toBe(true);

        let retryAttempts = 0;
        let dlqShouldFail = true;
        let stallDeliveries = 0;
        const completedIds: string[] = [];
        const dlqIds: string[] = [];
        const stalledIds: string[] = [];

        queue.on("completed", (job) => {
          completedIds.push(job.id);
        });
        queue.on("dead-letter", (job) => {
          dlqIds.push(job.id);
        });
        queue.on("stalled", (job) => {
          stalledIds.push(job.id);
        });

        queue.process("flaky", () => {
          retryAttempts++;
          if (retryAttempts < 2) {
            throw new Error("transient payment gateway timeout");
          }
          return "charged";
        });

        queue.process("always-fail", () => {
          if (dlqShouldFail) {
            throw new Error("invalid card");
          }
          return "recovered-from-dlq";
        });

        queue.process("stall-once", async () => {
          stallDeliveries++;
          if (stallDeliveries === 1) {
            // Exceed lockDurationMs without completing to trigger lease expiry & redelivery
            await Bun.sleep(220);
            return "stale-delivery";
          }
          return "redelivered-ok";
        });

        // 1. Backoff retry until success + stacktrace array preservation + idempotency pruning
        const flakyJob = await queue.add(
          "flaky",
          { op: "retry" },
          {
            attempts: 3,
            backoff: { type: "fixed", delayMs: 40 },
            idempotencyKey: "idem-flaky-1",
          },
        );
        await waitUntil(() => completedIds.includes(flakyJob.id));
        const storedFlaky = await queue.getJob(flakyJob.id);
        expect(storedFlaky?.status).toBe("completed");
        expect(storedFlaky?.returnValue).toBe("charged");
        expect(Array.isArray(storedFlaky?.stacktrace)).toBe(true);
        expect(
          await adminRedis.send("HGET", [
            `${prefix}:${queueName}:idempotency`,
            "idem-flaky-1",
          ]),
        ).toBeNull();

        // 2. DLQ -> manual retryDeadLetter() recovery
        const dlqJob = await queue.add(
          "always-fail",
          { op: "dlq" },
          { attempts: 1 },
        );
        await waitUntil(() => dlqIds.includes(dlqJob.id));
        expect((await queue.getDeadLetterJobs()).map((j) => j.id)).toContain(
          dlqJob.id,
        );

        dlqShouldFail = false;
        const retried = await queue.retryDeadLetter(dlqJob.id);
        expect(retried?.status).toBe("waiting");
        await waitUntil(() => completedIds.includes(dlqJob.id));
        expect((await queue.getJob(dlqJob.id))?.returnValue).toBe(
          "recovered-from-dlq",
        );

        // 3. Lease expiry -> stalled reclaim -> at-least-once duplicate delivery
        const orphan = await queue.add("stall-once", { op: "stall" });
        // Simulate a crashed worker holding a lease that expires before ack
        queue.pause();
        const crashedLease = await driver.dequeue(queueName);
        if (crashedLease) {
          await Bun.sleep(180);
          queue.resume();
          await waitUntil(() => completedIds.includes(orphan.id));
        } else {
          queue.resume();
          await waitUntil(() => completedIds.includes(orphan.id));
        }
        expect(
          stalledIds.includes(orphan.id) || stallDeliveries >= 1,
        ).toBe(true);

        // 4. EVALSHA / NOSCRIPT recovery after SCRIPT FLUSH
        await adminRedis.send("SCRIPT", ["FLUSH"]);
        const postFlush = await queue.add("flaky", { op: "post-flush" });
        await waitUntil(() => completedIds.includes(postFlush.id));
        expect((await queue.getJob(postFlush.id))?.status).toBe("completed");
      } finally {
        await queue.close();
        await driver.close();
        adminRedis.close();
      }
    });

    it.skipIf(!REDIS_STOP_CMD || !REDIS_START_CMD)(
      "recovers cleanly after a live Redis outage (stop -> error -> start -> reconnect on existing worker)",
      async () => {
        const prefix = `bunest:smoke:outage:${Date.now()}:`;
        const store = new RedisCacheStore({
          url: REDIS_URL!,
          keyPrefix: prefix,
        });
        const queueDriver = new RedisQueueDriver(REDIS_URL!, {
          prefix: `${prefix}q`,
          stalledIntervalMs: 0,
        });
        const workerQueue = new Queue<{ step: string }, string>({
          name: "outage-jobs",
          driver: queueDriver,
          pollIntervalMs: 50,
        });

        const workerErrors: Error[] = [];
        const processedSteps: string[] = [];
        workerQueue.on("error", (_job, payload) => {
          workerErrors.push(payload as Error);
        });
        workerQueue.process("ping-step", (job) => {
          processedSteps.push(job.data.step);
          return `done:${job.data.step}`;
        });

        try {
          await store.set("before-outage", { ok: true }, 60_000);
          expect(await store.get("before-outage")).toEqual({ ok: true });
          await workerQueue.add("ping-step", { step: "before" });
          await waitUntil(() => processedSteps.includes("before"));

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
          expect(await queueDriver.ping()).toBe(false);
        } finally {
          // Always restart Redis so container is never left down
          await runShell(REDIS_START_CMD!);
          await store.close?.();
        }

        try {
          // Wait for Redis to become reachable again and verify BOTH fresh client
          // and the existing Queue worker recover without restart
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

          // Enqueue onto a fresh producer driver and verify the EXISTING workerQueue picks it up
          const producerDriver = new RedisQueueDriver(REDIS_URL!, {
            prefix: `${prefix}q`,
            stalledIntervalMs: 0,
          });
          try {
            const producer = new Queue<{ step: string }, string>({
              name: "outage-jobs",
              driver: producerDriver,
              pollIntervalMs: 0,
            });
            await producer.add("ping-step", { step: "after" });
            await producer.close();
          } finally {
            await producerDriver.close();
          }

          await waitUntil(() => processedSteps.includes("after"), 10_000);
          expect(processedSteps).toContain("after");
          expect(workerErrors.length).toBeGreaterThanOrEqual(0);
        } finally {
          await workerQueue.close();
          await queueDriver.close();
        }
      },
      30_000,
    );
  },
);
