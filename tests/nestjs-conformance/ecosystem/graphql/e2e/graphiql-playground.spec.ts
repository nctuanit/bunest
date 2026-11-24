import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type DynamicModule,
  Injectable,
  Module,
} from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  GraphQLModule,
  type GraphQLModuleOptions,
  Query,
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
  }

  type Cat {
    id: Int
    name: String
  }
`;

@Injectable()
class CatsService {
  findAll() {
    return [{ id: 1, name: "Cat" }];
  }
}

@Resolver("Cat")
class CatsResolvers {
  constructor(private readonly catsService: CatsService) {}

  @Query(() => [Object], { name: "getCats" })
  getCats() {
    return this.catsService.findAll();
  }
}

@Module({
  providers: [CatsService, CatsResolvers],
})
class CatsModule {}

interface ExtendedGraphiQLOptions {
  headers?: Record<string, string>;
  shouldPersistHeaders?: boolean;
  isHeadersEditorEnabled?: boolean;
  inputValueDeprecation?: boolean;
}

@Module({
  imports: [CatsModule],
})
class GraphiQLPlaygroundModule {
  static withDefaults(): DynamicModule {
    return {
      module: GraphiQLPlaygroundModule,
      imports: [
        GraphQLModule.forRoot({
          typeDefs: CATS_TYPE_DEFS,
        }),
      ],
    };
  }

  static withPlaygroundEnabled(): DynamicModule {
    return {
      module: GraphiQLPlaygroundModule,
      imports: [
        GraphQLModule.forRoot({
          playground: true,
          typeDefs: CATS_TYPE_DEFS,
        }),
      ],
    };
  }

  static withEnabled(): DynamicModule {
    return {
      module: GraphiQLPlaygroundModule,
      imports: [
        GraphQLModule.forRoot({
          graphiql: true,
          typeDefs: CATS_TYPE_DEFS,
        }),
      ],
    };
  }

  static withDisabled(): DynamicModule {
    return {
      module: GraphiQLPlaygroundModule,
      imports: [
        GraphQLModule.forRoot({
          graphiql: false,
          typeDefs: CATS_TYPE_DEFS,
        }),
      ],
    };
  }

  static withPlaygroundDisabled(): DynamicModule {
    return {
      module: GraphiQLPlaygroundModule,
      imports: [
        GraphQLModule.forRoot({
          playground: false,
          typeDefs: CATS_TYPE_DEFS,
        }),
      ],
    };
  }

  static withDisabledOverridingPlayground(): DynamicModule {
    return {
      module: GraphiQLPlaygroundModule,
      imports: [
        GraphQLModule.forRoot({
          graphiql: false,
          playground: true,
          typeDefs: CATS_TYPE_DEFS,
        }),
      ],
    };
  }

  static withEnabledAndCustomized(
    options: ExtendedGraphiQLOptions,
  ): DynamicModule {
    return {
      module: GraphiQLPlaygroundModule,
      imports: [
        GraphQLModule.forRoot({
          typeDefs: CATS_TYPE_DEFS,
          graphiql: options as unknown as boolean,
        } as GraphQLModuleOptions),
      ],
    };
  }
}

describeConformance(
  "GraphiQL Playground",
  {
    upstreamPath: "packages/apollo/tests/e2e/graphiql-playground.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Bunest renders a built-in zero-CDN interactive Playground HTML ('<title>Bunest GraphQL Playground</title>') instead of Apollo's unpkg GraphiQL CDN page, and returns GraphQL-over-HTTP 400 when disabled on GET without a query param.",
  },
  () => {
    let app: BunestApplication;

    describe("when no landing page option is configured", () => {
      beforeEach(async () => {
        const moduleRef = await Test.createTestingModule({
          imports: [GraphiQLPlaygroundModule.withDefaults()],
        }).compile({ logger: false });

        app = moduleRef.createNestApplication({ logger: false });
        await app.init();
      });

      itAdapted(
        "ADR-001",
        "should render GraphiQL Playground by default",
        async () => {
          const res = await request(app)
            .get("/graphql")
            .set("Accept", "text/html")
            .expect(200);
          expect(res.headers["content-type"]).toContain("text/html");
          expect(res.text).toContain(
            "<title>Bunest GraphQL Playground</title>",
          );
        },
        "zero-CDN built-in Playground HTML",
      );

      afterEach(async () => {
        if (app) {
          await app.close();
        }
      });
    });

    describe('when "playground" is true', () => {
      beforeEach(async () => {
        const moduleRef = await Test.createTestingModule({
          imports: [GraphiQLPlaygroundModule.withPlaygroundEnabled()],
        }).compile({ logger: false });

        app = moduleRef.createNestApplication({ logger: false });
        await app.init();
      });

      itAdapted(
        "ADR-001",
        "should render GraphiQL Playground as a migration alias",
        async () => {
          const res = await request(app)
            .get("/graphql")
            .set("Accept", "text/html")
            .expect(200);
          expect(res.headers["content-type"]).toContain("text/html");
          expect(res.text).toContain(
            "<title>Bunest GraphQL Playground</title>",
          );
        },
        "zero-CDN built-in Playground HTML",
      );

      afterEach(async () => {
        if (app) {
          await app.close();
        }
      });
    });

    describe('when "graphiql" is true', () => {
      beforeEach(async () => {
        const moduleRef = await Test.createTestingModule({
          imports: [GraphiQLPlaygroundModule.withEnabled()],
        }).compile({ logger: false });

        app = moduleRef.createNestApplication({ logger: false });
        await app.init();
      });

      itAdapted(
        "ADR-001",
        "should render GraphiQL Playground",
        async () => {
          const res = await request(app)
            .get("/graphql")
            .set("Accept", "text/html")
            .expect(200);
          expect(res.headers["content-type"]).toContain("text/html");
          expect(res.text).toContain("<!DOCTYPE html>");
          expect(res.text).toContain(
            "<title>Bunest GraphQL Playground</title>",
          );
          expect(res.text).toContain("POST /graphql");
        },
        "zero-CDN built-in Playground HTML",
      );

      afterEach(async () => {
        if (app) {
          await app.close();
        }
      });
    });

    describe('when "graphiql" is an options object', () => {
      beforeEach(async () => {
        const moduleRef = await Test.createTestingModule({
          imports: [
            GraphiQLPlaygroundModule.withEnabledAndCustomized({
              headers: {
                "x-custom-header": "custom-value",
              },
              shouldPersistHeaders: false,
              isHeadersEditorEnabled: false,
            }),
          ],
        }).compile({ logger: false });

        app = moduleRef.createNestApplication({ logger: false });
        await app.init();
      });

      it("should render GraphiQL Playground with custom options", async () => {
        const res = await request(app)
          .get("/graphql")
          .set("Accept", "text/html")
          .expect(200);
        expect(res.text).toContain('{"x-custom-header":"custom-value"}');
        expect(res.text).toContain("shouldPersistHeaders: false");
        expect(res.text).toContain("isHeadersEditorEnabled: false");
      });

      afterEach(async () => {
        if (app) {
          await app.close();
        }
      });
    });

    describe('when "graphiql" has inputValueDeprecation enabled', () => {
      beforeEach(async () => {
        const moduleRef = await Test.createTestingModule({
          imports: [
            GraphiQLPlaygroundModule.withEnabledAndCustomized({
              inputValueDeprecation: true,
            }),
          ],
        }).compile({ logger: false });

        app = moduleRef.createNestApplication({ logger: false });
        await app.init();
      });

      it("should render GraphiQL Playground with inputValueDeprecation enabled", async () => {
        const res = await request(app)
          .get("/graphql")
          .set("Accept", "text/html")
          .expect(200);
        expect(res.text).toContain("inputValueDeprecation: true");
      });

      afterEach(async () => {
        if (app) {
          await app.close();
        }
      });
    });

    describe('when "graphiql" is false', () => {
      beforeEach(async () => {
        const moduleRef = await Test.createTestingModule({
          imports: [GraphiQLPlaygroundModule.withDisabled()],
        }).compile({ logger: false });

        app = moduleRef.createNestApplication({ logger: false });
        await app.init();
      });

      itAdapted(
        "ADR-001",
        "should serve no landing page",
        async () => {
          const res = await request(app)
            .get("/graphql")
            .set("Accept", "text/html")
            .expect(400);
          expect(res.text).not.toContain(
            "<title>Bunest GraphQL Playground</title>",
          );
          expect(res.text).not.toContain("<title>GraphiQL</title>");
        },
        "returns HTTP 400 missing query param instead of Apollo 406",
      );

      afterEach(async () => {
        if (app) {
          await app.close();
        }
      });
    });

    describe('when "playground" is false', () => {
      beforeEach(async () => {
        const moduleRef = await Test.createTestingModule({
          imports: [GraphiQLPlaygroundModule.withPlaygroundDisabled()],
        }).compile({ logger: false });

        app = moduleRef.createNestApplication({ logger: false });
        await app.init();
      });

      itAdapted(
        "ADR-001",
        "should serve no landing page",
        async () => {
          const res = await request(app)
            .get("/graphql")
            .set("Accept", "text/html")
            .expect(400);
          expect(res.text).not.toContain(
            "<title>Bunest GraphQL Playground</title>",
          );
          expect(res.text).not.toContain("<title>GraphiQL</title>");
        },
        "returns HTTP 400 missing query param instead of Apollo 406",
      );

      afterEach(async () => {
        if (app) {
          await app.close();
        }
      });
    });

    describe('when "graphiql" is false and "playground" is true', () => {
      beforeEach(async () => {
        const moduleRef = await Test.createTestingModule({
          imports: [
            GraphiQLPlaygroundModule.withDisabledOverridingPlayground(),
          ],
        }).compile({ logger: false });

        app = moduleRef.createNestApplication({ logger: false });
        await app.init();
      });

      it('should let "graphiql" take precedence over the deprecated alias', async () => {
        const res = await request(app)
          .get("/graphql")
          .set("Accept", "text/html");
        expect(res.status).not.toBe(200);
        expect(res.text).not.toContain(
          "<title>Bunest GraphQL Playground</title>",
        );
        expect(res.text).not.toContain("<title>GraphiQL</title>");
      });

      afterEach(async () => {
        if (app) {
          await app.close();
        }
      });
    });
  },
);
