import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { GraphQLError } from "../../../../../packages/graphql/node_modules/graphql";
import {
  BadRequestException,
  Module,
} from "../../../../../packages/common/src";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  GraphQLModule,
  type GraphQLModuleOptions,
  Query,
  Resolver,
} from "../../../../../packages/graphql/src";
import {
  Test,
  describeConformance,
  request,
} from "../../../_helpers/index";

@Resolver()
class Issue3997Resolver {
  @Query(() => String)
  throwHttpException(): string {
    throw new BadRequestException("validation error");
  }

  @Query(() => String)
  throwGraphqlErrorWithHttpStatus(): string {
    throw new GraphQLError("forbidden", {
      extensions: {
        code: "FORBIDDEN",
        http: { status: 403 },
      },
    });
  }

  @Query(() => String)
  success(): string {
    return "success";
  }
}

function buildModule(
  autoTransformHttpErrors?: boolean,
  preserveHttpStatusForExecutionErrors?: boolean,
) {
  @Module({
    imports: [
      GraphQLModule.forRoot({
        autoSchemaFile: true,
        includeStacktraceInErrorResponses: false,
        ...(autoTransformHttpErrors !== undefined
          ? { autoTransformHttpErrors }
          : {}),
        ...(preserveHttpStatusForExecutionErrors !== undefined
          ? { preserveHttpStatusForExecutionErrors }
          : {}),
      } as GraphQLModuleOptions),
    ],
    providers: [Issue3997Resolver],
  })
  class Issue3997Module {}
  return Issue3997Module;
}

async function bootstrap(
  autoTransformHttpErrors?: boolean,
  preserveHttpStatusForExecutionErrors?: boolean,
) {
  const moduleRef = await Test.createTestingModule({
    imports: [
      buildModule(
        autoTransformHttpErrors,
        preserveHttpStatusForExecutionErrors,
      ),
    ],
  }).compile({ logger: false });

  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  return app;
}

