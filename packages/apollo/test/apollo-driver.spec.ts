import "reflect-metadata";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Module,
  NotFoundException,
  Scope,
  UnauthorizedException,
  UnprocessableEntityException,
} from "@bunest/common";
import { BunestFactory } from "@bunest/core";
import {
  Args,
  Field,
  GraphQLModule,
  GraphQLSchemaHost,
  ID,
  Mutation,
  ObjectType,
  Query,
  Resolver,
  ResolverDecoratorHost,
} from "@bunest/graphql";
import {
  ApolloDriver,
  type ApolloDriverConfig,
  type ApolloDriverConfigFactory,
  ApolloError,
  ApolloFederationDefinitionsFactory,
  ApolloServerErrorCode,
  type ApolloServerPlugin,
  ApolloServerPluginLandingPageLocalDefault,
  AuthenticationError,
  BunestApolloServer,
  createApolloSchema,
  ForbiddenError,
  getApolloServer,
  PLUGIN_METADATA,
  Plugin,
  PluginsExplorerService,
  UserInputError,
  ValidationError,
} from "../src/index";

describe("@bunest/apollo — ApolloDriver, Plugins, Errors, APQ, Batching & GraphiQL", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await Promise.resolve(cleanups.pop()!()).catch(() => {});
    }
  });

  test("Apollo error classes extend GraphQLError with exact error codes", () => {
    const authErr = new AuthenticationError("not signed in", {
      extensions: { extra: 1 },
    });
    expect(authErr.message).toBe("not signed in");
    expect(authErr.extensions.code).toBe("UNAUTHENTICATED");
    expect(authErr.extensions.extra).toBe(1);

    const forbErr = new ForbiddenError("denied");
    expect(forbErr.extensions.code).toBe("FORBIDDEN");

    const inputErr = new UserInputError("bad arg");
    expect(inputErr.extensions.code).toBe(ApolloServerErrorCode.BAD_USER_INPUT);

    const valErr = new ValidationError("invalid");
    expect(valErr.extensions.code).toBe(
      ApolloServerErrorCode.GRAPHQL_VALIDATION_FAILED,
    );

    const baseErr = new ApolloError("custom", "CUSTOM_CODE", { detail: true });
    expect(baseErr.extensions.code).toBe("CUSTOM_CODE");
    expect(baseErr.extensions.detail).toBe(true);
    expect(PLUGIN_METADATA).toBe("graphql:plugin");
  });

  test("ApolloDriver runs code-first GraphQL with @Plugin() lifecycle hooks, GraphiQL, getApolloServer, batching, APQ, and HttpException mapping", async () => {
    const lifecycleLog: string[] = [];

    @Plugin()
    @Injectable()
    class AuditPlugin implements ApolloServerPlugin {
      async serverWillStart() {
        lifecycleLog.push("serverWillStart");
        return {
          async serverWillStop() {
            lifecycleLog.push("serverWillStop");
          },
        };
      }

      async requestDidStart() {
        lifecycleLog.push("requestDidStart");
        return {
          async parsingDidStart() {
            lifecycleLog.push("parsingDidStart");
          },
          async validationDidStart() {
            lifecycleLog.push("validationDidStart");
          },
          async didResolveOperation() {
            lifecycleLog.push("didResolveOperation");
          },
          async executionDidStart() {
            lifecycleLog.push("executionDidStart");
          },
          async didEncounterErrors() {
            lifecycleLog.push("didEncounterErrors");
          },
          async willSendResponse(ctx: any) {
            ctx.response.http.headers.set("x-apollo-plugin", "active");
            lifecycleLog.push("willSendResponse");
          },
        };
      }
    }

    @ObjectType()
    class Book {
      @Field(() => ID)
      id!: string;

      @Field()
      title!: string;
    }

    @Resolver(() => Book)
    class BookResolver {
      private books: Book[] = [{ id: "1", title: "Bunest in Action" }];

      @Query(() => [Book])
      booksList() {
        return this.books;
      }

      @Mutation(() => Book)
      addBook(@Args("title") title: string) {
        const b = { id: String(this.books.length + 1), title };
        this.books.push(b);
        return b;
      }

      @Query(() => String)
      throwBadRequest(): string {
        throw new BadRequestException("Invalid payload");
      }

      @Query(() => String)
      throwUnauthorized(): string {
        throw new UnauthorizedException("Token missing");
      }

      @Query(() => String)
      throwForbidden(): string {
        throw new ForbiddenException("No access");
      }

      @Query(() => String)
      throwUnprocessable(): string {
        throw new UnprocessableEntityException("Bad input");
      }

      @Query(() => String)
      throwNotFound(): string {
        throw new NotFoundException("Item gone");
      }
    }

    @Module({
      imports: [
        GraphQLModule.forRoot<ApolloDriverConfig>({
          driver: ApolloDriver,
          autoSchemaFile: true,
          graphiql: { headers: { "x-demo": "1" } },
          allowBatchedHttpRequests: true,
        }),
      ],
      providers: [BookResolver, AuditPlugin],
    })
    class AppModule {}

    const app = await BunestFactory.create(AppModule, { logger: false });
    cleanups.push(() => app.close());
    await app.init();

    // getApolloServer + GraphQLSchemaHost
    const server = getApolloServer(app);
    expect(server).toBeInstanceOf(BunestApolloServer);
    expect(server.started).toBe(true);
    expect(app.get(GraphQLSchemaHost).schema).toBe(server.schema!);
    expect(lifecycleLog).toContain("serverWillStart");

    // 1. Direct executeOperation
    const opRes = await server.executeOperation({
      query: `{ booksList { id title } }`,
    });
    expect(opRes.http.status).toBe(200);
    expect(opRes.http.headers.get("x-apollo-plugin")).toBe("active");
    expect(opRes.body.kind).toBe("single");
    if (opRes.body.kind === "single") {
      expect(opRes.body.singleResult.data).toEqual({
        booksList: [{ id: "1", title: "Bunest in Action" }],
      });
    }
    expect(lifecycleLog).toEqual([
      "serverWillStart",
      "requestDidStart",
      "parsingDidStart",
      "validationDidStart",
      "didResolveOperation",
      "executionDidStart",
      "willSendResponse",
    ]);

    // 2. GraphiQL HTML on GET /graphql with Accept: text/html
    const htmlRes = await app.fetch(
      new Request("http://localhost/graphql", {
        method: "GET",
        headers: { accept: "text/html" },
      }),
    );
    expect(htmlRes.status).toBe(200);
    const html = await htmlRes.text();
    expect(html).toContain("<title>GraphiQL</title>");
    expect(html).toContain('"x-demo":"1"');

    // 3. HTTP POST mutation & batched HTTP requests
    const batchRes = await app.fetch(
      new Request("http://localhost/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify([
          { query: `mutation { addBook(title: "Apollo Native") { id title } }` },
          { query: `{ booksList { title } }` },
        ]),
      }),
    );
    expect(batchRes.status).toBe(200);
    const batchJson = (await batchRes.json()) as any[];
    expect(batchJson).toHaveLength(2);
    expect(batchJson[0].data.addBook.title).toBe("Apollo Native");

    // 4. Automatic Persisted Queries (APQ)
    const apqQuery = `{ booksList { id } }`;
    const sha256Hash = createHash("sha256").update(apqQuery).digest("hex");

    const missRes = await app.fetch(
      new Request("http://localhost/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          extensions: { persistedQuery: { version: 1, sha256Hash } },
        }),
      }),
    );
    const missJson = (await missRes.json()) as any;
    expect(missJson.errors[0].extensions.code).toBe(
      ApolloServerErrorCode.PERSISTED_QUERY_NOT_FOUND,
    );

    const regRes = await app.fetch(
      new Request("http://localhost/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: apqQuery,
          extensions: { persistedQuery: { version: 1, sha256Hash } },
        }),
      }),
    );
    expect(((await regRes.json()) as any).data.booksList.length).toBeGreaterThanOrEqual(
      1,
    );

    const hitRes = await app.fetch(
      new Request("http://localhost/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          extensions: { persistedQuery: { version: 1, sha256Hash } },
        }),
      }),
    );
    expect(((await hitRes.json()) as any).data.booksList.length).toBeGreaterThanOrEqual(
      1,
    );

    // 5. Automatic HttpException -> Apollo error code mapping
    const httpErrCases: Array<[string, string, number?]> = [
      ["throwBadRequest", ApolloServerErrorCode.BAD_REQUEST],
      ["throwUnauthorized", "UNAUTHENTICATED"],
      ["throwForbidden", "FORBIDDEN"],
      ["throwUnprocessable", ApolloServerErrorCode.BAD_USER_INPUT],
      ["throwNotFound", ApolloServerErrorCode.INTERNAL_SERVER_ERROR, 404],
    ];
    for (const [field, expectedCode, expectedStatus] of httpErrCases) {
      const r = await app.fetch(
        new Request("http://localhost/graphql", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: `{ ${field} }` }),
        }),
      );
      // preserveHttpStatusForExecutionErrors defaults to true -> HTTP 200
      expect(r.status).toBe(200);
      const j = (await r.json()) as any;
      expect(j.errors[0].extensions.code).toBe(expectedCode);
      expect(j.errors[0].extensions.originalError).toBeDefined();
      if (expectedStatus !== undefined) {
        expect(j.errors[0].extensions.status).toBe(expectedStatus);
      }
    }
    expect(lifecycleLog).toContain("didEncounterErrors");

    // 6. Subscriptions over HTTP are rejected with 400 BAD_REQUEST
    const subReject = await server.executeOperation({
      query: `subscription { booksList { id } }`,
    });
    // Validation fails if no Subscription root type (400), which is expected
    expect(subReject.http.status).toBe(400);

    // 7. Graceful shutdown triggers serverWillStop
    await app.close();
    expect(lifecycleLog).toContain("serverWillStop");
  });

  test("ApolloDriver supports forRootAsync (useClass), CSRF prevention, disabled landing page, and ResolverDecoratorHost hooks", async () => {
    const reqHooks: string[] = [];

    @Injectable()
    class ApolloConfigService implements ApolloDriverConfigFactory {
      createGqlOptions(): ApolloDriverConfig {
        return {
          path: "/apollo-async",
          playground: false,
          csrfPrevention: true,
          typeDefs: `
            type Query { ping: String! }
            type Subscription { tick: String! }
          `,
          resolvers: {
            Query: { ping: () => "pong" },
            Subscription: {
              tick: {
                subscribe: async function* () {
                  yield { tick: "tock" };
                },
              },
            },
          },
        };
      }
    }

    @Module({
      imports: [
        GraphQLModule.forRootAsync<ApolloDriverConfig>({
          driver: ApolloDriver,
          path: "/apollo-async",
          useClass: ApolloConfigService,
        }),
      ],
    })
    class AsyncAppModule {}

    const app = await BunestFactory.create(AsyncAppModule, { logger: false });
    cleanups.push(() => app.close());
    await app.init();

    const decoratorHost = app.get(ResolverDecoratorHost);
    decoratorHost.setOnRequestStartHook((ctx) => {
      reqHooks.push(`start:${ctx.query?.trim()}`);
      return { id: "trace-1" };
    });
    decoratorHost.setOnRequestEndHook((ctx) => {
      reqHooks.push(`end:${(ctx.state as any).id}`);
    });

    // Playground disabled -> GET text/html returns 400
    const noHtml = await app.fetch(
      new Request("http://localhost/apollo-async", {
        method: "GET",
        headers: { accept: "text/html" },
      }),
    );
    expect(noHtml.status).toBe(400);

    // CSRF blocks GET query without preflight header
    const csrfBlocked = await app.fetch(
      new Request("http://localhost/apollo-async?query=%7Bping%7D", {
        method: "GET",
      }),
    );
    expect(csrfBlocked.status).toBe(400);

    // CSRF allows GET query with x-apollo-operation-name
    const csrfAllowed = await app.fetch(
      new Request("http://localhost/apollo-async?query=%7Bping%7D", {
        method: "GET",
        headers: { "x-apollo-operation-name": "Ping" },
      }),
    );
    expect(csrfAllowed.status).toBe(200);
    expect(await csrfAllowed.json()).toEqual({ data: { ping: "pong" } });
    expect(reqHooks).toEqual(["start:{ping}", "end:trace-1"]);

    // Reject subscription over HTTP with exact upstream message
    const subHttp = await app.fetch(
      new Request("http://localhost/apollo-async", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: `subscription { tick }` }),
      }),
    );
    expect(subHttp.status).toBe(400);
    const subJson = (await subHttp.json()) as any;
    expect(subJson.errors[0].message).toContain(
      "Subscription operations are not supported over HTTP",
    );
  });

  test("PluginsExplorerService rejects request/transient-scoped @Plugin() and getApolloServer throws when GraphQLModule is absent", async () => {
    @Plugin()
    class ScopedPlugin {}

    const explorer = new PluginsExplorerService();
    expect(() =>
      explorer.filterPlugins({
        instance: new ScopedPlugin(),
        scope: Scope.REQUEST,
        isDependencyTreeStatic: false,
      }),
    ).toThrow(/must be static \(singleton\)/);

    expect(() =>
      explorer.filterPlugins({
        instance: new ScopedPlugin(),
        scope: Scope.TRANSIENT,
        isDependencyTreeStatic: true,
      }),
    ).toThrow(/must be static \(singleton\)/);

    @Module({})
    class EmptyModule {}
    const emptyApp = await BunestFactory.create(EmptyModule, { logger: false });
    cleanups.push(() => emptyApp.close());
    expect(() => getApolloServer(emptyApp)).toThrow(/GraphQLModule/);
  });

  test("createApolloSchema, ApolloServerPluginLandingPageLocalDefault, ApolloFederationDefinitionsFactory, and subscriptionWithFilter", async () => {
    const schema = await createApolloSchema({
      typeDefs: `type Query { hello: String! }`,
      resolvers: { Query: { hello: () => "world" } },
    });
    const srv = new BunestApolloServer({
      schema,
      plugins: [ApolloServerPluginLandingPageLocalDefault({ title: "Custom Sandbox" })],
    });
    await srv.start();
    const htmlRes = await srv.handleHttpRequest(
      new Request("http://localhost/graphql", {
        method: "GET",
        headers: { accept: "text/html" },
      }),
    );
    expect(await htmlRes.text()).toContain("<title>Custom Sandbox</title>");
    await srv.stop();

    const fedDefs = new ApolloFederationDefinitionsFactory();
    expect(fedDefs).toBeInstanceOf(ApolloFederationDefinitionsFactory);

    const driver = new ApolloDriver();
    const filtered = driver.subscriptionWithFilter(
      { prefix: "ok" },
      function (this: { prefix: string }, payload: { tag: string }) {
        return payload.tag === this.prefix;
      },
      () =>
        async function* () {
          yield { tag: "skip" };
          yield { tag: "ok" };
        },
    );
    const iter = await filtered(undefined, {}, {}, {});
    const first = await iter.next();
    expect(first).toEqual({ value: { tag: "ok" }, done: false });
    const done = await iter.next();
    expect(done.done).toBe(true);
  });
});
