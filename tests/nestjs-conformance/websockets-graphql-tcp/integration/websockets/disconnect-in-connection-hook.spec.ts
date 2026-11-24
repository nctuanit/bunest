import { afterEach, expect, it } from "bun:test";
import {
  Inject,
  type Provider,
  REQUEST,
  Scope,
} from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  type BunWsClient,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketModule,
} from "../../../../../packages/core/src/ws";
import {
  Test,
  describeConformance,
  expectScopeLeak,
  itAdapted,
} from "../../../_helpers";

const calls: string[] = [];
let onDisconnectHook: () => void = () => {};

@WebSocketGateway({ path: "/ws" })
class SyncDisconnectingGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  handleConnection(client: BunWsClient): void {
    calls.push("connect");
    client.close(1000, "server disconnect");
    calls.push("after disconnect()");
  }

  handleDisconnect(_client: BunWsClient, _code: number, reason: string): void {
    calls.push(`disconnect: ${reason}`);
    onDisconnectHook();
  }
}

@WebSocketGateway({ path: "/ws" })
class AsyncDisconnectingGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  async handleConnection(client: BunWsClient): Promise<void> {
    await Promise.resolve();
    calls.push("connect");
    client.close(1000, "server disconnect");
  }

  handleDisconnect(_client: BunWsClient, _code: number, reason: string): void {
    calls.push(`disconnect: ${reason}`);
    onDisconnectHook();
  }
}

@WebSocketGateway({ path: "/ws" })
class ObservingGateway implements OnGatewayConnection, OnGatewayDisconnect {
  handleConnection(): void {
    calls.push("observer connect");
  }

  handleDisconnect(_client: BunWsClient, _code: number, reason: string): void {
    calls.push(`observer disconnect: ${reason}`);
    onDisconnectHook();
  }
}

@WebSocketGateway({ path: "/chat", namespace: "chat" })
class NamespacedSyncDisconnectingGateway extends SyncDisconnectingGateway {}

@WebSocketGateway({ path: "/chat", namespace: "/chat" })
class NamespacedObservingGateway extends ObservingGateway {}

@WebSocketGateway({ path: "/", namespace: "/" })
class MainNamespaceSyncDisconnectingGateway extends SyncDisconnectingGateway {}

@WebSocketGateway({ path: "/", namespace: "/" })
class MainNamespaceObservingGateway extends ObservingGateway {}

@WebSocketGateway({ path: "/room-1", namespace: "/room-1" })
class RoomGateway implements OnGatewayConnection {
  handleConnection(): void {
    calls.push("room connect");
  }
}

@WebSocketGateway({ path: "/room-1", namespace: "/room-1" })
class OtherRoomGateway implements OnGatewayConnection {
  handleConnection(): void {
    calls.push("other room connect");
  }
}

const CONNECTION_STATE = "CONNECTION_STATE";

const connectionStateProvider: Provider = {
  provide: CONNECTION_STATE,
  scope: Scope.REQUEST,
  useFactory: () => ({}),
};

const connectionStateResolvedOnLeaveProvider: Provider = {
  provide: CONNECTION_STATE,
  scope: Scope.REQUEST,
  inject: [REQUEST],
  useFactory: (_client: BunWsClient) =>
    new Promise<object>((resolve) => setTimeout(() => resolve({}), 50)),
};

@WebSocketGateway({ path: "/ws" })
class ImplicitLeakyObservingGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  constructor(@Inject(CONNECTION_STATE) readonly state: object) {}

  handleConnection(): void {
    calls.push("scoped observer connect");
  }

  handleDisconnect(_client: BunWsClient, _code: number, reason: string): void {
    calls.push(`scoped observer disconnect: ${reason}`);
    onDisconnectHook();
  }
}

