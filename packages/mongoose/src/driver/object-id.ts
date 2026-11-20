import { randomBytes } from "node:crypto";

const HEX_24_REGEX = /^[0-9a-fA-F]{24}$/;
const PROCESS_UNIQUE = randomBytes(5);
let objectIdCounter = Math.floor(Math.random() * 0xffffff);

/**
 * MongoDB BSON-spec 12-byte (24-hex-char) ObjectId implementation with zero
 * external dependencies.
 */
export class ObjectId {
  readonly _bsontype = "ObjectId" as const;
  readonly id: Uint8Array;
  private readonly hex: string;

  constructor(input?: string | number | Uint8Array | ObjectId | { toHexString(): string }) {
    if (input instanceof ObjectId) {
      this.id = new Uint8Array(input.id);
      this.hex = input.hex;
      return;
    }

    if (
      input !== undefined &&
      input !== null &&
      typeof input === "object" &&
      "toHexString" in input &&
      typeof input.toHexString === "function"
    ) {
      const hexStr = input.toHexString();
      if (!HEX_24_REGEX.test(hexStr)) {
        throw new TypeError(`Invalid ObjectId hex string: "${hexStr}"`);
      }
      this.hex = hexStr.toLowerCase();
      this.id = ObjectId.hexToBytes(this.hex);
      return;
    }

    if (typeof input === "string") {
      if (!HEX_24_REGEX.test(input)) {
        throw new TypeError(
          `input must be a 24 character hex string, 12 byte Uint8Array, or an integer`,
        );
      }
      this.hex = input.toLowerCase();
      this.id = ObjectId.hexToBytes(this.hex);
      return;
    }

    if (input instanceof Uint8Array) {
      if (input.byteLength !== 12) {
        throw new TypeError("Uint8Array ObjectId must be exactly 12 bytes");
      }
      this.id = new Uint8Array(input);
      this.hex = ObjectId.bytesToHex(this.id);
      return;
    }

    if (typeof input === "number" && Number.isInteger(input)) {
      this.id = ObjectId.generate(input);
      this.hex = ObjectId.bytesToHex(this.id);
      return;
    }

    if (input === undefined) {
      this.id = ObjectId.generate();
      this.hex = ObjectId.bytesToHex(this.id);
      return;
    }

    throw new TypeError(
      `Invalid ObjectId input: expected 24-char hex string, 12-byte Uint8Array, integer timestamp, or ObjectId`,
    );
  }

  static generate(timeSeconds?: number): Uint8Array {
    const time =
      typeof timeSeconds === "number"
        ? Math.floor(timeSeconds)
        : Math.floor(Date.now() / 1000);
    const bytes = new Uint8Array(12);
    bytes[0] = (time >>> 24) & 0xff;
    bytes[1] = (time >>> 16) & 0xff;
    bytes[2] = (time >>> 8) & 0xff;
    bytes[3] = time & 0xff;

    bytes[4] = PROCESS_UNIQUE[0]!;
    bytes[5] = PROCESS_UNIQUE[1]!;
    bytes[6] = PROCESS_UNIQUE[2]!;
    bytes[7] = PROCESS_UNIQUE[3]!;
    bytes[8] = PROCESS_UNIQUE[4]!;

    objectIdCounter = (objectIdCounter + 1) % 0x1000000;
    bytes[9] = (objectIdCounter >>> 16) & 0xff;
    bytes[10] = (objectIdCounter >>> 8) & 0xff;
    bytes[11] = objectIdCounter & 0xff;
    return bytes;
  }

  static isValid(id: unknown): boolean {
    if (id === null || id === undefined) {
      return false;
    }
    if (id instanceof ObjectId) {
      return true;
    }
    if (typeof id === "string") {
      return HEX_24_REGEX.test(id);
    }
    if (id instanceof Uint8Array) {
      return id.byteLength === 12;
    }
    if (
      typeof id === "object" &&
      typeof (id as { toHexString?: unknown }).toHexString === "function"
    ) {
      try {
        return HEX_24_REGEX.test(
          (id as { toHexString(): string }).toHexString(),
        );
      } catch {
        return false;
      }
    }
    return false;
  }

  static createFromHexString(hexString: string): ObjectId {
    return new ObjectId(hexString);
  }

  static createFromTime(timeSeconds: number): ObjectId {
    const bytes = new Uint8Array(12);
    const t = Math.floor(timeSeconds);
    bytes[0] = (t >>> 24) & 0xff;
    bytes[1] = (t >>> 16) & 0xff;
    bytes[2] = (t >>> 8) & 0xff;
    bytes[3] = t & 0xff;
    return new ObjectId(bytes);
  }

  private static hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(12);
    for (let i = 0; i < 12; i++) {
      bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }

  private static bytesToHex(bytes: Uint8Array): string {
    let out = "";
    for (let i = 0; i < bytes.length; i++) {
      out += bytes[i]!.toString(16).padStart(2, "0");
    }
    return out;
  }

  toHexString(): string {
    return this.hex;
  }

  toString(): string {
    return this.hex;
  }

  toJSON(): string {
    return this.hex;
  }

  valueOf(): string {
    return this.hex;
  }

  getTimestamp(): Date {
    const seconds =
      ((this.id[0]! << 24) |
        (this.id[1]! << 16) |
        (this.id[2]! << 8) |
        this.id[3]!) >>>
      0;
    return new Date(seconds * 1000);
  }

  equals(otherId: unknown): boolean {
    if (otherId === null || otherId === undefined) {
      return false;
    }
    if (otherId instanceof ObjectId) {
      return this.hex === otherId.hex;
    }
    if (typeof otherId === "string") {
      return HEX_24_REGEX.test(otherId) && this.hex === otherId.toLowerCase();
    }
    if (
      typeof otherId === "object" &&
      typeof (otherId as { toHexString?: unknown }).toHexString === "function"
    ) {
      return (
        this.hex ===
        (otherId as { toHexString(): string }).toHexString().toLowerCase()
      );
    }
    return false;
  }
}
