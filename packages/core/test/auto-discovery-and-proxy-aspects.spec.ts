import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  AutoModule,
  Controller,
  DecoratorRegistry,
  Get,
  Inject,
  Injectable,
  Module,
  Param,
  REQUEST,
  Scope,
  createMethodAspectDecorator,
  type DecoratorRegistrySnapshot,
  type MethodAspectContext,
  type MethodAspectHandler,
} from "@bunest/common";
import {
  BunestFactory,
  ContextIdFactory,
  weaveMethodExecutor,
  weaveProxyMethodAspects,
  type AspectResolver,
} from "../src";

describe("Zero-Boilerplate Auto-Discovery (@AutoModule, Module.autoDiscover, BunestFactory.createAuto)", () => {
  let savedSnapshot: DecoratorRegistrySnapshot;

  beforeEach(() => {
    savedSnapshot = DecoratorRegistry.snapshot();
    DecoratorRegistry.clear();
  });

  afterEach(() => {
    DecoratorRegistry.restore(savedSnapshot);
  });

  it("bootstraps a full HTTP app with BunestFactory.createAuto() without manually listing controllers or providers", async () => {
    @Injectable()
    class GreetingService {
      greet(name: string) {
        return `Hello, ${name}!`;
      }
    }

    @Controller("greetings")
    class GreetingController {
      constructor(private readonly greetings: GreetingService) {}

      @Get(":name")
      sayHello(@Param("name") name: string) {
        return { message: this.greetings.greet(name) };
      }
    }

    const app = await BunestFactory.createAuto({ logger: false });
    try {
      const res = await app.inject("/greetings/Bunest");
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ message: "Hello, Bunest!" });
      expect(app.get(GreetingService)).toBeInstanceOf(GreetingService);
      expect(app.get(GreetingController)).toBeInstanceOf(GreetingController);
    } finally {
      await app.close();
    }
  });

  it("supports @AutoModule, @Module({ autoDiscover }), include/exclude filters, and skips already-declared classes in imported modules", async () => {
    @Injectable()
    class SharedService {
      readonly source = "imported-module";
    }

    @Injectable()
    class AutoService {
      constructor(private readonly shared: SharedService) {}
      info() {
        return `auto+${this.shared.source}`;
      }
    }

    @Injectable()
    class ExcludedService {
      readonly skipped = true;
    }

    @Controller("shared")
    class SharedController {
      @Get()
      ping() {
        return { from: "shared" };
      }
    }

    @Controller("auto")
    class AutoController {
      constructor(private readonly svc: AutoService) {}

      @Get()
      index() {
        return { info: this.svc.info() };
      }
    }

    @Controller("excluded")
    class ExcludedController {
      @Get()
      never() {
        return { shouldNotExist: true };
      }
    }

    @Module({
      controllers: [SharedController],
      providers: [SharedService],
      exports: [SharedService],
    })
    class ImportedFeatureModule {}

    @AutoModule({
      imports: [ImportedFeatureModule],
      autoDiscover: {
        exclude: [ExcludedService, ExcludedController],
      },
      exports: [AutoService],
    })
    class RootAutoModule {}

    const app = await BunestFactory.create(RootAutoModule, { logger: false });
    try {
      const sharedRes = await app.inject("/shared");
      expect(sharedRes.statusCode).toBe(200);
      expect(sharedRes.json()).toEqual({ from: "shared" });

      const autoRes = await app.inject("/auto");
      expect(autoRes.statusCode).toBe(200);
      expect(autoRes.json()).toEqual({ info: "auto+imported-module" });

      // Excluded controller is not mounted and excluded service is not registered
      const excludedRes = await app.inject("/excluded");
      expect(excludedRes.statusCode).toBe(404);
      expect(() => app.get(ExcludedService)).toThrow();
    } finally {
      await app.close();
    }

    // Also test strict `include` filter + controllers/providers flags
    @Module({
      autoDiscover: {
        controllers: true,
        providers: true,
        include: [SharedController, SharedService],
      },
    })
    class ScopedAutoModule {}

    const scopedApp = await BunestFactory.create(ScopedAutoModule, {
      logger: false,
    });
    try {
      expect((await scopedApp.inject("/shared")).statusCode).toBe(200);
      expect((await scopedApp.inject("/auto")).statusCode).toBe(404);
      expect(scopedApp.get(SharedService)).toBeInstanceOf(SharedService);
      expect(() => scopedApp.get(AutoService)).toThrow();
    } finally {
      await scopedApp.close();
    }
  });

  it("leaves explicit @Module apps 100% unaffected by classes registered in DecoratorRegistry", async () => {
    @Controller("rogue")
    class RogueController {
      @Get()
      rogue() {
        return { rogue: true };
      }
    }

    @Controller("explicit")
    class ExplicitController {
      @Get()
      ok() {
        return { explicit: true };
      }
    }

    @Module({
      controllers: [ExplicitController],
    })
    class ExplicitAppModule {}

    // Reference RogueController so it's registered in DecoratorRegistry
    expect(DecoratorRegistry.getControllers()).toContain(RogueController);

    const app = await BunestFactory.create(ExplicitAppModule, {
      logger: false,
    });
    try {
      expect((await app.inject("/explicit")).statusCode).toBe(200);
      expect((await app.inject("/rogue")).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

describe("Proxy-Safe & Factory-Safe MethodAspectWeaver", () => {
  it("weaveMethodExecutor weaves stacked class-level and method-level aspects with sync fast-path and preserves metadata", () => {
    const trace: string[] = [];
    const SPAN_TOKEN = Symbol("SPAN_TOKEN");
    const CACHE_TOKEN = Symbol("CACHE_TOKEN");

    const Span = (name: string) =>
      createMethodAspectDecorator(SPAN_TOKEN, { name }, -10);
    const Cacheable = (ttl: number) =>
      createMethodAspectDecorator(CACHE_TOKEN, { ttl }, 0);

    @Span("repo-span")
    abstract class DemoRepo {
      @Cacheable(5000)
      findByEmail(_email: string): string {
        throw new Error("stub");
      }
      abstract findByRole(role: string): string;
    }

    const cacheStore = new Map<string, unknown>();
    const resolver: AspectResolver = (token) => {
      if (token === SPAN_TOKEN) {
        return {
          intercept(ctx: MethodAspectContext<{ name: string }>) {
            trace.push(`span:start:${ctx.options.name}:${String(ctx.methodName)}`);
            const out = ctx.proceed();
            trace.push(`span:end:${ctx.options.name}:${String(ctx.methodName)}`);
            return out;
          },
        };
      }
      if (token === CACHE_TOKEN) {
        return {
          intercept(ctx: MethodAspectContext<{ ttl: number }>) {
            const key = `${String(ctx.methodName)}:${JSON.stringify(ctx.args)}`;
            if (cacheStore.has(key)) {
              trace.push(`cache:hit:${key}`);
              return cacheStore.get(key);
            }
            trace.push(`cache:miss:${key}`);
            const out = ctx.proceed();
            cacheStore.set(key, out);
            return out;
          },
        };
      }
      return undefined;
    };

    const target = Object.create(DemoRepo.prototype) as object;
    const rawFindByEmail = function findByEmail(email: string) {
      trace.push(`exec:findByEmail:${email}`);
      return `user:${email}`;
    };

    const wovenEmail = weaveMethodExecutor(
      target,
      DemoRepo,
      "findByEmail",
      rawFindByEmail,
      resolver,
    );

    expect(wovenEmail.name).toBe("findByEmail");
    expect(wovenEmail.length).toBe(1);

    // Synchronous call #1 (cache miss)
    expect(wovenEmail("a@b.com")).toBe("user:a@b.com");
    // Synchronous call #2 (cache hit)
    expect(wovenEmail("a@b.com")).toBe("user:a@b.com");

    expect(trace).toEqual([
      "span:start:repo-span:findByEmail",
      'cache:miss:findByEmail:["a@b.com"]',
      "exec:findByEmail:a@b.com",
      "span:end:repo-span:findByEmail",
      "span:start:repo-span:findByEmail",
      'cache:hit:findByEmail:["a@b.com"]',
      "span:end:repo-span:findByEmail",
    ]);
  });

  it("weaveProxyMethodAspects weaves CRUD, @Query-style, concrete, AND dynamically synthesized derived methods on Proxy-backed abstract repositories", async () => {
    const trace: string[] = [];
    const TX_TOKEN = Symbol("TX_TOKEN");
    const CACHE_TOKEN = Symbol("CACHE_TOKEN");

    const Transactional = () => createMethodAspectDecorator(TX_TOKEN, undefined, -10);
    const Cacheable = (key: string) =>
      createMethodAspectDecorator(CACHE_TOKEN, { key }, 5);

    abstract class BaseFakeJpaRepo<T> {
      abstract findById(id: number): Promise<T | null>;
    }

    @Transactional()
    abstract class UserRepository extends BaseFakeJpaRepo<{
      id: number;
      email: string;
    }> {
      @Cacheable("by-email")
      findByEmail(_email: string): Promise<{ id: number; email: string } | null> {
        throw new Error("abstract stub");
      }

      // Purely abstract derived method (completely erased from prototype at runtime!)
      abstract findAllByDomain(
        domain: string,
      ): Promise<Array<{ id: number; email: string }>>;

      // Concrete helper method calling a derived method via `this`
      async findFirstInDomain(domain: string) {
        const list = await this.findAllByDomain(domain);
        return list[0] ?? null;
      }
    }

    const dbRows = [
      { id: 1, email: "ada@acme.io" },
      { id: 2, email: "grace@acme.io" },
    ];

    function createFakeRepoProxy(): UserRepository {
      const target = Object.create(UserRepository.prototype) as Record<
        PropertyKey,
        unknown
      >;
      target.findById = async (id: number) => {
        trace.push(`crud:findById:${id}`);
        return dbRows.find((r) => r.id === id) ?? null;
      };
      target.findByEmail = async (email: string) => {
        trace.push(`query:findByEmail:${email}`);
        return dbRows.find((r) => r.email === email) ?? null;
      };

      const derivedCache = new Map<string, Function>();
      return new Proxy(target, {
        get(obj, prop, receiver) {
          if (typeof prop === "symbol" || prop === "then") {
            return Reflect.get(obj, prop, receiver);
          }
          if (prop in obj) {
            return Reflect.get(obj, prop, receiver);
          }
          if (prop === "findAllByDomain") {
            let fn = derivedCache.get(prop);
            if (!fn) {
              fn = async (domain: string) => {
                trace.push(`derived:findAllByDomain:${domain}`);
                return dbRows.filter((r) => r.email.endsWith(`@${domain}`));
              };
              derivedCache.set(prop, fn);
            }
            return fn;
          }
          return undefined;
        },
      }) as unknown as UserRepository;
    }

    const cache = new Map<string, unknown>();
    const resolver: AspectResolver = (token) => {
      if (token === TX_TOKEN) {
        return {
          async intercept(ctx: MethodAspectContext) {
            trace.push(`tx:enter:${String(ctx.methodName)}`);
            const res = await ctx.proceed();
            trace.push(`tx:exit:${String(ctx.methodName)}`);
            return res;
          },
        };
      }
      if (token === CACHE_TOKEN) {
        return {
          async intercept(ctx: MethodAspectContext<{ key: string }>) {
            const k = `${ctx.options.key}:${String(ctx.args[0])}`;
            if (cache.has(k)) {
              trace.push(`cache:hit:${k}`);
              return cache.get(k);
            }
            trace.push(`cache:miss:${k}`);
            const res = await ctx.proceed();
            cache.set(k, res);
            return res;
          },
        };
      }
      return undefined;
    };

    const rawProxy = createFakeRepoProxy();
    const woven = weaveProxyMethodAspects(rawProxy, UserRepository, resolver);

    // Double-wrapping prevention + Promise assimilation safety + instanceof preservation
    expect(weaveProxyMethodAspects(woven, UserRepository, resolver)).toBe(woven);
    expect(await Promise.resolve(woven)).toBe(woven);
    expect(woven instanceof UserRepository).toBe(true);
    expect(woven instanceof BaseFakeJpaRepo).toBe(true);

    // 1. CRUD method triggers class-level @Transactional
    trace.length = 0;
    expect(await woven.findById(1)).toEqual({ id: 1, email: "ada@acme.io" });
    expect(trace).toEqual([
      "tx:enter:findById",
      "crud:findById:1",
      "tx:exit:findById",
    ]);

    // 2. @Query / stubbed method triggers BOTH class-level @Transactional AND method-level @Cacheable
    trace.length = 0;
    expect(await woven.findByEmail("ada@acme.io")).toEqual({
      id: 1,
      email: "ada@acme.io",
    });
    expect(await woven.findByEmail("ada@acme.io")).toEqual({
      id: 1,
      email: "ada@acme.io",
    });
    expect(trace).toEqual([
      "tx:enter:findByEmail",
      "cache:miss:by-email:ada@acme.io",
      "query:findByEmail:ada@acme.io",
      "tx:exit:findByEmail",
      "tx:enter:findByEmail",
      "cache:hit:by-email:ada@acme.io",
      "tx:exit:findByEmail",
    ]);

    // 3. Dynamically synthesized derived method (not on prototype!) triggers class-level @Transactional
    trace.length = 0;
    expect(await woven.findAllByDomain("acme.io")).toHaveLength(2);
    expect(trace).toEqual([
      "tx:enter:findAllByDomain",
      "derived:findAllByDomain:acme.io",
      "tx:exit:findAllByDomain",
    ]);

    // 4. Concrete helper method calling derived method triggers aspects on both
    trace.length = 0;
    expect(await woven.findFirstInDomain("acme.io")).toEqual({
      id: 1,
      email: "ada@acme.io",
    });
    expect(trace).toEqual([
      "tx:enter:findFirstInDomain",
      "tx:enter:findAllByDomain",
      "derived:findAllByDomain:acme.io",
      "tx:exit:findAllByDomain",
      "tx:exit:findFirstInDomain",
    ]);
  });

  it("DIContainer automatically weaves useFactory providers whose token OR returned proxy class carries MethodAspects (including sync pre-warming and REQUEST scope)", async () => {
    const trace: string[] = [];
    const REPO_ALIAS_TOKEN = Symbol("REPO_ALIAS_TOKEN");

    @Injectable()
    class AuditAspect implements MethodAspectHandler<{ tag: string }> {
      intercept(ctx: MethodAspectContext<{ tag: string }>) {
        trace.push(`audit:${ctx.options.tag}:${String(ctx.methodName)}`);
        return ctx.proceed();
      }
    }

    @Injectable({ scope: Scope.REQUEST })
    class TenantAspect implements MethodAspectHandler {
      constructor(@Inject(REQUEST) private readonly req: { tenant?: string }) {}

      async intercept(ctx: MethodAspectContext) {
        return `${this.req?.tenant ?? "none"}:${String(await ctx.proceed())}`;
      }
    }

    const Audit = (tag: string) =>
      createMethodAspectDecorator(AuditAspect, { tag });
    const WithTenant = () => createMethodAspectDecorator(TenantAspect);

    // Case 1: Abstract class token with useFactory returning a plain Proxy (whose .constructor is Object!)
    @Audit("class-token")
    abstract class FactoryTokenRepo {
      abstract computeSync(n: number): number;
      abstract findByCode(code: string): Promise<string>;
    }

    // Case 2: String/symbol token + useExisting alias (exact SqliteModule.forFeature / SqlModule.forFeature pattern!)
    @Audit("repo-proto")
    abstract class FeatureAliasRepo {
      abstract findBySlug(slug: string): Promise<string>;
    }

    // Case 3: REQUEST-scoped aspect on a useFactory class-token provider
    abstract class TenantAwareFactoryService {
      @WithTenant()
      describe(_label: string): Promise<string> {
        throw new Error("stub");
      }
    }

    @Module({
      providers: [
        AuditAspect,
        TenantAspect,
        {
          provide: FactoryTokenRepo,
          useFactory: () =>
            new Proxy(
              {
                computeSync(n: number) {
                  return n * 2;
                },
              },
              {
                get(target, prop, receiver) {
                  if (prop in target) {
                    return Reflect.get(target, prop, receiver);
                  }
                  if (prop === "findByCode") {
                    return async (code: string) => `code:${code}`;
                  }
                  return undefined;
                },
              },
            ),
        },
        {
          provide: REPO_ALIAS_TOKEN,
          useFactory: () => {
            const base = Object.create(FeatureAliasRepo.prototype) as object;
            return new Proxy(base, {
              get(obj, prop, receiver) {
                if (prop === "findBySlug") {
                  return async (slug: string) => `slug:${slug}`;
                }
                return Reflect.get(obj, prop, receiver);
              },
            });
          },
        },
        {
          provide: FeatureAliasRepo,
          useExisting: REPO_ALIAS_TOKEN,
        },
        {
          provide: TenantAwareFactoryService,
          scope: Scope.REQUEST,
          useFactory: () => ({
            async describe(label: string) {
              return `item:${label}`;
            },
          }),
        },
      ],
    })
    class FactoryAspectModule {}

    const ctx = await BunestFactory.createApplicationContext(
      FactoryAspectModule,
      { logger: false },
    );
    try {
      // Case 1: Class-token useFactory — sync method stays 100% synchronous on call #1!
      const tokenRepo = ctx.get(FactoryTokenRepo);
      const syncOut = tokenRepo.computeSync(21);
      expect(syncOut).toBe(42);
      expect(await tokenRepo.findByCode("ABC")).toBe("code:ABC");

      // Case 2: String/symbol useFactory with Object.create(RepoClass.prototype) + useExisting
      const aliasRepo = ctx.get(FeatureAliasRepo);
      expect(aliasRepo instanceof FeatureAliasRepo).toBe(true);
      expect(await aliasRepo.findBySlug("hello")).toBe("slug:hello");

      expect(trace).toEqual([
        "audit:class-token:computeSync",
        "audit:class-token:findByCode",
        "audit:repo-proto:findBySlug",
      ]);

      // Case 3: REQUEST-scoped aspect on useFactory
      const ctxId = ContextIdFactory.create();
      ctx.registerRequestByContextId({ tenant: "zenith" }, ctxId);
      const tenantSvc = await ctx.resolve(TenantAwareFactoryService, ctxId);
      expect(await tenantSvc.describe("widget")).toBe("zenith:item:widget");
    } finally {
      await ctx.close();
    }
  });
});
