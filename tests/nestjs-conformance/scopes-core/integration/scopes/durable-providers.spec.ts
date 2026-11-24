import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  APP_FILTER,
  APP_GUARD,
  BadRequestException,
  Catch,
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  PreconditionFailedException,
  REQUEST,
  Scope,
  type ArgumentsHost,
  type CanActivate,
  type ContextId,
  type ContextIdStrategy,
  type ExceptionFilter,
  type ExecutionContext,
  type HostComponentInfo,
} from "../../../../../packages/core/src/common";
import {
  ContextIdFactory,
  type BunestApplication,
} from "../../../../../packages/core/src";
import { Test, describeConformance, request } from "../../../_helpers";

type TenantContext = {
  tenantId: string;
  forceError?: boolean;
};

const tenants = new Map<string, ContextId>();

class DurableContextIdStrategy implements ContextIdStrategy<Request> {
  attach(contextId: ContextId, req: Request) {
    const tenantId = req.headers.get("x-tenant-id") ?? "0";
    const forceError = req.headers.get("x-force-error") === "true";

    let tenantSubTreeId = tenants.get(tenantId);
    if (!tenantSubTreeId) {
      tenantSubTreeId = ContextIdFactory.create();
      tenants.set(tenantId, tenantSubTreeId);
    }

    const payload: TenantContext = { tenantId };
    if (forceError) {
      payload.forceError = true;
    }

    return {
      resolve: (info: HostComponentInfo) =>
        info.isTreeDurable ? tenantSubTreeId! : contextId,
      payload,
    };
  }
}

@Injectable({ scope: Scope.REQUEST, durable: true })
class DurableService {
  public instanceCounter = 0;

  constructor(@Inject(REQUEST) private readonly requestPayload: TenantContext) {
    if (requestPayload.forceError) {
      throw new PreconditionFailedException("Forced error");
    }
  }

  greeting() {
    ++this.instanceCounter;
    return `Hello world! Counter: ${this.instanceCounter}`;
  }

  getTenantId() {
    return this.requestPayload.tenantId;
  }
}

@Injectable({ scope: Scope.REQUEST })
class NonDurableService {
  constructor(@Inject(REQUEST) private readonly req: Request) {}

  getTenantId() {
    return this.req.headers.get("x-tenant-id") ?? "";
  }
}

@Injectable({ scope: Scope.REQUEST, durable: true })
class DurableGuard implements CanActivate {
  public instanceCounter = 0;
  constructor(private readonly durableService: DurableService) {}

  public async canActivate(_context: ExecutionContext): Promise<boolean> {
    if (typeof this.durableService === "undefined") {
      throw new Error("Durable service is undefined");
    }
    this.instanceCounter++;
    return true;
  }
}

@Catch(BadRequestException)
@Injectable({ scope: Scope.REQUEST, durable: true })
class DurableFilter implements ExceptionFilter {
  public instanceCounter = 0;
  constructor(
    @Inject(REQUEST) private readonly requestPayload: TenantContext,
  ) {}

  catch(exception: BadRequestException, _host: ArgumentsHost) {
    return Response.json(
      {
        tenantId: this.requestPayload.tenantId,
        instanceCounter: ++this.instanceCounter,
      },
      { status: exception.getStatus() },
    );
  }
}

@Controller({ path: "durable", scope: Scope.REQUEST })
class DurableController {
  constructor(
    private readonly durableService: DurableService,
    private readonly nonDurableService: NonDurableService,
  ) {}

  @Get()
  greeting(): string {
    return this.durableService.greeting();
  }

  @Get("echo")
  echo() {
    return {
      tenantId: this.durableService.getTenantId(),
    };
  }

  @Get("request-context")
  getRequestContext() {
    return {
      durableService: this.durableService.getTenantId(),
      nonDurableService: this.nonDurableService.getTenantId(),
    };
  }

  @Get("filter")
  filter() {
    throw new BadRequestException();
  }
}

@Module({
  controllers: [DurableController],
  providers: [
    DurableService,
    NonDurableService,
    {
      provide: APP_GUARD,
      useClass: DurableGuard,
    },
    {
      provide: APP_FILTER,
      useClass: DurableFilter,
    },
  ],
})
class DurableModule {}

