import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  Controller,
  Get,
  Inject,
  Injectable,
  REQUEST,
  Scope,
  UseGuards,
  forwardRef,
  type CanActivate,
  type ContextId,
  type ContextIdStrategy,
  type ExecutionContext,
  type HostComponentInfo,
} from "../../../../../packages/common/src";
import {
  CircularDependencyException,
  ContextIdFactory,
  type BunestApplication,
} from "../../../../../packages/core/src";
import {
  Test,
  describeConformance,
  expectScopeLeak,
  itAdapted,
  request,
} from "../../../_helpers";

const tenantSubTrees = new Map<string, ContextId>();

class TenantContextIdStrategy implements ContextIdStrategy<Request> {
  attach(contextId: ContextId, req: Request) {
    const tenantId = req.headers.get("x-tenant-id") ?? "default";
    if (!tenantSubTrees.has(tenantId)) {
      tenantSubTrees.set(tenantId, ContextIdFactory.create());
    }
    const tenantSubTree = tenantSubTrees.get(tenantId)!;
    return {
      resolve: (info: HostComponentInfo) =>
        info.isTreeDurable ? tenantSubTree : contextId,
      payload: { tenantId },
    };
  }
}

@Injectable({ scope: Scope.REQUEST, durable: true })
class TenantDatabase {
  constructor(@Inject(REQUEST) readonly tenant: { tenantId: string }) {}
}

@Injectable({ scope: Scope.REQUEST })
class CurrentUser {
  name?: string;
}

@Injectable({ scope: Scope.REQUEST })
class ExplicitRequestAuthGuard implements CanActivate {
  constructor(private readonly currentUser: CurrentUser) {}

  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<Request>();
    this.currentUser.name = req.headers.get("authorization") ?? undefined;
    return !!this.currentUser.name;
  }
}

describeConformance(
  "Durable providers in a circular dependency",
  {
    upstreamPath: "integration/scopes/e2e/durable-circular-dependency.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-007", "ADR-012"],
    notes:
      "Tests ADR-012 fail-fast ScopeLeakException for singleton services/guards/controllers depending on durable Scope.REQUEST providers, ADR-007 §6 fail-fast CircularDependencyException for REQUEST-scoped forwardRef cycles, and non-circular explicit Scope.REQUEST tenant vs per-user isolation.",
  },
  () => {
    afterAll(() => {
      ContextIdFactory.reset();
    });

    itAdapted(
      "ADR-012",
      "should fail fast with ScopeLeakException when singleton AuthGuard/OrdersService/InvoicesService depend on Scope.REQUEST providers",
      async () => {
        @Injectable()
        class LeakyAuthGuard implements CanActivate {
          constructor(private readonly currentUser: CurrentUser) {}
          canActivate() {
            return !!this.currentUser.name;
          }
        }

        @Injectable()
        class LeakyOrdersService {
          constructor(private readonly database: TenantDatabase) {}
          list() {
            return this.database.tenant.tenantId;
          }
        }

        @Controller("leaky-invoices")
        @UseGuards(LeakyAuthGuard)
        class LeakyInvoicesController {
          constructor(private readonly orders: LeakyOrdersService) {}
          @Get()
          summary() {
            return this.orders.list();
          }
        }

        await expectScopeLeak(() =>
          Test.createTestingModule({
            controllers: [LeakyInvoicesController],
            providers: [TenantDatabase, CurrentUser, LeakyOrdersService],
          }).compile(),
        );
      },
    );

    itAdapted(
      "ADR-007",
      "should fail fast with CircularDependencyException for a REQUEST-scoped forwardRef cycle (OrdersService <-> InvoicesService)",
      async () => {
        @Injectable({ scope: Scope.REQUEST })
        class CyclicOrdersService {
          constructor(
            private readonly database: TenantDatabase,
            @Inject(forwardRef(() => CyclicInvoicesService))
            private readonly invoices: { owner(): string | undefined },
          ) {}

          list() {
            return `orders of ${this.invoices.owner()} in ${this.database.tenant.tenantId}`;
          }
        }

        @Injectable({ scope: Scope.REQUEST })
        class CyclicInvoicesService {
          constructor(
            @Inject(forwardRef(() => CyclicOrdersService))
            private readonly orders: CyclicOrdersService,
            private readonly currentUser: CurrentUser,
          ) {}

          owner() {
            return this.currentUser.name;
          }

          summary() {
            return {
              authenticatedAs: this.currentUser.name,
              orders: this.orders.list(),
            };
          }
        }

        @Controller({ path: "cyclic-invoices", scope: Scope.REQUEST })
        @UseGuards(ExplicitRequestAuthGuard)
        class CyclicInvoicesController {
          constructor(private readonly invoices: CyclicInvoicesService) {}

          @Get()
          summary() {
            return this.invoices.summary();
          }
        }

        await expect(
          Test.createTestingModule({
            controllers: [CyclicInvoicesController],
            providers: [
              TenantDatabase,
              CurrentUser,
              CyclicOrdersService,
              CyclicInvoicesService,
            ],
          }).compile(),
        ).rejects.toBeInstanceOf(CircularDependencyException);
      },
    );

    describe("with explicit Scope.REQUEST and acyclic composition (per-user CurrentUser + durable TenantDatabase)", () => {
      @Injectable({ scope: Scope.REQUEST })
      class OrdersService {
        constructor(
          private readonly database: TenantDatabase,
          private readonly currentUser: CurrentUser,
        ) {}

        list() {
          return `orders of ${this.currentUser.name} in ${this.database.tenant.tenantId}`;
        }
      }

      @Injectable({ scope: Scope.REQUEST })
      class InvoicesService {
        constructor(
          private readonly orders: OrdersService,
          private readonly currentUser: CurrentUser,
        ) {}

        summary() {
          return {
            authenticatedAs: this.currentUser.name,
            orders: this.orders.list(),
          };
        }
      }

      @Controller({ path: "invoices", scope: Scope.REQUEST })
      @UseGuards(ExplicitRequestAuthGuard)
      class InvoicesController {
        constructor(private readonly invoices: InvoicesService) {}

        @Get()
        summary() {
          return this.invoices.summary();
        }
      }

      let app: BunestApplication;

      beforeAll(async () => {
        tenantSubTrees.clear();
        const moduleRef = await Test.createTestingModule({
          controllers: [InvoicesController],
          providers: [
            TenantDatabase,
            CurrentUser,
            OrdersService,
            InvoicesService,
          ],
        }).compile();
        app = moduleRef.createNestApplication({ logger: false });
        await app.init();
        ContextIdFactory.apply(new TenantContextIdStrategy());
      });

      afterAll(async () => {
        ContextIdFactory.reset();
        await app.close();
      });

      const call = (user: string) =>
        request(app)
          .get("/invoices")
          .set("x-tenant-id", "acme")
          .set("authorization", user);

      it("should not serve a user with the instances built for another user of the tenant", async () => {
        const alice = await call("alice").expect(200);
        expect(alice.body).toEqual({
          authenticatedAs: "alice",
          orders: "orders of alice in acme",
        });

        const bob = await call("bob").expect(200);
        expect(bob.body).toEqual({
          authenticatedAs: "bob",
          orders: "orders of bob in acme",
        });
      });
    });
  },
);
