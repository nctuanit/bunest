import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Socket } from "bun";
import {
  FrameDecoder,
  TcpClientProxy,
  TcpServer,
  encodeFrame,
  type RpcResponseEnvelope,
} from "../../../../../../packages/microservices/src";
import { describeConformance, itAdapted } from "../../../../_helpers";

function frameRawString(rawPayload: string): Buffer {
  const payloadBytes = Buffer.from(rawPayload, "utf8");
  const frame = Buffer.alloc(4 + payloadBytes.byteLength);
  frame.writeUInt32BE(payloadBytes.byteLength, 0);
  payloadBytes.copy(frame, 4);
  return frame;
}

describeConformance(
  "FrameDecoder message parsing (JsonSocket message parsing)",
  {
    upstreamPath:
      "packages/microservices/test/json-socket/message-parsing.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts NestJS JsonSocket message-parsing tests to Bunest native 4-byte BE length-prefixed UTF-8 FrameDecoder & encodeFrame, plus live TcpServer malformed-frame error+FIN behavior.",
  },
  () => {
    let decoder: FrameDecoder;
    const servers: TcpServer[] = [];
    const clients: TcpClientProxy[] = [];
    const rawSockets: Array<Socket<unknown>> = [];

    beforeEach(() => {
      decoder = new FrameDecoder();
    });

    afterEach(async () => {
      while (rawSockets.length > 0) {
        try {
          rawSockets.pop()!.end();
        } catch {
          // Ignore already-closed sockets
        }
      }
      while (clients.length > 0) {
        await clients.pop()!.close();
      }
      while (servers.length > 0) {
        await servers.pop()!.close();
      }
    });

    const getInternalBufferLength = (d: FrameDecoder): number =>
      (d as unknown as { buffer: Buffer }).buffer.byteLength;

    it("should parse JSON strings", () => {
      const messages = decoder.push<string>(encodeFrame("Hello there"));
      expect(messages).toEqual(["Hello there"]);
      expect(getInternalBufferLength(decoder)).toBe(0);
    });

    it("should parse JSON numbers", () => {
      const messages = decoder.push<number>(encodeFrame(12.34));
      expect(messages).toEqual([12.34]);
      expect(getInternalBufferLength(decoder)).toBe(0);
    });

    it("should parse JSON booleans and null", () => {
      expect(decoder.push<boolean>(encodeFrame(true))).toEqual([true]);
      expect(decoder.push<boolean>(encodeFrame(false))).toEqual([false]);
      expect(decoder.push<null>(encodeFrame(null))).toEqual([null]);
      expect(getInternalBufferLength(decoder)).toBe(0);
    });

    it("should parse JSON objects", () => {
      const messages = decoder.push<Record<string, unknown>>(
        encodeFrame({ a: "yes", b: 9 }),
      );
      expect(messages).toEqual([{ a: "yes", b: 9 }]);
      expect(getInternalBufferLength(decoder)).toBe(0);
    });

    it("should parse JSON arrays", () => {
      const messages = decoder.push<unknown[]>(encodeFrame(["yes", 9]));
      expect(messages).toEqual([["yes", 9]]);
      expect(getInternalBufferLength(decoder)).toBe(0);
    });

    it("should parse multiple messages coalesced in one packet", () => {
      const combined = Buffer.concat([encodeFrame("hey"), encodeFrame(true)]);
      const messages = decoder.push<unknown>(combined);
      expect(messages).toEqual(["hey", true]);
      expect(getInternalBufferLength(decoder)).toBe(0);
    });

    it("should parse chunked messages split mid-header and mid-payload", () => {
      const full = encodeFrame("Hello there");
      // Split inside the 4-byte length header
      expect(decoder.push(full.subarray(0, 2))).toEqual([]);
      expect(decoder.push(full.subarray(2, 7))).toEqual([]);
      const messages = decoder.push<string>(full.subarray(7));
      expect(messages).toEqual(["Hello there"]);
      expect(getInternalBufferLength(decoder)).toBe(0);
    });

    it("should parse chunked and multiple messages together", () => {
      const msg1 = encodeFrame("Hello there");
      const msg2 = encodeFrame(true);
      const chunk1 = msg1.subarray(0, 8);
      const chunk2 = Buffer.concat([msg1.subarray(8), msg2]);

      expect(decoder.push(chunk1)).toEqual([]);
      expect(decoder.push<unknown>(chunk2)).toEqual(["Hello there", true]);
      expect(getInternalBufferLength(decoder)).toBe(0);
    });

    it("should parse chunked messages split mid multi-byte UTF-8 sequence", () => {
      // `"ة"` (U+0629) is encoded in UTF-8 as [0x22, 0xd8, 0xa9, 0x22] (4 bytes)
      const frame = encodeFrame("ة");
      // Split right between the two UTF-8 bytes 0xd8 and 0xa9 (index 6)
      expect(decoder.push(frame.subarray(0, 6))).toEqual([]);
      expect(decoder.push<string>(frame.subarray(6))).toEqual(["ة"]);
      expect(getInternalBufferLength(decoder)).toBe(0);

      // 4-byte emoji split 1 byte at a time
      const emojiFrame = encodeFrame("🚀🎉");
      const out: string[] = [];
      for (let i = 0; i < emojiFrame.byteLength; i++) {
        out.push(...decoder.push<string>(emojiFrame.subarray(i, i + 1)));
      }
      expect(out).toEqual(["🚀🎉"]);
      expect(getInternalBufferLength(decoder)).toBe(0);
    });

    it("should parse multiple messages with unicode correctly", () => {
      const german = "Diese Zeile enthält das Unicode-Zeichen";
      const combined = Buffer.concat([encodeFrame(german), encodeFrame(true)]);

      const messages = decoder.push<unknown>(combined);
      expect(messages).toEqual([german, true]);
      expect(getInternalBufferLength(decoder)).toBe(0);
    });

    it("should parse multiple and chunked messages with unicode correctly", () => {
      const german = "Diese Zeile enthält das Unicode-Zeichen";
      const combined = Buffer.concat([encodeFrame(german), encodeFrame(true)]);
      const splitPoint = Math.floor(combined.byteLength / 2);

      const part1 = decoder.push<unknown>(combined.subarray(0, splitPoint));
      const part2 = decoder.push<unknown>(combined.subarray(splitPoint));

      expect([...part1, ...part2]).toEqual([german, true]);
      expect(getInternalBufferLength(decoder)).toBe(0);
    });

    it("should respect non-zero byteOffset when given a Uint8Array view slice", () => {
      const frame = encodeFrame({ ok: true });
      const padded = new Uint8Array(frame.byteLength + 10);
      padded.fill(0xff);
      padded.set(frame, 5);
      const view = new Uint8Array(padded.buffer, 5, frame.byteLength);

      expect(decoder.push(view)).toEqual([{ ok: true }]);
      expect(getInternalBufferLength(decoder)).toBe(0);
    });

    describe("Error handling", () => {
      describe("JSON Error", () => {
        const badPacket = frameRawString('"Hel');

        it("should fail to parse invalid JSON and clear the buffer", () => {
          expect(() => decoder.push(badPacket)).toThrow(SyntaxError);
          expect(getInternalBufferLength(decoder)).toBe(0);
        });

        it("should fail cleanly on a 0-length frame (empty JSON)", () => {
          const emptyFrame = Buffer.from([0, 0, 0, 0]);
          expect(() => decoder.push(emptyFrame)).toThrow(SyntaxError);
          expect(getInternalBufferLength(decoder)).toBe(0);
        });

        itAdapted(
          "ADR-001",
          "should emit an error response frame and send FIN when TcpServer receives invalid JSON",
          async () => {
            const server = new TcpServer({ host: "127.0.0.1", port: 0 });
            servers.push(server);
            server.addMessageHandler("ping", () => "pong");
            await server.listen();

            const replyDecoder = new FrameDecoder();
            const replies: RpcResponseEnvelope[] = [];
            let resolveClosed!: () => void;
            const closedPromise = new Promise<void>((res) => {
              resolveClosed = res;
            });

            const rawSocket = await Bun.connect({
              hostname: "127.0.0.1",
              port: server.port!,
              socket: {
                data(_sock, chunk) {
                  replies.push(
                    ...replyDecoder.push<RpcResponseEnvelope>(chunk),
                  );
                },
                close() {
                  resolveClosed();
                },
                error() {
                  resolveClosed();
                },
              },
            });
            rawSockets.push(rawSocket);

            rawSocket.write(badPacket);
            await closedPromise;

            expect(replies).toHaveLength(1);
            expect(replies[0]?.type).toBe("response");
            expect(replies[0]?.isDisposed).toBe(true);
            expect(replies[0]?.error?.name).toBe("SyntaxError");

            // Server must remain healthy for subsequent valid clients
            const client = new TcpClientProxy({
              host: "127.0.0.1",
              port: server.port!,
            });
            clients.push(client);
            expect(await client.send("ping", null)).toBe("pong");
          },
          "Native Bun TCP server framing error handling",
        );
      });

      describe("Corrupted length header", () => {
        // ASCII "wtf#" = 0x77746623 = 2,004,117,027 bytes (> 16 MiB default limit)
        const corruptedPacket = Buffer.from('wtf#"Hello"', "utf8");

        it("should reject corrupted length prefix and clear internal buffer", () => {
          expect(() => decoder.push(corruptedPacket)).toThrow(/exceeds limit/);
          expect(getInternalBufferLength(decoder)).toBe(0);
        });

        itAdapted(
          "ADR-001",
          "should emit an error response frame and send FIN on TcpServer for corrupted length prefix",
          async () => {
            const server = new TcpServer({ host: "127.0.0.1", port: 0 });
            servers.push(server);
            await server.listen();

            const replyDecoder = new FrameDecoder();
            const replies: RpcResponseEnvelope[] = [];
            let resolveClosed!: () => void;
            const closedPromise = new Promise<void>((res) => {
              resolveClosed = res;
            });

            const rawSocket = await Bun.connect({
              hostname: "127.0.0.1",
              port: server.port!,
              socket: {
                data(_sock, chunk) {
                  replies.push(
                    ...replyDecoder.push<RpcResponseEnvelope>(chunk),
                  );
                },
                close() {
                  resolveClosed();
                },
                error() {
                  resolveClosed();
                },
              },
            });
            rawSockets.push(rawSocket);

            rawSocket.write(corruptedPacket);
            await closedPromise;

            expect(replies).toHaveLength(1);
            expect(replies[0]?.type).toBe("response");
            expect(replies[0]?.isDisposed).toBe(true);
            expect(replies[0]?.error?.message).toMatch(/exceeds limit/);
          },
          "Native Bun TCP server corrupted header handling",
        );
      });
    });
  },
);
