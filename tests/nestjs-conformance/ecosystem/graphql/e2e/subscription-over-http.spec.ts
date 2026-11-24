import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type CanActivate,
  Injectable,
  Module,
  UseGuards,
} from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Args,
  GraphQLModule,
  type GraphQLModuleOptions,
  Int,
  Query,
  Resolver,
  Subscription,
} from "../../../../../packages/graphql/src";
import { Test, describeConformance, request } from "../../../_helpers/index";

@Injectable()
class DenyGuard implements CanActivate {
  canActivate() {
    return false;
  }
}

@Resolver()
@UseGuards(DenyGuard)
class AccountsResolver {
  static RESOLVE_CALLS = 0;

  @Query(() => Int)
  balance(): number {
    return 0;
  }

  @Subscription(() => Int, {
    resolve(_payload: unknown, args: { id: number }) {
      AccountsResolver.RESOLVE_CALLS++;
      return args.id * 1000;
    },
  })
  balanceChanged(@Args("id", { type: () => Int }) _id: number) {
    throw new Error("Not reached: the guard refuses every subscriber");
  }
}

describeConformance(
  "Subscription operations over HTTP",
  {
    upstreamPath: "packages/apollo/tests/e2e/subscription-over-http.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts Express/Fastify ApolloDriver + ApolloFederationDriver matrix to Bunest BunHttpAdapter (standard + federation modes, with SSE disabled and guarded HTTP subscription refusal).",
  },
  () => {
    const cases: Array<[string, Partial<GraphQLModuleOptions>]> = [
      [
        "GraphQLModule (HTTP subscriptions disabled)",
        { subscriptions: { sse: false } },
      ],
      [
        "GraphQLModule Federation (HTTP subscriptions disabled)",
        { federation: { version: 2 }, subscriptions: { sse: false } },
      ],
      ["GraphQLModule (default SSE with DenyGuard)", {}],
    ];

    describe.each(cases)("%s", (_label, extraOpts) => {
      let app: BunestApplication;

      beforeEach(async () => {
        @Module({
          imports: [
            GraphQLModule.forRoot({
              autoSchemaFile: true,
              includeStacktraceInErrorResponses: false,
              ...extraOpts,
            }),
          ],
          providers: [AccountsResolver, DenyGuard],
        })
        class AppModule {}

        const moduleRef = await Test.createTestingModule({
          imports: [AppModule],
        }).compile({ logger: false });

        app = moduleRef.createNestApplication({ logger: false });
        await app.init();
        AccountsResolver.RESOLVE_CALLS = 0;
      });

      afterEach(async () => {
        await app.close();
      });

      it("should refuse a subscription operation sent as a POST", async () => {
        const res = await request(app)
          .post("/graphql")
          .send({ query: "subscription { balanceChanged(id: 1) }" })
          .expect(400);

        expect(res.body.data).toBeUndefined();
        expect(Array.isArray(res.body.errors)).toBe(true);
        expect(res.body.errors.length).toBe(1);
        expect(typeof res.body.errors[0].message).toBe("string");
        expect(AccountsResolver.RESOLVE_CALLS).toBe(0);
      });

      it("should refuse a subscription operation sent as a GET", async () => {
        const res = await request(app)
          .get("/graphql")
          .query({ query: "subscription { balanceChanged(id: 1) }" });

        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(AccountsResolver.RESOLVE_CALLS).toBe(0);
      });

      it("should still execute queries", async () => {
        const res = await request(app)
          .post("/graphql")
          .send({ query: "{ __typename }" })
          .expect(200);

        expect(res.body).toEqual({ data: { __typename: "Query" } });
      });
    });
  },
);
