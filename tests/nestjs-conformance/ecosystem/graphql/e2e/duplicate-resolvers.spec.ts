import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Module } from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Args,
  GraphQLModule,
  Mutation,
  Query,
  Resolver,
} from "../../../../../packages/graphql/src";
import { Test, describeConformance, request } from "../../../_helpers/index";

// Code-first duplicate resolver class names ("UserResolver") in separate modules
function createCodeFirstAppModule() {
  const ModuleAModule = (() => {
    @Resolver()
    class UserResolver {
      @Mutation(() => String, { name: "moduleALogin" })
      login(@Args("code") code: string): string {
        return code;
      }
    }

    @Module({
      providers: [UserResolver],
    })
    class ModuleA {}
    return ModuleA;
  })();

  const ModuleBModule = (() => {
    @Resolver()
    class UserResolver {
      @Mutation(() => String, { name: "moduleBLogin" })
      login(@Args("username") username: string): string {
        return username;
      }
    }

    @Module({
      providers: [UserResolver],
    })
    class ModuleB {}
    return ModuleB;
  })();

  @Resolver()
  class QueryResolver {
    @Query(() => Boolean, { name: "_" })
    test(): boolean {
      return true;
    }
  }

  @Module({
    imports: [
      GraphQLModule.forRoot({
        autoSchemaFile: true,
      }),
      ModuleAModule,
      ModuleBModule,
    ],
    providers: [QueryResolver],
  })
  class CodeFirstAppModule {}

  return CodeFirstAppModule;
}

const DUPLICATE_RESOLVER_TYPE_DEFS = `
  type Query {
    _: Boolean
  }

  type Mutation {
    moduleALogin(code: String): String
    moduleBLogin(username: String): String
  }
`;

// Schema-first duplicate resolver class names ("UserResolver") in separate modules
function createSchemaFirstAppModule() {
  const ModuleAModule = (() => {
    @Resolver()
    class UserResolver {
      @Mutation(() => String, { name: "moduleALogin" })
      login(@Args("code") code: string): string {
        return code;
      }
    }

    @Module({
      providers: [UserResolver],
    })
    class ModuleA {}
    return ModuleA;
  })();

  const ModuleBModule = (() => {
    @Resolver()
    class UserResolver {
      @Mutation(() => String, { name: "moduleBLogin" })
      login(@Args("username") username: string): string {
        return username;
      }
    }

    @Module({
      providers: [UserResolver],
    })
    class ModuleB {}
    return ModuleB;
  })();

  @Module({
    imports: [
      GraphQLModule.forRoot({
        typeDefs: DUPLICATE_RESOLVER_TYPE_DEFS,
      }),
      ModuleAModule,
      ModuleBModule,
    ],
  })
  class SchemaFirstAppModule {}

  return SchemaFirstAppModule;
}

const CodeFirstModule = createCodeFirstAppModule();
const SchemaFirstModule = createSchemaFirstAppModule();

describeConformance(
  "Duplicate resolvers",
  {
    upstreamPath: "packages/apollo/tests/e2e/duplicate-resolvers.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Replaces ApolloDriver and apolloClient.executeOperation with native @bunest/graphql and zero-socket request(app). Both modules define separate classes named UserResolver.",
  },
  () => {
    let app: BunestApplication;

    afterEach(async () => {
      if (app) {
        await app.close();
      }
    });

    describe("code-first", () => {
      beforeEach(async () => {
        const moduleRef = await Test.createTestingModule({
          imports: [CodeFirstModule],
        }).compile({ logger: false });

        app = moduleRef.createNestApplication({ logger: false });
        await app.init();
      });

      it("should return results from both resolvers", async () => {
        const res = await request(app)
          .post("/graphql")
          .send({
            query: `
              mutation {
                moduleALogin(code: "hello")
                moduleBLogin(username: "bye")
              }
            `,
          })
          .expect(200);

        expect(res.body.errors).toBeUndefined();
        expect(res.body.data).toEqual({
          moduleALogin: "hello",
          moduleBLogin: "bye",
        });
      });
    });

    describe("schema-first", () => {
      beforeEach(async () => {
        const moduleRef = await Test.createTestingModule({
          imports: [SchemaFirstModule],
        }).compile({ logger: false });

        app = moduleRef.createNestApplication({ logger: false });
        await app.init();
      });

      it("should return results from both resolvers", async () => {
        const res = await request(app)
          .post("/graphql")
          .send({
            query: `
              mutation {
                moduleALogin(code: "hello")
                moduleBLogin(username: "bye")
              }
            `,
          })
          .expect(200);

        expect(res.body.errors).toBeUndefined();
        expect(res.body.data).toEqual({
          moduleALogin: "hello",
          moduleBLogin: "bye",
        });
      });
    });
  },
);
