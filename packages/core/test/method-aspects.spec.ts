import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Injectable,
  METADATA_KEYS,
  MetadataRegistry,
  Module,
  REQUEST,
  Scope,
  SetMetadata,
  UseMiddleware,
  createMethodAspectDecorator,
  type BunestMiddleware,
  type MethodAspectContext,
  type MethodAspectHandler,
  type NextFunction,
  type PipeTransform,
  type ResponseContext,
} from "@bunest/common";
import {
  BunestFactory,
  ClsModule,
  ClsService,
  ContextIdFactory,
  ExternalContextCreator,
  WithCls,
} from "../src";

describe("Core DI Method Aspect Weaver", () => {
  it("imposes zero wrapping overhead on classes without method aspects", async () => {
    @Injectable()
    class PlainService {
      add(a: number, b: number) {
        return a + b;
      }
    }

    @Module({ providers: [PlainService] })
    class PlainModule {}

    const ctx = await BunestFactory.createApplicationContext(PlainModule, {
      logger: false,
    });
    try {
      const svc = ctx.get(PlainService);
      expect(svc.add).toBe(PlainService.prototype.add);
      expect(Object.prototype.hasOwnProperty.call(svc, "add")).toBe(false);
      expect(svc.add(2, 3)).toBe(5);
    } finally {
      await ctx.close();
    }
  });

  it("weaves stacked DI, direct handler, and functional aspects in top-to-bottom outer-to-inner order with sync & async support", async () => {
    const trace: string[] = [];
    const CUSTOM_ASPECT_TOKEN = Symbol("CUSTOM_ASPECT_TOKEN");

    @Injectable()
    class PrefixProvider {
      readonly prefix = "DI";
    }

    @Injectable()
    class DiLoggingAspect implements MethodAspectHandler<{ tag: string }> {
      constructor(private readonly prefixProvider: PrefixProvider) {}

      intercept(ctx: MethodAspectContext<{ tag: string }>) {
        trace.push(`before:${this.prefixProvider.prefix}:${ctx.options.tag}`);
        const res = ctx.proceed();
        trace.push(`after:${this.prefixProvider.prefix}:${ctx.options.tag}`);
        return res;
      }
    }

    const tokenHandler: MethodAspectHandler<{ mult: number }> = {
      intercept(ctx) {
        trace.push(`before:token:${ctx.options.mult}`);
        const firstArg = ctx.args[0] as number;
        const result = ctx.proceed(firstArg * ctx.options.mult);
        trace.push(`after:token:${ctx.options.mult}`);
        return result;
      },
    };

    const fnAspect = (ctx: MethodAspectContext<{ suffix: string }>) => {
      trace.push("before:fn");
      const out = ctx.proceed();
      trace.push("after:fn");
      return `${String(out)}:${ctx.options.suffix}`;
    };

    const directInstanceAspect: MethodAspectHandler = {
      intercept(ctx) {
        trace.push("before:direct");
        const out = ctx.proceed();
        trace.push("after:direct");
        return out;
      },
    };

    const Log = (tag: string) =>
      createMethodAspectDecorator(DiLoggingAspect, { tag });
    const Scale = (mult: number) =>
      createMethodAspectDecorator(CUSTOM_ASPECT_TOKEN, { mult });
    const Append = (suffix: string) =>
      createMethodAspectDecorator(fnAspect, { suffix });
    const Direct = () => createMethodAspectDecorator(directInstanceAspect);

    @Injectable()
    class CalculatorService {
      readonly label = "calc";

      @Log("outer")
      @Scale(10)
      @Direct()
      @Append("done")
      computeSync(n: number): string {
        trace.push(`body:${this.label}:${n}`);
        return `${this.label}=${n}`;
      }

      @Log("async")
      async computeAsync(n: number): Promise<number> {
        await Bun.sleep(1);
        trace.push(`async-body:${n}`);
        return n + 1;
      }

      untouched() {
        return "raw";
      }
    }

    @Module({
      providers: [
        PrefixProvider,
        DiLoggingAspect,
        { provide: CUSTOM_ASPECT_TOKEN, useValue: tokenHandler },
        CalculatorService,
      ],
    })
    class AppMod {}

    const ctx = await BunestFactory.createApplicationContext(AppMod, {
      logger: false,
    });
    try {
      const calc = ctx.get(CalculatorService);

      // Untouched method is never wrapped
      expect(calc.untouched).toBe(CalculatorService.prototype.untouched);

      // Synchronous aspect chain stays synchronous (no Promise returned!)
      const syncResult = calc.computeSync(4);
      expect(syncResult).toBe("calc=40:done");
      expect(trace).toEqual([
        "before:DI:outer",
        "before:token:10",
        "before:direct",
        "before:fn",
        "body:calc:40",
        "after:fn",
        "after:direct",
        "after:token:10",
        "after:DI:outer",
      ]);

      // Async method works cleanly
      trace.length = 0;
      const asyncResult = await calc.computeAsync(9);
      expect(asyncResult).toBe(10);
      expect(trace).toEqual([
        "before:DI:async",
        "after:DI:async",
        "async-body:9",
      ]);
    } finally {
      await ctx.close();
    }
  });

  it("weaves aspects across TRANSIENT and REQUEST scopes and supports controller metadata preservation + retry proceed()", async () => {
    let transientCounter = 0;
    let requestCounter = 0;
    let retryAttempts = 0;

    const retryAspect: MethodAspectHandler<{ maxAttempts: number }> = {
      intercept(ctx) {
        let lastErr: unknown;
        for (let i = 0; i < ctx.options.maxAttempts; i++) {
          try {
            return ctx.proceed();
          } catch (err) {
            lastErr = err;
          }
        }
        throw lastErr;
      },
    };

    const tagAspect = (ctx: MethodAspectContext<string>) =>
      `${ctx.options}:${String(ctx.proceed())}`;

    @Injectable({ scope: Scope.TRANSIENT })
    class TransientSvc {
      readonly id = ++transientCounter;

      @createMethodAspectDecorator(tagAspect, "transient")
      identify() {
        return `t-${this.id}`;
      }
    }

    @Injectable({ scope: Scope.REQUEST })
    class RequestAspect implements MethodAspectHandler {
      constructor(@Inject(REQUEST) private readonly req: { tenant?: string }) {}

      intercept(ctx: MethodAspectContext) {
        return `${this.req?.tenant ?? "none"}:${String(ctx.proceed())}`;
      }
    }

    @Injectable({ scope: Scope.REQUEST })
    class RequestSvc {
      readonly id = ++requestCounter;

      @createMethodAspectDecorator(RequestAspect)
      describe() {
        return `r-${this.id}`;
      }
    }

    @Controller("aop")
    class AopController {
      @Get("flaky")
      @HttpCode(201)
      @SetMetadata("custom:flag", "preserved")
      @createMethodAspectDecorator(retryAspect, { maxAttempts: 3 })
      flaky() {
        retryAttempts++;
        if (retryAttempts < 3) {
          throw new Error("transient failure");
        }
        return { ok: true, attempts: retryAttempts };
      }
    }

    @Module({
      controllers: [AopController],
      providers: [TransientSvc, RequestAspect, RequestSvc],
    })
    class ScopeMod {}

    const app = await BunestFactory.create(ScopeMod, { logger: false });
    try {
      // TRANSIENT scope: distinct woven instances
      const t1 = await app.resolve(TransientSvc);
      const t2 = await app.resolve(TransientSvc);
      expect(t1).not.toBe(t2);
      expect(t1.identify()).toBe("transient:t-1");
      expect(t2.identify()).toBe("transient:t-2");

      // REQUEST scope: woven with per-request DI aspect handler
      const ctxId1 = ContextIdFactory.create();
      app.registerRequestByContextId({ tenant: "acme" }, ctxId1);
      const r1 = await app.resolve(RequestSvc, ctxId1);
      expect(r1.describe()).toBe("acme:r-1");

      const ctxId2 = ContextIdFactory.create();
      app.registerRequestByContextId({ tenant: "globex" }, ctxId2);
      const r2 = await app.resolve(RequestSvc, ctxId2);
      expect(r2.describe()).toBe("globex:r-2");

      // Controller method aspect preserves HTTP metadata and retries via multiple proceed()
      const ctrl = app.get(AopController);
      expect(MetadataRegistry.get(METADATA_KEYS.HTTP_CODE, ctrl.flaky)).toBe(201);
      expect(MetadataRegistry.get("custom:flag", ctrl.flaky)).toBe("preserved");

      const res = await app.inject("/aop/flaky");
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ ok: true, attempts: 3 });
    } finally {
      await app.close();
    }
  });

  it("throws a clear error when invoking a method with an unregistered aspect token while leaving other methods usable", async () => {
    const MISSING_ASPECT = Symbol("MISSING_ASPECT");

    @Injectable()
    class PartialService {
      @createMethodAspectDecorator(MISSING_ASPECT)
      broken() {
        return "never";
      }

      healthy() {
        return "ok";
      }
    }

    @Module({ providers: [PartialService] })
    class PartialMod {}

    const ctx = await BunestFactory.createApplicationContext(PartialMod, {
      logger: false,
    });
    try {
      const svc = ctx.get(PartialService);
      expect(svc.healthy()).toBe("ok");
      await expect(Promise.resolve(svc.broken())).rejects.toThrow(
        /not registered in the DI container/i,
      );
    } finally {
      await ctx.close();
    }
  });
});

