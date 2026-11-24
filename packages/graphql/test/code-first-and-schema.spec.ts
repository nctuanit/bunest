import { describe, expect, test } from "bun:test";
import {
  type BunestInterceptor,
  type CallHandler,
  type CanActivate,
  type ExecutionContext,
  Injectable,
  Module,
  ParseIntPipe,
  UseGuards,
  UseInterceptors,
} from "@bunest/core";
import { BunestFactory, ValidationPipe } from "@bunest/core";
import {
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  MinLength,
} from "../../validation/src/validator";
import {
  Args,
  ArgsType,
  Context,
  Field,
  Float,
  GqlExecutionContext,
  GraphQLModule,
  GraphQLService,
  ID,
  Info,
  InputType,
  Int,
  Mutation,
  ObjectType,
  Parent,
  Query,
  registerEnumType,
  ResolveField,
  Resolver,
} from "../src/index";

enum UserRole {
  ADMIN = "ADMIN",
  MEMBER = "MEMBER",
}

registerEnumType(UserRole, { name: "UserRole" });

@ObjectType()
class BaseNode {
  @Field(() => ID)
  id!: string;
}

@ObjectType({ description: "Blog post model" })
class PostModel extends BaseNode {
  @Field()
  title!: string;

  @Field(() => UserModel, { nullable: true })
  author?: unknown;
}

@ObjectType({ description: "User account model" })
class UserModel extends BaseNode {
  @Field()
  name!: string;

  @Field()
  email!: string;

  @Field(() => Int)
  age!: number;

  @Field(() => Float)
  score!: number;

  @Field(() => UserRole)
  role!: UserRole;

  @Field(() => [PostModel])
  posts?: PostModel[];

  @Field(() => [String], { nullable: "itemsAndList" })
  tags?: Array<string | null> | null;
}

@InputType()
class CreateUserInput {
  @Field()
  @IsString()
  @MinLength(2)
  name!: string;

  @Field()
  @IsEmail()
  email!: string;

  @Field(() => Int, { nullable: true, defaultValue: 20 })
  @IsOptional()
  @IsInt()
  age?: number;
}

@ArgsType()
class PaginationArgs {
  @Field(() => Int, { nullable: true, defaultValue: 10 })
  limit?: number;

  @Field(() => Int, { nullable: true, defaultValue: 0 })
  offset?: number;
}

