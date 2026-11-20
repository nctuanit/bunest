import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import {
  APP_FILTER,
  APP_GUARD,
  APP_INTERCEPTOR,
  APP_PIPE,
  Catch,
  Controller,
  Get,
  Global,
  Inject,
  Injectable,
  Module,
  Param,
  Post,
  UseFilters,
  UseGuards,
  UseInterceptors,
  UsePipes,
  type ArgumentsHost,
  type BunestInterceptor,
  type CallHandler,
  type CanActivate,
  type DynamicModule,
  type ExceptionFilter,
  type ExecutionContext,
  type PipeTransform,
} from "@bunest/common";
import { Test, createAutoMocker, request, type MockFunction } from "../../src";

describe("E2E: DI Overrides (overrideModule, useMocker, decorator / APP_* / useGlobal* enhancers)", () => {
  it("runs HTTP requests against overrideModule()-replaced static, @Global, and DynamicModule providers", async () => {
    const PAYMENT_KEY = Symbol("PAYMENT_KEY");

    @Injectable()
    class RealGateway {
      charge(amount: number) {
        return { gateway: "stripe-live", amount };
      }
    }

    @Global()
    @Module({
      providers: [
        RealGateway,
        { provide: PAYMENT_KEY, useValue: "sk_live_danger" },
      ],
      exports: [RealGateway, PAYMENT_KEY],
    })
    class LivePaymentModule {}

    @Global()
    @Module({
      providers: [
        {
          provide: RealGateway,
          useValue: {
            charge: (amount: number) => ({ gateway: "sandbox-mock", amount }),
          },
        },
        { provide: PAYMENT_KEY, useValue: "sk_test_safe" },
      ],
      exports: [RealGateway, PAYMENT_KEY],
    })
    class SandboxPaymentModule {}

    const FEATURE_FLAG = Symbol("FEATURE_FLAG");

    @Module({})
    class FlagsModule {
      static forRoot(enabled: boolean): DynamicModule {
        return {
          module: FlagsModule,
          providers: [{ provide: FEATURE_FLAG, useValue: enabled }],
          exports: [FEATURE_FLAG],
        };
      }
    }

    @Controller("/checkout")
    class CheckoutController {
      constructor(
        private readonly gateway: RealGateway,
        @Inject(PAYMENT_KEY) private readonly key: string,
        @Inject(FEATURE_FLAG) private readonly promoEnabled: boolean,
      ) {}

      @Post("pay/:amount")
      pay(@Param("amount") amount: string) {
        return {
          ...this.gateway.charge(Number(amount)),
          keyPrefix: this.key.slice(0, 7),
          promoEnabled: this.promoEnabled,
        };
      }
    }

    @Module({
      imports: [LivePaymentModule, FlagsModule.forRoot(false)],
      controllers: [CheckoutController],
    })
    class AppModule {}

    const mod = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideModule(LivePaymentModule)
      .useModule(SandboxPaymentModule)
      .overrideModule(FlagsModule)
      .useModule(FlagsModule.forRoot(true))
      .compile();

    const app = mod.createNestApplication();
    await app.init();

    try {
      await request(app).post("/checkout/pay/500").expect(201, {
        gateway: "sandbox-mock",
        amount: 500,
        keyPrefix: "sk_test",
        promoEnabled: true,
      });
    } finally {
      await mod.close();
    }
  });

  it("runs full HTTP controller E2E with useMocker(createAutoMocker()) spying on unregistered downstream services", async () => {
    @Injectable()
    class InventoryClient {
      async reserve(_sku: string, _qty: number): Promise<{ reserved: boolean }> {
        throw new Error("Should never hit real inventory network");
      }
    }

    @Injectable()
    class NotificationClient {
      notify(_msg: string): void {
        throw new Error("Should never send real notifications");
      }
    }

    @Controller("/orders")
    class OrdersController {
      constructor(
        private readonly inventory: InventoryClient,
        private readonly notifications: NotificationClient,
      ) {}

      @Post(":sku")
      async place(@Param("sku") sku: string) {
        const res = await this.inventory.reserve(sku, 2);
        this.notifications.notify(`ordered:${sku}`);
        return { sku, ...res };
      }
    }

    const mod = await Test.createTestingModule({
      controllers: [OrdersController],
    })
      .useMocker(createAutoMocker())
      .compile();

    const app = mod.createNestApplication();
    await app.init();

    try {
      const invMock = mod.get<
        InventoryClient,
        InventoryClient & { reserve: MockFunction }
      >(InventoryClient);
      const notifMock = mod.get<
        NotificationClient,
        NotificationClient & { notify: MockFunction }
      >(NotificationClient);

      invMock.reserve.mockResolvedValue({ reserved: true });

      await request(app)
        .post("/orders/SKU-99")
        .expect(201, { sku: "SKU-99", reserved: true });

      expect(invMock.reserve.calls).toEqual([["SKU-99", 2]]);
      expect(notifMock.notify.calls).toEqual([["ordered:SKU-99"]]);
    } finally {
      await mod.close();
    }
  });

  it("overrides decorator-level, APP_* DI-global, and imperative useGlobal* enhancers cleanly in one HTTP app and preserves APP_* -> useGlobal* ordering", async () => {
    const executionLog: string[] = [];
    const PRIVATE_CFG = Symbol("PRIVATE_CFG");

    // 1. APP_* global enhancers
    @Injectable()
    class RealAppGuard implements CanActivate {
      canActivate() {
        return false;
      }
    }

    @Injectable()
    class RealAppInterceptor implements BunestInterceptor {
      async intercept(_ctx: ExecutionContext, next: CallHandler) {
        return next.handle();
      }
    }

    class AppErr extends Error {}
    @Catch(AppErr)
    @Injectable()
    class RealAppFilter implements ExceptionFilter<AppErr> {
      catch() {
        return Response.json({ filter: "real-app" }, { status: 500 });
      }
    }

    // 2. Imperative useGlobal* enhancers
    @Injectable()
    class ImperativeGuard implements CanActivate {
      canActivate() {
        return false;
      }
    }

    @Injectable()
    class ImperativePipe implements PipeTransform<string, string> {
      transform(v: string) {
        return v;
      }
    }

    @Injectable()
    class ImperativeInterceptor implements BunestInterceptor {
      async intercept(_ctx: ExecutionContext, next: CallHandler) {
        return next.handle();
      }
    }

    class ImpErr extends Error {}
    @Catch(ImpErr)
    @Injectable()
    class ImperativeFilter implements ExceptionFilter<ImpErr> {
      catch() {
        return Response.json({ filter: "real-imp" }, { status: 500 });
      }
    }

    // 3. Decorator-level enhancers
    @Injectable()
    class RouteGuard implements CanActivate {
      canActivate() {
        return false;
      }
    }

    @Injectable()
    class RoutePipe implements PipeTransform<string, string> {
      transform(v: string) {
        return v;
      }
    }

    @Injectable()
    class RouteInterceptor implements BunestInterceptor {
      async intercept(_ctx: ExecutionContext, next: CallHandler) {
        return next.handle();
      }
    }

    class RouteErr extends Error {}
    @Catch(RouteErr)
    @Injectable()
    class RouteFilter implements ExceptionFilter<RouteErr> {
      catch() {
        return Response.json({ filter: "real-route" }, { status: 500 });
      }
    }

    @Controller("/layers")
    @UseGuards(RouteGuard)
    @UseInterceptors(RouteInterceptor)
    @UseFilters(RouteFilter)
    class LayersController {
      @Get("item/:id")
      @UsePipes(RoutePipe)
      item(@Param("id") id: string) {
        executionLog.push("handler");
        return { id };
      }

      @Get("err/app")
      errApp(): never {
        throw new AppErr("app-err");
      }

      @Get("err/imp")
      errImp(): never {
        throw new ImpErr("imp-err");
      }

      @Get("err/route")
      errRoute(): never {
        throw new RouteErr("route-err");
      }
    }

    @Module({
      controllers: [LayersController],
      providers: [
        { provide: PRIVATE_CFG, useValue: "from-private" },
        { provide: APP_GUARD, useClass: RealAppGuard },
        { provide: APP_INTERCEPTOR, useClass: RealAppInterceptor },
        { provide: APP_FILTER, useClass: RealAppFilter },
        {
          provide: APP_PIPE,
          useValue: {
            transform: (v: unknown) => {
              executionLog.push("app-pipe");
              return v;
            },
          },
        },
      ],
    })
    class LayersModule {}

    const mod = await Test.createTestingModule({
      imports: [LayersModule],
    })
      // APP_* overrides (factory using private dep)
      .overrideGuard(RealAppGuard)
      .useFactory({
        factory: (cfg: string) => ({
          canActivate: () => {
            executionLog.push(`app-guard:${cfg}`);
            return true;
          },
        }),
        inject: [PRIVATE_CFG],
      })
      .overrideInterceptor(RealAppInterceptor)
      .useValue({
        intercept: async (_ctx: ExecutionContext, next: CallHandler) => {
          executionLog.push("app-interceptor:before");
          const out = await next.handle();
          executionLog.push("app-interceptor:after");
          return out;
        },
      })
      .overrideFilter(RealAppFilter)
      .useValue({
        catch: (e: AppErr) =>
          Response.json({ layer: "app-filter", msg: e.message }, { status: 418 }),
      })
      // Imperative useGlobal* overrides
      .overrideGuard(ImperativeGuard)
      .useValue({
        canActivate: () => {
          executionLog.push("imp-guard");
          return true;
        },
      })
      .overridePipe(ImperativePipe)
      .useValue({
        transform: (v: string) => {
          executionLog.push("imp-pipe");
          return `${v}-imp`;
        },
      })
      .overrideInterceptor(ImperativeInterceptor)
      .useValue({
        intercept: async (_ctx: ExecutionContext, next: CallHandler) => {
          executionLog.push("imp-interceptor:before");
          const out = await next.handle();
          executionLog.push("imp-interceptor:after");
          return out;
        },
      })
      .overrideFilter(ImperativeFilter)
      .useValue({
        catch: (e: ImpErr) =>
          Response.json({ layer: "imp-filter", msg: e.message }, { status: 419 }),
      })
      // Decorator-level overrides
      .overrideGuard(RouteGuard)
      .useValue({
        canActivate: () => {
          executionLog.push("route-guard");
          return true;
        },
      })
      .overridePipe(RoutePipe)
      .useValue({
        transform: (v: string) => {
          executionLog.push("route-pipe");
          return `${v}-route`;
        },
      })
      .overrideInterceptor(RouteInterceptor)
      .useValue({
        intercept: async (_ctx: ExecutionContext, next: CallHandler) => {
          executionLog.push("route-interceptor:before");
          const out = await next.handle();
          executionLog.push("route-interceptor:after");
          return { final: out };
        },
      })
      .overrideFilter(RouteFilter)
      .useValue({
        catch: (e: RouteErr) =>
          Response.json({ layer: "route-filter", msg: e.message }, { status: 420 }),
      })
      .compile();

    const app = mod.createNestApplication();
    app.useGlobalGuards(ImperativeGuard);
    app.useGlobalPipes(ImperativePipe);
    app.useGlobalInterceptors(ImperativeInterceptor);
    app.useGlobalFilters(ImperativeFilter);
    await app.init();

    try {
      await request(app)
        .get("/layers/item/42")
        .expect(200, { final: { id: "42-imp-route" } });

      // Verify APP_* executes BEFORE imperative useGlobal* BEFORE route-level enhancers!
      expect(executionLog).toEqual([
        "app-guard:from-private",
        "imp-guard",
        "route-guard",
        "app-interceptor:before",
        "imp-interceptor:before",
        "route-interceptor:before",
        "app-pipe",
        "imp-pipe",
        "route-pipe",
        "handler",
        "route-interceptor:after",
        "imp-interceptor:after",
        "app-interceptor:after",
      ]);

      // Verify all 3 filter layers keep their distinct @Catch() boundaries
      await request(app)
        .get("/layers/err/app")
        .expect(418, { layer: "app-filter", msg: "app-err" });
      await request(app)
        .get("/layers/err/imp")
        .expect(419, { layer: "imp-filter", msg: "imp-err" });
      await request(app)
        .get("/layers/err/route")
        .expect(420, { layer: "route-filter", msg: "route-err" });
    } finally {
      await mod.close();
    }
  });
});
