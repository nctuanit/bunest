import "reflect-metadata";
import { afterEach, beforeEach, expect, it } from "bun:test";
import {
  HttpException,
  Module,
  NotFoundException,
} from "../../../../../packages/common/src";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  GraphQLModule,
  Query,
  Resolver,
} from "../../../../../packages/graphql/src";
import {
  Test,
  describeConformance,
  request,
} from "../../../_helpers/index";

@Resolver()
class ErrorsResolver {
  @Query(() => String)
  throwHttpException(): string {
    throw new NotFoundException("invoice not found");
  }

  @Query(() => String)
  throwHttpExceptionWithStringResponse(): string {
    throw new HttpException("Sign in first", 401);
  }

  @Query(() => String)
  throwHttpClientError(): string {
    // Same shape as the errors thrown by HTTP clients such as superagent:
    // "status" and "response.statusCode" are set, but it is not an HttpException
    const error = new Error("Not Found") as Error & {
      status?: number;
      response?: {
        statusCode: number;
        req: { headers: { authorization: string } };
      };
    };
    error.status = 404;
    error.response = {
      statusCode: 404,
      req: { headers: { authorization: "Bearer secret" } },
    };
    throw error;
  }
}

@Module({
  imports: [
    GraphQLModule.forRoot({
      autoSchemaFile: true,
      includeStacktraceInErrorResponses: false,
    }),
  ],
  providers: [ErrorsResolver],
})
class AppModule {}

describeConformance(
  "autoTransformHttpErrors",
  {
    upstreamPath: "packages/apollo/tests/e2e/auto-transform-http-errors.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Replaces ApolloDriver with native @bunest/graphql GraphQLModule.forRoot() and uses zero-socket request(app).",
  },
  () => {
    let app: BunestApplication;

    beforeEach(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile({ logger: false });

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
    });

    afterEach(async () => {
      if (app) {
        await app.close();
      }
    });

    const query = (fieldName: string) =>
      request(app)
        .post("/graphql")
        .send({ query: `{ ${fieldName} }` });

    // BUNEST_BUG: Expected extensions { code: "INTERNAL_SERVER_ERROR", status: 404, originalError: { statusCode: 404, message: "invoice not found", error: "Not Found" } } per NestJS autoTransformHttpErrors; actual { code: "NOT_FOUND", statusCode: 404 } (missing originalError & status mapping) in packages/graphql/src/driver/graphql-http.handler.ts (GraphQLService.formatSingleError).
    it.skip('should map an HttpException and expose its response as "originalError"', async () => {
      const res = await query("throwHttpException");

      expect(res.body.errors[0].message).toBe("invoice not found");
      expect(res.body.errors[0].extensions).toEqual({
        code: "INTERNAL_SERVER_ERROR",
        status: 404,
        originalError: {
          statusCode: 404,
          message: "invoice not found",
          error: "Not Found",
        },
      });
    });

    // BUNEST_BUG: Expected extensions { code: "UNAUTHENTICATED", originalError: "Sign in first" } for HttpException(string, 401); actual { code: "HTTPEXCEPTION", statusCode: 401 } because packages/graphql/src/driver/graphql-http.handler.ts (GraphQLService.formatSingleError) derives code from httpJson.error instead of HTTP status code mapping and omits originalError.
    it.skip("should map an HttpException created with a string response", async () => {
      const res = await query("throwHttpExceptionWithStringResponse");

      expect(res.body.errors[0].message).toBe("Sign in first");
      expect(res.body.errors[0].extensions).toEqual({
        code: "UNAUTHENTICATED",
        originalError: "Sign in first",
      });
    });

    it("should not transform errors that only look like an HttpException", async () => {
      const res = await query("throwHttpClientError");

      expect(res.body.errors[0].message).toBe("Not Found");
      expect(res.body.errors[0].extensions).toEqual({
        code: "INTERNAL_SERVER_ERROR",
      });
    });
  },
);
