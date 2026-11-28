import { afterEach, describe, expect, it } from "bun:test";
import {
  Controller,
  dirname,
  Get,
  Global,
  Inject,
  Injectable,
  join,
  METADATA_KEYS,
  MetadataRegistry,
  Module,
  readDirSyncNames,
  readTextSync,
  relative,
  REQUEST,
  resolve,
  Scope,
  SetMetadata,
  statSyncPath,
  VersioningType,
  type BeforeApplicationShutdown,
  type ContextId,
  type ContextIdStrategy,
  type HostComponentInfo,
  type MicroserviceInstance,
  type OnApplicationShutdown,
  type OnModuleDestroy,
  type OnModuleInit,
  type OnRequestDestroy,
} from "../src/common/index";
import {
  BunestFactory,
  ConfigurableModuleBuilder,
  ContextIdFactory,
  DiscoveryModule,
  DiscoveryService,
  LazyModuleLoader,
  MetadataScanner,
  RouterModule,
  ScopeLeakException,
  UnknownDependencyException,
} from "../src";

afterEach(() => {
  ContextIdFactory.reset();
});

describe("DiscoveryService & MetadataScanner", () => {
  it("discovers providers, controllers, modules, tokens, and methods without private casts", async () => {
    const HANDLER_META = Symbol("handler:meta");
    let getterInvoked = false;

    @Injectable()
    class BaseWorker {
      @SetMetadata(HANDLER_META, "base")
      baseWork() {
        return "base";
      }

      get dangerousGetter() {
        getterInvoked = true;
        return "boom";
      }
    }

    @Injectable()
    class AlphaService extends BaseWorker {
      @SetMetadata(HANDLER_META, "alpha")
      runAlpha() {
        return "alpha";
      }
    }

    @Injectable({ scope: Scope.REQUEST })
    class ReqScopedHelper {}

    @Controller("alpha")
    class AlphaController {
      @Get()
      ping() {
        return { ok: true };
      }
    }

    @Module({
      providers: [AlphaService, ReqScopedHelper],
      controllers: [AlphaController],
      exports: [AlphaService],
    })
    class AlphaModule {}

    @Injectable()
    class InspectorService {
      constructor(
        public readonly discovery: DiscoveryService,
        public readonly scanner: MetadataScanner,
      ) {}
    }

    @Module({
      imports: [DiscoveryModule, AlphaModule],
      providers: [InspectorService],
    })
    class AppModule {}

    const app = await BunestFactory.create(AppModule, { logger: false });
    try {
      const inspector = app.get(InspectorService);
      expect(inspector.discovery).toBe(app.get(DiscoveryService));
      expect(inspector.scanner).toBe(app.get(MetadataScanner));

      // DiscoveryService.getModules()
      const modules = inspector.discovery.getModules();
      expect(modules.map((m) => m.metatype)).toContain(AlphaModule);
      expect(modules.map((m) => m.metatype)).toContain(AppModule);

      // DiscoveryService.getProviders() with include filter
      const alphaProviders = inspector.discovery.getProviders({
        include: [AlphaModule],
      });
      const alphaWrapper = alphaProviders.find((w) => w.token === AlphaService);
      const reqWrapper = alphaProviders.find(
        (w) => w.token === ReqScopedHelper,
      );
      expect(alphaWrapper).toBeDefined();
      expect(alphaWrapper?.instance).toBeInstanceOf(AlphaService);
      expect(alphaWrapper?.metatype).toBe(AlphaService);
      expect(alphaWrapper?.scope).toBe(Scope.SINGLETON);
      expect(alphaWrapper?.isDependencyTreeStatic).toBe(true);
      expect(alphaWrapper?.moduleRef.get(AlphaService)).toBe(
        alphaWrapper?.instance as AlphaService,
      );

      expect(reqWrapper).toBeDefined();
      expect(reqWrapper?.instance).toBeUndefined();
      expect(reqWrapper?.scope).toBe(Scope.REQUEST);
      expect(reqWrapper?.isDependencyTreeStatic).toBe(false);

      // DiscoveryService.getControllers() & getProviderByToken()
      const controllers = inspector.discovery.getControllers();
      expect(controllers).toHaveLength(1);
      expect(controllers[0]?.token).toBe(AlphaController);
      expect(controllers[0]?.instance).toBeInstanceOf(AlphaController);
      expect(controllers[0]?.isDependencyTreeStatic).toBe(true);

      const byToken = inspector.discovery.getProviderByToken(AlphaService);
      expect(byToken?.instance).toBe(alphaWrapper?.instance as AlphaService);

      // MetadataScanner skips getters/constructor & discovers inherited methods
      const alphaInst = alphaWrapper!.instance as AlphaService;
      const methods = inspector.scanner.getAllMethodNames(
        Object.getPrototypeOf(alphaInst),
      );
      expect(methods).toEqual(["runAlpha", "baseWork"]);
      expect(getterInvoked).toBe(false);

      const scanned = inspector.scanner.scanFromPrototype(
        alphaInst,
        Object.getPrototypeOf(alphaInst),
        (name) => {
          const fn = (alphaInst as unknown as Record<string, Function>)[name];
          const meta = fn
            ? MetadataRegistry.get<string>(HANDLER_META, fn)
            : undefined;
          return meta ? `${name}:${meta}` : undefined;
        },
      );
      expect(scanned).toEqual(["runAlpha:alpha", "baseWork:base"]);
    } finally {
      await app.close();
    }
  });
});

