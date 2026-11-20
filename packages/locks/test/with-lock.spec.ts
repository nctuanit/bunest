import "reflect-metadata";
import { describe, expect, test } from "bun:test";
import { Controller, Get, Injectable, Module, Param, Scope } from "@bunest/common";
import { BunestFactory } from "@bunest/core";
import {
  InMemoryLockStore,
  LockNotAcquiredError,
  LocksContext,
  LocksModule,
  LocksStorage,
  WithLock,
} from "../src";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("@bunest/locks @WithLock Method Aspect Decorator", () => {
  test("serializes same dynamic key with waitTimeout, rejects immediately without waitTimeout, runs distinct keys in parallel, exposes LocksContext, and releases on throw", async () => {
    let activeSameKey = 0;
    let maxSameKey = 0;
    let activeParallel = 0;
    let maxParallel = 0;
    const events: string[] = [];

    @Injectable()
    class InventoryService {
      constructor(private readonly lockCtx: LocksContext) {}

      @WithLock((sku: string) => `inventory:${sku}`, {
        ttl: 5_000,
        waitTimeout: 1_000,
      })
      async reserveSerialized(
        sku: string,
        caller: string,
      ): Promise<{ sku: string; caller: string; fencingToken?: number }> {
        activeSameKey += 1;
        maxSameKey = Math.max(maxSameKey, activeSameKey);
        events.push(`start:${caller}`);
        const token = this.lockCtx.fencingToken;
        await delay(25);
        events.push(`end:${caller}`);
        activeSameKey -= 1;
        return { sku, caller, fencingToken: token };
      }

      @WithLock((sku: string) => `fast:${sku}`, { ttl: 5_000 })
      async reserveNoWait(sku: string): Promise<string> {
        await delay(40);
        return `locked:${sku}`;
      }

      @WithLock((sku: string) => `parallel:${sku}`, { ttl: 5_000 })
      async workBySku(sku: string): Promise<string> {
        activeParallel += 1;
        maxParallel = Math.max(maxParallel, activeParallel);
        await delay(30);
        activeParallel -= 1;
        return sku;
      }

      @WithLock("failing-lock", { ttl: 5_000 })
      async failUnderLock(shouldFail: boolean): Promise<string> {
        if (shouldFail) {
          throw new Error("work failed");
        }
        return "recovered";
      }
    }

    @Module({
      imports: [LocksModule.forRoot({ allowInMemoryStorage: true })],
      providers: [InventoryService],
    })
    class AppModule {}

    const ctx = await BunestFactory.createApplicationContext(AppModule, {
      logger: false,
    });

    try {
      const svc = ctx.get(InventoryService);

      // 1. Same dynamic key with waitTimeout serializes cleanly (maxSameKey === 1)
      const [r1, r2] = await Promise.all([
        svc.reserveSerialized("SKU-1", "A"),
        svc.reserveSerialized("SKU-1", "B"),
      ]);
      expect(maxSameKey).toBe(1);
      expect(r1.fencingToken).toBeGreaterThanOrEqual(1);
      expect(r2.fencingToken).toBeGreaterThan(r1.fencingToken!);
      expect(events).toEqual(["start:A", "end:A", "start:B", "end:B"]);

      // 2. Same dynamic key without waitTimeout fails immediately with LockNotAcquiredError
      const holdPromise = svc.reserveNoWait("SKU-2");
      await delay(5);
      await expect(svc.reserveNoWait("SKU-2")).rejects.toBeInstanceOf(
        LockNotAcquiredError,
      );
      expect(await holdPromise).toBe("locked:SKU-2");

      // 3. Different dynamic keys execute in parallel (maxParallel === 2)
      const [p1, p2] = await Promise.all([
        svc.workBySku("ITEM-A"),
        svc.workBySku("ITEM-B"),
      ]);
      expect([p1, p2]).toEqual(["ITEM-A", "ITEM-B"]);
      expect(maxParallel).toBe(2);

      // 4. Lock is ALWAYS released when method throws, so next call succeeds immediately
      await expect(svc.failUnderLock(true)).rejects.toThrow("work failed");
      expect(await svc.failUnderLock(false)).toBe("recovered");
    } finally {
      await ctx.close();
    }
  });

  test("works across TRANSIENT and REQUEST scopes and supports named stores via options.store", async () => {
    const customStore = new InMemoryLockStore();
    let customStoreAcquires = 0;
    const origAcquire = customStore.acquire.bind(customStore);
    customStore.acquire = async (key, owner, ttl) => {
      customStoreAcquires += 1;
      return origAcquire(key, owner, ttl);
    };

    @Injectable()
    class NamedStoreRegistrar {
      constructor(storage: LocksStorage) {
        storage.registerNamedSource("billing", customStore);
      }
    }

    @Injectable({ scope: Scope.TRANSIENT })
    class TransientLockService {
      @WithLock((id: string) => `invoice:${id}`, {
        store: "billing",
        waitTimeout: 500,
      })
      async processInvoice(id: string): Promise<string> {
        await delay(15);
        return `paid:${id}`;
      }
    }

    @Injectable({ scope: Scope.REQUEST })
    class RequestLockService {
      @WithLock((id: string) => `req-job:${id}`, {
        store: "prefixed-ns",
        waitTimeout: 500,
      })
      async runForRequest(id: string): Promise<string> {
        await delay(15);
        return `req-ok:${id}`;
      }
    }

    @Controller({ path: "locks-test", scope: Scope.REQUEST })
    class LocksTestController {
      constructor(private readonly reqSvc: RequestLockService) {}

      @Get(":id")
      async run(@Param("id") id: string) {
        return { result: await this.reqSvc.runForRequest(id) };
      }
    }

    @Module({
      imports: [LocksModule.forRoot({ allowInMemoryStorage: true })],
      controllers: [LocksTestController],
      providers: [NamedStoreRegistrar, TransientLockService, RequestLockService],
    })
    class ScopedAppModule {}

    const app = await BunestFactory.create(ScopedAppModule, { logger: false });
    await app.init();

    try {
      // TRANSIENT scope with named store ("billing")
      const t1 = await app.resolve(TransientLockService);
      const t2 = await app.resolve(TransientLockService);
      expect(t1).not.toBe(t2);
      const [inv1, inv2] = await Promise.all([
        t1.processInvoice("inv-42"),
        t2.processInvoice("inv-42"),
      ]);
      expect([inv1, inv2]).toEqual(["paid:inv-42", "paid:inv-42"]);
      expect(customStoreAcquires).toBeGreaterThanOrEqual(2);

      // REQUEST scope over concurrent HTTP requests with key-prefixed store fallback
      const [res1, res2] = await Promise.all([
        app.inject({ method: "GET", url: "/locks-test/42" }),
        app.inject({ method: "GET", url: "/locks-test/42" }),
      ]);
      expect(res1.statusCode).toBe(200);
      expect(res2.statusCode).toBe(200);
      expect(res1.json()).toEqual({ result: "req-ok:42" });
      expect(res2.json()).toEqual({ result: "req-ok:42" });
    } finally {
      await app.close();
    }
  });
});
