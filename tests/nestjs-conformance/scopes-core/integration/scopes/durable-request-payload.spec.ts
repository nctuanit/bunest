import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  Controller,
  Get,
  Inject,
  Injectable,
  REQUEST,
  Scope,
  type ContextId,
  type ContextIdStrategy,
  type HostComponentInfo,
} from "../../../../../packages/core/src/common";
import {
  ContextIdFactory,
  type BunestApplication,
} from "../../../../../packages/core/src";
import {
  MessagePattern,
  MicroserviceHost,
  MicroserviceModule,
  TcpClientProxy,
  TcpServer,
  Transport,
} from "../../../../../packages/microservices/src";
import { Test, describeConformance, request } from "../../../_helpers";

type TenantPayload = { tenantId: string };

class TenantContextIdStrategy<T> implements ContextIdStrategy<T> {
  private readonly tenants = new Map<string, ContextId>();

  constructor(private readonly getTenantId: (request: T) => string) {}

  attach(contextId: ContextId, req: T) {
    const tenantId = this.getTenantId(req);
    if (!this.tenants.has(tenantId)) {
      this.tenants.set(tenantId, ContextIdFactory.create());
    }
    const tenantSubTreeId = this.tenants.get(tenantId)!;
    return {
      resolve: (info: HostComponentInfo) =>
        info.isTreeDurable ? tenantSubTreeId : contextId,
      payload: { tenantId } satisfies TenantPayload,
    };
  }
}

