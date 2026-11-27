const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export type CborKey = number | string;

export type CborValue =
  | number
  | boolean
  | null
  | undefined
  | string
  | Uint8Array
  | CborValue[]
  | Map<CborKey, CborValue>;

export interface CborDecodeOptions {
  /** Maximum container nesting depth. Default `32`. */
  maxDepth?: number;
  /** Maximum total decoded CBOR items across the payload (anti-CBOR-bomb guard). Default `10_000`. */
  maxItems?: number;
}

export interface CborDecodePrefixResult {
  value: CborValue;
  bytesRead: number;
}

export class CborDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CborDecodeError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const DEFAULT_MAX_DEPTH = 32;
const DEFAULT_MAX_ITEMS = 10_000;
const MAX_UINT32_MULT = 0x1_0000_0000;

interface DecodeState {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  offset: number;
  itemsRead: number;
  readonly maxDepth: number;
  readonly maxItems: number;
}

function readUint(state: DecodeState, additionalInfo: number): number {
  if (additionalInfo < 24) {
    return additionalInfo;
  }
  if (additionalInfo === 24) {
    if (state.offset + 1 > state.bytes.byteLength) {
      throw new CborDecodeError("Unexpected end of CBOR input reading uint8");
    }
    const v = state.bytes[state.offset]!;
    state.offset += 1;
    return v;
  }
  if (additionalInfo === 25) {
    if (state.offset + 2 > state.bytes.byteLength) {
      throw new CborDecodeError("Unexpected end of CBOR input reading uint16");
    }
    const v = state.view.getUint16(state.offset, false);
    state.offset += 2;
    return v;
  }
  if (additionalInfo === 26) {
    if (state.offset + 4 > state.bytes.byteLength) {
      throw new CborDecodeError("Unexpected end of CBOR input reading uint32");
    }
    const v = state.view.getUint32(state.offset, false);
    state.offset += 4;
    return v;
  }
  if (additionalInfo === 27) {
    if (state.offset + 8 > state.bytes.byteLength) {
      throw new CborDecodeError("Unexpected end of CBOR input reading uint64");
    }
    const high = state.view.getUint32(state.offset, false);
    const low = state.view.getUint32(state.offset + 4, false);
    state.offset += 8;
    // IEEE 754 safe integer bound: 2^53 - 1 (high <= 0x001fffff)
    if (high > 0x001f_ffff) {
      throw new CborDecodeError(
        "CBOR integer exceeds JavaScript safe integer range",
      );
    }
    return high * MAX_UINT32_MULT + low;
  }
  if (additionalInfo === 31) {
    throw new CborDecodeError(
      "Indefinite-length CBOR items are not permitted in strict WebAuthn decoding",
    );
  }
  throw new CborDecodeError(
    `Invalid CBOR additional information value: ${additionalInfo}`,
  );
}

