import { afterEach, expect, it } from "bun:test";
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
  type GraphQLModuleAsyncOptions,
  type GraphQLModuleOptions,
  Query,
  Resolver,
} from "../../../../../packages/graphql/src";
import {
  describeConformance,
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
    return Boolean(GqlExecutionContext.create(context));
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

@Injectable()
class ConfigService {
  readonly instanceId = crypto.randomUUID();

  createGqlOptions(): GraphQLModuleOptions {
    return {
      typeDefs: CATS_TYPE_DEFS,
    };
  }
}

@Module({
  providers: [ConfigService],
  exports: [ConfigService],
})
class ConfigModule {}

describeConformance(
  "GraphQL (async existing)",
  {
    upstreamPath:
      "integration/graphql-schema-first/e2e/graphql-async-existing.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008"],
    notes:
      "Verifies reusing an exported ConfigService instance for async GraphQL config; documents missing useExisting support in GraphQLModule.forRootAsync.",
  },
  () => {
    let app: BunestApplication | undefined;

    afterEach(async () => {
      if (app) {
        await app.close();
        app = undefined;
      }
    });

    it("should return query result using GraphQLModule.forRootAsync({ imports: [ConfigModule], useExisting })", async () => {
      const asyncExistingOptions = {
        imports: [ConfigModule],
        useExisting: ConfigService,
      } as unknown as GraphQLModuleAsyncOptions;

      @Module({
        imports: [CatsModule, GraphQLModule.forRootAsync(asyncExistingOptions)],
      })
      class AsyncExistingApplicationModule {}

      app = await NestFactory.create(AsyncExistingApplicationModule, {
        logger: false,
      });
      await app.init();

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
    });

    itAdapted(
      ["ADR-001"],
      "should reuse exported ConfigService singleton via forRootAsync({ imports: [ConfigModule], inject: [ConfigService], useFactory })",
      async () => {
        let injectedConfig: ConfigService | undefined;

        @Module({
          imports: [
            CatsModule,
            ConfigModule,
            GraphQLModule.forRootAsync({
              imports: [ConfigModule],
              inject: [ConfigService],
              useFactory: (configService: ConfigService) => {
                injectedConfig = configService;
                return configService.createGqlOptions();
              },
            }),
          ],
        })
        class AsyncExistingAdaptedModule {}

        app = await NestFactory.create(AsyncExistingAdaptedModule, {
          logger: false,
        });
        await app.init();

        expect(injectedConfig).toBe(app.get(ConfigService));

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
      },
    );
  },
);
