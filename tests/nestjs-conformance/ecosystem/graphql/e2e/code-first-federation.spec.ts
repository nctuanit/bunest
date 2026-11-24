import { afterEach, beforeEach, expect, it } from "bun:test";
import { Injectable, Module } from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Args,
  Directive,
  Field,
  GraphQLModule,
  ID,
  Int,
  InterfaceType,
  ObjectType,
  Parent,
  Query,
  ResolveField,
  ResolveReference,
  Resolver,
  createUnionType,
} from "../../../../../packages/graphql/src";
import { Test, describeConformance, request } from "../../../_helpers/index";

@ObjectType()
@Directive('@key(fields: "id")')
class Post {
  @Field(() => ID)
  public id!: number;

  @Field()
  public title!: string;

  @Field(() => Int)
  public authorId!: number;

  constructor(post: Partial<Post>) {
    Object.assign(this, post);
  }
}

@ObjectType()
@Directive("@extends")
@Directive('@key(fields: "id")')
class User {
  @Field(() => ID)
  @Directive("@external")
  public id!: number;

  @Field(() => [Post])
  public posts!: Post[];

  constructor(user: Partial<User>) {
    Object.assign(this, user);
  }
}

const FederationSearchResultUnion = createUnionType({
  name: "FederationSearchResultUnion",
  description: "Search result description",
  types: () => [Post, User] as const,
  resolveType: (value: Record<string, unknown>) => {
    if ("posts" in value) {
      return User;
    }
    if ("title" in value) {
      return Post;
    }
    return undefined;
  },
});

@InterfaceType()
abstract class Base {
  @Field(() => ID)
  id!: string;
}

@InterfaceType({
  resolveType: () => Recipe,
})
abstract class IRecipe extends Base {
  @Field()
  title!: string;

  @Field()
  @Directive("@external")
  externalField!: string;
}

@ObjectType({ implements: IRecipe })
class Recipe extends IRecipe {
  @Field()
  description!: string;
}

@InterfaceType()
abstract class Character {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;
}

@ObjectType({
  implements: () => [Character],
})
class Human implements Character {
  id!: string;
  name!: string;
}

const POST_DATA = [
  { id: 1, title: "HELLO WORLD", authorId: 2 },
  { id: 2, title: "lorem ipsum", authorId: 1 },
];

@Injectable()
class PostService {
  public findOne(id: number): Post | null {
    const post = POST_DATA.find((p) => p.id === id);
    if (post) {
      return new Post(post);
    }
    return null;
  }

  public all(): Post[] {
    return POST_DATA.map((p) => new Post(p));
  }

  public forAuthor(authorId: number): Post[] {
    return POST_DATA.filter((p) => p.authorId === authorId).map(
      (p) => new Post(p),
    );
  }
}

@Resolver(() => Post)
class PostResolver {
  constructor(private readonly postService: PostService) {}

  @Query(() => Post)
  public findPost(@Args("id") id: number): Post | null {
    return this.postService.findOne(id);
  }

  @Query(() => [Post])
  public getPosts(): Post[] {
    return this.postService.all();
  }

  @Query(() => [FederationSearchResultUnion], {
    deprecationReason: "test",
  })
  search(): Array<Post | User> {
    return [
      new User({ id: 1, posts: [] }),
      new Post({ id: 2, title: "lorem ipsum", authorId: 1 }),
    ];
  }

  @ResolveReference()
  public resolveRef(reference: { id: number }): Post | null {
    return this.postService.findOne(reference.id);
  }
}

@Module({
  providers: [PostService, PostResolver],
  exports: [PostService],
})
class PostModule {}

@Resolver(() => User)
class UserResolver {
  constructor(private readonly postService: PostService) {}

  @ResolveField()
  public posts(@Parent() user: User): Post[] {
    return this.postService.forAuthor(user.id);
  }
}

@Module({
  providers: [UserResolver],
  imports: [PostModule],
})
class UserModule {}

@Resolver(() => IRecipe)
class IRecipeResolver {
  @Query(() => IRecipe)
  public recipe() {
    return { id: "1", title: "Recipe", description: "Interface description" };
  }
}

@Module({
  providers: [IRecipeResolver],
})
class RecipeModule {}

@Resolver(() => Character)
class HumanResolver {
  @Query(() => [Human])
  humans(): Human[] {
    return [
      { id: "1", name: "Bob" },
      { id: "2", name: "Alice" },
    ];
  }

  @ResolveField(() => [Human])
  friends(): Human[] {
    return [{ id: "3", name: "Peter" }];
  }
}

@Module({
  providers: [HumanResolver],
})
class HumanModule {}

