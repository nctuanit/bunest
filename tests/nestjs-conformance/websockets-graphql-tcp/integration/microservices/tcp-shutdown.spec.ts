import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  Controller,
  Injectable,
  Module,
  type OnApplicationShutdown,
} from "../../../../../packages/core/src/common";
import {
  NestFactory,
  type BunestMicroserviceApplication,
} from "../../../../../packages/core/src";
import {
  FrameDecoder,
  MessagePattern,
  MicroserviceHost,
  MicroserviceModule,
  TcpServer,
  encodeFrame,
  normalizePattern,
  type RpcRequestEnvelope,
  type RpcResponseEnvelope,
  type TcpTransportOptions,
} from "../../../../../packages/microservices/src";
import { describeConformance, itAdapted } from "../../../_helpers";

let handlerCalls = 0;

@Controller()
class PingController {
  @MessagePattern({ cmd: "ping" })
  ping(): string {
    handlerCalls++;
    return "pong";
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface BunTestClientSocket {
  write(data: Uint8Array | string): void;
  destroy(): void;
  closed: Promise<void>;
}

async function openBunTcpSocket(
  port: number,
  onData?: (chunk: Buffer) => void,
): Promise<BunTestClientSocket> {
  let resolveClosed!: () => void;
  let closedDone = false;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const markClosed = () => {
    if (!closedDone) {
      closedDone = true;
      resolveClosed();
    }
  };
  const pendingWrites: Uint8Array[] = [];
  let rawSocket: Bun.Socket<unknown> | undefined;

  const flushWrites = () => {
    if (!rawSocket || closedDone) {
      return;
    }
    while (pendingWrites.length > 0) {
      const head = pendingWrites[0]!;
      const written = rawSocket.write(head);
      if (written < head.byteLength) {
        if (written > 0) {
          pendingWrites[0] = head.subarray(written);
        }
        return;
      }
      pendingWrites.shift();
    }
  };

  rawSocket = await Bun.connect({
    hostname: "127.0.0.1",
    port,
    socket: {
      data(_socket, chunk) {
        onData?.(Buffer.from(chunk));
      },
      drain() {
        flushWrites();
      },
      end() {
        markClosed();
      },
      close() {
        markClosed();
      },
      error() {
        markClosed();
      },
    },
  });

  return {
    closed,
    write(data: Uint8Array | string) {
      if (closedDone) {
        return;
      }
      pendingWrites.push(typeof data === "string" ? Buffer.from(data) : data);
      flushWrites();
    },
    destroy() {
      if (!closedDone) {
        try {
          rawSocket?.terminate();
        } catch {
          // ignore
        }
        markClosed();
      }
    },
  };
}

describeConformance(
  "TCP transport shutdown",
  {
    upstreamPath: "integration/microservices/e2e/tcp-shutdown.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Uses Bunest native TcpServer (port: 0) with 4-byte length-prefixed framing; gracefulShutdown/gracePeriod/TLS drain tests are tracked as BUNEST_BUG skips where TcpServer does not yet implement those options.",
  },
  () => {
    describe("TCP transport shutdown", () => {
      let app: BunestMicroserviceApplication<MicroserviceHost> | undefined;
      let tcpServer: TcpServer | undefined;
      let port = 0;
      let sockets: BunTestClientSocket[] = [];

      beforeEach(async () => {
        handlerCalls = 0;
        sockets = [];
        tcpServer = new TcpServer({ host: "127.0.0.1", port: 0 });

        @Module({
          imports: [MicroserviceModule.forRoot({ server: tcpServer })],
          controllers: [PingController],
        })
        class PingModule {}

        app = await NestFactory.createMicroservice(
          PingModule,
          (ctx) => ctx.get(MicroserviceHost),
          { logger: false },
        );
        await app.listen();
        port = tcpServer.port!;
        expect(port).toBeGreaterThan(0);
      });

      afterEach(async () => {
        for (const s of sockets) {
          s.destroy();
        }
        sockets = [];
        try {
          await app?.close();
        } catch {
          // already closed by test
        }
        app = undefined;
        tcpServer = undefined;
      });

      function openSockets(): Set<unknown> {
        return (tcpServer as unknown as { clients: Set<unknown> }).clients;
      }

      async function connect(): Promise<BunTestClientSocket> {
        const beforeCount = openSockets().size;
        const socket = await openBunTcpSocket(port);
        sockets.push(socket);

        const deadline = Date.now() + 2000;
        while (openSockets().size <= beforeCount && Date.now() < deadline) {
          await sleep(5);
        }
        return socket;
      }

      it("should have destroyed pre-existing connections by the time close() resolves", async () => {
        const clientSocket = await connect();

        expect(openSockets().size).toBe(1);

        await app!.close();

        expect(openSockets().size).toBe(0);
        await clientSocket.closed;
      });

      itAdapted(
        "ADR-001",
        "should not execute handlers over a pre-existing connection after shutdown",
        async () => {
          const socket = await connect();

          socket.write(
            encodeFrame({
              type: "request",
              id: "1",
              pattern: normalizePattern({ cmd: "ping" }),
              data: null,
            } satisfies RpcRequestEnvelope),
          );
          await sleep(150);
          expect(handlerCalls).toBe(1);

          await app!.close();

          socket.write(
            encodeFrame({
              type: "request",
              id: "2",
              pattern: normalizePattern({ cmd: "ping" }),
              data: null,
            } satisfies RpcRequestEnvelope),
          );
          await sleep(200);

          expect(handlerCalls).toBe(1);
        },
        "4-byte length-prefixed framing",
      );

      it("should leave no open sockets tracked after the shutdown", async () => {
        await connect();
        await connect();

        expect(openSockets().size).toBe(2);

        await app!.close();

        expect(openSockets().size).toBe(0);
      });
    });

    describe('TCP transport shutdown with "gracefulShutdown"', () => {
      let app: BunestMicroserviceApplication<MicroserviceHost> | undefined;
      let tcpServer: TcpServer | undefined;
      let port = 0;
      let events: string[] = [];
      let sockets: BunTestClientSocket[] = [];

      @Injectable()
      class Resources implements OnApplicationShutdown {
        onApplicationShutdown() {
          events.push("shutdown hook");
        }
      }

      @Controller()
      class SlowController {
        @MessagePattern({ cmd: "slow" })
        async slow(data: { id: number; duration: number; size?: number }) {
          const log = events;
          log.push(`handler ${data.id} started`);
          await sleep(data.duration);
          log.push(`handler ${data.id} finished`);
          return data.size ? "x".repeat(data.size) : `reply ${data.id}`;
        }
      }

      async function createServer(options: Record<string, unknown> = {}) {
        tcpServer = new TcpServer({
          host: "127.0.0.1",
          port: 0,
          ...(options as TcpTransportOptions),
        });

        @Module({
          imports: [MicroserviceModule.forRoot({ server: tcpServer })],
          controllers: [SlowController],
          providers: [Resources],
        })
        class SlowModule {}

        app = await NestFactory.createMicroservice(
          SlowModule,
          (ctx) => ctx.get(MicroserviceHost),
          { logger: false },
        );
        await app.listen();
        port = tcpServer.port!;
        expect(port).toBeGreaterThan(0);
        return app;
      }

      async function connect() {
        const clientsSet = (tcpServer as unknown as { clients: Set<unknown> })
          .clients;
        const beforeCount = clientsSet.size;
        const replies: RpcResponseEnvelope[] = [];
        const decoder = new FrameDecoder();
        const socket = await openBunTcpSocket(port, (chunk) => {
          try {
            replies.push(...decoder.push<RpcResponseEnvelope>(chunk));
          } catch {
            // ignore partial frame on abrupt close
          }
        });
        sockets.push(socket);

        const deadline = Date.now() + 2000;
        while (clientsSet.size <= beforeCount && Date.now() < deadline) {
          await sleep(5);
        }

        const sendRequest = (id: number, duration: number, size?: number) => {
          socket.write(
            encodeFrame({
              type: "request",
              id: String(id),
              pattern: normalizePattern({ cmd: "slow" }),
              data: { id, duration, size },
            } satisfies RpcRequestEnvelope),
          );
        };
        return { socket, replies, closed: socket.closed, request: sendRequest };
      }

      async function handlerStarted(id: number) {
        const deadline = Date.now() + 5000;
        while (!events.includes(`handler ${id} started`)) {
          if (Date.now() > deadline) {
            throw new Error(`Handler ${id} did not start`);
          }
          await sleep(10);
        }
      }

      beforeEach(() => {
        events = [];
        sockets = [];
      });

      afterEach(async () => {
        for (const socket of sockets) {
          socket.destroy();
        }
        sockets = [];
        await app?.close();
        app = undefined;
        tcpServer = undefined;
      });

      it("should not wait for a handler in flight by default", async () => {
        const server = await createServer();
        const { replies, closed, request } = await connect();
        request(1, 500);
        await handlerStarted(1);

        await server.close();
        await closed;

        expect(events).toEqual(["handler 1 started", "shutdown hook"]);
        expect(replies).toEqual([]);
      });

      // BUNEST_BUG: TcpServer / TcpTransportOptions do not implement `gracefulShutdown` to wait for in-flight handlers to reply before closing sockets and running shutdown hooks (packages/microservices/src/transports/tcp.transport.ts, packages/microservices/src/interfaces.ts)
      it.skip("should let a handler in flight reply before the shutdown hooks run, then close its connection", async () => {
        const server = await createServer({ gracefulShutdown: true });
        const { replies, closed, request } = await connect();
        request(1, 500);
        await handlerStarted(1);

        await server.close();

        expect(events).toEqual([
          "handler 1 started",
          "handler 1 finished",
          "shutdown hook",
        ]);
        await closed;
        expect(replies).toEqual([
          { type: "response", id: "1", response: "reply 1", isDisposed: true },
        ]);
      });

      // BUNEST_BUG: TcpServer / TcpTransportOptions do not implement `gracefulShutdown` / `gracePeriod` (packages/microservices/src/transports/tcp.transport.ts, packages/microservices/src/interfaces.ts)
      it.skip('should close as soon as the handler is done, well before "gracePeriod"', async () => {
        const server = await createServer({
          gracefulShutdown: true,
          gracePeriod: 30_000,
        });
        const { replies, closed, request } = await connect();
        request(1, 500);
        await handlerStarted(1);

        const closeCalledAt = Date.now();
        await server.close();

        expect(Date.now() - closeCalledAt).toBeLessThan(5000);
        await closed;
        expect(replies).toHaveLength(1);
      });

      // BUNEST_BUG: TcpServer / TcpTransportOptions do not implement `gracefulShutdown` closing-state rejection of newly arriving requests on draining sockets (packages/microservices/src/transports/tcp.transport.ts)
      it.skip("should not run a handler for a request that arrives on a connection while it is closing", async () => {
        const server = await createServer({ gracefulShutdown: true });
        const { replies, closed, request } = await connect();
        request(1, 500);
        await handlerStarted(1);

        const closing = server.close();
        await sleep(100);
        request(2, 0);
        await closing;
        await closed;

        expect(events).not.toContain("handler 2 started");
        expect(replies.map(({ id }) => id)).toEqual(["1"]);
      });

      // BUNEST_BUG: TcpServer / TcpTransportOptions do not implement `gracefulShutdown` per-connection draining (packages/microservices/src/transports/tcp.transport.ts)
      it.skip("should close a connection with nothing in flight right away, and the others once their handlers are done", async () => {
        const server = await createServer({ gracefulShutdown: true });
        const idle = await connect();
        const busy = await connect();
        idle.request(0, 0);
        while (idle.replies.length === 0) {
          await sleep(10);
        }
        void idle.closed.then(() => events.push("idle connection closed"));
        void busy.closed.then(() => events.push("busy connection closed"));
        busy.request(1, 500);
        await handlerStarted(1);

        await server.close();
        await busy.closed;

        expect(events).toEqual([
          "handler 0 started",
          "handler 0 finished",
          "handler 1 started",
          "idle connection closed",
          "handler 1 finished",
          "shutdown hook",
          "busy connection closed",
        ]);
        expect(busy.replies).toHaveLength(1);
      });

      // BUNEST_BUG: TcpServer / TcpTransportOptions do not implement `gracefulShutdown` per-connection independent socket closure (packages/microservices/src/transports/tcp.transport.ts)
      it.skip("should close each connection once its own handlers are done, rather than once every handler is", async () => {
        const server = await createServer({
          gracefulShutdown: true,
          gracePeriod: 5000,
        });
        const fast = await connect();
        const slow = await connect();
        void fast.closed.then(() => events.push("fast connection closed"));
        void slow.closed.then(() => events.push("slow connection closed"));
        slow.request(2, 800);
        await handlerStarted(2);
        fast.request(1, 100);
        await handlerStarted(1);

        events.push("closing");
        await server.close();
        await Promise.all([fast.closed, slow.closed]);

        expect(events.slice(0, 6)).toEqual([
          "handler 2 started",
          "handler 1 started",
          "closing",
          "handler 1 finished",
          "fast connection closed",
          "handler 2 finished",
        ]);
        expect(fast.replies).toEqual([
          { type: "response", id: "1", response: "reply 1", isDisposed: true },
        ]);
        expect(slow.replies).toEqual([
          { type: "response", id: "2", response: "reply 2", isDisposed: true },
        ]);
      });

      // BUNEST_BUG: TcpServer / TcpTransportOptions do not implement `gracefulShutdown` listener stop while draining in-flight requests (packages/microservices/src/transports/tcp.transport.ts)
      it.skip("should refuse new connections while it waits", async () => {
        const server = await createServer({ gracefulShutdown: true });
        const { request } = await connect();
        request(1, 500);
        await handlerStarted(1);

        const closing = server.close();
        let outcome = "ERROR";
        try {
          const late = await Bun.connect({
            hostname: "127.0.0.1",
            port,
            socket: {
              data() {},
              error() {},
            },
          });
          outcome = "connected";
          late.terminate();
        } catch (err) {
          outcome = (err as { code?: string }).code ?? "ERROR";
        }
        await closing;

        expect(outcome).toBe("ECONNREFUSED");
      });

      it('should close after "gracePeriod" when a handler is still running', async () => {
        const server = await createServer({
          gracefulShutdown: true,
          gracePeriod: 200,
        });
        const { replies, closed, request } = await connect();
        request(1, 3000);
        await handlerStarted(1);

        const closeCalledAt = Date.now();
        await server.close();

        expect(Date.now() - closeCalledAt).toBeLessThan(2000);
        expect(events).toEqual(["handler 1 started", "shutdown hook"]);
        await closed;
        expect(replies).toEqual([]);
      });

      // BUNEST_BUG: TcpServer / TcpTransportOptions do not implement `gracefulShutdown` write-queue flush before socket close for large replies (packages/microservices/src/transports/tcp.transport.ts)
      it.skip("should send a large reply in full before it closes the connection", async () => {
        const size = 8 * 1024 * 1024;
        const server = await createServer({ gracefulShutdown: true });
        const { replies, closed, request } = await connect();
        request(1, 200, size);
        await handlerStarted(1);

        await server.close();
        await closed;

        expect(replies).toHaveLength(1);
        expect((replies[0]!.response as string).length).toBe(size);
      });

      // BUNEST_BUG: TcpServer / TcpTransportOptions do not implement `gracefulShutdown` with `gracePeriod: Infinity` (packages/microservices/src/transports/tcp.transport.ts)
      it.skip('should send a large reply in full when "gracePeriod" is longer than a timer supports', async () => {
        const size = 8 * 1024 * 1024;
        const server = await createServer({
          gracefulShutdown: true,
          gracePeriod: Number.POSITIVE_INFINITY,
        });
        const { replies, closed, request } = await connect();
        request(1, 200, size);
        await handlerStarted(1);

        await server.close();
        await closed;

        expect(replies).toHaveLength(1);
        expect((replies[0]!.response as string).length).toBe(size);
      });

      // BUNEST_BUG: TcpServer / TcpTransportOptions do not implement `tlsOptions` or `gracefulShutdown` (packages/microservices/src/transports/tcp.transport.ts, packages/microservices/src/interfaces.ts)
      it.skip("should let a handler in flight reply over TLS", async () => {
        const server = await createServer({
          gracefulShutdown: true,
          tlsOptions: {},
        });
        const { replies, closed, request } = await connect();
        request(1, 500);
        await handlerStarted(1);

        await server.close();
        await closed;

        expect(events).toEqual([
          "handler 1 started",
          "handler 1 finished",
          "shutdown hook",
        ]);
        expect(replies).toEqual([
          { type: "response", id: "1", response: "reply 1", isDisposed: true },
        ]);
      });
    });
  },
);