describe("RouterModule", () => {
  it("resolves nested module route trees, composes with globalPrefix, and never mutates controller metadata", async () => {
    @Controller("users")
    class UsersController {
      @Get("list")
      list() {
        return { scope: "users" };
      }
    }

    @Controller("billing")
    class BillingController {
      @Get("invoices")
      invoices() {
        return { scope: "billing" };
      }
    }

    @Module({ controllers: [UsersController] })
    class UsersModule {}

    @Module({ controllers: [BillingController] })
    class BillingModule {}

    @Module({ imports: [UsersModule, BillingModule] })
    class AdminModule {}

    @Module({
      imports: [
        AdminModule,
        RouterModule.register([
          {
            path: "admin",
            module: AdminModule,
            children: [
              { path: "v1", children: [UsersModule] },
              { path: "finance", module: BillingModule },
            ],
          },
        ]),
      ],
    })
    class AppModule {}

    const app = await BunestFactory.create(AppModule, { logger: false });
    try {
      const res1 = await app.inject("/admin/v1/users/list");
      expect(res1.statusCode).toBe(200);
      expect(res1.json()).toEqual({ scope: "users" });

      const res2 = await app.inject("/admin/finance/billing/invoices");
      expect(res2.statusCode).toBe(200);
      expect(res2.json()).toEqual({ scope: "billing" });

      // Unprefixed path should 404
      expect((await app.inject("/users/list")).statusCode).toBe(404);

      // Composes with setGlobalPrefix
      app.setGlobalPrefix("api");
      const res3 = await app.inject("/api/admin/v1/users/list");
      expect(res3.statusCode).toBe(200);
      expect(res3.json()).toEqual({ scope: "users" });
    } finally {
      await app.close();
    }

    // Original controller metadata was NOT mutated!
    expect(
      MetadataRegistry.get(METADATA_KEYS.CONTROLLER, UsersController),
    ).toEqual({ path: "users" });

    // A second app without RouterModule serves /users/list directly
    @Module({ imports: [UsersModule] })
    class PlainAppModule {}
    const plainApp = await BunestFactory.create(PlainAppModule, {
      logger: false,
    });
    try {
      expect((await plainApp.inject("/users/list")).statusCode).toBe(200);
    } finally {
      await plainApp.close();
    }
  });
});

