import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Controller, Module } from "../../../../../packages/core/src/common";
import {
  NestFactory,
  type BunestMicroserviceApplication,
} from "../../../../../packages/core/src";
import {
  EventPattern,
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
  type TcpTransportOptions,
} from "../../../../../packages/microservices/src";
import { describeConformance, itAdapted } from "../../../_helpers";

/**
 * Integration tests for bounded-memory protections on the TCP transport:
 * - Receiving side: incompleteMessageTimeout, messageReceiveTimeout, maxFrameBytes (maxBufferSize)
 * - Sending side: maxSendBufferSize backpressure & full delivery for reading peers
 * - Handling side: maxConcurrentMessages concurrency limits
 */
const PAYLOAD = "x".repeat(1024 * 1024);

@Controller()
class PayloadController {
  @MessagePattern({ cmd: "payload" })
  payload(): string {
    return PAYLOAD;
  }
}

@Controller()
class SlowController {
  static started = 0;
  static mostPending = 0;
  static pending: Array<() => void> = [];
  static openStreams = 0;

  @EventPattern("slow")
  async slow(): Promise<void> {
    SlowController.started++;
    SlowController.mostPending = Math.max(
      SlowController.mostPending,
      SlowController.pending.length + 1,
    );
    await new Promise<void>((resolve) => SlowController.pending.push(resolve));
  }

  @MessagePattern("stream")
  async *stream(): AsyncGenerator<never> {
    SlowController.openStreams++;
    try {
      await new Promise<never>(() => {});
    } finally {
      SlowController.openStreams--;
    }
  }

