import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
} from "bun:test";
import {
  GraphQLSchema,
  Kind,
  type ValueNode,
  defaultFieldResolver,
  isObjectType,
} from "../../../../../packages/graphql/src";
import { Injectable, Module } from "../../../../../packages/core/src/common";
import {
  ensureDir,
  join,
  removePath,
  type BunestApplication,
} from "../../../../../packages/core/src";
import {
  Args,
  type CustomScalar,
  GraphQLModule,
  GraphQLSchemaHost,
  Mutation,
  Parent,
  Query,
  ResolveField,
  Resolver,
  Scalar,
} from "../../../../../packages/graphql/src";
import { Test, describeConformance } from "../../../_helpers/index";

const POSTS_FEDERATION_SDL = `
directive @upper on FIELD_DEFINITION

scalar Date

enum PostType {
  TEXT
  IMAGE
}

type Post @key(fields: "id") {
  id: ID!
  title: String!
  body: String!
  user: User
  publishDate: Date
  type: PostType
}

extend type User @key(fields: "id") {
  id: ID! @external
  posts: [Post]
}

extend type Query {
  getPosts(type: PostType): [Post]
}

extend type Mutation {
  publishPost(id: ID!, publishDate: Date!): Post
}
`;

enum PostType {
  IMAGE = "IMAGE",
  TEXT = "TEXT",
}

interface Post {
  id: string;
  title: string;
  body: string;
  userId: string;
  publishDate: Date;
  type: PostType;
}

@Scalar("Date")
class DateScalar implements CustomScalar<number, Date> {
  description = "Date custom scalar type";

  parseValue(value: unknown): Date {
    const date = new Date(parseInt(String(value), 10));
    if (Number.isNaN(date.getTime())) {
      throw new TypeError("Invalid date given");
    }
    return date;
  }

  serialize(value: Date): number {
    return value.getTime();
  }

  parseLiteral(ast: ValueNode): Date {
    if (ast.kind === Kind.INT) {
      return new Date(parseInt(ast.value, 10));
    }
    return null as unknown as Date;
  }
}

@Injectable()
class PostsService {
  private readonly posts: Post[] = [
    {
      id: "1",
      title: "HELLO WORLD",
      body: "Lorem ipsum dolor sit amet, consectetur adipiscing elit.",
      userId: "5",
      publishDate: new Date(0),
      type: PostType.TEXT,
    },
  ];

  findAll(): Promise<Post[]> {
    return Promise.resolve(this.posts);
  }

  findById(id: string): Promise<Post | undefined> {
    return Promise.resolve(this.posts.find((p) => p.id === id));
  }

  findByUserId(id: string): Promise<Post[]> {
    return Promise.resolve(this.posts.filter((p) => p.userId === id));
  }

  findByType(type: PostType): Promise<Post[]> {
    return Promise.resolve(this.posts.filter((p) => p.type === type));
  }

  async publish(id: string, publishDate: Date): Promise<Post | undefined> {
    const post = await this.findById(id);
    if (post) {
      post.publishDate = publishDate;
    }
    return post;
  }
}

@Resolver("Post")
class PostsResolvers {
  constructor(private readonly postsService: PostsService) {}

  @Query(() => [Object], { name: "getPosts" })
  getPosts(@Args("type") type?: PostType) {
    if (type) {
      return this.postsService.findByType(type);
    }
    return this.postsService.findAll();
  }

  @Mutation(() => Object, { name: "publishPost" })
  publishPost(@Args("id") id: string, @Args("publishDate") publishDate: Date) {
    return this.postsService.publish(id, publishDate);
  }

  @ResolveField("user")
  getUser(@Parent() post: Post) {
    return { __typename: "User", id: post.userId };
  }
}

@Resolver("User")
class UsersResolvers {
  constructor(private readonly postsService: PostsService) {}

  @ResolveField("posts")
  getPosts(@Parent() reference: { id: string }) {
    return this.postsService.findByUserId(reference.id);
  }
}

@Module({
  providers: [PostsResolvers, PostsService, UsersResolvers, DateScalar],
})
class PostsModule {}

function upperDirectiveTransformer(
  schema: GraphQLSchema,
  directiveName: string,
): GraphQLSchema {
  for (const type of Object.values(schema.getTypeMap())) {
    if (!isObjectType(type) || type.name.startsWith("__")) {
      continue;
    }
    for (const field of Object.values(type.getFields())) {
      const hasUpper = field.astNode?.directives?.some(
        (d) => d.name.value === directiveName,
      );
      if (hasUpper) {
        const resolve = field.resolve ?? defaultFieldResolver;
        field.resolve = async function (source, args, context, info) {
          const result = await resolve(source, args, context, info);
          if (typeof result === "string") {
            return result.toUpperCase();
          }
          return result;
        };
      }
    }
  }
  return schema;
}

describeConformance(
  "GraphQL federation GraphQLSchemaHost using",
  {
    upstreamPath:
      "packages/apollo/tests/e2e/graphql-federation-schema-host.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts ApolloFederationDriver GraphQLSchemaHost E2E to native @bunest/graphql Federation Subgraph (ADR-001, ADR-013) with pure graphql-js directive transform.",
  },
  () => {
    let app: BunestApplication;
    let tmpDir: string;

    beforeAll(async () => {
      tmpDir = join(
        Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp",
        `bunest-fed-schema-host-${crypto.randomUUID()}`,
      );
      await ensureDir(tmpDir);
      await Bun.write(
        join(tmpDir, "posts.types.graphql"),
        POSTS_FEDERATION_SDL,
      );
    });

    afterAll(async () => {
      await removePath(tmpDir, { recursive: true, force: true });
    });

    beforeEach(async () => {
      @Module({
        imports: [
          GraphQLModule.forRoot({
            federation: { version: 2 },
            typePaths: [join(tmpDir, "**/*.graphql")],
            transformSchema: (schema) =>
              upperDirectiveTransformer(schema, "upper"),
          }),
          PostsModule,
        ],
      })
      class AppModule {}

      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile({ logger: false });

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
    });

    afterEach(async () => {
      await app.close();
    });

    it("GraphQLSchemaHost should contain schema", () => {
      const schemaHost = app.get(GraphQLSchemaHost);

      expect(schemaHost.schema).toBeInstanceOf(GraphQLSchema);
    });
  },
);
