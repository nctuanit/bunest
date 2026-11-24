import { afterEach, beforeEach, expect, it } from "bun:test";
import {
  type CanActivate,
  type DynamicModule,
  type ExecutionContext,
  Injectable,
  Module,
  UseGuards,
} from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Args,
  Field,
  GRAPHQL_TRANSPORT_WS_PROTOCOL,
  GqlExecutionContext,
  GraphQLModule,
  type GraphQLModuleOptions,
  GraphQLService,
  type GraphQLWsConnectionContext,
  ObjectType,
  PubSub,
  Query,
  Resolver,
  Subscription,
} from "../../../../../packages/graphql/src";
import { Test, describeConformance } from "../../../_helpers/index";

class MalformedTokenException extends Error {
  constructor() {
    super("Malformed token");
  }
}

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

@Injectable()
class AuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const ctx = GqlExecutionContext.create(context).getContext<{
      user?: string;
    }>();
    return Boolean(ctx.user?.startsWith("test"));
  }
}

@Resolver(() => Notification)
class NotificationResolver {
  @Query(() => Notification)
  getNotification() {
    return {
      id: "0",
      recipient: "system",
      message: "Hello!",
    };
  }

  @UseGuards(AuthGuard)
  @Subscription(() => Notification, {
    filter(
      payload: { newNotification: Notification },
      variables: { id: string },
      context: { user?: string },
    ) {
      return (
        context.user === payload.newNotification.recipient &&
        payload.newNotification.id === variables.id
      );
    },
  })
  newNotification(@Args("id", { nullable: false }) _id: string) {
    return pubSub.asyncIterator("newNotification");
  }
}

@Module({
  providers: [NotificationResolver, AuthGuard],
})
class NotificationModule {}

@Module({})
class AppModule {
  static forRoot(options?: {
    context?: GraphQLModuleOptions["context"];
    subscriptions?: GraphQLModuleOptions["subscriptions"];
  }): DynamicModule {
    return {
      module: AppModule,
      imports: [
        NotificationModule,
        GraphQLModule.forRoot({
          includeStacktraceInErrorResponses: false,
          context: options?.context,
          autoSchemaFile: true,
          subscriptions: options?.subscriptions,
        }),
      ],
    };
  }
}

const subscriptionQuery = `
  subscription TestSubscription($id: String!) {
    newNotification(id: $id) {
      id
      message
    }
  }
`;

