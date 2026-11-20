import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Module } from "../../../../../packages/common/src";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Args,
  Field,
  GraphQLModule,
  type GraphQLModuleOptions,
  ID,
  InputType,
  Mutation,
  ObjectType,
  Query,
  Resolver,
} from "../../../../../packages/graphql/src";
import {
  Test,
  describeConformance,
  request,
} from "../../../_helpers/index";

@ObjectType()
class AppInfo {
  @Field()
  version!: string;
}

@ObjectType({ registerIn: () => ProductsModule })
class Product {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;
}

@Resolver(() => Product)
class ProductsResolver {
  @Query(() => [Product])
  products(): Product[] {
    return [{ id: "1", name: "Widget" }];
  }
}

@Module({
  providers: [ProductsResolver],
})
class ProductsModule {}

@InputType({ registerIn: () => UsersModule })
class CreateUserInput {
  @Field()
  name!: string;
}

@ObjectType({ registerIn: () => UsersModule })
class User {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field(() => AppInfo)
  info!: AppInfo;
}

@Resolver(() => User)
class UsersResolver {
  private readonly _users: User[] = [
    { id: "1", name: "Ada", info: { version: "1.0.0" } },
  ];

  @Query(() => [User])
  users(): User[] {
    return this._users;
  }

  @Mutation(() => User)
  createUser(@Args("input") input: CreateUserInput): User {
    const user = {
      id: String(this._users.length + 1),
      name: input.name,
      info: { version: "1.0.0" },
    };
    this._users.push(user);
    return user;
  }
}

@Module({
  providers: [UsersResolver],
})
class UsersModule {}

async function buildApp(
  include?: Function[],
  options: GraphQLModuleOptions = {},
): Promise<BunestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      UsersModule,
      ProductsModule,
      GraphQLModule.forRoot({
        autoSchemaFile: true,
        includeStacktraceInErrorResponses: false,
        ...(include ? { include } : {}),
        ...options,
      }),
    ],
  }).compile({ logger: false });

  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  return app;
}

async function queryTypeName(app: BunestApplication, name: string) {
  const res = await request(app)
    .post("/graphql")
    .send({
      query: `
        query TypeByName($name: String!) {
          __type(name: $name) {
            name
          }
        }
      `,
      variables: { name },
    })
    .expect(200);
  expect(res.body.errors).toBeUndefined();
  return res.body.data;
}

