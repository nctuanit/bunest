import "reflect-metadata";
import { afterAll, beforeAll, expect, it } from "bun:test";
import {
  type CanActivate,
  ForbiddenException,
  Injectable,
  Module,
  UseGuards,
} from "../../../../../packages/common/src";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Field,
  type FieldMiddleware,
  GraphQLModule,
  ObjectType,
  Parent,
  Query,
  ResolveField,
  Resolver,
} from "../../../../../packages/graphql/src";
import { Test, describeConformance, request } from "../../../_helpers/index";

const wrap =
  (name: string): FieldMiddleware =>
  async (_ctx, next) =>
    `${name}(${await next()})`;

@ObjectType()
class User {
  @Field()
  id!: string;

  // Also resolved by "UsersResolver.nickname()".
  @Field({ middleware: [wrap("model")] })
  nickname!: string;
}

@ObjectType()
class Author extends User {
  @Field()
  bio!: string;
}

@ObjectType()
class StarAuthor extends Author {
  @Field()
  stars!: number;
}

@ObjectType()
class Editor extends User {
  @Field()
  desk!: string;
}

const ada = {
  id: "1",
  nickname: "ada",
  bio: "writes books",
  stars: 3,
  desk: "A1",
  email: "ada@example.com",
  ssn: "000-00-0000",
  phone: "555-0100",
};

@Injectable()
class DenyGuard implements CanActivate {
  canActivate(): boolean {
    throw new ForbiddenException("Forbidden resource");
  }
}

@Resolver(() => User)
class UsersResolver {
  @Query(() => User)
  user(): User {
    return ada;
  }

  @Query(() => Author)
  author(): Author {
    return ada;
  }

  @Query(() => StarAuthor)
  starAuthor(): StarAuthor {
    return ada;
  }

  @Query(() => Editor)
  editor(): Editor {
    return ada;
  }

  @ResolveField(() => String)
  email(@Parent() user: typeof ada): string {
    return `user:${user.email}`;
  }

  @ResolveField(() => String, {
    middleware: [
      () => {
        throw new ForbiddenException("Forbidden resource");
      },
    ],
  })
  ssn(): string {
    return ada.ssn;
  }

  @ResolveField(() => String)
  @UseGuards(DenyGuard)
  phone(): string {
    return ada.phone;
  }

  @ResolveField()
  nickname(@Parent() user: typeof ada): string {
    return `resolver:${user.nickname}`;
  }
}

@Resolver(() => Author)
class AuthorsResolver {
  @ResolveField(() => String)
  email(@Parent() author: typeof ada): string {
    return `author:${author.email}`;
  }
}

@Module({
  imports: [
    GraphQLModule.forRoot({
      federation: { version: 2 },
      autoSchemaFile: true,
      fieldResolverEnhancers: ["guards"],
      includeStacktraceInErrorResponses: false,
    }),
  ],
  providers: [UsersResolver, AuthorsResolver, DenyGuard],
})
class TypeInheritanceFederationModule {}

describeConformance(
  "Federation - code-first object types that use inheritance",
  {
    upstreamPath:
      "packages/apollo/tests/e2e/federation-type-inheritance.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts ApolloFederationDriver object type inheritance E2E to native @bunest/graphql Federation Subgraph (ADR-001, ADR-013) via zero-socket request(app).",
  },
  () => {
    let app: BunestApplication;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [TypeInheritanceFederationModule],
      }).compile({ logger: false });
      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
    });

    afterAll(async () => {
      await app.close();
    });

    async function expectForbidden(query: string) {
      const res = await request(app).post("/graphql").send({ query });
      const { data, errors } = res.body as {
        data?: Record<string, unknown> | null;
        errors?: Array<{ message: string }>;
      };
      expect(data).toBeNull();
      expect(errors?.map((error) => error.message)).toEqual([
        "Forbidden resource",
      ]);
    }

    // BUNEST_BUG: GraphQLSchemaFactory.getOrCreateObjectType (packages/graphql/src/schema/graphql-schema.factory.ts) looks up `resolveFieldRegistry.get(typeName)` directly without walking ancestor @ObjectType() classes (Author -> User, StarAuthor -> Author -> User, Editor -> User), failing with `Cannot query field "email" on type "StarAuthor".` / `"Editor".`.
    it.skip("should bind the field resolvers of the parent type to its subtypes (nearest ancestor wins)", async () => {
      const res = await request(app)
        .post("/graphql")
        .send({
          query: `{
            user { email }
            author { email }
            starAuthor { email }
            editor { email }
          }`,
        })
        .expect(200);
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data).toEqual({
        user: { email: "user:ada@example.com" },
        author: { email: "author:ada@example.com" },
        starAuthor: { email: "author:ada@example.com" },
        editor: { email: "user:ada@example.com" },
      });
    });

    it("should apply the field middleware of the inherited field resolver (user)", () =>
      expectForbidden("{ user { ssn } }"));

    for (const query of ["author", "starAuthor", "editor"] as const) {
      // BUNEST_BUG: GraphQLSchemaFactory.getOrCreateObjectType (packages/graphql/src/schema/graphql-schema.factory.ts) does not inherit @ResolveField() `ssn` (or its field middleware) from parent @ObjectType() `User` onto subtypes `Author`, `StarAuthor`, `Editor` (`data` is undefined / validation error).
      it.skip(`should apply the field middleware of the inherited field resolver (${query})`, () =>
        expectForbidden(`{ ${query} { ssn } }`));
    }

    it("should apply the guards of the inherited field resolver (user)", () =>
      expectForbidden("{ user { phone } }"));

    for (const query of ["author", "starAuthor", "editor"] as const) {
      // BUNEST_BUG: GraphQLSchemaFactory.getOrCreateObjectType (packages/graphql/src/schema/graphql-schema.factory.ts) does not inherit @ResolveField() `phone` (or its @UseGuards(DenyGuard)) from parent @ObjectType() `User` onto subtypes `Author`, `StarAuthor`, `Editor` (`data` is undefined / validation error).
      it.skip(`should apply the guards of the inherited field resolver (${query})`, () =>
        expectForbidden(`{ ${query} { phone } }`));
    }

    // BUNEST_BUG: GraphQLSchemaFactory.getOrCreateObjectType (packages/graphql/src/schema/graphql-schema.factory.ts) drops model @Field({ middleware }) when overridden by @ResolveField() (`user.nickname` returned `"resolver:ada"` instead of `"model(resolver:ada)"`) and does not inherit `UsersResolver.nickname` onto subtypes (`author`/`starAuthor`/`editor` returned `"model(ada)"` instead of `"model(resolver:ada)"`).
    it.skip("should run the model field middleware once around the inherited field resolver", async () => {
      const res = await request(app)
        .post("/graphql")
        .send({
          query: `{
            user { nickname }
            author { nickname }
            starAuthor { nickname }
            editor { nickname }
          }`,
        })
        .expect(200);
      expect(res.body.errors).toBeUndefined();
      const nickname = { nickname: "model(resolver:ada)" };
      expect(res.body.data).toEqual({
        user: nickname,
        author: nickname,
        starAuthor: nickname,
        editor: nickname,
      });
    });
  },
);