describe("ConfigurableModuleBuilder", () => {
  interface CacheConfig {
    ttl: number;
    namespace: string;
  }

  const { ConfigurableModuleClass, MODULE_OPTIONS_TOKEN } =
    new ConfigurableModuleBuilder<CacheConfig>({ moduleName: "Cache" })
      .setClassMethodName("forRoot")
      .setFactoryMethodName("createCacheOptions")
      .setExtras({ isGlobal: false }, (definition, extras) => ({
        ...definition,
        global: extras.isGlobal,
      }))
      .build();

  @Injectable()
  class CacheService {
    constructor(
      @Inject(MODULE_OPTIONS_TOKEN) public readonly config: CacheConfig,
    ) {}
  }

  @Module({
    providers: [CacheService],
    exports: [CacheService],
  })
  class CacheModule extends ConfigurableModuleClass {}

  it("supports sync forRoot() with extras transform (global visibility) and clean options separation", async () => {
    @Injectable()
    class ConsumerService {
      constructor(public readonly cache: CacheService) {}
    }

    @Module({ providers: [ConsumerService], exports: [ConsumerService] })
    class ConsumerModule {}

    @Module({
      imports: [
        CacheModule.forRoot({ ttl: 120, namespace: "prod", isGlobal: true }),
        ConsumerModule,
      ],
    })
    class AppModule {}

    const ctx = await BunestFactory.createApplicationContext(AppModule, {
      logger: false,
    });
    try {
      const consumer = ctx.get(ConsumerService);
      expect(consumer.cache.config).toEqual({ ttl: 120, namespace: "prod" });
    } finally {
      await ctx.close();
    }
  });

  it("supports forRootAsync() with useFactory, useClass, and useExisting", async () => {
    const ENV_TOKEN = Symbol("ENV_TOKEN");

    @Module({
      providers: [{ provide: ENV_TOKEN, useValue: "staging" }],
      exports: [ENV_TOKEN],
    })
    class EnvModule {}

    // 1. useFactory + imports + inject
    @Module({
      imports: [
        CacheModule.forRootAsync({
          imports: [EnvModule],
          inject: [ENV_TOKEN],
          useFactory: async (env: string) => ({ ttl: 60, namespace: env }),
        }),
      ],
    })
    class FactoryApp {}

    const factoryCtx = await BunestFactory.createApplicationContext(
      FactoryApp,
      { logger: false },
    );
    try {
      expect(factoryCtx.get(CacheService).config).toEqual({
        ttl: 60,
        namespace: "staging",
      });
    } finally {
      await factoryCtx.close();
    }

    // 2. useClass with custom factory method name `createCacheOptions`
    @Injectable()
    class CacheOptionsFactory {
      constructor(@Inject(ENV_TOKEN) private readonly env: string) {}
      async createCacheOptions(): Promise<CacheConfig> {
        return { ttl: 300, namespace: `class:${this.env}` };
      }
    }

    @Module({
      imports: [
        CacheModule.forRootAsync({
          imports: [EnvModule],
          useClass: CacheOptionsFactory,
        }),
      ],
    })
    class UseClassApp {}

    const classCtx = await BunestFactory.createApplicationContext(UseClassApp, {
      logger: false,
    });
    try {
      expect(classCtx.get(CacheService).config).toEqual({
        ttl: 300,
        namespace: "class:staging",
      });
    } finally {
      await classCtx.close();
    }

    // 3. useExisting
    @Module({
      imports: [EnvModule],
      providers: [CacheOptionsFactory],
      exports: [CacheOptionsFactory],
    })
    class ExistingFactoryModule {}

    @Module({
      imports: [
        CacheModule.forRootAsync({
          imports: [ExistingFactoryModule],
          useExisting: CacheOptionsFactory,
        }),
      ],
    })
    class UseExistingApp {}

    const existingCtx = await BunestFactory.createApplicationContext(
      UseExistingApp,
      { logger: false },
    );
    try {
      expect(existingCtx.get(CacheService).config).toEqual({
        ttl: 300,
        namespace: "class:staging",
      });
    } finally {
      await existingCtx.close();
    }
  });
});

