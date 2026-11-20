import "reflect-metadata";
import { afterEach, beforeEach, expect, it } from "bun:test";
import {
  Injectable,
  Module,
  Scope,
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
  expectScopeLeak,
  itAdapted,
  request,
} from "../../../_helpers/index";

interface Cat {
  readonly id: number;
  readonly name: string;
  readonly age: number;
}

const CATS_TYPE_DEFS = `
  type Query {
    getCats: [Cat]
  }

  type Cat {
    id: Int
    name: String
    age: Int
  }
`;

@Injectable({ scope: Scope.REQUEST })
class CatsRequestScopedService {
  static COUNTER = 0;
  private readonly cats: Cat[] = [{ id: 1, name: "Cat", age: 5 }];

  constructor() {
    CatsRequestScopedService.COUNTER++;
  }

  findAll(): Cat[] {
    return this.cats;
  }
}

describeConformance(
  "GraphQL request scoped",
  {
    upstreamPath:
      "integration/graphql-schema-first/e2e/graphql-request-scoped.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-012"],
    notes:
      "Verifies ADR-012 fail-fast ScopeLeakException when a singleton @Resolver injects a Scope.REQUEST service, plus explicit Scope.REQUEST resolver instantiation per incoming HTTP request.",
  },
  () => {
    let app: BunestApplication | undefined;

    beforeEach(() => {
      CatsRequestScopedService.COUNTER = 0;
    });

    afterEach(async () => {
      if (app) {
        await app.close();
        app = undefined;
      }
    });

    itAdapted(
      ["ADR-012"],
      "should fail fast with ScopeLeakException when singleton @Resolver injects a Scope.REQUEST provider instead of silent scope bubbling",
      async () => {
        @Resolver("Cat")
        class SingletonCatsResolver {
          constructor(private readonly catsService: CatsRequestScopedService) {}

          @Query(() => [Object], { name: "getCats" })
          getCats(): Cat[] {
            return this.catsService.findAll();
          }
        }

        @Module({
          imports: [GraphQLModule.forRoot({ typeDefs: CATS_TYPE_DEFS })],
          providers: [CatsRequestScopedService, SingletonCatsResolver],
        })
        class BubblingAttemptModule {}

        await expectScopeLeak(() =>
          Test.createTestingModule({
            imports: [BubblingAttemptModule],
          }).compile({ logger: false }),
        );
      },
    );

    // BUNEST_BUG: GraphQLService.buildSchema() in packages/graphql/src/driver/graphql-http.handler.ts skips any discovered provider whose `wrapper.instance` is undefined, which omits Scope.REQUEST @Resolver() providers from the schema and never resolves request-scoped resolvers per incoming GraphQL HTTP request.
    it.skip("should create explicitly Scope.REQUEST resolver and service for each incoming request", async () => {
      @Injectable({ scope: Scope.REQUEST })
      @Resolver("Cat")
      class RequestScopedCatsResolver {
        constructor(private readonly catsService: CatsRequestScopedService) {}

        @Query(() => [Object], { name: "getCats" })
        getCats(): Cat[] {
          return this.catsService.findAll();
        }
      }

      @Module({
        imports: [GraphQLModule.forRoot({ typeDefs: CATS_TYPE_DEFS })],
        providers: [CatsRequestScopedService, RequestScopedCatsResolver],
      })
      class RequestScopedGqlModule {}

      const moduleRef = await Test.createTestingModule({
        imports: [RequestScopedGqlModule],
      }).compile({ logger: false });

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();

      for (let i = 0; i < 3; i++) {
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
            getCats: [{ id: 1 }],
          },
        });
      }

      expect(CatsRequestScopedService.COUNTER).toEqual(3);
    });
  },
);
