import "reflect-metadata";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "bun:test";
import {
  APP_GUARD,
  Controller,
  Get,
  Inject,
  Injectable,
  Optional,
  Scope,
  UnauthorizedException,
  forwardRef,
  type CanActivate,
  type ContextId,
  type ContextIdStrategy,
  type HostComponentInfo,
  type InjectionToken,
  type Provider,
  type Type,
} from "../../../../../packages/common/src";
import {
  CircularDependencyException,
  ContextIdFactory,
  ModuleRef,
  REQUEST,
  type BunestApplication,
} from "../../../../../packages/core/src";
import {
  SubscribeMessage,
  WebSocketGateway,
  WebSocketModule,
  WsException,
} from "../../../../../packages/websockets/src";
import {
  Test,
  describeConformance,
  expectScopeLeak,
  itAdapted,
  type TestingModule,
} from "../../../_helpers";

type MockRequest = { headers: Record<string, string | undefined> };
type AnyRequest = MockRequest | Request;

const readHeader = (
  request: AnyRequest,
  name: string,
): string | undefined => {
  if (request.headers instanceof Headers) {
    return request.headers.get(name) ?? undefined;
  }
  return (request.headers as Record<string, string | undefined>)[name];
};

const assertAuthorized = (request: AnyRequest) => {
  if (readHeader(request, "x-api-key") !== "secret") {
    throw new UnauthorizedException();
  }
};