describe("Durable DI Sub-Trees (ContextIdFactory.apply)", () => {
  it("caches durable tenant-scoped trees across requests while keeping non-durable REQUEST providers per-request and cleans up on destroy/close", async () => {
    const tenants = new Map<string, ContextId>();
    let durableConstructs = 0;
    let ephemeralConstructs = 0;
    const destroyedLog: string[] = [];

    class TenantContextStrategy implements ContextIdStrategy<Request> {
      attach(contextId: ContextId, request: Request) {
        const tenantId = request.headers.get("x-tenant-id") ?? "default";
        let tenantSubTreeId = tenants.get(tenantId);
        if (!tenantSubTreeId) {
          tenantSubTreeId = ContextIdFactory.create();
          tenants.set(tenantId, tenantSubTreeId);
        }
        return {
          resolve: (info: HostComponentInfo) =>
            info.isTreeDurable ? tenantSubTreeId : contextId,
          payload: { tenantId },
        };
      }
    }

    ContextIdFactory.apply(new TenantContextStrategy());

    @Injectable({ scope: Scope.REQUEST, durable: true })
    class TenantConnectionService implements OnRequestDestroy {
      readonly instanceId = ++durableConstructs;
      constructor(
        @Inject(REQUEST) public readonly payload: { tenantId: string },
      ) {}

      onRequestDestroy() {
        destroyedLog.push(
          `durable:${this.payload.tenantId}#${this.instanceId}`,
        );
      }
    }

    @Injectable({ scope: Scope.REQUEST })
    class PerRequestAuditService implements OnRequestDestroy {
      readonly instanceId = ++ephemeralConstructs;
      constructor(@Inject(REQUEST) public readonly req: Request) {}

      onRequestDestroy() {
        destroyedLog.push(`req:#${this.instanceId}`);
      }
    }

    @Controller({ path: "tenant", scope: Scope.REQUEST })
    class TenantController {
      constructor(
        private readonly tenantConn: TenantConnectionService,
        private readonly audit: PerRequestAuditService,
      ) {}

      @Get("info")
      info() {
        return {
          tenantId: this.tenantConn.payload.tenantId,
          durableInstanceId: this.tenantConn.instanceId,
          ephemeralInstanceId: this.audit.instanceId,
          url: new URL(this.audit.req.url).pathname,
        };
      }
    }

    @Module({
      controllers: [TenantController],
      providers: [TenantConnectionService, PerRequestAuditService],
    })
    class MultiTenantApp {}

    const app = await BunestFactory.create(MultiTenantApp, { logger: false });
    try {
      // Request 1 & 2 for tenant "acme" reuse durable instance #1, but get fresh ephemeral #1 and #2
      const r1 = (
        await app.inject({
          url: "/tenant/info",
          headers: { "x-tenant-id": "acme" },
        })
      ).json<{
        tenantId: string;
        durableInstanceId: number;
        ephemeralInstanceId: number;
      }>();

      const r2 = (
        await app.inject({
          url: "/tenant/info",
          headers: { "x-tenant-id": "acme" },
        })
      ).json<{
        tenantId: string;
        durableInstanceId: number;
        ephemeralInstanceId: number;
      }>();

      // Request 3 for tenant "globex" creates a separate durable instance #2
      const r3 = (
        await app.inject({
          url: "/tenant/info",
          headers: { "x-tenant-id": "globex" },
        })
      ).json<{
        tenantId: string;
        durableInstanceId: number;
        ephemeralInstanceId: number;
      }>();

      expect(r1.tenantId).toBe("acme");
      expect(r2.tenantId).toBe("acme");
      expect(r1.durableInstanceId).toBe(r2.durableInstanceId);
      expect(r1.ephemeralInstanceId).not.toBe(r2.ephemeralInstanceId);

      expect(r3.tenantId).toBe("globex");
      expect(r3.durableInstanceId).not.toBe(r1.durableInstanceId);

      // Per-request audit providers were destroyed after each request, durable ones were NOT!
      expect(destroyedLog).toEqual(["req:#1", "req:#2", "req:#3"]);

      // Explicit destroyDurableContext destroys only acme's durable tree
      await app.destroyDurableContext(tenants.get("acme")!);
      expect(destroyedLog).toContain("durable:acme#1");
      expect(destroyedLog).not.toContain("durable:globex#2");

      // Next acme request creates a brand-new durable instance #3
      const r4 = (
        await app.inject({
          url: "/tenant/info",
          headers: { "x-tenant-id": "acme" },
        })
      ).json<{ durableInstanceId: number }>();
      expect(r4.durableInstanceId).toBe(3);
    } finally {
      await app.close();
    }

    // app.close() destroys remaining durable contexts cleanly
    expect(destroyedLog).toContain("durable:globex#2");
    expect(destroyedLog).toContain("durable:acme#3");
  });

  it("single-flights concurrent async durable factory instantiation with zero leaks on destroy/close (Regression #111)", async () => {
    const tenants = new Map<string, ContextId>();
    const ASYNC_DURABLE_TOKEN = Symbol("ASYNC_DURABLE_TOKEN");
    let factoryCalls = 0;
    const destroyedIds: number[] = [];

    ContextIdFactory.apply({
      attach(contextId: ContextId, request: Request) {
        const tenantId = request.headers.get("x-tenant-id") ?? "default";
        let subTreeId = tenants.get(tenantId);
        if (!subTreeId) {
          subTreeId = ContextIdFactory.create();
          tenants.set(tenantId, subTreeId);
        }
        return {
          resolve: (info: HostComponentInfo) =>
            info.isTreeDurable ? subTreeId : contextId,
          payload: { tenantId },
        };
      },
    });

    @Controller({ path: "async-durable", scope: Scope.REQUEST })
    class AsyncDurableController {
      constructor(
        @Inject(ASYNC_DURABLE_TOKEN)
        private readonly resource: { id: number; tenantId: string },
      ) {}

      @Get()
      get() {
        return { id: this.resource.id, tenantId: this.resource.tenantId };
      }
    }

    @Module({
      controllers: [AsyncDurableController],
      providers: [
        {
          provide: ASYNC_DURABLE_TOKEN,
          scope: Scope.REQUEST,
          durable: true,
          inject: [REQUEST],
          useFactory: async (payload: { tenantId: string }) => {
            const id = ++factoryCalls;
            await new Promise((r) => setTimeout(r, 20));
            return {
              id,
              tenantId: payload.tenantId,
              onRequestDestroy() {
                destroyedIds.push(id);
              },
            };
          },
        },
      ],
    })
    class ConcurrentDurableApp {}

    const app = await BunestFactory.create(ConcurrentDurableApp, {
      logger: false,
    });
    try {
      const [resA, resB, resC] = await Promise.all([
        app.inject({
          url: "/async-durable",
          headers: { "x-tenant-id": "acme" },
        }),
        app.inject({
          url: "/async-durable",
          headers: { "x-tenant-id": "acme" },
        }),
        app.inject({
          url: "/async-durable",
          headers: { "x-tenant-id": "acme" },
        }),
      ]);

      expect(factoryCalls).toBe(1);
      expect(resA.json()).toEqual({ id: 1, tenantId: "acme" });
      expect(resB.json()).toEqual({ id: 1, tenantId: "acme" });
      expect(resC.json()).toEqual({ id: 1, tenantId: "acme" });
    } finally {
      await app.close();
    }

    expect(destroyedIds).toEqual([1]);
  });
});