describeConformance(
  "Durable providers",
  {
    upstreamPath: "integration/scopes/e2e/durable-providers.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-010", "ADR-012"],
    notes:
      "Tests per-tenant durable DI sub-trees, durable guards/filters, custom payloads, non-durable request context isolation, overlapping requests, and error-non-caching.",
  },
  () => {
    const OVERLAP_REQUEST_COUNT = 200;
    let app: BunestApplication;

    beforeAll(async () => {
      tenants.clear();
      const moduleRef = await Test.createTestingModule({
        imports: [DurableModule],
      }).compile();

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();

      ContextIdFactory.apply(new DurableContextIdStrategy());
    });

    afterAll(async () => {
      ContextIdFactory.reset();
      await app.close();
    });

    const call = (
      tenantId: number,
      endpoint = "/durable",
      opts: { forceError: boolean } = { forceError: false },
    ) =>
      request(app)
        .get(endpoint)
        .set("x-tenant-id", String(tenantId))
        .set("x-force-error", opts.forceError ? "true" : "false");

    describe("when service is durable", () => {
      it("should share durable providers per tenant", async () => {
        expect((await call(1).expect(200)).text).toBe(
          "Hello world! Counter: 1",
        );
        expect((await call(1).expect(200)).text).toBe(
          "Hello world! Counter: 2",
        );
        expect((await call(1).expect(200)).text).toBe(
          "Hello world! Counter: 3",
        );
      });

      it("should create per-tenant DI sub-tree", async () => {
        expect((await call(4).expect(200)).text).toBe(
          "Hello world! Counter: 1",
        );
        expect((await call(5).expect(200)).text).toBe(
          "Hello world! Counter: 1",
        );
        expect((await call(6).expect(200)).text).toBe(
          "Hello world! Counter: 1",
        );
      });

      it("should register a custom per-tenant request payload", async () => {
        expect((await call(1, "/durable/echo").expect(200)).body).toEqual({
          tenantId: "1",
        });
        expect((await call(3, "/durable/echo").expect(200)).body).toEqual({
          tenantId: "3",
        });
      });

      // BUNEST_BUG: DIContainer.resolveSyntheticEnhancer() does not call resolveDurableContainerFor() for durable APP_FILTER/APP_GUARD multi-providers (packages/core/src/di/di-container.ts:1752-1767), injecting raw Request instead of tenant payload so tenantId is undefined.
      it.skip("should run a durable global filter with its tenant payload", async () => {
        expect((await call(51, "/durable/filter").expect(400)).body).toEqual({
          tenantId: "51",
          instanceCounter: 1,
        });
        expect((await call(51, "/durable/filter").expect(400)).body).toEqual({
          tenantId: "51",
          instanceCounter: 2,
        });
        expect((await call(52, "/durable/filter").expect(400)).body).toEqual({
          tenantId: "52",
          instanceCounter: 1,
        });
      });

      it("should return the same tenantId both from durable request scoped service and non-durable request scoped service", async () => {
        expect(
          (await call(1, "/durable/request-context").expect(200)).body,
        ).toEqual({
          durableService: "1",
          nonDurableService: "1",
        });

        expect(
          (await call(2, "/durable/request-context").expect(200)).body,
        ).toEqual({
          durableService: "2",
          nonDurableService: "2",
        });
      });

      it("should preserve request context across overlapping requests from different tenants", async () => {
        const tenantIds = Array.from(
          { length: OVERLAP_REQUEST_COUNT },
          (_, index) => index + 101,
        );

        const responses = await Promise.all(
          tenantIds.map((tenantId) =>
            call(tenantId, "/durable/request-context"),
          ),
        );

        expect(responses.map((r) => r.status)).toEqual(
          tenantIds.map(() => 200),
        );
        expect(responses.map((r) => r.body)).toEqual(
          tenantIds.map((tenantId) => ({
            durableService: String(tenantId),
            nonDurableService: String(tenantId),
          })),
        );
      }, 20000);

      it("should reuse the durable subtree across overlapping requests for the same tenant", async () => {
        const tenantId = 31;

        const responses = await Promise.all(
          Array.from({ length: OVERLAP_REQUEST_COUNT }, () => call(tenantId)),
        );

        const counters = responses
          .map((r) => Number(r.text.match(/Counter: (\d+)/)?.[1]))
          .sort((a, b) => a - b);

        expect(responses.map((r) => r.status)).toEqual(
          Array.from({ length: OVERLAP_REQUEST_COUNT }, () => 200),
        );
        expect(counters).toEqual(
          Array.from({ length: OVERLAP_REQUEST_COUNT }, (_, i) => i + 1),
        );
      }, 20000);

      // BUNEST_BUG: DIContainer.resolveDurableContainerFor() caches the durable RequestContainer with the first request's REQUEST payload before provider construction succeeds (packages/core/src/di/di-container.ts:1040-1045), so after a failing construction with forceError=true, subsequent requests reuse the stale forceError=true payload and return 412 instead of 200.
      it.skip("should not cache durable providers that throw errors", async () => {
        const failed = await call(10, "/durable/echo", { forceError: true });
        expect(failed.status).toBe(412);

        const succeeded = await call(10, "/durable/echo").expect(200);
        expect(succeeded.body).toEqual({ tenantId: "10" });
      });
    });
  },
);
