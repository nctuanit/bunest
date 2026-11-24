const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

let objectIdCounter = Math.floor(Math.random() * 0xffffff);
const processRandom5 = crypto.getRandomValues(new Uint8Array(5));

/**
 * MongoDB-compatible 12-byte / 24-hex-character ObjectId backed by Bun's native CSPRNG.
 */
export class ObjectId {
  readonly bytes: Uint8Array;

  constructor(input?: string | Uint8Array | ObjectId) {
    if (input instanceof ObjectId) {
      this.bytes = new Uint8Array(input.bytes);
      return;
    }
    if (input instanceof Uint8Array) {
      if (input.length !== 12) {
        throw new Error(`ObjectId requires exactly 12 bytes, received ${input.length}.`);
      }
      this.bytes = new Uint8Array(input);
      return;
    }
    if (typeof input === "string") {
      if (!/^[0-9a-fA-F]{24}$/.test(input)) {
        throw new Error(`Invalid ObjectId hex string: "${input}".`);
      }
      const bytes = new Uint8Array(12);
      for (let i = 0; i < 12; i++) {
        bytes[i] = parseInt(input.slice(i * 2, i * 2 + 2), 16);
      }
      this.bytes = bytes;
      return;
    }

    // Generate fresh 12-byte ObjectId: 4-byte timestamp + 5-byte random + 3-byte counter
    const bytes = new Uint8Array(12);
    const view = new DataView(bytes.buffer);
    const ts = Math.floor(Date.now() / 1000) >>> 0;
    view.setUint32(0, ts, false);
    bytes.set(processRandom5, 4);
    objectIdCounter = (objectIdCounter + 1) & 0xffffff;
    bytes[9] = (objectIdCounter >>> 16) & 0xff;
    bytes[10] = (objectIdCounter >>> 8) & 0xff;
    bytes[11] = objectIdCounter & 0xff;
    this.bytes = bytes;
  }

  toHexString(): string {
    let hex = "";
    for (let i = 0; i < 12; i++) {
      hex += this.bytes[i]!.toString(16).padStart(2, "0");
    }
    return hex;
  }

  toString(): string {
    return this.toHexString();
  }

  toJSON(): string {
    return this.toHexString();
  }

  equals(other: unknown): boolean {
    if (other instanceof ObjectId) {
      return this.toHexString() === other.toHexString();
    }
    if (typeof other === "string") {
      return this.toHexString().toLowerCase() === other.toLowerCase();
    }
    return false;
  }

  static isValid(value: unknown): boolean {
    if (value instanceof ObjectId) return true;
    return typeof value === "string" && /^[0-9a-fA-F]{24}$/.test(value);
  }
}

export function generateObjectId(): string {
  return new ObjectId().toHexString();
}

// ============================================================================
// Zero-Dependency BSON Binary Encoder / Decoder (BSON Spec 1.1)
// ============================================================================

class BsonWriter {
  private buf: Uint8Array;
  private view: DataView;
  private pos = 0;

  constructor(initialSize = 256) {
    this.buf = new Uint8Array(initialSize);
    this.view = new DataView(this.buf.buffer);
  }

  private ensure(extra: number): void {
    if (this.pos + extra <= this.buf.length) return;
    let nextLen = this.buf.length * 2;
    while (nextLen < this.pos + extra) nextLen *= 2;
    const next = new Uint8Array(nextLen);
    next.set(this.buf);
    this.buf = next;
    this.view = new DataView(this.buf.buffer);
  }

  writeByte(b: number): void {
    this.ensure(1);
    this.buf[this.pos++] = b & 0xff;
  }

  writeInt32(val: number): void {
    this.ensure(4);
    this.view.setInt32(this.pos, val, true);
    this.pos += 4;
  }

  patchInt32(offset: number, val: number): void {
    this.view.setInt32(offset, val, true);
  }

  writeInt64(val: bigint): void {
    this.ensure(8);
    this.view.setBigInt64(this.pos, val, true);
    this.pos += 8;
  }

  writeDouble(val: number): void {
    this.ensure(8);
    this.view.setFloat64(this.pos, val, true);
    this.pos += 8;
  }

  writeBytes(bytes: Uint8Array): void {
    this.ensure(bytes.length);
    this.buf.set(bytes, this.pos);
    this.pos += bytes.length;
  }

  writeCString(str: string): void {
    const encoded = textEncoder.encode(str);
    this.writeBytes(encoded);
    this.writeByte(0);
  }

  writeString(str: string): void {
    const encoded = textEncoder.encode(str);
    this.writeInt32(encoded.length + 1);
    this.writeBytes(encoded);
    this.writeByte(0);
  }

  get offset(): number {
    return this.pos;
  }

  toUint8Array(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }
}

