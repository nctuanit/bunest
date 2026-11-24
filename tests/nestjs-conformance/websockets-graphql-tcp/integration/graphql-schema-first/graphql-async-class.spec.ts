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
  createGqlOptions(): GraphQLModuleOptions {
    return {
      typeDefs: CATS_TYPE_DEFS,
    };
  }
}

describeConformance(
  "GraphQL (async class)",
  {
    upstreamPath:
      "integration/graphql-schema-first/e2e/graphql-async-class.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008"],
    notes:
      "Verifies class-based async GraphQL options factory; documents missing useClass / GqlOptionsFactory support in GraphQLModule.forRootAsync.",
  },
  () => {
    let app: BunestApplication | undefined;

    afterEach(async () => {
      if (app) {
        await app.close();
        app = undefined;
      }
    });

    it("should return query result using GraphQLModule.forRootAsync({ useClass })", async () => {
      const asyncClassOptions = {
        useClass: ConfigService,
      } as unknown as GraphQLModuleAsyncOptions;

      @Module({
        imports: [CatsModule, GraphQLModule.forRootAsync(asyncClassOptions)],
      })
      class AsyncClassApplicationModule {}

      app = await NestFactory.create(AsyncClassApplicationModule, {
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
      "should return query result when delegating to ConfigService.createGqlOptions() via forRootAsync useFactory",
      async () => {
        @Module({
          providers: [ConfigService],
          exports: [ConfigService],
        })
        class LocalConfigModule {}

        @Module({
          imports: [
            CatsModule,
            GraphQLModule.forRootAsync({
              imports: [LocalConfigModule],
              inject: [ConfigService],
              useFactory: (configService: ConfigService) =>
                configService.createGqlOptions(),
            }),
          ],
        })
        class AsyncFactoryDelegatingClassModule {}

        app = await NestFactory.create(AsyncFactoryDelegatingClassModule, {
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
      },
    );
  },
);
