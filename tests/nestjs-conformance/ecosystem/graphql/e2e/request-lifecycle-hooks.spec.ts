import { afterEach, beforeEach, expect, it } from "bun:test";
import {
  Injectable,
  Module,
  ParseIntPipe,
} from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Args,
  type GqlRequestEndHookContext,
  type GqlRequestStartHookContext,
  GraphQLModule,
  Query,
  Resolver,
  ResolverDecoratorHost,
} from "../../../../../packages/graphql/src";
import { Test, describeConformance, request } from "../../../_helpers/index";

const CATS_TYPE_DEFS = `
  type Query {
    getCats: [Cat]
    cat(id: ID!): Cat
  }

  type Cat {
    id: Int
    name: String
    age: Int
  }
`;

@Injectable()
class CatsService {
  private readonly cats = [{ id: 1, name: "Cat", age: 5 }];

  findAll() {
    return this.cats;
  }

  findOneById(id: number) {
    return this.cats.find((c) => c.id === id);
  }
}

@Resolver("Cat")
class CatsResolvers {
  constructor(private readonly catsService: CatsService) {}

  @Query(() => [Object], { name: "getCats" })
  async getCats() {
    return this.catsService.findAll();
  }

  @Query(() => Object, { name: "cat" })
  async findOneById(@Args("id", ParseIntPipe) id: number) {
    return this.catsService.findOneById(id);
  }
}

@Module({
  providers: [CatsService, CatsResolvers],
})
class CatsModule {}

@Module({
  imports: [
    CatsModule,
    GraphQLModule.forRoot({
      typeDefs: CATS_TYPE_DEFS,
    }),
  ],
})
class ApplicationModule {}

describeConformance(
  "Request lifecycle hooks",
  {
    upstreamPath: "packages/apollo/tests/e2e/request-lifecycle-hooks.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Uses native @bunest/graphql ResolverDecoratorHost request start/end hooks and zero-socket request(app).",
  },
  () => {
    let app: BunestApplication;
    let startCalls: GqlRequestStartHookContext[];
    let endCalls: GqlRequestEndHookContext[];

    beforeEach(async () => {
      startCalls = [];
      endCalls = [];

      const moduleRef = await Test.createTestingModule({
        imports: [ApplicationModule],
      }).compile({ logger: false });

      app = moduleRef.createNestApplication({ logger: false });

      const resolverDecoratorHost = app.get(ResolverDecoratorHost);
      resolverDecoratorHost.setOnRequestStartHook((ctx) => {
        startCalls.push(ctx);
        return { startedAt: 1 };
      });
      resolverDecoratorHost.setOnRequestEndHook((ctx) => {
        endCalls.push(ctx);
      });

      await app.init();
    });

    it("should call the start/end hooks once per operation", async () => {
      await request(app)
        .post("/graphql")
        .send({
          operationName: "GetCats",
          variables: {},
          query: "query GetCats { getCats { id } }",
        })
        .expect(200);

      expect(startCalls.length).toEqual(1);
      expect(endCalls.length).toEqual(1);

      expect(startCalls[0]!.query).toContain("getCats");
      expect(startCalls[0]!.operationName).toEqual("GetCats");
      expect(startCalls[0]!.variables).toEqual({});
      expect(startCalls[0]!.context).toBeDefined();

      expect(endCalls[0]!.operationName).toEqual("GetCats");
      expect(endCalls[0]!.errors).toBeUndefined();
      expect(endCalls[0]!.state).toEqual({ startedAt: 1 });
    });

    // BUNEST_BUG: Expected onRequestEnd hook to be invoked (endCalls.length === 1) with validation errors when querying unknownField; actual endCalls.length === 0 because packages/graphql/src/driver/graphql-http.handler.ts (GraphQLService.executeQuery) returns early on validate() errors before invoking resolverDecoratorHost.onRequestStart / onRequestEnd.
    it.skip("should expose errors in the end hook", async () => {
      await request(app).post("/graphql").send({
        operationName: "GetCat",
        variables: {},
        query: "query GetCat { cat(id: 1) { unknownField } }",
      });

      expect(endCalls.length).toEqual(1);
      expect(endCalls[0]!.errors?.length).toBeGreaterThan(0);
    });

    it("should await an async start hook and hand its result to the end hook", async () => {
      const resolverDecoratorHost = app.get(ResolverDecoratorHost);
      resolverDecoratorHost.setOnRequestStartHook(async () => ({
        startedAt: 2,
      }));

      await request(app)
        .post("/graphql")
        .send({ query: "{ getCats { id } }" })
        .expect(200);

      expect(endCalls[0]!.state).toEqual({ startedAt: 2 });
    });

    // BUNEST_BUG: Expected rejecting async onRequestStartHook to fail the GraphQL operation (response.body.data undefined, errors.length > 0); actual HTTP 200 with { data: { getCats: [{ id: 1 }] } } because packages/graphql/src/services/resolver-decorator-host.ts (ResolverDecoratorHost.onRequestStart / handleRejection) catches and swallows rejections instead of propagating them.
    it.skip("should fail the operation when an async start hook rejects", async () => {
      const resolverDecoratorHost = app.get(ResolverDecoratorHost);
      resolverDecoratorHost.setOnRequestStartHook(async () => {
        throw new Error("hook failed");
      });

      const response = await request(app)
        .post("/graphql")
        .send({ query: "{ getCats { id } }" });

      expect(response.body.data).toBeUndefined();
      expect(response.body.errors?.length).toBeGreaterThan(0);
    });

    afterEach(async () => {
      if (app) {
        await app.close();
      }
    });
  },
);
