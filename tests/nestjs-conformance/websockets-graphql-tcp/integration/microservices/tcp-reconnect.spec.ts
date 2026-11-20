import "reflect-metadata";
import { afterEach, beforeEach, expect } from "bun:test";
import { once } from "node:events";
import * as net from "node:net";
import {
  FrameDecoder,
  TcpClientProxy,
  encodeFrame,
  type RpcRequestEnvelope,
  type RpcResponseEnvelope,
} from "../../../../../packages/microservices/src";
import { describeConformance, itAdapted } from "../../../_helpers";

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
    let server: net.Server;
    let client: TcpClientProxy;
    let serverSockets: net.Socket[];
    let accepted: Promise<void>;

    beforeEach(async () => {
      serverSockets = [];
      // Keep the old connection half-open until the new one has a pending
      // request, so its late close is controlled by real TCP FINs, not timers.
      server = net.createServer({ allowHalfOpen: true });
      accepted = new Promise<void>((resolve) => {
        server.on("connection", (socket) => {
          serverSockets.push(socket);
          socket.on("error", () => {});
          if (serverSockets.length === 2) {
            resolve();
          }
        });
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      client = new TcpClientProxy({
        host: "127.0.0.1",
        port: (server.address() as net.AddressInfo).port,
        defaultTimeoutMs: 5000,
      });
    });

    afterEach(async () => {
      await client?.close();
      for (const socket of serverSockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
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
            if (serverA.destroyed) {
              resolve();
              return;
            }
            serverA.once("close", () => resolve());
          });

          const decoderB = new FrameDecoder();
          const requestOnB = new Promise<RpcRequestEnvelope>((resolve) => {
            serverB.on("data", (chunk: Buffer) => {
              const frames = decoderB.push<RpcRequestEnvelope>(chunk);
              if (frames.length > 0) {
                resolve(frames[0]!);
              }
            });
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
          serverA.end();
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

          serverB.write(
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
