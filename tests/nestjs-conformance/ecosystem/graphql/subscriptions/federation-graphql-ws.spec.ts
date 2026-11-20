import "reflect-metadata";
import { afterEach, beforeEach, expect, it } from "bun:test";
import {
  type DynamicModule,
  Module,
} from "../../../../../packages/common/src";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Args,
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
import { Test, describeConformance, request } from "../../../_helpers/index";

const pubSub = new PubSub();

@ObjectType()
class Notification {
  @Field({ nullable: false })
  id!: string;

  @Field({ nullable: false })
  recipient!: string;

  @Field({ nullable: false })
  message!: string;
}

@Resolver(() => Notification)
class NotificationResolver {
  @Query(() => Notification)
  getFederatedNotification(): Notification {
    return { id: "0", recipient: "system", message: "ok" };
  }

  @Subscription(() => Notification, {
    filter(
      payload: { newFederatedNotification: Notification },
      variables: { id: string; recipient: string },
    ) {
      return (
        payload.newFederatedNotification.id === variables.id &&
        payload.newFederatedNotification.recipient === variables.recipient
      );
    },
  })
  newFederatedNotification(
    @Args("id", { nullable: false }) _id: string,
    @Args("recipient", { nullable: false }) _recipient: string,
  ) {
    return pubSub.asyncIterator("newFederatedNotification");
  }
}

@Module({
  providers: [NotificationResolver],
})
class NotificationModule {}

type FederationAppModuleConfig = {
  subscriptions?: GraphQLModuleOptions["subscriptions"];
  stopOnApplicationShutdown?: boolean;
};

@Module({})
class FederationAppModule {
  static forRoot(options?: FederationAppModuleConfig): DynamicModule {
    return {
      module: FederationAppModule,
      imports: [
        NotificationModule,
        GraphQLModule.forRoot({
          federation: { version: 2 },
          autoSchemaFile: true,
          includeStacktraceInErrorResponses: false,
          subscriptions: options?.subscriptions,
          stopOnApplicationShutdown: options?.stopOnApplicationShutdown,
        }),
      ],
    };
  }
}

const subscriptionQuery = `
  subscription FederatedSubscription($id: String!, $recipient: String!) {
    newFederatedNotification(id: $id, recipient: $recipient) {
      id
      recipient
      message
    }
  }
`;

describeConformance(
  "GraphQL Federation - graphql-ws subscriptions",
  {
    upstreamPath:
      "packages/apollo/tests/subscriptions/federation-graphql-ws.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts ApolloFederationDriver + graphql-ws client E2E to native @bunest/graphql Federation Subgraph and Bun native WebSocket (graphql-transport-ws, ADR-013).",
  },
  () => {
    let app: BunestApplication;
    let ws: WebSocket | undefined;
    let port: number;

    beforeEach(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [
          FederationAppModule.forRoot({
            subscriptions: { "graphql-ws": {} },
          }),
        ],
      }).compile({ logger: false });

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
      app.get(GraphQLService).attachWebSocket(app);
      const info = await app.listen({ port: 0, hostname: "127.0.0.1" });
      port = info.port;
    });

    afterEach(async () => {
      if (ws && ws.readyState < WebSocket.CLOSING) {
        ws.close();
      }
      ws = undefined;
      await app.close();
    });

    it("should connect and receive a filtered notification", async () => {
      ws = new WebSocket(
        `ws://127.0.0.1:${port}/graphql`,
        GRAPHQL_TRANSPORT_WS_PROTOCOL,
      );
      const socket = ws;

      const publishNotifications = () => {
        void pubSub.publish("newFederatedNotification", {
          newFederatedNotification: {
            id: "99",
            recipient: "alice",
            message: "wrong id",
          },
        });
        void pubSub.publish("newFederatedNotification", {
          newFederatedNotification: {
            id: "1",
            recipient: "bob",
            message: "wrong recipient",
          },
        });
        void pubSub.publish("newFederatedNotification", {
          newFederatedNotification: {
            id: "1",
            recipient: "alice",
            message: "Hello from federation",
          },
        });
      };

      let publishTimer: ReturnType<typeof setInterval> | undefined;
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          timeoutTimer = setTimeout(
            () => reject(new Error("Timed out waiting for federated notification")),
            3000,
          );

          socket.addEventListener("error", (err) => reject(err));
          socket.addEventListener("open", () => {
            socket.send(JSON.stringify({ type: "connection_init" }));
          });
          socket.addEventListener("message", (ev) => {
            const msg = JSON.parse(String(ev.data)) as {
              type: string;
              id?: string;
              payload?: any;
            };
            if (msg.type === "connection_ack") {
              socket.send(
                JSON.stringify({
                  id: "sub-1",
                  type: "subscribe",
                  payload: {
                    query: subscriptionQuery,
                    variables: { id: "1", recipient: "alice" },
                  },
                }),
              );
              publishNotifications();
              publishTimer = setInterval(publishNotifications, 25);
            } else if (msg.type === "next" && msg.id === "sub-1") {
              try {
                expect(msg.payload.data.newFederatedNotification.id).toEqual(
                  "1",
                );
                expect(
                  msg.payload.data.newFederatedNotification.recipient,
                ).toEqual("alice");
                expect(
                  msg.payload.data.newFederatedNotification.message,
                ).toEqual("Hello from federation");
                socket.send(JSON.stringify({ id: "sub-1", type: "complete" }));
                resolve();
              } catch (e) {
                reject(e);
              }
            } else if (msg.type === "error") {
              reject(new Error(JSON.stringify(msg.payload)));
            }
          });
        });
      } finally {
        clearInterval(publishTimer);
        clearTimeout(timeoutTimer);
      }
    });

    it("should expose the Subscription type in the federation SDL", async () => {
      const response = await request(app)
        .post("/graphql")
        .send({ query: "{ _service { sdl } }" })
        .expect(200);

      const sdl: string = response.body.data._service.sdl;
      expect(sdl).toContain("type Subscription");
      expect(sdl).toContain("newFederatedNotification");
    });
  },
);
