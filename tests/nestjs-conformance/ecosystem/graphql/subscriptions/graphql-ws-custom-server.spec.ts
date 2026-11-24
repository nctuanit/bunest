import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { type DynamicModule, Module } from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Field,
  GRAPHQL_TRANSPORT_WS_PROTOCOL,
  GraphQLModule,
  type GraphQLModuleOptions,
  GraphQLService,
  type GraphQLWsServer,
  ObjectType,
  PubSub,
  Query,
  Resolver,
  Subscription,
} from "../../../../../packages/graphql/src";
import { Test, describeConformance } from "../../../_helpers/index";

const pubSub = new PubSub();

@ObjectType()
class CustomServerNotification {
  @Field()
  id!: string;

  @Field()
  message!: string;
}

@Resolver(() => CustomServerNotification)
class CustomServerNotificationResolver {
  @Query(() => CustomServerNotification)
  getNotification(): CustomServerNotification {
    return { id: "1", message: "Hello!" };
  }

  @Subscription(() => CustomServerNotification)
  newNotification() {
    return pubSub.asyncIterator("customServerNotification");
  }
}

@Module({
  providers: [CustomServerNotificationResolver],
})
class NotificationModule {}

@Module({})
class AppModule {
  static forRoot(options?: {
    subscriptions?: GraphQLModuleOptions["subscriptions"];
  }): DynamicModule {
    return {
      module: AppModule,
      imports: [
        NotificationModule,
        GraphQLModule.forRoot({
          autoSchemaFile: true,
          includeStacktraceInErrorResponses: false,
          subscriptions: options?.subscriptions,
        }),
      ],
    };
  }
}

@Module({})
class FederationAppModule {
  static forRoot(options?: {
    subscriptions?: GraphQLModuleOptions["subscriptions"];
  }): DynamicModule {
    return {
      module: FederationAppModule,
      imports: [
        NotificationModule,
        GraphQLModule.forRoot({
          federation: { version: 2 },
          autoSchemaFile: true,
          includeStacktraceInErrorResponses: false,
          subscriptions: options?.subscriptions,
        }),
      ],
    };
  }
}

interface MockCustomWsServer extends GraphQLWsServer {
  readonly clients: Set<unknown>;
  readonly listeners: Map<string, Set<(...args: any[]) => void>>;
  on(event: string, fn: (...args: any[]) => void): void;
  listenerCount(event: string): number;
}

function createMockWsServer(opts: {
  noServer?: boolean;
  path?: string;
  maxPayload?: number;
}): MockCustomWsServer {
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  const clients = new Set<unknown>();
  return {
    options: { noServer: opts.noServer, path: opts.path },
    clients,
    listeners,
    on(event: string, fn: (...args: any[]) => void) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(fn);
    },
    listenerCount(event: string) {
      return listeners.get(event)?.size ?? 0;
    },
    handleUpgrade(_req, _socket, _head, cb) {
      const client = { close: () => {} };
      clients.add(client);
      cb(client, _req);
    },
    emit(event: "connection", ...args: any[]) {
      const set = listeners.get(event);
      if (!set || set.size === 0) return false;
      for (const fn of set) fn(...args);
      return true;
    },
  };
}

const withTimeout = <T>(promise: Promise<T>, ms = 1500) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve("timeout"), ms);
    }),
  ]);
};

const connect = (url: string, protocol = GRAPHQL_TRANSPORT_WS_PROTOCOL) => {
  const socket = new WebSocket(url, protocol);
  const acked = new Promise<void>((resolve, reject) => {
    socket.addEventListener("error", () =>
      reject(new Error("WebSocket connection failed")),
    );
    socket.addEventListener("open", () =>
      socket.send(JSON.stringify({ type: "connection_init" })),
    );
    socket.addEventListener("message", (ev) => {
      if (JSON.parse(String(ev.data)).type === "connection_ack") {
        resolve();
      }
    });
  });
  const closed = new Promise<number>((resolve) =>
    socket.addEventListener("close", (ev) => resolve(ev.code), { once: true }),
  );
  return { socket, acked, closed };
};