describe("LazyModuleLoader", () => {
  it("loads modules on demand, shares existing singletons, runs onModuleInit once, deduplicates concurrent loads, and tears down on app.close()", async () => {
    const lifecycleLog: string[] = [];

    @Global()
    @Injectable()
    class SharedConfigService {
      readonly env = "production";
    }

    @Global()
    @Module({
      providers: [SharedConfigService],
      exports: [SharedConfigService],
    })
    class SharedGlobalModule {}

    @Injectable()
    class HeavyService
      implements
        OnModuleInit,
        OnModuleDestroy,
        BeforeApplicationShutdown,
        OnApplicationShutdown
    {
      constructor(public readonly config: SharedConfigService) {}

      onModuleInit() {
        lifecycleLog.push("heavy:init");
      }

      onModuleDestroy() {
        lifecycleLog.push("heavy:destroy");
      }

      beforeApplicationShutdown() {
        lifecycleLog.push("heavy:beforeShutdown");
      }

      onApplicationShutdown() {
        lifecycleLog.push("heavy:shutdown");
      }
    }

    @Module({
      providers: [HeavyService],
      exports: [HeavyService],
    })
    class HeavyModule {}

    @Injectable()
    class TriggerService {
      constructor(public readonly lazyLoader: LazyModuleLoader) {}
    }

    @Module({
      imports: [SharedGlobalModule],
      providers: [TriggerService],
    })
    class AppModule {}

    const app = await BunestFactory.create(AppModule, { logger: false });
    await app.init();

    const trigger = app.get(TriggerService);
    expect(trigger.lazyLoader).toBe(app.get(LazyModuleLoader));

    // Concurrent + repeated loads deduplicate cleanly
    const [ref1, ref2] = await Promise.all([
      trigger.lazyLoader.load(async () => HeavyModule),
      trigger.lazyLoader.load(() => HeavyModule),
    ]);
    const ref3 = await trigger.lazyLoader.load(() => HeavyModule);

    const heavy1 = ref1.get(HeavyService);
    expect(heavy1).toBe(ref2.get(HeavyService));
    expect(heavy1).toBe(ref3.get(HeavyService));
    expect(heavy1.config).toBe(app.get(SharedConfigService));
    expect(lifecycleLog).toEqual(["heavy:init"]);

    // Lazy module is visible via DiscoveryService
    const discovery = app.get(DiscoveryService);
    expect(discovery.getProviderByToken(HeavyService)?.instance).toBe(heavy1);

    // Invalid lazy module fails and rolls back without corrupting the live app
    @Injectable()
    class BrokenLazyService {
      constructor(@Inject(Symbol("MISSING_TOKEN")) readonly missing: unknown) {}
    }

    @Module({ providers: [BrokenLazyService] })
    class BrokenLazyModule {}

    await expect(
      trigger.lazyLoader.load(() => BrokenLazyModule),
    ).rejects.toThrow(UnknownDependencyException);
    expect(discovery.getProviderByToken(BrokenLazyService)).toBeUndefined();

    // ScopeLeakException inside lazy module also rejected cleanly
    @Injectable({ scope: Scope.REQUEST })
    class LazyReqDep {}

    @Injectable()
    class BadSingletonLazy {
      constructor(public readonly reqDep: LazyReqDep) {}
    }

    @Module({ providers: [LazyReqDep, BadSingletonLazy] })
    class LeakyLazyModule {}

    await expect(
      trigger.lazyLoader.load(() => LeakyLazyModule),
    ).rejects.toThrow(ScopeLeakException);

    await app.close();
    expect(lifecycleLog).toEqual([
      "heavy:init",
      "heavy:destroy",
      "heavy:beforeShutdown",
      "heavy:shutdown",
    ]);
  });
});

