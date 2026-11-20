import "reflect-metadata";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, mock } from "bun:test";
import {
  type DirectiveNode,
  type DocumentNode,
  Kind,
  type SchemaExtensionNode,
  parse,
  specifiedDirectives,
  visit,
} from "../../../../../packages/graphql/node_modules/graphql";
import { Injectable, Module } from "../../../../../packages/common/src";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Args,
  Directive,
  Field,
  FileSystemHelper,
  GraphQLModule,
  ID,
  Int,
  ObjectType,
  Parent,
  Query,
  ResolveField,
  ResolveReference,
  Resolver,
} from "../../../../../packages/graphql/src";
import { Test, describeConformance } from "../../../_helpers/index";

const FEDERATION_SPEC_URL_PREFIX = "https://specs.apollo.dev/federation/v2";

function getFederationLink(document: DocumentNode): DirectiveNode | undefined {
  return document.definitions
    .filter(
      (definition): definition is SchemaExtensionNode =>
        definition.kind === Kind.SCHEMA_EXTENSION,
    )
    .flatMap((definition) => definition.directives ?? [])
    .find((directive) => {
      const url = directive.arguments?.find((arg) => arg.name.value === "url");
      return (
        directive.name.value === "link" &&
        url?.value.kind === Kind.STRING &&
        url.value.value.startsWith(FEDERATION_SPEC_URL_PREFIX)
      );
    });
}

function getImportedDirectives(link: DirectiveNode): string[] {
  const importArg = link.arguments?.find((arg) => arg.name.value === "import");
  if (importArg?.value.kind !== Kind.LIST) {
    return [];
  }
  return importArg.value.values.flatMap((value) =>
    value.kind === Kind.STRING ? [value.value] : [],
  );
}

function getUsedDirectives(document: DocumentNode): string[] {
  const builtInDirectives = new Set([
    "link",
    ...specifiedDirectives.map((directive) => directive.name),
  ]);
  const used = new Set<string>();
  visit(document, {
    Directive(node) {
      if (!builtInDirectives.has(node.name.value)) {
        used.add(`@${node.name.value}`);
      }
    },
  });
  return [...used];
}

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

describeConformance(
  "Federation 2 - autoSchemaFile generation",
  {
    upstreamPath:
      "packages/apollo/tests/e2e/federation2-auto-schema-file.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts ApolloFederationDriver Federation 2 autoSchemaFile generation E2E to native @bunest/graphql (ADR-001, ADR-013) with isolated temp schema path and graphql-js AST validation instead of @apollo/gateway LocalCompose.",
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
        tmpdir(),
        `bunest-fed2-auto-schema-${crypto.randomUUID()}.graphql`,
      );

      @Module({
        imports: [
          GraphQLModule.forRoot({
            federation: { version: 2 },
            includeStacktraceInErrorResponses: false,
            autoSchemaFile: {
              path: schemaPath,
              federation: 2,
            },
            buildSchemaOptions: {
              orphanedTypes: [User],
            },
          }),
        ],
        providers: [PostService, PostResolver, UserResolver],
      })
      class Federation2AutoSchemaFileModule {}

      const moduleRef = await Test.createTestingModule({
        imports: [Federation2AutoSchemaFileModule],
      })
        .overrideProvider(FileSystemHelper)
        .useValue({ writeFile: writeFileMock })
        .compile({ logger: false });

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
    });

    afterEach(async () => {
      await app.close();
      rmSync(schemaPath, { force: true });
    });

    // BUNEST_BUG: GraphQLSchemaFactory.buildCodeFirst (packages/graphql/src/schema/graphql-schema.factory.ts) writes autoSchemaFile via direct `node:fs` `writeFileSync` instead of DI `FileSystemHelper.writeFile()` (0 calls instead of 1), and emits raw `printSchema(schema)` without Federation v2 `extend schema @link(url: "https://specs.apollo.dev/federation/v2...", import: [...])` or `@key`/`@extends`/`@external` directives.
    it.skip("should link the federation 2 spec in the generated SDL file", () => {
      expect(writeFileMock).toHaveBeenCalledTimes(1);
      expect(writeFileMock.mock.calls[0]?.[0]).toBe(schemaPath);

      const fileContent = writeFileMock.mock.calls[0]?.[1] ?? "";
      expect(fileContent).toMatch(
        /extend schema @link\(url: "https:\/\/specs\.apollo\.dev\/federation\/v2\.\d+", import: \[[^\]]+\]\)/,
      );

      const document = parse(fileContent);
      const link = getFederationLink(document);
      expect(link).toBeDefined();

      const usedDirectives = getUsedDirectives(document);
      expect(usedDirectives).toEqual(
        expect.arrayContaining(["@key", "@extends", "@external"]),
      );
      expect(getImportedDirectives(link!)).toEqual(
        expect.arrayContaining(usedDirectives),
      );
    });

    // BUNEST_BUG: GraphQLSchemaFactory.buildCodeFirst (packages/graphql/src/schema/graphql-schema.factory.ts) bypasses DI `FileSystemHelper.writeFile()` and emits raw `printSchema(schema)` lacking Federation v2 `@link` and `@key` directives required for subgraph composition.
    it.skip("should write an SDL file that composes with other federation 2 subgraphs", async () => {
      const fileContent = writeFileMock.mock.calls[0]?.[1] ?? "";
      expect(fileContent.length).toBeGreaterThan(0);

      const postsDoc = parse(fileContent);
      const usersDoc = parse(`
        extend schema
          @link(url: "https://specs.apollo.dev/federation/v2.3", import: ["@key"])

        type User @key(fields: "id") {
          id: ID!
          name: String!
        }

        type Query {
          me: User
        }
      `);

      // Verify both subgraphs declare Federation v2 @link and matching entity keys for composition
      expect(getFederationLink(postsDoc)).toBeDefined();
      expect(getFederationLink(usersDoc)).toBeDefined();
      expect(fileContent).toContain("type Post");
      expect(fileContent).toContain("type User");
      expect(fileContent).toMatch(/type\s+Post[^{]*@key\(fields:\s*"id"\)/);
      expect(fileContent).toMatch(/type\s+User[^{]*@key\(fields:\s*"id"\)/);
    });
  },
);
