import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  BadRequestException,
  Body,
  Catch,
  Controller,
  Get,
  Header,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  Logger,
  Post,
  UnauthorizedException,
  type ArgumentsHost,
  type ExceptionFilter,
} from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Test,
  describeConformance,
  itAdapted,
  request,
  stubMethod,
} from "../../../_helpers";

function createHttpLikeError(
  statusCode: number,
  message: string,
): Error & { statusCode: number; status: number; expose: boolean } {
  return Object.assign(new Error(message), {
    statusCode,
    status: statusCode,
    expose: statusCode < 500,
  });
}

@Controller()
class ErrorsController {
  @Get("sync")
  synchronous() {
    this.throwError();
  }

  @Get("async")
  async asynchronous() {
    this.throwError();
  }

  @Get("unexpected-error")
  @Header("Content-Type", "application/pdf")
  unexpectedError() {
    throw new Error();
  }

  @Get("error-with-status-code")
  errorWithStatusCode() {
    throw Object.assign(new Error("forbidden by error instance"), {
      statusCode: 403,
    });
  }

  throwError() {
    throw new BadRequestException({
      statusCode: 400,
      error: "Bad Request",
      message: "Integration test",
    });
  }
}

@Controller()
class ErrorBodyController {
  @Get("error-body")
  findAll() {
    throw new UnauthorizedException(
      new Error("invalid signature") as unknown as Record<string, unknown>,
    );
  }
}

@Controller()
class ErrorCauseController {
  @Get("error-cause")
  findAll() {
    throw new InternalServerErrorException("Oops", {
      cause: createHttpLikeError(404, "Not Found"),
    });
  }
}

@Catch(HttpException)
class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost) {
    host.switchToHttp().getResponse().status(exception.getStatus());
    return { caught: exception.getStatus() };
  }
}

@Controller()
class EchoController {
  @Post("echo")
  echo(@Body() body: unknown) {
    return body;
  }
}

@Controller()
class MiddlewareTargetController {
  @Get("middleware-error")
  middlewareError() {
    return "ok";
  }
}