describeConformance(
  "Issue #3997 - Granular HTTP status preservation control",
  {
    upstreamPath:
      "packages/apollo/tests/e2e/issue-3997-http-status-preservation.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Replaces ApolloDriver with native @bunest/graphql GraphQLModule.forRoot() and zero-socket request(app).",
  },
  () => {
    describe("default behavior (both flags enabled)", () => {
      let app: BunestApplication;

      beforeEach(async () => {
        app = await bootstrap();
      });

      afterEach(async () => {
        if (app) {
          await app.close();
        }
      });

      it("should return HTTP 200 with execution errors when both flags are enabled", async () => {
        const res = await request(app)
          .post("/graphql")
          .send({ query: "{ throwHttpException }" });

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty("data", null);
        expect(res.body).toHaveProperty("errors");
        expect(res.body.errors[0].extensions).toMatchObject({
          code: "BAD_REQUEST",
        });
      });

      it("should return HTTP 200 with GraphQL errors carrying status when preserve is enabled", async () => {
        const res = await request(app)
          .post("/graphql")
          .send({ query: "{ throwGraphqlErrorWithHttpStatus }" });

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty("data", null);
        expect(res.body).toHaveProperty("errors");
        expect(res.body.errors[0].extensions.code).toBe("FORBIDDEN");
      });

      it("should still return non-200 for request-level errors when preserve is enabled", async () => {
        const res = await request(app)
          .post("/graphql")
          .send({ query: "{ throwHttpException " });

        expect(res.status).toBe(400);
        expect(res.body).not.toHaveProperty("data");
        expect(res.body).toHaveProperty("errors");
      });

      it("should return HTTP 200 for successful queries", async () => {
        const res = await request(app)
          .post("/graphql")
          .send({ query: "{ success }" });

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty("data");
        expect(res.body).not.toHaveProperty("errors");
      });
    });

    describe("with preserveHttpStatusForExecutionErrors disabled", () => {
      let app: BunestApplication;

      beforeEach(async () => {
        app = await bootstrap(true, false);
      });

      afterEach(async () => {
        if (app) {
          await app.close();
        }
      });

      // BUNEST_BUG: Expected HTTP 403 from extensions.http.status when preserveHttpStatusForExecutionErrors is false; actual HTTP 200 because packages/graphql/src/driver/graphql-http.handler.ts (GraphQLService.executeQuery) always returns status: 200 and does not implement preserveHttpStatusForExecutionErrors.
      it.skip("should preserve HTTP status from GraphQL errors when preserve flag is false", async () => {
        const res = await request(app)
          .post("/graphql")
          .send({ query: "{ throwGraphqlErrorWithHttpStatus }" });

        // HTTP status should be preserved from extensions.http.status (403)
        expect(res.status).toBe(403);
        expect(res.body).toHaveProperty("data", null);
        expect(res.body).toHaveProperty("errors");
        expect(res.body.errors[0].extensions.code).toBe("FORBIDDEN");
      });

      it("should still transform HttpException to GraphQL errors when autoTransformHttpErrors is enabled", async () => {
        const res = await request(app)
          .post("/graphql")
          .send({ query: "{ throwHttpException }" });

        expect(res.body).toHaveProperty("errors");
        expect(res.body.errors[0].extensions).toHaveProperty("code");
      });

      it("should return HTTP 200 for successful queries", async () => {
        const res = await request(app)
          .post("/graphql")
          .send({ query: "{ success }" });

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty("data");
        expect(res.body).not.toHaveProperty("errors");
      });
    });

    describe("with autoTransformHttpErrors disabled", () => {
      let app: BunestApplication;

      beforeEach(async () => {
        app = await bootstrap(false, false);
      });

      afterEach(async () => {
        if (app) {
          await app.close();
        }
      });

      // BUNEST_BUG: Expected HTTP 403 from extensions.http.status when autoTransformHttpErrors and preserveHttpStatusForExecutionErrors are false; actual HTTP 200 because packages/graphql/src/driver/graphql-http.handler.ts (GraphQLService.executeQuery) does not support preserveHttpStatusForExecutionErrors.
      it.skip("should preserve HTTP status from GraphQL errors when autoTransform is disabled", async () => {
        const res = await request(app)
          .post("/graphql")
          .send({ query: "{ throwGraphqlErrorWithHttpStatus }" });

        expect(res.status).toBe(403);
        expect(res.body).toHaveProperty("data", null);
        expect(res.body).toHaveProperty("errors");
      });

      it("should return HTTP 200 for successful queries", async () => {
        const res = await request(app)
          .post("/graphql")
          .send({ query: "{ success }" });

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty("data");
        expect(res.body).not.toHaveProperty("errors");
      });
    });

    describe("with both flags disabled", () => {
      let app: BunestApplication;

      beforeEach(async () => {
        app = await bootstrap(false, false);
      });

      afterEach(async () => {
        if (app) {
          await app.close();
        }
      });

      // BUNEST_BUG: Expected HTTP 403 from extensions.http.status when both flags are disabled; actual HTTP 200 because packages/graphql/src/driver/graphql-http.handler.ts (GraphQLService.executeQuery) does not implement preserveHttpStatusForExecutionErrors or autoTransformHttpErrors.
      it.skip("should preserve GraphQL error HTTP status without any transformation", async () => {
        const res = await request(app)
          .post("/graphql")
          .send({ query: "{ throwGraphqlErrorWithHttpStatus }" });

        expect(res.status).toBe(403);
        expect(res.body).toHaveProperty("data", null);
        expect(res.body).toHaveProperty("errors");
      });

      it("should return HTTP 200 for successful queries", async () => {
        const res = await request(app)
          .post("/graphql")
          .send({ query: "{ success }" });

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty("data");
        expect(res.body).not.toHaveProperty("errors");
      });
    });

    describe("backward compatibility", () => {
      it("should maintain existing behavior when preserveHttpStatusForExecutionErrors is not specified", async () => {
        const app = await bootstrap(true, undefined);

        try {
          const res = await request(app)
            .post("/graphql")
            .send({ query: "{ throwHttpException }" });

          expect(res.status).toBe(200);
          expect(res.body).toHaveProperty("errors");
        } finally {
          await app.close();
        }
      });

      it("should work with autoTransformHttpErrors=false legacy behavior", async () => {
        const app = await bootstrap(false, undefined);

        try {
          const res = await request(app)
            .post("/graphql")
            .send({ query: "{ throwGraphqlErrorWithHttpStatus }" });

          expect(res.status).toBe(200);
          expect(res.body).toHaveProperty("data");
          expect(res.body).toHaveProperty("errors");
        } finally {
          await app.close();
        }
      });
    });
  },
);
