import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  Optional,
  REQUEST,
  Scope,
  forwardRef,
  type ContextId,
  type ContextIdStrategy,
  type HostComponentInfo,
  type Provider,
} from "../../../../../packages/core/src/common";
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

type TenantContext = { tenantId: string };
const TENANT_CONNECTION = "TENANT_CONNECTION";
interface TenantConnection {
  tenantId: string;
}

const tenantConnectionProvider: Provider = {
  provide: TENANT_CONNECTION,
  scope: Scope.REQUEST,
  durable: true,
  useFactory: (payload: TenantContext): TenantConnection => ({
    tenantId: payload.tenantId,
  }),
  inject: [REQUEST],
};

describeConformance(
  "Durable providers in a forwardRef cycle spanning modules (issue #17562 follow-up)",
  {
    upstreamPath:
      "integration/scopes/e2e/durable-cross-module-forward-ref.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-007", "ADR-012"],
    notes:
      "Tests ADR-012 ScopeLeakException for default-scoped consumers of durable factory, ADR-007 §6 rejection of non-singleton forwardRef provider cycles, and cross-module durable resolution with explicit Scope.REQUEST.",
  },
  () => {
    afterAll(() => {
      ContextIdFactory.reset();
    });

    itAdapted(
      "ADR-012",
      "should fail fast with ScopeLeakException when default-scoped services depend on durable Scope.REQUEST factory",
      async () => {
        @Injectable()
        class LeakyElephantsService {
          constructor(
            @Inject(TENANT_CONNECTION)
            public readonly connection: TenantConnection,
          ) {}
        }

        @Module({
          providers: [tenantConnectionProvider, LeakyElephantsService],
          exports: [LeakyElephantsService],
        })
        class LeakyModule {}

        await expectScopeLeak(() =>
          Test.createTestingModule({
            imports: [LeakyModule],
          }).compile(),
        );
      },
    );

    itAdapted(
      "ADR-007",
      "should fail fast with CircularDependencyException when REQUEST-scoped durable providers form a cross-module forwardRef provider cycle",
      async () => {
        @Injectable({ scope: Scope.REQUEST, durable: true })
        class CyclicElephantsService {
          constructor(
            @Inject(TENANT_CONNECTION)
            public readonly connection: TenantConnection,
            @Inject(forwardRef(() => CyclicLionsService))
            public readonly lionsService: unknown,
          ) {}
        }

        @Injectable({ scope: Scope.REQUEST, durable: true })
        class CyclicLionsService {
          constructor(
            @Inject(TENANT_CONNECTION)
            public readonly connection: TenantConnection,
            @Inject(forwardRef(() => CyclicElephantsService))
            public readonly elephantsService: unknown,
          ) {}
        }

        @Module({
          imports: [forwardRef(() => CyclicLionsModule)],
          providers: [tenantConnectionProvider, CyclicElephantsService],
          exports: [CyclicElephantsService],
        })
        class CyclicElephantsModule {}

        @Module({
          imports: [forwardRef(() => CyclicElephantsModule)],
          providers: [tenantConnectionProvider, CyclicLionsService],
          exports: [CyclicLionsService],
        })
        class CyclicLionsModule {}

        await expect(
          Test.createTestingModule({
            imports: [CyclicElephantsModule],
          }).compile(),
        ).rejects.toBeInstanceOf(CircularDependencyException);
      },
    );

    describe("cross-module durable provider chain with forwardRef module import and explicit Scope.REQUEST", () => {
      const tenants = new Map<string, ContextId>();

      class DurableStrategy implements ContextIdStrategy<Request> {
        attach(contextId: ContextId, req: Request) {
          const tenantId = req.headers.get("x-tenant-id") ?? "0";
          let subTree = tenants.get(tenantId);
          if (!subTree) {
            subTree = ContextIdFactory.create();
            tenants.set(tenantId, subTree);
          }
          return {
            resolve: (info: HostComponentInfo) =>
              info.isTreeDurable ? subTree! : contextId,
            payload: { tenantId },
          };
        }
      }

      @Injectable({ scope: Scope.REQUEST, durable: true })
      class DurableLionsService {
        constructor(
          @Inject(TENANT_CONNECTION)
          private readonly connection: TenantConnection,
        ) {}

        roar() {
          return `roar from ${this.connection.tenantId}`;
        }
      }

      @Injectable({ scope: Scope.REQUEST, durable: true })
      class DurableElephantsService {
        constructor(
          @Inject(TENANT_CONNECTION)
          private readonly connection: TenantConnection,
          @Inject(forwardRef(() => DurableLionsService))
          private readonly lionsService: DurableLionsService,
        ) {}

        trumpet() {
          return `trumpet from ${this.connection.tenantId}, lion says ${this.lionsService.roar()}`;
        }
      }

      @Module({
        imports: [forwardRef(() => DurableLionsModule)],
        providers: [tenantConnectionProvider, DurableElephantsService],
        exports: [DurableElephantsService],
      })
      class DurableElephantsModule {}

      @Module({
        imports: [forwardRef(() => DurableElephantsModule)],
        providers: [tenantConnectionProvider, DurableLionsService],
        exports: [DurableLionsService],
      })
      class DurableLionsModule {}

      @Injectable({ scope: Scope.REQUEST, durable: true })
      class DurableZooService {
        constructor(
          @Inject(TENANT_CONNECTION)
          private readonly connection: TenantConnection,
          private readonly elephantsService: DurableElephantsService,
          @Optional()
          @Inject("ZOO_KEEPER")
          public readonly zooKeeper?: unknown,
        ) {}

        visit() {
          return {
            constructorCalled: !!this.connection,
            tenantId: this.connection?.tenantId,
            elephant: this.elephantsService.trumpet(),
          };
        }
      }

      @Module({
        imports: [DurableElephantsModule],
        providers: [tenantConnectionProvider, DurableZooService],
        exports: [DurableZooService],
      })
      class DurableZooModule {}

      @Controller({ path: "durable", scope: Scope.REQUEST, durable: true })
      class DurableController {
        constructor(private readonly zooService: DurableZooService) {}

        @Get("cross-module-forward-ref")
        crossModuleForwardRef() {
          return this.zooService.visit();
        }
      }

      let app: BunestApplication;

      beforeAll(async () => {
        tenants.clear();
        const moduleRef = await Test.createTestingModule({
          imports: [DurableZooModule],
          controllers: [DurableController],
        }).compile();

        app = moduleRef.createNestApplication({ logger: false });
        await app.init();
        ContextIdFactory.apply(new DurableStrategy());
      });

      afterAll(async () => {
        ContextIdFactory.reset();
        await app.close();
      });

      const call = (tenantId: number) =>
        request(app)
          .get("/durable/cross-module-forward-ref")
          .set("x-tenant-id", String(tenantId));

      it("should construct every provider of the cross-module durable graph for every tenant", async () => {
        for (const tenantId of [43, 44]) {
          const response = await call(tenantId).expect(200);
          expect(response.body).toEqual({
            constructorCalled: true,
            tenantId: String(tenantId),
            elephant: `trumpet from ${tenantId}, lion says roar from ${tenantId}`,
          });
        }

        const repeated = await call(44).expect(200);
        expect((repeated.body as any).constructorCalled).toEqual(true);
      });
    });
  },
);