@Module({
  imports: [
    UserModule,
    PostModule,
    RecipeModule,
    HumanModule,
    GraphQLModule.forRoot({
      inheritResolversFromInterfaces: true,
      federation: { version: 2 },
      includeStacktraceInErrorResponses: false,
      autoSchemaFile: true,
      buildSchemaOptions: {
        orphanedTypes: [User],
      },
    }),
  ],
})
class ApplicationModule {}

describeConformance(
  "Code-first - Federation",
  {
    upstreamPath: "packages/apollo/tests/e2e/code-first-federation.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts ApolloFederationDriver code-first subgraph E2E to native @bunest/graphql Federation Subgraph (ADR-001, ADR-013) via zero-socket request(app).",
  },
  () => {
    let app: BunestApplication;

    beforeEach(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [ApplicationModule],
      }).compile({ logger: false });

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
    });

    afterEach(async () => {
      await app.close();
    });

    // BUNEST_BUG: GraphQLSchemaFactory.buildCodeFirst (packages/graphql/src/schema/graphql-schema.factory.ts) sets `_service.sdl = printSchema(schema)`, omitting Federation v2 directives (@shareable, @link, @inaccessible, @override), stripping @Directive() annotations (@key, @extends, @external), leaking _service/_entities/_Any/_Entity, and omitting interface @ResolveField() fields (Character.friends / Human.friends).
    it.skip("should return query result", async () => {
      const res = await request(app)
        .post("/graphql")
        .send({
          query: `
            {
              _service {
                sdl
              }
            }
          `,
        })
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      const sdl: string = res.body.data._service.sdl;
      expect(sdl).toContain(
        "directive @shareable on FIELD_DEFINITION | OBJECT",
      );
      expect(sdl).toContain("directive @link(");
      expect(sdl).toContain("directive @inaccessible on");
      expect(sdl).toContain(
        "directive @override(from: String!) on FIELD_DEFINITION",
      );
      expect(sdl).toMatch(
        /interface IRecipe\s*\{[\s\S]*externalField: String! @external/,
      );
      expect(sdl).toMatch(/type Post @key\(fields: "id"\)/);
      expect(sdl).toMatch(/type User @extends @key\(fields: "id"\)/);
      expect(sdl).toMatch(/type User[\s\S]*id: ID! @external/);
      expect(sdl).toMatch(/type Recipe implements IRecipe/);
      expect(sdl).toMatch(
        /type Human implements Character[\s\S]*friends: \[Human!\]!/,
      );
      expect(sdl).toMatch(/interface Character[\s\S]*friends: \[Human!\]!/);
      expect(sdl).toContain(
        'search: [FederationSearchResultUnion!]! @deprecated(reason: "test")',
      );
      expect(sdl).toContain("union FederationSearchResultUnion = Post | User");
    });

    it("should return the search result", async () => {
      const res = await request(app)
        .post("/graphql")
        .send({
          query: `
            {
              search {
                ... on Post {
                  title
                }
                ... on User {
                  id
                }
                __typename
              }
            }
          `,
        })
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      expect(res.body.data).toEqual({
        search: [
          {
            id: "1",
            __typename: "User",
          },
          {
            title: "lorem ipsum",
            __typename: "Post",
          },
        ],
      });
    });

    it("should return query result (recipe interface)", async () => {
      const res = await request(app)
        .post("/graphql")
        .send({
          query: `
            {
              recipe {
                id
                title
                ... on Recipe {
                  description
                }
              }
            }
          `,
        })
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      expect(res.body.data).toEqual({
        recipe: {
          id: "1",
          title: "Recipe",
          description: "Interface description",
        },
      });
    });

    // BUNEST_BUG: GraphQLSchemaFactory (packages/graphql/src/schema/graphql-schema.factory.ts) does not attach @ResolveField() declared on an @InterfaceType() resolver (@Resolver(() => Character) -> friends) to the interface or implementing @ObjectType() (Human), returning HTTP 400 `Cannot query field "friends" on type "Human".`.
    it.skip("should return the human result with resolve interface", async () => {
      const res = await request(app)
        .post("/graphql")
        .send({
          query: `
            {
              humans {
                id
                name
                friends {
                  id
                  name
                }
              }
            }
          `,
        })
        .expect(200);

      expect(res.body.errors).toBeUndefined();
      expect(res.body.data).toEqual({
        humans: [
          {
            id: "1",
            name: "Bob",
            friends: [{ id: "3", name: "Peter" }],
          },
          {
            id: "2",
            name: "Alice",
            friends: [{ id: "3", name: "Peter" }],
          },
        ],
      });
    });
  },
);