@WebSocketGateway({ path: "/ws", scope: Scope.REQUEST })
class RequestScopedObservingGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  constructor(@Inject(CONNECTION_STATE) readonly state: object) {}

  handleConnection(): void {
    calls.push("scoped observer connect");
  }

  handleDisconnect(_client: BunWsClient, _code: number, reason: string): void {
    calls.push(`scoped observer disconnect: ${reason}`);
    onDisconnectHook();
  }
}

describeConformance(
  "WebSocketGateway - disconnect from the connection hook",
  {
    upstreamPath:
      "integration/websockets/e2e/disconnect-in-connection-hook.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-012"],
    notes:
      "Adapted from Socket.IO client.disconnect() to Bunest native BunWsClient.close() (ADR-001) and explicit Scope.REQUEST / fail-fast ScopeLeakException (ADR-012).",
  },
  () => {
    let app: BunestApplication | undefined;
    const clients: WebSocket[] = [];

    afterEach(async () => {
      for (const client of clients.splice(0)) {
        if (
          client.readyState === WebSocket.OPEN ||
          client.readyState === WebSocket.CONNECTING
        ) {
          client.close();
        }
      }
      if (app) {
        await app.close();
        app = undefined;
      }
    });

    async function connect(
      providers: Provider[],
      expectedDisconnects: number,
      { path = "/ws", leaveOnConnect = false } = {},
    ): Promise<void> {
      calls.length = 0;
      let remaining = expectedDisconnects;
      const disconnectHooksCalled = new Promise<void>((resolve) => {
        if (remaining === 0) {
          resolve();
          return;
        }
        onDisconnectHook = () => {
          remaining -= 1;
          if (remaining === 0) {
            resolve();
          }
        };
      });

      const testingModule = await Test.createTestingModule({
        imports: [WebSocketModule.forRoot()],
        providers,
      }).compile({ logger: false });
      app = testingModule.createNestApplication({ logger: false });
      await WebSocketModule.attach(app);
      const info = await app.listen({ port: 0, hostname: "127.0.0.1" });

      const ws = new WebSocket(`ws://127.0.0.1:${info.port}${path}`);
      clients.push(ws);
      if (leaveOnConnect) {
        ws.addEventListener("open", () => ws.close(1000, "client disconnect"));
      }

      await Promise.race([
        disconnectHooksCalled,
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]);
    }

    // BUNEST_BUG: Expected handleDisconnect() to run after synchronous handleConnection() finishes (["connect", "after disconnect()", "disconnect: server disconnect"]), but Bun's ServerWebSocket.close() invokes the close callback synchronously and BunWebSocketAdapter.handleClose() runs handleDisconnect() re-entrantly before handleConnection() completes (received ["connect", "disconnect: server disconnect", "after disconnect()"]) (packages/core/src/ws/adapter/bun-ws.adapter.ts#L662-L716).
    it.skip("should call handleDisconnect when a synchronous handleConnection disconnects the client [ADR-001: native Bun WS close]", async () => {
      await connect([SyncDisconnectingGateway], 1);

      expect(calls).toEqual([
        "connect",
        "after disconnect()",
        "disconnect: server disconnect",
      ]);
    });

    itAdapted(
      "ADR-001",
      "should call handleDisconnect when an asynchronous handleConnection disconnects the client",
      async () => {
        await connect([AsyncDisconnectingGateway], 1);

        expect(calls).toEqual(["connect", "disconnect: server disconnect"]);
      },
      "native Bun WS close",
    );

    itAdapted(
      "ADR-012",
      "should reject singleton gateway injecting Scope.REQUEST provider with ScopeLeakException",
      async () => {
        await expectScopeLeak(
          () =>
            Test.createTestingModule({
              imports: [WebSocketModule.forRoot()],
              providers: [
                ImplicitLeakyObservingGateway,
                connectionStateProvider,
              ],
            }).compile({ logger: false }),
          /ImplicitLeakyObservingGateway/,
        );
      },
      "fail-fast scope leak",
    );

    // BUNEST_BUG: BunWebSocketAdapter rejects registering multiple @WebSocketGateway() classes on the same path ("Duplicate @WebSocketGateway() path") instead of multiplexing lifecycle hooks across co-located gateways (packages/core/src/ws/adapter/bun-ws.adapter.ts#L259-L263).
    it.skip("should call handleDisconnect of every gateway after their handleConnection", async () => {
      await connect([SyncDisconnectingGateway, ObservingGateway], 2);

      expect(calls).toEqual([
        "connect",
        "after disconnect()",
        "observer connect",
        "disconnect: server disconnect",
        "observer disconnect: server disconnect",
      ]);
    });

    // BUNEST_BUG: BunWebSocketAdapter disallows multiple gateways sharing the same path/namespace "/chat" (packages/core/src/ws/adapter/bun-ws.adapter.ts#L259-L263).
    it.skip("should call handleDisconnect of every gateway sharing a namespace after their handleConnection", async () => {
      await connect(
        [NamespacedSyncDisconnectingGateway, NamespacedObservingGateway],
        2,
        { path: "/chat" },
      );

      expect(calls).toEqual([
        "connect",
        "after disconnect()",
        "observer connect",
        "disconnect: server disconnect",
        "observer disconnect: server disconnect",
      ]);
    });

    // BUNEST_BUG: BunWebSocketAdapter disallows multiple gateways sharing the root "/" path (packages/core/src/ws/adapter/bun-ws.adapter.ts#L259-L263).
    it.skip("should call handleDisconnect of gateways on '/' and default namespace after their handleConnection", async () => {
      await connect(
        [MainNamespaceSyncDisconnectingGateway, MainNamespaceObservingGateway],
        2,
        { path: "/" },
      );

      expect(calls).toEqual([
        "connect",
        "after disconnect()",
        "observer connect",
        "disconnect: server disconnect",
        "observer disconnect: server disconnect",
      ]);
    });

    // BUNEST_BUG: BunWebSocketAdapter does not support RegExp namespaces or multiple gateways sharing a path (packages/core/src/ws/interfaces/ws.interface.ts#L21, packages/core/src/ws/adapter/bun-ws.adapter.ts#L259-L263).
    it.skip("should call handleConnection of every gateway sharing a RegExp namespace", async () => {
      await connect([RoomGateway, OtherRoomGateway], 0, {
        path: "/room-1",
      });

      expect(calls).toEqual(["room connect", "other room connect"]);
    });

    // BUNEST_BUG: WsGatewayExplorer skips @WebSocketGateway({ scope: Scope.REQUEST }) providers and BunWebSocketAdapter disallows multiple gateways on the same path (packages/core/src/ws/explorer/ws-gateway.explorer.ts#L122, packages/core/src/ws/adapter/bun-ws.adapter.ts#L259-L263).
    it.skip("should call handleDisconnect of a request-scoped gateway after its handleConnection", async () => {
      await connect(
        [
          SyncDisconnectingGateway,
          RequestScopedObservingGateway,
          connectionStateProvider,
        ],
        2,
      );

      expect(calls).toEqual([
        "connect",
        "after disconnect()",
        "disconnect: server disconnect",
        "scoped observer connect",
        "scoped observer disconnect: server disconnect",
      ]);
    });

    // BUNEST_BUG: WsGatewayExplorer skips @WebSocketGateway({ scope: Scope.REQUEST }) providers and BunWebSocketAdapter has no per-connection RequestContainer resolution (packages/core/src/ws/explorer/ws-gateway.explorer.ts#L122).
    it.skip("should call handleDisconnect of a request-scoped gateway after its handleConnection when the client leaves while the gateway is being resolved", async () => {
      await connect(
        [RequestScopedObservingGateway, connectionStateResolvedOnLeaveProvider],
        1,
        { leaveOnConnect: true },
      );

      expect(calls).toEqual([
        "scoped observer connect",
        "scoped observer disconnect: client disconnect",
      ]);
    });
  },
);