function decodeItem(state: DecodeState, depth: number): CborValue {
  if (depth > state.maxDepth) {
    throw new CborDecodeError(
      `CBOR nesting depth exceeds maximum allowed (${state.maxDepth})`,
    );
  }
  state.itemsRead += 1;
  if (state.itemsRead > state.maxItems) {
    throw new CborDecodeError(
      `CBOR item count exceeds maximum allowed (${state.maxItems})`,
    );
  }
  if (state.offset >= state.bytes.byteLength) {
    throw new CborDecodeError("Unexpected end of CBOR input");
  }

  const initialByte = state.bytes[state.offset]!;
  state.offset += 1;
  const majorType = initialByte >> 5;
  const additionalInfo = initialByte & 0x1f;

  switch (majorType) {
    case 0: {
      // Unsigned integer
      return readUint(state, additionalInfo);
    }
    case 1: {
      // Negative integer: -1 - n
      const n = readUint(state, additionalInfo);
      const neg = -1 - n;
      if (!Number.isSafeInteger(neg)) {
        throw new CborDecodeError(
          "CBOR negative integer exceeds JavaScript safe integer range",
        );
      }
      return neg;
    }
    case 2: {
      // Definite-length byte string
      const len = readUint(state, additionalInfo);
      const remaining = state.bytes.byteLength - state.offset;
      if (len > remaining) {
        throw new CborDecodeError(
          `CBOR byte string truncated: declared ${len} bytes, only ${remaining} available`,
        );
      }
      const copy = new Uint8Array(len);
      copy.set(state.bytes.subarray(state.offset, state.offset + len));
      state.offset += len;
      return copy;
    }
    case 3: {
      // Definite-length UTF-8 text string
      const len = readUint(state, additionalInfo);
      const remaining = state.bytes.byteLength - state.offset;
      if (len > remaining) {
        throw new CborDecodeError(
          `CBOR text string truncated: declared ${len} bytes, only ${remaining} available`,
        );
      }
      const slice = state.bytes.subarray(state.offset, state.offset + len);
      state.offset += len;
      try {
        return textDecoder.decode(slice);
      } catch {
        throw new CborDecodeError("Invalid UTF-8 sequence in CBOR text string");
      }
    }
    case 4: {
      // Definite-length array
      const len = readUint(state, additionalInfo);
      const remaining = state.bytes.byteLength - state.offset;
      if (len > remaining || state.itemsRead + len > state.maxItems) {
        throw new CborDecodeError(
          `CBOR array length (${len}) exceeds remaining payload or item limit`,
        );
      }
      const arr: CborValue[] = [];
      for (let i = 0; i < len; i++) {
        arr.push(decodeItem(state, depth + 1));
      }
      return arr;
    }
    case 5: {
      // Definite-length map (stored in JS Map to avoid prototype pollution and preserve numeric COSE keys)
      const len = readUint(state, additionalInfo);
      const remaining = state.bytes.byteLength - state.offset;
      if (len * 2 > remaining || state.itemsRead + len * 2 > state.maxItems) {
        throw new CborDecodeError(
          `CBOR map length (${len}) exceeds remaining payload or item limit`,
        );
      }
      const map = new Map<CborKey, CborValue>();
      for (let i = 0; i < len; i++) {
        const key = decodeItem(state, depth + 1);
        if (typeof key !== "string" && typeof key !== "number") {
          throw new CborDecodeError(
            "CBOR map keys must be integers or text strings",
          );
        }
        if (map.has(key)) {
          throw new CborDecodeError(`Duplicate CBOR map key: ${String(key)}`);
        }
        const value = decodeItem(state, depth + 1);
        map.set(key, value);
      }
      return map;
    }
    case 6: {
      // Semantic tags are not used in WebAuthn attestation objects or COSE keys
      throw new CborDecodeError("CBOR semantic tags (major type 6) are not supported");
    }
    case 7: {
      // Simple values and floats
      if (additionalInfo === 20) return false;
      if (additionalInfo === 21) return true;
      if (additionalInfo === 22) return null;
      if (additionalInfo === 23) return undefined;
      if (additionalInfo === 26) {
        if (state.offset + 4 > state.bytes.byteLength) {
          throw new CborDecodeError(
            "Unexpected end of CBOR input reading float32",
          );
        }
        const f = state.view.getFloat32(state.offset, false);
        state.offset += 4;
        return f;
      }
      if (additionalInfo === 27) {
        if (state.offset + 8 > state.bytes.byteLength) {
          throw new CborDecodeError(
            "Unexpected end of CBOR input reading float64",
          );
        }
        const f = state.view.getFloat64(state.offset, false);
        state.offset += 8;
        return f;
      }
      throw new CborDecodeError(
        `Unsupported CBOR simple/float value (additional info ${additionalInfo})`,
      );
    }
    default:
      throw new CborDecodeError(`Unsupported CBOR major type: ${majorType}`);
  }
}

/**
 * Decodes a single CBOR item starting at `offset` and returns both the decoded
 * value and exact byte length consumed. Used to extract `credentialPublicKey`
 * (COSE_Key) from `authenticatorData` where CBOR extensions may follow.
 */
export function decodeCborPrefix(
  input: Uint8Array,
  offset = 0,
  options: CborDecodeOptions = {},
): CborDecodePrefixResult {
  if (!(input instanceof Uint8Array) || input.byteLength === 0) {
    throw new CborDecodeError("CBOR input must be a non-empty Uint8Array");
  }
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= input.byteLength) {
    throw new CborDecodeError(`Invalid CBOR start offset: ${offset}`);
  }
  const state: DecodeState = {
    bytes: input,
    view: new DataView(input.buffer, input.byteOffset, input.byteLength),
    offset,
    itemsRead: 0,
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxItems: options.maxItems ?? DEFAULT_MAX_ITEMS,
  };
  const value = decodeItem(state, 0);
  return {
    value,
    bytesRead: state.offset - offset,
  };
}

