import { afterEach, beforeEach, expect, it } from "bun:test";
import { Module } from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Context,
  GraphQLModule,
  Query,
  Resolver,
} from "../../../../../packages/graphql/src";
import { Test, describeConformance, request } from "../../../_helpers/index";

@Resolver()
class CustomContextResolver {
  @Query(() => String)
  fooFromContext(@Context() ctx: Record<string, unknown>): string {
    return ctx.foo as string;
  }
}

@Module({
  imports: [
    GraphQLModule.forRoot({
      autoSchemaFile: true,
      context: (args) => ({
        foo: "bar",
        request: args.req,
      }),
    }),
  ],
  providers: [CustomContextResolver],
})
class CustomContextModule {}

describeConformance(
  "GraphQL (custom context)",
  {
    upstreamPath: "packages/apollo/tests/e2e/custom-context.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Runs with Bunest native BunHttpAdapter instead of ExpressAdapter/FastifyAdapter (ADR-001) and native @bunest/graphql GraphQLModule.forRoot().",
  },
  () => {
    let app: BunestApplication;

    beforeEach(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [CustomContextModule],
      }).compile({ logger: false });

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
    });

    afterEach(async () => {
      if (app) {
        await app.close();
      }
    });

    it("should return query result", async () => {
      const res = await request(app)
        .post("/graphql")
        .send({
          operationName: null,
          variables: {},
          query: `
          {
            fooFromContext
          }
          `,
        })
        .expect(200);

      expect(res.body).toEqual({
        data: {
          fooFromContext: "bar",
        },
      });
    });
  },
);
