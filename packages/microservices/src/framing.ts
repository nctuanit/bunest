const HEADER_BYTES = 4;
const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024; // 16 MiB

/**
 * Encodes a JSON-serializable message into a 4-byte big-endian length-prefixed UTF-8 frame.
 */
export function encodeFrame(payload: unknown): Uint8Array {
  const jsonBytes = Buffer.from(JSON.stringify(payload), "utf8");
  const frame = Buffer.allocUnsafe(HEADER_BYTES + jsonBytes.byteLength);
  frame.writeUInt32BE(jsonBytes.byteLength, 0);
  jsonBytes.copy(frame, HEADER_BYTES);
  return frame;
}

/**
 * Streaming decoder for 4-byte length-prefixed UTF-8 JSON frames.
 * Safely reassembles arbitrary TCP packet fragmentation and coalesced frames
 * while enforcing a strict maximum frame byte size.
 */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  private readonly maxFrameBytes: number;

  constructor(maxFrameBytes: number = DEFAULT_MAX_FRAME_BYTES) {
    if (typeof maxFrameBytes !== "number" || Number.isNaN(maxFrameBytes)) {
      this.maxFrameBytes = DEFAULT_MAX_FRAME_BYTES;
    } else if (maxFrameBytes === Infinity) {
      this.maxFrameBytes = Infinity;
    } else {
      this.maxFrameBytes = Math.max(1024, Math.floor(maxFrameBytes));
    }
  }

  push<T = unknown>(chunk: Uint8Array | Buffer): T[] {
    const incoming = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);

    this.buffer =
      this.buffer.byteLength === 0
        ? Buffer.from(incoming)
        : Buffer.concat([this.buffer, incoming]);

    const messages: T[] = [];

    while (this.buffer.byteLength >= HEADER_BYTES) {
      const payloadLength = this.buffer.readUInt32BE(0);
      if (payloadLength > this.maxFrameBytes) {
        this.buffer = Buffer.alloc(0);
        throw new Error(
          `Incoming TCP frame size ${payloadLength} exceeds limit of ${this.maxFrameBytes} bytes.`,
        );
      }

      const totalLength = HEADER_BYTES + payloadLength;
      if (this.buffer.byteLength < totalLength) {
        break;
      }

      const payloadSlice = this.buffer.subarray(HEADER_BYTES, totalLength);
      const rawJson = payloadSlice.toString("utf8");
      this.buffer =
        this.buffer.byteLength === totalLength
          ? Buffer.alloc(0)
          : Buffer.from(this.buffer.subarray(totalLength));

      messages.push(JSON.parse(rawJson) as T);
    }

    return messages;
  }

  reset(): void {
    this.buffer = Buffer.alloc(0);
  }
}
