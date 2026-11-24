import { afterEach, describe, expect, it } from "bun:test";
import {
  Catch,
  Controller,
  Get,
  HttpException,
  Injectable,
  Module,
  type ArgumentsHost,
  type BunestMiddleware,
  type BunestModule,
  type ExceptionFilter,
  type MiddlewareConsumer,
  type NextFunction,
  type ResponseContext,
  type Type,
} from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Test,
  describeConformance,
  itAdapted,
  request,
} from "../../../_helpers";

class CsrfError extends Error {
  readonly status = 403;
  readonly statusCode = 403;
  readonly expose = true;
  readonly code = "EBADCSRFTOKEN";

  constructor() {
    super("invalid csrf token");
  }
}

@Catch(HttpException)
class CsrfErrorFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost) {
    const cause = exception.cause as CsrfError | undefined;
    host.switchToHttp().getResponse().status(499);
    return {
      status: exception.getStatus(),
      cause: cause?.constructor.name,
      code: cause?.code,
      isCsrfError: cause instanceof CsrfError,
    };
  }
}

@Catch()
class FailingFilter implements ExceptionFilter {
  calls = 0;

  catch(_exception: unknown, _host: ArgumentsHost): never {
    this.calls++;
    throw new HttpException("Range Not Satisfiable", 416);
  }
}

@Injectable()
class CsrfMiddleware implements BunestMiddleware {
  use(_req: Request, _res: ResponseContext, _next: NextFunction) {
    throw new CsrfError();
  }
}

@Controller()
class ErrorsController {
  @Get("ok")
  ok() {
    return "ok";
  }

  @Get("guarded")
  guarded() {
    return "guarded";
  }
}

@Module({ controllers: [ErrorsController] })
class ErrorsModule {}

@Module({ controllers: [ErrorsController] })
class ClassMiddlewareErrorsModule implements BunestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(CsrfMiddleware).forRoutes("guarded");
  }
}

async function createApp(
  mod: Type<unknown>,
  setup?: (app: BunestApplication) => void,
): Promise<BunestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [mod],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  setup?.(app);
  await app.init();
  return app;
}

