import { afterEach, beforeEach, expect, it, mock } from "bun:test";
import { Injectable, Module } from "../../../../../packages/core/src/common";
import {
  join,
  removePath,
  type BunestApplication,
} from "../../../../../packages/core/src";
import {
  Args,
  Directive,
  Field,
  FileSystemHelper,
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
import { Test, describeConformance } from "../../../_helpers/index";

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
    if ("posts" in value) return User;
    if ("title" in value) return Post;
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

@ObjectType({ implements: () => [Character] })
class Human implements Character {
  id!: string;
  name!: string;
}

@Injectable()
class PostService {
  private readonly data = [
    { id: 1, title: "HELLO WORLD", authorId: 2 },
    { id: 2, title: "lorem ipsum", authorId: 1 },
  ];

  public findOne(id: number): Post | null {
    const post = this.data.find((p) => p.id === id);
    return post ? new Post(post) : null;
  }

  public all(): Post[] {
    return this.data.map((p) => new Post(p));
  }

  public forAuthor(authorId: number): Post[] {
    return this.data
      .filter((p) => p.authorId === authorId)
      .map((p) => new Post(p));
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

  @Query(() => [FederationSearchResultUnion], { deprecationReason: "test" })
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

@Resolver(() => User)
class UserResolver {
  constructor(private readonly postService: PostService) {}

  @ResolveField()
  public posts(@Parent() user: User): Post[] {
    return this.postService.forAuthor(user.id);
  }
}

@Resolver(() => IRecipe)
class IRecipeResolver {
  @Query(() => IRecipe)
  public recipe() {
    return { id: "1", title: "Recipe", description: "Interface description" };
  }
}

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

describeConformance(
  "Federation - autoSchemaFile generation (issue #3722)",
  {
    upstreamPath:
      "packages/apollo/tests/e2e/federation-auto-schema-file.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts ApolloFederationDriver autoSchemaFile generation test to native @bunest/graphql (ADR-001, ADR-013) using an isolated temp schema path cleaned up in afterEach.",
  },
  () => {
    let app: BunestApplication;
    let schemaPath: string;
    const writeFileMock = mock((_path: string, _content: string) =>
      Promise.resolve(),
    );

    beforeEach(async () => {
      writeFileMock.mockClear();
      schemaPath = join(
        Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp",
        `bunest-fed-auto-schema-${crypto.randomUUID()}.graphql`,
      );

      @Module({
        imports: [
          GraphQLModule.forRoot({
            inheritResolversFromInterfaces: true,
            federation: true,
            includeStacktraceInErrorResponses: false,
            autoSchemaFile: schemaPath,
            buildSchemaOptions: {
              orphanedTypes: [User],
            },
          }),
        ],
        providers: [
          PostService,
          PostResolver,
          UserResolver,
          IRecipeResolver,
          HumanResolver,
        ],
      })
      class FederationAutoSchemaFileModule {}

      const moduleRef = await Test.createTestingModule({
        imports: [FederationAutoSchemaFileModule],
      })
        .overrideProvider(FileSystemHelper)
        .useValue({ writeFile: writeFileMock })
        .compile({ logger: false });

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
    });

    afterEach(async () => {
      await app.close();
      await removePath(schemaPath, { force: true });
    });

    it("should write the federated SDL file once with the configured filename", () => {
      expect(writeFileMock).toHaveBeenCalledTimes(1);
      expect(writeFileMock.mock.calls[0]?.[0]).toBe(schemaPath);
    });

    it("should preserve federation directives (@key, @external, @extends) in the generated SDL", () => {
      const fileContent = writeFileMock.mock.calls[0]?.[1] ?? "";

      // Object types decorated with @Directive('@key(...)') must keep the directive
      // when emitted via autoSchemaFile.
      expect(fileContent).toMatch(/type\s+Post[^{]*@key\(fields:\s*"id"\)/);
      expect(fileContent).toMatch(/type\s+User[^{]*@key\(fields:\s*"id"\)/);
      expect(fileContent).toMatch(/type\s+User[^{]*@extends/);
      expect(fileContent).toMatch(/@external/);
    });
  },
);
