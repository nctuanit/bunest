import { Injectable, Module } from "@bunest/core";
import { BunestFactory } from "@bunest/core";
import { afterEach, describe, expect, it } from "bun:test";
import {
  InMemoryLockStore,
  LockLostError,
  LockNotAcquiredError,
  LockStoreTimeoutError,
  Locks,
  LocksContext,
  LocksError,
  LocksEvents,
  LocksModule,
  LocksStorage,
  ManualLockClock,
  type LockAcquireResult,
  type LockStore,
  type LocksEvent,
} from "../../src/locks/index";

describe("Locks core service, leases, renewals, context & storage", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  async function createApp(options?: {
    clock?: ManualLockClock;
    store?: LockStore;
    ttl?: number | `${number}ms` | `${number}s`;
    storeTimeout?: number | `${number}ms` | `${number}s`;
    allowInMemoryStorage?: boolean;
  }) {
    const clock = options?.clock ?? new ManualLockClock();
    const store = options?.store ?? new InMemoryLockStore({ clock });

    @Injectable()
    class StoreRegistrar {
      constructor(storage: LocksStorage) {
        storage.registerSource(store);
      }
    }

    @Module({
      imports: [
        LocksModule.forRoot({
          clock,
          ttl: options?.ttl ?? "3s",
          storeTimeout: options?.storeTimeout ?? "5s",
          allowInMemoryStorage: options?.allowInMemoryStorage,
        }),
      ],
      providers: [StoreRegistrar],
    })
    class TestAppModule {}

    const app = await BunestFactory.createApplicationContext(TestAppModule);
    await app.init();
    return {
      app,
      clock,
      store,
      locks: app.get(Locks),
      context: app.get(LocksContext),
      events: app.get(LocksEvents),
      storage: app.get(LocksStorage),
    };
  }

  it("acquires, holds, renews automatically every ttl/3, and releases locks", async () => {
    const clock = new ManualLockClock();
    const store = new InMemoryLockStore({ clock });
    const { app, locks } = await createApp({ clock, store, ttl: "3s" });

    try {
      const lock = await locks.acquire("orders:sync");
      expect(lock).not.toBeNull();
      expect(lock!.key).toBe("orders:sync");
      expect(lock!.fencingToken).toBe(1);
      expect(lock!.held).toBe(true);
      expect(lock!.signal.aborted).toBe(false);
      expect(clock.pendingTimers).toBe(1);

      // Contention returns null without wait
      expect(await locks.acquire("orders:sync")).toBeNull();

      // Advance well beyond initial 3s TTL; renewals every 1s keep the lock alive
      await clock.advance("10s");
      expect(lock!.held).toBe(true);
      expect(lock!.signal.aborted).toBe(false);
      expect(store.peek("orders:sync")?.owner).toBe(lock!.owner);

      // Release frees the lock and stops all renewal timers
      const released = await lock!.release();
      expect(released).toBe(true);
      expect(lock!.held).toBe(false);
      expect(lock!.signal.aborted).toBe(true);
      expect((lock!.signal.reason as DOMException).name).toBe("AbortError");
      expect(clock.pendingTimers).toBe(0);

      // Subsequent release is idempotent and returns false
      expect(await lock!.release()).toBe(false);

      // Next acquisition gets a strictly higher fencing token
      const lock2 = await locks.acquire("orders:sync");
      expect(lock2).not.toBeNull();
      expect(lock2!.fencingToken).toBeGreaterThan(lock!.fencingToken);
      await lock2!.release();
    } finally {
      await app.close();
    }
  });

  it("supports Symbol.asyncDispose (`await using`) on Lock", async () => {
    const clock = new ManualLockClock();
    const store = new InMemoryLockStore({ clock });
    const { app, locks } = await createApp({ clock, store });

    try {
      let capturedOwner = "";
      {
        await using lock = (await locks.acquire("disposable:key"))!;
        expect(lock.held).toBe(true);
        capturedOwner = lock.owner;
        expect(store.peek("disposable:key")?.owner).toBe(capturedOwner);
      }
      expect(store.peek("disposable:key")).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("withLock() provides LocksContext, returns value, releases on error, and throws LockNotAcquiredError", async () => {
    const clock = new ManualLockClock();
    const store = new InMemoryLockStore({ clock });
    const { app, locks, context } = await createApp({ clock, store });

    try {
      expect(context.lock).toBeUndefined();
      expect(context.fencingToken).toBeUndefined();
      expect(context.signal).toBeUndefined();

      const value = await locks.withLock("billing:run", async (lock) => {
        expect(context.lock).toBe(lock);
        expect(context.fencingToken).toBe(lock.fencingToken);
        expect(context.signal).toBe(lock.signal);
        return "ok";
      });
      expect(value).toBe("ok");
      expect(context.lock).toBeUndefined();
      expect(store.peek("billing:run")).toBeUndefined();

      // Releases even when callback throws
      await expect(
        locks.withLock("billing:fail", async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(store.peek("billing:fail")).toBeUndefined();

      // Throws LockNotAcquiredError when already held
      const holder = (await locks.acquire("billing:busy"))!;
      let caught: unknown;
      try {
        await locks.withLock("billing:busy", () => "never");
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(LockNotAcquiredError);
      expect(caught).toBeInstanceOf(LocksError);
      const err = caught as LockNotAcquiredError;
      expect(err.key).toBe("billing:busy");
      expect(err.waitMs).toBe(0);
      expect(err.reason).toBe("taken");
      await holder.release();
    } finally {
      await app.close();
    }
  });

  it("LocksContext.run() propagates lock, fencingToken, and signal through async calls", async () => {
    const { app, locks, context } = await createApp();
    try {
      const lock = (await locks.acquire("ctx:manual"))!;
      const observed = await context.run(lock, async () => {
        await Promise.resolve();
        return {
          lock: context.lock,
          token: context.fencingToken,
          signal: context.signal,
        };
      });
      expect(observed.lock).toBe(lock);
      expect(observed.token).toBe(lock.fencingToken);
      expect(observed.signal).toBe(lock.signal);
      expect(context.lock).toBeUndefined();
      await lock.release();
    } finally {
      await app.close();
    }
  });

  it("acquire() waits with backoff and wakes immediately on local release or aborts on signal", async () => {
    const clock = new ManualLockClock();
    const store = new InMemoryLockStore({ clock });
    const { app, locks } = await createApp({ clock, store });

    try {
      const first = (await locks.acquire("wait:key"))!;

      // Start waiting up to 2s
      const waitingPromise = locks.acquire("wait:key", { wait: "2s" });
      await clock.advance(10);

      // Releasing locally wakes waiter immediately
      await first.release();
      const second = await waitingPromise;
      expect(second).not.toBeNull();
      expect(second!.fencingToken).toBeGreaterThan(first.fencingToken);

      // Abort signal cancels waiting
      const ac = new AbortController();
      const abortedPromise = locks.acquire("wait:key", {
        wait: "2s",
        signal: ac.signal,
      });
      await clock.advance(10);
      const abortReason = new Error("caller cancelled");
      ac.abort(abortReason);
      await expect(abortedPromise).rejects.toBe(abortReason);

      await second!.release();
    } finally {
      await app.close();
    }
  });

  it("detects lock loss by renewal refusal and emits LocksLockLostEvent", async () => {
    const storeClock = new ManualLockClock();
    const appClock = new ManualLockClock();
    const store = new InMemoryLockStore({ clock: storeClock });
    const { app, locks, events } = await createApp({
      clock: appClock,
      store,
      ttl: "3s",
    });

    const received: LocksEvent[] = [];
    const sub = events.events$.subscribe((e) => received.push(e));

    try {
      const lock = (await locks.acquire("lost:renewal"))!;

      // Simulate paused process: store's clock advances past TTL while app's hasn't
      await storeClock.advance("4s");
      // Another instance takes the key in the store
      await store.acquire("lost:renewal", "other-instance", 3_000);

      // Now app's renewal timer fires at 1s -> store refuses renew()
      await appClock.advance("1s");
      expect(lock.held).toBe(false);
      expect(lock.signal.aborted).toBe(true);
      expect(lock.signal.reason).toBeInstanceOf(LockLostError);
      const reason = lock.signal.reason as LockLostError;
      expect(reason.key).toBe("lost:renewal");
      expect(reason.fencingToken).toBe(lock.fencingToken);
      expect(reason.detectedBy).toBe("renewal");

      expect(received).toEqual([
        {
          type: "lock-lost",
          key: "lost:renewal",
          fencingToken: lock.fencingToken,
          detectedBy: "renewal",
        },
      ]);
    } finally {
      sub.unsubscribe();
      await app.close();
    }
  });

  it("detects lock loss by deadline when store renewals fail or stall", async () => {
    const clock = new ManualLockClock();
    const inner = new InMemoryLockStore({ clock });
    let failRenew = false;
    const flakyStore: LockStore = {
      acquire: (k, o, t) => inner.acquire(k, o, t),
      renew: async (k, o, t) => {
        if (failRenew) {
          throw new Error("store unreachable");
        }
        return inner.renew(k, o, t);
      },
      release: (k, o) => inner.release(k, o),
    };

    const { app, locks, events } = await createApp({
      clock,
      store: flakyStore,
      ttl: "3s",
    });

    const received: LocksEvent[] = [];
    const sub = events.events$.subscribe((e) => received.push(e));

    try {
      const lock = (await locks.acquire("lost:deadline"))!;
      failRenew = true;

      // Advance through all renewal attempts up to deadline (3s)
      await clock.advance("3s");
      expect(lock.held).toBe(false);
      expect(lock.signal.aborted).toBe(true);
      expect(lock.signal.reason).toBeInstanceOf(LockLostError);
      const reason = lock.signal.reason as LockLostError;
      expect(reason.detectedBy).toBe("deadline");
      expect(received).toEqual([
        {
          type: "lock-lost",
          key: "lost:deadline",
          fencingToken: lock.fencingToken,
          detectedBy: "deadline",
        },
      ]);
    } finally {
      sub.unsubscribe();
      await app.close();
    }
  });

  it("times out hung store calls with LockStoreTimeoutError and gives back late grants", async () => {
    const clock = new ManualLockClock();
    let resolveAcquire!: (res: LockAcquireResult) => void;
    const releasedOwners: string[] = [];

    const slowStore: LockStore = {
      acquire: () =>
        new Promise<LockAcquireResult>((r) => {
          resolveAcquire = r;
        }),
      renew: async () => true,
      release: async (_k, owner) => {
        releasedOwners.push(owner);
        return true;
      },
    };

    const { app, locks } = await createApp({
      clock,
      store: slowStore,
      storeTimeout: "500ms",
    });

    try {
      const acquirePromise = locks.acquire("slow:key");
      const caughtPromise = acquirePromise.catch((e: unknown) => e);
      await clock.advance("500ms");
      const err = await caughtPromise;
      expect(err).toBeInstanceOf(LockStoreTimeoutError);
      const timeoutErr = err as LockStoreTimeoutError;
      expect(timeoutErr.key).toBe("slow:key");
      expect(timeoutErr.method).toBe("acquire");
      expect(timeoutErr.timeoutMs).toBe(500);

      // Late grant after timeout must be automatically returned to the store
      resolveAcquire({ acquired: true, fencingToken: 42 });
      await clock.advance(0);
      expect(releasedOwners.length).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("rejects non-integer / string fencing tokens and gives lock back", async () => {
    const clock = new ManualLockClock();
    const released: string[] = [];
    const buggyStore: LockStore = {
      acquire: async () => ({
        acquired: true,
        fencingToken: "1" as unknown as number,
      }),
      renew: async () => true,
      release: async (k) => {
        released.push(k);
        return true;
      },
    };

    const { app, locks } = await createApp({ clock, store: buggyStore });
    try {
      await expect(locks.acquire("pg:bigint")).rejects.toThrow(
        /positive safe integer.*PostgreSQL/,
      );
      expect(released).toEqual(["pg:bigint"]);
    } finally {
      await app.close();
    }
  });

  it("enforces LocksStorage validation, replace option, late registration guard, and production guard", async () => {
    const storage = new LocksStorage();
    expect(() => storage.registerSource(null as unknown as LockStore)).toThrow(
      TypeError,
    );
    expect(() =>
      storage.registerSource({
        acquire: async () => ({ acquired: false }),
      } as unknown as LockStore),
    ).toThrow(/renew\(\), release\(\) are missing/);

    const store1 = new InMemoryLockStore();
    const store2 = new InMemoryLockStore();
    storage.registerSource(store1);
    expect(() => storage.registerSource(store2)).toThrow(/already did/);
    storage.registerSource(store2, { replace: true });
    expect(storage.source).toBe(store2);

    // Locked once read
    expect(() => storage.registerSource(store1, { replace: true })).toThrow(
      /after LocksModule initialized/,
    );

    // Production guard fails without registered store unless allowInMemoryStorage: true
    process.env.NODE_ENV = "production";
    @Module({ imports: [LocksModule.forRoot()] })
    class ProdFailModule {}
    await expect(
      BunestFactory.createApplicationContext(ProdFailModule),
    ).rejects.toThrow(/NODE_ENV is "production"/);

    @Module({
      imports: [LocksModule.forRoot({ allowInMemoryStorage: true })],
    })
    class ProdAllowedModule {}
    const okApp =
      await BunestFactory.createApplicationContext(ProdAllowedModule);
    expect(okApp.get(LocksStorage).source).toBeInstanceOf(InMemoryLockStore);
    await okApp.close();
  });

  it("rejects leftover `store` option in forRoot / forRootAsync", () => {
    expect(() =>
      LocksModule.forRoot({
        store: new InMemoryLockStore(),
      } as unknown as Record<string, unknown>),
    ).toThrow(/`store` is not an option/);

    expect(() =>
      LocksModule.forRootAsync({
        store: new InMemoryLockStore(),
        useFactory: () => ({}),
      } as unknown as Parameters<typeof LocksModule.forRootAsync>[0]),
    ).toThrow(/`store` is not an option/);
  });

  it("releases held locks on beforeApplicationShutdown and rejects new withLock() with reason shutdown", async () => {
    const clock = new ManualLockClock();
    const store = new InMemoryLockStore({ clock });
    const { app, locks } = await createApp({ clock, store });

    const lock = (await locks.acquire("shutdown:held"))!;
    expect(store.peek("shutdown:held")).toBeDefined();

    await app.close();
    expect(lock.held).toBe(false);
    expect(lock.signal.aborted).toBe(true);
    expect(store.peek("shutdown:held")).toBeUndefined();

    expect(await locks.acquire("shutdown:new")).toBeNull();
    let caught: unknown;
    try {
      await locks.withLock("shutdown:new", () => "nope");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LockNotAcquiredError);
    expect((caught as LockNotAcquiredError).reason).toBe("shutdown");
  });
});
