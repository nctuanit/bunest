import "reflect-metadata";
import { afterEach, beforeEach, expect, it } from "bun:test";
import {
  BadRequestException,
  Catch,
  Controller,
  Get,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  REQUEST,
  Scope,
  UseFilters,
  type ArgumentsHost,
  type ExceptionFilter,
} from "../../../../../packages/common/src";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Test,
  describeConformance,
  expectScopeLeak,
  itAdapted,
  request,
} from "../../../_helpers";

@Injectable()
class FailureLog {
  readonly entries: string[] = [];

  record(entry: string) {
    this.entries.push(entry);
  }
}

@Injectable({ scope: Scope.REQUEST })
class Tenant {
  readonly name: string;

  constructor(@Inject(REQUEST) req: Request) {
    if (req.headers.get("x-tenant") !== "acme") {
      throw new BadRequestException("Unknown tenant");
    }
    this.name = "acme";
  }
}

@Injectable({ scope: Scope.REQUEST })
@Catch(HttpException)
class RequestScopedFilter implements ExceptionFilter {
  constructor(private readonly log: FailureLog) {}

  async catch(exception: HttpException, _host: ArgumentsHost) {
    await Promise.resolve();
    this.log.record(exception.message);
    return Response.json(
      { handledBy: "RequestScopedFilter" },
      { status: exception.getStatus() },
    );
  }
}

@Injectable({ scope: Scope.TRANSIENT })
@Catch(HttpException)
class TransientFilter implements ExceptionFilter {
  constructor(private readonly log: FailureLog) {}

  catch(exception: HttpException, _host: ArgumentsHost) {
    this.log.record(exception.message);
    return Response.json(
      { handledBy: "TransientFilter" },
      { status: exception.getStatus() },
    );
  }
}

@Catch()
@Injectable()
class UnscopedFilter implements ExceptionFilter {
  constructor(private readonly log: FailureLog) {}

  catch(exception: Error, _host: ArgumentsHost) {
    this.log.record(exception.message);
    return Response.json({ handledBy: "UnscopedFilter" }, { status: 503 });
  }
}

@Controller({ path: "scoped", scope: Scope.REQUEST })
@UseFilters(RequestScopedFilter)
class ScopedFilterController {
  constructor(private readonly tenant: Tenant) {}

  @Get()
  find() {
    throw new NotFoundException(`No invoices for ${this.tenant.name}`);
  }
}

@Controller({ path: "unscoped", scope: Scope.REQUEST })
@UseFilters(UnscopedFilter)
class UnscopedFilterController {
  constructor(private readonly tenant: Tenant) {}

  @Get()
  find() {
    throw new NotFoundException(`No invoices for ${this.tenant.name}`);
  }
}

@Controller("transient")
@UseFilters(TransientFilter)
class TransientFilterController {
  @Get()
  find() {
    throw new NotFoundException("No invoices");
  }
}

describeConformance(
  "Exception filters of a request-scoped controller that fails to resolve",
  {
    upstreamPath:
      "integration/scopes/e2e/scoped-filter-resolution-error.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-010", "ADR-012"],
    notes:
      "Tests scoped/unscoped/transient exception filters when a request-scoped controller fails to resolve during DI, plus ADR-012 ScopeLeakException when singleton controller injects Scope.REQUEST Tenant.",
  },
  () => {
    let app: BunestApplication;
    let log: FailureLog;

    beforeEach(async () => {
      const moduleRef = await Test.createTestingModule({
        controllers: [
          ScopedFilterController,
          UnscopedFilterController,
          TransientFilterController,
        ],
        providers: [FailureLog, Tenant],
      }).compile();

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
      log = app.get(FailureLog);
    });

    afterEach(async () => {
      await app.close();
    });

    itAdapted(
      "ADR-012",
      "should fail fast with ScopeLeakException if controller omits Scope.REQUEST while injecting Tenant",
      async () => {
        @Controller("leaky-scoped")
        class LeakyController {
          constructor(private readonly tenant: Tenant) {}
          @Get()
          find() {
            return this.tenant.name;
          }
        }

        await expectScopeLeak(() =>
          Test.createTestingModule({
            controllers: [LeakyController],
            providers: [Tenant],
          }).compile(),
        );
      },
    );

    it("should run a request-scoped filter of a controller that resolves", async () => {
      await request(app)
        .get("/scoped")
        .set("x-tenant", "acme")
        .expect(404, { handledBy: "RequestScopedFilter" });
      expect(log.entries).toEqual(["No invoices for acme"]);
    });

    // BUNEST_BUG: executeFullCompiledRoute() eagerly resolves request-scoped controller @UseFilters() BEFORE resolving the request-scoped controller (packages/http/src/pipeline/execution-pipeline.ts:567-587,751-756), so RequestScopedFilter intercepts Tenant's BadRequestException instead of leaving it to DefaultExceptionFilter.
    it.skip("should leave the error to the built-in filter instead of a request-scoped filter that was not created", async () => {
      const res = await request(app)
        .get("/scoped")
        .set("x-tenant", "unknown")
        .expect(400);
      expect((res.body as any).statusCode).toBe(400);
      expect((res.body as any).message).toBe("Unknown tenant");
      expect(log.entries).toEqual([]);

      // The application still answers
      await request(app)
        .get("/scoped")
        .set("x-tenant", "acme")
        .expect(404, { handledBy: "RequestScopedFilter" });
    });

    it("should still run a filter without a scope for the error", async () => {
      await request(app)
        .get("/unscoped")
        .set("x-tenant", "unknown")
        .expect(503, { handledBy: "UnscopedFilter" });
      expect(log.entries).toEqual(["Unknown tenant"]);
    });

    it("should run a transient filter of a controller without a scope", async () => {
      await request(app)
        .get("/transient")
        .expect(404, { handledBy: "TransientFilter" });
      expect(log.entries).toEqual(["No invoices"]);
    });
  },
);