describe("Hybrid BunestApplication (enableVersioning, useStaticAssets, connectMicroservice)", () => {
  it("manages versioning/static asset config and full hybrid microservice lifecycle", async () => {
    const events: string[] = [];

    const makeServer = (name: string): MicroserviceInstance => ({
      async listen() {
        events.push(`${name}:listen`);
      },
      async close() {
        events.push(`${name}:close`);
      },
    });

    @Controller("health")
    class HealthController {
      @Get()
      check() {
        return { status: "ok" };
      }
    }

    @Module({ controllers: [HealthController] })
    class HybridAppModule {}

    const app = await BunestFactory.create(HybridAppModule, { logger: false });
    app.enableVersioning({
      type: VersioningType.HEADER,
      header: "X-API-Version",
      defaultVersion: "1",
    });
    app.useStaticAssets("./public", {
      prefix: "/static",
      cacheControl: "public, max-age=60",
      dotfiles: "deny",
    });

    expect(app.getVersioningOptions()).toEqual({
      type: VersioningType.HEADER,
      header: "X-API-Version",
      defaultVersion: "1",
    });
    expect(app.getStaticAssetsConfigs()).toEqual([
      {
        rootDir: "./public",
        options: {
          prefix: "/static",
          cacheControl: "public, max-age=60",
          dotfiles: "deny",
        },
      },
    ]);

    const grpc = app.connectMicroservice(makeServer("grpc"));
    const kafka = app.connectMicroservice(makeServer("kafka"));
    // Duplicate connect is deduplicated
    app.connectMicroservice(grpc);

    expect(app.getMicroservices()).toEqual([grpc, kafka]);

    await app.startAllMicroservices();
    // Second call is idempotent (already started servers are not started again)
    await app.startAllMicroservices();
    expect(events).toEqual(["grpc:listen", "kafka:listen"]);

    expect(
      (
        await app.inject({
          url: "/health",
          headers: { "x-api-version": "1" },
        })
      ).json(),
    ).toEqual({ status: "ok" });
    expect((await app.inject("/health")).statusCode).toBe(404);

    await app.close();
    expect(events).toEqual([
      "grpc:listen",
      "kafka:listen",
      "grpc:close",
      "kafka:close",
    ]);
  });
});