/**
 * Strictly decodes a complete RFC 8949 CBOR payload, rejecting any trailing bytes,
 * duplicate map keys, indefinite-length items, truncation, or excessive depth/size.
 */
export function decodeCbor(
  input: Uint8Array,
  options: CborDecodeOptions = {},
): CborValue {
  const { value, bytesRead } = decodeCborPrefix(input, 0, options);
  if (bytesRead !== input.byteLength) {
    throw new CborDecodeError(
      `Trailing bytes after CBOR item (${input.byteLength - bytesRead} unexpected byte(s))`,
    );
  }
  return value;
}

// ------------------------------------------------------------------ Encoder

function writeMajorAndLength(
  out: number[],
  majorType: number,
  length: number,
): void {
  const prefix = majorType << 5;
  if (length < 24) {
    out.push(prefix | length);
  } else if (length <= 0xff) {
    out.push(prefix | 24, length);
  } else if (length <= 0xffff) {
    out.push(prefix | 25, (length >>> 8) & 0xff, length & 0xff);
  } else if (length <= 0xffff_ffff) {
    out.push(
      prefix | 26,
      (length >>> 24) & 0xff,
      (length >>> 16) & 0xff,
      (length >>> 8) & 0xff,
      length & 0xff,
    );
  } else {
    const high = Math.floor(length / MAX_UINT32_MULT);
    const low = length >>> 0;
    out.push(
      prefix | 27,
      (high >>> 24) & 0xff,
      (high >>> 16) & 0xff,
      (high >>> 8) & 0xff,
      high & 0xff,
      (low >>> 24) & 0xff,
      (low >>> 16) & 0xff,
      (low >>> 8) & 0xff,
      low & 0xff,
    );
  }
}

function encodeValueInto(
  value: CborValue | Record<string, CborValue>,
  out: number[],
  depth: number,
): void {
  if (depth > DEFAULT_MAX_DEPTH) {
    throw new CborDecodeError("CBOR encoding depth exceeds maximum");
  }
  if (value === false) {
    out.push(0xf4);
    return;
  }
  if (value === true) {
    out.push(0xf5);
    return;
  }
  if (value === null) {
    out.push(0xf6);
    return;
  }
  if (value === undefined) {
    out.push(0xf7);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new CborDecodeError(
        `CBOR encoder supports safe integers only (got ${value})`,
      );
    }
    if (value >= 0) {
      writeMajorAndLength(out, 0, value);
    } else {
      writeMajorAndLength(out, 1, -1 - value);
    }
    return;
  }
  if (typeof value === "string") {
    const utf8 = textEncoder.encode(value);
    writeMajorAndLength(out, 3, utf8.byteLength);
    for (let i = 0; i < utf8.byteLength; i++) {
      out.push(utf8[i]!);
    }
    return;
  }
  if (value instanceof Uint8Array) {
    writeMajorAndLength(out, 2, value.byteLength);
    for (let i = 0; i < value.byteLength; i++) {
      out.push(value[i]!);
    }
    return;
  }
  if (Array.isArray(value)) {
    writeMajorAndLength(out, 4, value.length);
    for (const item of value) {
      encodeValueInto(item, out, depth + 1);
    }
    return;
  }
  if (value instanceof Map) {
    writeMajorAndLength(out, 5, value.size);
    for (const [k, v] of value.entries()) {
      encodeValueInto(k, out, depth + 1);
      encodeValueInto(v, out, depth + 1);
    }
    return;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value);
    writeMajorAndLength(out, 5, entries.length);
    for (const [k, v] of entries) {
      encodeValueInto(k, out, depth + 1);
      encodeValueInto(v, out, depth + 1);
    }
    return;
  }
  throw new CborDecodeError(`Unsupported CBOR value type: ${typeof value}`);
}

/**
 * Minimal pure-TS RFC 8949 CBOR encoder supporting unsigned/negative integers,
 * byte strings, text strings, arrays, Maps/plain objects, booleans, and null.
 */
export function encodeCbor(
  value: CborValue | Record<string, CborValue>,
): Uint8Array<ArrayBuffer> {
  const out: number[] = [];
  encodeValueInto(value, out, 0);
  const bytes = new Uint8Array(out.length);
  bytes.set(out);
  return bytes;
}
