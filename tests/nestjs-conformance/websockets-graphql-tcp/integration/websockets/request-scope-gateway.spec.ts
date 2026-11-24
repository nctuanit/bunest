import { afterEach, expect, it } from "bun:test";
import {
  Inject,
  Injectable,
  REQUEST,
  Scope,
} from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  type BunWsClient,
  ConnectedSocket,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketModule,
  type WsMessageFrame,
} from "../../../../../packages/core/src/ws";
import {
  Test,
  describeConformance,
  expectScopeLeak,
  itAdapted,
} from "../../../_helpers";

interface ConnectionStateSnapshot {
  instanceId: number;
  sequence: number;
  source: "connection" | "message";
  injectedClientId?: string;
  connectedClientId?: string;
  matchesClient: boolean;
}

@Injectable()
class SocketLifecycleTracker {
  private latestDisconnectClientId: string | undefined;

  reset(): void {
    this.latestDisconnectClientId = undefined;
  }

  recordDisconnect(client: BunWsClient): void {
    this.latestDisconnectClientId = client.id;
  }

  getDisconnectClientId(): string | undefined {
    return this.latestDisconnectClientId;
  }
}

@Injectable({ scope: Scope.REQUEST })
class ConnectionStateService {
  private static nextId = 0;

  private readonly instanceId = ++ConnectionStateService.nextId;
  private sequence = 0;

  constructor(@Inject(REQUEST) private readonly client: BunWsClient) {}

  snapshot(
    client: BunWsClient,
    source: "connection" | "message",
  ): ConnectionStateSnapshot {
    return {
      instanceId: this.instanceId,
      sequence: ++this.sequence,
      source,
      injectedClientId: this.client.id,
      connectedClientId: client.id,
      matchesClient: this.client === client,
    };
  }
}

@WebSocketGateway({ path: "/ws" })
class ImplicitLeakyRequestGateway {
  constructor(
    @Inject(ConnectionStateService)
    private readonly connectionState: ConnectionStateService,
  ) {}

  @SubscribeMessage("state")
  onState(@ConnectedSocket() client: BunWsClient): {
    event: string;
    data: ConnectionStateSnapshot;
  } {
    return {
      event: "state",
      data: this.connectionState.snapshot(client, "message"),
    };
  }
}

@WebSocketGateway({ path: "/ws", scope: Scope.REQUEST })
class RequestScopeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  constructor(
    @Inject(ConnectionStateService)
    private readonly connectionState: ConnectionStateService,
    @Inject(SocketLifecycleTracker)
    private readonly socketLifecycleTracker: SocketLifecycleTracker,
  ) {}

  handleConnection(client: BunWsClient): void {
    client.emit(
      "connectedState",
      this.connectionState.snapshot(client, "connection"),
    );
  }

  async handleDisconnect(client: BunWsClient): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    this.socketLifecycleTracker.recordDisconnect(client);
  }

  @SubscribeMessage("state")
  onState(@ConnectedSocket() client: BunWsClient): {
    event: string;
    data: ConnectionStateSnapshot;
  } {
    return {
      event: "state",
      data: this.connectionState.snapshot(client, "message"),
    };
  }
}

interface StateWsClient {
  ws: WebSocket;
  connectedState: ConnectionStateSnapshot;
  emitState(): Promise<ConnectionStateSnapshot>;
  closeAndWait(): Promise<void>;
}