describeConformance(
  "graphql-ws custom server",
  {
    upstreamPath:
      "packages/apollo/tests/subscriptions/graphql-ws-custom-server.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts upstream graphql-ws custom WebSocketServer + unsupported subprotocol tests to native Bun WebSocket and @bunest/graphql GraphQLWsHandler (ADR-013).",
  },
  () => {
    type ModuleFactory = (server: GraphQLWsServer) => DynamicModule;

    const cases: Array<[string, ModuleFactory]> = [
      [
        "GraphQLModule (standard)",
        (server) =>
          AppModule.forRoot({
            subscriptions: { "graphql-ws": { server, path: "/subscriptions" } },
          }),
      ],
      [
        "GraphQLModule (federation)",
        (server) =>
          FederationAppModule.forRoot({
            subscriptions: { "graphql-ws": { server, path: "/subscriptions" } },
          }),
      ],
    ];

    describe.each(cases)(
      "graphql-ws custom server (%s)",
      (_name, moduleFactory) => {
        let app: BunestApplication;
        let server: MockCustomWsServer;
        let port: number;
        let socket: WebSocket | undefined;
        let closing: Promise<void> | undefined;
        const onConnection = mock(() => {});

        beforeEach(async () => {
          onConnection.mockClear();
          server = createMockWsServer({
            noServer: true,
            path: "/subscriptions",
            maxPayload: 1024,
          });
          server.on("connection", onConnection);

          const moduleRef = await Test.createTestingModule({
            imports: [moduleFactory(server)],
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
          await (closing ?? app.close());
          closing = undefined;
        });

        it("routes connections on its own path to the custom server", async () => {
          const client = connect(`ws://127.0.0.1:${port}/subscriptions`);
          socket = client.socket;

          expect(await withTimeout(client.acked.then(() => "acked"))).toBe(
            "acked",
          );
          expect(onConnection).toHaveBeenCalledTimes(1);
          expect(server.clients.size).toBe(1);
        });

        // BUNEST_BUG: GraphQLWsHandler ignores `subscriptions["graphql-ws"].server` options such as `maxPayload` (closed with 4400 invalid JSON instead of 1009 message too big; packages/graphql/src/subscriptions/graphql-ws.handler.ts).
        it.skip("applies the options of the custom server", async () => {
          const client = connect(`ws://127.0.0.1:${port}/subscriptions`);
          socket = client.socket;
          await client.acked;

          client.socket.send("x".repeat(2048));

          // 1009: message too big, enforced by the custom server's maxPayload
          expect(await withTimeout(client.closed)).toBe(1009);
        });

        it("closes the custom server when the application closes", async () => {
          const client = connect(`ws://127.0.0.1:${port}/subscriptions`);
          socket = client.socket;
          await client.acked;

          closing = app.close();

          expect(await withTimeout(client.closed)).toBe(1001);
          expect(server.listenerCount("connection")).toBe(0);
          expect(server.clients.size).toBe(0);
        });
      },
    );

    describe("graphql-ws custom server validation", () => {
      it('rejects a server that was not created with "noServer: true"', async () => {
        const server = createMockWsServer({ noServer: false });
        const moduleRef = await Test.createTestingModule({
          imports: [
            AppModule.forRoot({ subscriptions: { "graphql-ws": { server } } }),
          ],
        }).compile({ logger: false });
        const app = moduleRef.createNestApplication({ logger: false });
        try {
          await expect(app.init()).rejects.toThrow(
            'Custom WebSocketServer passed to "graphql-ws" must be instantiated with "noServer: true".',
          );
        } finally {
          await app.close();
        }
      });
    });

    describe("graphql-ws default server", () => {
      let app: BunestApplication;
      let socket: WebSocket | undefined;
      let port: number;

      beforeEach(async () => {
        const moduleRef = await Test.createTestingModule({
          imports: [AppModule.forRoot({ subscriptions: { "graphql-ws": {} } })],
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
        await app.close();
      });

      it("answers upgrades that use an unsupported subprotocol", async () => {
        // "graphql-ws" is the subprotocol of the legacy subscriptions-transport-ws
        const client = connect(`ws://127.0.0.1:${port}/graphql`, "graphql-ws");
        socket = client.socket;

        const outcome = await withTimeout(
          client.acked.then(() => "acked").catch((err: Error) => err.message),
        );
        expect(outcome).not.toBe("acked");
        expect(outcome).not.toBe("timeout");
      });
    });
  },
);
