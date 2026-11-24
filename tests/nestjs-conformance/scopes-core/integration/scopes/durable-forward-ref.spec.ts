import { afterAll, beforeAll, expect, it } from "bun:test";
import {
  Controller,
  Get,
  Inject,
  Injectable,
  REQUEST,
  Scope,
  forwardRef,
  type ContextId,
  type ContextIdStrategy,
  type HostComponentInfo,
} from "../../../../../packages/core/src/common";
import {
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

const tenants = new Map<string, ContextId>();

class DurableContextIdStrategy implements ContextIdStrategy<Request> {
  attach(contextId: ContextId, req: Request) {
    const tenantId = req.headers.get("x-tenant-id") ?? "0";
    let tenantSubTreeId = tenants.get(tenantId);
    if (!tenantSubTreeId) {
      tenantSubTreeId = ContextIdFactory.create();
      tenants.set(tenantId, tenantSubTreeId);
    }
    return {
      resolve: (info: HostComponentInfo) =>
        info.isTreeDurable ? tenantSubTreeId! : contextId,
      payload: { tenantId } satisfies TenantContext,
    };
  }
}

@Injectable({ scope: Scope.REQUEST, durable: true })
class DurableDogsService {
  constructor(
    @Inject(REQUEST) private readonly requestPayload: TenantContext,
  ) {}

  bark() {
    return `woof from ${this.requestPayload.tenantId}`;
  }
}

@Injectable({ scope: Scope.REQUEST, durable: true })
class DurableCatsService {
  constructor(
    @Inject(REQUEST) private readonly requestPayload: TenantContext,
    @Inject(forwardRef(() => DurableDogsService))
    private readonly dogsService: DurableDogsService,
  ) {}

  meow() {
    return {
      constructorCalled: !!this.requestPayload,
      tenantId: this.requestPayload?.tenantId,
      dog: this.dogsService?.bark(),
    };
  }
}

@Controller({ path: "durable", scope: Scope.REQUEST, durable: true })
class DurableController {
  constructor(private readonly durableCatsService: DurableCatsService) {}

  @Get("forward-ref")
  forwardRef() {
    return this.durableCatsService.meow();
  }
}

describeConformance(
  "Durable providers with forwardRef ctor dependency (issue #17562)",
  {
    upstreamPath: "integration/scopes/e2e/durable-forward-ref.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-012"],
    notes:
      "Tests durable provider with forwardRef constructor dependency across tenants + ADR-012 fail-fast ScopeLeakException when controller omits Scope.REQUEST.",
  },
  () => {
    let app: BunestApplication;

    beforeAll(async () => {
      tenants.clear();
      const moduleRef = await Test.createTestingModule({
        controllers: [DurableController],
        providers: [DurableCatsService, DurableDogsService],
      }).compile();

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();

      ContextIdFactory.apply(new DurableContextIdStrategy());
    });

    afterAll(async () => {
      ContextIdFactory.reset();
      await app.close();
    });

    const call = (tenantId: number) =>
      request(app)
        .get("/durable/forward-ref")
        .set("x-tenant-id", String(tenantId));

    itAdapted(
      "ADR-012",
      "should throw ScopeLeakException if singleton controller injects durable Scope.REQUEST provider",
      async () => {
        @Controller("leaky-durable")
        class LeakyDurableController {
          constructor(private readonly cats: DurableCatsService) {}
          @Get()
          meow() {
            return this.cats.meow();
          }
        }

        await expectScopeLeak(() =>
          Test.createTestingModule({
            controllers: [LeakyDurableController],
            providers: [DurableCatsService, DurableDogsService],
          }).compile(),
        );
      },
    );

    it("should construct the durable service for every tenant", async () => {
      const first = await call(41).expect(200);
      expect(first.body).toEqual({
        constructorCalled: true,
        tenantId: "41",
        dog: "woof from 41",
      });

      const second = await call(42).expect(200);
      expect(second.body).toEqual({
        constructorCalled: true,
        tenantId: "42",
        dog: "woof from 42",
      });

      // durable sub-tree caches the instance; a second request must also work
      const secondAgain = await call(42).expect(200);
      expect(secondAgain.body).toEqual({
        constructorCalled: true,
        tenantId: "42",
        dog: "woof from 42",
      });
    });
  },
);