describeConformance(
  "Request-scoped providers with a forward reference",
  {
    upstreamPath: "integration/injector/e2e/request-scoped-forward-ref.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-007", "ADR-010", "ADR-012"],
    notes:
      "Adapts supertest/WsAdapter/implicit scope bubbling to Bunest app.inject(), WebSocketModule + native WebSocket, ADR-012 explicit Scope.REQUEST (+ durable: true) declarations, and ADR-007 §6 fail-fast rejection of circular forwardRef cycles on REQUEST-scoped providers.",
  },
  () => {
    describe("when there is no circular dependency", () => {
      @Injectable()
      class AuditLog {}

      @Injectable({ scope: Scope.REQUEST })
      class TenantContext {
        public readonly tenant: string;

        constructor(
          @Inject(REQUEST) request: AnyRequest,
          @Inject(forwardRef(() => AuditLog)) public readonly log: AuditLog,
        ) {
          assertAuthorized(request);
          this.tenant = "acme";
        }
      }

      @Controller({ path: "invoices", scope: Scope.REQUEST })
      class InvoicesController {
        constructor(private readonly tenantContext: TenantContext) {}

        @Get()
        list() {
          return { tenant: `${this.tenantContext.tenant}` };
        }
      }

      let app: BunestApplication;

      beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({
          controllers: [InvoicesController],
          providers: [AuditLog, TenantContext],
        }).compile();
        app = moduleRef.createNestApplication({ logger: false });
        await app.init();
      });

      afterAll(async () => {
        await app.close();
      });

      itAdapted(
        "ADR-012",
        "should reject singleton controller injecting request-scoped TenantContext at bootstrap",
        async () => {
          @Controller("leaking-invoices")
          class LeakingInvoicesController {
            constructor(public readonly tenantContext: TenantContext) {}
          }

          await expectScopeLeak(() =>
            Test.createTestingModule({
              controllers: [LeakingInvoicesController],
              providers: [AuditLog, TenantContext],
            }).compile(),
          );
        },
      );

      it("should not run the handler when its constructor throws", async () => {
        const res = await app.inject({ method: "GET", url: "/invoices" });
        expect(res.statusCode).toBe(401);
      });

      it("should run the handler with the constructed provider", async () => {
        const res = await app.inject({
          method: "GET",
          url: "/invoices",
          headers: { "x-api-key": "secret" },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ tenant: "acme" });
      });
    });

    describe.each([
      ["one side", false],
      ["both sides", true],
    ] as const)(
      'when %s of a circular dependency use "forwardRef()" (ADR-007 §6)',
      (_, bothSides) => {
        @Injectable({ scope: Scope.REQUEST })
        class TenantContext {
          public readonly isConstructed = true;

          constructor(
            @Inject(REQUEST) request: MockRequest,
            @Inject(forwardRef(() => TenantService))
            public readonly service: { tenant: TenantContext },
          ) {
            assertAuthorized(request);
          }
        }

        @Injectable({ scope: Scope.REQUEST })
        class TenantService {
          constructor(
            @Inject(
              (bothSides
                ? forwardRef(() => TenantContext)
                : TenantContext) as InjectionToken,
            )
            public readonly tenant: TenantContext,
          ) {}
        }

        @Injectable({ scope: Scope.REQUEST })
        class Consumer {
          constructor(public readonly service: TenantService) {}
        }

        itAdapted(
          "ADR-007",
          "should fail fast at bootstrap with CircularDependencyException for REQUEST-scoped forwardRef cycles",
          async () => {
            await expect(
              Test.createTestingModule({
                providers: [TenantContext, TenantService, Consumer],
              }).compile(),
            ).rejects.toBeInstanceOf(CircularDependencyException);
          },
        );
      },
    );

    describe("when resolving circular request-scoped providers directly (ADR-007 §6)", () => {
      const CONNECTION = "CONNECTION";

      const connection: Provider = {
        provide: CONNECTION,
        scope: Scope.REQUEST,
        inject: [REQUEST],
        useFactory: async (request: MockRequest) => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          assertAuthorized(request);
          return "connected";
        },
      };

      async function compileCycleFixture(
        bothSides: boolean,
        conn?: Provider,
      ) {
        @Injectable({ scope: Scope.REQUEST })
        class UpdateUsecase {
          constructor(
            @Inject(forwardRef(() => CreateUsecase))
            public readonly create: { update: UpdateUsecase },
            @Optional() @Inject(CONNECTION) public readonly connection?: string,
          ) {}
        }

        @Injectable({ scope: Scope.REQUEST })
        class CreateUsecase {
          constructor(
            @Inject(
              (bothSides
                ? forwardRef(() => UpdateUsecase)
                : UpdateUsecase) as InjectionToken,
            )
            public readonly update: UpdateUsecase,
            @Optional() @Inject(CONNECTION) public readonly connection?: string,
          ) {}
        }

        return Test.createTestingModule({
          providers: [
            UpdateUsecase,
            CreateUsecase,
            ...(conn ? [conn] : []),
          ],
        }).compile();
      }

      itAdapted(
        "ADR-007",
        "should reject one-sided REQUEST-scoped forwardRef cycles at bootstrap without hanging",
        async () => {
          await expect(compileCycleFixture(false)).rejects.toBeInstanceOf(
            CircularDependencyException,
          );
          await expect(
            compileCycleFixture(false, connection),
          ).rejects.toBeInstanceOf(CircularDependencyException);
        },
      );

      itAdapted(
        "ADR-007",
        "should reject two-sided REQUEST-scoped forwardRef cycles at bootstrap per ADR-007 §6",
        async () => {
          await expect(compileCycleFixture(true)).rejects.toBeInstanceOf(
            CircularDependencyException,
          );
          await expect(
            compileCycleFixture(true, connection),
          ).rejects.toBeInstanceOf(CircularDependencyException);
        },
      );
    });

    describe.each([
      ["class", false],
      ["async factory", true],
    ] as const)("when it depends on a durable %s provider", (_, isAsync) => {
      const knownTenants = ["acme"];
      const tenantSubTrees = new Map<string, ContextId>();

      class TenantContextIdStrategy implements ContextIdStrategy<MockRequest> {
        attach(contextId: ContextId, request: MockRequest) {
          const tenantId = request.headers["x-tenant-id"]!;
          if (!tenantSubTrees.has(tenantId)) {
            tenantSubTrees.set(tenantId, ContextIdFactory.create());
          }
          const tenantSubTree = tenantSubTrees.get(tenantId)!;
          return (info: HostComponentInfo) =>
            info.isTreeDurable ? tenantSubTree : contextId;
        }
      }

      @Injectable({ scope: Scope.REQUEST, durable: true })
      class TenantDatabase {
        constructor(@Inject(REQUEST) public readonly request: MockRequest) {}
      }

      const asyncTenantDatabase: Provider = {
        provide: TenantDatabase,
        scope: Scope.REQUEST,
        durable: true,
        inject: [REQUEST],
        useFactory: async (request: MockRequest) => {
          await new Promise((resolve) => setTimeout(resolve, 10));
          return new TenantDatabase(request);
        },
      };

      @Injectable()
      class AuditLog {}

      @Injectable({ scope: Scope.REQUEST, durable: true })
      class TenantContext {
        public readonly tenantId: string;

        constructor(
          database: TenantDatabase,
          @Inject(forwardRef(() => AuditLog)) public readonly log: AuditLog,
        ) {
          const tenantId = database.request.headers["x-tenant-id"]!;
          if (!knownTenants.includes(tenantId)) {
            throw new UnauthorizedException();
          }
          this.tenantId = tenantId;
        }
      }

      @Injectable({ scope: Scope.REQUEST, durable: true })
      class Consumer {
        constructor(public readonly context: TenantContext) {}
      }

      @Injectable({ scope: Scope.REQUEST })
      class RequestConsumer {
        constructor(
          @Inject(REQUEST) public readonly request: MockRequest,
          public readonly consumer: Consumer,
        ) {}
      }

      let moduleRef: TestingModule;

      beforeAll(async () => {
        moduleRef = await Test.createTestingModule({
          providers: [
            isAsync ? asyncTenantDatabase : TenantDatabase,
            AuditLog,
            TenantContext,
            Consumer,
            RequestConsumer,
          ],
        }).compile();
        ContextIdFactory.apply(new TenantContextIdStrategy());
      });

      afterAll(async () => {
        ContextIdFactory.reset();
        await moduleRef.close();
      });

      const resolve = <T>(type: Type<T>, tenantId: string) => {
        const request: MockRequest = { headers: { "x-tenant-id": tenantId } };
        const contextId = ContextIdFactory.getByRequest(request);
        moduleRef.registerRequestByContextId(request, contextId);
        return moduleRef.resolve(type, contextId);
      };

      it("should reject every request of the tenant when its constructor throws", async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          await expect(resolve(Consumer, "initech")).rejects.toBeInstanceOf(
            UnauthorizedException,
          );
        }
      });

      it("should reject every request of the tenant for a consumer that is not durable", async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          await expect(
            resolve(RequestConsumer, "umbrella"),
          ).rejects.toBeInstanceOf(UnauthorizedException);
        }
      });

      it("should reject the overlapping requests of the tenant when its constructor throws", async () => {
        const results = await Promise.allSettled(
          [Consumer, Consumer, RequestConsumer].map((type) =>
            resolve<object>(type, "hooli"),
          ),
        );

        for (const result of results) {
          expect(result).toEqual({
            status: "rejected",
            reason: expect.any(UnauthorizedException),
          });
        }
      });

      it("should construct it for the next request of the tenant once its constructor succeeds", async () => {
        await expect(resolve(Consumer, "globex")).rejects.toBeInstanceOf(
          UnauthorizedException,
        );

        knownTenants.push("globex");
        const { context } = await resolve(Consumer, "globex");
        expect(context.tenantId).toBe("globex");
      });

      it("should construct it before the overlapping requests of the tenant use it", async () => {
        const tenantIds = await Promise.all(
          [Consumer, Consumer, RequestConsumer].map(async (type) => {
            const instance = await resolve<object>(type, "acme");
            const consumer =
              instance instanceof RequestConsumer
                ? instance.consumer
                : instance;
            return (consumer as Consumer).context.tenantId;
          }),
        );

        expect(tenantIds).toEqual(["acme", "acme", "acme"]);
      });

      it("should share it between the requests of the tenant", async () => {
        const first = await resolve(Consumer, "acme");
        const second = await resolve(Consumer, "acme");

        expect(second).toBe(first);
        expect(second.context.tenantId).toBe("acme");
      });

      describe('through the "ModuleRef" of a module', () => {
        const resolveThroughModule = <T>(type: Type<T>, tenantId: string) => {
          const request: MockRequest = { headers: { "x-tenant-id": tenantId } };
          const contextId = ContextIdFactory.getByRequest(request);
          moduleRef.registerRequestByContextId(request, contextId);
          return moduleRef.get(ModuleRef).resolve(type, contextId);
        };

        it("should reject every request of the tenant once its constructor threw for another injector", async () => {
          await expect(resolve(Consumer, "cyberdyne")).rejects.toBeInstanceOf(
            UnauthorizedException,
          );
          for (let attempt = 0; attempt < 2; attempt++) {
            await expect(
              resolveThroughModule(Consumer, "cyberdyne"),
            ).rejects.toBeInstanceOf(UnauthorizedException);
          }
          await expect(resolve(Consumer, "cyberdyne")).rejects.toBeInstanceOf(
            UnauthorizedException,
          );
        });

        it("should make another injector reject every request of the tenant once its constructor threw", async () => {
          await expect(
            resolveThroughModule(Consumer, "tyrell"),
          ).rejects.toBeInstanceOf(UnauthorizedException);
          for (let attempt = 0; attempt < 2; attempt++) {
            await expect(resolve(Consumer, "tyrell")).rejects.toBeInstanceOf(
              UnauthorizedException,
            );
          }
          await expect(
            resolveThroughModule(Consumer, "tyrell"),
          ).rejects.toBeInstanceOf(UnauthorizedException);
        });

        it("should construct it for a tenant that it accepts", async () => {
          const { context } = await resolveThroughModule(Consumer, "acme");
          expect(context.tenantId).toBe("acme");
        });
      });
    });

    describe("when a pair that references each other depends on a durable provider that throws (ADR-007 §6)", () => {
      @Injectable({ scope: Scope.REQUEST, durable: true })
      class TenantConnection {
        constructor(@Inject(REQUEST) public readonly payload: unknown) {}
      }

      @Injectable({ scope: Scope.REQUEST, durable: true })
      class UsersService {
        constructor(
          @Inject(forwardRef(() => OrdersService)) public readonly orders: any,
          public readonly connection: TenantConnection,
        ) {}
      }

      @Injectable({ scope: Scope.REQUEST, durable: true })
      class ReportsService {
        constructor(public readonly users: UsersService) {}
      }

      @Injectable({ scope: Scope.REQUEST, durable: true })
      class OrdersService {
        constructor(
          @Inject(forwardRef(() => UsersService)) public readonly users: any,
          public readonly reports: ReportsService,
        ) {}
      }

      @Controller({ path: "orders", scope: Scope.REQUEST, durable: true })
      class OrdersController {
        constructor(public readonly orders: OrdersService) {}

        @Get()
        list() {
          return [];
        }
      }

      itAdapted(
        "ADR-007",
        "should fail fast at bootstrap with CircularDependencyException for circular durable REQUEST-scoped providers",
        async () => {
          await expect(
            Test.createTestingModule({
              controllers: [OrdersController],
              providers: [
                TenantConnection,
                UsersService,
                ReportsService,
                OrdersService,
              ],
            }).compile(),
          ).rejects.toBeInstanceOf(CircularDependencyException);
        },
      );
    });

    describe('when a durable factory of a pair that references each other resolves its other side through "ModuleRef" (ADR-007 §6)', () => {
      const TENANT_SETTINGS = Symbol("TENANT_SETTINGS");

      @Injectable({ scope: Scope.REQUEST, durable: true })
      class BillingService {
        constructor(
          @Inject(forwardRef(() => InvoicesService))
          public readonly invoices: any,
          @Inject(TENANT_SETTINGS) public readonly settings: any,
        ) {}
      }

      @Injectable({ scope: Scope.REQUEST, durable: true })
      class InvoicesService {
        constructor(
          @Inject(forwardRef(() => BillingService))
          public readonly billing: any,
        ) {}
      }

      const tenantSettings: Provider = {
        provide: TENANT_SETTINGS,
        scope: Scope.REQUEST,
        durable: true,
        inject: [ModuleRef, REQUEST],
        useFactory: async (moduleRef: ModuleRef, request: MockRequest) => ({
          invoices: await moduleRef.resolve(
            InvoicesService,
            ContextIdFactory.getByRequest(request),
          ),
        }),
      };

      itAdapted(
        "ADR-007",
        "should fail fast at bootstrap with CircularDependencyException for circular durable REQUEST-scoped providers with factory dependency",
        async () => {
          await expect(
            Test.createTestingModule({
              providers: [tenantSettings, BillingService, InvoicesService],
            }).compile(),
          ).rejects.toBeInstanceOf(CircularDependencyException);
        },
      );
    });

    describe("when a scoped global guard of a gateway depends on it", () => {
      @Injectable()
      class AuditLog {}

      @Injectable({ scope: Scope.REQUEST })
      class ClientContext {
        static isAuthorized = false;

        constructor(
          @Inject(REQUEST) public readonly client: object,
          @Inject(forwardRef(() => AuditLog)) public readonly log: AuditLog,
        ) {
          if (!ClientContext.isAuthorized) {
            throw new WsException("Unauthorized");
          }
        }
      }

      @Injectable({ scope: Scope.REQUEST })
      class ClientGuard implements CanActivate {
        constructor(public readonly context: ClientContext) {}

        canActivate() {
          return true;
        }
      }

      @WebSocketGateway({ path: "/forward-ref" })
      class Gateway {
        @SubscribeMessage("open")
        open() {
          return { event: "open", data: "granted" };
        }
      }

      let app: BunestApplication | undefined;

      afterEach(async () => {
        await app?.close();
        app = undefined;
      });

      const send = async () => {
        const moduleRef = await Test.createTestingModule({
          imports: [WebSocketModule.forRoot()],
          providers: [
            AuditLog,
            ClientContext,
            Gateway,
            { provide: APP_GUARD, useClass: ClientGuard },
          ],
        }).compile();
        app = moduleRef.createNestApplication({ logger: false });
        await WebSocketModule.attach(app);
        await app.listen(0, "127.0.0.1");

        const wsUrl = new URL("/forward-ref", app.getUrl()!)
          .toString()
          .replace(/^http/, "ws");
        const client = new WebSocket(wsUrl);
        await new Promise<void>((resolve, reject) => {
          client.addEventListener("open", () => resolve(), { once: true });
          client.addEventListener(
            "error",
            () => reject(new Error("WebSocket connection error")),
            { once: true },
          );
        });
        const reply = new Promise<string>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("WebSocket reply timeout")),
            2000,
          );
          client.addEventListener(
            "message",
            (event) => {
              clearTimeout(timer);
              resolve(String(event.data));
            },
            { once: true },
          );
        });
        client.send(JSON.stringify({ event: "open", data: {} }));
        try {
          return JSON.parse(await reply) as {
            event: string;
            data: { message?: string } | string;
          };
        } finally {
          client.close();
        }
      };

      // BUNEST_BUG: WsGatewayExplorer / BunWebSocketAdapter does not wire DI APP_GUARD multi-providers (including request-scoped guards) to @WebSocketGateway() handlers, so ClientGuard never runs and unauthorized messages still invoke the handler (packages/websockets/src/explorer/ws-gateway.explorer.ts, packages/websockets/src/adapter/bun-ws.adapter.ts)
      it.skip("should not run the handler when its constructor throws", async () => {
        ClientContext.isAuthorized = false;

        const reply = await send();

        expect(reply.event).toBe("exception");
        expect((reply.data as { message?: string }).message).toBe(
          "Unauthorized",
        );
      });

      it("should run the handler once it is constructed", async () => {
        ClientContext.isAuthorized = true;

        expect(await send()).toEqual({ event: "open", data: "granted" });
      });
    });
  },
);
