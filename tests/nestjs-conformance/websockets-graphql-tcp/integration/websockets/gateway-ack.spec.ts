import { afterEach, expect } from "bun:test";
import type { Type } from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Ack,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketModule,
  type WsAckCallback,
  type WsMessageFrame,
} from "../../../../../packages/core/src/ws";
import { Test, describeConformance, itAdapted } from "../../../_helpers";

@WebSocketGateway({ path: "/ws" })
class AckGateway {
  @SubscribeMessage("push")
  onPush(): string {
    return "pong";
  }

  @SubscribeMessage("manual-ack")
  async handleManualAck(
    @MessageBody() data: { shouldSucceed: boolean },
    @Ack() ack: WsAckCallback,
  ): Promise<{ status: string }> {
    await new Promise((resolve) => setTimeout(resolve, 20));

    if (data.shouldSucceed) {
      ack({ status: "success", data });
    } else {
      ack({ status: "error", message: "Operation failed" });
    }
    return { status: "ignored" };
  }
}

interface WsClientHandle {
  ws: WebSocket;
  messages: WsMessageFrame[];
  sendFrame(event: string, data?: unknown, id?: string): void;
  waitFor(
    predicate: (frame: WsMessageFrame) => boolean,
    timeoutMs?: number,
  ): Promise<WsMessageFrame>;
  close(): void;
}

function connectWs(url: string): Promise<WsClientHandle> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const messages: WsMessageFrame[] = [];
    const waiters: Array<{
      predicate: (m: WsMessageFrame) => boolean;
      resolve: (m: WsMessageFrame) => void;
    }> = [];

    const openTimer = setTimeout(() => {
      ws.close();
      reject(new Error(`Timed out opening WebSocket ${url}`));
    }, 3000);

    ws.addEventListener("open", () => {
      clearTimeout(openTimer);
      resolve({
        ws,
        messages,
        sendFrame(event: string, data?: unknown, id?: string) {
          const frame: Record<string, unknown> = { event };
          if (data !== undefined) frame.data = data;
          if (id !== undefined) frame.id = id;
          ws.send(JSON.stringify(frame));
        },
        waitFor(predicate, timeoutMs = 2000) {
          const existing = messages.find(predicate);
          if (existing) {
            return Promise.resolve(existing);
          }
          return new Promise<WsMessageFrame>((res, rej) => {
            const timer = setTimeout(
              () =>
                rej(
                  new Error(
                    `Timed out waiting for WS frame; received: ${JSON.stringify(messages)}`,
                  ),
                ),
              timeoutMs,
            );
            waiters.push({
              predicate,
              resolve: (frame) => {
                clearTimeout(timer);
                res(frame);
              },
            });
          });
        },
        close() {
          if (
            ws.readyState === WebSocket.OPEN ||
            ws.readyState === WebSocket.CONNECTING
          ) {
            ws.close();
          }
        },
      });
    });

    ws.addEventListener("message", (evt) => {
      if (typeof evt.data === "string") {
        const parsed = JSON.parse(evt.data) as WsMessageFrame;
        messages.push(parsed);
        for (let i = waiters.length - 1; i >= 0; i--) {
          const w = waiters[i]!;
          if (w.predicate(parsed)) {
            waiters.splice(i, 1);
            w.resolve(parsed);
          }
        }
      }
    });

    ws.addEventListener("error", (err) => {
      clearTimeout(openTimer);
      reject(err);
    });
  });
}

describeConformance(
  "WebSocketGateway (ack)",
  {
    upstreamPath: "integration/websockets/e2e/gateway-ack.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Ported from Socket.IO ack callbacks to Bunest native WebSocket correlated { event, data, id } acknowledgement frames and @Ack() decorator (ADR-001).",
  },
  () => {
    let app: BunestApplication | undefined;
    let client: WsClientHandle | undefined;

    async function startApp(...gateways: Type<unknown>[]): Promise<number> {
      const testingModule = await Test.createTestingModule({
        imports: [WebSocketModule.forRoot()],
        providers: gateways,
      }).compile({ logger: false });
      app = testingModule.createNestApplication({ logger: false });
      await WebSocketModule.attach(app);
      const info = await app.listen({ port: 0, hostname: "127.0.0.1" });
      return info.port;
    }

    afterEach(async () => {
      client?.close();
      client = undefined;
      if (app) {
        await app.close();
        app = undefined;
      }
    });

    itAdapted(
      "ADR-001",
      "should handle message with ack (http)",
      async () => {
        const port = await startApp(AckGateway);
        client = await connectWs(`ws://127.0.0.1:${port}/ws`);

        client.sendFrame("push", { test: "test" }, "ack-1");
        const reply = await client.waitFor((m) => m.id === "ack-1");
        expect(reply.event).toBe("push");
        expect(reply.data).toEqual("pong");
      },
      "correlated id frame",
    );

    itAdapted(
      "ADR-001",
      "should handle message with ack & without data (http)",
      async () => {
        const port = await startApp(AckGateway);
        client = await connectWs(`ws://127.0.0.1:${port}/ws`);

        client.sendFrame("push", undefined, "ack-2");
        const reply = await client.waitFor((m) => m.id === "ack-2");
        expect(reply.event).toBe("push");
        expect(reply.data).toEqual("pong");
      },
      "correlated id frame without data",
    );

    itAdapted(
      "ADR-001",
      "should handle manual ack for async operations when @Ack() is used (success case)",
      async () => {
        const port = await startApp(AckGateway);
        client = await connectWs(`ws://127.0.0.1:${port}/ws`);
        const payload = { shouldSucceed: true };

        client.sendFrame("manual-ack", payload, "ack-3");
        const reply = await client.waitFor((m) => m.id === "ack-3");
        expect(reply.event).toBe("manual-ack");
        expect(reply.data).toEqual({ status: "success", data: payload });

        // Ensure the returned `{ status: "ignored" }` value was NOT also emitted
        await new Promise((resolve) => setTimeout(resolve, 40));
        expect(client.messages.filter((m) => m.id === "ack-3")).toHaveLength(1);
      },
      "@Ack() manual response",
    );

    itAdapted(
      "ADR-001",
      "should handle manual ack for async operations when @Ack() is used (error case)",
      async () => {
        const port = await startApp(AckGateway);
        client = await connectWs(`ws://127.0.0.1:${port}/ws`);
        const payload = { shouldSucceed: false };

        client.sendFrame("manual-ack", payload, "ack-4");
        const reply = await client.waitFor((m) => m.id === "ack-4");
        expect(reply.event).toBe("manual-ack");
        expect(reply.data).toEqual({
          status: "error",
          message: "Operation failed",
        });

        await new Promise((resolve) => setTimeout(resolve, 40));
        expect(client.messages.filter((m) => m.id === "ack-4")).toHaveLength(1);
      },
      "@Ack() manual error response",
    );
  },
);
