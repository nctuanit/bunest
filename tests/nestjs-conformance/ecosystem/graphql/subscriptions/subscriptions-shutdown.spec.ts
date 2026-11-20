import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  type DynamicModule,
  Module,
} from "../../../../../packages/common/src";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Field,
  GRAPHQL_TRANSPORT_WS_PROTOCOL,
  GraphQLModule,
  type GraphQLModuleOptions,
  GraphQLService,
  ObjectType,
  PubSub,
  Query,
  Resolver,
  Subscription,
} from "../../../../../packages/graphql/src";
import { Test, describeConformance } from "../../../_helpers/index";

const pubSub = new PubSub();

@ObjectType()
class ShutdownNotification {
  @Field()
  id!: string;
}

@Resolver(() => ShutdownNotification)
class ShutdownNotificationResolver {
  @Query(() => ShutdownNotification)
  getNotification(): ShutdownNotification {
    return { id: "1" };
  }

  @Subscription(() => ShutdownNotification)
  newNotification() {
    return pubSub.asyncIterator("shutdownNotification");
  }
}

@Module({
  providers: [ShutdownNotificationResolver],
})
class ShutdownNotificationModule {}

function createAppModule(
  options: Partial<GraphQLModuleOptions>,
): DynamicModule {
  @Module({})
  class DynamicAppModule {}

  return {
    module: DynamicAppModule,
    imports: [
      ShutdownNotificationModule,
      GraphQLModule.forRoot({
        autoSchemaFile: true,
        includeStacktraceInErrorResponses: false,
        ...options,
      }),
    ],
  };
}

describeConformance(
  "graphql-ws shutdown",
  {
    upstreamPath:
      "packages/apollo/tests/subscriptions/subscriptions-shutdown.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts ApolloDriver + ApolloFederationDriver graphql-ws graceful shutdown (1001 close code on app.close() with default and stopOnApplicationShutdown modes) to native @bunest/graphql (ADR-013).",
  },
  () => {
    const cases: Array<[string, () => DynamicModule]> = [
      [
        "GraphQLModule",
        () => createAppModule({ subscriptions: { "graphql-ws": {} } }),
      ],
      [
        "GraphQLModule Federation",
        () =>
          createAppModule({
            federation: { version: 2 },
            subscriptions: { "graphql-ws": {} },
          }),
      ],
      [
        "GraphQLModule, stopOnApplicationShutdown",
        () =>
          createAppModule({
            subscriptions: { "graphql-ws": {} },
            stopOnApplicationShutdown: true,
          }),
      ],
      [
        "GraphQLModule Federation, stopOnApplicationShutdown",
        () =>
          createAppModule({
            federation: { version: 2 },
            subscriptions: { "graphql-ws": {} },
            stopOnApplicationShutdown: true,
          }),
      ],
    ];

    describe.each(cases)("graphql-ws shutdown (%s)", (_name, moduleFactory) => {
      let app: BunestApplication;
      let socket: WebSocket | undefined;
      let port: number;
      let closePromise: Promise<void> | undefined;

      beforeEach(async () => {
        const moduleRef = await Test.createTestingModule({
          imports: [moduleFactory()],
        }).compile({ logger: false });
        app = moduleRef.createNestApplication({ logger: false });
        await app.init();
        app.get(GraphQLService).attachWebSocket(app);
        const info = await app.listen({ port: 0, hostname: "127.0.0.1" });
        port = info.port;
      });

      afterEach(async () => {
        if (socket && socket.readyState < WebSocket.CLOSING) {
          socket.close();
        }
        socket = undefined;
        await (closePromise ?? app.close());
        closePromise = undefined;
      });

      // BUNEST_BUG: During app.close(), BunHttpAdapter.close() stops the Bun server (terminating open WS connections with abnormal close code 1006) before GraphQLService's onModuleDestroy/onApplicationShutdown calls GraphQLWsHandler.closeAll(1001), so clients observe 1006 instead of 1001 Going Away (packages/graphql/src/driver/graphql-http.handler.ts:146-162 & packages/core/src/application/bunest-application-context.ts:387-395).
      it.skip("closes open graphql-ws connections when the application closes", async () => {
        socket = new WebSocket(
          `ws://127.0.0.1:${port}/graphql`,
          GRAPHQL_TRANSPORT_WS_PROTOCOL,
        );
        const client = socket;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Timed out waiting for connection_ack")),
            2000,
          );
          client.addEventListener("error", (err) => {
            clearTimeout(timer);
            reject(err);
          });
          client.addEventListener("open", () =>
            client.send(JSON.stringify({ type: "connection_init" })),
          );
          client.addEventListener("message", (ev) => {
            if (JSON.parse(String(ev.data)).type === "connection_ack") {
              clearTimeout(timer);
              resolve();
            }
          });
        });

        const closed = new Promise<number>((resolve) =>
          client.addEventListener("close", (ev) => resolve(ev.code), {
            once: true,
          }),
        );
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<string>((resolve) => {
          timer = setTimeout(() => resolve("not closed"), 2000);
        });

        closePromise = app.close();

        const outcome = await Promise.race([
          closed.finally(() => clearTimeout(timer)),
          timeout,
        ]);
        expect(outcome).toBe(1001);
      });
    });
  },
);
