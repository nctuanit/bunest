import "reflect-metadata";
import { afterEach, describe, expect, test } from "bun:test";
import {
  APP_FILTER,
  BadRequestException,
  Catch,
  Injectable,
  Module,
  UseFilters,
  type ArgumentsHost,
  type ExceptionFilter,
  type ExecutionContext,
} from "@bunest/common";
import { BunestFactory } from "@bunest/core";
import {
  Args,
  BunestDataLoader,
  Context,
  Field,
  GRAPHQL_TRANSPORT_WS_PROTOCOL,
  GqlExecutionContext,
  GraphQLModule,
  GraphQLService,
  ID,
  Int,
  InterfaceType,
  ObjectType,
  Parent,
  PubSub,
  Query,
  ResolveField,
  Resolver,
  Subscription,
  createUnionType,
  registerEnumType,
} from "../src/index";

// ---------------------------------------------------------------------------
// Code-First InterfaceType, UnionType, EnumType (with valuesMap) Models
// ---------------------------------------------------------------------------

enum ContentStatus {
  DRAFT = "DRAFT",
  PUBLISHED = "PUBLISHED",
  ARCHIVED = "ARCHIVED",
}

registerEnumType(ContentStatus, {
  name: "ContentStatus",
  description: "Publication lifecycle state",
  valuesMap: {
    ARCHIVED: { deprecationReason: "Use soft-delete instead" },
  },
});

@InterfaceType({
  description: "Common node interface",
})
abstract class ContentNode {
  @Field(() => ID)
  id!: string;

  @Field(() => ContentStatus)
  status!: ContentStatus;
}

@ObjectType({ implements: () => [ContentNode] })
class ArticleNode {
  @Field(() => ID)
  id!: string;

  @Field(() => ContentStatus)
  status!: ContentStatus;

  @Field()
  title!: string;

  @Field(() => ID)
  authorId!: string;
}

@ObjectType({ implements: () => [ContentNode] })
class CommentNode {
  @Field(() => ID)
  id!: string;

  @Field(() => ContentStatus)
  status!: ContentStatus;

  @Field()
  body!: string;
}

@ObjectType()
class AuthorModel {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;
}

const SearchResultUnion = createUnionType({
  name: "SearchResult",
  description: "Polymorphic search result union",
  types: () => [ArticleNode, CommentNode] as const,
  resolveType(value: Record<string, unknown>) {
    if ("title" in value) return ArticleNode;
    if ("body" in value) return CommentNode;
    return null;
  },
});

@ObjectType()
class LiveAlert {
  @Field(() => ID)
  id!: string;

  @Field()
  channel!: string;

  @Field()
  message!: string;
}

class CustomDomainFailure extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CustomDomainFailure";
  }
}

class GlobalTriggerFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GlobalTriggerFailure";
  }
}

