import "reflect-metadata";
import { afterEach, expect } from "bun:test";
import {
  Inject,
  Injectable,
  type MicroserviceInstance,
} from "../../../../../packages/common/src";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  BunWebSocketAdapter,
  type BunWsServer,
  type OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketModule,
  type WsMessageFrame,
} from "../../../../../packages/websockets/src";
import { Test, describeConformance, itAdapted } from "../../../_helpers";

class NoopTransport implements MicroserviceInstance {
  listenCalls = 0;
  closeCalls = 0;

  async listen(): Promise<void> {
    this.listenCalls += 1;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

@Injectable()
class Tracker {
  servers: BunWsServer[] = [];
}

@WebSocketGateway({ path: "/ws" })
class AppGateway implements OnGatewayInit {
  constructor(@Inject(Tracker) private readonly tracker: Tracker) {}

  afterInit(server: BunWsServer): void {
    this.tracker.servers.push(server);
  }

  @SubscribeMessage("ping")
  ping(): { pong: boolean } {
    return { pong: true };
  }
}

describeConformance(
  "Hybrid application with a deferred microservice",
  {
    upstreamPath:
      "integration/websockets/e2e/hybrid-deferred-microservice.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapted to Bunest hybrid BunestApplication.connectMicroservice() + WebSocketModule / BunWebSocketAdapter (ADR-001). Verifies WebSocket gateways are bound once to the HTTP server when startAllMicroservices() runs before init().",
  },
  () => {
    let app: BunestApplication | undefined;
    const clients: WebSocket[] = [];

    afterEach(async () => {
      for (const ws of clients.splice(0)) {
        if (
          ws.readyState === WebSocket.OPEN ||
          ws.readyState === WebSocket.CONNECTING
        ) {
          ws.close();
        }
      }
      if (app) {
        await app.close();
        app = undefined;
      }
    });

    for (const inheritAppConfig of [false, true] as const) {
      itAdapted(
        "ADR-001",
        `should bind the gateways once, to the HTTP server (inheritAppConfig: ${inheritAppConfig})`,
        async () => {
          const testingModule = await Test.createTestingModule({
            imports: [WebSocketModule.forRoot()],
            providers: [Tracker, AppGateway],
          }).compile({ logger: false });

          app = testingModule.createNestApplication({ logger: false });
          const wsAdapter = app.get(BunWebSocketAdapter);
          app.useWebSocketAdapter(wsAdapter as unknown as Parameters<BunestApplication["useWebSocketAdapter"]>[0]);

          const transport = new NoopTransport();
          app.connectMicroservice(transport, { inheritAppConfig });

          await app.startAllMicroservices();
          await app.init();

          const { servers } = app.get(Tracker);
          expect(servers).toHaveLength(1);
          expect(transport.listenCalls).toBe(1);
          expect(servers[0]).toBe(wsAdapter.getServerByPath("/ws"));

          // Verify the single gateway is live on the HTTP server's ephemeral port
          const info = await app.listen({ port: 0, hostname: "127.0.0.1" });
          const ws = new WebSocket(`ws://127.0.0.1:${info.port}/ws`);
          clients.push(ws);

          const reply = await new Promise<WsMessageFrame>((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error("Timed out waiting for ping reply")),
              2000,
            );
            ws.addEventListener("open", () => {
              ws.send(JSON.stringify({ event: "ping", id: "h-1" }));
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
            event: "ping",
            data: { pong: true },
            id: "h-1",
          });
          expect(servers[0]!.clients.size).toBe(1);
        },
        "hybrid HTTP + WS + Microservice",
      );
    }
  },
);
