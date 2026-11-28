import { describe, expect, it } from "bun:test";
import { Injectable, Module, Scope } from "@bunest/core";
import { BunestFactory } from "@bunest/core";
import { Test } from "@bunest/testing";
import {
  Args,
  BunestDataLoader,
  Field,
  GraphQLModule,
  GraphQLService,
  ID,
  Loader,
  Mutation,
  ObjectType,
  Parent,
  Query,
  ResolveField,
  Resolver,
  resolveRequestScopedDataLoader,
  type BunestDataLoaderFactory,
} from "../src/index";

describe("GraphQL per-request @Loader() DataLoader DI", () => {
  @ObjectType()
  class Author {
    @Field(() => ID)
    id!: string;

    @Field()
    name!: string;
  }

  @ObjectType()
  class Post {
    @Field(() => ID)
    id!: string;

    @Field()
    title!: string;

    authorId!: string;

    @Field(() => Author)
    author!: Author;
  }

  it("batches N+1 field resolutions into 1 batchLoadFn call per request while keeping Resolver and LoaderFactory SINGLETON", async () => {
    let resolverConstructions = 0;
    let factoryConstructions = 0;
    const batchCalls: Array<readonly string[]> = [];

    @Injectable()
    class AuthorService {
      async findByIds(ids: readonly string[]): Promise<Author[]> {
        batchCalls.push([...ids]);
        return ids.map((id) => ({ id, name: `Author ${id}` }));
      }
    }

    @Injectable()
    class AuthorLoader implements BunestDataLoaderFactory<string, Author> {
      constructor(private readonly authors: AuthorService) {
        factoryConstructions += 1;
      }

      createDataLoader(): BunestDataLoader<string, Author> {
        return new BunestDataLoader((ids) => this.authors.findByIds(ids));
      }
    }

    @Resolver(() => Post)
    class PostsResolver {
      constructor() {
        resolverConstructions += 1;
      }

      @Query(() => [Post])
      posts(): Post[] {
        return [
          { id: "p1", title: "First", authorId: "u1", author: null as any },
          { id: "p2", title: "Second", authorId: "u2", author: null as any },
          { id: "p3", title: "Third", authorId: "u1", author: null as any },
        ];
      }

      @ResolveField(() => Author)
      author(
        @Parent() post: Post,
        @Loader(AuthorLoader) loader: BunestDataLoader<string, Author>,
      ): Promise<Author> {
        return loader.load(post.authorId);
      }
    }

    @Module({
      imports: [GraphQLModule.forRoot({ autoSchemaFile: true })],
      providers: [AuthorService, AuthorLoader, PostsResolver],
    })
    class AppModule {}

    const app = await BunestFactory.create(AppModule, { logger: false });
    await app.init();

    try {
      const query = `{ posts { id title author { id name } } }`;

      // Request 1: 3 posts referencing u1, u2, u1 -> batched into 1 call ["u1", "u2"]
      const res1 = await app.fetch(
        new Request("http://localhost/graphql", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query }),
        }),
      );
      expect(res1.status).toBe(200);
      const body1 = (await res1.json()) as {
        data: { posts: Array<{ id: string; author: { id: string; name: string } }> };
      };
      expect(body1.data.posts).toHaveLength(3);
      expect(body1.data.posts[0]!.author).toEqual({ id: "u1", name: "Author u1" });
      expect(body1.data.posts[1]!.author).toEqual({ id: "u2", name: "Author u2" });
      expect(body1.data.posts[2]!.author).toEqual({ id: "u1", name: "Author u1" });
      expect(batchCalls).toEqual([["u1", "u2"]]);

      // Request 2: fresh per-request DataLoader (no cross-request cache pollution)
      const res2 = await app.fetch(
        new Request("http://localhost/graphql", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query }),
        }),
      );
      expect(res2.status).toBe(200);
      expect(batchCalls).toEqual([
        ["u1", "u2"],
        ["u1", "u2"],
      ]);

      // Both resolver and loader factory stayed SINGLETON (instantiated once!)
      expect(resolverConstructions).toBe(1);
      expect(factoryConstructions).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("preserves cross-field microtask batching with multiple @Loader() params, excludes loader params from SDL, and works on @Query/@Mutation", async () => {
    const authorBatches: Array<readonly string[]> = [];
    const tagBatches: Array<readonly string[]> = [];

    @ObjectType()
    class Article {
      @Field(() => ID)
      id!: string;

      authorId!: string;
      coAuthorId!: string;
      tagId!: string;

      @Field(() => Author)
      author!: Author;

      @Field(() => String)
      summary!: string;
    }

    @Injectable()
    class AuthorLoader implements BunestDataLoaderFactory<string, Author> {
      createDataLoader(): BunestDataLoader<string, Author> {
        return new BunestDataLoader(async (ids) => {
          authorBatches.push([...ids]);
          return ids.map((id) => ({ id, name: `Author ${id}` }));
        });
      }
    }

    @Injectable()
    class TagLoader implements BunestDataLoaderFactory<string, string> {
      createDataLoader(): BunestDataLoader<string, string> {
        return new BunestDataLoader(async (ids) => {
          tagBatches.push([...ids]);
          return ids.map((id) => `#${id}`);
        });
      }
    }

    @Resolver(() => Article)
    class ArticlesResolver {
      @Query(() => [Article])
      articles(): Article[] {
        return [
          {
            id: "a1",
            authorId: "u1",
            coAuthorId: "u2",
            tagId: "t1",
            author: null as any,
            summary: "",
          },
        ];
      }

      @Query(() => Author)
      authorById(
        @Args("id") id: string,
        @Loader(AuthorLoader) loader: BunestDataLoader<string, Author>,
      ): Promise<Author> {
        return loader.load(id);
      }

      @Mutation(() => Author)
      touchAuthor(
        @Args("id") id: string,
        @Loader(AuthorLoader) loader: BunestDataLoader<string, Author>,
      ): Promise<Author> {
        return loader.load(id);
      }

      // 1 @Loader() param
      @ResolveField(() => Author)
      author(
        @Parent() article: Article,
        @Loader(AuthorLoader) loader: BunestDataLoader<string, Author>,
      ): Promise<Author> {
        return loader.load(article.authorId);
      }

      // 2 @Loader() params sharing AuthorLoader with sibling field `author`
      @ResolveField(() => String)
      async summary(
        @Parent() article: Article,
        @Loader(TagLoader) tagLoader: BunestDataLoader<string, string>,
        @Loader(AuthorLoader) authorLoader: BunestDataLoader<string, Author>,
      ): Promise<string> {
        const [tag, coAuthor] = await Promise.all([
          tagLoader.load(article.tagId),
          authorLoader.load(article.coAuthorId),
        ]);
        return `${tag}:${coAuthor.name}`;
      }
    }

    @Module({
      imports: [GraphQLModule.forRoot({ autoSchemaFile: true })],
      providers: [AuthorLoader, TagLoader, ArticlesResolver],
    })
    class AppModule {}

    const app = await BunestFactory.create(AppModule, { logger: false });
    await app.init();

    try {
      // SDL must exclude @Loader() parameters from schema arguments
      const sdl = app.get(GraphQLService).printSDL();
      expect(sdl).toContain("authorById(id: String!): Author!");
      expect(sdl).toContain("touchAuthor(id: String!): Author!");
      expect(sdl).toContain("author: Author!");
      expect(sdl).toContain("summary: String!");

      // Cross-field batching: `author` (1 loader) and `summary` (2 loaders) coalesce into 1 AuthorLoader batch
      const res = await app.fetch(
        new Request("http://localhost/graphql", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            query: `{ articles { id author { id name } summary } }`,
          }),
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.errors).toBeUndefined();
      expect(body.data.articles[0]).toEqual({
        id: "a1",
        author: { id: "u1", name: "Author u1" },
        summary: "#t1:Author u2",
      });
      expect(authorBatches).toEqual([["u1", "u2"]]);
      expect(tagBatches).toEqual([["t1"]]);

      // @Query and @Mutation with @Loader()
      const qRes = await app.fetch(
        new Request("http://localhost/graphql", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: `{ authorById(id: "u9") { id name } }` }),
        }),
      );
      expect(((await qRes.json()) as any).data.authorById).toEqual({
        id: "u9",
        name: "Author u9",
      });

      const mRes = await app.fetch(
        new Request("http://localhost/graphql", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            query: `mutation { touchAuthor(id: "u10") { id name } }`,
          }),
        }),
      );
      expect(((await mRes.json()) as any).data.touchAuthor).toEqual({
        id: "u10",
        name: "Author u10",
      });
    } finally {
      await app.close();
    }
  });

  it("supports Scope.REQUEST loader factories and caches per GraphQL request", async () => {
    let factoryConstructions = 0;
    const batches: Array<readonly string[]> = [];

    @Injectable({ scope: Scope.REQUEST })
    class RequestScopedAuthorLoader
      implements BunestDataLoaderFactory<string, Author>
    {
      private readonly instanceId: number;

      constructor() {
        factoryConstructions += 1;
        this.instanceId = factoryConstructions;
      }

      createDataLoader(): BunestDataLoader<string, Author> {
        const instId = this.instanceId;
        return new BunestDataLoader(async (ids) => {
          batches.push([...ids]);
          return ids.map((id) => ({ id, name: `Req#${instId}:${id}` }));
        });
      }
    }

    @Resolver(() => Post)
    class ScopedPostsResolver {
      @Query(() => [Post])
      posts(): Post[] {
        return [
          { id: "p1", title: "A", authorId: "u1", author: null as any },
          { id: "p2", title: "B", authorId: "u2", author: null as any },
        ];
      }

      @ResolveField(() => Author)
      author(
        @Parent() post: Post,
        @Loader(RequestScopedAuthorLoader)
        loader: BunestDataLoader<string, Author>,
      ): Promise<Author> {
        return loader.load(post.authorId);
      }
    }

    @Module({
      imports: [GraphQLModule.forRoot({ autoSchemaFile: true })],
      providers: [RequestScopedAuthorLoader, ScopedPostsResolver],
    })
    class AppModule {}

    const app = await BunestFactory.create(AppModule, { logger: false });
    await app.init();

    try {
      const req = () =>
        app.fetch(
          new Request("http://localhost/graphql", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              query: `{ posts { id author { id name } } }`,
            }),
          }),
        );

      const body1 = (await (await req()).json()) as any;
      expect(body1.errors).toBeUndefined();
      expect(body1.data.posts[0].author.name).toBe("Req#1:u1");
      expect(body1.data.posts[1].author.name).toBe("Req#1:u2");

      const body2 = (await (await req()).json()) as any;
      expect(body2.errors).toBeUndefined();
      expect(body2.data.posts[0].author.name).toBe("Req#2:u1");
      expect(body2.data.posts[1].author.name).toBe("Req#2:u2");

      // Instantiated once per request (not once per field!)
      expect(factoryConstructions).toBe(2);
    } finally {
      await app.close();
    }
  });

  it("validates invalid @Loader() tokens, missing createDataLoader(), null return, primitive context, and TestingModule.overrideProvider", async () => {
    // 1. @Loader(undefined) throws eagerly
    expect(() => Loader(undefined as any)).toThrow(/requires a DataLoader factory class/i);

    // 2. Primitive/undefined context in resolveRequestScopedDataLoader does not throw WeakMap TypeError
    class SimpleFactory implements BunestDataLoaderFactory<string, string> {
      createDataLoader(): BunestDataLoader<string, string> {
        return new BunestDataLoader((keys) => keys.map((k) => `v:${k}`));
      }
    }
    const loaderFromUndef = resolveRequestScopedDataLoader(
      undefined,
      SimpleFactory,
      new SimpleFactory(),
    );
    expect(await loaderFromUndef.load("a")).toBe("v:a");
    const loaderFromPrim = resolveRequestScopedDataLoader(
      "primitive-ctx" as any,
      SimpleFactory,
      new SimpleFactory(),
    );
    expect(await loaderFromPrim.load("b")).toBe("v:b");

    // 3. createDataLoader() returning null/undefined throws descriptive error
    class NullFactory implements BunestDataLoaderFactory<string, string> {
      createDataLoader(): any {
        return null;
      }
    }
    expect(() =>
      resolveRequestScopedDataLoader({}, NullFactory, new NullFactory()),
    ).toThrow(/must return a BunestDataLoader instance/i);

    // 4. Factory lacking createDataLoader() + TestingModule.overrideProvider
    @Injectable()
    class BrokenLoader {}

    @Injectable()
    class OverridableLoader implements BunestDataLoaderFactory<string, Author> {
      createDataLoader(): BunestDataLoader<string, Author> {
        return new BunestDataLoader((ids) =>
          ids.map((id) => ({ id, name: `Real ${id}` })),
        );
      }
    }

    @Resolver()
    class TestResolver {
      @Query(() => Author)
      broken(
        @Loader(BrokenLoader) loader: BunestDataLoader<string, Author>,
      ): Promise<Author> {
        return loader.load("1");
      }

      @Query(() => Author)
      overridden(
        @Loader(OverridableLoader) loader: BunestDataLoader<string, Author>,
      ): Promise<Author> {
        return loader.load("1");
      }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [GraphQLModule.forRoot({ autoSchemaFile: true })],
      providers: [BrokenLoader, OverridableLoader, TestResolver],
    })
      .overrideProvider(OverridableLoader)
      .useValue({
        createDataLoader: () =>
          new BunestDataLoader((ids: readonly string[]) =>
            ids.map((id) => ({ id, name: `Mocked ${id}` })),
          ),
      })
      .compile();

    const app = moduleRef.createNestApplication({ logger: false });
    await app.init();

    try {
      const gql = app.get(GraphQLService);

      const overriddenRes = await gql.executeQuery({
        query: `{ overridden { id name } }`,
      });
      expect(overriddenRes.result.errors).toBeUndefined();
      expect((overriddenRes.result.data as any).overridden).toEqual({
        id: "1",
        name: "Mocked 1",
      });

      const brokenRes = await gql.executeQuery({
        query: `{ broken { id name } }`,
      });
      expect(brokenRes.result.errors).toBeDefined();
      expect(brokenRes.result.errors![0]!.message).toContain(
        "must implement createDataLoader()",
      );
    } finally {
      await app.close();
    }
  });
});