function writeBsonDocument(
  writer: BsonWriter,
  doc: Record<string, unknown>,
  ancestors: Set<object>,
): void {
  const start = writer.offset;
  writer.writeInt32(0); // Placeholder for total doc length

  ancestors.add(doc);
  try {
    for (const [key, val] of Object.entries(doc)) {
      if (val === undefined) continue;
      if (typeof val === "object" && val !== null && ancestors.has(val)) {
        continue; // Cycle-safe BSON encoding!
      }
      writeBsonElement(writer, key, val, ancestors);
    }
  } finally {
    ancestors.delete(doc);
  }

  writer.writeByte(0); // Document terminator
  writer.patchInt32(start, writer.offset - start);
}

function writeBsonArray(
  writer: BsonWriter,
  arr: readonly unknown[],
  ancestors: Set<object>,
): void {
  const start = writer.offset;
  writer.writeInt32(0);

  ancestors.add(arr as object);
  try {
    for (let i = 0; i < arr.length; i++) {
      const item = arr[i];
      if (typeof item === "object" && item !== null && ancestors.has(item)) {
        writeBsonElement(writer, String(i), null, ancestors);
      } else {
        writeBsonElement(writer, String(i), item === undefined ? null : item, ancestors);
      }
    }
  } finally {
    ancestors.delete(arr as object);
  }

  writer.writeByte(0);
  writer.patchInt32(start, writer.offset - start);
}

function writeBsonElement(
  writer: BsonWriter,
  key: string,
  val: unknown,
  ancestors: Set<object>,
): void {
  if (val === null || val === undefined) {
    writer.writeByte(0x0a);
    writer.writeCString(key);
    return;
  }
  if (typeof val === "boolean") {
    writer.writeByte(0x08);
    writer.writeCString(key);
    writer.writeByte(val ? 1 : 0);
    return;
  }
  if (typeof val === "string") {
    writer.writeByte(0x02);
    writer.writeCString(key);
    writer.writeString(val);
    return;
  }
  if (typeof val === "number") {
    if (Number.isInteger(val) && val >= -2147483648 && val <= 2147483647 && !Object.is(val, -0)) {
      writer.writeByte(0x10); // Int32
      writer.writeCString(key);
      writer.writeInt32(val);
    } else {
      writer.writeByte(0x01); // Double
      writer.writeCString(key);
      writer.writeDouble(val);
    }
    return;
  }
  if (typeof val === "bigint") {
    writer.writeByte(0x12); // Int64
    writer.writeCString(key);
    writer.writeInt64(val);
    return;
  }
  if (val instanceof Date) {
    writer.writeByte(0x09); // UTC DateTime
    writer.writeCString(key);
    writer.writeInt64(BigInt(val.getTime()));
    return;
  }
  if (val instanceof ObjectId) {
    writer.writeByte(0x07); // ObjectId
    writer.writeCString(key);
    writer.writeBytes(val.bytes);
    return;
  }
  if (val instanceof Uint8Array) {
    writer.writeByte(0x05); // Binary (Generic subtype 0x00)
    writer.writeCString(key);
    writer.writeInt32(val.length);
    writer.writeByte(0x00);
    writer.writeBytes(val);
    return;
  }
  if (val instanceof RegExp) {
    writer.writeByte(0x0b); // RegExp
    writer.writeCString(key);
    writer.writeCString(val.source);
    writer.writeCString(val.flags.split("").sort().join(""));
    return;
  }
  if (Array.isArray(val)) {
    writer.writeByte(0x04); // Array
    writer.writeCString(key);
    writeBsonArray(writer, val, ancestors);
    return;
  }
  if (typeof val === "object") {
    writer.writeByte(0x03); // Embedded document
    writer.writeCString(key);
    writeBsonDocument(writer, val as Record<string, unknown>, ancestors);
  }
}

/**
 * Encodes a JS object into a binary BSON `Uint8Array`.
 */
export function encodeBson(doc: Record<string, unknown>): Uint8Array {
  const writer = new BsonWriter();
  writeBsonDocument(writer, doc, new Set());
  return writer.toUint8Array();
}

function readCString(
  bytes: Uint8Array,
  state: { pos: number },
): string {
  const start = state.pos;
  while (state.pos < bytes.length && bytes[state.pos] !== 0) {
    state.pos++;
  }
  const str = textDecoder.decode(bytes.subarray(start, state.pos));
  state.pos++; // Skip NUL
  return str;
}

