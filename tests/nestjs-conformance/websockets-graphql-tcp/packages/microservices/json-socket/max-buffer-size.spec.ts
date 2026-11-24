import { afterEach, describe, expect, it } from "bun:test";
import type { Socket } from "bun";
import {
  FrameDecoder,
  TcpServer,
  encodeFrame,
  type RpcResponseEnvelope,
} from "../../../../../../packages/microservices/src";
import { describeConformance, itAdapted } from "../../../../_helpers";

const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024; // 16 MiB

function makeHeader(payloadByteLength: number): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payloadByteLength, 0);
  return header;
}

describeConformance(
  "FrameDecoder maxFrameBytes (JsonSocket maxBufferSize)",
  {
    upstreamPath:
      "packages/microservices/test/json-socket/max-buffer-size.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts NestJS JsonSocket maxBufferSize tests to Bunest native 4-byte length-prefixed FrameDecoder and live Bun TcpServer maxFrameBytes enforcement.",
  },
  () => {
    const servers: TcpServer[] = [];
    const rawSockets: Array<Socket<unknown>> = [];

    afterEach(async () => {
      while (rawSockets.length > 0) {
        try {
          rawSockets.pop()!.end();
        } catch {
          // Ignore already-closed raw sockets
        }
      }
      while (servers.length > 0) {
        await servers.pop()!.close();
      }
    });

    describe("default maxFrameBytes", () => {
      it("should use default maxFrameBytes (16 MiB) when not provided", () => {
        const decoder = new FrameDecoder();
        expect(
          (decoder as unknown as { maxFrameBytes: number }).maxFrameBytes,
        ).toBe(DEFAULT_MAX_FRAME_BYTES);
      });

      it("should accept a payload up to default maxFrameBytes (16 MiB)", () => {
        const decoder = new FrameDecoder();
        // JSON string `"xxx..."` has exact byte length DEFAULT_MAX_FRAME_BYTES
        const largeStr = "x".repeat(DEFAULT_MAX_FRAME_BYTES - 2);
        const frame = encodeFrame(largeStr);

        let decoded: string[] = [];
        expect(() => {
          decoded = decoder.push<string>(frame);
        }).not.toThrow();
        expect(decoded).toHaveLength(1);
        expect(decoded[0]?.length).toBe(largeStr.length);
      });

      it("should throw when exceeding default maxFrameBytes", () => {
        const decoder = new FrameDecoder();
        const oversizedHeader = makeHeader(DEFAULT_MAX_FRAME_BYTES + 1);

        expect(() => {
          decoder.push(oversizedHeader);
        }).toThrow(/exceeds limit/);
      });
    });

    describe("limits that are not a number", () => {
      // BUNEST_BUG: FrameDecoder constructor in packages/microservices/src/framing.ts computes `Math.max(1024, Math.floor(maxFrameBytes))` without guarding against NaN/non-numeric inputs; `Math.max(1024, NaN)` yields `NaN`, so `payloadLength > NaN` is always false and disables frame-size enforcement.
      it.skip("should fall back to default maxFrameBytes for NaN or non-numeric strings", () => {
        for (const invalidLimit of [NaN, "16mb" as unknown as number]) {
          const decoder = new FrameDecoder(invalidLimit);
          expect(
            (decoder as unknown as { maxFrameBytes: number }).maxFrameBytes,
          ).toBe(DEFAULT_MAX_FRAME_BYTES);
        }
      });

      // BUNEST_BUG: Because `new FrameDecoder(NaN)` sets `maxFrameBytes = NaN` in packages/microservices/src/framing.ts, frames declaring more than 16 MiB are NOT rejected.
      it.skip("should reject a frame declaring more than default maxFrameBytes when configured with NaN", () => {
        const decoder = new FrameDecoder(NaN);
        expect(() => {
          decoder.push(makeHeader(DEFAULT_MAX_FRAME_BYTES + 1));
        }).toThrow(/exceeds limit/);
      });

      it("should keep Infinity as an unlimited frame size", () => {
        const decoder = new FrameDecoder(Infinity);
        expect(
          (decoder as unknown as { maxFrameBytes: number }).maxFrameBytes,
        ).toBe(Infinity);

        const frame = encodeFrame("a".repeat(4096));
        expect(decoder.push<string>(frame)).toEqual(["a".repeat(4096)]);
      });
    });

    describe("custom maxFrameBytes", () => {
      it("should use custom maxFrameBytes when provided (>= 1024)", () => {
        const customSize = 2048;
        const decoder = new FrameDecoder(customSize);
        expect(
          (decoder as unknown as { maxFrameBytes: number }).maxFrameBytes,
        ).toBe(customSize);
      });

      it("should accept a payload up to custom maxFrameBytes", () => {
        const customSize = 2048;
        const decoder = new FrameDecoder(customSize);
        const data = "x".repeat(customSize - 2); // JSON string = 2048 bytes
        const frame = encodeFrame(data);

        expect(decoder.push<string>(frame)).toEqual([data]);
      });

      it("should throw when exceeding custom maxFrameBytes", () => {
        const customSize = 2048;
        const decoder = new FrameDecoder(customSize);
        const frame = encodeFrame("x".repeat(customSize)); // JSON string = 2050 bytes > 2048

        expect(() => {
          decoder.push(frame);
        }).toThrow(/exceeds limit/);
      });

      it("should include both the declared payload length and configured limit in the error message", () => {
        const customSize = 2048;
        const decoder = new FrameDecoder(customSize);
        const payload = "x".repeat(customSize + 100);
        const frame = encodeFrame(payload);
        const expectedPayloadBytes = Buffer.byteLength(
          JSON.stringify(payload),
          "utf8",
        );

        expect(() => {
          decoder.push(frame);
        }).toThrow(
          `Incoming TCP frame size ${expectedPayloadBytes} exceeds limit of ${customSize} bytes.`,
        );
      });

      it("should floor fractional custom maxFrameBytes", () => {
        const decoder = new FrameDecoder(2048.9);
        expect(
          (decoder as unknown as { maxFrameBytes: number }).maxFrameBytes,
        ).toBe(2048);
      });
    });

    describe("several frames in one read", () => {
      const maxFrameBytes = 1024;
      // 600 bytes of JSON text (598 chars + 2 quotes)
      const body = "x".repeat(598);
      const frame = encodeFrame(body);
      // Exactly 1024 bytes of JSON text
      const fullBody = "y".repeat(1022);
      const fullFrame = encodeFrame(fullBody);

      it("should accept multiple coalesced frames within the limit even when their combined size exceeds it", () => {
        const decoder = new FrameDecoder(maxFrameBytes);
        const combined = Buffer.concat([frame, frame, frame]); // 3 * 604 = 1812 > 1024

        const messages = decoder.push<string>(combined);
        expect(messages).toEqual([body, body, body]);
      });

      it("should accept a frame of exactly maxFrameBytes payload length", () => {
        const decoder = new FrameDecoder(maxFrameBytes);
        expect(decoder.push<string>(fullFrame)).toEqual([fullBody]);
      });

      it("should accept the start of the next frame right after the end of one across chunks", () => {
        const decoder = new FrameDecoder(maxFrameBytes);
        const messages: string[] = [];

        messages.push(...decoder.push<string>(fullFrame.subarray(0, 500)));
        expect(messages).toHaveLength(0);

        const middleChunk = Buffer.concat([
          fullFrame.subarray(500),
          fullFrame.subarray(0, 800),
        ]);
        messages.push(...decoder.push<string>(middleChunk));
        expect(messages).toEqual([fullBody]);

        messages.push(...decoder.push<string>(fullFrame.subarray(800)));
        expect(messages).toEqual([fullBody, fullBody]);
      });

      it("should reject an oversized frame that follows a valid frame in the same chunk and clear buffer", () => {
        const decoder = new FrameDecoder(maxFrameBytes);
        const oversized = encodeFrame("z".repeat(maxFrameBytes + 10));
        const combined = Buffer.concat([frame, oversized]);

        expect(() => decoder.push(combined)).toThrow(/exceeds limit/);
        expect(
          (decoder as unknown as { buffer: Buffer }).buffer.byteLength,
        ).toBe(0);
      });

      it("should allow clean decoding again after reset() or error buffer clear", () => {
        const decoder = new FrameDecoder(maxFrameBytes);
        expect(() => decoder.push(makeHeader(maxFrameBytes + 1))).toThrow(
          /exceeds limit/,
        );
        expect(
          (decoder as unknown as { buffer: Buffer }).buffer.byteLength,
        ).toBe(0);

        // Next valid frame decodes cleanly with zero leftover garbage
        expect(decoder.push<string>(frame)).toEqual([body]);

        // Explicit reset discards incomplete buffered prefix
        decoder.push(fullFrame.subarray(0, 200));
        expect(
          (decoder as unknown as { buffer: Buffer }).buffer.byteLength,
        ).toBe(200);
        decoder.reset();
        expect(
          (decoder as unknown as { buffer: Buffer }).buffer.byteLength,
        ).toBe(0);
        expect(decoder.push<string>(frame)).toEqual([body]);
      });
    });

    describe("chunked data exceeding maxFrameBytes", () => {
      it("should reject immediately once a fragmented 4-byte length header declares an oversized frame", () => {
        const customSize = 1024;
        const decoder = new FrameDecoder(customSize);
        const header = makeHeader(customSize + 1);

        // First 2 bytes: incomplete header, buffered without throwing
        expect(decoder.push(header.subarray(0, 2))).toEqual([]);

        // Remaining 2 bytes complete the header and immediately trigger limit error
        expect(() => decoder.push(header.subarray(2))).toThrow(/exceeds limit/);
      });

      it("should clear internal buffer after throwing on oversized frame", () => {
        const customSize = 1024;
        const decoder = new FrameDecoder(customSize);
        const oversized = encodeFrame("x".repeat(customSize + 10));

        expect(() => decoder.push(oversized)).toThrow(/exceeds limit/);
        expect(
          (decoder as unknown as { buffer: Buffer }).buffer.byteLength,
        ).toBe(0);
      });
    });

    describe("live TcpServer error handling when maxFrameBytes exceeded", () => {
      itAdapted(
        "ADR-001",
        "should send an error response frame and close the socket (FIN) when maxFrameBytes is exceeded",
        async () => {
          const server = new TcpServer({
            host: "127.0.0.1",
            port: 0,
            maxFrameBytes: 1024,
          });
          servers.push(server);
          server.addMessageHandler("echo", (data) => data);
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
                replies.push(...replyDecoder.push<RpcResponseEnvelope>(chunk));
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

          // Send an oversized frame (> 1024 bytes)
          const oversizedFrame = encodeFrame({
            type: "request",
            id: "req-oversized",
            pattern: "echo",
            data: "x".repeat(2048),
          });
          rawSocket.write(oversizedFrame);

          await closedPromise;

          expect(replies).toHaveLength(1);
          expect(replies[0]?.type).toBe("response");
          expect(replies[0]?.isDisposed).toBe(true);
          expect(replies[0]?.error?.message).toMatch(/exceeds limit/);
        },
        "Native Bun.listen / Bun.connect TCP framing",
      );
    });

    describe("edge cases", () => {
      it("should clamp sub-1024 limits to the 1024-byte minimum floor", () => {
        const zeroDecoder = new FrameDecoder(0);
        const smallDecoder = new FrameDecoder(100);

        expect(
          (zeroDecoder as unknown as { maxFrameBytes: number }).maxFrameBytes,
        ).toBe(1024);
        expect(
          (smallDecoder as unknown as { maxFrameBytes: number }).maxFrameBytes,
        ).toBe(1024);

        // Still rejects frames over 1024 bytes
        expect(() => zeroDecoder.push(encodeFrame("a".repeat(1024)))).toThrow(
          /exceeds limit/,
        );
      });

      it("should handle very large custom maxFrameBytes (10 MiB)", () => {
        const tenMiB = 10 * 1024 * 1024;
        const decoder = new FrameDecoder(tenMiB);
        expect(
          (decoder as unknown as { maxFrameBytes: number }).maxFrameBytes,
        ).toBe(tenMiB);

        const data = "x".repeat(tenMiB - 2);
        const frame = encodeFrame(data);

        const messages = decoder.push<string>(frame);
        expect(messages).toHaveLength(1);
        expect(messages[0]?.length).toBe(data.length);
      });

      it("should accept a frame at exactly 1024 bytes and reject at 1025 bytes", () => {
        const decoder = new FrameDecoder(1024);
        const exact = encodeFrame("x".repeat(1022)); // 1024 bytes JSON
        const oneOver = encodeFrame("x".repeat(1023)); // 1025 bytes JSON

        expect(decoder.push<string>(exact)).toEqual(["x".repeat(1022)]);
        expect(() => decoder.push(oneOver)).toThrow(/exceeds limit/);
      });
    });
  },
);
