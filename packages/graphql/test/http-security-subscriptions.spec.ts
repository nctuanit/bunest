import { afterEach, describe, expect, test } from "bun:test";
import { Module } from "@bunest/core";
import { BunestFactory } from "@bunest/core";
import {
  Args,
  Field,
  GraphQLModule,
  GraphQLService,
  ID,
  Int,
  Mutation,
  ObjectType,
  PubSub,
  Query,
  Resolver,
  Subscription,
} from "../src/index";

@ObjectType()
class CategoryNode {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field(() => CategoryNode, { nullable: true })
  parent?: CategoryNode | null;
}

@ObjectType()
class MessageEvent {
  @Field(() => ID)
  id!: string;

  @Field()
  room!: string;

  @Field()
  text!: string;
}

describe("GraphQL Security Hardening, GraphiQL, Error Formatting & Live SSE Subscriptions", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      if (fn) {
        await fn().catch(() => {});
      }
    }
  });

  test("enforces maxDepth (including fragments), introspection toggle, GET query/mutation rules, GraphiQL UI, and production stack hiding", async () => {
    const rootCat: CategoryNode = { id: "1", name: "Root", parent: null };
    rootCat.parent = rootCat;

    @Resolver()
    class SecurityResolver {
      @Query(() => CategoryNode)
      category() {
        return rootCat;
      }

      @Query(() => String)
      boom() {
        throw new Error("TOP_SECRET_SQL_CREDENTIAL");
      }

      @Mutation(() => Int)
      bump() {
        return 1;
      }
    }

    @Module({
      imports: [
        GraphQLModule.forRoot({
          maxDepth: 2,
          introspection: false,
          playground: true,
        }),
      ],
      providers: [SecurityResolver],
    })
    class HardenedModule {}

    const app = await BunestFactory.create(HardenedModule, { logger: false });
    cleanups.push(() => app.close());

    // GraphiQL HTML on GET /graphql with Accept: text/html
    const uiRes = await app.fetch(
      new Request("http://localhost/graphql", {
        headers: { accept: "text/html" },
      }),
    );
    expect(uiRes.status).toBe(200);
    expect(uiRes.headers.get("content-type")).toContain("text/html");
    expect(await uiRes.text()).toContain("Bunest GraphQL Playground");

    // GET query works; GET mutation rejected with 405
    const getQueryRes = await app.fetch(
      new Request(
        `http://localhost/graphql?query=${encodeURIComponent("{ category { name } }")}`,
      ),
    );
    expect(getQueryRes.status).toBe(200);
    expect(await getQueryRes.json()).toEqual({
      data: { category: { name: "Root" } },
    });

    const getMutRes = await app.fetch(
      new Request(
        `http://localhost/graphql?query=${encodeURIComponent("mutation { bump }")}`,
      ),
    );
    expect(getMutRes.status).toBe(405);

    // Depth 2 allowed: category (1) -> name (2)
    const depth2 = await app.fetch(
      new Request("http://localhost/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "{ category { id name } }" }),
      }),
    );
    expect(depth2.status).toBe(200);
    expect(await depth2.json()).toEqual({
      data: { category: { id: "1", name: "Root" } },
    });

    // Depth 3 rejected: category (1) -> parent (2) -> name (3)
    const depth3 = await app.fetch(
      new Request("http://localhost/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "{ category { parent { name } } }" }),
      }),
    );
    expect(depth3.status).toBe(400);
    const depth3Json = (await depth3.json()) as {
      errors?: Array<{ extensions?: { code?: string; maxDepth?: number } }>;
    };
    expect(depth3Json.errors?.[0]?.extensions?.code).toBe(
      "QUERY_DEPTH_LIMIT_EXCEEDED",
    );
    expect(depth3Json.errors?.[0]?.extensions?.maxDepth).toBe(2);

    // Fragment spread depth bypass also rejected!
    const fragBypass = await app.fetch(
      new Request("http://localhost/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: `
            query { category { ...DeepFrag } }
            fragment DeepFrag on CategoryNode { parent { name } }
          `,
        }),
      }),
    );
    expect(fragBypass.status).toBe(400);
    const fragJson = (await fragBypass.json()) as {
      errors?: Array<{ extensions?: { code?: string } }>;
    };
    expect(fragJson.errors?.[0]?.extensions?.code).toBe(
      "QUERY_DEPTH_LIMIT_EXCEEDED",
    );

    // Introspection disabled -> __schema rejected with 400
    const introRes = await app.fetch(
      new Request("http://localhost/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "{ __schema { types { name } } }" }),
      }),
    );
    expect(introRes.status).toBe(400);
    const introJson = (await introRes.json()) as { errors?: unknown[] };
    expect(introJson.errors?.length).toBeGreaterThan(0);

    // Production mode hides internal error message & stack trace
    const prevNodeEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      const errRes = await app.fetch(
        new Request("http://localhost/graphql", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: "{ boom }" }),
        }),
      );
      const rawText = await errRes.text();
      expect(rawText).not.toContain("TOP_SECRET_SQL_CREDENTIAL");
      expect(rawText).not.toContain("stacktrace");
      const errJson = JSON.parse(rawText) as {
        errors?: Array<{
          message: string;
          extensions?: Record<string, unknown>;
        }>;
      };
      expect(errJson.errors?.[0]?.message).toBe("Internal server error");
      expect(errJson.errors?.[0]?.extensions?.stacktrace).toBeUndefined();
    } finally {
      if (prevNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = prevNodeEnv;
      }
    }
  });

  test("streams real-time @Subscription via PubSub (filter + resolve) over live SSE and cleans up on abort", async () => {
    const pubSub = new PubSub();

    @Resolver()
    class MessagesResolver {
      @Query(() => String)
      ping() {
        return "pong";
      }

      @Subscription(() => MessageEvent, {
        filter: (
          payload: { messageAdded: MessageEvent },
          variables: { room: string },
        ) => payload.messageAdded.room === variables.room,
        resolve: (payload: { messageAdded: MessageEvent }) => ({
          ...payload.messageAdded,
          text: payload.messageAdded.text.toUpperCase(),
        }),
      })
      messageAdded(@Args("room") _room: string) {
        return pubSub.asyncIterator<{ messageAdded: MessageEvent }>(
          "MESSAGE_ADDED",
        );
      }
    }

    @Module({
      imports: [GraphQLModule.forRoot()],
      providers: [MessagesResolver],
    })
    class SubModule {}

    const app = await BunestFactory.create(SubModule, { logger: false });
    const info = await app.listen({ port: 0, hostname: "127.0.0.1" });
    cleanups.push(() => app.close());

    // 1. Live HTTP SSE subscription over Bun.serve({ port: 0 })
    const abortController = new AbortController();
    const sseRes = await fetch(`http://127.0.0.1:${info.port}/graphql`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify({
        query: `subscription ($room: String!) { messageAdded(room: $room) { id room text } }`,
        variables: { room: "general" },
      }),
      signal: abortController.signal,
    });

    expect(sseRes.status).toBe(200);
    expect(sseRes.headers.get("content-type")).toContain("text/event-stream");
    expect(pubSub.listenerCount("MESSAGE_ADDED")).toBe(1);

    const reader = sseRes.body!.getReader();
    const decoder = new TextDecoder();

    // Publish event for OTHER room (must be filtered out) + event for "general" (must arrive uppercased!)
    await pubSub.publish("MESSAGE_ADDED", {
      messageAdded: { id: "m0", room: "private", text: "ignored" },
    });
    await pubSub.publish("MESSAGE_ADDED", {
      messageAdded: { id: "m1", room: "general", text: "hello world" },
    });

    let sseText = "";
    while (!sseText.includes("event: next")) {
      const chunk = await reader.read();
      expect(chunk.done).toBe(false);
      sseText += decoder.decode(chunk.value);
    }
    expect(sseText).toContain("event: next");
    expect(sseText).toContain('"id":"m1"');
    expect(sseText).toContain('"text":"HELLO WORLD"');
    expect(sseText).not.toContain("ignored");

    // Abort SSE stream -> PubSub listener MUST be cleaned up to 0
    abortController.abort();
    await reader.cancel().catch(() => {});
    await new Promise((r) => setTimeout(r, 60));
    expect(pubSub.listenerCount("MESSAGE_ADDED")).toBe(0);

    // 2. Programmatic subscribeQuery() + AbortSignal cleanup
    const gqlService = app.get(GraphQLService);
    const progAbort = new AbortController();
    const iter = await gqlService.subscribeQuery({
      query: `subscription { messageAdded(room: "dev") { id text } }`,
      signal: progAbort.signal,
    });
    expect(Symbol.asyncIterator in iter).toBe(true);
    expect(pubSub.listenerCount("MESSAGE_ADDED")).toBe(1);

    const asyncIter = iter as AsyncIterableIterator<{
      data?: Record<string, unknown> | null;
    }>;
    const nextPromise = asyncIter.next();
    await pubSub.publish("MESSAGE_ADDED", {
      messageAdded: { id: "m2", room: "dev", text: "hi dev" },
    });
    const received = await nextPromise;
    expect(received.done).toBe(false);
    expect(received.value).toEqual({
      data: { messageAdded: { id: "m2", text: "HI DEV" } },
    });

    progAbort.abort();
    await new Promise((r) => setTimeout(r, 20));
    expect(pubSub.listenerCount("MESSAGE_ADDED")).toBe(0);
  });

  test("disables playground and introspection by default in production", async () => {
    @Resolver()
    class ProdDefaultsResolver {
      @Query(() => String)
      hello() {
        return "world";
      }
    }

    @Module({
      imports: [GraphQLModule.forRoot()],
      providers: [ProdDefaultsResolver],
    })
    class ProdDefaultsModule {}

    const prevNodeEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";
      const app = await BunestFactory.create(ProdDefaultsModule, {
        logger: false,
      });
      cleanups.push(() => app.close());

      // Playground disabled by default in production
      const uiRes = await app.fetch(
        new Request("http://localhost/graphql", {
          headers: { accept: "text/html" },
        }),
      );
      expect(uiRes.status).toBe(400);

      // Introspection disabled by default in production
      const introRes = await app.fetch(
        new Request("http://localhost/graphql", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: "{ __schema { types { name } } }" }),
        }),
      );
      expect(introRes.status).toBe(400);

      // Normal query still executes cleanly
      const okRes = await app.fetch(
        new Request("http://localhost/graphql", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ query: "{ hello }" }),
        }),
      );
      expect(okRes.status).toBe(200);
      expect(await okRes.json()).toEqual({ data: { hello: "world" } });
    } finally {
      if (prevNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = prevNodeEnv;
      }
    }
  });

  test("rejects non-object JSON bodies (null/array/primitive), non-object variables, non-string operationName with 400, and resists 50-level fragment diamond DAG bombs in linear time", async () => {
    const rootCat: CategoryNode = { id: "1", name: "Root", parent: null };
    rootCat.parent = rootCat;

    @Resolver()
    class HardeningRegressionResolver {
      @Query(() => CategoryNode)
      category() {
        return rootCat;
      }
    }

    @Module({
      imports: [GraphQLModule.forRoot({ maxDepth: 2 })],
      providers: [HardeningRegressionResolver],
    })
    class RegressionModule {}

    const app = await BunestFactory.create(RegressionModule, { logger: false });
    cleanups.push(() => app.close());

    // 1. POST with JSON `null`, array, string, number bodies -> HTTP 400 (never 500)
    for (const badBody of ["null", "[]", '"hello"', "123"]) {
      const res = await app.fetch(
        new Request("http://localhost/graphql", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: badBody,
        }),
      );
      expect(res.status).toBe(400);
    }

    // 2. Non-object `variables` and non-string `operationName` on POST & GET -> HTTP 400
    for (const badVars of ["str", 123, [1, 2], true]) {
      const postRes = await app.fetch(
        new Request("http://localhost/graphql", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            query: "{ category { id } }",
            variables: badVars,
          }),
        }),
      );
      expect(postRes.status).toBe(400);

      const getRes = await app.fetch(
        new Request(
          `http://localhost/graphql?query=${encodeURIComponent("{ category { id } }")}&variables=${encodeURIComponent(JSON.stringify(badVars))}`,
        ),
      );
      expect(getRes.status).toBe(400);
    }

    const badOpNameRes = await app.fetch(
      new Request("http://localhost/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: "{ category { id } }",
          operationName: 42,
        }),
      }),
    );
    expect(badOpNameRes.status).toBe(400);

    // Explicit `variables: null` and `operationName: null` remain valid per GraphQL-over-HTTP spec
    const nullOptionalsRes = await app.fetch(
      new Request("http://localhost/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: "{ category { id } }",
          variables: null,
          operationName: null,
        }),
      }),
    );
    expect(nullOptionalsRes.status).toBe(200);
    expect(await nullOptionalsRes.json()).toEqual({
      data: { category: { id: "1" } },
    });

    // 3. 50-level fragment diamond DAG bomb (2^50 paths) MUST resolve in linear O(V+E) time (<100ms)
    const levels = 50;
    const fragLines: string[] = [];
    for (let i = 1; i < levels; i++) {
      fragLines.push(
        `fragment F${i} on CategoryNode { ...F${i + 1} ...F${i + 1} }`,
      );
    }
    fragLines.push(`fragment F${levels} on CategoryNode { parent { name } }`);
    const dagBombQuery = `query { category { ...F1 } }\n${fragLines.join("\n")}`;

    const startedAt = performance.now();
    const bombRes = await app.fetch(
      new Request("http://localhost/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: dagBombQuery }),
      }),
    );
    const elapsedMs = performance.now() - startedAt;

    expect(bombRes.status).toBe(400);
    expect(elapsedMs).toBeLessThan(150);
    const bombJson = (await bombRes.json()) as {
      errors?: Array<{ extensions?: { code?: string; depth?: number } }>;
    };
    expect(bombJson.errors?.[0]?.extensions?.code).toBe(
      "QUERY_DEPTH_LIMIT_EXCEEDED",
    );
    expect(bombJson.errors?.[0]?.extensions?.depth).toBe(3);
  });
});
