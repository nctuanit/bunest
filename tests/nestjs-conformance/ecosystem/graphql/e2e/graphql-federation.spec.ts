import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  it,
} from "bun:test";
import {
  type GraphQLSchema,
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
  Mutation,
  Parent,
  Query,
  ResolveField,
  ResolveReference,
  Resolver,
  Scalar,
} from "../../../../../packages/graphql/src";
import { Test, describeConformance, request } from "../../../_helpers/index";

const USERS_FEDERATION_SDL = `
type User @key(fields: "id") {
  id: ID!
  name: String!
}

extend type Query {
  getUser(id: ID!): User
}
`;

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

interface User {
  id: string;
  name: string;
}

@Injectable()
class UsersService {
  private readonly users: User[] = [{ id: "5", name: "GraphQL" }];

  findById(id: string): Promise<User | undefined> {
    return Promise.resolve(this.users.find((p) => p.id === id));
  }
}

@Resolver("User")
class UsersResolvers {
  constructor(private readonly usersService: UsersService) {}

  @Query(() => Object, { name: "getUser" })
  getUser(@Args("id") id: string) {
    return this.usersService.findById(id);
  }

  @ResolveReference()
  resolveReference(reference: { __typename: string; id: string }) {
    return this.usersService.findById(reference.id);
  }
}

@Module({
  providers: [UsersResolvers, UsersService],
})
class UsersFeatureModule {}

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
class PostsUsersResolvers {
  constructor(private readonly postsService: PostsService) {}

  @ResolveField("posts")
  getPosts(@Parent() reference: { id: string }) {
    return this.postsService.findByUserId(reference.id);
  }
}

@Module({
  providers: [PostsResolvers, PostsService, PostsUsersResolvers, DateScalar],
})
class PostsFeatureModule {}

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
  "GraphQL Federation",
  {
    upstreamPath: "packages/apollo/tests/e2e/graphql-federation.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts ApolloFederationDriver schema-first UsersService & PostsService E2E to native @bunest/graphql Federation Subgraph (ADR-001, ADR-013) via zero-socket request(app).",
  },
  () => {
    let app: BunestApplication;
    let usersDir: string;
    let postsDir: string;

    beforeAll(async () => {
      const tempRoot = Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp";
      usersDir = join(tempRoot, `bunest-fed-users-${crypto.randomUUID()}`);
      postsDir = join(tempRoot, `bunest-fed-posts-${crypto.randomUUID()}`);
      await ensureDir(usersDir);
      await ensureDir(postsDir);
      await Bun.write(
        join(usersDir, "users.types.graphql"),
        USERS_FEDERATION_SDL,
      );
      await Bun.write(
        join(postsDir, "posts.types.graphql"),
        POSTS_FEDERATION_SDL,
      );
    });

    afterAll(async () => {
      await removePath(usersDir, { recursive: true, force: true });
      await removePath(postsDir, { recursive: true, force: true });
    });

    afterEach(async () => {
      if (app) {
        await app.close();
      }
    });

    describe("UsersService", () => {
      beforeEach(async () => {
        @Module({
          imports: [
            GraphQLModule.forRoot({
              federation: { version: 2 },
              typePaths: [join(usersDir, "**/*.graphql")],
            }),
            UsersFeatureModule,
          ],
        })
        class UsersModule {}

        const moduleRef = await Test.createTestingModule({
          imports: [UsersModule],
        }).compile({ logger: false });

        app = moduleRef.createNestApplication({ logger: false });
        await app.init();
      });

      it("should return query result", async () => {
        await request(app)
          .post("/graphql")
          .send({
            operationName: null,
            variables: {},
            query: `
          {
            getUser(id: "5") {
              id,
              name,
            }
          }`,
          })
          .expect(200, {
            data: {
              getUser: {
                id: "5",
                name: "GraphQL",
              },
            },
          });
      });

      it("should resolve references", async () => {
        await request(app)
          .post("/graphql")
          .send({
            variables: {
              representations: [
                {
                  __typename: "User",
                  id: "5",
                },
              ],
            },
            query: `
              query ($representations: [_Any!]!) {
                _entities(representations: $representations) {
                  __typename
                  ... on User {
                    id
                    name
                  }
                }
              }`,
          })
          .expect(200, {
            data: {
              _entities: [
                {
                  __typename: "User",
                  id: "5",
                  name: "GraphQL",
                },
              ],
            },
          });
      });
    });

    describe("PostsService", () => {
      beforeEach(async () => {
        @Module({
          imports: [
            GraphQLModule.forRoot({
              federation: { version: 2 },
              typePaths: [join(postsDir, "**/*.graphql")],
              transformSchema: (schema) =>
                upperDirectiveTransformer(schema, "upper"),
            }),
            PostsFeatureModule,
          ],
        })
        class PostsModule {}

        const moduleRef = await Test.createTestingModule({
          imports: [PostsModule],
        }).compile({ logger: false });

        app = moduleRef.createNestApplication({ logger: false });
        await app.init();
      });

      it("should return query result", async () => {
        await request(app)
          .post("/graphql")
          .send({
            operationName: null,
            variables: {},
            query: `
          {
            getPosts {
              id,
              title,
              body,
            }
          }`,
          })
          .expect(200, {
            data: {
              getPosts: [
                {
                  id: "1",
                  title: "HELLO WORLD",
                  body: "Lorem ipsum dolor sit amet, consectetur adipiscing elit.",
                },
              ],
            },
          });
      });

      it("should return a stripped reference", async () => {
        await request(app)
          .post("/graphql")
          .send({
            operationName: null,
            variables: {},
            query: `
          {
            getPosts {
              id,
              title,
              body,
              user {
                id
              }
            }
          }`,
          })
          .expect(200, {
            data: {
              getPosts: [
                {
                  id: "1",
                  title: "HELLO WORLD",
                  body: "Lorem ipsum dolor sit amet, consectetur adipiscing elit.",
                  user: {
                    id: "5",
                  },
                },
              ],
            },
          });
      });

      it("should handle scalars", async () => {
        await request(app)
          .post("/graphql")
          .send({
            operationName: null,
            variables: {},
            query: `
          mutation {
            publishPost(id: "1", publishDate: 500) {
              id,
              title,
              body,
              publishDate
            }
          }`,
          })
          .expect(200, {
            data: {
              publishPost: {
                id: "1",
                title: "HELLO WORLD",
                body: "Lorem ipsum dolor sit amet, consectetur adipiscing elit.",
                publishDate: 500,
              },
            },
          });
      });

      it("should accept enum as query input", async () => {
        await request(app)
          .post("/graphql")
          .send({
            variables: {
              postType: "TEXT",
            },
            query: `
              query ($postType: PostType!) {
                getPosts(type: $postType) {
                  id
                  type
                }
              }`,
          })
          .expect(200, {
            data: {
              getPosts: [
                {
                  id: "1",
                  type: "TEXT",
                },
              ],
            },
          });
      });
    });
  },
);
