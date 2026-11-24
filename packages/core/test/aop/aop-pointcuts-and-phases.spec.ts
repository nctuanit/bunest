import { afterEach, describe, expect, it } from "bun:test";
import {
  AOP_POINTCUTS_TOKEN,
  AopModule,
  AspectPhase,
  BunestFactory,
  Injectable,
  Module,
  Scope,
  SetMetadata,
  clearGlobalPointcuts,
  createMethodAspectDecorator,
  createTypedAspect,
  defineAspectPipeline,
  getMethodAspects,
  registerGlobalPointcuts,
  resolveAspectOrder,
  unregisterGlobalPointcut,
  type MethodAspectContext,
  type MethodAspectHandler,
  type PointcutRule,
} from "../../src";

describe("Service-Layer AOP: AspectPhase, defineAspectPipeline, createTypedAspect & Pointcuts", () => {
  afterEach(() => {
    clearGlobalPointcuts();
  });

  describe("AspectPhase & createMethodAspectDecorator phase/order support", () => {
    it("exports canonical AspectPhase numeric constants in strict outer-to-inner order", () => {
      expect(AspectPhase).toEqual({
        OBSERVABILITY: -500,
        RESILIENCE: -400,
        RATE_LIMIT: -350,
        LOCK: -300,
        TRANSACTION: -200,
        CACHE: -100,
        VALIDATION: -50,
        DEFAULT: 0,
        EVENT: 100,
        AUDIT: 200,
      });

      expect(resolveAspectOrder(undefined)).toBeUndefined();
      expect(resolveAspectOrder(-42)).toBe(-42);
      expect(resolveAspectOrder(AspectPhase.TRANSACTION)).toBe(-200);
      expect(resolveAspectOrder({ phase: AspectPhase.CACHE })).toBe(-100);
      expect(resolveAspectOrder({ order: 15 })).toBe(15);
      expect(resolveAspectOrder({ phase: AspectPhase.CACHE, order: 5 })).toBe(
        -95,
      );
      expect(resolveAspectOrder({ phase: AspectPhase.CACHE, order: -5 })).toBe(
        -105,
      );
    });

    it("executes stacked aspects strictly in semantic AspectPhase order regardless of decorator declaration order", async () => {
      const trace: string[] = [];

      const mkPhase = (
        label: string,
        orderOrPhase:
          | number
          | { readonly phase?: number; readonly order?: number },
      ) =>
        createMethodAspectDecorator(
          (ctx: MethodAspectContext) => {
            trace.push(`enter:${label}`);
            const out = ctx.proceed();
            trace.push(`exit:${label}`);
            return out;
          },
          undefined,
          orderOrPhase,
        );

      const Audit = () => mkPhase("audit", AspectPhase.AUDIT);
      const Event = () => mkPhase("event", { phase: AspectPhase.EVENT });
      const DefaultAsp = () => mkPhase("default", AspectPhase.DEFAULT);
      const Validation = () =>
        mkPhase("validation", { phase: AspectPhase.VALIDATION });
      const CacheLate = () =>
        mkPhase("cache-late", { phase: AspectPhase.CACHE, order: 5 });
      const CacheEarly = () =>
        mkPhase("cache-early", { phase: AspectPhase.CACHE, order: -5 });
      const Transaction = () => mkPhase("tx", AspectPhase.TRANSACTION);
      const Lock = () => mkPhase("lock", { phase: AspectPhase.LOCK });
      const RateLimit = () => mkPhase("rate-limit", AspectPhase.RATE_LIMIT);
      const Resilience = () =>
        mkPhase("resilience", { phase: AspectPhase.RESILIENCE });
      const Observability = () =>
        mkPhase("observability", AspectPhase.OBSERVABILITY);

      @Injectable()
      class OrderService {
        // Deliberately stacked in scrambled order
        @Audit()
        @CacheLate()
        @DefaultAsp()
        @Transaction()
        @Event()
        @Validation()
        @Observability()
        @Lock()
        @CacheEarly()
        @RateLimit()
        @Resilience()
        placeOrder(id: string): string {
          trace.push(`exec:${id}`);
          return `ok:${id}`;
        }
      }

      @Module({ providers: [OrderService] })
      class PhaseTestModule {}

      const ctx = await BunestFactory.createApplicationContext(
        PhaseTestModule,
        { logger: false },
      );
      try {
        const svc = ctx.get(OrderService);
        // Synchronous chain stays 100% synchronous
        const result = svc.placeOrder("ord-1");
        expect(result).toBe("ok:ord-1");

        expect(trace).toEqual([
          "enter:observability",
          "enter:resilience",
          "enter:rate-limit",
          "enter:lock",
          "enter:tx",
          "enter:cache-early",
          "enter:cache-late",
          "enter:validation",
          "enter:default",
          "enter:event",
          "enter:audit",
          "exec:ord-1",
          "exit:audit",
          "exit:event",
          "exit:default",
          "exit:validation",
          "exit:cache-late",
          "exit:cache-early",
          "exit:tx",
          "exit:lock",
          "exit:rate-limit",
          "exit:resilience",
          "exit:observability",
        ]);
      } finally {
        await ctx.close();
      }
    });
  });

  describe("defineAspectPipeline", () => {
    it("composes decorators and declarative specs into a reusable class/method decorator preserving phase and declaration order", async () => {
      const trace: string[] = [];
      const CACHE_TOKEN = Symbol("PIPELINE_CACHE");

      @Injectable()
      class TracingAspect implements MethodAspectHandler<{ span: string }> {
        intercept(ctx: MethodAspectContext<{ span: string }>) {
          trace.push(`trace:start:${ctx.options.span}:${String(ctx.methodName)}`);
          const res = ctx.proceed();
          trace.push(`trace:end:${ctx.options.span}:${String(ctx.methodName)}`);
          return res;
        }
      }

      const cacheMap = new Map<string, unknown>();
      const cacheAspectHandler: MethodAspectHandler<{ keyPrefix: string }> = {
        intercept(ctx: MethodAspectContext<{ keyPrefix: string }>) {
          const k = `${ctx.options.keyPrefix}:${String(ctx.args[0])}`;
          if (cacheMap.has(k)) {
            trace.push(`cache:hit:${k}`);
            return cacheMap.get(k);
          }
          trace.push(`cache:miss:${k}`);
          const res = ctx.proceed();
          cacheMap.set(k, res);
          return res;
        },
      };

      const WithAudit = (tag: string) =>
        createMethodAspectDecorator(
          (ctx: MethodAspectContext<{ tag: string }>) => {
            trace.push(`audit:${ctx.options.tag}`);
            return ctx.proceed();
          },
          { tag },
          AspectPhase.AUDIT,
        );

      const WithSamePhaseA = () =>
        createMethodAspectDecorator((ctx: MethodAspectContext) => {
          trace.push("same:A");
          return ctx.proceed();
        });
      const WithSamePhaseB = () =>
        createMethodAspectDecorator((ctx: MethodAspectContext) => {
          trace.push("same:B");
          return ctx.proceed();
        });

      // Static pipeline (mixed decorator + spec objects, out-of-order phases)
      const StandardReadPipeline = defineAspectPipeline([
        WithAudit("read"),
        {
          token: CACHE_TOKEN,
          options: { keyPrefix: "std" },
          phase: AspectPhase.CACHE,
        },
        {
          token: TracingAspect,
          options: { span: "read-span" },
          phase: AspectPhase.OBSERVABILITY,
        },
      ]);

      // Parameterized pipeline factory
      const CachedCommandPipeline = defineAspectPipeline(
        (opts: { span: string; cacheKey: string }) => [
          WithSamePhaseA(),
          WithSamePhaseB(),
          {
            token: CACHE_TOKEN,
            options: { keyPrefix: opts.cacheKey },
            phase: AspectPhase.CACHE,
          },
          {
            token: TracingAspect,
            options: { span: opts.span },
            phase: AspectPhase.OBSERVABILITY,
          },
        ],
      );

      // Nested pipelines
      const NestedInner = defineAspectPipeline([WithSamePhaseB()]);
      const NestedOuter = defineAspectPipeline([WithSamePhaseA(), NestedInner]);

      @Injectable()
      @StandardReadPipeline
      class ClassPipelinedService {
        fetchItem(id: string): string {
          trace.push(`exec:fetchItem:${id}`);
          return `item:${id}`;
        }
      }

      @Injectable()
      class MethodPipelinedService {
        @CachedCommandPipeline({ span: "cmd-span", cacheKey: "cmd" })
        runCommand(id: string): string {
          trace.push(`exec:runCommand:${id}`);
          return `cmd:${id}`;
        }

        @NestedOuter
        nested(id: string): string {
          trace.push(`exec:nested:${id}`);
          return id;
        }
      }

      @Module({
        providers: [
          TracingAspect,
          { provide: CACHE_TOKEN, useValue: cacheAspectHandler },
          ClassPipelinedService,
          MethodPipelinedService,
        ],
      })
      class PipelineModule {}

      const ctx = await BunestFactory.createApplicationContext(PipelineModule, {
        logger: false,
      });
      try {
        const classSvc = ctx.get(ClassPipelinedService);
        expect(classSvc.fetchItem("42")).toBe("item:42");
        expect(classSvc.fetchItem("42")).toBe("item:42");
        expect(trace).toEqual([
          "trace:start:read-span:fetchItem",
          "cache:miss:std:42",
          "audit:read",
          "exec:fetchItem:42",
          "trace:end:read-span:fetchItem",
          "trace:start:read-span:fetchItem",
          "cache:hit:std:42",
          "trace:end:read-span:fetchItem",
        ]);

        trace.length = 0;
        const methodSvc = ctx.get(MethodPipelinedService);
        expect(methodSvc.runCommand("99")).toBe("cmd:99");
        expect(trace).toEqual([
          "trace:start:cmd-span:runCommand",
          "cache:miss:cmd:99",
          "same:A",
          "same:B",
          "exec:runCommand:99",
          "trace:end:cmd-span:runCommand",
        ]);

        trace.length = 0;
        expect(methodSvc.nested("x")).toBe("x");
        expect(trace).toEqual(["same:A", "same:B", "exec:nested:x"]);
      } finally {
        await ctx.close();
      }
    });
  });

  describe("createTypedAspect (typed args/proceed & asyncOnly compile-time constraint)", () => {
    it("provides strongly-typed args, options, proceed override, and enforces asyncOnly at compile time", async () => {
      const log: string[] = [];

      const NormalizeEmail = createTypedAspect<
        [email: string, domainSuffix?: string],
        string
      >({
        phase: AspectPhase.VALIDATION,
        intercept(ctx) {
          const [rawEmail, suffix] = ctx.args;
          const normalized = rawEmail.trim().toLowerCase();
          log.push(`normalize:${normalized}`);
          return suffix !== undefined
            ? ctx.proceed(normalized, suffix)
            : ctx.proceed(normalized);
        },
      });

      const AsyncRetry = createTypedAspect<
        readonly unknown[],
        unknown,
        { maxAttempts: number }
      >({
        asyncOnly: true,
        phase: AspectPhase.RESILIENCE,
        async intercept(ctx) {
          let lastError: unknown;
          for (let attempt = 1; attempt <= ctx.options.maxAttempts; attempt++) {
            log.push(`attempt:${attempt}:${String(ctx.methodName)}`);
            try {
              return await ctx.proceed();
            } catch (err) {
              lastError = err;
            }
          }
          throw lastError;
        },
      });

      // Compile-time safety verification: asyncOnly rejects sync methods,
      // and tuple-typed aspects reject incompatible parameter/return signatures.
      // biome-ignore lint/correctness/noUnusedVariables: compile-time type verification fixture
      class _TypeCheckFixtures {
        // @ts-expect-error asyncOnly aspect must reject synchronous return types
        @AsyncRetry({ maxAttempts: 2 })
        syncNotAllowed(x: string): string {
          return x;
        }

        // @ts-expect-error tuple-typed aspect must reject incompatible arg type
        @NormalizeEmail()
        wrongArgType(count: number): string {
          return String(count);
        }

        // @ts-expect-error tuple-typed aspect must reject incompatible return type
        @NormalizeEmail()
        wrongReturnType(email: string): number {
          return email.length;
        }
      }
      void _TypeCheckFixtures;

      @Injectable()
      class AccountService {
        private calls = 0;

        @NormalizeEmail()
        formatAccount(email: string, domainSuffix?: string): string {
          return domainSuffix ? `${email}@${domainSuffix}` : email;
        }

        @AsyncRetry({ maxAttempts: 3 })
        async flakyLookup(id: string): Promise<string> {
          this.calls += 1;
          if (this.calls < 3) {
            throw new Error(`transient-${this.calls}`);
          }
          return `found:${id}`;
        }
      }

      @Module({ providers: [AccountService] })
      class TypedAspectModule {}

      const ctx = await BunestFactory.createApplicationContext(
        TypedAspectModule,
        { logger: false },
      );
      try {
        const svc = ctx.get(AccountService);

        // Synchronous typed aspect preserves synchronous return (no Promise)
        const formatted = svc.formatAccount("  Ada@Acme.IO  ");
        expect(formatted).toBe("ada@acme.io");

        // Async-only typed aspect retries cleanly
        const found = await svc.flakyLookup("user-7");
        expect(found).toBe("found:user-7");

        expect(log).toEqual([
          "normalize:ada@acme.io",
          "attempt:1:flakyLookup",
          "attempt:2:flakyLookup",
          "attempt:3:flakyLookup",
        ]);
      } finally {
        await ctx.close();
      }
    });

    it("supports DI token + defaultOptions in createTypedAspect and throws if neither token nor intercept is given", async () => {
      expect(() => createTypedAspect({} as never)).toThrow(TypeError);

      const MULTIPLIER_ASPECT = Symbol("MULTIPLIER_ASPECT");
      const MultiplyResult = createTypedAspect<
        [n: number],
        number,
        { factor: number } | undefined
      >({
        token: MULTIPLIER_ASPECT,
        phase: AspectPhase.DEFAULT,
        defaultOptions: { factor: 2 },
      });

      @Injectable()
      class MathService {
        @MultiplyResult()
        doubleBase(n: number): number {
          return n + 1;
        }

        @MultiplyResult({ factor: 10 })
        tenTimesBase(n: number): number {
          return n + 1;
        }
      }

      @Module({
        providers: [
          MathService,
          {
            provide: MULTIPLIER_ASPECT,
            useValue: {
              intercept(ctx: MethodAspectContext<{ factor: number }>) {
                return (ctx.proceed() as number) * ctx.options.factor;
              },
            },
          },
        ],
      })
      class TypedDiModule {}

      const ctx = await BunestFactory.createApplicationContext(TypedDiModule, {
        logger: false,
      });
      try {
        const math = ctx.get(MathService);
        expect(math.doubleBase(4)).toBe(10);
        expect(math.tenTimesBase(4)).toBe(50);
      } finally {
        await ctx.close();
      }
    });
  });

  describe("Declarative Pointcuts (AopModule.forRoot, forFeature & registerGlobalPointcuts)", () => {
    it("weaves matching classes/methods via className, methodName, excludeMethods, metadataKey, predicate, and composes phases with decorators", async () => {
      const trace: string[] = [];
      const AUDITED_META = Symbol("AUDITED_META");

      @Injectable()
      class MetricsPointcutAspect
        implements MethodAspectHandler<{ metric: string }>
      {
        intercept(ctx: MethodAspectContext<{ metric: string }>) {
          trace.push(
            `metric:${ctx.options.metric}:${ctx.targetClass.name}.${String(ctx.methodName)}`,
          );
          return ctx.proceed();
        }
      }

      const MethodCacheDecorator = () =>
        createMethodAspectDecorator(
          (ctx: MethodAspectContext) => {
            trace.push(`decorator:cache:${String(ctx.methodName)}`);
            return ctx.proceed();
          },
          undefined,
          AspectPhase.CACHE,
        );

      const auditPointcutFn = (ctx: MethodAspectContext<{ source: string }>) => {
        trace.push(`pointcut:audit:${ctx.options.source}:${String(ctx.methodName)}`);
        return ctx.proceed();
      };

      @Injectable()
      class BillingService {
        @MethodCacheDecorator()
        createInvoice(amount: number): string {
          trace.push(`exec:createInvoice:${amount}`);
          return `inv:${amount}`;
        }

        @SetMetadata(AUDITED_META, true)
        refundInvoice(id: string): string {
          trace.push(`exec:refundInvoice:${id}`);
          return `refund:${id}`;
        }

        healthCheck(): string {
          trace.push("exec:healthCheck");
          return "healthy";
        }
      }

      @Injectable()
      class UnmatchedHelper {
        ping(): string {
          return "pong";
        }
      }

      const pointcuts: PointcutRule[] = [
        {
          name: "service-metrics",
          match: {
            className: "*Service",
            excludeMethods: ["healthCheck"],
          },
          aspects: [
            {
              token: MetricsPointcutAspect,
              options: { metric: "svc_calls" },
              phase: AspectPhase.OBSERVABILITY,
            },
          ],
        },
        {
          name: "audited-metadata",
          match: {
            metadataKey: AUDITED_META,
          },
          aspects: [
            {
              token: auditPointcutFn,
              options: { source: "meta" },
              phase: AspectPhase.AUDIT,
            },
          ],
        },
        {
          name: "create-mutations-predicate",
          match: {
            methodName: /^create/,
            predicate: (target, method) =>
              target === BillingService && method === "createInvoice",
          },
          aspects: [
            {
              token: (ctx: MethodAspectContext) => {
                trace.push(`pointcut:tx:${String(ctx.methodName)}`);
                return ctx.proceed();
              },
              phase: AspectPhase.TRANSACTION,
            },
          ],
        },
      ];

      @Module({
        imports: [
          AopModule.forRoot({
            pointcuts,
            providers: [MetricsPointcutAspect],
          }),
        ],
        providers: [BillingService, UnmatchedHelper],
      })
      class PointcutAppModule {}

      const ctx = await BunestFactory.createApplicationContext(
        PointcutAppModule,
        { logger: false },
      );
      try {
        // AOP_POINTCUTS_TOKEN is also inspectable from DI
        expect(ctx.get(AOP_POINTCUTS_TOKEN)).toHaveLength(3);

        const billing = ctx.get(BillingService);

        // createInvoice matches: OBSERVABILITY (pointcut) -> TRANSACTION (pointcut) -> CACHE (decorator) -> exec
        expect(billing.createInvoice(100)).toBe("inv:100");
        expect(trace).toEqual([
          "metric:svc_calls:BillingService.createInvoice",
          "pointcut:tx:createInvoice",
          "decorator:cache:createInvoice",
          "exec:createInvoice:100",
        ]);

        // refundInvoice matches: OBSERVABILITY (pointcut) -> AUDIT (metadataKey pointcut) -> exec
        trace.length = 0;
        expect(billing.refundInvoice("inv-1")).toBe("refund:inv-1");
        expect(trace).toEqual([
          "metric:svc_calls:BillingService.refundInvoice",
          "pointcut:audit:meta:refundInvoice",
          "exec:refundInvoice:inv-1",
        ]);

        // healthCheck is in excludeMethods -> NOT wrapped at all!
        trace.length = 0;
        expect(billing.healthCheck()).toBe("healthy");
        expect(trace).toEqual(["exec:healthCheck"]);
        expect(
          Object.prototype.hasOwnProperty.call(billing, "healthCheck"),
        ).toBe(false);

        // UnmatchedHelper has zero wrapping overhead (no own property override)
        const helper = ctx.get(UnmatchedHelper);
        expect(helper.ping()).toBe("pong");
        expect(Object.prototype.hasOwnProperty.call(helper, "ping")).toBe(
          false,
        );
      } finally {
        await ctx.close();
      }
    });

    it("enforces module-scoped pointcuts via AopModule.forFeature() without leaking to sibling modules", async () => {
      const trace: string[] = [];

      const scopedAspect = (ctx: MethodAspectContext) => {
        trace.push(`scoped:${ctx.targetClass.name}.${String(ctx.methodName)}`);
        return ctx.proceed();
      };

      @Injectable()
      class ScopedPaymentsService {
        charge(): string {
          return "charged";
        }
      }

      @Injectable()
      class IsolatedCatalogService {
        list(): string {
          return "items";
        }
      }

      @Module({
        imports: [
          AopModule.forFeature({
            pointcuts: [
              {
                name: "payments-only",
                match: { className: /Service$/ },
                aspects: [{ token: scopedAspect, phase: AspectPhase.AUDIT }],
              },
            ],
          }),
        ],
        providers: [ScopedPaymentsService],
        exports: [ScopedPaymentsService],
      })
      class PaymentsModule {}

      @Module({
        providers: [IsolatedCatalogService],
        exports: [IsolatedCatalogService],
      })
      class CatalogModule {}

      @Module({
        imports: [PaymentsModule, CatalogModule],
      })
      class ScopedRootModule {}

      const ctx = await BunestFactory.createApplicationContext(
        ScopedRootModule,
        { logger: false },
      );
      try {
        expect(ctx.get(ScopedPaymentsService).charge()).toBe("charged");
        expect(ctx.get(IsolatedCatalogService).list()).toBe("items");

        expect(trace).toEqual(["scoped:ScopedPaymentsService.charge"]);
        expect(
          Object.prototype.hasOwnProperty.call(
            ctx.get(IsolatedCatalogService),
            "list",
          ),
        ).toBe(false);
      } finally {
        await ctx.close();
      }
    });

    it("supports registerGlobalPointcuts, useFactory AOP_POINTCUTS_TOKEN, Proxy-backed factory providers, self-recursion guard, and WeakMap O(1) caching", async () => {
      const trace: string[] = [];
      let predicateChecksForPlain = 0;

      @Injectable()
      class CatchAllAspect implements MethodAspectHandler {
        intercept(ctx: MethodAspectContext) {
          trace.push(`global:${ctx.targetClass.name}.${String(ctx.methodName)}`);
          return ctx.proceed();
        }
      }

      @Injectable({ scope: Scope.TRANSIENT })
      class PlainTransientBean {
        noop(): string {
          return "noop";
        }
      }

      abstract class DynamicOrderRepository {
        abstract findByCode(code: string): string;
      }

      const dispose = registerGlobalPointcuts({
        name: "catch-all-repo-and-aspect-safe",
        match: {
          className: (name) => {
            if (name === "PlainTransientBean") {
              predicateChecksForPlain += 1;
            }
            return (
              name === "DynamicOrderRepository" || name === "CatchAllAspect"
            );
          },
        },
        aspects: [{ token: CatchAllAspect, phase: AspectPhase.OBSERVABILITY }],
      });

      @Module({
        providers: [
          CatchAllAspect,
          PlainTransientBean,
          {
            provide: DynamicOrderRepository,
            useFactory: () =>
              new Proxy(
                {},
                {
                  get(_target, prop) {
                    if (prop === "findByCode") {
                      return (code: string) => `order:${code}`;
                    }
                    return undefined;
                  },
                },
              ),
          },
        ],
      })
      class GlobalPointcutModule {}

      const ctx = await BunestFactory.createApplicationContext(
        GlobalPointcutModule,
        { logger: false },
      );
      try {
        // Proxy-backed factory provider with synthesized method is woven cleanly
        const repo = ctx.get(DynamicOrderRepository);
        expect(repo.findByCode("X1")).toBe("order:X1");
        expect(trace).toEqual(["global:DynamicOrderRepository.findByCode"]);

        // WeakMap fast-path: resolving TRANSIENT unmatched class multiple times
        // evaluates the pointcut className predicate at most once!
        await ctx.resolve(PlainTransientBean);
        await ctx.resolve(PlainTransientBean);
        await ctx.resolve(PlainTransientBean);
        expect(predicateChecksForPlain).toBe(1);

        // Unregistering via dispose & unregisterGlobalPointcut works cleanly
        dispose();
        expect(unregisterGlobalPointcut("non-existent")).toBe(false);
      } finally {
        await ctx.close();
      }

      // Dynamic useFactory AOP_POINTCUTS_TOKEN provider
      const factoryTrace: string[] = [];

      @Injectable()
      class FactoryTargetService {
        compute(): number {
          return 7;
        }
      }

      @Module({
        providers: [
          {
            provide: AOP_POINTCUTS_TOKEN,
            useFactory: (): PointcutRule[] => [
              {
                name: "factory-rule",
                match: { className: "FactoryTargetService" },
                aspects: [
                  {
                    token: (c: MethodAspectContext) => {
                      factoryTrace.push(String(c.methodName));
                      return (c.proceed() as number) * 3;
                    },
                  },
                ],
              },
            ],
          },
          FactoryTargetService,
        ],
      })
      class FactoryPointcutModule {}

      const factoryCtx = await BunestFactory.createApplicationContext(
        FactoryPointcutModule,
        { logger: false },
      );
      try {
        expect(factoryCtx.get(FactoryTargetService).compute()).toBe(21);
        expect(factoryTrace).toEqual(["compute"]);
      } finally {
        await factoryCtx.close();
      }
    });

    it("keeps getMethodAspects metadata introspection 100% consistent for phase decorators", () => {
      const TOK_A = Symbol("A");
      const TOK_B = Symbol("B");

      const DecA = () =>
        createMethodAspectDecorator(TOK_A, undefined, AspectPhase.AUDIT);
      const DecB = () =>
        createMethodAspectDecorator(TOK_B, undefined, {
          phase: AspectPhase.OBSERVABILITY,
        });

      class Sample {
        @DecA()
        @DecB()
        run() {}
      }

      expect(getMethodAspects(Sample, "run").map((m) => m.token)).toEqual([
        TOK_B,
        TOK_A,
      ]);
    });

    it("supports class-level metadataKey pointcuts, methodName wildcard globs, and zero-arg/optional defineAspectPipeline factories", async () => {
      const trace: string[] = [];
      const TRACKED_CLASS = Symbol("TRACKED_CLASS");

      const ZeroArgPipe = defineAspectPipeline(() => [
        {
          token: (ctx: MethodAspectContext) => {
            trace.push(`zero:${String(ctx.methodName)}`);
            return ctx.proceed();
          },
          phase: AspectPhase.EVENT,
        },
      ]);

      const OptionalArgPipe = defineAspectPipeline(
        (opts?: { label?: string }) => [
          {
            token: (ctx: MethodAspectContext<{ label: string }>) => {
              trace.push(`opt:${ctx.options.label}:${String(ctx.methodName)}`);
              return ctx.proceed();
            },
            options: { label: opts?.label ?? "default" },
            phase: AspectPhase.VALIDATION,
          },
        ],
      );

      @Injectable()
      @SetMetadata(TRACKED_CLASS, true)
      class TrackedInventoryRepo {
        @ZeroArgPipe()
        @OptionalArgPipe()
        findBySku(sku: string): string {
          return `sku:${sku}`;
        }

        @OptionalArgPipe({ label: "custom" })
        findAllActive(): string[] {
          return ["a", "b"];
        }

        internalCleanup(): string {
          return "cleaned";
        }
      }

      @Module({
        imports: [
          AopModule.forRoot({
            pointcuts: [
              {
                name: "class-meta-find-glob",
                match: {
                  metadataKey: TRACKED_CLASS,
                  methodName: "find*",
                },
                aspects: [
                  {
                    token: (ctx: MethodAspectContext) => {
                      trace.push(`pc:${String(ctx.methodName)}`);
                      return ctx.proceed();
                    },
                    phase: AspectPhase.OBSERVABILITY,
                  },
                ],
              },
            ],
          }),
        ],
        providers: [TrackedInventoryRepo],
      })
      class MetaGlobModule {}

      const ctx = await BunestFactory.createApplicationContext(MetaGlobModule, {
        logger: false,
      });
      try {
        const repo = ctx.get(TrackedInventoryRepo);
        expect(repo.findBySku("SKU-1")).toBe("sku:SKU-1");
        expect(repo.findAllActive()).toEqual(["a", "b"]);
        expect(repo.internalCleanup()).toBe("cleaned");

        // internalCleanup did NOT match `find*` -> not wrapped
        expect(
          Object.prototype.hasOwnProperty.call(repo, "internalCleanup"),
        ).toBe(false);

        expect(trace).toEqual([
          "pc:findBySku",
          "opt:default:findBySku",
          "zero:findBySku",
          "pc:findAllActive",
          "opt:custom:findAllActive",
        ]);
      } finally {
        await ctx.close();
      }
    });
  });
});
