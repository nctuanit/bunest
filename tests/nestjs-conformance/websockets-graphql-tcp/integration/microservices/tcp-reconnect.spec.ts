import { afterEach, beforeEach, expect } from "bun:test";
import {
  FrameDecoder,
  TcpClientProxy,
  encodeFrame,
  type RpcRequestEnvelope,
  type RpcResponseEnvelope,
} from "../../../../../packages/microservices/src";
import { describeConformance, itAdapted } from "../../../_helpers";

interface ServerConn {
  socket: Bun.Socket<unknown>;
  closed: boolean;
  closeResolvers: Array<() => void>;
  buffered: Buffer[];
  dataListener?: (chunk: Buffer) => void;
}

describeConformance(
  "TCP client reconnect",
  {
    upstreamPath: "integration/microservices/e2e/tcp-reconnect.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008"],
    notes:
      "Uses Bunest TcpClientProxy + 4-byte length-prefixed framing (encodeFrame/FrameDecoder) and Promise request-reply instead of RxJS Observable stream.",
  },
  () => {
    let server: Bun.TCPSocketListener<undefined>;
    let client: TcpClientProxy;
    let serverSockets: ServerConn[];
    let accepted: Promise<void>;

    beforeEach(() => {
      serverSockets = [];
      const connBySocket = new WeakMap<Bun.Socket<unknown>, ServerConn>();
      let resolveAccepted!: () => void;
      accepted = new Promise<void>((resolve) => {
        resolveAccepted = resolve;
      });

      server = Bun.listen({
        hostname: "127.0.0.1",
        port: 0,
        socket: {
          open(socket) {
            const conn: ServerConn = {
              socket,
              closed: false,
              closeResolvers: [],
              buffered: [],
            };
            connBySocket.set(socket, conn);
            serverSockets.push(conn);
            if (serverSockets.length === 2) {
              resolveAccepted();
            }
          },
          data(socket, chunk) {
            const conn = connBySocket.get(socket);
            if (!conn) {
              return;
            }
            const buf = Buffer.from(chunk);
            if (conn.dataListener) {
              conn.dataListener(buf);
            } else {
              conn.buffered.push(buf);
            }
          },
          close(socket) {
            const conn = connBySocket.get(socket);
            if (!conn || conn.closed) {
              return;
            }
            conn.closed = true;
            for (const fn of conn.closeResolvers.splice(0)) {
              fn();
            }
          },
          error() {},
        },
      });
      client = new TcpClientProxy({
        host: "127.0.0.1",
        port: server.port,
        defaultTimeoutMs: 5000,
      });
    });

    afterEach(async () => {
      await client?.close();
      for (const conn of serverSockets) {
        try {
          conn.socket.terminate();
        } catch {
          // ignore
        }
      }
      server.stop(true);
    });

    for (const closeWhileConnecting of [false, true]) {
      itAdapted(
        ["ADR-001", "ADR-008"],
        `should preserve responses after closing ${
          closeWhileConnecting ? "a connecting" : "a connected"
        } socket and reconnecting`,
        async () => {
          const connectA = client.connect();
          if (!closeWhileConnecting) {
            await connectA;
          }

          await client.close();
          const connectB = client.connect();
          await Promise.all([connectA.catch(() => {}), connectB, accepted]);

          const serverA = serverSockets[0]!;
          const serverB = serverSockets[1]!;

          const closedA = new Promise<void>((resolve) => {
            if (serverA.closed) {
              resolve();
              return;
            }
            serverA.closeResolvers.push(resolve);
          });

          const decoderB = new FrameDecoder();
          const requestOnB = new Promise<RpcRequestEnvelope>((resolve) => {
            const handleChunk = (chunk: Buffer) => {
              const frames = decoderB.push<RpcRequestEnvelope>(chunk);
              if (frames.length > 0) {
                resolve(frames[0]!);
              }
            };
            serverB.dataListener = handleChunk;
            for (const buffered of serverB.buffered.splice(0)) {
              handleChunk(buffered);
            }
          });

          // Handle rejection immediately if a stale close fails the in-flight request
          const response = client
            .send<string>("stream", {}, { timeoutMs: 3000 })
            .then(
              (value) => ({ value }),
              (error: unknown) => ({ error }),
            );

          const packet = await requestOnB;

          // Trigger late FIN on the stale connection while serverB's request is in flight.
          // Upstream only calls serverA.end() (relying on the client half closing cleanly).
          if (!serverA.closed) {
            serverA.socket.end();
          }
          let closeTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              closedA,
              new Promise<never>((_, reject) => {
                closeTimer = setTimeout(
                  () =>
                    reject(
                      new Error(
                        "Timed out waiting for stale connection A to close after serverA.end()",
                      ),
                    ),
                  1500,
                );
              }),
            ]);
          } finally {
            if (closeTimer) clearTimeout(closeTimer);
          }
          await Bun.sleep(25);

          serverB.socket.write(
            encodeFrame({
              type: "response",
              id: packet.id,
              response: "ab",
              isDisposed: true,
            } satisfies RpcResponseEnvelope),
          );

          expect(await response).toEqual({ value: "ab" });
          await client.connect();
          expect(serverSockets).toHaveLength(2);
        },
        "4-byte length-prefixed framing + single Promise response",
      );
    }
  },
);
