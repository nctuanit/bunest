import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import {
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  REQUEST,
  Scope,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  type OnModuleDestroy,
  type OnModuleInit,
  type OnRequestDestroy,
} from "@bunest/common";
import { ScopeLeakException } from "@bunest/core";
import { Test, request } from "../../src";

describe("E2E: Scopes (SINGLETON, REQUEST, TRANSIENT, ADR-012 ScopeLeakException) & Lifecycle Hooks", () => {
  it("enforces SINGLETON sharing, TRANSIENT uniqueness, and per-request REQUEST isolation + OnRequestDestroy cleanup", async () => {
    let singletonCount = 0;
    let transientCount = 0;
    let requestCount = 0;
    const destroyedRequestIds: number[] = [];

    @Injectable({ scope: Scope.SINGLETON })
    class SingletonCounter {
      readonly id = ++singletonCount;
    }

    @Injectable({ scope: Scope.TRANSIENT })
    class TransientHelper {
      readonly id = ++transientCount;
    }

    @Injectable({ scope: Scope.REQUEST })
    class RequestTracker implements OnRequestDestroy {
      readonly id = ++requestCount;
      constructor(
        @Inject(REQUEST) readonly req: Request,
        readonly transient: TransientHelper,
      ) {}
      onRequestDestroy() {
        destroyedRequestIds.push(this.id);
      }
    }

    @Injectable({ scope: Scope.REQUEST })
    class RequestService {
      constructor(
        readonly tracker: RequestTracker,
        readonly transient: TransientHelper,
      ) {}
    }

    @Controller("/scopes")
    @Injectable({ scope: Scope.REQUEST })
    class ScopesController {
      constructor(
        private readonly singleton: SingletonCounter,
        private readonly tracker: RequestTracker,
        private readonly svc: RequestService,
      ) {}

      @Get("info")
      info() {
        return {
          singletonId: this.singleton.id,
          requestId: this.tracker.id,
          sameRequestTracker: this.tracker === this.svc.tracker,
          distinctTransients: this.tracker.transient.id !== this.svc.transient.id,
          reqHeader: this.tracker.req.headers.get("x-req-id"),
        };
      }
    }

    const mod = await Test.createTestingModule({
      controllers: [ScopesController],
      providers: [SingletonCounter, TransientHelper, RequestTracker, RequestService],
    }).compile();

    const app = mod.createNestApplication();
    await app.init();

    try {
      const r1 = await request(app)
        .get("/scopes/info")
        .set("x-req-id", "first")
        .expect(200);
      const r2 = await request(app)
        .get("/scopes/info")
        .set("x-req-id", "second")
        .expect(200);

      expect(r1.body).toEqual({
        singletonId: 1,
        requestId: 1,
        sameRequestTracker: true,
        distinctTransients: true,
        reqHeader: "first",
      });
      expect(r2.body).toEqual({
        singletonId: 1,
        requestId: 2,
        sameRequestTracker: true,
        distinctTransients: true,
        reqHeader: "second",
      });
      expect(destroyedRequestIds).toEqual([1, 2]);
    } finally {
      await mod.close();
    }
  });

  it("throws explicit ADR-012 ScopeLeakException when a SINGLETON injects a REQUEST-scoped provider", async () => {
    @Injectable({ scope: Scope.REQUEST })
    class RequestOnlyProvider {}

    @Injectable({ scope: Scope.SINGLETON })
    class LeakySingleton {
      constructor(readonly _reqOnly: RequestOnlyProvider) {}
    }

    await expect(
      Test.createTestingModule({
        providers: [RequestOnlyProvider, LeakySingleton],
      }).compile(),
    ).rejects.toThrow(ScopeLeakException);
  });

  it("executes all 5 lifecycle hooks in deterministic topological / reverse-topological order", async () => {
    const events: string[] = [];

    @Injectable()
    class ChildLifecycle
      implements
        OnModuleInit,
        OnApplicationBootstrap,
        OnModuleDestroy,
        BeforeApplicationShutdown,
        OnApplicationShutdown
    {
      onModuleInit() {
        events.push("child:onModuleInit");
      }
      onApplicationBootstrap() {
        events.push("child:onApplicationBootstrap");
      }
      onModuleDestroy() {
        events.push("child:onModuleDestroy");
      }
      beforeApplicationShutdown(signal?: string) {
        events.push(`child:beforeApplicationShutdown:${signal ?? "none"}`);
      }
      onApplicationShutdown(signal?: string) {
        events.push(`child:onApplicationShutdown:${signal ?? "none"}`);
      }
    }

    @Module({
      providers: [ChildLifecycle],
      exports: [ChildLifecycle],
    })
    class ChildModule {}

    @Injectable()
    class ParentLifecycle
      implements
        OnModuleInit,
        OnApplicationBootstrap,
        OnModuleDestroy,
        BeforeApplicationShutdown,
        OnApplicationShutdown
    {
      constructor(readonly _child: ChildLifecycle) {}
      onModuleInit() {
        events.push("parent:onModuleInit");
      }
      onApplicationBootstrap() {
        events.push("parent:onApplicationBootstrap");
      }
      onModuleDestroy() {
        events.push("parent:onModuleDestroy");
      }
      beforeApplicationShutdown(signal?: string) {
        events.push(`parent:beforeApplicationShutdown:${signal ?? "none"}`);
      }
      onApplicationShutdown(signal?: string) {
        events.push(`parent:onApplicationShutdown:${signal ?? "none"}`);
      }
    }

    @Module({
      imports: [ChildModule],
      providers: [ParentLifecycle],
    })
    class ParentModule {}

    const mod = await Test.createTestingModule({
      imports: [ParentModule],
    }).compile();

    const app = mod.createNestApplication();
    await app.init();

    expect(events).toEqual([
      "child:onModuleInit",
      "parent:onModuleInit",
      "child:onApplicationBootstrap",
      "parent:onApplicationBootstrap",
    ]);

    await mod.close("SIGINT");

    expect(events).toEqual([
      "child:onModuleInit",
      "parent:onModuleInit",
      "child:onApplicationBootstrap",
      "parent:onApplicationBootstrap",
      "parent:onModuleDestroy",
      "child:onModuleDestroy",
      "parent:beforeApplicationShutdown:SIGINT",
      "child:beforeApplicationShutdown:SIGINT",
      "parent:onApplicationShutdown:SIGINT",
      "child:onApplicationShutdown:SIGINT",
    ]);
  });

  it("keeps init() and close() strictly idempotent across TestingModule + BunestApplication + fetch() (no double-fire)", async () => {
    const events: string[] = [];

    @Injectable()
    class Tracker
      implements
        OnModuleInit,
        OnApplicationBootstrap,
        OnModuleDestroy,
        BeforeApplicationShutdown,
        OnApplicationShutdown
    {
      onModuleInit() {
        events.push("init");
      }
      onApplicationBootstrap() {
        events.push("bootstrap");
      }
      onModuleDestroy() {
        events.push("destroy");
      }
      beforeApplicationShutdown() {
        events.push("beforeShutdown");
      }
      onApplicationShutdown() {
        events.push("shutdown");
      }
    }

    @Controller("/idem")
    class IdemController {
      constructor(readonly _t: Tracker) {}
      @Get()
      ok() {
        return { ok: true };
      }
    }

    const mod = await Test.createTestingModule({
      controllers: [IdemController],
      providers: [Tracker],
    }).compile();

    const app1 = mod.createNestApplication();
    const app2 = mod.createNestApplication();

    // Call init on mod, app1, app2, AND dispatch HTTP via fetch()
    await mod.init();
    await app1.init();
    await app2.init();
    await request(app1).get("/idem").expect(200, { ok: true });
    await request(app2).get("/idem").expect(200, { ok: true });

    expect(events).toEqual(["init", "bootstrap"]);

    // Close app1, app2, and mod — shutdown hooks still fire exactly once
    await app1.close();
    await app2.close();
    await mod.close();

    expect(events).toEqual([
      "init",
      "bootstrap",
      "destroy",
      "beforeShutdown",
      "shutdown",
    ]);
  });

  it("cleans up process signal listeners registered by enableShutdownHooks() on mod.close() without leaking", async () => {
    const baseSigterm = process.listenerCount("SIGTERM");
    const baseSigint = process.listenerCount("SIGINT");

    const mod = await Test.createTestingModule({}).compile();
    mod.enableShutdownHooks(["SIGTERM", "SIGINT"]);
    // Creating an app from the same TestingModule shares LifecycleManager
    const app = mod.createNestApplication();
    await app.init();

    expect(process.listenerCount("SIGTERM")).toBe(baseSigterm + 1);
    expect(process.listenerCount("SIGINT")).toBe(baseSigint + 1);

    await mod.close();

    expect(process.listenerCount("SIGTERM")).toBe(baseSigterm);
    expect(process.listenerCount("SIGINT")).toBe(baseSigint);
  });

  it("stops every listening HTTP server on shared LifecycleManager regardless of close order (zero leaked servers)", async () => {
    const shutdowns: string[] = [];

    @Injectable()
    class ShutdownOnce implements OnModuleDestroy, OnApplicationShutdown {
      onModuleDestroy() {
        shutdowns.push("destroy");
      }
      onApplicationShutdown() {
        shutdowns.push("shutdown");
      }
    }

    @Controller("/multi-srv")
    class MultiSrvController {
      @Get()
      ok() {
        return { ok: true };
      }
    }

    // Order 1: close sibling app2 first, then mod.close()
    const mod1 = await Test.createTestingModule({
      controllers: [MultiSrvController],
      providers: [ShutdownOnce],
    }).compile();

    const a1 = mod1.createNestApplication();
    const a2 = mod1.createNestApplication();
    await a1.listen(0);
    await a2.listen(0);
    expect(a1.getHttpServer()).toBeDefined();
    expect(a2.getHttpServer()).toBeDefined();

    await a2.close();
    expect(a2.getHttpServer()).toBeUndefined();
    await mod1.close();
    expect(a1.getHttpServer()).toBeUndefined();
    expect(shutdowns).toEqual(["destroy", "shutdown"]);

    // Order 2: close app1 then app2 sequentially
    shutdowns.length = 0;
    const mod2 = await Test.createTestingModule({
      controllers: [MultiSrvController],
      providers: [ShutdownOnce],
    }).compile();

    const b1 = mod2.createNestApplication();
    const b2 = mod2.createNestApplication();
    await b1.listen(0);
    await b2.listen(0);
    await b1.close();
    await b2.close();
    expect(b1.getHttpServer()).toBeUndefined();
    expect(b2.getHttpServer()).toBeUndefined();
    expect(shutdowns).toEqual(["destroy", "shutdown"]);
    await mod2.close();
  });
});
