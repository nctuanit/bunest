import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import {
  APP_GUARD,
  Controller,
  Inject,
  Injectable,
  Module,
  Optional,
  REQUEST,
  REQUEST_CONTEXT,
  Reflector,
  Scope,
  forwardRef,
  type OnRequestDestroy,
  type ResponseContext,
} from "@bunest/common";
import {
  CircularDependencyException,
  DIContainer,
  ModuleRef,
  ModuleScanner,
  ScopeLeakException,
  UnknownDependencyException,
} from "../src";

function makeFakeResponseContext(): ResponseContext {
  const headers = new Headers();
  let statusCode: number | undefined;
  return {
    status(c) {
      statusCode = c;
      return this;
    },
    getStatus: () => statusCode,
    header(k, v) {
      headers.set(k, v);
      return this;
    },
    appendHeader(k, v) {
      headers.append(k, v);
      return this;
    },
    removeHeader(k) {
      headers.delete(k);
      return this;
    },
    getHeaders: () => headers,
    cookie() {
      return this;
    },
    clearCookie() {
      return this;
    },
  };
}

describe("DIContainer, Scopes, forwardRef, ScopeLeakException & ModuleRef", () => {
  it("resolves useClass, useValue, async useFactory (+ optional inject), useExisting, property @Inject, ModuleRef, and Reflector", async () => {
    const CONFIG = Symbol("CONFIG");
    const ASYNC_VAL = Symbol("ASYNC_VAL");
    const MISSING_OPT = Symbol("MISSING_OPT");
    const ALIAS = Symbol("ALIAS");
    const PROP_TOK = Symbol("PROP_TOK");

    @Injectable()
    class RepoService {
      readonly tag = "real-repo";
    }

    @Injectable()
    class MainService {
      @Inject(PROP_TOK)
      propInjected!: string;

      @Optional()
      @Inject(MISSING_OPT)
      optionalProp?: string;

      constructor(
        public readonly repo: RepoService,
        @Inject(CONFIG) public readonly cfg: { env: string },
        @Inject(ASYNC_VAL) public readonly asyncVal: string,
        @Inject(ALIAS) public readonly aliasedRepo: RepoService,
        @Optional() @Inject(MISSING_OPT) public readonly missing?: string,
        public readonly moduleRef?: ModuleRef,
        public readonly reflector?: Reflector,
      ) {}
    }

    @Module({
      providers: [
        RepoService,
        { provide: CONFIG, useValue: { env: "test" } },
        { provide: PROP_TOK, useValue: "prop-ok" },
        {
          provide: ASYNC_VAL,
          inject: [CONFIG, { token: MISSING_OPT, optional: true }],
          useFactory: async (cfg: { env: string }, missing?: string) => {
            await Promise.resolve();
            return `${cfg.env}:${String(missing)}`;
          },
        },
        { provide: ALIAS, useExisting: RepoService },
        { provide: APP_GUARD, useValue: { id: "g1" } },
        { provide: APP_GUARD, useValue: { id: "g2" } },
        MainService,
      ],
    })
    class AppModule {}

    const graph = await new ModuleScanner().scan(AppModule);
    const container = new DIContainer(graph);
    await container.initialize();

    const ref = container.getModuleRef(graph.root.id);
    const main = ref.get(MainService);

    expect(main.repo).toBeInstanceOf(RepoService);
    expect(main.aliasedRepo).toBe(main.repo);
    expect(main.cfg).toEqual({ env: "test" });
    expect(main.asyncVal).toBe("test:undefined");
    expect(main.missing).toBeUndefined();
    expect(main.propInjected).toBe("prop-ok");
    expect(main.optionalProp).toBeUndefined();
    expect(main.moduleRef).toBeInstanceOf(ModuleRef);
    expect(main.reflector).toBeInstanceOf(Reflector);

    // Multi-provider APP_GUARD accumulates both registrations
    expect(
      container.getMultiProviderEntries(APP_GUARD).map((e) => e.instance),
    ).toEqual([{ id: "g1" }, { id: "g2" }]);

    // ModuleRef.create instantiates unregistered classes with full DI
    @Injectable()
    class AdHoc {
      constructor(public readonly repo: RepoService) {}
    }
    const adHoc = await ref.create(AdHoc);
    expect(adHoc.repo).toBe(main.repo);
  });

  it("detects unwrapped circular provider dependencies and resolves forwardRef singleton cycles", async () => {
    const TOK_A = Symbol("TOK_A");
    const TOK_B = Symbol("TOK_B");

    // Unwrapped cycle fails fast with full chain
    @Injectable()
    class BadA {
      constructor(@Inject(TOK_B) public b: unknown) {}
    }
    @Injectable()
    class BadB {
      constructor(@Inject(TOK_A) public a: unknown) {}
    }
    @Module({
      providers: [
        { provide: TOK_A, useClass: BadA },
        { provide: TOK_B, useClass: BadB },
      ],
    })
    class BadCycleMod {}

    const badGraph = await new ModuleScanner().scan(BadCycleMod);
    await expect(new DIContainer(badGraph).initialize()).rejects.toThrow(
      CircularDependencyException,
    );

    // Factory cycle even with forwardRef fails fast per ADR-007 §6
    const F_A = Symbol("F_A");
    const F_B = Symbol("F_B");
    @Module({
      providers: [
        { provide: F_A, inject: [forwardRef(() => F_B)], useFactory: (b: unknown) => ({ b }) },
        { provide: F_B, inject: [forwardRef(() => F_A)], useFactory: (a: unknown) => ({ a }) },
      ],
    })
    class BadFactoryCycleMod {}
    const badFactoryGraph = await new ModuleScanner().scan(BadFactoryCycleMod);
    await expect(new DIContainer(badFactoryGraph).initialize()).rejects.toThrow(
      CircularDependencyException,
    );

    // Singleton class cycle WITH forwardRef resolves cleanly
    // (Using an interface type annotation avoids JS TDZ before PeerB is declared in the same file)
    interface IPeerB {
      whoami(): string;
      callPeer(): string;
    }

    @Injectable()
    class PeerA {
      constructor(
        @Inject(forwardRef(() => PeerB)) public readonly b: IPeerB,
      ) {}
      whoami() {
        return "A";
      }
      callPeer() {
        return this.b.whoami();
      }
    }

    @Injectable()
    class PeerB implements IPeerB {
      constructor(
        @Inject(forwardRef(() => PeerA)) public readonly a: PeerA,
      ) {}
      whoami() {
        return "B";
      }
      callPeer() {
        return this.a.whoami();
      }
    }

    @Module({ providers: [PeerA, PeerB] })
    class GoodCycleMod {}

    const goodGraph = await new ModuleScanner().scan(GoodCycleMod);
    const container = new DIContainer(goodGraph);
    await container.initialize();

    const ref = container.getModuleRef(goodGraph.root.id);
    const a = ref.get(PeerA);
    const b = ref.get(PeerB);

    expect(a.callPeer()).toBe("B");
    expect(b.callPeer()).toBe("A");
    expect(b.a).toBeInstanceOf(PeerA);
    expect(a.b).toBeInstanceOf(PeerB);

    // One-sided forwardRef cycle + ES #private fields accessed through deferred proxy
    interface IOneSideB {
      readSecret(): string;
      writeSecret(v: string): void;
    }

    @Injectable()
    class OneSideA {
      #secret = "initial-secret";

      constructor(
        @Inject(forwardRef(() => OneSideB)) public readonly b: IOneSideB,
      ) {}

      get secret(): string {
        return this.#secret;
      }

      set secret(val: string) {
        this.#secret = val;
      }
    }

    @Injectable()
    class OneSideB implements IOneSideB {
      // No forwardRef on this side!
      constructor(public readonly a: OneSideA) {}

      readSecret(): string {
        return this.a.secret;
      }

      writeSecret(v: string): void {
        this.a.secret = v;
      }
    }

    @Module({ providers: [OneSideA, OneSideB] })
    class OneSidedCycleMod {}

    const oneSideGraph = await new ModuleScanner().scan(OneSidedCycleMod);
    const oneSideContainer = new DIContainer(oneSideGraph);
    await oneSideContainer.initialize();

    const oneSideRef = oneSideContainer.getModuleRef(oneSideGraph.root.id);
    const oa = oneSideRef.get(OneSideA);
    const ob = oneSideRef.get(OneSideB);

    expect(ob.readSecret()).toBe("initial-secret");
    ob.writeSecret("mutated-secret");
    expect(oa.secret).toBe("mutated-secret");
    expect(oa.b.readSecret()).toBe("mutated-secret");
  });

  it("handles TRANSIENT and REQUEST scopes, concurrent RequestContainer isolation, OnRequestDestroy cleanup, and requiresRequestScope fast path", async () => {
    let transientCounter = 0;
    let requestCounter = 0;
    const destroyedLog: string[] = [];

    @Injectable({ scope: Scope.TRANSIENT })
    class TransientId {
      readonly id = ++transientCounter;
    }

    @Injectable({ scope: Scope.REQUEST })
    class TenantContext implements OnRequestDestroy {
      readonly instanceId = ++requestCounter;
      constructor(
        @Inject(REQUEST) public readonly req: Request,
        @Inject(REQUEST_CONTEXT) public readonly resCtx: ResponseContext,
      ) {}

      onRequestDestroy() {
        destroyedLog.push(`TenantContext#${this.instanceId}`);
      }
    }

    @Injectable({ scope: Scope.REQUEST })
    class RequestAuditService implements OnRequestDestroy {
      constructor(
        public readonly tenant: TenantContext,
        public readonly transientId: TransientId,
      ) {}

      onRequestDestroy() {
        destroyedLog.push(`RequestAuditService#${this.tenant.instanceId}`);
      }
    }

    @Controller({ path: "/scoped", scope: Scope.REQUEST })
    class ScopedController {
      constructor(
        public readonly tenant: TenantContext,
        public readonly audit: RequestAuditService,
      ) {}
    }

    @Injectable()
    class PureSingletonService {}

    @Controller("/fast")
    class FastController {
      constructor(public readonly svc: PureSingletonService) {}
    }

    @Module({
      controllers: [ScopedController, FastController],
      providers: [
        TransientId,
        TenantContext,
        RequestAuditService,
        PureSingletonService,
      ],
    })
    class AppModule {}

    const graph = await new ModuleScanner().scan(AppModule);
    const container = new DIContainer(graph);
    await container.initialize();

    // REQUEST-scoped providers are NOT instantiated at bootstrap
    expect(requestCounter).toBe(0);

    // Static requiresRequestScope fast path
    expect(container.requiresRequestScope(FastController)).toBe(false);
    expect(container.requiresRequestScope(ScopedController)).toBe(true);
    expect(container.requiresRequestScope(FastController, [TenantContext])).toBe(
      true,
    );

    // TRANSIENT resolves a fresh instance every call
    const ref = container.getModuleRef(graph.root.id);
    const t1 = await ref.resolve(TransientId);
    const t2 = await ref.resolve(TransientId);
    expect(t1).not.toBe(t2);
    expect(t2.id).toBeGreaterThan(t1.id);

    // Synchronous get() rejects non-singleton tokens
    expect(() => ref.get(TransientId)).toThrow(/TRANSIENT-scoped/);
    expect(() => ref.get(TenantContext)).toThrow(/REQUEST-scoped/);

    // Concurrent isolated RequestContainers
    const rc1 = container.createRequestContainer(
      new Request("http://localhost/scoped?t=1"),
      undefined,
      makeFakeResponseContext(),
    );
    const rc2 = container.createRequestContainer(
      new Request("http://localhost/scoped?t=2"),
      undefined,
      makeFakeResponseContext(),
    );

    const [ctrl1, ctrl2] = (await Promise.all([
      container.resolveController(ScopedController, rc1),
      container.resolveController(ScopedController, rc2),
    ])) as [ScopedController, ScopedController];

    // Within same request, TenantContext is shared between controller and RequestAuditService
    expect(ctrl1.tenant).toBe(ctrl1.audit.tenant);
    expect(ctrl2.tenant).toBe(ctrl2.audit.tenant);
    // Across concurrent requests, instances & Request objects are strictly isolated
    expect(ctrl1).not.toBe(ctrl2);
    expect(ctrl1.tenant).not.toBe(ctrl2.tenant);
    expect(ctrl1.tenant.req.url).toContain("t=1");
    expect(ctrl2.tenant.req.url).toContain("t=2");

    // Cleanup runs in reverse instantiation order on destroy()
    await rc1.destroy();
    expect(destroyedLog).toEqual([
      `RequestAuditService#${ctrl1.tenant.instanceId}`,
      `TenantContext#${ctrl1.tenant.instanceId}`,
    ]);
  });

  it("fails fast with ScopeLeakException when a SINGLETON depends directly or transitively (including via TRANSIENT) on REQUEST scope", async () => {
    @Injectable({ scope: Scope.REQUEST })
    class TenantContext {}

    @Injectable({ scope: Scope.TRANSIENT })
    class TransientBridge {
      constructor(public readonly tenant: TenantContext) {}
    }

    @Injectable()
    class LeakySingleton {
      constructor(public readonly bridge: TransientBridge) {}
    }

    @Controller("/leaky")
    class LeakyController {
      constructor(public readonly svc: LeakySingleton) {}
    }

    @Module({
      controllers: [LeakyController],
      providers: [TenantContext, TransientBridge, LeakySingleton],
    })
    class LeakyApp {}

    const graph = await new ModuleScanner().scan(LeakyApp);
    const container = new DIContainer(graph);

    let caught: unknown;
    try {
      await container.initialize();
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ScopeLeakException);
    const leak = caught as ScopeLeakException;
    expect(leak.message).toContain("SINGLETON");
    expect(leak.message).toContain("REQUEST");
    expect(leak.message).toContain("LeakySingleton [SINGLETON]");
    expect(leak.message).toContain("TransientBridge [TRANSIENT]");
    expect(leak.message).toContain("TenantContext [REQUEST]");
    expect(leak.message).toContain("Fix:");
  });

  it("supports provider overrides before initialization (for @bunest/testing)", async () => {
    @Injectable()
    class RealEmailService {
      send() {
        return "real";
      }
    }

    @Injectable()
    class AuthService {
      constructor(public readonly email: RealEmailService) {}
    }

    @Module({ providers: [RealEmailService, AuthService] })
    class AppModule {}

    const graph = await new ModuleScanner().scan(AppModule);
    const container = new DIContainer(graph);
    container.applyOverrides({
      providers: new Map([
        [RealEmailService, { provide: RealEmailService, useValue: { send: () => "mocked" } }],
      ]),
    });
    await container.initialize();

    const auth = container.getModuleRef(graph.root.id).get(AuthService);
    expect(auth.email.send()).toBe("mocked");
  });

  it("reports actionable UnknownDependencyException with class, parameter index, token, and module name", async () => {
    const MISSING_DB = Symbol("MISSING_DB");

    @Injectable()
    class BrokenService {
      constructor(@Inject(MISSING_DB) public readonly db: unknown) {}
    }

    @Module({ providers: [BrokenService] })
    class BrokenModule {}

    const graph = await new ModuleScanner().scan(BrokenModule);
    let caught: unknown;
    try {
      await new DIContainer(graph).initialize();
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(UnknownDependencyException);
    const msg = (caught as Error).message;
    expect(msg).toContain("BrokenService");
    expect(msg).toContain("constructor parameter #0");
    expect(msg).toContain("Symbol(MISSING_DB)");
    expect(msg).toContain("BrokenModule");
  });
});