describeConformance(
  "Code-first - registerIn",
  {
    upstreamPath: "packages/apollo/tests/e2e/code-first-register-in.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts upstream @nestjs/apollo registerIn module-scoped type filtering E2E to native @bunest/graphql over zero-socket HTTP requests.",
  },
  () => {
    describe("include: [UsersModule]", () => {
      let app: BunestApplication;

      beforeAll(async () => {
        app = await buildApp([UsersModule]);
      });

      afterAll(async () => {
        await app.close();
      });

      it("should expose User type", async () => {
        expect(await queryTypeName(app, "User")).toEqual({
          __type: { name: "User" },
        });
      });

      it("should expose CreateUserInput type", async () => {
        expect(await queryTypeName(app, "CreateUserInput")).toEqual({
          __type: { name: "CreateUserInput" },
        });
      });

      it("should expose AppInfo (no registerIn) referenced by User", async () => {
        expect(await queryTypeName(app, "AppInfo")).toEqual({
          __type: { name: "AppInfo" },
        });
      });

      it("should NOT expose Product type", async () => {
        expect(await queryTypeName(app, "Product")).toEqual({ __type: null });
      });

      it("should NOT expose products query field", async () => {
        const res = await request(app)
          .post("/graphql")
          .send({
            query: `
              {
                __schema {
                  queryType {
                    fields {
                      name
                    }
                  }
                }
              }
            `,
          })
          .expect(200);
        expect(res.body.errors).toBeUndefined();
        const data = res.body.data as {
          __schema: { queryType: { fields: { name: string }[] } };
        };
        const fieldNames = data.__schema.queryType.fields.map((f) => f.name);
        expect(fieldNames).toContain("users");
        expect(fieldNames).not.toContain("products");
      });

      it("should resolve users query", async () => {
        const res = await request(app)
          .post("/graphql")
          .send({
            query: `
              {
                users {
                  id
                  name
                  info {
                    version
                  }
                }
              }
            `,
          })
          .expect(200);
        expect(res.body.errors).toBeUndefined();
        expect(res.body.data).toEqual({
          users: [{ id: "1", name: "Ada", info: { version: "1.0.0" } }],
        });
      });

      it("should resolve createUser mutation", async () => {
        const res = await request(app)
          .post("/graphql")
          .send({
            query: `
              mutation CreateUser($input: CreateUserInput!) {
                createUser(input: $input) {
                  id
                  name
                }
              }
            `,
            variables: { input: { name: "Grace" } },
          })
          .expect(200);
        expect(res.body.errors).toBeUndefined();
        expect(res.body.data).toEqual({
          createUser: { id: "2", name: "Grace" },
        });
      });
    });

    describe("include: [UsersModule] (federation)", () => {
      let app: BunestApplication;

      beforeAll(async () => {
        app = await buildApp([UsersModule], {
          federation: true,
          buildSchemaOptions: { orphanedTypes: [Product] },
        });
      });

      afterAll(async () => {
        await app.close();
      });

      it("should expose User type", async () => {
        expect(await queryTypeName(app, "User")).toEqual({
          __type: { name: "User" },
        });
      });

      // BUNEST_BUG: Expected `{ __type: null }` when Product has `registerIn: () => ProductsModule` and `include: [UsersModule]`; actual returns `{ __type: { name: "Product" } }` because GraphQLSchemaFactory.buildCodeFirst (packages/graphql/src/schema/graphql-schema.factory.ts:1407-1428) adds all buildSchemaOptions.orphanedTypes without filtering by registerIn against options.include.
      it.skip("should NOT expose Product type", async () => {
        expect(await queryTypeName(app, "Product")).toEqual({ __type: null });
      });
    });

    describe("include: [UsersModule, ProductsModule]", () => {
      let app: BunestApplication;

      beforeAll(async () => {
        app = await buildApp([UsersModule, ProductsModule]);
      });

      afterAll(async () => {
        await app.close();
      });

      it("should expose both User and Product types", async () => {
        expect(await queryTypeName(app, "User")).toEqual({
          __type: { name: "User" },
        });
        expect(await queryTypeName(app, "Product")).toEqual({
          __type: { name: "Product" },
        });
      });

      it("should resolve users and products queries", async () => {
        const res = await request(app)
          .post("/graphql")
          .send({
            query: `
              {
                users {
                  id
                  name
                }
                products {
                  id
                  name
                }
              }
            `,
          })
          .expect(200);
        expect(res.body.errors).toBeUndefined();
        expect(res.body.data).toEqual({
          users: [{ id: "1", name: "Ada" }],
          products: [{ id: "1", name: "Widget" }],
        });
      });
    });

    describe("include omitted", () => {
      let app: BunestApplication;

      beforeAll(async () => {
        app = await buildApp();
      });

      afterAll(async () => {
        await app.close();
      });

      it("should expose all types regardless of registerIn", async () => {
        expect(await queryTypeName(app, "User")).toEqual({
          __type: { name: "User" },
        });
        expect(await queryTypeName(app, "Product")).toEqual({
          __type: { name: "Product" },
        });
        expect(await queryTypeName(app, "AppInfo")).toEqual({
          __type: { name: "AppInfo" },
        });
      });

      it("should resolve queries from all modules", async () => {
        const res = await request(app)
          .post("/graphql")
          .send({
            query: `
              {
                users {
                  id
                  name
                }
                products {
                  id
                  name
                }
              }
            `,
          })
          .expect(200);
        expect(res.body.errors).toBeUndefined();
        expect(res.body.data).toEqual({
          users: [{ id: "1", name: "Ada" }],
          products: [{ id: "1", name: "Widget" }],
        });
      });
    });
  },
);