describe("@WithCls() Method Aspect", () => {
  it("wraps non-HTTP service methods in ClsService.run() with initial state, setup, ifNotActive, and async isolation", async () => {
    @Injectable()
    class JobService {
      constructor(private readonly cls: ClsService) {}

      @WithCls({
        initial: (args) => ({ jobId: args[0] }),
        setup: (cls) => {
          cls.set("started", true);
        },
      })
      async runJob(jobId: string) {
        await Bun.sleep(Math.floor(Math.random() * 5) + 1);
        return {
          clsId: this.cls.getId(),
          jobId: this.cls.get<string>("jobId"),
          started: this.cls.get<boolean>("started"),
          active: this.cls.isActive(),
        };
      }

      @WithCls({ ifNotActive: true, initial: { fallback: true } })
      readOrStart() {
        return {
          active: this.cls.isActive(),
          outer: this.cls.get<string>("outer"),
          fallback: this.cls.get<boolean>("fallback"),
        };
      }

      @WithCls()
      syncJob(val: number): number {
        this.cls.set("v", val * 3);
        return this.cls.get<number>("v")!;
      }
    }

    @Module({
      imports: [ClsModule.forRoot({ global: true })],
      providers: [JobService],
    })
    class JobMod {}

    const ctx = await BunestFactory.createApplicationContext(JobMod, {
      logger: false,
    });
    try {
      const svc = ctx.get(JobService);
      const cls = ctx.get(ClsService);

      expect(cls.isActive()).toBe(false);

      // Sync @WithCls stays synchronous
      expect(svc.syncJob(7)).toBe(21);
      expect(cls.isActive()).toBe(false);

      // Concurrent async jobs stay completely isolated
      const results = await Promise.all(
        Array.from({ length: 15 }, (_, i) => svc.runJob(`job-${i}`)),
      );
      const uniqueIds = new Set(results.map((r) => r.clsId));
      expect(uniqueIds.size).toBe(15);
      for (let i = 0; i < 15; i++) {
        expect(results[i]).toMatchObject({
          jobId: `job-${i}`,
          started: true,
          active: true,
        });
      }

      // ifNotActive reuses active context when present, creates fresh when absent
      expect(svc.readOrStart()).toEqual({
        active: true,
        outer: undefined,
        fallback: true,
      });
      const nested = cls.run(() => {
        cls.set("outer", "parent-val");
        return svc.readOrStart();
      });
      expect(nested).toEqual({
        active: true,
        outer: "parent-val",
        fallback: undefined,
      });
    } finally {
      await ctx.close();
    }
  });
});

