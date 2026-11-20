import "reflect-metadata";
import { afterEach, describe, expect, test } from "bun:test";
import { Module } from "@bunest/common";
import { BunestFactory } from "@bunest/core";
import {
  Args,
  Directive,
  Field,
  GraphQLModule,
  ID,
  ObjectType,
  Query,
  ResolveReference,
  Resolver,
  transformSchema,
} from "@bunest/graphql";
import { GraphQLObjectType, GraphQLString, isObjectType, printSchema } from "graphql";
import {
  ApolloFederationDriver,
  type ApolloFederationDriverConfig,
  ApolloGatewayDriver,
  type ApolloGatewayDriverConfig,
  getApolloServer,
  IntrospectAndCompose,
  RemoteGraphQLDataSource,
} from "../src/index";

describe("@bunest/apollo — ApolloFederationDriver & Multi-Subgraph ApolloGatewayDriver", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await Promise.resolve(cleanups.pop()!()).catch(() => {});
    }
  });

  test("ApolloFederationDriver exposes Federation v2 _service { sdl } and _entities with @ResolveReference()", async () => {
    @Directive('@key(fields: "id")')
    @ObjectType()
    class FedUser {
      @Field(() => ID)
      id!: string;

      @Field()
      name!: string;
    }

    @Resolver(() => FedUser)
    class FedUserResolver {
      private readonly db = new Map<string, FedUser>([
        ["u1", { id: "u1", name: "Ada Lovelace" }],
        ["u2", { id: "u2", name: "Grace Hopper" }],
      ]);

      @Query(() => FedUser, { nullable: true })
      user(@Args("id", { type: () => ID }) id: string) {
        return this.db.get(id) ?? null;
      }

      @ResolveReference()
      resolveReference(ref: { __typename: string; id: string }) {
        return this.db.get(ref.id) ?? null;
      }
    }

    @Module({
      imports: [
        GraphQLModule.forRoot<ApolloFederationDriverConfig>({
          driver: ApolloFederationDriver,
          autoSchemaFile: { federation: 2 },
        }),
      ],
      providers: [FedUserResolver],
    })
    class UsersSubgraphModule {}

    const app = await BunestFactory.create(UsersSubgraphModule, {
      logger: false,
    });
    cleanups.push(() => app.close());
    await app.init();

    // 1. _service { sdl }
    const sdlRes = await app.fetch(
      new Request("http://localhost/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: `{ _service { sdl } }` }),
      }),
    );
    expect(sdlRes.status).toBe(200);
    const sdlJson = (await sdlRes.json()) as any;
    expect(sdlJson.data._service.sdl).toContain("type FedUser");
    expect(sdlJson.data._service.sdl).toContain('@key(fields: "id")');

    // 2. _entities(representations)
    const entRes = await app.fetch(
      new Request("http://localhost/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: `query ($reps: [_Any!]!) { _entities(representations: $reps) { ... on FedUser { id name } } }`,
          variables: { reps: [{ __typename: "FedUser", id: "u2" }] },
        }),
      }),
    );
    expect(entRes.status).toBe(200);
    expect(await entRes.json()).toEqual({
      data: { _entities: [{ id: "u2", name: "Grace Hopper" }] },
    });
  });

  test("ApolloGatewayDriver composes multiple live Federation v2 subgraphs, forwards headers via RemoteGraphQLDataSource, and resolves cross-subgraph entities", async () => {
    const receivedHeaders: string[] = [];

    // --- Subgraph A: Users ---
    @Module({
      imports: [
        GraphQLModule.forRoot<ApolloFederationDriverConfig>({
          driver: ApolloFederationDriver,
          federation: { version: 2 },
          typeDefs: `
            type User @key(fields: "id") {
              id: ID!
              name: String!
            }
            type Query {
              user(id: ID!): User
            }
          `,
          resolvers: {
            Query: {
              user: (_p: any, args: { id: string }, ctx: any) => {
                const auth = ctx?.req?.headers?.get?.("x-gateway-auth");
                if (auth) receivedHeaders.push(`users:${auth}`);
                return args.id === "u1"
                  ? { id: "u1", name: "Alan Turing" }
                  : null;
              },
            },
            User: {
              __resolveReference: (ref: { id: string }) => ({
                id: ref.id,
                name: "Alan Turing",
              }),
            },
          },
        }),
      ],
    })
    class SubgraphUsersModule {}

    // --- Subgraph B: Profiles & Posts (extends User with `bio`) ---
    @Module({
      imports: [
        GraphQLModule.forRoot<ApolloFederationDriverConfig>({
          driver: ApolloFederationDriver,
          federation: { version: 2 },
          typeDefs: `
            type Post {
              id: ID!
              title: String!
            }
            type User @key(fields: "id") {
              id: ID! @external
              bio: String!
            }
            type Query {
              posts: [Post!]!
            }
          `,
          resolvers: {
            Query: {
              posts: (_p: any, _a: any, ctx: any) => {
                const auth = ctx?.req?.headers?.get?.("x-gateway-auth");
                if (auth) receivedHeaders.push(`posts:${auth}`);
                return [{ id: "p1", title: "On Computable Numbers" }];
              },
            },
            User: {
              __resolveReference: (ref: { id: string }) => ({
                id: ref.id,
                bio: `Bio for ${ref.id}`,
              }),
            },
          },
        }),
      ],
    })
    class SubgraphPostsModule {}

    const usersApp = await BunestFactory.create(SubgraphUsersModule, {
      logger: false,
    });
    const postsApp = await BunestFactory.create(SubgraphPostsModule, {
      logger: false,
    });
    cleanups.push(() => usersApp.close());
    cleanups.push(() => postsApp.close());
    await usersApp.init();
    await postsApp.init();

    // Route virtual subgraph URLs directly into our live Bunest subgraph apps via fetch() contract
    const subgraphFetcher = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const req =
        input instanceof Request ? input : new Request(String(input), init);
      if (req.url.startsWith("http://users.internal")) {
        return usersApp.fetch(req);
      }
      if (req.url.startsWith("http://posts.internal")) {
        return postsApp.fetch(req);
      }
      throw new Error(`Unexpected subgraph URL: ${req.url}`);
    };

    // --- Gateway ---
    @Module({
      imports: [
        GraphQLModule.forRoot<ApolloGatewayDriverConfig>({
          driver: ApolloGatewayDriver,
          server: {
            path: "/gateway",
            context: ({ req }: { req: Request }) => ({
              token: req?.headers?.get("authorization") ?? "anon",
            }),
          },
          gateway: {
            supergraphSdl: new IntrospectAndCompose({
              subgraphs: [
                { name: "users", url: "http://users.internal/graphql" },
                { name: "posts", url: "http://posts.internal/graphql" },
              ],
            }),
            buildService: ({ url }) =>
              new RemoteGraphQLDataSource({
                url: url!,
                fetcher: subgraphFetcher,
                willSendRequest({ request, context }) {
                  if (context?.token) {
                    request.http?.headers.set("x-gateway-auth", context.token);
                  }
                },
              }),
          },
        }),
      ],
    })
    class GatewayAppModule {}

    const gatewayApp = await BunestFactory.create(GatewayAppModule, {
      logger: false,
    });
    cleanups.push(() => gatewayApp.close());
    await gatewayApp.init();

    // Cross-subgraph query combining `users` + `posts` AND entity extension `User.bio`!
    const res = await gatewayApp.fetch(
      new Request("http://localhost/gateway", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer secret-jwt",
        },
        body: JSON.stringify({
          query: `
            query FederatedView($uid: ID!) {
              user(id: $uid) {
                id
                name
                bio
              }
              posts {
                id
                title
              }
            }
          `,
          variables: { uid: "u1" },
        }),
      }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: {
        user: {
          id: "u1",
          name: "Alan Turing",
          bio: "Bio for u1",
        },
        posts: [{ id: "p1", title: "On Computable Numbers" }],
      },
    });
    expect(receivedHeaders).toContain("users:Bearer secret-jwt");
    expect(receivedHeaders).toContain("posts:Bearer secret-jwt");
  });

  test("ApolloGatewayDriver applies transformSchema and validates operations against transformed schema", async () => {
    @Module({
      imports: [
        GraphQLModule.forRoot<ApolloGatewayDriverConfig>({
          driver: ApolloGatewayDriver,
          gateway: {
            supergraphSdl: `
              type Query {
                publicField: String
                internalField: String
              }
            `,
          },
          transformSchema: (schema) =>
            transformSchema(schema, (type) => {
              if (isObjectType(type) && type.name === "Query") {
                const cfg = type.toConfig();
                const fields = { ...cfg.fields };
                delete fields.internalField;
                fields.addedField = {
                  type: GraphQLString,
                  resolve: () => "ok",
                };
                return new GraphQLObjectType({ ...cfg, fields });
              }
              return type;
            }),
        }),
      ],
    })
    class TransformedGatewayModule {}

    const app = await BunestFactory.create(TransformedGatewayModule, {
      logger: false,
    });
    cleanups.push(() => app.close());
    await app.init();

    const apolloServer = getApolloServer(app);
    const sdl = printSchema(apolloServer.schema!);
    expect(sdl).toContain("publicField");
    expect(sdl).toContain("addedField");
    expect(sdl).not.toContain("internalField");

    // Querying removed field fails validation against transformed schema
    const blocked = await apolloServer.executeOperation({
      query: `{ internalField }`,
    });
    expect(blocked.http.status).toBe(400);
    expect(
      blocked.body.kind === "single" &&
        blocked.body.singleResult.errors?.[0]?.message,
    ).toContain("internalField");
  });
});