describeConformance(
  "Error messages",
  {
    upstreamPath: "integration/hello-world/e2e/exceptions.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008", "ADR-009", "ADR-010"],
    notes:
      "Adapts Express/Fastify/Node adapter error matrices to BunHttpAdapter (both request(app) and app.inject()).",
  },
  () => {
    describe("BunHttpAdapter (request(app))", () => {
      let app: BunestApplication;

      beforeEach(async () => {
        const moduleRef = await Test.createTestingModule({
          controllers: [
            ErrorsController,
            ErrorBodyController,
            ErrorCauseController,
            MiddlewareTargetController,
          ],
        }).compile();

        app = moduleRef.createNestApplication({ logger: false });
        app.use((req, _res, next) => {
          if (new URL(req.url).pathname === "/middleware-error") {
            throw createHttpLikeError(
              503,
              "connect ECONNREFUSED 127.0.0.1:6379",
            );
          }
          return next();
        });
        await app.init();
      });

      afterEach(async () => {
        await app.close();
      });

      it("/GET", async () => {
        const res = await request(app)
          .get("/sync")
          .expect(HttpStatus.BAD_REQUEST);
        expect(res.body).toMatchObject({
          statusCode: 400,
          error: "Bad Request",
          message: "Integration test",
        });
      });

      it("/GET (Promise/async)", async () => {
        const res = await request(app)
          .get("/async")
          .expect(HttpStatus.BAD_REQUEST);
        expect(res.body).toMatchObject({
          statusCode: 400,
          error: "Bad Request",
          message: "Integration test",
        });
      });

      it("/GET (InternalServerError despite custom content-type)", async () => {
        const res = await request(app)
          .get("/unexpected-error")
          .expect(HttpStatus.INTERNAL_SERVER_ERROR)
          .expect("Content-Type", /application\/json/);
        expect(res.body).toMatchObject({
          statusCode: 500,
          message: "Internal server error",
        });
      });

      it("/GET (InternalServerError when Error instance has statusCode)", async () => {
        const res = await request(app)
          .get("/error-with-status-code")
          .expect(HttpStatus.INTERNAL_SERVER_ERROR);
        expect(res.body).toMatchObject({
          statusCode: 500,
          message: "Internal server error",
        });
      });

      it("/GET (Unauthorized when the body of the HttpException is an Error)", async () => {
        const res = await request(app)
          .get("/error-body")
          .expect(HttpStatus.UNAUTHORIZED);
        expect(res.body).toMatchObject({
          statusCode: 401,
          message: "Unauthorized",
        });
      });

      // BUNEST_BUG: Expected middleware-thrown http-errors error ({ statusCode: 503, expose: false }) to return 503 "Service Unavailable" and log via Logger.prototype.error; actual returns 500 "Internal server error" because DefaultExceptionFilter/execution-pipeline do not handle http-errors-shaped errors (packages/core/src/http/pipeline/exception-handler.ts, packages/core/src/http/pipeline/execution-pipeline.ts).
      it.skip('/GET (ServiceUnavailable logged when a middleware raises an "http-errors" error)', async () => {
        const logError = stubMethod(Logger.prototype, "error");
        try {
          const res = await request(app)
            .get("/middleware-error")
            .expect(HttpStatus.SERVICE_UNAVAILABLE);
          expect(res.body).toMatchObject({
            statusCode: 503,
            message: "Service Unavailable",
          });
          expect(logError.calledOnce).toBe(true);
        } finally {
          logError.restore();
        }
      });

      it('/GET (InternalServerError not logged when its cause is a 4xx "http-errors" error)', async () => {
        const logError = stubMethod(Logger.prototype, "error");
        try {
          const res = await request(app)
            .get("/error-cause")
            .expect(HttpStatus.INTERNAL_SERVER_ERROR);
          expect(res.body).toMatchObject({
            statusCode: 500,
            error: "Internal Server Error",
            message: "Oops",
          });
          expect(logError.called).toBe(false);
        } finally {
          logError.restore();
        }
      });
    });

    describe("BunHttpAdapter (app.inject())", () => {
      let app: BunestApplication;

      beforeEach(async () => {
        const moduleRef = await Test.createTestingModule({
          controllers: [ErrorsController, ErrorBodyController],
        }).compile();

        app = moduleRef.createNestApplication({ logger: false });
        await app.init();
      });

      afterEach(async () => {
        await app.close();
      });

      it("/GET", async () => {
        const { body, statusCode } = await app.inject({
          method: "GET",
          url: "/sync",
        });
        expect(statusCode).toBe(HttpStatus.BAD_REQUEST);
        expect(JSON.parse(body)).toMatchObject({
          statusCode: 400,
          error: "Bad Request",
          message: "Integration test",
        });
      });

      it("/GET (Promise/async)", async () => {
        const { body, statusCode } = await app.inject({
          method: "GET",
          url: "/async",
        });
        expect(statusCode).toBe(HttpStatus.BAD_REQUEST);
        expect(JSON.parse(body)).toMatchObject({
          statusCode: 400,
          error: "Bad Request",
          message: "Integration test",
        });
      });

      it("/GET (InternalServerError despite custom content-type)", async () => {
        const { body, statusCode } = await app.inject({
          method: "GET",
          url: "/unexpected-error",
        });
        expect(statusCode).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
        expect(JSON.parse(body)).toMatchObject({
          statusCode: 500,
          message: "Internal server error",
        });
      });

      it("/GET (InternalServerError when Error instance has statusCode)", async () => {
        const { body, statusCode } = await app.inject({
          method: "GET",
          url: "/error-with-status-code",
        });
        expect(statusCode).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
        expect(JSON.parse(body)).toMatchObject({
          statusCode: 500,
          message: "Internal server error",
        });
      });

      it("/GET (Unauthorized when the body of the HttpException is an Error)", async () => {
        const { body, statusCode } = await app.inject({
          method: "GET",
          url: "/error-body",
        });
        expect(statusCode).toBe(HttpStatus.UNAUTHORIZED);
        expect(JSON.parse(body)).toMatchObject({
          statusCode: 401,
          message: "Unauthorized",
        });
      });
    });

    describe("BunHttpAdapter (HttpException filter)", () => {
      let app: BunestApplication;

      beforeEach(async () => {
        const moduleRef = await Test.createTestingModule({
          controllers: [
            ErrorsController,
            EchoController,
            MiddlewareTargetController,
          ],
        }).compile();

        app = moduleRef.createNestApplication({
          logger: false,
          bodyLimit: 16,
        });
        app.useGlobalFilters(new HttpExceptionFilter());
        app.use((req, _res, next) => {
          if (new URL(req.url).pathname === "/middleware-error") {
            throw createHttpLikeError(413, "request entity too large");
          }
          return next();
        });
        await app.init();
      });

      afterEach(async () => {
        await app.close();
      });

      // BUNEST_BUG: Expected 4xx http-errors-shaped error ({ statusCode: 413 }) thrown in middleware to be mapped to HttpException and caught by @Catch(HttpException) filter (returning 413 { caught: 413 }); actual bypasses @Catch(HttpException) and returns 500 "Internal server error" (packages/core/src/http/pipeline/execution-pipeline.ts, packages/core/src/http/pipeline/exception-handler.ts).
      it.skip('/GET (a 4xx "http-errors" error from a middleware reaches the filter)', async () => {
        await request(app)
          .get("/middleware-error")
          .expect(HttpStatus.PAYLOAD_TOO_LARGE)
          .expect({ caught: 413 });
      });

      itAdapted(
        "ADR-001",
        "/POST (a body parser limit error reaches the filter)",
        async () => {
          await request(app)
            .post("/echo")
            .set("content-type", "application/json")
            .send(JSON.stringify({ name: "x".repeat(32) }))
            .expect(HttpStatus.PAYLOAD_TOO_LARGE)
            .expect({ caught: 413 });
        },
        "Uses Bunest bodyLimit option instead of Express/Node useBodyParser",
      );
    });
  },
);