describe("ExternalContextCreator fixes (C5 DI param pipes & C6 proto/ctor metadata)", () => {
  it("resolves class-based parameter pipes via DI container and reads metadata from both prototype and constructor", async () => {
    const PROTO_PARAM_KEY = Symbol("ext:proto_params");
    const CTOR_PARAM_KEY = Symbol("ext:ctor_params");

    @Injectable()
    class FactorService {
      readonly factor = 100;
    }

    @Injectable()
    class DiScalePipe implements PipeTransform<number, number> {
      constructor(private readonly factors: FactorService) {}

      transform(value: number): number {
        return value * this.factors.factor;
      }
    }

    function ProtoArg(...pipes: Array<PipeTransform | (new (...a: any[]) => PipeTransform)>): ParameterDecorator {
      return (target, propertyKey, index) => {
        MetadataRegistry.define(
          PROTO_PARAM_KEY,
          { [`arg:${index}`]: { index, data: "val", pipes } },
          target,
          propertyKey!,
        );
      };
    }

    function CtorArg(...pipes: Array<PipeTransform | (new (...a: any[]) => PipeTransform)>): ParameterDecorator {
      return (target, propertyKey, index) => {
        MetadataRegistry.define(
          CTOR_PARAM_KEY,
          { [`arg:${index}`]: { index, data: "val", pipes } },
          target.constructor,
          propertyKey!,
        );
      };
    }

    @Injectable()
    class ExtTarget {
      fromProto(@ProtoArg(DiScalePipe) n: number) {
        return n + 1;
      }

      fromCtor(@CtorArg(DiScalePipe) n: number) {
        return n + 2;
      }
    }

    @Module({
      providers: [FactorService, DiScalePipe, ExtTarget],
    })
    class ExtMod {}

    const ctx = await BunestFactory.createApplicationContext(ExtMod, {
      logger: false,
    });
    try {
      const container = ctx.getModuleContainer();
      const creator = ExternalContextCreator.fromContainer(container);
      const target = ctx.get(ExtTarget);
      const factory = {
        exchangeKeyForValue: (_t: number | string, _d: unknown, args: unknown[]) =>
          args[0],
      };

      const protoFn = creator.create(
        target,
        target.fromProto as (...args: unknown[]) => unknown,
        "fromProto",
        PROTO_PARAM_KEY,
        factory,
      );
      expect(await protoFn(3)).toBe(301);

      const ctorFn = creator.create(
        target,
        target.fromCtor as (...args: unknown[]) => unknown,
        "fromCtor",
        CTOR_PARAM_KEY,
        factory,
      );
      expect(await ctorFn(4)).toBe(402);
    } finally {
      await ctx.close();
    }
  });

  it("resolves DI-injected class @UseMiddleware() on controllers and methods via BunestFactory", async () => {
    @Injectable()
    class HeaderTagService {
      readonly value = "di-mw-ok";
    }

    @Injectable()
    class DiHeaderMiddleware implements BunestMiddleware {
      constructor(private readonly tag: HeaderTagService) {}

      use(_req: Request, res: ResponseContext, next: NextFunction) {
        res.header("X-Di-Middleware", this.tag.value);
        return next();
      }
    }

    @Controller("di-mw")
    @UseMiddleware(DiHeaderMiddleware)
    class DiMwController {
      @Get("ping")
      ping() {
        return { ok: true };
      }
    }

    @Module({
      controllers: [DiMwController],
      providers: [HeaderTagService, DiHeaderMiddleware],
    })
    class DiMwMod {}

    const app = await BunestFactory.create(DiMwMod, { logger: false });
    try {
      const res = await app.inject("/di-mw/ping");
      expect(res.statusCode).toBe(200);
      expect(res.headers["x-di-middleware"]).toBe("di-mw-ok");
      expect(res.json()).toEqual({ ok: true });
    } finally {
      await app.close();
    }
  });
});