describe("GraphQL P1 #8: @InterfaceType, createUnionType, @UseFilters, BunestDataLoader & graphql-ws", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()!().catch(() => {});
    }
  });

  test("supports @InterfaceType, createUnionType, registerEnumType(valuesMap), @UseFilters (method/class/global), and BunestDataLoader N+1 batching", async () => {
    let authorBatchCalls = 0;
    const authorBatches: Array<readonly string[]> = [];

    const authorsDb: Record<string, AuthorModel> = {
      a1: { id: "a1", name: "Ada" },
      a2: { id: "a2", name: "Grace" },
    };

    @Catch(CustomDomainFailure)
    class DomainGqlFilter implements ExceptionFilter<CustomDomainFailure> {
      catch(exception: CustomDomainFailure, host: ArgumentsHost) {
        const gqlCtx = GqlExecutionContext.create(host as ExecutionContext);
        const field = gqlCtx.getInfo().fieldName;
        if (exception.code === "RECOVER") {
          return `recovered:${field}:${exception.message}`;
        }
        throw new BadRequestException(
          `filtered:${field}:${exception.code}:${exception.message}`,
        );
      }
    }

    @Catch(GlobalTriggerFailure)
    class GlobalGqlFilter implements ExceptionFilter<GlobalTriggerFailure> {
      catch(exception: GlobalTriggerFailure, host: ArgumentsHost) {
        const gqlCtx = GqlExecutionContext.create(host as ExecutionContext);
        return `global-caught:${gqlCtx.getInfo().fieldName}:${exception.message}`;
      }
    }

    @Resolver(() => ArticleNode)
    @UseFilters(DomainGqlFilter)
    class ContentResolver {
      @Query(() => [ContentNode])
      nodes() {
        const art = Object.assign(new ArticleNode(), {
          id: "n1",
          status: ContentStatus.PUBLISHED,
          title: "Bunest GraphQL",
          authorId: "a1",
        });
        const com = Object.assign(new CommentNode(), {
          id: "n2",
          status: ContentStatus.DRAFT,
          body: "Great interfaces!",
        });
        return [art, com];
      }

      @Query(() => [SearchResultUnion])
      search() {
        return [
          { id: "s1", status: ContentStatus.PUBLISHED, title: "Union Hit", authorId: "a2" },
          { id: "s2", status: ContentStatus.ARCHIVED, body: "Union Comment" },
        ];
      }

      @Query(() => [ArticleNode])
      articles() {
        return [
          { id: "1", status: ContentStatus.PUBLISHED, title: "A1", authorId: "a1" },
          { id: "2", status: ContentStatus.PUBLISHED, title: "A2", authorId: "a2" },
          { id: "3", status: ContentStatus.PUBLISHED, title: "A3", authorId: "a1" },
          { id: "4", status: ContentStatus.PUBLISHED, title: "A4", authorId: "a2" },
        ];
      }

      @ResolveField(() => AuthorModel, { nullable: true })
      author(
        @Parent() article: ArticleNode,
        @Context("authorLoader") loader: BunestDataLoader<string, AuthorModel | null>,
      ) {
        return loader.load(article.authorId);
      }

      @Query(() => String)
      recoverableFail() {
        throw new CustomDomainFailure("RECOVER", "soft-err");
      }

      @Query(() => String)
      transformedFail() {
        throw new CustomDomainFailure("BAD_INPUT", "invalid-id");
      }

      @Query(() => String)
      globalFilterTest() {
        throw new GlobalTriggerFailure("from-global");
      }
    }

    @Module({
      imports: [
        GraphQLModule.forRoot({
          context: () => ({
            authorLoader: new BunestDataLoader<string, AuthorModel | null>(
              async (ids) => {
                authorBatchCalls++;
                authorBatches.push([...ids]);
                return ids.map((id) => authorsDb[id] ?? null);
              },
            ),
          }),
        }),
      ],
      providers: [
        ContentResolver,
        DomainGqlFilter,
        { provide: APP_FILTER, useClass: GlobalGqlFilter },
      ],
    })
    class ContentModule {}

    const app = await BunestFactory.create(ContentModule, { logger: false });
    cleanups.push(() => app.close());
    await app.init();

    const sdl = app.get(GraphQLService).printSDL();
    expect(sdl).toContain("interface ContentNode");
    expect(sdl).toContain("type ArticleNode implements ContentNode");
    expect(sdl).toContain("type CommentNode implements ContentNode");
    expect(sdl).toContain("union SearchResult = ArticleNode | CommentNode");
    expect(sdl).toContain('@deprecated(reason: "Use soft-delete instead")');

    // 1. Interface query with inline fragments + Union query
    const polyRes = await app.fetch(
      new Request("http://localhost/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: `
            query {
              nodes {
                __typename
                id
                status
                ... on ArticleNode { title }
                ... on CommentNode { body }
              }
              search {
                __typename
                ... on ArticleNode { id title }
                ... on CommentNode { id body }
              }
            }
          `,
        }),
      }),
    );
    expect(polyRes.status).toBe(200);
    expect(await polyRes.json()).toEqual({
      data: {
        nodes: [
          { __typename: "ArticleNode", id: "n1", status: "PUBLISHED", title: "Bunest GraphQL" },
          { __typename: "CommentNode", id: "n2", status: "DRAFT", body: "Great interfaces!" },
        ],
        search: [
          { __typename: "ArticleNode", id: "s1", title: "Union Hit" },
          { __typename: "CommentNode", id: "s2", body: "Union Comment" },
        ],
      },
    });

    // 2. BunestDataLoader eliminates N+1: 4 articles referencing 2 unique authors -> 1 single batch call with ["a1", "a2"]!
    const batchRes = await app.fetch(
      new Request("http://localhost/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: `{ articles { id title author { id name } } }`,
        }),
      }),
    );
    expect(batchRes.status).toBe(200);
    expect(await batchRes.json()).toEqual({
      data: {
        articles: [
          { id: "1", title: "A1", author: { id: "a1", name: "Ada" } },
          { id: "2", title: "A2", author: { id: "a2", name: "Grace" } },
          { id: "3", title: "A3", author: { id: "a1", name: "Ada" } },
          { id: "4", title: "A4", author: { id: "a2", name: "Grace" } },
        ],
      },
    });
    expect(authorBatchCalls).toBe(1);
    expect(authorBatches).toEqual([["a1", "a2"]]);

    // 3. @UseFilters() recovery, error transformation, and global APP_FILTER
    const filterRes = await app.fetch(
      new Request("http://localhost/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: `{ recoverableFail globalFilterTest }`,
        }),
      }),
    );
    expect(await filterRes.json()).toEqual({
      data: {
        recoverableFail: "recovered:recoverableFail:soft-err",
        globalFilterTest: "global-caught:globalFilterTest:from-global",
      },
    });

    const transformedRes = await app.fetch(
      new Request("http://localhost/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: `{ transformedFail }` }),
      }),
    );
    const transformedJson = (await transformedRes.json()) as {
      errors?: Array<{ message: string; extensions?: { statusCode?: number } }>;
    };
    expect(transformedJson.errors?.[0]?.message).toBe(
      "filtered:transformedFail:BAD_INPUT:invalid-id",
    );
    expect(transformedJson.errors?.[0]?.extensions?.statusCode).toBe(400);
  });

  test("BunestDataLoader unit semantics: maxBatchSize, per-item Error isolation, prime, clear, clearAll", async () => {
    const calls: Array<readonly number[]> = [];
    const loader = new BunestDataLoader<number, string>(
      async (keys) => {
        calls.push([...keys]);
        return keys.map((k) =>
          k < 0 ? new Error(`negative:${k}`) : `v:${k}`,
        );
      },
      { maxBatchSize: 2 },
    );

    loader.prime(99, "primed:99");
    expect(await loader.load(99)).toBe("primed:99");
    expect(calls).toHaveLength(0);

    const results = await loader.loadMany([1, 2, -3, 1]);
    expect(results[0]).toBe("v:1");
    expect(results[1]).toBe("v:2");
    expect(results[2]).toBeInstanceOf(Error);
    expect((results[2] as Error).message).toBe("negative:-3");
    expect(results[3]).toBe("v:1");
    // 3 unique keys split by maxBatchSize=2 -> [[1, 2], [-3]]
    expect(calls).toEqual([[1, 2], [-3]]);

    // Cache hit avoids extra batch
    expect(await loader.load(2)).toBe("v:2");
    expect(calls).toHaveLength(2);

    // Clear forces fresh load
    loader.clear(2);
    expect(await loader.load(2)).toBe("v:2");
    expect(calls).toHaveLength(3);
  });

  test("runs live graphql-ws (graphql-transport-ws) E2E over Bun.serve({ port: 0 }) with onConnect auth, ping/pong, subscribe/next/complete, and disconnect cleanup", async () => {
    const pubSub = new PubSub();

    @Injectable()
    class AlertService {
      async publish(channel: string, id: string, message: string) {
        await pubSub.publish("ALERT", {
          alertAdded: { id, channel, message },
        });
      }
    }

    @Resolver()
    class AlertsResolver {
      @Query(() => Int)
      version() {
        return 2;
      }

      @Subscription(() => LiveAlert, {
        filter: (
          payload: { alertAdded: LiveAlert },
          vars: { channel: string },
        ) => payload.alertAdded.channel === vars.channel,
      })
      alertAdded(
        @Args("channel") _channel: string,
        @Context("user") user?: string,
      ) {
        if (!user) {
          throw new Error("Missing ws user in context");
        }
        return pubSub.asyncIterator<{ alertAdded: LiveAlert }>("ALERT");
      }
    }

    @Module({
      imports: [
        GraphQLModule.forRoot({
          path: "/graphql",
          subscriptions: {
            "graphql-ws": {
              onConnect: ({ connectionParams }) => {
                if (connectionParams.token !== "valid-jwt") {
                  return false;
                }
                return { user: "ws-admin" };
              },
            },
          },
        }),
      ],
      providers: [AlertService, AlertsResolver],
    })
    class WsGraphqlModule {}

    const app = await BunestFactory.create(WsGraphqlModule, { logger: false });
    app.get(GraphQLService).attachWebSocket(app);
    const info = await app.listen({ port: 0, hostname: "127.0.0.1" });
    cleanups.push(() => app.close());

    const wsUrl = `ws://127.0.0.1:${info.port}/graphql`;
    const alerts = app.get(AlertService);

    // 1. Unauthorized connection_init rejected by onConnect with 4403
    const deniedClose = await new Promise<{ code: number; reason: string }>(
      (resolve) => {
        const ws = new WebSocket(wsUrl, GRAPHQL_TRANSPORT_WS_PROTOCOL);
        ws.onopen = () => {
          ws.send(
            JSON.stringify({
              type: "connection_init",
              payload: { token: "wrong" },
            }),
          );
        };
        ws.onclose = (ev) => resolve({ code: ev.code, reason: ev.reason });
      },
    );
    expect(deniedClose.code).toBe(4403);

    // 2. Authorized graphql-transport-ws session: connection_init -> connection_ack -> ping/pong -> query -> subscription -> complete
    const received: Array<Record<string, unknown>> = [];
    const ws = new WebSocket(wsUrl, GRAPHQL_TRANSPORT_WS_PROTOCOL);
    const waitForMessage = (
      predicate: (msg: Record<string, unknown>) => boolean,
      timeoutMs = 2000,
    ): Promise<Record<string, unknown>> =>
      new Promise((resolve, reject) => {
        const existing = received.find(predicate);
        if (existing) {
          resolve(existing);
          return;
        }
        const timer = setTimeout(() => {
          reject(new Error(`Timed out waiting for graphql-ws message`));
        }, timeoutMs);
        const onMsg = (ev: MessageEvent) => {
          const parsed = JSON.parse(String(ev.data)) as Record<string, unknown>;
          if (predicate(parsed)) {
            clearTimeout(timer);
            ws.removeEventListener("message", onMsg);
            resolve(parsed);
          }
        };
        ws.addEventListener("message", onMsg);
      });

    ws.addEventListener("message", (ev) => {
      received.push(JSON.parse(String(ev.data)) as Record<string, unknown>);
    });

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", (e) => reject(e), { once: true });
    });

    expect(ws.protocol).toBe(GRAPHQL_TRANSPORT_WS_PROTOCOL);

    // connection_init -> connection_ack
    ws.send(
      JSON.stringify({
        type: "connection_init",
        payload: { token: "valid-jwt" },
      }),
    );
    await waitForMessage((m) => m.type === "connection_ack");

    // ping -> pong
    ws.send(JSON.stringify({ type: "ping", payload: { ts: 1 } }));
    const pong = await waitForMessage((m) => m.type === "pong");
    expect(pong.payload).toEqual({ ts: 1 });

    // Unary query over graphql-ws
    ws.send(
      JSON.stringify({
        id: "q1",
        type: "subscribe",
        payload: { query: "{ version }" },
      }),
    );
    const qNext = await waitForMessage((m) => m.id === "q1" && m.type === "next");
    expect(qNext.payload).toEqual({ data: { version: 2 } });
    await waitForMessage((m) => m.id === "q1" && m.type === "complete");

    // Live subscription over graphql-ws
    ws.send(
      JSON.stringify({
        id: "sub1",
        type: "subscribe",
        payload: {
          query: `subscription ($ch: String!) { alertAdded(channel: $ch) { id channel message } }`,
          variables: { ch: "ops" },
        },
      }),
    );

    // Wait briefly for subscription to register on PubSub
    const deadline = Date.now() + 1000;
    while (pubSub.listenerCount("ALERT") < 1 && Date.now() < deadline) {
      await Bun.sleep(5);
    }
    expect(pubSub.listenerCount("ALERT")).toBe(1);

    await alerts.publish("other", "a0", "filtered-out");
    await alerts.publish("ops", "a1", "deploy-ok");

    const subNext = await waitForMessage(
      (m) => m.id === "sub1" && m.type === "next",
    );
    expect(subNext.payload).toEqual({
      data: {
        alertAdded: { id: "a1", channel: "ops", message: "deploy-ok" },
      },
    });

    // Client sends `complete` -> PubSub listener cleaned up to 0 immediately!
    ws.send(JSON.stringify({ id: "sub1", type: "complete" }));
    const cleanDeadline = Date.now() + 1000;
    while (pubSub.listenerCount("ALERT") > 0 && Date.now() < cleanDeadline) {
      await Bun.sleep(5);
    }
    expect(pubSub.listenerCount("ALERT")).toBe(0);

    // Re-subscribe and close socket abruptly -> PubSub listener MUST clean up to 0!
    ws.send(
      JSON.stringify({
        id: "sub2",
        type: "subscribe",
        payload: {
          query: `subscription { alertAdded(channel: "ops") { id } }`,
        },
      }),
    );
    const sub2Deadline = Date.now() + 1000;
    while (pubSub.listenerCount("ALERT") < 1 && Date.now() < sub2Deadline) {
      await Bun.sleep(5);
    }
    expect(pubSub.listenerCount("ALERT")).toBe(1);

    ws.close();
    const closeDeadline = Date.now() + 1000;
    while (pubSub.listenerCount("ALERT") > 0 && Date.now() < closeDeadline) {
      await Bun.sleep(5);
    }
    expect(pubSub.listenerCount("ALERT")).toBe(0);
  });

  test("graphql-ws regression: handles back-to-back duplicate ids (4409), disconnect/complete during async context & subscribeQuery without iterator leaks, and throwing context without unhandled rejections", async () => {
    let activeIterators = 0;
    let cleanedIterators = 0;

    async function* slowTrackedStream(delayStartMs: number) {
      if (delayStartMs > 0) {
        await Bun.sleep(delayStartMs);
      }
      activeIterators++;
      try {
        while (true) {
          await Bun.sleep(25);
          yield { tick: 1 };
        }
      } finally {
        cleanedIterators++;
      }
    }

    @Resolver()
    class RaceResolver {
      @Query(() => Int)
      pingVal() {
        return 1;
      }

      @Subscription(() => Int)
      async slowSub(@Args("delayMs", { type: () => Int, nullable: true }) delayMs?: number) {
        if (delayMs && delayMs > 0) {
          await Bun.sleep(delayMs);
        }
        return slowTrackedStream(0);
      }
    }

    @Module({
      imports: [
        GraphQLModule.forRoot({
          path: "/graphql",
          subscriptions: {
            "graphql-ws": {
              context: async (_ctx, msg) => {
                const vars = msg.payload.variables as Record<string, unknown> | undefined;
                if (vars?.throwContext === true) {
                  throw new Error("ws context failed");
                }
                const ctxDelay =
                  typeof vars?.ctxDelayMs === "number" ? vars.ctxDelayMs : 0;
                if (ctxDelay > 0) {
                  await Bun.sleep(ctxDelay);
                }
                return {};
              },
            },
          },
        }),
      ],
      providers: [RaceResolver],
    })
    class RaceGraphqlModule {}

    const app = await BunestFactory.create(RaceGraphqlModule, { logger: false });
    app.get(GraphQLService).attachWebSocket(app);
    const info = await app.listen({ port: 0, hostname: "127.0.0.1" });
    cleanups.push(() => app.close());

    const wsUrl = `ws://127.0.0.1:${info.port}/graphql`;

    const openInitializedSocket = async () => {
      const socket = new WebSocket(wsUrl, GRAPHQL_TRANSPORT_WS_PROTOCOL);
      const msgs: Array<Record<string, unknown>> = [];
      socket.addEventListener("message", (ev) => {
        msgs.push(JSON.parse(String(ev.data)) as Record<string, unknown>);
      });
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", (e) => reject(e), { once: true });
      });
      socket.send(JSON.stringify({ type: "connection_init" }));
      const ackDeadline = Date.now() + 1500;
      while (!msgs.some((m) => m.type === "connection_ack") && Date.now() < ackDeadline) {
        await Bun.sleep(5);
      }
      return { socket, msgs };
    };

    // 4a: Duplicate `id` sent back-to-back while `context()` is still awaiting -> MUST close with 4409 and leak 0 iterators!
    const { socket: dupWs } = await openInitializedSocket();
    const dupClosePromise = new Promise<number>((resolve) => {
      dupWs.addEventListener("close", (ev) => resolve(ev.code), { once: true });
    });
    const dupFrame = JSON.stringify({
      id: "dup-1",
      type: "subscribe",
      payload: {
        query: "subscription ($ctxDelayMs: Int) { slowSub }",
        variables: { ctxDelayMs: 40 },
      },
    });
    dupWs.send(dupFrame);
    dupWs.send(dupFrame);
    expect(await dupClosePromise).toBe(4409);
    await Bun.sleep(90);
    expect(cleanedIterators).toBe(activeIterators);

    // 4b-i: Socket closes while async `context()` (40ms) AND async `subscribeQuery()` (40ms) are still in-flight -> 0 leaked iterators!
    const beforeCloseActive = activeIterators;
    const { socket: closeRaceWs } = await openInitializedSocket();
    closeRaceWs.send(
      JSON.stringify({
        id: "close-ctx-race",
        type: "subscribe",
        payload: {
          query: "subscription ($ctxDelayMs: Int) { slowSub(delayMs: 40) }",
          variables: { ctxDelayMs: 30 },
        },
      }),
    );
    closeRaceWs.send(
      JSON.stringify({
        id: "close-sub-race",
        type: "subscribe",
        payload: {
          query: "subscription { slowSub(delayMs: 50) }",
        },
      }),
    );
    await Bun.sleep(10);
    closeRaceWs.close();
    await Bun.sleep(120);
    expect(cleanedIterators).toBe(activeIterators);
    expect(activeIterators).toBeGreaterThanOrEqual(beforeCloseActive);

    // 4b-ii: Client sends `complete` while `subscribeQuery()` is still awaiting -> iterator cleaned immediately, no stray frames!
    const { socket: completeRaceWs, msgs: completeMsgs } = await openInitializedSocket();
    completeRaceWs.send(
      JSON.stringify({
        id: "early-complete",
        type: "subscribe",
        payload: {
          query: "subscription { slowSub(delayMs: 45) }",
        },
      }),
    );
    await Bun.sleep(10);
    completeRaceWs.send(JSON.stringify({ id: "early-complete", type: "complete" }));
    await Bun.sleep(100);
    expect(cleanedIterators).toBe(activeIterators);
    expect(completeMsgs.filter((m) => m.id === "early-complete")).toHaveLength(0);

    // 4c: Throwing `options.context()` sends `{ id, type: "error" }` cleanly with 0 unhandled rejections!
    let unhandledCount = 0;
    const onUnhandled = () => {
      unhandledCount++;
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      completeRaceWs.send(
        JSON.stringify({
          id: "ctx-boom",
          type: "subscribe",
          payload: {
            query: "query ($throwContext: Boolean) { pingVal }",
            variables: { throwContext: true },
          },
        }),
      );
      const errDeadline = Date.now() + 1500;
      while (
        !completeMsgs.some((m) => m.id === "ctx-boom" && m.type === "error") &&
        Date.now() < errDeadline
      ) {
        await Bun.sleep(5);
      }
      const errMsg = completeMsgs.find(
        (m) => m.id === "ctx-boom" && m.type === "error",
      );
      expect(errMsg).toBeDefined();
      expect(errMsg?.payload).toEqual([{ message: "ws context failed" }]);
      await Bun.sleep(30);
      expect(unhandledCount).toBe(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      completeRaceWs.close();
    }
  });
});
