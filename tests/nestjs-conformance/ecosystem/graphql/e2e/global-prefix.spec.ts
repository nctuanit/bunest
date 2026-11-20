import "reflect-metadata";
import { afterEach, beforeEach, describe, it } from "bun:test";
import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  Module,
  UseGuards,
} from "../../../../../packages/common/src";
import {
  type BunestApplication,
  NestFactory,
} from "../../../../../packages/core/src";
import {
  GqlExecutionContext,
  type GqlOptionsFactory,
  GraphQLModule,
  type GraphQLModuleOptions,
  Query,
  ResolveField,
  Resolver,
} from "../../../../../packages/graphql/src";
import {
  Test,
  describeConformance,
  request,
} from "../../../_helpers/index";

const CATS_TYPE_DEFS = `
  type Query {
    getCats: [Cat]
    cat(id: ID!): Cat
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
      useGlobalPrefix: true,
    }),
  ],
})
class GlobalPrefixModule {}

@Module({
  imports: [
    CatsModule,
    GraphQLModule.forRootAsync({
      useFactory: async () => ({
        typeDefs: CATS_TYPE_DEFS,
        useGlobalPrefix: true,
      }),
    }),
  ],
})
class GlobalPrefixAsyncOptionsModule {}

@Injectable()
class ConfigService implements GqlOptionsFactory {
  createGqlOptions(): GraphQLModuleOptions {
    return {
      typeDefs: CATS_TYPE_DEFS,
      useGlobalPrefix: true,
    };
  }
}

@Module({
  imports: [
    CatsModule,
    GraphQLModule.forRootAsync({
      useClass: ConfigService,
    }),
  ],
})
class GlobalPrefixAsyncOptionsClassModule {}

const QUERY_PAYLOAD = {
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
};

const EXPECTED_RESPONSE = {
  data: {
    getCats: [
      {
        id: 1,
        color: "black",
        weight: 5,
      },
    ],
  },
};

describeConformance(
  "GraphQL (global prefix)",
  {
    upstreamPath: "packages/apollo/tests/e2e/global-prefix.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Replaces ExpressAdapter and ApolloDriver with native Bunest HTTP adapter and @bunest/graphql GraphQLModule.forRoot()/forRootAsync().",
  },
  () => {
    let app: BunestApplication;

    describe("Global prefix with starting slash", () => {
      beforeEach(async () => {
        const moduleRef = await Test.createTestingModule({
          imports: [GlobalPrefixModule],
        }).compile({ logger: false });

        app = moduleRef.createNestApplication({
          logger: false,
          abortOnError: false,
        });
        app.setGlobalPrefix("/api/v1");
        await app.init();
      });

      it("should return query result", async () => {
        await request(app)
          .post("/api/v1/graphql")
          .send(QUERY_PAYLOAD)
          .expect(200, EXPECTED_RESPONSE);
      });

      afterEach(async () => {
        if (app) {
          await app.close();
        }
      });
    });

    describe("Global prefix without starting slash", () => {
      beforeEach(async () => {
        const moduleRef = await Test.createTestingModule({
          imports: [GlobalPrefixModule],
        }).compile({ logger: false });

        app = moduleRef.createNestApplication({
          logger: false,
          abortOnError: false,
        });
        app.setGlobalPrefix("api/v1");
        await app.init();
      });

      it("should return query result", async () => {
        await request(app)
          .post("/api/v1/graphql")
          .send(QUERY_PAYLOAD)
          .expect(200, EXPECTED_RESPONSE);
      });

      afterEach(async () => {
        if (app) {
          await app.close();
        }
      });
    });

    describe("Global prefix with ending slash", () => {
      beforeEach(async () => {
        const moduleRef = await Test.createTestingModule({
          imports: [GlobalPrefixModule],
        }).compile({ logger: false });

        app = moduleRef.createNestApplication({
          logger: false,
          abortOnError: false,
        });
        app.setGlobalPrefix("/api/v1/");
        await app.init();
      });

      it("should return query result", async () => {
        await request(app)
          .post("/api/v1/graphql")
          .send(QUERY_PAYLOAD)
          .expect(200, EXPECTED_RESPONSE);
      });

      afterEach(async () => {
        if (app) {
          await app.close();
        }
      });
    });

    describe("Global prefix (async configuration)", () => {
      beforeEach(async () => {
        app = await NestFactory.create(GlobalPrefixAsyncOptionsModule, {
          logger: false,
          abortOnError: false,
        });
        app.setGlobalPrefix("/api/v1/");
        await app.init();
      });

      it("should return query result", async () => {
        await request(app)
          .post("/api/v1/graphql")
          .send(QUERY_PAYLOAD)
          .expect(200, EXPECTED_RESPONSE);
      });

      afterEach(async () => {
        if (app) {
          await app.close();
        }
      });
    });

    describe("Global prefix (async class)", () => {
      beforeEach(async () => {
        app = await NestFactory.create(GlobalPrefixAsyncOptionsClassModule, {
          logger: false,
          abortOnError: false,
        });
        app.setGlobalPrefix("/api/v1/");
        await app.init();
      });

      it("should return query result", async () => {
        await request(app)
          .post("/api/v1/graphql")
          .send(QUERY_PAYLOAD)
          .expect(200, EXPECTED_RESPONSE);
      });

      afterEach(async () => {
        if (app) {
          await app.close();
        }
      });
    });
  },
);