describeConformance(
  "graphql-ws protocol",
  {
    upstreamPath: "packages/apollo/tests/subscriptions/graphql-ws.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts @nestjs/apollo graphql-ws protocol E2E (onConnect auth, malformed token, AuthGuard rejection, filtered notifications) to native @bunest/graphql GraphQLWsHandler and Bun WebSocket (ADR-013).",
  },
  () => {
    let app: BunestApplication;
    let ws: WebSocket | undefined;
    let port: number;

    beforeEach(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [
          AppModule.forRoot({
            subscriptions: {
              "graphql-ws": {
                onConnect: (context: GraphQLWsConnectionContext) => {
                  const authorization = context.connectionParams
                    .authorization as string | undefined;
                  if (!authorization) {
                    const extraSocket = (
                      context.extra as {
                        socket?: {
                          close: (code: number, reason: string) => void;
                        };
                      }
                    ).socket;
                    if (extraSocket) {
                      extraSocket.close(4000, "Missing authorization");
                      return;
                    }
                    return false;
                  }
                  if (!authorization.startsWith("Bearer ")) {
                    throw new MalformedTokenException();
                  }
                  return { user: authorization.split("Bearer ")[1] };
                },
              },
            },
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

    it("should receive an error if missing token", async () => {
      ws = new WebSocket(
        `ws://127.0.0.1:${port}/graphql`,
        GRAPHQL_TRANSPORT_WS_PROTOCOL,
      );
      const socket = ws;

      const closed = await new Promise<{ code: number; reason: string }>(
        (resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Timed out waiting for close")),
            2000,
          );
          socket.addEventListener("open", () => {
            socket.send(
              JSON.stringify({ type: "connection_init", payload: {} }),
            );
          });
          socket.addEventListener(
            "close",
            (ev) => {
              clearTimeout(timer);
              resolve({ code: ev.code, reason: ev.reason });
            },
            { once: true },
          );
        },
      );

      expect(closed.code).toEqual(4000);
      expect(closed.reason).toEqual("Missing authorization");
    });

    it("should receive an error if token is malformed", async () => {
      ws = new WebSocket(
        `ws://127.0.0.1:${port}/graphql`,
        GRAPHQL_TRANSPORT_WS_PROTOCOL,
      );
      const socket = ws;

      const closed = await new Promise<{ code: number; reason: string }>(
        (resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Timed out waiting for close")),
            2000,
          );
          socket.addEventListener("open", () => {
            socket.send(
              JSON.stringify({
                type: "connection_init",
                payload: { authorization: "wrong token" },
              }),
            );
          });
          socket.addEventListener(
            "close",
            (ev) => {
              clearTimeout(timer);
              resolve({ code: ev.code, reason: ev.reason });
            },
            { once: true },
          );
        },
      );

      expect(closed.code).toEqual(4500);
      expect(closed.reason).toEqual("Malformed token");
    });

    it("should receive error on subscription if guard fails", async () => {
      ws = new WebSocket(
        `ws://127.0.0.1:${port}/graphql`,
        GRAPHQL_TRANSPORT_WS_PROTOCOL,
      );
      const socket = ws;

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Timed out waiting for guard error")),
          2000,
        );
        socket.addEventListener("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
        socket.addEventListener("open", () => {
          socket.send(
            JSON.stringify({
              type: "connection_init",
              payload: { authorization: "Bearer notest" },
            }),
          );
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
                id: "guard-sub",
                type: "subscribe",
                payload: {
                  query: subscriptionQuery,
                  variables: { id: "1" },
                },
              }),
            );
          } else if (msg.type === "error" && msg.id === "guard-sub") {
            clearTimeout(timer);
            try {
              expect(msg.payload[0].message).toEqual("Forbidden resource");
              expect(msg.payload[0].path[0]).toEqual("newNotification");
              resolve();
            } catch (e) {
              reject(e);
            }
          }
        });
      });
    });

    it("should connect to subscriptions", async () => {
      ws = new WebSocket(
        `ws://127.0.0.1:${port}/graphql`,
        GRAPHQL_TRANSPORT_WS_PROTOCOL,
      );
      const socket = ws;

      const publishNotifications = () => {
        void pubSub.publish("newNotification", {
          newNotification: {
            id: "2",
            recipient: "test",
            message: "wrong message!",
          },
        });
        void pubSub.publish("newNotification", {
          newNotification: {
            id: "1",
            recipient: "someone-else",
            message: "wrong message!",
          },
        });
        void pubSub.publish("newNotification", {
          newNotification: {
            id: "1",
            recipient: "test",
            message: "Hello graphql-ws",
          },
        });
      };

      let publishTimer: ReturnType<typeof setInterval> | undefined;
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          timeoutTimer = setTimeout(
            () => reject(new Error("Timed out waiting for notification")),
            3000,
          );
          socket.addEventListener("error", (err) => reject(err));
          socket.addEventListener("open", () => {
            socket.send(
              JSON.stringify({
                type: "connection_init",
                payload: { authorization: "Bearer test" },
              }),
            );
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
                  id: "ok-sub",
                  type: "subscribe",
                  payload: {
                    query: subscriptionQuery,
                    variables: { id: "1" },
                  },
                }),
              );
              publishNotifications();
              publishTimer = setInterval(publishNotifications, 25);
            } else if (msg.type === "next" && msg.id === "ok-sub") {
              try {
                expect(msg.payload.data.newNotification.id).toEqual("1");
                expect(msg.payload.data.newNotification.message).toEqual(
                  "Hello graphql-ws",
                );
                socket.send(JSON.stringify({ id: "ok-sub", type: "complete" }));
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
  },
);
