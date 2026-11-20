import "reflect-metadata";
import { afterAll, beforeAll, expect, it } from "bun:test";
import {
  Controller,
  Get,
  Inject,
  Module,
} from "../../../../../packages/common/src";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  CACHE_MANAGER,
  Cache,
  CacheModule,
  MemoryCacheStore,
} from "../../../../../packages/cache/src";
import {
  Test,
  describeConformance,
} from "../../../_helpers/index";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

class TrackedMemoryStore extends MemoryCacheStore {
  public closed = false;
  public onDisconnect?: () => Promise<void> | void;

  override async close(): Promise<void> {
    this.closed = true;
    await super.close();
    await this.onDisconnect?.();
  }
}

describeConformance(
  "CacheModule - Caching on shutdown",
  {
    upstreamPath: "cache-manager/tests/e2e/shutdown.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts upstream @keyv/redis shutdown ordering test to a native tracked MemoryCacheStore and live ephemeral Bun HTTP server.",
  },
  () => {
    let app: BunestApplication;
    let store: TrackedMemoryStore;
    let gate: {
      started: ReturnType<typeof deferred>;
      release: ReturnType<typeof deferred>;
    };

    beforeAll(async () => {
      store = new TrackedMemoryStore();
      gate = { started: deferred(), release: deferred() };

      @Controller()
      class ShutdownController {
        constructor(
          @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
        ) {}

        @Get("slow")
        async slow(): Promise<unknown> {
          gate.started.resolve();
          await gate.release.promise;
          if (store.closed) {
            throw new Error("Store was disconnected while request was in flight");
          }
          await this.cacheManager.set("shutdown-key", "shutdown-value");
          return this.cacheManager.get("shutdown-key");
        }
      }

      @Module({
        imports: [
          CacheModule.register({
            stores: [store],
          }),
        ],
        controllers: [ShutdownController],
      })
      class ShutdownModule {}

      const moduleRef = await Test.createTestingModule({
        imports: [ShutdownModule],
      }).compile({ logger: false });

      app = moduleRef.createNestApplication({ logger: false });
      await app.listen(0);
    });

    // BUNEST_BUG: BunHttpAdapter defaults forceCloseConnections to true (packages/http/src/adapter/bun-http.adapter.ts:509,2215), so app.close() invokes server.stop(true) and forcibly aborts in-flight HTTP requests with ECONNRESET instead of draining them before CacheService disconnects the store; additionally CacheService disconnects in onModuleDestroy() rather than onApplicationShutdown() (packages/cache/src/cache.service.ts:587).
    it.skip("should disconnect the store only after the requests in flight", async () => {
      const cacheManager = app.get<Cache>(CACHE_MANAGER);
      await cacheManager.del("shutdown-key");

      store.onDisconnect = () => {
        gate.release.resolve();
      };
      const safetyTimer = setTimeout(() => gate.release.resolve(), 300);
      safetyTimer.unref?.();

      const rawUrl = await app.getUrl();
      if (!rawUrl) {
        throw new Error("Expected listening URL");
      }
      const baseUrl = rawUrl.replace(/\/$/, "");
      const responsePromise = fetch(`${baseUrl}/slow`);
      await gate.started.promise;
      await app.close();
      clearTimeout(safetyTimer);

      const res = await responsePromise;
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("shutdown-value");
      expect(store.closed).toBe(true);
    });

    afterAll(async () => {
      await app.close();
    });
  },
);
