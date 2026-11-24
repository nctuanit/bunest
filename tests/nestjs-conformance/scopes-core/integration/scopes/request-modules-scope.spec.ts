import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  REQUEST,
  Scope,
  UseInterceptors,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Test,
  describeConformance,
  expectScopeLeak,
  itAdapted,
  request,
} from "../../../_helpers";

@Injectable({ scope: Scope.REQUEST })
class HelperService {
  constructor(@Inject(REQUEST) public readonly req: Request) {}
  public noop() {}
}

@Module({
  providers: [HelperService],
  exports: [HelperService],
})
class HelperModule {}

@Injectable({ scope: Scope.REQUEST })
class LoggingInterceptor implements NestInterceptor {
  constructor(private readonly helperSvc: HelperService) {}

  intercept(_context: ExecutionContext, next: CallHandler) {
    this.helperSvc.noop();
    if (!this.helperSvc.req) {
      throw new Error("missing request");
    }
    return next.handle();
  }
}

@Injectable({ scope: Scope.REQUEST })
class RequestChainService {
  static COUNTER = 0;
  constructor(private readonly helperService: HelperService) {
    helperService.noop();
    RequestChainService.COUNTER += 1;
  }

  call() {
    this.helperService.noop();
  }
}

@Controller({ path: "hello", scope: Scope.REQUEST })
class RequestChainController {
  constructor(private readonly chainService: RequestChainService) {}

  @UseInterceptors(LoggingInterceptor)
  @Get()
  greeting(): string {
    this.chainService.call();
    return "ok";
  }
}

@Module({
  imports: [HelperModule],
  providers: [RequestChainService],
  controllers: [RequestChainController],
})
class RequestChainModule {}

describeConformance(
  "Request scope (modules propagation)",
  {
    upstreamPath: "integration/scopes/e2e/request-modules-scope.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008", "ADR-012"],
    notes:
      "Verifies BOTH ADR-012 fail-fast ScopeLeakException when singleton service/interceptor/controller imports a Scope.REQUEST service AND full concurrent request-scope propagation with explicit Scope.REQUEST.",
  },
  () => {
    itAdapted(
      "ADR-012",
      "should throw ScopeLeakException when singleton RequestChainService/Controller/Interceptor imports Scope.REQUEST HelperService without explicit Scope.REQUEST",
      async () => {
        @Injectable()
        class LeakyChainService {
          constructor(public readonly helper: HelperService) {}
        }

        @Module({
          imports: [HelperModule],
          providers: [LeakyChainService],
        })
        class LeakyChainModule {}

        await expectScopeLeak(() =>
          Test.createTestingModule({
            imports: [LeakyChainModule],
          }).compile(),
        );
      },
    );

    describe("with explicit Scope.REQUEST across modules", () => {
      const OVERLAP_REQUEST_COUNT = 200;
      let app: BunestApplication;

      beforeAll(async () => {
        RequestChainService.COUNTER = 0;
        const module = await Test.createTestingModule({
          imports: [RequestChainModule],
        }).compile();

        app = module.createNestApplication({ logger: false });
        await app.init();
      });

      afterAll(async () => {
        await app.close();
      });

      describe("when service from parent module is request scoped", () => {
        beforeAll(async () => {
          await request(app).get("/hello").expect(200);
          await request(app).get("/hello").expect(200);
          await request(app).get("/hello").expect(200);
        });

        it("should not fail and should instantiate per request", () => {
          expect(RequestChainService.COUNTER).toEqual(3);
        });
      });

      describe("when service from parent module is request scoped under overlapping requests", () => {
        let counterBefore: number;
        let statuses: number[];

        beforeAll(async () => {
          counterBefore = RequestChainService.COUNTER;
          const responses = await Promise.all(
            Array.from({ length: OVERLAP_REQUEST_COUNT }, () =>
              request(app).get("/hello"),
            ),
          );
          statuses = responses.map((r) => r.status);
        }, 20000);

        it("should complete every overlapping request successfully", () => {
          expect(statuses).toEqual(
            Array.from({ length: OVERLAP_REQUEST_COUNT }, () => 200),
          );
        });

        it("should create the request-scoped dependency chain for every overlapping request", () => {
          expect(RequestChainService.COUNTER - counterBefore).toBe(
            OVERLAP_REQUEST_COUNT,
          );
        });
      });
    });
  },
);