describe("Code-First & Schema-First GraphQL Execution", () => {
  test("compiles code-first schema with circular types, DI, @ResolveField, @ArgsType, pipes/ValidationPipe, Guards (GqlExecutionContext), and Interceptors", async () => {
    @Injectable()
    class UsersStore {
      private readonly users: Array<
        Omit<UserModel, "posts"> & { postIds: string[] }
      > = [
        {
          id: "1",
          name: "Ada",
          email: "ada@bun.sh",
          age: 36,
          score: 99.5,
          role: UserRole.ADMIN,
          tags: ["math", null],
          postIds: ["p1"],
        },
      ];

      private readonly posts = [
        { id: "p1", title: "Analytical Engine", authorId: "1" },
      ];

      findAll(limit: number, offset: number) {
        return this.users.slice(offset, offset + limit);
      }

      findById(id: string) {
        return this.users.find((u) => u.id === id) ?? null;
      }

      findPostsForUser(userId: string) {
        return this.posts.filter((p) => p.authorId === userId);
      }

      create(input: CreateUserInput) {
        const next = {
          id: String(this.users.length + 1),
          name: input.name,
          email: input.email,
          age: input.age ?? 20,
          score: 10.0,
          role: UserRole.MEMBER,
          tags: null,
          postIds: [],
        };
        this.users.push(next);
        return next;
      }
    }

    class AdminGqlGuard implements CanActivate {
      canActivate(ctx: ExecutionContext): boolean {
        expect(ctx.getType<string>()).toBe("graphql");
        const gqlCtx = GqlExecutionContext.create(ctx);
        expect(gqlCtx.getInfo().fieldName).toBe("secretMetric");
        return gqlCtx.getContext<{ role?: string }>().role === "admin";
      }
    }

    class MultiplyInterceptor implements BunestInterceptor {
      async intercept(_ctx: ExecutionContext, next: CallHandler<number>) {
        const result = await next.handle();
        return result * 10;
      }
    }

    @Resolver(() => UserModel)
    class UsersResolver {
      constructor(private readonly store: UsersStore) {}

      @Query(() => [UserModel])
      users(@Args() pagination: PaginationArgs) {
        return this.store.findAll(
          pagination.limit ?? 10,
          pagination.offset ?? 0,
        );
      }

      @Query(() => UserModel, { nullable: true })
      user(
        @Args("id", { type: () => ID }) id: string,
        @Info() info: { fieldName: string },
      ) {
        expect(info.fieldName).toBe("user");
        return this.store.findById(id);
      }

      @Query(() => Int)
      doubleNumber(@Args("n", { type: () => Int }, ParseIntPipe) n: number) {
        return n * 2;
      }

      @UseGuards(AdminGqlGuard)
      @UseInterceptors(MultiplyInterceptor)
      @Query(() => Int)
      secretMetric(@Context("seed") seed?: number) {
        return seed ?? 7;
      }

      @Mutation(() => UserModel)
      createUser(
        @Args("input", { type: () => CreateUserInput }, new ValidationPipe())
        input: CreateUserInput,
      ) {
        return this.store.create(input);
      }

      @ResolveField(() => [PostModel])
      posts(@Parent() user: UserModel) {
        return this.store.findPostsForUser(user.id);
      }
    }

    @Resolver(() => PostModel)
    class PostsResolver {
      constructor(private readonly store: UsersStore) {}

      @ResolveField(() => UserModel, { nullable: true })
      author(@Parent() post: { authorId: string }) {
        return this.store.findById(post.authorId);
      }
    }

    @Module({
      imports: [
        GraphQLModule.forRoot({
          context: ({ req }) => ({
            role: req.headers.get("x-role") ?? "guest",
            seed: Number(req.headers.get("x-seed") ?? "7"),
          }),
        }),
      ],
      providers: [UsersStore, UsersResolver, PostsResolver],
    })
    class AppModule {}

    const app = await BunestFactory.create(AppModule, { logger: false });
    try {
      await app.init();
      const gql = app.get(GraphQLService);
      const sdl = gql.printSDL();

      // Verify inheritance + circular schema types + enum + input type generated
      expect(sdl).toContain("type UserModel");
      expect(sdl).toContain("type PostModel");
      expect(sdl).toContain("input CreateUserInput");
      expect(sdl).toContain("enum UserRole");

      // Query with nested circular @ResolveField (User -> posts -> author -> name)
      const qRes = await app.fetch(
        new Request("http://localhost/graphql", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            query: `
              query ($limit: Int) {
                users(limit: $limit) {
                  id name age score role tags
                  posts { id title author { id name } }
                }
              }
            `,
            variables: { limit: 5 },
          }),
        }),
      );
      expect(qRes.status).toBe(200);
      expect(await qRes.json()).toEqual({
        data: {
          users: [
            {
              id: "1",
              name: "Ada",
              age: 36,
              score: 99.5,
              role: "ADMIN",
              tags: ["math", null],
              posts: [
                {
                  id: "p1",
                  title: "Analytical Engine",
                  author: { id: "1", name: "Ada" },
                },
              ],
            },
          ],
        },
      });

      // Valid mutation with ValidationPipe
      const mOk = await app.fetch(
        new Request("http://localhost/graphql", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            query: `
              mutation ($input: CreateUserInput!) {
                createUser(input: $input) { id name email age role }
              }
            `,
            variables: {
              input: { name: "Grace", email: "grace@bun.sh", age: 40 },
            },
          }),
        }),
      );
      expect(await mOk.json()).toEqual({
        data: {
          createUser: {
            id: "2",
            name: "Grace",
            email: "grace@bun.sh",
            age: 40,
            role: "MEMBER",
          },
        },
      });

      // Invalid mutation rejected by ValidationPipe -> formatted GraphQL error with statusCode 400
      const mBad = await app.fetch(
        new Request("http://localhost/graphql", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            query: `
              mutation {
                createUser(input: { name: "A", email: "not-an-email" }) { id }
              }
            `,
          }),
        }),
      );
      const badJson = (await mBad.json()) as {
        errors?: Array<{
          extensions?: {
            code?: string;
            originalError?: { statusCode?: number };
            details?: unknown[];
          };
        }>;
      };
      expect(badJson.errors?.length).toBe(1);
      expect(badJson.errors?.[0]?.extensions?.originalError?.statusCode).toBe(
        400,
      );
      expect(
        badJson.errors?.[0]?.extensions?.details?.length,
      ).toBeGreaterThanOrEqual(2);

      // Guard (GqlExecutionContext) denies guest & allows admin (Interceptor multiplies result by 10)
      const denied = await app.fetch(
        new Request("http://localhost/graphql", {
          method: "POST",
          headers: { "content-type": "application/json", "x-role": "guest" },
          body: JSON.stringify({ query: "{ secretMetric }" }),
        }),
      );
      const deniedJson = (await denied.json()) as {
        errors?: Array<{
          extensions?: {
            originalError?: { statusCode?: number };
            code?: string;
          };
        }>;
      };
      expect(deniedJson.errors?.[0]?.extensions?.originalError?.statusCode).toBe(
        403,
      );

      const allowed = await app.fetch(
        new Request("http://localhost/graphql", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-role": "admin",
            "x-seed": "9",
          },
          body: JSON.stringify({ query: "{ secretMetric }" }),
        }),
      );
      expect(await allowed.json()).toEqual({ data: { secretMetric: 90 } });
    } finally {
      await app.close();
    }
  });

  test("supports schema-first SDL with plain resolvers, DI @Resolver bindings, and forRootAsync()", async () => {
    @Injectable()
    class GreeterService {
      greet(name: string) {
        return `Hello, ${name}!`;
      }
    }

    @Resolver("Book")
    class SdlResolver {
      constructor(private readonly greeter: GreeterService) {}

      @Query(() => String, { name: "hello" })
      hello(@Args("name") name: string) {
        return this.greeter.greet(name);
      }

      @ResolveField("summary")
      summary(@Parent() book: { title: string; author: string }) {
        return `${book.title} by ${book.author}`;
      }
    }

    const typeDefs = `
      type Book {
        title: String!
        author: String!
        summary: String!
      }
      type Query {
        hello(name: String!): String!
        book: Book!
      }
    `;

    @Module({
      imports: [
        GraphQLModule.forRootAsync({
          path: "/gql",
          useFactory: async () => ({
            path: "/gql",
            typeDefs,
            resolvers: {
              Query: {
                book: () => ({ title: "Bunest", author: "Bun Team" }),
              },
            },
          }),
        }),
      ],
      providers: [GreeterService, SdlResolver],
    })
    class SchemaFirstModule {}

    const app = await BunestFactory.create(SchemaFirstModule, {
      logger: false,
    });
    try {
      const res = await app.fetch(
        new Request("http://localhost/gql", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            query: `{ hello(name: "Bun") book { title summary } }`,
          }),
        }),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        data: {
          hello: "Hello, Bun!",
          book: { title: "Bunest", summary: "Bunest by Bun Team" },
        },
      });
    } finally {
      await app.close();
    }
  });
});
