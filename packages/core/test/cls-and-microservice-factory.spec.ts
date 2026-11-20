import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import {
  Controller,
  Get,
  Injectable,
  Module,
  SetMetadata,
  UseInterceptors,
  type BunestModule,
  type MiddlewareConsumer,
  type MicroserviceInstance,
  type OnModuleDestroy,
} from "@bunest/common";
import {
  BunestFactory,
  ClsInterceptor,
  ClsMiddleware,
  ClsModule,
  ClsService,
  DiscoveryService,
} from "../src";

describe("ClsModule / ClsService & BunestFactory.createMicroservice & DiscoveryService helpers", () => {
  it("isolates ClsService state across 30 concurrent HTTP requests via ClsMiddleware", async () => {
    @Injectable()
    class AuditService {
      constructor(private readonly cls: ClsService) {}

      async readContext() {
        await Bun.sleep(Math.floor(Math.random() * 8) + 1);
        return {
          id: this.cls.getId(),
          tenant: this.cls.get<string>("tenant"),
          active: this.cls.isActive(),
        };
      }
    }

    @Controller("cls")
    class ClsController {
      constructor(
        private readonly cls: ClsService,
        private readonly audit: AuditService,
      ) {}

      @Get()
      async check() {
        return this.audit.readContext();
      }
    }

    @Module({
      imports: [
        ClsModule.forRoot({
          global: true,
          setup: (cls, req) => {
            cls.set("tenant", req?.headers.get("x-tenant") ?? "default");
          },
        }),
      ],
      controllers: [ClsController],
      providers: [AuditService],
    })
    class ClsAppModule implements BunestModule {
      configure(consumer: MiddlewareConsumer) {
        consumer.apply(ClsMiddleware).forRoutes("*");
      }
    }

    const app = await BunestFactory.create(ClsAppModule, { logger: false });
    try {
      const results = await Promise.all(
        Array.from({ length: 30 }, (_, i) =>
          app
            .inject({
              url: "/cls",
              headers: {
                "x-request-id": `req-${i}`,
                "x-tenant": `tenant-${i}`,
              },
            })
            .then((res) => ({
              expectedId: `req-${i}`,
              expectedTenant: `tenant-${i}`,
              body: res.json<{ id: string; tenant: string; active: boolean }>(),
            })),
        ),
      );

      for (const r of results) {
        expect(r.body).toEqual({
          id: r.expectedId,
          tenant: r.expectedTenant,
          active: true,
        });
      }

      const cls = app.get(ClsService);
      expect(cls.isActive()).toBe(false);
      expect(() => cls.set("k", "v")).toThrow();
      const inside = cls.run(() => {
        expect(cls.setIfUndefined("a", 1)).toBe(true);
        expect(cls.setIfUndefined("a", 2)).toBe(false);
        return cls.get<number>("a");
      });
      expect(inside).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("supports ClsInterceptor without middleware", async () => {
    @Controller("cls-int")
    @UseInterceptors(ClsInterceptor)
    class ClsIntController {
      constructor(private readonly cls: ClsService) {}

      @Get()
      check() {
        this.cls.set("step", "controller");
        return { active: this.cls.isActive(), step: this.cls.get("step") };
      }
    }

    @Module({
      imports: [ClsModule.forRoot()],
      controllers: [ClsIntController],
    })
    class AppMod {}

    const app = await BunestFactory.create(AppMod, { logger: false });
    try {
      const res = await app.inject("/cls-int");
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ active: true, step: "controller" });
    } finally {
      await app.close();
    }
  });

  it("bootstraps standalone microservice via BunestFactory.createMicroservice() with full lifecycle", async () => {
    const events: string[] = [];

    @Injectable()
    class WorkerService implements OnModuleDestroy {
      getName() {
        return "orders-worker";
      }
      onModuleDestroy() {
        events.push("worker:destroy");
      }
    }

    @Module({ providers: [WorkerService], exports: [WorkerService] })
    class WorkerModule {}

    const ms = await BunestFactory.createMicroservice(
      WorkerModule,
      (ctx): MicroserviceInstance => {
        const svc = ctx.get(WorkerService);
        return {
          async listen() {
            events.push(`listen:${svc.getName()}`);
          },
          async close() {
            events.push(`close:${svc.getName()}`);
          },
        };
      },
      { logger: false },
    );

    await ms.listen();
    await ms.listen(); // idempotent
    expect(events).toEqual(["listen:orders-worker"]);

    await ms.close();
    expect(events).toEqual([
      "listen:orders-worker",
      "close:orders-worker",
      "worker:destroy",
    ]);
  });

  it("exposes DiscoveryService metadata helpers and resolveEnhancer()", async () => {
    const TAG = Symbol("custom:tag");

    @SetMetadata(TAG, "billing")
    @Injectable()
    class BillingService {}

    @SetMetadata(TAG, "billing-ctrl")
    @Controller("billing")
    class BillingController {
      @Get()
      ping() {
        return "ok";
      }
    }

    @Injectable()
    class SampleGuard {
      constructor(public readonly billing: BillingService) {}
    }

    @Module({
      controllers: [BillingController],
      providers: [BillingService],
    })
    class AppMod {}

    const app = await BunestFactory.create(AppMod, { logger: false });
    try {
      const discovery = app.get(DiscoveryService);
      const providers = discovery.getProvidersWithMetaAtKey<string>(TAG);
      expect(providers.map((p) => p.metadata)).toEqual(["billing"]);

      const ctrls = discovery.getControllersWithMetaAtKey<string>(TAG);
      expect(ctrls.map((c) => c.metadata)).toEqual(["billing-ctrl"]);

      const guard = await discovery.resolveEnhancer(SampleGuard);
      expect(guard.billing).toBeInstanceOf(BillingService);
    } finally {
      await app.close();
    }
  });
});
