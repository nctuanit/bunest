import "reflect-metadata";
import { afterEach, beforeEach, expect } from "bun:test";
import type { Socket } from "bun";
import { Controller, Module } from "../../../../../packages/common/src";
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
  type RpcEventEnvelope,
  type RpcRequestEnvelope,
  type RpcResponseEnvelope,
} from "../../../../../packages/microservices/src";
import { describeConformance, itAdapted } from "../../../_helpers";

/**
 * Integration test for TCP pipelined-frames stack-overflow resilience.
 *
 * Sends 12,000 back-to-back length-prefixed frames followed by a ping request
 * in a single TCP write, exercising FrameDecoder's iterative parsing loop.
 */
@Controller()
class PingController {
  @MessagePattern({ cmd: "ping" })
  ping(): string {
    return "pong";
  }
}

describeConformance(
  "TCP pipelined frames – stack-overflow regression (CVE fix)",
  {
    upstreamPath:
      "integration/microservices/e2e/tcp-json-socket-pipeline.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Uses Bunest 4-byte length-prefixed JSON framing (encodeFrame/FrameDecoder), native Bun.connect, and ephemeral port: 0 TcpServer.",
  },
  () => {
    let app: BunestMicroserviceApplication<MicroserviceHost> | undefined;
    let tcpServer: TcpServer | undefined;
    let port = 0;

    beforeEach(async () => {
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
      await app?.close();
      app = undefined;
      tcpServer = undefined;
    });

    itAdapted(
      "ADR-001",
      "server remains responsive after receiving a 12_000-frame pipelined burst",
      async () => {
        const FRAME_COUNT = 12_000;
        const burstFrame = encodeFrame({
          type: "event",
          pattern: "noop",
          data: null,
        } satisfies RpcEventEnvelope);

        const pingEnvelope: RpcRequestEnvelope = {
          type: "request",
          id: "integration-test-ping",
          pattern: normalizePattern({ cmd: "ping" }),
          data: null,
        };
        const pingFrame = encodeFrame(pingEnvelope);

        // Verify 4-byte big-endian length header matches JSON byte length
        const pingJsonLen = Buffer.byteLength(
          JSON.stringify(pingEnvelope),
          "utf8",
        );
        expect(
          Buffer.from(pingFrame.buffer, pingFrame.byteOffset, 4).readUInt32BE(
            0,
          ),
        ).toBe(pingJsonLen);

        const totalBytes =
          burstFrame.byteLength * FRAME_COUNT + pingFrame.byteLength;
        const combined = Buffer.allocUnsafe(totalBytes);
        let offset = 0;
        for (let i = 0; i < FRAME_COUNT; i++) {
          combined.set(burstFrame, offset);
          offset += burstFrame.byteLength;
        }
        combined.set(pingFrame, offset);

        await new Promise<void>((resolve, reject) => {
          const decoder = new FrameDecoder();
          let settled = false;
          let sock: Socket<undefined> | undefined;
          let pendingWrite: Uint8Array = combined;

          const finish = (err?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            try {
              sock?.end();
            } catch {
              // ignore already closed
            }
            if (err) {
              reject(err);
            } else {
              resolve();
            }
          };

          const flush = (socket: Socket<undefined>) => {
            while (pendingWrite.byteLength > 0) {
              const written = socket.write(pendingWrite);
              if (written === pendingWrite.byteLength) {
                pendingWrite = new Uint8Array(0);
                break;
              }
              if (written > 0) {
                pendingWrite = pendingWrite.subarray(written);
              } else {
                break;
              }
            }
          };

          const timeout = setTimeout(() => {
            finish(
              new Error(
                "Timed out waiting for pong – the server likely crashed during the burst",
              ),
            );
          }, 12_000);

          Bun.connect({
            hostname: "127.0.0.1",
            port,
            socket: {
              open(socket) {
                sock = socket;
                // Send burst + ping as one pipelined write to exercise the
                // iterative FrameDecoder.push() loop without stack overflow.
                flush(socket);
              },
              drain(socket) {
                flush(socket);
              },
              data(_socket, chunk) {
                let frames: RpcResponseEnvelope[];
                try {
                  frames = decoder.push<RpcResponseEnvelope>(chunk);
                } catch (e) {
                  finish(e as Error);
                  return;
                }
                const pong = frames.find(
                  (f) => f.id === "integration-test-ping",
                );
                if (pong) {
                  try {
                    expect(pong.response).toBe("pong");
                    expect(pong.error).toBeUndefined();
                    finish();
                  } catch (e) {
                    finish(e as Error);
                  }
                }
              },
              error(_socket, err) {
                finish(
                  new Error(
                    `Socket error (server may have crashed): ${err.message}`,
                  ),
                );
              },
              connectError(_socket, err) {
                finish(err);
              },
            },
          }).catch((err: unknown) => finish(err as Error));
        });
      },
      "4-byte length-prefixed FrameDecoder + native Bun.connect",
      15_000,
    );
  },
);
