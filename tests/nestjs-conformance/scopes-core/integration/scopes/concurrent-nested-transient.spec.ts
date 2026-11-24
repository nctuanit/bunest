import { afterEach, describe, expect, it } from "bun:test";
import {
  APP_GUARD,
  Controller,
  Get,
  Inject,
  Injectable,
  REQUEST,
  Scope,
  UseGuards,
  UseInterceptors,
  type CallHandler,
  type CanActivate,
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

@Injectable({ scope: Scope.TRANSIENT })
class Stopwatch {}

@Injectable({ scope: Scope.TRANSIENT })
class TransientLogger {
  constructor(public readonly stopwatch: Stopwatch) {}
}

@Injectable({ scope: Scope.TRANSIENT })
class RequestInfo {
  constructor(@Inject(REQUEST) public readonly request: unknown) {}
}

@Injectable()
class DenyGuard implements CanActivate {
  constructor(public readonly logger: TransientLogger) {}

  canActivate() {
    return false;
  }
}

@Injectable()
class ImplicitAuditService {
  constructor(
    public readonly logger: TransientLogger,
    public readonly info: RequestInfo,
  ) {}
}

@Injectable({ scope: Scope.REQUEST })
class ExplicitRequestAuditService {
  constructor(
    public readonly logger: TransientLogger,
    public readonly info: RequestInfo,
  ) {}
}

@Injectable()
class LoggedGuard implements CanActivate {
  constructor(public readonly logger: TransientLogger) {}

  canActivate() {
    return this.logger.stopwatch instanceof Stopwatch;
  }
}

@Injectable({ scope: Scope.TRANSIENT })
class LoggedInterceptor implements NestInterceptor {
  constructor(public readonly logger: TransientLogger) {}

  intercept(_context: ExecutionContext, next: CallHandler) {
    return next.handle();
  }
}

@Controller()
class AppController {
  @Get()
  get() {
    return "ok";
  }
}

@Controller()
@UseGuards(LoggedGuard)
@UseInterceptors(LoggedInterceptor)
class LoggedController {
  @Get()
  get() {
    return "ok";
  }
}

describeConformance(
  "Nested transient providers resolved concurrently",
  {
    upstreamPath: "integration/scopes/e2e/concurrent-nested-transient.spec.ts",
    category: "DIRECT_PORT",
    adrs: ["ADR-008", "ADR-012"],
    notes:
      "Tests nested transient providers resolved concurrently alongside guards/interceptors, plus ADR-012 fail-fast ScopeLeakException for singleton depending on transient->REQUEST.",
  },
  () => {
    let app: BunestApplication | undefined;

    afterEach(async () => {
      await app?.close();
      app = undefined;
    });

    itAdapted(
      "ADR-012",
      "should fail fast with ScopeLeakException when singleton AuditService injects transient RequestInfo depending on REQUEST",
      async () => {
        await expectScopeLeak(() =>
          Test.createTestingModule({
            controllers: [AppController],
            providers: [
              Stopwatch,
              TransientLogger,
              RequestInfo,
              DenyGuard,
              { provide: APP_GUARD, useExisting: DenyGuard },
              ImplicitAuditService,
            ],
          }).compile(),
        );
      },
    );

    it("should instantiate a global guard that a request-scoped provider resolves along with", async () => {
      const moduleRef = await Test.createTestingModule({
        controllers: [AppController],
        providers: [
          Stopwatch,
          TransientLogger,
          RequestInfo,
          DenyGuard,
          { provide: APP_GUARD, useExisting: DenyGuard },
          ExplicitRequestAuditService,
        ],
      }).compile();
      app = moduleRef.createNestApplication({ logger: false });
      await app.init();

      await request(app).get("/").expect(403);
      expect(app.get(DenyGuard).logger.stopwatch).toBeInstanceOf(Stopwatch);
    });

    it("should instantiate the dependencies of a guard that a transient interceptor resolves along with", async () => {
      const moduleRef = await Test.createTestingModule({
        controllers: [LoggedController],
        providers: [Stopwatch, TransientLogger],
      }).compile();
      app = moduleRef.createNestApplication({ logger: false });
      await app.init();

      await request(app).get("/").expect(200, "ok");
    });
  },
);
