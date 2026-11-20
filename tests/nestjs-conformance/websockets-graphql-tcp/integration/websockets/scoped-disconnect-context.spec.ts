import "reflect-metadata";
import { afterEach, expect, it } from "bun:test";
import {
  Inject,
  Injectable,
  Scope,
} from "../../../../../packages/common/src";
import {
  type BunestApplication,
  ContextIdFactory,
  ModuleRef,
} from "../../../../../packages/core/src";
import {
  type BunWsClient,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketModule,
  type WsMessageFrame,
} from "../../../../../packages/websockets/src";
import {
  Test,
  describeConformance,
  expectScopeLeak,
  itAdapted,
} from "../../../_helpers";

@Injectable({ scope: Scope.REQUEST })
class SharedState {}

@Injectable()
class DisconnectTracker {
  client: BunWsClient | undefined;
  sameState = false;
  startSlow: () => void = () => {};
  finishFast: () => void = () => {};
  finishSlow: () => void = () => {};
  release: () => void = () => {};

  readonly slowStarted = new Promise<void>((resolve) => {
    this.startSlow = resolve;
  });
  readonly fastFinished = new Promise<void>((resolve) => {
    this.finishFast = resolve;
  });
  readonly slowFinished = new Promise<void>((resolve) => {
    this.finishSlow = resolve;
  });
  readonly gate = new Promise<void>((resolve) => {
    this.release = resolve;
  });
}

@WebSocketGateway({ path: "/ws" })
class ImplicitLeakyFastGateway {
  constructor(
    @Inject(SharedState) readonly state: SharedState,
    @Inject(DisconnectTracker) readonly tracker: DisconnectTracker,
  ) {}
}

@WebSocketGateway({ path: "/ws", scope: Scope.REQUEST })
class FastGateway implements OnGatewayConnection, OnGatewayDisconnect {
  constructor(
    @Inject(SharedState) readonly state: SharedState,
    @Inject(DisconnectTracker) private readonly tracker: DisconnectTracker,
  ) {}

  handleConnection(client: BunWsClient): void {
    client.emit("fastReady");
  }

  handleDisconnect(): void {
    this.tracker.finishFast();
  }
}

@WebSocketGateway({ path: "/ws", scope: Scope.REQUEST })
class SlowGateway implements OnGatewayConnection, OnGatewayDisconnect {
  constructor(
    @Inject(SharedState) private readonly state: SharedState,
    @Inject(DisconnectTracker) private readonly tracker: DisconnectTracker,
    @Inject(ModuleRef) private readonly moduleRef: ModuleRef,
  ) {}

  handleConnection(client: BunWsClient): void {
    this.tracker.client = client;
    client.emit("slowReady");
  }

  async handleDisconnect(client: BunWsClient): Promise<void> {
    this.tracker.startSlow();
    await this.tracker.gate;
    const resolved = await this.moduleRef.resolve(
      SharedState,
      ContextIdFactory.getByRequest(client),
      { strict: false },
    );
    this.tracker.sameState = resolved === this.state;
    this.tracker.finishSlow();
  }
}

describeConformance(
  "Shared gateway disconnect context",
  {
    upstreamPath:
      "integration/websockets/e2e/scoped-disconnect-context.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-012"],
    notes:
      "Adapted to Bunest native WebSocket (ADR-001) and explicit Scope.REQUEST / ScopeLeakException (ADR-012).",
  },
  () => {
    let app: BunestApplication | undefined;
    let client: WebSocket | undefined;
    let tracker: DisconnectTracker | undefined;

    afterEach(async () => {
      tracker?.release();
      tracker = undefined;
      if (
        client &&
        (client.readyState === WebSocket.OPEN ||
          client.readyState === WebSocket.CONNECTING)
      ) {
        client.close();
      }
      client = undefined;
      if (app) {
        await app.close();
        app = undefined;
      }
    });

    itAdapted(
      "ADR-012",
      "should fail fast with ScopeLeakException when a singleton gateway injects SharedState without Scope.REQUEST",
      async () => {
        await expectScopeLeak(
          () =>
            Test.createTestingModule({
              imports: [WebSocketModule.forRoot()],
              providers: [
                ImplicitLeakyFastGateway,
                SharedState,
                DisconnectTracker,
              ],
            }).compile({ logger: false }),
          /ImplicitLeakyFastGateway.*SharedState/,
        );
      },
      "fail-fast scope leak",
    );

    // BUNEST_BUG: WsGatewayExplorer skips Scope.REQUEST gateways, BunWebSocketAdapter disallows multiple gateways sharing the same path ("/ws"), and no per-connection ContextId is bound to BunWsClient for handleDisconnect resolution (packages/websockets/src/explorer/ws-gateway.explorer.ts#L122, packages/websockets/src/adapter/bun-ws.adapter.ts#L259-L263, #L691-L716).
    it.skip("should keep request-scoped dependencies shared while another gateway disconnects [ADR-001, ADR-012]", async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [WebSocketModule.forRoot()],
        providers: [FastGateway, SlowGateway, SharedState, DisconnectTracker],
      }).compile({ logger: false });
      app = moduleRef.createNestApplication({ logger: false });
      await WebSocketModule.attach(app);
      const info = await app.listen({ port: 0, hostname: "127.0.0.1" });
      const currentTracker = app.get(DisconnectTracker);
      tracker = currentTracker;

      client = new WebSocket(`ws://127.0.0.1:${info.port}/ws`);
      const seenEvents = new Set<string>();
      const ready = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Timed out waiting for fastReady and slowReady")),
          2000,
        );
        client!.addEventListener("message", (evt) => {
          const parsed = JSON.parse(String(evt.data)) as WsMessageFrame;
          seenEvents.add(parsed.event);
          if (seenEvents.has("fastReady") && seenEvents.has("slowReady")) {
            clearTimeout(timer);
            resolve();
          }
        });
        client!.addEventListener("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });

      await ready;
      const contextId = ContextIdFactory.getByRequest(currentTracker.client!);
      client.close();
      await Promise.all([
        currentTracker.slowStarted,
        currentTracker.fastFinished,
      ]);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(ContextIdFactory.getByRequest(currentTracker.client!)).toBe(
        contextId,
      );

      currentTracker.release();
      await currentTracker.slowFinished;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(currentTracker.sameState).toBe(true);
    });
  },
);