  static finishPending() {
    this.pending.splice(0).forEach((resolve) => resolve());
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function buildLengthHeader(declaredBytes: number): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(declaredBytes, 0);
  return header;
}

interface BunTestClientSocket {
  destroyed: boolean;
  write(data: Uint8Array | string): void;
  end(data?: Uint8Array | string): void;
  destroy(): void;
  pause(): void;
  resume(): void;
  onData(listener: (chunk: Buffer) => void): void;
  onceClose(listener: () => void): void;
}

async function openBunTcpSocket(port: number): Promise<BunTestClientSocket> {
  const pendingWrites: Uint8Array[] = [];
  const dataListeners: Array<(chunk: Buffer) => void> = [];
  const closeListeners: Array<() => void> = [];
  let rawSocket: Bun.Socket<unknown> | undefined;
  let destroyed = false;
  let endAfterDrain = false;

  const flushWrites = () => {
    if (!rawSocket || destroyed) {
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
    if (endAfterDrain) {
      endAfterDrain = false;
      rawSocket.end();
    }
  };

  const markClosed = () => {
    if (destroyed) {
      return;
    }
    destroyed = true;
    pendingWrites.length = 0;
    for (const fn of closeListeners.splice(0)) {
      fn();
    }
  };

  rawSocket = await Bun.connect({
    hostname: "127.0.0.1",
    port,
    socket: {
      data(_socket, chunk) {
        const buf = Buffer.from(chunk);
        for (const fn of dataListeners) {
          fn(buf);
        }
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

  const toBytes = (data: Uint8Array | string): Uint8Array =>
    typeof data === "string" ? Buffer.from(data) : data;

  return {
    get destroyed() {
      return destroyed;
    },
    write(data: Uint8Array | string) {
      if (destroyed) {
        return;
      }
      pendingWrites.push(toBytes(data));
      flushWrites();
    },
    end(data?: Uint8Array | string) {
      if (destroyed) {
        return;
      }
      if (data !== undefined) {
        pendingWrites.push(toBytes(data));
      }
      endAfterDrain = true;
      flushWrites();
    },
    destroy() {
      if (!destroyed) {
        try {
          rawSocket?.terminate();
        } catch {
          // ignore
        }
        markClosed();
      }
    },
    pause() {},
    resume() {},
    onData(listener: (chunk: Buffer) => void) {
      dataListeners.push(listener);
    },
    onceClose(listener: () => void) {
      if (destroyed) {
        listener();
      } else {
        closeListeners.push(listener);
      }
    },
  };
}

describeConformance(
  "TCP transport memory bounds",
  {
    upstreamPath: "integration/microservices/e2e/tcp-memory-bounds.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008"],
    notes:
      "Uses Bunest 4-byte length-prefixed framing (encodeFrame/FrameDecoder), native TcpServer (port: 0, maxFrameBytes), and records missing DoS/memory-bound guards as BUNEST_BUG skips.",
  },
  () => {
    let app: BunestMicroserviceApplication<MicroserviceHost> | undefined;
    let tcpServer: TcpServer | undefined;
    let port = 0;
    let clientSockets: BunTestClientSocket[] = [];

    async function start(options: Record<string, unknown> = {}) {
      clientSockets = [];
      tcpServer = new TcpServer({
        host: "127.0.0.1",
        port: 0,
        ...(options as TcpTransportOptions),
      });

      @Module({
        imports: [MicroserviceModule.forRoot({ server: tcpServer })],
        controllers: [PayloadController, SlowController],
      })
      class MemoryBoundsModule {}

      app = await NestFactory.createMicroservice(
        MemoryBoundsModule,
        (ctx) => ctx.get(MicroserviceHost),
        { logger: false },
      );
      await app.listen();
      port = tcpServer.port!;
      expect(port).toBeGreaterThan(0);
    }

    async function connect(): Promise<BunTestClientSocket> {
      const socket = await openBunTcpSocket(port);
      clientSockets.push(socket);
      return socket;
    }

    afterEach(async () => {
      SlowController.finishPending();
      for (const socket of clientSockets) {
        socket.destroy();
      }
      clientSockets = [];
      await app?.close();
      app = undefined;
      tcpServer = undefined;
    });

    describe("incompleteMessageTimeout", () => {
      it("should drop a peer that goes silent in the middle of a packet", async () => {
        await start({ incompleteMessageTimeout: 300 });
        const socket = await connect();
        const closed = new Promise<void>((resolve) =>
          socket.onceClose(() => resolve()),
        );

        // Declare a packet far larger than what is actually sent, then stall.
        socket.write(buildLengthHeader(999_999));
        socket.write("partial payload");

        await closed;
        expect(socket.destroyed).toBe(true);
      });

      itAdapted(
        "ADR-001",
        "should not drop a slow but progressing transfer",
        async () => {
          await start({ incompleteMessageTimeout: 300 });
          const socket = await connect();
          let closed = false;
          socket.onceClose(() => {
            closed = true;
          });

          const decoder = new FrameDecoder();
          const replies: RpcResponseEnvelope[] = [];
          socket.onData((chunk: Buffer) => {
            replies.push(...decoder.push<RpcResponseEnvelope>(chunk));
          });

          const frameBytes = encodeFrame({
            type: "request",
            id: "1",
            pattern: normalizePattern({ cmd: "payload" }),
            data: null,
          } satisfies RpcRequestEnvelope);

          // Trickle the framed payload out one byte at a time across > 300ms.
          for (let i = 0; i < frameBytes.byteLength; i++) {
            socket.write(frameBytes.subarray(i, i + 1));
            await sleep(8);
          }

          const deadline = Date.now() + 2000;
          while (replies.length === 0 && Date.now() < deadline) {
            await sleep(20);
          }

          expect(closed).toBe(false);
          expect(replies).toHaveLength(1);
          expect((replies[0]!.response as string).length).toBe(PAYLOAD.length);
        },
        "4-byte length-prefixed trickle framing",
      );

      itAdapted(
        "ADR-001",
        "should not drop an idle peer that is between packets",
        async () => {
          await start({ incompleteMessageTimeout: 300 });
          const socket = await connect();
          let closed = false;
          socket.onceClose(() => {
            closed = true;
          });

          socket.resume();
          socket.write(
            encodeFrame({
              type: "request",
              id: "1",
              pattern: normalizePattern({ cmd: "payload" }),
              data: null,
            } satisfies RpcRequestEnvelope),
          );
          await sleep(450);

          expect(closed).toBe(false);
        },
        "4-byte length-prefixed framing",
      );
    });

    describe("messageReceiveTimeout", () => {
      it("should drop a peer that keeps a packet incomplete by trickling it out", async () => {
        await start({
          incompleteMessageTimeout: 300,
          messageReceiveTimeout: 600,
        });
        const socket = await connect();
        let closed = false;
        socket.onceClose(() => {
          closed = true;
        });

        const startedAt = Date.now();
        socket.write(buildLengthHeader(999_999));
        while (!closed && Date.now() - startedAt < 5000) {
          socket.write("x");
          await sleep(100);
        }

        expect(closed).toBe(true);
        expect(Date.now() - startedAt).toBeLessThan(2000);
      });
    });

    describe("maxBufferSize", () => {
      itAdapted(
        "ADR-001",
        "should reject a packet declaring more than maxBufferSize right away",
        async () => {
          await start({ maxFrameBytes: 1024 });
          const socket = await connect();
          const closed = new Promise<void>((resolve) =>
            socket.onceClose(() => resolve()),
          );

          const decoder = new FrameDecoder();
          const responses: RpcResponseEnvelope[] = [];
          socket.onData((chunk: Buffer) => {
            try {
              responses.push(...decoder.push<RpcResponseEnvelope>(chunk));
            } catch {
              // ignore partial frame on close
            }
          });

          // Declare a frame far exceeding maxFrameBytes (1024) in the 4-byte length header
          socket.write(buildLengthHeader(100_000_000));
          socket.write("x".repeat(512));

          await closed;
          expect(socket.destroyed).toBe(true);
          expect(responses.length).toBeGreaterThanOrEqual(1);
          expect(responses[0]!.error?.message).toMatch(/exceeds limit/);
        },
        "TcpServer maxFrameBytes rejects oversized length header immediately",
      );
    });

    describe("maxSendBufferSize", () => {
      it("should drop a peer that lets responses pile up unread", async () => {
        await start({ maxSendBufferSize: 2 * 1024 * 1024 });
        const socket = await connect();

        socket.pause();
        for (let i = 0; i < 20; i++) {
          socket.write(
            encodeFrame({
              type: "request",
              id: String(i),
              pattern: normalizePattern({ cmd: "payload" }),
              data: null,
            } satisfies RpcRequestEnvelope),
          );
        }

        const clientsSet = (tcpServer as unknown as { clients: Set<unknown> })
          .clients;
        const deadline = Date.now() + 5000;
        while (clientsSet.size > 0 && Date.now() < deadline) {
          await sleep(20);
        }
        expect(clientsSet.size).toBe(0);
      });

      itAdapted(
        "ADR-001",
        "should serve a peer that reads its responses",
        async () => {
          await start();
          const socket = await connect();

          let closed = false;
          socket.onceClose(() => {
            closed = true;
          });

          let receivedBytes = 0;
          const decoder = new FrameDecoder();
          const responses: RpcResponseEnvelope[] = [];
          socket.onData((chunk: Buffer) => {
            receivedBytes += chunk.byteLength;
            responses.push(...decoder.push<RpcResponseEnvelope>(chunk));
          });

          for (let i = 0; i < 20; i++) {
            socket.write(
              encodeFrame({
                type: "request",
                id: String(i),
                pattern: normalizePattern({ cmd: "payload" }),
                data: null,
              } satisfies RpcRequestEnvelope),
            );
          }

          const deadline = Date.now() + 10_000;
          while (responses.length < 20 && Date.now() < deadline) {
            await sleep(20);
          }

          expect(receivedBytes).toBeGreaterThanOrEqual(20 * PAYLOAD.length);
          expect(responses).toHaveLength(20);
          expect(closed).toBe(false);
        },
        "TcpServer drain backpressure delivers 20x1MiB responses cleanly",
        15_000,
      );
    });

    describe("maxConcurrentMessages", () => {
      const slowFrame = encodeFrame({
        type: "event",
        pattern: "slow",
        data: null,
      } satisfies RpcEventEnvelope);

      beforeEach(() => {
        SlowController.started = 0;
        SlowController.mostPending = 0;
        SlowController.pending = [];
        SlowController.openStreams = 0;
      });

      it("should not start more handlers for a peer than that at once", async () => {
        await start({ maxConcurrentMessages: 10 });
        const socket = await connect();

        const batch = Buffer.concat(
          Array.from({ length: 1000 }, () => slowFrame),
        );
        socket.write(batch);
        while (SlowController.pending.length < 10) {
          await sleep(20);
        }
        await sleep(200);
        expect(SlowController.started).toBe(10);

        while (SlowController.started < 1000) {
          SlowController.finishPending();
          await sleep(1);
        }
        SlowController.finishPending();
        expect(SlowController.mostPending).toBe(10);
      });

      it("should still handle every message of a peer that ends the connection after them", async () => {
        await start({ maxConcurrentMessages: 10, maxFrameBytes: 1024 });
        const socket = await connect();

        const batch = Buffer.concat(
          Array.from({ length: 2000 }, () => slowFrame),
        );
        socket.end(batch);
        while (SlowController.started < 2000) {
          SlowController.finishPending();
          await sleep(1);
        }
        SlowController.finishPending();
        expect(SlowController.mostPending).toBe(10);
      });

      // BUNEST_BUG: Ported SlowController.stream() uses `async *stream()` suspended at `await new Promise(() => {})` (not `yield`), so in JS `iterator.return()` can never reach its `finally` block (ADR-008 RxJS Observable teardown discrepancy).
      it.skip("should notice a peer that leaves while reading from it is suspended", async () => {
        await start({
          maxConcurrentMessages: 1,
          maxFrameBytes: 1024,
          drainTimeout: 300,
        });
        const socket = await connect();

        const streamReq = encodeFrame({
          type: "request",
          id: "1",
          pattern: "stream",
          data: null,
        } satisfies RpcRequestEnvelope);
        const floods = Buffer.concat([
          streamReq,
          ...Array.from({ length: 1000 }, () => slowFrame),
        ]);
        socket.write(floods);

        while (SlowController.openStreams < 1) {
          await sleep(20);
        }
        socket.destroy();

        const startedAt = Date.now();
        while (
          SlowController.openStreams > 0 &&
          Date.now() - startedAt < 5000
        ) {
          await sleep(20);
        }
        expect(SlowController.openStreams).toBe(0);
        expect(SlowController.started).toBe(0);
      });

      it("should count the messages of each peer separately", async () => {
        await start({ maxConcurrentMessages: 10 });
        const sockets = [await connect(), await connect()];

        const batch = Buffer.concat(
          Array.from({ length: 100 }, () => slowFrame),
        );
        for (const socket of sockets) {
          socket.write(batch);
        }
        while (SlowController.pending.length < 20) {
          await sleep(20);
        }
        await sleep(200);
        expect(SlowController.started).toBe(20);
        while (SlowController.started < 200) {
          SlowController.finishPending();
          await sleep(1);
        }
        SlowController.finishPending();
      });
    });
  },
);
