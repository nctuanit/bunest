import { afterEach, describe, expect, it } from "bun:test";
import { BunestFactory, Injectable, Module } from "@bunest/core";
import {
  Cron,
  CronExpression,
  CronJob,
  InMemorySchedulerLockDriver,
  LUA_RELEASE_LOCK,
  LUA_RENEW_LOCK,
  RedisSchedulerLockDriver,
  SCHEDULER_LOCK_DRIVER,
  ScheduleModule,
  SchedulerRegistry,
  type RedisLockClientLike,
} from "../../src/scheduler";

class MockRedisLockClient implements RedisLockClientLike {
  public readonly store = new Map<string, { value: string; expiresAt: number }>();
  public readonly commands: Array<{ cmd: string; args: unknown[] }> = [];
  public readonly shas = new Map<string, string>();
  public simulateNoScriptOnce = false;
  public nowMs = 1_000_000;

  private getEntry(key: string) {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.nowMs) {
      this.store.delete(key);
      return undefined;
    }
    return entry;
  }

  async set(
    key: string,
    value: string,
    ...args: Array<string | number>
  ): Promise<string | null> {
    this.commands.push({ cmd: "SET", args: [key, value, ...args] });
    const hasNx = args.includes("NX");
    const pxIdx = args.indexOf("PX");
    const ttlMs = pxIdx !== -1 ? Number(args[pxIdx + 1]) : 1000;
    if (hasNx && this.getEntry(key)) {
      return null;
    }
    this.store.set(key, { value, expiresAt: this.nowMs + ttlMs });
    return "OK";
  }

  async scriptLoad(script: string): Promise<string> {
    const sha = `sha_${this.shas.size + 1}`;
    this.shas.set(sha, script);
    return sha;
  }

  async evalsha(
    sha1: string,
    numKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown> {
    if (this.simulateNoScriptOnce) {
      this.simulateNoScriptOnce = false;
      throw new Error("NOSCRIPT No matching script.");
    }
    const script = this.shas.get(sha1);
    if (!script) {
      throw new Error("NOSCRIPT No matching script.");
    }
    return this.eval(script, numKeys, ...args);
  }

  async eval(
    script: string,
    numKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown> {
    const keys = args.slice(0, numKeys).map(String);
    const argv = args.slice(numKeys).map(String);
    const key = keys[0]!;
    const token = argv[0]!;

    if (script === LUA_RELEASE_LOCK) {
      this.commands.push({ cmd: "LUA_RELEASE_LOCK", args: [key, token] });
      const entry = this.getEntry(key);
      if (entry && entry.value === token) {
        this.store.delete(key);
        return 1;
      }
      return 0;
    }

    if (script === LUA_RENEW_LOCK) {
      this.commands.push({ cmd: "LUA_RENEW_LOCK", args: [key, token, argv[1]] });
      const entry = this.getEntry(key);
      if (entry && entry.value === token) {
        entry.expiresAt = this.nowMs + Number(argv[1]);
        return 1;
      }
      return 0;
    }

    throw new Error(`Unexpected script: ${script}`);
  }
}

describe("Distributed Cron Locking", () => {
  const jobs: CronJob[] = [];
  const track = (job: CronJob): CronJob => {
    jobs.push(job);
    return job;
  };

  afterEach(() => {
    while (jobs.length > 0) {
      jobs.pop()!.stop();
    }
  });

  it("InMemorySchedulerLockDriver enforces atomic NX acquisition, TTL expiry, and token-verified release/renew", async () => {
    let clock = 10_000;
    const driver = new InMemorySchedulerLockDriver({ now: () => clock });

    expect(await driver.acquire("job:a", 500, "tok-1")).toBe(true);
    expect(driver.has("job:a")).toBe(true);
    // Second node with different token cannot acquire while lease is active
    expect(await driver.acquire("job:a", 500, "tok-2")).toBe(false);
    // Wrong token cannot release or renew
    expect(await driver.release("job:a", "tok-2")).toBe(false);
    expect(await driver.renew("job:a", 500, "tok-2")).toBe(false);

    // Owner renews TTL
    clock += 300;
    expect(await driver.renew("job:a", 500, "tok-1")).toBe(true);
    clock += 300; // 600ms since start, but renewed at 10_300 -> expires 10_800
    expect(await driver.acquire("job:a", 500, "tok-2")).toBe(false);

    // Owner releases
    expect(await driver.release("job:a", "tok-1")).toBe(true);
    expect(driver.has("job:a")).toBe(false);
    expect(await driver.acquire("job:a", 500, "tok-2")).toBe(true);

    // TTL expiry allows another node to acquire
    clock += 600;
    expect(await driver.acquire("job:a", 500, "tok-3")).toBe(true);
    expect(await driver.release("job:a", "tok-2")).toBe(false);
  });

  it("RedisSchedulerLockDriver uses atomic SET NX PX and token-verified Lua release/renew scripts", async () => {
    const redis = new MockRedisLockClient();
    const driver = new RedisSchedulerLockDriver(redis, { prefix: "cronlock" });

    expect(await driver.acquire("billing", 1000, "node-a")).toBe(true);
    expect(redis.commands[0]).toEqual({
      cmd: "SET",
      args: ["cronlock:billing", "node-a", "NX", "PX", 1000],
    });
    expect(await driver.acquire("billing", 1000, "node-b")).toBe(false);

    // Wrong token rejected by Lua scripts
    expect(await driver.renew("billing", 2000, "node-b")).toBe(false);
    expect(await driver.release("billing", "node-b")).toBe(false);

    // NOSCRIPT recovery on evalsha
    redis.simulateNoScriptOnce = true;
    expect(await driver.renew("billing", 2000, "node-a")).toBe(true);
    expect(await driver.release("billing", "node-a")).toBe(true);
    expect(redis.store.size).toBe(0);

    // Empty prefix omits leading colon
    const noPrefixDriver = new RedisSchedulerLockDriver(redis, { prefix: "" });
    expect(await noPrefixDriver.acquire("raw-key", 500, "tok-x")).toBe(true);
    expect(redis.store.has("raw-key")).toBe(true);
  });

  it('CronJob in "skip" mode prevents concurrent multi-node execution, renews slow ticks, and releases on completion/error', async () => {
    const lockDriver = new InMemorySchedulerLockDriver();
    const runs: string[] = [];

    const node1 = track(
      new CronJob(
        CronExpression.EVERY_MINUTE,
        async () => {
          runs.push("node1:start");
          await Bun.sleep(65);
          runs.push("node1:end");
        },
        {
          name: "sync-job-node1",
          lock: { ttlMs: 40, key: "shared:sync", mode: "skip", renewIntervalMs: 15 },
          lockDriver,
        },
      ),
    );

    const node2 = track(
      new CronJob(
        CronExpression.EVERY_MINUTE,
        async () => {
          runs.push("node2");
        },
        {
          name: "sync-job-node2",
          lock: { ttlMs: 40, key: "shared:sync", mode: "skip" },
          lockDriver,
        },
      ),
    );

    // Fire node1 and node2 concurrently; node1 holds & renews lock across 65ms (> 40ms ttl)
    const p1 = node1.fireOnce();
    await Bun.sleep(10);
    await node2.fireOnce();
    await Bun.sleep(35); // Past initial 40ms TTL — renewal must still keep node2 out
    await node2.fireOnce();
    await p1;

    expect(runs).toEqual(["node1:start", "node1:end"]);
    expect(node2.skippedTicks).toBe(2);
    expect(lockDriver.has("shared:sync")).toBe(false);

    // Once node1 finishes and releases, node2 can acquire and run
    await node2.fireOnce();
    expect(runs).toEqual(["node1:start", "node1:end", "node2"]);
  });

  it('CronJob in "leader" mode elects one leader, renews leadership lease, and fails over cleanly when leader stops', async () => {
    const lockDriver = new InMemorySchedulerLockDriver();
    const executedBy: string[] = [];

    const leader = track(
      new CronJob(
        CronExpression.EVERY_HOUR,
        () => {
          executedBy.push("leader-a");
        },
        {
          name: "leader-a",
          lock: { ttlMs: 60, key: "cluster:leader", mode: "leader", renewIntervalMs: 15 },
          lockDriver,
        },
      ),
    );

    const standby = track(
      new CronJob(
        CronExpression.EVERY_HOUR,
        () => {
          executedBy.push("standby-b");
        },
        {
          name: "standby-b",
          lock: { ttlMs: 60, key: "cluster:leader", mode: "leader", renewIntervalMs: 15 },
          lockDriver,
        },
      ),
    );

    leader.start();
    await Bun.sleep(20);
    standby.start();
    await Bun.sleep(80); // Longer than ttlMs (60ms) so leader must have renewed lease

    expect(leader.isLeader()).toBe(true);
    expect(standby.isLeader()).toBe(false);

    await leader.fireOnce();
    await standby.fireOnce();
    expect(executedBy).toEqual(["leader-a"]);
    expect(standby.skippedTicks).toBe(1);

    // Stop leader -> releases lease -> standby takes over leadership on next renewal tick
    leader.stop();
    await Bun.sleep(35);

    expect(leader.isLeader()).toBe(false);
    expect(standby.isLeader()).toBe(true);

    await standby.fireOnce();
    expect(executedBy).toEqual(["leader-a", "standby-b"]);
  });

  it("wires ScheduleModule.forRoot({ lockDriver }) and forRootAsync({ useFactory }) into @Cron() jobs", async () => {
    const sharedDriver = new InMemorySchedulerLockDriver();
    const hits: string[] = [];

    @Injectable()
    class ClusterCronA {
      @Cron(CronExpression.EVERY_HOUR, {
        name: "nightly-rollup",
        lock: { ttlMs: 500, mode: "skip" },
      })
      async run() {
        hits.push("A:start");
        await Bun.sleep(35);
        hits.push("A:end");
      }
    }

    @Injectable()
    class ClusterCronB {
      @Cron(CronExpression.EVERY_HOUR, {
        name: "nightly-rollup",
        lock: { ttlMs: 500, mode: "skip" },
      })
      async run() {
        hits.push("B");
      }
    }

    @Module({
      imports: [ScheduleModule.forRoot({ lockDriver: sharedDriver })],
      providers: [ClusterCronA],
    })
    class NodeAModule {}

    @Module({
      imports: [
        ScheduleModule.forRootAsync({
          useFactory: () => ({ lockDriver: sharedDriver }),
        }),
      ],
      providers: [ClusterCronB],
    })
    class NodeBModule {}

    const appA = await BunestFactory.createApplicationContext(NodeAModule);
    const appB = await BunestFactory.createApplicationContext(NodeBModule);
    try {
      expect(appA.get(SCHEDULER_LOCK_DRIVER)).toBe(sharedDriver);
      expect(appB.get(SCHEDULER_LOCK_DRIVER)).toBe(sharedDriver);

      const jobA = appA.get(SchedulerRegistry).getCronJob("nightly-rollup");
      const jobB = appB.get(SchedulerRegistry).getCronJob("nightly-rollup");

      const pA = jobA.fireOnce();
      await Bun.sleep(10);
      await jobB.fireOnce();
      await pA;

      expect(hits).toEqual(["A:start", "A:end"]);
      expect(jobB.skippedTicks).toBe(1);
    } finally {
      await appB.close();
      await appA.close();
    }
  });
});
