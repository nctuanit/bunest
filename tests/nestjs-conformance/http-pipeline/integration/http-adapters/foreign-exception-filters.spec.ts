import { afterEach, expect, it } from "bun:test";
import {
  Catch,
  Controller,
  Get,
  HttpException,
  Module,
  UseGuards,
  type ArgumentsHost,
  type ExceptionFilter,
} from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Test,
  describeConformance,
  itAdapted,
  request,
} from "../../../_helpers";

// The shape of a GraphQL-style exception filter: it returns the error directly
@Catch(HttpException)
class GraphQLStyleFilter implements ExceptionFilter {
  catch(exception: HttpException) {
    return exception;
  }
}

// An async RPC-style exception filter that does not write an HTTP response
// (adapted from RxJS throwError() under ADR-008)
@Catch()
class AsyncRpcStyleFilter implements ExceptionFilter {
  async catch() {
    await new Promise((resolve) => setImmediate(resolve));
    return undefined;
  }
}

// An HTTP filter that answers after awaiting something (ADR-010 Web Response)
@Catch()
class AsyncHttpFilter implements ExceptionFilter {
  async catch(_exception: unknown, host: ArgumentsHost) {
    await new Promise((resolve) => setImmediate(resolve));
    const response = host.switchToHttp().getResponse();
    response.status(418).header("Content-Type", "text/plain");
    return "from the filter";
  }
}

@Controller()
class FiltersController {
  @Get("guarded")
  @UseGuards({ canActivate: () => false })
  guarded() {}

  @Get("fails")
  fails() {
    throw new Error("internal detail");
  }
}

@Module({ controllers: [FiltersController] })
class FiltersModule {}

describeConformance(
  "Global exception filters for another context",
  {
    upstreamPath:
      "integration/http-adapters/e2e/foreign-exception-filters.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008", "ADR-010"],
    notes:
      "Adapts Express/Fastify/Node matrix and RxJS/raw socket filters to BunHttpAdapter + ADR-008/ADR-010.",
  },
  () => {
    let app: BunestApplication | undefined;

    const createFilteredApp = async (filter: ExceptionFilter) => {
      const moduleRef = await Test.createTestingModule({
        imports: [FiltersModule],
      }).compile();
      const instance = moduleRef.createNestApplication({ logger: false });
      instance.useGlobalFilters(filter);
      await instance.init();
      return instance;
    };

    const get = (path: string) => request(app!).get(path).timeout(3000);

    afterEach(async () => {
      await app?.close();
      app = undefined;
    });

    it("should answer the HTTP errors a GraphQL-style filter returns", async () => {
      app = await createFilteredApp(new GraphQLStyleFilter());

      await get("/missing").expect(404);
      await get("/guarded").expect(403);
    });

    it("should answer the HTTP errors an async RPC-style filter leaves [ADR-008: Promise-based filter returning undefined replaces RxJS throwError() Observable]", async () => {
      app = await createFilteredApp(new AsyncRpcStyleFilter());

      await get("/missing").expect(404);
      await get("/guarded").expect(403);
      const failRes = await get("/fails").expect(500);
      expect(failRes.body).toMatchObject({
        statusCode: 500,
        message: "Internal server error",
      });
    });

    itAdapted(
      "ADR-010",
      "should leave the answer to an async filter that answers",
      async () => {
        app = await createFilteredApp(new AsyncHttpFilter());

        await get("/missing").expect(418, "from the filter");
        await get("/fails").expect(418, "from the filter");
      },
      "Uses ResponseContext + return value instead of raw Node ServerResponse.end()",
    );
  },
);
