import { afterEach, beforeEach, it } from "bun:test";
import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  type MiddlewareConsumer,
  Module,
  type NestMiddleware,
  type NestModule,
  RequestMethod,
  UnauthorizedException,
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
import {
  Test,
  describeConformance,
  itAdapted,
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
    }),
  ],
})
class ApplicationModule {}

@Injectable()
class ApiKeyMiddleware implements NestMiddleware {
  use(req: Request, _res: unknown, next: () => void) {
    if (req.headers.get("x-api-key") !== "secret") {
      throw new UnauthorizedException();
    }
    next();
  }
}

@Module({ imports: [ApplicationModule] })
class ApiKeyModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(ApiKeyMiddleware)
      .forRoutes({ path: "graphql", method: RequestMethod.ALL });
  }
}

describeConformance(
  "GraphQL endpoint path",
  {
    upstreamPath: "packages/apollo/tests/e2e/endpoint-path.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-011"],
    notes:
      "Runs with Bunest native BunHttpAdapter and Web Standard Request headers (ADR-001) instead of ExpressAdapter/NodeAdapter.",
  },
  () => {
    let app: BunestApplication;

    beforeEach(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [ApiKeyModule],
      }).compile({ logger: false });

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
    });

    afterEach(async () => {
      if (app) {
        await app.close();
      }
    });

    const query = (path: string) =>
      request(app).post(path).send({ query: "{ getCats { id } }" });

    itAdapted(
      "ADR-011",
      "should run the middleware bound to the endpoint path",
      async () => {
        await query("/graphql").expect(401);
        await query("/graphql")
          .set("x-api-key", "secret")
          .expect(200, { data: { getCats: [{ id: 1 }] } });

        // Under ADR-011 default strict routing (ignoreTrailingSlash: false),
        // /graphql/ is rejected with 404 and cannot bypass middleware.
        await query("/graphql/").expect(404);
      },
      "strict trailing slash by default; /graphql/ tested with ignoreTrailingSlash: true below",
    );

    it("should run the middleware on /graphql and /graphql/ when ignoreTrailingSlash is enabled", async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [ApiKeyModule],
      }).compile({ logger: false });
      const lenientApp = moduleRef.createNestApplication({
        logger: false,
        ignoreTrailingSlash: true,
      });
      await lenientApp.init();
      try {
        for (const path of ["/graphql", "/graphql/"]) {
          await request(lenientApp)
            .post(path)
            .send({ query: "{ getCats { id } }" })
            .expect(401);
          await request(lenientApp)
            .post(path)
            .set("x-api-key", "secret")
            .send({ query: "{ getCats { id } }" })
            .expect(200, { data: { getCats: [{ id: 1 }] } });
        }
      } finally {
        await lenientApp.close();
      }
    });

    it("should not serve requests below the endpoint path", async () => {
      await query("/graphql/x").expect(404);
      await query("/graphql/a/b").expect(404);
      await request(app)
        .get("/graphql/x")
        .query({ query: "{ getCats { id } }" })
        .set("apollo-require-preflight", "true")
        .expect(404);
    });
  },
);
