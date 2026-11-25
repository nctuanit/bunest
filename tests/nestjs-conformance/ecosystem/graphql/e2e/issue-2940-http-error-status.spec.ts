import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { GraphQLError } from "../../../../../packages/graphql/src";
import {
  BadRequestException,
  Module,
} from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  GraphQLModule,
  type GraphQLModuleOptions,
  Query,
  Resolver,
} from "../../../../../packages/graphql/src";
import { Test, describeConformance, request } from "../../../_helpers/index";

@Resolver()
class IssueResolver {
  @Query(() => String)
  throwHttpException(): string {
    throw new BadRequestException("foo");
  }

  @Query(() => String)
  throwGraphqlErrorWithHttpStatus(): string {
    throw new GraphQLError("boom", {
      extensions: {
        code: "BAD_REQUEST",
        http: { status: 400 },
      },
    });
  }
}

function buildModule(preserveHttpStatusForExecutionErrors?: boolean) {
  @Module({
    imports: [
      GraphQLModule.forRoot({
        autoSchemaFile: true,
        includeStacktraceInErrorResponses: false,
        ...(preserveHttpStatusForExecutionErrors !== undefined
          ? { preserveHttpStatusForExecutionErrors }
          : {}),
      } as GraphQLModuleOptions),
    ],
    providers: [IssueResolver],
  })
  class Issue2940Module {}
  return Issue2940Module;
}

async function bootstrap(preserveHttpStatusForExecutionErrors?: boolean) {
  const moduleRef = await Test.createTestingModule({
    imports: [buildModule(preserveHttpStatusForExecutionErrors)],
  }).compile({ logger: false });

  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  return app;
}

describeConformance(
  "Issue #2940 - GraphQL error formatting with HTTP status",
  {
    upstreamPath:
      "packages/apollo/tests/e2e/issue-2940-http-error-status.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Replaces ApolloDriver with native @bunest/graphql GraphQLModule.forRoot() and zero-socket request(app).",
  },
  () => {
    describe("default (preserveHttpStatusForExecutionErrors enabled)", () => {
      let app: BunestApplication;

      beforeEach(async () => {
        app = await bootstrap();
      });

      afterEach(async () => {
        if (app) {
          await app.close();
        }
      });

      it("should return the standard {data, errors} response shape (HTTP 200) when a NestJS HttpException is thrown from a resolver", async () => {
        const res = await request(app)
          .post("/graphql")
          .send({ query: "{ throwHttpException }" });

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty("data", null);
        expect(res.body).toHaveProperty("errors");
        expect(res.body).not.toHaveProperty("error");
        expect(res.body.errors[0].extensions).toMatchObject({
          code: "BAD_REQUEST",
          originalError: {
            statusCode: 400,
            message: "foo",
          },
        });
        expect(res.body.errors[0].extensions).not.toHaveProperty("http");
      });

      it("should keep the response at HTTP 200 when a resolver throws a GraphQLError carrying extensions.http.status", async () => {
        const res = await request(app)
          .post("/graphql")
          .send({ query: "{ throwGraphqlErrorWithHttpStatus }" });

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty("data", null);
        expect(res.body).toHaveProperty("errors");
        expect(res.body).not.toHaveProperty("error");
        expect(res.body.errors[0].extensions.code).toBe("BAD_REQUEST");
        expect(res.body.errors[0].extensions).not.toHaveProperty("http");
      });

      it("should still return a non-200 status for request-level errors (e.g. parse failures)", async () => {
        const res = await request(app)
          .post("/graphql")
          .send({ query: "{ throwHttpException " });

        expect(res.status).toBe(400);
        expect(res.body).not.toHaveProperty("data");
        expect(res.body).toHaveProperty("errors");
      });
    });

    describe("with preserveHttpStatusForExecutionErrors disabled", () => {
      let app: BunestApplication;

      beforeEach(async () => {
        app = await bootstrap(false);
      });

      afterEach(async () => {
        if (app) {
          await app.close();
        }
      });

      it("should preserve Apollo Server's extensions.http.status response status when the user opts out", async () => {
        const res = await request(app)
          .post("/graphql")
          .send({ query: "{ throwGraphqlErrorWithHttpStatus }" });

        expect(res.status).toBe(400);
        expect(res.body).toHaveProperty("data", null);
        expect(res.body).toHaveProperty("errors");
      });
    });
  },
);