function connectStateClient(url: string): Promise<StateWsClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pendingStateResolvers: Array<(s: ConnectionStateSnapshot) => void> =
      [];
    let connectedStateResolved = false;

    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`Timed out connecting to ${url}`));
    }, 2000);

    ws.addEventListener("message", (evt) => {
      if (typeof evt.data !== "string") return;
      const frame = JSON.parse(
        evt.data,
      ) as WsMessageFrame<ConnectionStateSnapshot>;
      if (
        frame.event === "connectedState" &&
        !connectedStateResolved &&
        frame.data
      ) {
        connectedStateResolved = true;
        clearTimeout(timer);
        resolve({
          ws,
          connectedState: frame.data,
          emitState() {
            return new Promise<ConnectionStateSnapshot>((res, rej) => {
              const t = setTimeout(
                () => rej(new Error("Timed out waiting for state frame")),
                2000,
              );
              pendingStateResolvers.push((snap) => {
                clearTimeout(t);
                res(snap);
              });
              ws.send(JSON.stringify({ event: "state" }));
            });
          },
          closeAndWait() {
            return new Promise<void>((res) => {
              if (ws.readyState === WebSocket.CLOSED) {
                res();
                return;
              }
              ws.addEventListener("close", () => res(), { once: true });
              ws.close();
            });
          },
        });
      } else if (frame.event === "state" && frame.data) {
        const next = pendingStateResolvers.shift();
        next?.(frame.data);
      }
    });

    ws.addEventListener("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describeConformance(
  "WebSocketGateway request scope",
  {
    upstreamPath: "integration/websockets/e2e/request-scope-gateway.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-012"],
    notes:
      "Per ADR-012, singleton gateways injecting Scope.REQUEST providers fail fast with ScopeLeakException unless explicitly marked { scope: Scope.REQUEST }.",
  },
  () => {
    let app: BunestApplication | undefined;
    const clients: StateWsClient[] = [];

    afterEach(async () => {
      await Promise.all(
        clients.splice(0).map((c) => c.closeAndWait().catch(() => {})),
      );
      if (app) {
        await app.close();
        app = undefined;
      }
    });

    itAdapted(
      "ADR-012",
      "should fail fast with ScopeLeakException when a singleton gateway injects a Scope.REQUEST provider without explicit scope",
      async () => {
        await expectScopeLeak(
          () =>
            Test.createTestingModule({
              imports: [WebSocketModule.forRoot()],
              providers: [ImplicitLeakyRequestGateway, ConnectionStateService],
            }).compile({ logger: false }),
          /ImplicitLeakyRequestGateway.*ConnectionStateService/,
        );
      },
      "fail-fast scope leak",
    );

    // BUNEST_BUG: WsGatewayExplorer.discoverAndBindGateways() only iterates discovery.getAllSingletonInstances() and skips @WebSocketGateway({ scope: Scope.REQUEST }) providers; BunWebSocketAdapter lacks per-connection RequestContainer/REQUEST resolution (packages/core/src/ws/explorer/ws-gateway.explorer.ts#L122, packages/core/src/ws/adapter/bun-ws.adapter.ts#L240).
    it.skip("should reuse the same request-scoped provider per connection and isolate across clients [ADR-001, ADR-012]", async () => {
      const testingModule = await Test.createTestingModule({
        imports: [WebSocketModule.forRoot()],
        providers: [
          RequestScopeGateway,
          ConnectionStateService,
          SocketLifecycleTracker,
        ],
      }).compile({ logger: false });
      app = testingModule.createNestApplication({ logger: false });
      await WebSocketModule.attach(app);
      const info = await app.listen({ port: 0, hostname: "127.0.0.1" });
      const wsUrl = `ws://127.0.0.1:${info.port}/ws`;
      const tracker = app.get(SocketLifecycleTracker);
      tracker.reset();

      const firstClient = await connectStateClient(wsUrl);
      clients.push(firstClient);

      expect(firstClient.connectedState.source).toBe("connection");
      expect(firstClient.connectedState.sequence).toBe(1);
      expect(firstClient.connectedState.matchesClient).toBe(true);
      expect(firstClient.connectedState.injectedClientId).toBe(
        firstClient.connectedState.connectedClientId,
      );

      const firstClientMessage = await firstClient.emitState();
      expect(firstClientMessage.source).toBe("message");
      expect(firstClientMessage.sequence).toBe(2);
      expect(firstClientMessage.instanceId).toBe(
        firstClient.connectedState.instanceId,
      );
      expect(firstClientMessage.matchesClient).toBe(true);
      expect(firstClientMessage.injectedClientId).toBe(
        firstClient.connectedState.injectedClientId,
      );

      const secondClient = await connectStateClient(wsUrl);
      clients.push(secondClient);

      expect(secondClient.connectedState.source).toBe("connection");
      expect(secondClient.connectedState.sequence).toBe(1);
      expect(secondClient.connectedState.instanceId).not.toBe(
        firstClient.connectedState.instanceId,
      );
      expect(secondClient.connectedState.matchesClient).toBe(true);

      const secondClientMessage = await secondClient.emitState();
      expect(secondClientMessage.sequence).toBe(2);
      expect(secondClientMessage.instanceId).toBe(
        secondClient.connectedState.instanceId,
      );
      expect(secondClientMessage.instanceId).not.toBe(
        firstClient.connectedState.instanceId,
      );
      expect(secondClientMessage.injectedClientId).toBe(
        secondClient.connectedState.connectedClientId,
      );

      await firstClient.closeAndWait();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(tracker.getDisconnectClientId()).toBe(
        firstClient.connectedState.connectedClientId,
      );
    });
  },
);
