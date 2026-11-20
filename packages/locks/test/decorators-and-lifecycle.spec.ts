import { Injectable, Module, Scope, SetMetadata } from "@bunest/common";
import { BunestFactory } from "@bunest/core";
import { describe, expect, it } from "bun:test";
import { subscribe as dcSubscribe, unsubscribe as dcUnsubscribe } from "node:diagnostics_channel";
import {
  InMemoryLockStore,
  LOCKS_MODULE_OPTIONS,
  LeaderElection,
  Locks,
  LocksContext,
  LocksEvents,
  LocksModule,
  LocksStorage,
  ManualLockClock,
  OnOneInstance,
  WithoutOverlapping,
  type Lock,
  type LocksEvent,
  type LocksJobSkippedEvent,
  type LocksModuleOptions,
  type LocksOptionsFactory,
  type OnLeadershipAcquired,
  type OnLeadershipLost,
} from "../src/index";

describe("Decorators (@OnOneInstance, @WithoutOverlapping, @LeaderElection), LocksEvents & LocksModule.forRootAsync", () => {
  it("@OnOneInstance() runs on one instance and skips on others until failover", async () => {
    const sharedClock = new ManualLockClock();
    const sharedStore = new InMemoryLockStore({ clock: sharedClock });

    @Injectable()
    class SharedStoreRegistrar {
      constructor(storage: LocksStorage) {
        storage.registerSource(sharedStore);
      }
    }

    @Injectable()
    class ExportJob {
      runs: Array<{ token: number | undefined; aborted: boolean | undefined }> =
        [];

      constructor(private readonly ctx: LocksContext) {}

      @OnOneInstance({ key: "invoices:export", ttl: "3s" })
      async run() {
        this.runs.push({
          token: this.ctx.fencingToken,
          aborted: this.ctx.signal?.aborted,
        });
        return "exported";
      }
    }

    const createInstance = async (instanceClock: ManualLockClock) => {
      @Module({
        imports: [LocksModule.forRoot({ clock: instanceClock, ttl: "3s" })],
        providers: [SharedStoreRegistrar, ExportJob],
      })
      class AppModule {}

      const app = await BunestFactory.createApplicationContext(AppModule);
      await app.init();
      return {
        app,
        job: app.get(ExportJob),
        events: app.get(LocksEvents),
      };
    };

    const clockA = new ManualLockClock();
    const clockB = new ManualLockClock();
    const instanceA = await createInstance(clockA);
    const instanceB = await createInstance(clockB);

    const skipsB: LocksJobSkippedEvent[] = [];
    const subB = instanceB.events.jobSkips$.subscribe((e) => skipsB.push(e));

    try {
      // Instance A takes ownership and runs
      expect(await instanceA.job.run()).toBe("exported");
      expect(instanceA.job.runs.length).toBe(1);
      expect(instanceA.job.runs[0]?.token).toBe(1);
      expect(instanceA.job.runs[0]?.aborted).toBe(false);

      // Instance B skips with ownership-unavailable
      expect(await instanceB.job.run()).toBeUndefined();
      expect(instanceB.job.runs.length).toBe(0);
      expect(skipsB).toEqual([
        {
          type: "job-skipped",
          job: "ExportJob.run",
          key: "invoices:export",
          reason: "ownership-unavailable",
        },
      ]);

      // Simulate instance A crash (don't advance clockA; advance sharedClock past TTL)
      await sharedClock.advance("4s");

      // Instance B takes over ownership on next tick
      expect(await instanceB.job.run()).toBe("exported");
      expect(instanceB.job.runs.length).toBe(1);
      expect(instanceB.job.runs[0]?.token).toBeGreaterThan(1);
    } finally {
      subB.unsubscribe();
      await instanceA.app.close();
      await instanceB.app.close();
    }
  });

  it("@WithoutOverlapping() skips concurrent calls, releases on completion, and works with @OnOneInstance() in either order", async () => {
    const clock = new ManualLockClock();
    const store = new InMemoryLockStore({ clock });

    let releaseFirstRun!: () => void;
    const firstRunGate = new Promise<void>((r) => {
      releaseFirstRun = r;
    });

    @Injectable()
    class StoreInit {
      constructor(storage: LocksStorage) {
        storage.registerSource(store);
      }
    }

    @Injectable()
    class ReconcileJob {
      tokens: Array<number | undefined> = [];
      signals: Array<AbortSignal | undefined> = [];

      constructor(private readonly ctx: LocksContext) {}

      @SetMetadata("custom:meta", "preserved-above")
      @OnOneInstance({ key: "stock:reconcile" })
      @WithoutOverlapping()
      @SetMetadata("custom:below", "preserved-below")
      async reconcile() {
        this.tokens.push(this.ctx.fencingToken);
        this.signals.push(this.ctx.signal);
        if (this.tokens.length === 1) {
          await firstRunGate;
        }
        return this.tokens.length;
      }
    }

    @Module({
      imports: [LocksModule.forRoot({ clock, ttl: "3s" })],
      providers: [StoreInit, ReconcileJob],
    })
    class AppModule {}

    const app = await BunestFactory.createApplicationContext(AppModule);
    await app.init();

    const job = app.get(ReconcileJob);
    const events = app.get(LocksEvents);
    const skips: LocksJobSkippedEvent[] = [];
    const sub = events.jobSkips$.subscribe((e) => skips.push(e));

    try {
      // Metadata attached above and below decorators is preserved on wrapper
      expect(
        Reflect.getMetadata("custom:meta", ReconcileJob.prototype.reconcile),
      ).toBe("preserved-above");
      expect(
        Reflect.getMetadata("custom:below", ReconcileJob.prototype.reconcile),
      ).toBe("preserved-below");

      // Start first run (blocks on gate)
      const run1 = job.reconcile();
      await clock.advance(0);

      // Overlapping second call skips with run-lock-unavailable
      expect(await job.reconcile()).toBeUndefined();
      expect(skips).toEqual([
        {
          type: "job-skipped",
          job: "ReconcileJob.reconcile",
          key: "stock:reconcile",
          reason: "run-lock-unavailable",
        },
      ]);

      // Finish first run; its per-run signal aborts when run ends
      releaseFirstRun();
      expect(await run1).toBe(1);
      expect(job.signals[0]?.aborted).toBe(true);

      // Next run acquires fresh run lock with higher fencing token
      expect(await job.reconcile()).toBe(2);
      expect(job.tokens[1]!).toBeGreaterThan(job.tokens[0]!);
    } finally {
      sub.unsubscribe();
      await app.close();
    }
  });

  it("@LeaderElection() elects one leader, handles failover on step-down, and emits events + diagnostics_channel", async () => {
    const sharedClock = new ManualLockClock();
    const sharedStore = new InMemoryLockStore({ clock: sharedClock });

    @Injectable()
    class SharedStoreInit {
      constructor(storage: LocksStorage) {
        storage.registerSource(sharedStore);
      }
    }

    @Injectable()
    @LeaderElection("warehouse-feed", { ttl: "3s" })
    class WarehouseFeed implements OnLeadershipAcquired, OnLeadershipLost {
      acquired: Lock[] = [];
      lost: Lock[] = [];

      onLeadershipAcquired(lock: Lock) {
        this.acquired.push(lock);
      }

      onLeadershipLost(lock: Lock) {
        this.lost.push(lock);
      }
    }

    const createNode = async () => {
      const capturedEvents: LocksEvent[] = [];

      @Injectable()
      class EventRecorder {
        constructor(events: LocksEvents) {
          events.events$.subscribe((e) => capturedEvents.push(e));
        }
      }

      @Module({
        imports: [LocksModule.forRoot({ clock: sharedClock, ttl: "3s" })],
        providers: [SharedStoreInit, EventRecorder, WarehouseFeed],
      })
      class NodeModule {}

      const app = await BunestFactory.createApplicationContext(NodeModule);
      return {
        app,
        feed: app.get(WarehouseFeed),
        events: app.get(LocksEvents),
        capturedEvents,
      };
    };

    const dcAcquired: unknown[] = [];
    const dcLost: unknown[] = [];
    const onDcAcq = (msg: unknown) => dcAcquired.push(msg);
    const onDcLost = (msg: unknown) => dcLost.push(msg);
    dcSubscribe("nestjs:locks:leadership-acquired", onDcAcq);
    dcSubscribe("nestjs:locks:leadership-lost", onDcLost);

    const nodeA = await createNode();
    await sharedClock.advance(0);

    const nodeB = await createNode();
    await sharedClock.advance(0);

    try {
      // Node A leads; Node B is standby
      expect(nodeA.feed.acquired.length).toBe(1);
      expect(nodeB.feed.acquired.length).toBe(0);
      expect(dcAcquired.length).toBe(1);

      // Node A shuts down -> steps down cleanly -> emits leadership-lost (released)
      await nodeA.app.close();
      expect(nodeA.feed.lost.length).toBe(1);
      expect(nodeA.capturedEvents).toEqual([
        {
          type: "leadership-acquired",
          key: "warehouse-feed",
          fencingToken: 1,
        },
        {
          type: "leadership-lost",
          key: "warehouse-feed",
          fencingToken: 1,
          reason: "released",
        },
      ]);
      expect(dcLost.length).toBe(1);

      // Advance ttl / 3 (1s) so Node B's campaign timer fires and wins leadership
      await sharedClock.advance("1s");
      expect(nodeB.feed.acquired.length).toBe(1);
      expect(nodeB.feed.acquired[0]!.fencingToken).toBeGreaterThan(1);
      expect(nodeB.capturedEvents[0]).toEqual({
        type: "leadership-acquired",
        key: "warehouse-feed",
        fencingToken: nodeB.feed.acquired[0]!.fencingToken,
      });
    } finally {
      dcUnsubscribe("nestjs:locks:leadership-acquired", onDcAcq);
      dcUnsubscribe("nestjs:locks:leadership-lost", onDcLost);
      await nodeB.app.close();
    }
  });

  it("@LeaderElection() steps down if onLeadershipAcquired() throws or rejects", async () => {
    const clock = new ManualLockClock();
    const store = new InMemoryLockStore({ clock });

    @Injectable()
    class StoreInit {
      constructor(storage: LocksStorage) {
        storage.registerSource(store);
      }
    }

    @Injectable()
    @LeaderElection("flaky-leader", { ttl: "3s" })
    class FlakyLeader implements OnLeadershipAcquired, OnLeadershipLost {
      lostCalls = 0;
      async onLeadershipAcquired() {
        throw new Error("init failed");
      }
      onLeadershipLost() {
        this.lostCalls++;
      }
    }

    @Module({
      imports: [LocksModule.forRoot({ clock })],
      providers: [StoreInit, FlakyLeader],
    })
    class AppModule {}

    const app = await BunestFactory.createApplicationContext(AppModule);
    await app.init();
    await clock.advance(0);

    try {
      const leader = app.get(FlakyLeader);
      expect(leader.lostCalls).toBe(1);
      expect(store.peek("flaky-leader")).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("LocksEvents supports AsyncIterable (`for await`), subscriber error isolation, and completes on shutdown", async () => {
    const events = new LocksEvents();
    const receivedSub: LocksEvent[] = [];
    let completed = false;

    // A throwing subscriber must not break other subscribers or emitter
    events.events$.subscribe(() => {
      throw new Error("bad subscriber");
    });
    events.events$.subscribe({
      next: (e) => receivedSub.push(e),
      complete: () => {
        completed = true;
      },
    });

    const receivedAsync: LocksEvent[] = [];
    const consumeAsync = (async () => {
      for await (const e of events.events$) {
        receivedAsync.push(e);
      }
    })();

    const ev1: LocksEvent = {
      type: "leadership-acquired",
      key: "k1",
      fencingToken: 1,
    };
    const ev2: LocksEvent = {
      type: "lock-lost",
      key: "k1",
      fencingToken: 1,
      detectedBy: "deadline",
    };

    events.emit(ev1);
    events.emit(ev2);
    events.onApplicationShutdown();

    // Emitting after shutdown is ignored
    events.emit({
      type: "leadership-lost",
      key: "k1",
      fencingToken: 1,
      reason: "released",
    });

    await consumeAsync;
    expect(completed).toBe(true);
    expect(receivedSub).toEqual([ev1, ev2]);
    expect(receivedAsync).toEqual([ev1, ev2]);

    // Subscribing after completion calls complete() immediately
    let lateCompleted = false;
    events.events$.subscribe({
      complete: () => {
        lateCompleted = true;
      },
    });
    expect(lateCompleted).toBe(true);
  });

  it("supports LocksModule.forRootAsync with useFactory, useClass (LocksOptionsFactory), and useExisting", async () => {
    const clock = new ManualLockClock();

    // 1. useFactory
    const CONFIG_TOKEN = "LOCK_CONFIG_TTL";
    @Module({
      providers: [{ provide: CONFIG_TOKEN, useValue: "5s" }],
      exports: [CONFIG_TOKEN],
    })
    class ConfigModule {}

    @Module({
      imports: [
        LocksModule.forRootAsync({
          imports: [ConfigModule],
          inject: [CONFIG_TOKEN],
          useFactory: (ttl: `${number}s`): LocksModuleOptions => ({
            ttl,
            clock,
          }),
        }),
      ],
    })
    class FactoryAppModule {}

    const factoryApp =
      await BunestFactory.createApplicationContext(FactoryAppModule);
    await factoryApp.init();
    expect(factoryApp.get<LocksModuleOptions>(LOCKS_MODULE_OPTIONS).ttl).toBe(
      "5s",
    );
    const lock1 = await factoryApp.get(Locks).acquire("async:factory");
    expect(lock1?.held).toBe(true);
    await factoryApp.close();

    // 2. useClass (LocksOptionsFactory)
    @Injectable()
    class MyLocksConfig implements LocksOptionsFactory {
      async createLocksOptions(): Promise<LocksModuleOptions> {
        return { ttl: "4s", clock };
      }
    }

    @Module({
      imports: [LocksModule.forRootAsync({ useClass: MyLocksConfig })],
    })
    class ClassAppModule {}

    const classApp =
      await BunestFactory.createApplicationContext(ClassAppModule);
    await classApp.init();
    expect(classApp.get<LocksModuleOptions>(LOCKS_MODULE_OPTIONS).ttl).toBe(
      "4s",
    );
    await classApp.close();

    // 3. useExisting
    @Module({
      providers: [MyLocksConfig],
      exports: [MyLocksConfig],
    })
    class ExistingConfigModule {}

    @Module({
      imports: [
        LocksModule.forRootAsync({
          imports: [ExistingConfigModule],
          useExisting: MyLocksConfig,
        }),
      ],
    })
    class ExistingAppModule {}

    const existingApp =
      await BunestFactory.createApplicationContext(ExistingAppModule);
    await existingApp.init();
    expect(existingApp.get<LocksModuleOptions>(LOCKS_MODULE_OPTIONS).ttl).toBe(
      "4s",
    );
    await existingApp.close();
  });

  it("validates decorator misuse, non-singleton @LeaderElection, and key collisions", async () => {
    expect(() => LeaderElection("")).toThrow(TypeError);
    expect(() => OnOneInstance({ key: "" })).toThrow(TypeError);
    expect(() => WithoutOverlapping({ ttl: "0ms" })).toThrow(RangeError);

    // Mismatched keys between @OnOneInstance and @WithoutOverlapping
    expect(() => {
      class BadKeys {
        @OnOneInstance({ key: "a" })
        @WithoutOverlapping({ key: "b" })
        run() {}
      }
      return BadKeys;
    }).toThrow(/set different keys/);

    // Non-singleton @LeaderElection provider fails at startup
    @Injectable({ scope: Scope.REQUEST })
    @LeaderElection("req-election")
    class RequestScopedLeader implements OnLeadershipAcquired {
      onLeadershipAcquired() {}
    }

    @Module({
      imports: [LocksModule.forRoot()],
      providers: [RequestScopedLeader],
    })
    class BadLeaderModule {}

    await expect(
      BunestFactory.createApplicationContext(BadLeaderModule),
    ).rejects.toThrow(/singleton provider/);

    // Key collision between job and leader election
    @Injectable()
    class CollidingJob {
      @OnOneInstance({ key: "shared:key" })
      work() {}
    }

    @Injectable()
    @LeaderElection("shared:key")
    class CollidingLeader implements OnLeadershipAcquired {
      onLeadershipAcquired() {}
    }

    @Module({
      imports: [LocksModule.forRoot()],
      providers: [CollidingJob, CollidingLeader],
    })
    class CollisionModule {}

    await expect(
      BunestFactory.createApplicationContext(CollisionModule),
    ).rejects.toThrow(/both use the lock key/);

    // Calling a decorated method on an unregistered instance throws a clear error
    class StandaloneJob {
      @OnOneInstance()
      tick() {
        return "never";
      }
    }
    await expect(new StandaloneJob().tick()).rejects.toThrow(
      /LocksModule doesn't know this instance/,
    );
  });

  it("handles subclass job inheritance with distinct keys and shutdown handover grace", async () => {
    const clock = new ManualLockClock();
    const store = new InMemoryLockStore({ clock });

    @Injectable()
    class StoreInit {
      constructor(storage: LocksStorage) {
        storage.registerSource(store);
      }
    }

    abstract class BaseSyncJob {
      @OnOneInstance()
      async sync() {
        return this.constructor.name;
      }
    }

    @Injectable()
    class AlphaSyncJob extends BaseSyncJob {}

    @Injectable()
    class BetaSyncJob extends BaseSyncJob {}

    @Module({
      imports: [LocksModule.forRoot({ clock, ttl: "5s" })],
      providers: [StoreInit, AlphaSyncJob, BetaSyncJob],
    })
    class SubclassAppModule {}

    const app = await BunestFactory.createApplicationContext(SubclassAppModule);
    const alpha = app.get(AlphaSyncJob);
    const beta = app.get(BetaSyncJob);

    expect(await alpha.sync()).toBe("AlphaSyncJob");
    expect(await beta.sync()).toBe("BetaSyncJob");
    expect(store.peek("AlphaSyncJob.sync:owner")).toBeDefined();
    expect(store.peek("BetaSyncJob.sync:owner")).toBeDefined();

    // Closing right after start lingers the ownership lease for HANDOVER_GRACE (1000ms)
    await app.close();
    const lingering = store.peek("AlphaSyncJob.sync:owner");
    expect(lingering).toBeDefined();
    expect(lingering!.expiresAt).toBe(clock.now() + 1_000);
    await clock.advance(1_000);
    expect(store.peek("AlphaSyncJob.sync:owner")).toBeUndefined();
  });
});
