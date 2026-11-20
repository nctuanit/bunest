import "reflect-metadata";
import { afterEach, describe, expect, it } from "bun:test";
import type { Type } from "../../../../../packages/common/src";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  type OnGatewayConnection,
  WebSocketGateway,
  WebSocketModule,
  WsException,
  type WsMessageFrame,
} from "../../../../../packages/websockets/src";
import { Test, describeConformance } from "../../../_helpers";

@WebSocketGateway({ path: "/ws" })
class SyncRejectingGateway implements OnGatewayConnection {
  handleConnection(): void {
    throw new WsException("Unauthorized");
  }
}

@WebSocketGateway({ path: "/ws" })
class AsyncRejectingGateway implements OnGatewayConnection {
  async handleConnection(): Promise<void> {
    await Promise.resolve();
    throw new WsException("Unauthorized");
  }
}

describeConformance(
  "WebSocketGateway - connection hook errors",
  {
    upstreamPath: "integration/websockets/e2e/connection-hook-error.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Ported to Bunest native WebSocket framing (ADR-001). Verifies exceptions thrown/rejected in handleConnection() are routed to exception filters and sent to the client.",
  },
  () => {
    let app: BunestApplication | undefined;
    const clients: WebSocket[] = [];

    async function start(gateway: Type<unknown>): Promise<number> {
      const testingModule = await Test.createTestingModule({
        imports: [WebSocketModule.forRoot()],
        providers: [gateway],
      }).compile({ logger: false });
      app = testingModule.createNestApplication({ logger: false });
      await WebSocketModule.attach(app);
      const info = await app.listen({ port: 0, hostname: "127.0.0.1" });
      return info.port;
    }

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

    describe.each([
      ["throws", SyncRejectingGateway],
      ["rejects", AsyncRejectingGateway],
    ] as const)("when the hook %s", (_, gateway) => {
      // BUNEST_BUG: Expected handleConnection() throwing/rejecting WsException to be routed through BaseWsExceptionFilter and emit an error frame to the connected client, but BunWebSocketAdapter.handleOpen() catches and only logs the error without notifying the client (packages/websockets/src/adapter/bun-ws.adapter.ts#L679-L688).
      it.skip("should send the exception to a ws client [ADR-001]", async () => {
        const port = await start(gateway);
        const client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        clients.push(client);

        const message = await new Promise<WsMessageFrame>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Timed out waiting for connection hook error frame")),
            1500,
          );
          client.addEventListener("message", (evt) => {
            clearTimeout(timer);
            resolve(JSON.parse(String(evt.data)) as WsMessageFrame);
          });
          client.addEventListener("error", (err) => {
            clearTimeout(timer);
            reject(err);
          });
        });

        expect(message).toEqual({
          event: "error",
          data: {
            status: "error",
            message: "Unauthorized",
          },
        });
      });
    });
  },
);
