import { describe, expect, it } from "bun:test";
import { BunestFactory } from "@bunest/core";
import { WebSocketModule, type WsMessageFrame } from "@bunest/core/ws";
import { AppModule } from "../src/app.module";

interface WsClientHelper {
  ws: WebSocket;
  sendEvent(event: string, data?: unknown, id?: string): void;
  waitFor(
    predicate: (msg: WsMessageFrame) => boolean,
    timeoutMs?: number,
  ): Promise<WsMessageFrame>;
  waitForClose(timeoutMs?: number): Promise<void>;
  close(): void;
}

function connectClient(url: string): Promise<WsClientHelper> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const queue: WsMessageFrame[] = [];
    const waiters: Array<{
      predicate: (m: WsMessageFrame) => boolean;
      resolve: (m: WsMessageFrame) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }> = [];
    let closed = false;
    const closeResolvers: Array<() => void> = [];

    ws.onopen = () => {
      resolve({
        ws,
        sendEvent(event, data, id) {
          ws.send(JSON.stringify({ event, data, ...(id ? { id } : {}) }));
        },
        waitFor(predicate, timeoutMs = 2000) {
          const existingIdx = queue.findIndex(predicate);
          if (existingIdx !== -1) {
            return Promise.resolve(queue.splice(existingIdx, 1)[0]!);
          }
          return new Promise<WsMessageFrame>((res, rej) => {
            const timer = setTimeout(() => {
              const idx = waiters.findIndex((w) => w.resolve === res);
              if (idx !== -1) waiters.splice(idx, 1);
              rej(new Error(`Timed out waiting for WebSocket message`));
            }, timeoutMs);
            waiters.push({ predicate, resolve: res, reject: rej, timer });
          });
        },
        waitForClose(timeoutMs = 2000) {
          if (closed) return Promise.resolve();
          return new Promise<void>((res, rej) => {
            const timer = setTimeout(
              () => rej(new Error("Timed out waiting for WS close")),
              timeoutMs,
            );
            closeResolvers.push(() => {
              clearTimeout(timer);
              res();
            });
          });
        },
        close() {
          ws.close();
        },
      });
    };

    ws.onmessage = (ev) => {
      const frame = JSON.parse(String(ev.data)) as WsMessageFrame;
      const idx = waiters.findIndex((w) => w.predicate(frame));
      if (idx !== -1) {
        const waiter = waiters.splice(idx, 1)[0]!;
        clearTimeout(waiter.timer);
        waiter.resolve(frame);
      } else {
        queue.push(frame);
      }
    };

    ws.onclose = () => {
      closed = true;
      for (const r of closeResolvers.splice(0)) r();
    };

    ws.onerror = () => {
      reject(new Error(`Failed to connect to ${url}`));
    };
  });
}

describe("WebSocket Chat Example (E2E)", () => {
  it("authenticates handshake, exchanges room messages between 2 real WebSockets, rejects 401, and closes cleanly", async () => {
    const app = await BunestFactory.create(AppModule);
    await WebSocketModule.attach(app);
    const server = await app.listen({ hostname: "127.0.0.1", port: 0 });
    const port = server.port;

    try {
      // 1. Unauthenticated HTTP upgrade request is rejected with 401 BEFORE upgrade
      const unauthHttp = await fetch(`http://127.0.0.1:${port}/chat`, {
        headers: {
          upgrade: "websocket",
          connection: "Upgrade",
        },
      });
      expect(unauthHttp.status).toBe(401);

      // 2. Connect Alice & Bob with valid tokens
      const alice = await connectClient(
        `ws://127.0.0.1:${port}/chat?token=token-alice`,
      );
      const bob = await connectClient(
        `ws://127.0.0.1:${port}/chat?token=token-bob`,
      );

      // 3. Both join room "general"
      alice.sendEvent("join", { room: "general" }, "j1");
      const aliceJoinAck = await alice.waitFor((m) => m.id === "j1");
      expect(aliceJoinAck.data).toMatchObject({
        joined: "general",
        user: "alice",
      });

      bob.sendEvent("join", { room: "general" }, "j2");
      const [bobJoinAck, aliceNotified] = await Promise.all([
        bob.waitFor((m) => m.id === "j2"),
        alice.waitFor((m) => m.event === "system"),
      ]);
      expect(bobJoinAck.data).toMatchObject({
        joined: "general",
        user: "bob",
      });
      expect(aliceNotified.data).toEqual({
        type: "joined",
        room: "general",
        user: "bob",
      });

      // 4. Alice sends a room message -> Bob receives it, Alice receives ack (sender excluded from pub/sub)
      alice.sendEvent(
        "message",
        { room: "general", text: "Hello from Bunest!" },
        "m1",
      );
      const [aliceAck, bobReceived] = await Promise.all([
        alice.waitFor((m) => m.id === "m1"),
        bob.waitFor((m) => m.event === "message"),
      ]);
      expect(aliceAck.data).toEqual({ delivered: true, room: "general" });
      expect(bobReceived.data).toMatchObject({
        room: "general",
        from: "alice",
        text: "Hello from Bunest!",
      });

      // 5. Bob leaves room -> Alice notified
      bob.sendEvent("leave", { room: "general" }, "l1");
      const [bobLeftAck, aliceSawLeave] = await Promise.all([
        bob.waitFor((m) => m.id === "l1"),
        alice.waitFor(
          (m) =>
            m.event === "system" &&
            (m.data as { type?: string })?.type === "left",
        ),
      ]);
      expect(bobLeftAck.data).toEqual({ left: "general" });
      expect(aliceSawLeave.data).toEqual({
        type: "left",
        room: "general",
        user: "bob",
      });

      // 6. Graceful shutdown disconnects active WebSocket clients cleanly
      const aliceClosePromise = alice.waitForClose();
      const bobClosePromise = bob.waitForClose();
      await app.close();
      await Promise.all([aliceClosePromise, bobClosePromise]);
    } finally {
      await app.close();
    }
  });
});
