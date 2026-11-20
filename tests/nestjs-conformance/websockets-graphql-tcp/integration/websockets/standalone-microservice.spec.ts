import "reflect-metadata";
import { afterEach, beforeEach, expect, it, spyOn } from "bun:test";
import {
  Inject,
  Injectable,
  Module,
  type MicroserviceInstance,
  type Type,
} from "../../../../../packages/common/src";
import {
  BunestFactory,
  type BunestMicroserviceApplication,
} from "../../../../../packages/core/src";
import {
  BunWebSocketAdapter,
  type BunWsServer,
  BunWsServerImpl,
  type OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketModule,
  type WsMessageFrame,
} from "../../../../../packages/websockets/src";
import { describeConformance, itAdapted } from "../../../_helpers";

class NoopTransport implements MicroserviceInstance {
  async listen(): Promise<void> {}
  async close(): Promise<void> {}
}

@Injectable()
class Tracker {
  servers: BunWsServer[] = [];
}

@WebSocketGateway({ path: "/ws" })
class BroadcastingGateway implements OnGatewayInit {
  constructor(@Inject(Tracker) private readonly tracker: Tracker) {}

  afterInit(server: BunWsServer): void {
    this.tracker.servers.push(server);
  }

  @SubscribeMessage("echo")
  echo(_client: unknown, data: unknown): { event: string; data: unknown } {
    return { event: "echo", data };
  }
}

class SharedStoreWsAdapter extends BunWebSocketAdapter {
  readonly sharedStore = true;
}

describeConformance(
  "Standalone microservice with gateways",
  {
    upstreamPath: "integration/websockets/e2e/standalone-microservice.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapted from NestJS IoAdapter/WsAdapter standalone microservice tests to BunestFactory.createMicroservice() + WebSocketModule / BunWebSocketAdapter (ADR-001).",
  },
  () => {
    let app: BunestMicroserviceApplication<NoopTransport> | undefined;
    let serveSpy: ReturnType<typeof spyOn> | undefined;
    const clients: WebSocket[] = [];

    beforeEach(() => {
      serveSpy = spyOn(Bun, "serve");
    });

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
      serveSpy?.mockRestore();
      serveSpy = undefined;
    });

    async function start(providers: Type<unknown>[]): Promise<BunWsServer[]> {
      @Module({
        imports: [WebSocketModule.forRoot()],
        providers: [Tracker, ...providers],
      })
      class StandaloneMicroserviceModule {}

      app = await BunestFactory.createMicroservice(
        StandaloneMicroserviceModule,
        new NoopTransport(),
        { logger: false },
      );
      await app.listen();
      return app.get(Tracker).servers;
    }

    itAdapted(
      "ADR-001",
      "should give a gateway without a port a WebSocket server handle that does not listen",
      async () => {
        const servers = await start([BroadcastingGateway]);
        expect(servers).toHaveLength(1);
        const server = servers[0]!;

        expect(server).toBeInstanceOf(BunWsServerImpl);
        expect(server.clients.size).toBe(0);
        expect(() => server.emit("news", "to every process")).not.toThrow();
        expect(serveSpy).not.toHaveBeenCalled();
      },
      "native BunWsServerImpl non-listening server",
    );

    // BUNEST_BUG: BunestMicroserviceApplication does not implement useWebSocketAdapter() (declared optional on INestMicroservice) and WsGatewayExplorer hardcodes `new BunWebSocketAdapter()` instead of accepting an application-supplied adapter (packages/core/src/application/bunest-factory.ts#L44-L80, packages/websockets/src/explorer/ws-gateway.explorer.ts#L66).
    it.skip("should set up such a server through the adapter of the application", async () => {
      @Module({
        imports: [WebSocketModule.forRoot()],
        providers: [Tracker, BroadcastingGateway],
      })
      class CustomAdapterModule {}

      app = await BunestFactory.createMicroservice(
        CustomAdapterModule,
        new NoopTransport(),
        { logger: false },
      );

      const customAdapter = new SharedStoreWsAdapter();
      const msWithWsAdapter = app as unknown as {
        useWebSocketAdapter?: (adapter: BunWebSocketAdapter) => unknown;
      };
      expect(typeof msWithWsAdapter.useWebSocketAdapter).toBe("function");
      msWithWsAdapter.useWebSocketAdapter!(customAdapter);

      await app.listen();
      const servers = app.get(Tracker).servers;
      expect(servers).toHaveLength(1);
      expect(customAdapter.sharedStore).toBe(true);
      expect(servers[0]).toBe(customAdapter.getServerByPath("/ws"));
      expect(serveSpy).not.toHaveBeenCalled();
    });

    itAdapted(
      "ADR-001",
      "should give a gateway without an HTTP server a native ws server handle that does not bind a port",
      async () => {
        const servers = await start([BroadcastingGateway]);
        expect(servers).toHaveLength(1);
        const server = servers[0]!;

        expect(server.path).toBe("/ws");
        expect(server.namespace).toBe("/ws");
        expect(server.clients.size).toBe(0);
        expect(serveSpy).not.toHaveBeenCalled();
      },
      "native BunWebSocketAdapter without HTTP adapter",
    );

    itAdapted(
      "ADR-001",
      "should still serve a gateway on its own port via BunWebSocketAdapter.listen()",
      async () => {
        serveSpy?.mockRestore();
        serveSpy = undefined;

        const servers = await start([BroadcastingGateway]);
        expect(servers).toHaveLength(1);

        const wsAdapter = app!.get(BunWebSocketAdapter);
        const info = await wsAdapter.listen({ port: 0, hostname: "127.0.0.1" });
        expect(info.port).toBeGreaterThan(0);

        const ws = new WebSocket(`ws://127.0.0.1:${info.port}/ws`);
        clients.push(ws);

        const reply = await new Promise<WsMessageFrame>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Timed out waiting for echo reply")),
            2000,
          );
          ws.addEventListener("open", () => {
            ws.send(JSON.stringify({ event: "echo", data: { ok: true } }));
          });
          ws.addEventListener("message", (evt) => {
            clearTimeout(timer);
            resolve(JSON.parse(String(evt.data)) as WsMessageFrame);
          });
          ws.addEventListener("error", (err) => {
            clearTimeout(timer);
            reject(err);
          });
        });

        expect(reply).toEqual({
          event: "echo",
          data: { ok: true },
        });
      },
      "standalone BunWebSocketAdapter ephemeral port",
    );
  },
);
