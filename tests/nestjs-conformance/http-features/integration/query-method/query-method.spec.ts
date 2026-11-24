import { afterEach, beforeEach, expect, it } from "bun:test";
import {
  BadRequestException,
  Body,
  Catch,
  Controller,
  HttpStatus,
  Injectable,
  Module,
  Param,
  Query,
  QueryMethod,
  UseFilters,
  UseGuards,
  UseInterceptors,
  type ArgumentsHost,
  type BunestInterceptor,
  type CallHandler,
  type CanActivate,
  type ExceptionFilter,
  type ExecutionContext,
  type PipeTransform,
} from "../../../../../packages/core/src/common";
import {
  HttpAdapterHost,
  type BunestApplication,
} from "../../../../../packages/core/src";
import { Test, describeConformance, itAdapted } from "../../../_helpers";

interface SearchFilters {
  name?: string;
  page?: number;
}

@Injectable()
class AllowGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}

@Injectable()
class TagInterceptor implements BunestInterceptor {
  async intercept(
    _context: ExecutionContext,
    next: CallHandler,
  ): Promise<unknown> {
    const result = (await next.handle()) as Record<string, unknown>;
    return { ...result, intercepted: true };
  }
}

@Injectable()
class UppercasePipe implements PipeTransform {
  transform(value: unknown) {
    return typeof value === "string" ? value.toUpperCase() : value;
  }
}

@Catch(BadRequestException)
class RejectFilter implements ExceptionFilter {
  constructor(private readonly adapterHost: HttpAdapterHost) {}

  catch(_exception: BadRequestException, host: ArgumentsHost) {
    const { httpAdapter } = this.adapterHost;
    const response = host.switchToHttp().getResponse();
    return httpAdapter.reply(response, { handledBy: "RejectFilter" }, 400);
  }
}

@Controller("items")
class QueryMethodController {
  @QueryMethod()
  findAll(@Body() filters: SearchFilters) {
    return { results: [], filters };
  }

  @QueryMethod("search")
  search(@Body() filters: SearchFilters) {
    return { endpoint: "search", filters };
  }

  @UseFilters(RejectFilter)
  @QueryMethod("reject")
  reject(): never {
    throw new BadRequestException("nope");
  }

  @UseGuards(AllowGuard)
  @UseInterceptors(TagInterceptor)
  @QueryMethod(":id")
  findOne(
    @Param("id") id: string,
    @Query("tenant", UppercasePipe) tenant: string,
    @Body() filters: SearchFilters,
  ) {
    return { id, tenant, filters };
  }
}

@Module({
  controllers: [QueryMethodController],
  providers: [AllowGuard, TagInterceptor, UppercasePipe, RejectFilter],
})
class QueryMethodModule {}

describeConformance(
  "QueryMethod E2E (BunHttpAdapter)",
  {
    upstreamPath: "integration/query-method/e2e/query-method.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-006", "ADR-008", "ADR-011"],
    notes:
      "Adapts NestJS HTTP QUERY method (RFC 10008 / @QueryMethod) E2E tests to BunHttpAdapter using native Web Request + Promise interceptor.",
  },
  () => {
    let app: BunestApplication;

    beforeEach(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [QueryMethodModule],
      }).compile();
      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
    });

    afterEach(async () => {
      await app.close();
    });

    async function sendQuery(
      path: string,
      method: string,
      body?: Record<string, unknown>,
    ): Promise<{ statusCode: number; json: any; headers: Headers }> {
      const res = await app.fetch(
        new Request(`http://localhost${path}`, {
          method,
          headers:
            body !== undefined ? { "content-type": "application/json" } : {},
          body: body !== undefined ? JSON.stringify(body) : undefined,
        }),
      );
      const text = await res.text();
      return {
        statusCode: res.status,
        json: text ? JSON.parse(text) : null,
        headers: res.headers,
      };
    }

    it("should route QUERY /items to the handler", async () => {
      const { statusCode, json } = await sendQuery("/items", "QUERY", {
        name: "nestjs",
        page: 1,
      });

      expect(statusCode).toBe(HttpStatus.OK);
      expect(json.filters).toEqual({ name: "nestjs", page: 1 });
    });

    it('should route QUERY /items/search to the @QueryMethod("search") handler', async () => {
      const { statusCode, json } = await sendQuery("/items/search", "QUERY", {
        name: "test",
      });

      expect(statusCode).toBe(HttpStatus.OK);
      expect(json.endpoint).toBe("search");
      expect(json.filters).toEqual({ name: "test" });
    });

    itAdapted(
      "ADR-011",
      "should return 405 Method Not Allowed (with Allow: QUERY) for GET /items (wrong method)",
      async () => {
        const { statusCode, headers } = await sendQuery("/items", "GET");
        expect(statusCode).toBe(HttpStatus.METHOD_NOT_ALLOWED);
        expect(headers.get("allow")).toContain("QUERY");
      },
      "Bunest returns O(1) 405 + Allow header instead of Express 404 for wrong HTTP method",
    );

    itAdapted(
      "ADR-008",
      "combines @Param(), @Query() and @Body() on a QUERY route, through a guard/interceptor/pipe",
      async () => {
        const { statusCode, json } = await sendQuery(
          "/items/42?tenant=acme",
          "QUERY",
          { name: "nestjs" },
        );

        expect(statusCode).toBe(HttpStatus.OK);
        expect(json).toEqual({
          id: "42",
          tenant: "ACME",
          filters: { name: "nestjs" },
          intercepted: true,
        });
      },
      "Promise-based interceptor instead of RxJS map()",
    );

    it("runs exception filters for a QUERY route", async () => {
      const { statusCode, json } = await sendQuery(
        "/items/reject",
        "QUERY",
        {},
      );

      expect(statusCode).toBe(HttpStatus.BAD_REQUEST);
      expect(json).toEqual({ handledBy: "RejectFilter" });
    });
  },
);