describeConformance(
  "Errors from middleware",
  {
    upstreamPath: "integration/http-adapters/e2e/middleware-errors.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008", "ADR-010"],
    notes:
      "Adapts Express/Fastify/Node next(err) middleware error tests to Bunest Promise middleware throw semantics (ADR-008).",
  },
  () => {
    describe("Errors from sync middleware", () => {
      let app: BunestApplication | undefined;
      const get = (path: string) => request(app!).get(path);

      afterEach(async () => {
        await app?.close();
        app = undefined;
      });

      // BUNEST_BUG: Expected http-errors-shaped error (CsrfError, statusCode: 403) thrown in app.use() middleware to be mapped to HttpException with { cause } so @Catch(HttpException) catches it (499); actual returns 500 because execution-pipeline does not wrap middleware http-errors objects into HttpException (packages/core/src/http/pipeline/execution-pipeline.ts, packages/core/src/http/pipeline/exception-handler.ts).
      it.skip("should hand an error thrown by app.use() middleware to filters as the cause of an HttpException", async () => {
        app = await createApp(ErrorsModule, (instance) => {
          instance.use((_req, _res, _next) => {
            throw new CsrfError();
          });
          instance.useGlobalFilters(new CsrfErrorFilter());
        });

        const res = await get("/ok");

        expect(res.status).toBe(499);
        expect(res.body).toEqual({
          status: 403,
          cause: "CsrfError",
          code: "EBADCSRFTOKEN",
          isCsrfError: true,
        });
      });

      // BUNEST_BUG: Expected http-errors-shaped error (CsrfError) thrown in class middleware to be mapped to HttpException with { cause } so @Catch(HttpException) catches it (499); actual returns 500 (packages/core/src/http/pipeline/execution-pipeline.ts, packages/core/src/http/pipeline/exception-handler.ts).
      it.skip("should hand an error from a class middleware to filters as the cause of an HttpException", async () => {
        app = await createApp(ClassMiddlewareErrorsModule, (instance) => {
          instance.useGlobalFilters(new CsrfErrorFilter());
        });

        const res = await get("/guarded");

        expect(res.status).toBe(499);
        expect(res.body.isCsrfError).toBe(true);
      });

      // BUNEST_BUG: Expected http-errors-shaped error (statusCode: 403, expose: true) thrown in middleware to return 403 { statusCode: 403, message: "invalid csrf token" } without a filter; actual DefaultExceptionFilter ignores statusCode on non-HttpException errors and returns 500 (packages/core/src/http/pipeline/exception-handler.ts).
      it.skip("should answer an http-errors-style error with its status and message without a filter", async () => {
        app = await createApp(ErrorsModule, (instance) => {
          instance.use((_req, _res, _next) => {
            throw new CsrfError();
          });
        });

        const res = await get("/ok");

        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({
          statusCode: 403,
          message: "invalid csrf token",
        });
      });

      // BUNEST_BUG: Expected synchronously thrown http-errors-shaped error (statusCode: 403) in middleware to return 403; actual returns 500 (packages/core/src/http/pipeline/exception-handler.ts).
      it.skip("should answer an error thrown synchronously by middleware the same way", async () => {
        app = await createApp(ErrorsModule, (instance) => {
          instance.use(() => {
            throw new CsrfError();
          });
        });

        expect((await get("/ok")).status).toBe(403);
      });

      // BUNEST_BUG: Expected plain { statusCode: 422, message: "plain object" } thrown in middleware to return 422; actual returns 500 (packages/core/src/http/pipeline/exception-handler.ts).
      it.skip("should answer a plain { statusCode, message } object with its status", async () => {
        app = await createApp(ErrorsModule, (instance) => {
          instance.use(() => {
            throw { statusCode: 422, message: "plain object" };
          });
        });

        const res = await get("/ok");

        expect(res.status).toBe(422);
        expect(res.body).toMatchObject({
          statusCode: 422,
          message: "plain object",
        });
      });

      it("should answer an HttpException from middleware with its response", async () => {
        app = await createApp(ErrorsModule, (instance) => {
          instance.use(() => {
            throw new HttpException({ reason: "teapot" }, 418);
          });
        });

        const res = await get("/ok");

        expect(res.status).toBe(418);
        expect(res.body).toMatchObject({ reason: "teapot" });
      });
    });

    describe("Errors from async middleware", () => {
      let app: BunestApplication | undefined;

      afterEach(async () => {
        await app?.close();
        app = undefined;
      });

      // BUNEST_BUG: Expected async middleware rejection with http-errors-shaped CsrfError to be wrapped as HttpException with { cause } and caught by @Catch(HttpException) (499); actual returns 500 (packages/core/src/http/pipeline/execution-pipeline.ts, packages/core/src/http/pipeline/exception-handler.ts).
      it.skip("should hand the rejection to filters as the cause of an HttpException", async () => {
        app = await createApp(ErrorsModule, (instance) => {
          instance.use(async () => {
            throw new CsrfError();
          });
          instance.useGlobalFilters(new CsrfErrorFilter());
        });

        const res = await request(app).get("/ok");

        expect(res.status).toBe(499);
        expect(res.body.isCsrfError).toBe(true);
      });
    });

    describe("Exception filters that fail as well", () => {
      let app: BunestApplication | undefined;

      afterEach(async () => {
        await app?.close();
        app = undefined;
      });

      itAdapted(
        "ADR-008",
        "should not run a filter again and again when the filter itself throws",
        async () => {
          const filter = new FailingFilter();
          app = await createApp(ErrorsModule, (instance) => {
            instance.useGlobalFilters(filter);
          });

          const res = await request(app)
            .get("/missing")
            .set("Range", "bytes=99999-")
            .timeout(2000);

          expect(res.status).toBe(416);
          expect(filter.calls).toBe(1);
        },
        "Bunest delegates filter errors straight to DefaultExceptionFilter without re-entering custom filters",
      );
    });
  },
);