describe("Zero Circular Dependency Verification (runtime + type-only)", () => {
  function walkTs(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readDirSyncNames(dir)) {
      const full = join(dir, entry);
      if (statSyncPath(full).isDirectory()) {
        out.push(...walkTs(full));
      } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
        out.push(full);
      }
    }
    return out;
  }

  function findAllCycles(pkgSrcDir: string): string[][] {
    const files = walkTs(pkgSrcDir);
    const graph = new Map<string, string[]>();

    for (const file of files) {
      const src = readTextSync(file)
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
        .replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");
      const edges: string[] = [];
      const fromRegex =
        /(?:^|;|\n)\s*(?:import|export)\s+(?:type\s+)?[^;(=]*?\s+from\s+["'](\.[^"']+)["']/g;
      for (const m of src.matchAll(fromRegex)) {
        const spec = m[1]!;
        const base = resolve(dirname(file), spec);
        for (const candidate of [base, `${base}.ts`, join(base, "index.ts")]) {
          try {
            if (statSyncPath(candidate).isFile()) {
              edges.push(relative(pkgSrcDir, candidate));
              break;
            }
          } catch {
            // continue
          }
        }
      }
      graph.set(relative(pkgSrcDir, file), edges);
    }

    const visiting = new Set<string>();
    const visited = new Set<string>();
    const cycles: string[][] = [];

    const dfs = (node: string, stack: string[]) => {
      if (visiting.has(node)) {
        cycles.push([...stack.slice(stack.indexOf(node)), node]);
        return;
      }
      if (visited.has(node)) return;
      visiting.add(node);
      for (const dep of graph.get(node) ?? []) {
        dfs(dep, [...stack, node]);
      }
      visiting.delete(node);
      visited.add(node);
    };

    for (const node of graph.keys()) {
      dfs(node, []);
    }
    return cycles;
  }

  it(
    "has ZERO runtime AND ZERO type-only circular imports in packages/core/src/common and packages/core/src",
    () => {
      const repoRoot = resolve(import.meta.dir, "../../..");
      const commonCycles = findAllCycles(
        join(repoRoot, "packages/core/src/common"),
      );
      const coreCycles = findAllCycles(join(repoRoot, "packages/core/src"));
      expect(commonCycles).toEqual([]);
      expect(coreCycles).toEqual([]);
    },
    15_000,
  );
});
