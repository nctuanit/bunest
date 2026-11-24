import { afterEach, beforeEach, expect, it } from "bun:test";
import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  Module,
  UseGuards,
} from "../../../../../packages/core/src/common";
import {
  type BunestApplication,
  NestFactory,
} from "../../../../../packages/core/src";
import {
  GqlExecutionContext,
  GraphQLModule,
  Query,
  Resolver,
} from "../../../../../packages/graphql/src";
import { describeConformance, request } from "../../../_helpers/index";

interface Cat {
  readonly id: number;
  readonly name: string;
  readonly age: number;
}

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
  private readonly cats: Cat[] = [{ id: 1, name: "Cat", age: 5 }];

  findAll(): Cat[] {
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
  async getCats(): Promise<Cat[]> {
    return this.catsService.findAll();
  }
}

@Module({
  providers: [CatsService, CatsResolvers],
})
class CatsModule {}

@Module({
  imports: [
    CatsModule,
    GraphQLModule.forRootAsync({
      useFactory: async () => ({
        typeDefs: CATS_TYPE_DEFS,
      }),
    }),
  ],
})
class AsyncApplicationModule {}

describeConformance(
  "GraphQL (async configuration)",
  {
    upstreamPath: "integration/graphql-schema-first/e2e/graphql-async.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008"],
    notes:
      "Adapts upstream GraphQLModule.forRootAsync({ useFactory }) schema-first E2E to native @bunest/graphql.",
  },
  () => {
    let app: BunestApplication;

    beforeEach(async () => {
      app = await NestFactory.create(AsyncApplicationModule, { logger: false });
      await app.init();
    });

    afterEach(async () => {
      await app.close();
    });

    it("should return query result", async () => {
      const res = await request(app)
        .post("/graphql")
        .send({
          operationName: null,
          variables: {},
          query: "{\n  getCats {\n    id\n  }\n}\n",
        })
        .expect(200);

      expect(res.body).toEqual({
        data: {
          getCats: [
            {
              id: 1,
            },
          ],
        },
      });
    });
  },
);
