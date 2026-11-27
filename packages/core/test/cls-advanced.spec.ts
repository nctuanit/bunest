import { describe, expect, it } from "bun:test";
import {
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
} from "../src/common/index";
import {
  BunestFactory,
  CLS_ID,
  CLS_PROXY_MARKER,
  ClsModule,
  ClsService,
  createClsProxyProvider,
} from "../src";

interface TypedRequestStore {
  tenantId: string;
  userId: number;
  roles: string[];
}

describe("ClsModule & ClsService upgrades", () => {
  it("auto-mounts ClsMiddleware in ClsModule.forRoot({ middleware: { mount: true } }) with exclude and concurrent isolation", async () => {
    @Injectable()
    class TenantReader {
      constructor(private readonly cls: ClsService) {}

      async read() {
        await Bun.sleep(Math.floor(Math.random() * 6) + 1);
        return {
          active: this.cls.isActive(),
          id: this.cls.getId(),
          tenant: this.cls.get<string>("tenant"),
          customHeader: this.cls.get<string>("mwTag"),
        };
      }
    }

    @Controller()
    class AutoMountController {
      constructor(private readonly reader: TenantReader) {}

      @Get("auto")
      auto() {
        return this.reader.read();
      }

      @Get("health")
      health() {
        return this.reader.read();
      }
    }

    @Module({
      imports: [
        ClsModule.forRoot({
          middleware: {
            mount: true,
            exclude: ["/health"],
            idGenerator: (req) =>
              `mw-${req.headers.get("x-req-id") ?? "anon"}`,
            setup: (cls, req, res) => {
              const tenant = req.headers.get("x-tenant") ?? "public";
              cls.set("tenant", tenant);
              cls.set("mwTag", "mounted");
              res.header("x-cls-id", cls.getId() ?? "");
            },
          },
        }),
      ],
      controllers: [AutoMountController],
      providers: [TenantReader],
    })
    class AppModule {}

    const app = await BunestFactory.create(AppModule, { logger: false });
    try {
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          app
            .inject({
              url: "/auto",
              headers: {
                "x-req-id": `${i}`,
                "x-tenant": `t-${i}`,
              },
            })
            .then((res) => ({
              i,
              clsHeader: res.headers["x-cls-id"],
              body: res.json<{
                active: boolean;
                id: string;
                tenant: string;
                customHeader: string;
              }>(),
            })),
        ),
      );

      for (const r of results) {
        expect(r.body).toEqual({
          active: true,
          id: `mw-${r.i}`,
          tenant: `t-${r.i}`,
          customHeader: "mounted",
        });
        expect(r.clsHeader).toBe(`mw-${r.i}`);
      }

      const healthRes = await app.inject("/health");
      expect(healthRes.json()).toEqual({
        active: false,
      });
    } finally {
      await app.close();
    }
  });

  it("auto-mounts ClsInterceptor globally in ClsModule.forRoot({ interceptor: { mount: true } }) without double-running top-level setup", async () => {
    let topSetupCalls = 0;
    let mwSetupCalls = 0;
    let intSetupCalls = 0;

    @Controller("int-auto")
    class IntAutoController {
      constructor(private readonly cls: ClsService) {}

      @Get()
      check() {
        return {
          active: this.cls.isActive(),
          top: this.cls.get<string>("top"),
          mw: this.cls.get<string>("mw"),
          handler: this.cls.get<string>("handler"),
        };
      }
    }

    @Module({
      imports: [
        ClsModule.forRoot({
          setup: (cls) => {
            topSetupCalls += 1;
            cls.set("top", "yes");
          },
          middleware: {
            mount: true,
            setup: (cls) => {
              mwSetupCalls += 1;
              cls.set("mw", "yes");
            },
          },
          interceptor: {
            mount: true,
            setup: (cls, ctx) => {
              intSetupCalls += 1;
              cls.set("handler", String(ctx.getHandlerKey?.()));
            },
          },
        }),
      ],
      controllers: [IntAutoController],
    })
    class CombinedModule {}

    const app = await BunestFactory.create(CombinedModule, { logger: false });
    try {
      const res = await app.inject("/int-auto");
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        active: true,
        top: "yes",
        mw: "yes",
        handler: "check",
      });
      expect(topSetupCalls).toBe(1);
      expect(mwSetupCalls).toBe(1);
      expect(intSetupCalls).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("supports ClsModule.forRootAsync() with imports, inject, useFactory, and auto-mounted middleware/interceptor", async () => {
    @Injectable()
    class ClsConfigService {
      readonly headerName = "x-org-id";
      readonly prefix = "org";
    }

    @Module({
      providers: [ClsConfigService],
      exports: [ClsConfigService],
    })
    class ClsConfigModule {}

    @Controller("async-cls")
    class AsyncClsController {
      constructor(private readonly cls: ClsService) {}

      @Get()
      read() {
        return {
          id: this.cls.getId(),
          org: this.cls.get<string>("org"),
          handler: this.cls.get<string>("handlerKey"),
        };
      }
    }

    @Module({
      imports: [
        ClsModule.forRootAsync({
          imports: [ClsConfigModule],
          inject: [ClsConfigService],
          useFactory: async (cfg: ClsConfigService) => {
            await Bun.sleep(2);
            return {
              middleware: {
                mount: true,
                idGenerator: (req) =>
                  `${cfg.prefix}:${req.headers.get(cfg.headerName) ?? "none"}`,
                setup: (cls, req) => {
                  cls.set("org", req.headers.get(cfg.headerName) ?? "none");
                },
              },
              interceptor: {
                mount: true,
                setup: (cls, ctx) => {
                  cls.set("handlerKey", String(ctx.getHandlerKey?.()));
                },
              },
            };
          },
        }),
      ],
      controllers: [AsyncClsController],
    })
    class AsyncAppModule {}

    const app = await BunestFactory.create(AsyncAppModule, { logger: false });
    try {
      const res = await app.inject({
        url: "/async-cls",
        headers: { "x-org-id": "acme-99" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        id: "org:acme-99",
        org: "acme-99",
        handler: "read",
      });
    } finally {
      await app.close();
    }
  });

  it("injects typed CLS proxy providers into singletons via createClsProxyProvider & ClsModule.forFeature without Scope.REQUEST", async () => {
    const TENANT_CTX = Symbol("TENANT_CTX");

    interface TenantContext {
      readonly id: string;
      hits: number;
      describe(): string;
    }

    class MutableRequestState {
      actor = "anonymous";
      tags: string[] = [];
      addTag(tag: string): number {
        this.tags.push(tag);
        return this.tags.length;
      }
    }

    @Injectable()
    class BillingService {
      constructor(
        @Inject(TENANT_CTX) private readonly tenant: TenantContext,
        private readonly state: MutableRequestState,
      ) {}

      async bill(amount: number) {
        this.tenant.hits += 1;
        this.state.addTag(`bill:${amount}`);
        await Bun.sleep(Math.floor(Math.random() * 5) + 1);
        return {
          summary: this.tenant.describe(),
          hits: this.tenant.hits,
          actor: this.state.actor,
          tags: [...this.state.tags],
          keys: Object.keys(this.tenant).sort(),
          hasId: "id" in this.tenant,
          isProxy: Boolean(
            (this.tenant as unknown as Record<symbol, unknown>)[
              CLS_PROXY_MARKER
            ],
          ),
        };
      }
    }

    @Controller("billing")
    class BillingController {
      constructor(
        private readonly billing: BillingService,
        private readonly state: MutableRequestState,
        private readonly cls: ClsService,
      ) {}

      @Get()
      async charge() {
        this.state.actor = this.cls.get<string>("actor") ?? "anon";
        return this.billing.bill(42);
      }
    }

    @Module({
      imports: [
        ClsModule.forRoot({
          middleware: {
            mount: true,
            setup: (cls, req) => {
              cls.set("tenantId", req.headers.get("x-tenant") ?? "default");
              cls.set("actor", req.headers.get("x-actor") ?? "guest");
            },
          },
        }),
        ClsModule.forFeature([
          createClsProxyProvider<TenantContext>(TENANT_CTX, (cls) => {
            const id = cls.get<string>("tenantId") ?? "default";
            return {
              id,
              hits: 0,
              describe() {
                return `tenant:${this.id}:hits=${this.hits}`;
              },
            };
          }),
          MutableRequestState,
        ]),
      ],
      controllers: [BillingController],
      providers: [BillingService],
    })
    class ProxyAppModule {}

    const app = await BunestFactory.create(ProxyAppModule, { logger: false });
    try {
      // Accessing CLS proxy outside active context throws a clear, actionable error
      const tenantProxy = app.get<TenantContext>(TENANT_CTX);
      expect(() => tenantProxy.id).toThrow(/outside an active CLS context/);

      const responses = await Promise.all(
        Array.from({ length: 15 }, (_, i) =>
          app
            .inject({
              url: "/billing",
              headers: {
                "x-tenant": `corp-${i}`,
                "x-actor": `user-${i}`,
              },
            })
            .then((res) => ({
              i,
              body: res.json<{
                summary: string;
                hits: number;
                actor: string;
                tags: string[];
                keys: string[];
                hasId: boolean;
                isProxy: boolean;
              }>(),
            })),
        ),
      );

      for (const r of responses) {
        expect(r.body).toEqual({
          summary: `tenant:corp-${r.i}:hits=1`,
          hits: 1,
          actor: `user-${r.i}`,
          tags: ["bill:42"],
          keys: ["describe", "hits", "id"],
          hasId: true,
          isProxy: true,
        });
      }
    } finally {
      await app.close();
    }
  });

  it("supports ClsService.runChild() shallow inheritance, isolation, and typed get<K>()", async () => {
    const TRACE_SYM = Symbol("trace");
    const cls = new ClsService<TypedRequestStore>();

    await cls.run(
      async () => {
        cls.set("tenantId", "acme");
        cls.set("userId", 7);
        cls.set("roles", ["admin"]);
        cls.set(TRACE_SYM, "parent-trace");
        const parentId = cls.getId();

        // Typed inference check (compile-time + runtime)
        const tenant: string | undefined = cls.get("tenantId");
        const userId: number | undefined = cls.get("userId");
        const roles: string[] | undefined = cls.get("roles");
        expect(tenant).toBe("acme");
        expect(userId).toBe(7);
        expect(roles).toEqual(["admin"]);

        const [childA, childB] = await Promise.all([
          cls.runChild(
            async () => {
              await Bun.sleep(4);
              cls.set("userId", 101);
              return {
                id: cls.getId(),
                tenant: cls.get("tenantId"),
                userId: cls.get("userId"),
                trace: cls.get<string>(TRACE_SYM),
              };
            },
            { tenantId: "acme-child-a" },
          ),
          cls.runChild(
            async () => {
              await Bun.sleep(2);
              return {
                id: cls.getId(),
                tenant: cls.get("tenantId"),
                userId: cls.get("userId"),
                trace: cls.get<string>(TRACE_SYM),
              };
            },
            { [TRACE_SYM]: "child-b-trace" },
          ),
        ]);

        expect(childA).toEqual({
          id: parentId,
          tenant: "acme-child-a",
          userId: 101,
          trace: "parent-trace",
        });
        expect(childB).toEqual({
          id: parentId,
          tenant: "acme",
          userId: 7,
          trace: "child-b-trace",
        });

        // Parent store must remain completely untouched by child mutations/overrides
        expect(cls.get("tenantId")).toBe("acme");
        expect(cls.get("userId")).toBe(7);
        expect(cls.get<string>(TRACE_SYM)).toBe("parent-trace");
      },
      { [CLS_ID]: "root-req-1" },
    );

    // Calling runChild outside any active context creates a fresh context
    const orphan = cls.runChild(
      () => ({
        active: cls.isActive(),
        hasId: typeof cls.getId() === "string",
        tenant: cls.get("tenantId"),
      }),
      { tenantId: "standalone" },
    );
    expect(orphan).toEqual({
      active: true,
      hasId: true,
      tenant: "standalone",
    });
  });
});