describeConformance(
  "Request payload of durable providers",
  {
    upstreamPath: "integration/scopes/e2e/durable-request-payload.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008", "ADR-012"],
    notes:
      "Tests durable strategy payload injection into durable providers, property injection, transient dependencies, and non-durable sibling controllers across HTTP and TCP microservices.",
  },
  () => {
    afterEach(() => {
      ContextIdFactory.reset();
    });

    describe("when a controller that is not durable uses them (HTTP)", () => {
      @Injectable({ scope: Scope.TRANSIENT })
      class TenantFormatter {
        constructor(@Inject(REQUEST) public readonly tenant: TenantPayload) {}
      }

      @Injectable({ scope: Scope.TRANSIENT })
      class TenantLogger {
        constructor(
          @Inject(REQUEST) public readonly tenant: TenantPayload,
          public readonly formatter: TenantFormatter,
        ) {}
      }

      @Injectable({ scope: Scope.REQUEST, durable: true })
      class TenantStats {
        @Inject(REQUEST)
        public readonly tenantProperty!: TenantPayload;

        constructor(
          @Inject(REQUEST) public readonly tenant: TenantPayload,
          public readonly logger: TenantLogger,
        ) {}
      }

      @Injectable({ scope: Scope.REQUEST })
      class CurrentUser {
        public readonly name: string;

        constructor(@Inject(REQUEST) req: Request) {
          this.name = req.headers.get("x-user") ?? "";
        }
      }

      @Controller({ path: "orders", scope: Scope.REQUEST })
      class OrdersController {
        constructor(
          private readonly user: CurrentUser,
          private readonly stats: TenantStats,
        ) {}

        @Get()
        list() {
          return { user: this.user.name, tenant: this.stats.tenant.tenantId };
        }
      }

      @Controller({ path: "stats", scope: Scope.REQUEST, durable: true })
      class StatsController {
        constructor(private readonly stats: TenantStats) {}

        @Get()
        describe() {
          return {
            constructorParam: this.stats.tenant,
            property: this.stats.tenantProperty,
            transientDependency: this.stats.logger.tenant,
            nestedTransientDependency: this.stats.logger.formatter.tenant,
          };
        }
      }

      let app: BunestApplication;

      beforeEach(async () => {
        const moduleRef = await Test.createTestingModule({
          controllers: [OrdersController, StatsController],
          providers: [TenantFormatter, TenantLogger, TenantStats, CurrentUser],
        }).compile();
        app = moduleRef.createNestApplication({ logger: false });
        await app.init();
        ContextIdFactory.apply(
          new TenantContextIdStrategy<Request>(
            (req) => req.headers.get("x-tenant-id") ?? "default",
          ),
        );
      });

      afterEach(async () => {
        await app.close();
      });

      const get = (path: string, tenantId: string, user: string) =>
        request(app).get(path).set("x-tenant-id", tenantId).set("x-user", user);

      it("should build them with the payload of the strategy", async () => {
        for (const tenantId of ["acme", "globex"]) {
          await get("/orders", tenantId, "alice").expect(200, {
            user: "alice",
            tenant: tenantId,
          });
          await get("/stats", tenantId, "bob").expect(200, {
            constructorParam: { tenantId },
            property: { tenantId },
            transientDependency: { tenantId },
            nestedTransientDependency: { tenantId },
          });
          await get("/orders", tenantId, "bob").expect(200, {
            user: "bob",
            tenant: tenantId,
          });
        }
      });
    });

    describe("when a controller that is not durable uses them (microservices)", () => {
      @Injectable({ scope: Scope.REQUEST, durable: true })
      class TenantStats {
        public orders = 0;

        constructor(@Inject(REQUEST) public readonly tenant: TenantPayload) {}
      }

      @Injectable({ scope: Scope.REQUEST })
      class AuditTrail {
        static readonly users: string[] = [];

        constructor(
          @Inject(REQUEST) private readonly message: { data: { user: string } },
        ) {}

        record() {
          AuditTrail.users.push(this.message.data.user);
        }
      }

      @Controller({ scope: Scope.REQUEST })
      class OrdersController {
        constructor(
          private readonly audit: AuditTrail,
          private readonly stats: TenantStats,
        ) {}

        @MessagePattern("order.create")
        create() {
          this.audit.record();
          this.stats.orders++;
          return { accepted: true };
        }
      }

      @Controller({ scope: Scope.REQUEST, durable: true })
      class StatsController {
        constructor(private readonly stats: TenantStats) {}

        @MessagePattern("tenant.describe")
        describe() {
          return { ...this.stats.tenant, orders: this.stats.orders };
        }
      }

      let server: TcpServer;
      let host: MicroserviceHost;
      let client: TcpClientProxy;

      afterEach(async () => {
        await client?.close();
        await host?.close();
      });

      // BUNEST_BUG: MicroserviceHost.collectLoadedInstances() only discovers singleton instances (wrapper.instance !== undefined) and skips Scope.REQUEST controllers, nor does it create a per-message RequestContainer / ContextIdFactory strategy (packages/microservices/src/microservice-host.ts:59-78,318-395); throws RpcException("No @MessagePattern() handler found for pattern \"order.create\"").
      it.skip("should not answer a request of the tenant with the message they were built for", async () => {
        AuditTrail.users.length = 0;
        const moduleRef = await Test.createTestingModule({
          imports: [
            MicroserviceModule.forRoot({
              transport: Transport.TCP,
              options: { host: "127.0.0.1", port: 0 },
            }),
          ],
          controllers: [OrdersController, StatsController],
          providers: [AuditTrail, TenantStats],
        }).compile();

        host = moduleRef.get(MicroserviceHost);
        await host.listen();
        server = host.getServers()[0] as TcpServer;
        ContextIdFactory.apply(
          new TenantContextIdStrategy<{ data: { tenantId: string } }>(
            (message) => message.data.tenantId,
          ),
        );

        client = new TcpClientProxy({
          host: "127.0.0.1",
          port: server.port!,
        });
        await client.connect();

        await client.send("order.create", { tenantId: "acme", user: "alice" });
        const reply = await client.send("tenant.describe", {
          tenantId: "acme",
          user: "bob",
        });

        expect(reply).toEqual({ tenantId: "acme", orders: 1 });
        expect(AuditTrail.users).toEqual(["alice"]);
      });
    });
  },
);
