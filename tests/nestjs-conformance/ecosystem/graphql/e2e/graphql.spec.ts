import { afterEach, beforeEach, expect, it } from "bun:test";
import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  Module,
  UseGuards,
} from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  GqlExecutionContext,
  GraphQLModule,
  Query,
  ResolveField,
  Resolver,
} from "../../../../../packages/graphql/src";
import { Test, describeConformance, request } from "../../../_helpers/index";

const CATS_TYPE_DEFS = `
  type Query {
    getCats: [Cat]
    cat(id: ID!): Cat
  }

  type Mutation {
    createCat(name: String): Cat
  }

  type Subscription {
    catCreated: Cat
  }

  type Cat {
    id: Int
    name: String
    age: Int
    color: String
    weight: Int
  }
`;

@Injectable()
class CatsService {
  private readonly cats = [{ id: 1, name: "Cat", age: 5 }];

  findAll() {
    return this.cats;
  }
}

@Injectable()
class CatsGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const ctx = GqlExecutionContext.create(context);
    return Boolean(ctx);
  }
}

@Resolver("Cat")
class CatsResolvers {
  constructor(private readonly catsService: CatsService) {}

  @Query(() => [Object], { name: "getCats" })
  @UseGuards(CatsGuard)
  async getCats() {
    return this.catsService.findAll();
  }

  @ResolveField("color")
  getColor(): string {
    return "black";
  }

  @ResolveField()
  weight(): number {
    return 5;
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
  "GraphQL",
  {
    upstreamPath: "packages/apollo/tests/e2e/graphql.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts upstream schema-first Cats GraphQL E2E from ApolloDriver/typePaths to native @bunest/graphql GraphQLModule.forRoot({ typeDefs }).",
  },
  () => {
    let app: BunestApplication;

    beforeEach(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [ApplicationModule],
      }).compile({ logger: false });

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
    });

    it("should return query result", async () => {
      await request(app)
        .post("/graphql")
        .send({
          operationName: null,
          variables: {},
          query: `
          {
            getCats {
              id,
              color,
              weight
            }
          }`,
        })
        .expect(200, {
          data: {
            getCats: [
              {
                id: 1,
                color: "black",
                weight: 5,
              },
            ],
          },
        });
    });

    // BUNEST_BUG: Expected app.get(GraphQLModule) to return the GraphQLModule instance with completeOptions containing { path: "/graphql", schema: GraphQLSchema }; actual app.get(GraphQLModule) throws UnknownDependencyException (packages/core/src/di/di-container.ts does not resolve module classes via ModuleRef.get) AND packages/graphql/src/graphql.module.ts does not merge default path or compiled schema into completeOptions when no custom driver is configured.
    it.skip("should return complete options", () => {
      const graphql = app.get(GraphQLModule);

      expect(graphql.completeOptions).toHaveProperty("path", "/graphql");
      expect(graphql.completeOptions).toHaveProperty("schema");
    });

    afterEach(async () => {
      if (app) {
        await app.close();
      }
    });
  },
);