function decodeBsonDocumentAt(
  bytes: Uint8Array,
  view: DataView,
  state: { pos: number },
  asArray = false,
): Record<string, unknown> | unknown[] {
  const start = state.pos;
  const size = view.getInt32(state.pos, true);
  state.pos += 4;
  const end = start + size - 1;

  const targetObj: Record<string, unknown> = {};
  const targetArr: unknown[] = [];

  while (state.pos < end) {
    const type = bytes[state.pos++]!;
    if (type === 0) break;
    const key = readCString(bytes, state);

    let val: unknown;
    switch (type) {
      case 0x01: // Double
        val = view.getFloat64(state.pos, true);
        state.pos += 8;
        break;
      case 0x02: {
        // UTF-8 String
        const len = view.getInt32(state.pos, true);
        state.pos += 4;
        val = textDecoder.decode(bytes.subarray(state.pos, state.pos + len - 1));
        state.pos += len;
        break;
      }
      case 0x03: // Embedded Document
        val = decodeBsonDocumentAt(bytes, view, state, false);
        break;
      case 0x04: // Array
        val = decodeBsonDocumentAt(bytes, view, state, true);
        break;
      case 0x05: {
        // Binary
        const len = view.getInt32(state.pos, true);
        state.pos += 4;
        state.pos += 1; // subtype
        val = bytes.slice(state.pos, state.pos + len);
        state.pos += len;
        break;
      }
      case 0x07: // ObjectId
        val = new ObjectId(bytes.subarray(state.pos, state.pos + 12));
        state.pos += 12;
        break;
      case 0x08: // Boolean
        val = bytes[state.pos++] !== 0;
        break;
      case 0x09: {
        // UTC DateTime
        const ms = Number(view.getBigInt64(state.pos, true));
        state.pos += 8;
        val = new Date(ms);
        break;
      }
      case 0x0a: // Null
      case 0x06: // Undefined (deprecated)
        val = null;
        break;
      case 0x0b: {
        // RegExp
        const pattern = readCString(bytes, state);
        const flags = readCString(bytes, state);
        val = new RegExp(pattern, flags);
        break;
      }
      case 0x10: // Int32
        val = view.getInt32(state.pos, true);
        state.pos += 4;
        break;
      case 0x11: // Timestamp (uint64)
      case 0x12: // Int64
        val = view.getBigInt64(state.pos, true);
        state.pos += 8;
        break;
      case 0x13: // Decimal128 (raw 16 bytes)
        val = bytes.slice(state.pos, state.pos + 16);
        state.pos += 16;
        break;
      default:
        throw new Error(`Unsupported BSON element type: 0x${type.toString(16)}`);
    }

    if (asArray) {
      targetArr.push(val);
    } else {
      targetObj[key] = val;
    }
  }

  state.pos = start + size;
  return asArray ? targetArr : targetObj;
}

/**
 * Decodes a binary BSON `Uint8Array` into a plain JS object.
 */
export function decodeBson(
  bytes: Uint8Array,
  offset = 0,
): Record<string, unknown> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const state = { pos: offset };
  return decodeBsonDocumentAt(bytes, view, state, false) as Record<
    string,
    unknown
  >;
}

// ============================================================================
// MongoDB Wire Protocol OP_MSG (Opcode 2013) Framing
// ============================================================================

export const MONGO_OP_MSG = 2013;

/**
 * Encodes a MongoDB `OP_MSG` (opcode `2013`, section kind `0`) packet.
 */
export function encodeOpMsg(
  requestId: number,
  body: Record<string, unknown>,
  responseTo = 0,
): Uint8Array {
  const bsonBody = encodeBson(body);
  // 16-byte MsgHeader + 4-byte flagBits + 1-byte kind(0) + bsonBody
  const totalLen = 16 + 4 + 1 + bsonBody.length;
  const packet = new Uint8Array(totalLen);
  const view = new DataView(packet.buffer);
  view.setInt32(0, totalLen, true);
  view.setInt32(4, requestId, true);
  view.setInt32(8, responseTo, true);
  view.setInt32(12, MONGO_OP_MSG, true);
  view.setUint32(16, 0, true); // flagBits
  packet[20] = 0; // Section kind 0: single BSON body
  packet.set(bsonBody, 21);
  return packet;
}

export interface DecodedOpMsg {
  readonly messageLength: number;
  readonly requestId: number;
  readonly responseTo: number;
  readonly opCode: number;
  readonly document: Record<string, unknown>;
}

/**
 * Decodes a complete MongoDB `OP_MSG` wire packet.
 */
export function decodeOpMsg(packet: Uint8Array): DecodedOpMsg {
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  const messageLength = view.getInt32(0, true);
  const requestId = view.getInt32(4, true);
  const responseTo = view.getInt32(8, true);
  const opCode = view.getInt32(12, true);

  if (opCode !== MONGO_OP_MSG) {
    throw new Error(`Expected MongoDB OP_MSG (2013), received opcode ${opCode}.`);
  }

  // Offset 16..19 = flagBits, offset 20 = section kind (0), offset 21 = BSON body
  const sectionKind = packet[20];
  if (sectionKind !== 0) {
    throw new Error(`Unsupported MongoDB OP_MSG section kind: ${sectionKind}.`);
  }

  const document = decodeBson(packet, 21);
  return { messageLength, requestId, responseTo, opCode, document };
}
