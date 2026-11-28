import {
  base64UrlEncode,
  isFiniteNumber,
  randomToken,
  timingSafeEqualBytes,
  timingSafeEqualStr,
} from "@bunest/core/common";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

const BASE64URL_REGEX = /^[A-Za-z0-9_-]+$/;

export function utf8Encode(value: string): Uint8Array<ArrayBuffer> {
  return textEncoder.encode(value) as Uint8Array<ArrayBuffer>;
}

export function utf8Decode(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}

export {
  base64UrlEncode,
  randomToken,
  timingSafeEqualBytes,
  timingSafeEqualStr as timingSafeEqualString,
};

export function base64UrlDecode(input: string): Uint8Array<ArrayBuffer> {
  if (typeof input !== "string" || input.length === 0) {
    throw new Error("Invalid base64url input: empty string");
  }
  if (!BASE64URL_REGEX.test(input) || input.length % 4 === 1) {
    throw new Error("Invalid base64url encoding");
  }
  const padded = input
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(input.length / 4) * 4, "=");
  const buf = Buffer.from(padded, "base64");
  const out = new Uint8Array(buf.byteLength);
  out.set(buf);
  return out;
}

export function base64UrlDecodeUtf8(input: string): string {
  return utf8Decode(base64UrlDecode(input));
}

export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

const DURATION_REGEX = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w|y)?$/i;

const DURATION_UNIT_SECONDS: Record<string, number> = {
  ms: 1 / 1000,
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
  w: 604800,
  y: 31557600,
};

/**
 * Parses a duration in seconds (number) or shorthand string ("30s", "15m", "2h", "7d", "2w", "1y", "500ms")
 * into seconds.
 */
export function parseDurationToSeconds(value: number | string): number {
  if (typeof value === "number") {
    if (!isFiniteNumber(value) || value < 0) {
      throw new Error(`Invalid duration value: ${value}`);
    }
    return Math.floor(value);
  }

  const match = DURATION_REGEX.exec(value.trim());
  if (!match) {
    throw new Error(`Invalid duration format: "${value}"`);
  }

  const amount = Number.parseFloat(match[1]!);
  const unit = (match[2] ?? "s").toLowerCase();
  const multiplier = DURATION_UNIT_SECONDS[unit];
  if (multiplier === undefined) {
    throw new Error(`Unsupported duration unit: "${unit}"`);
  }
  return Math.floor(amount * multiplier);
}

/**
 * Strips PEM armor headers/footers and decodes DER bytes into an ArrayBuffer
 * suitable for `crypto.subtle.importKey("pkcs8" | "spki", ...)`.
 */
export function pemToArrayBuffer(pem: string): ArrayBuffer {
  const base64 = pem
    .replace(/-----BEGIN [A-Z0-9 ]+-----/g, "")
    .replace(/-----END [A-Z0-9 ]+-----/g, "")
    .replace(/\s+/g, "");
  if (base64.length === 0) {
    throw new Error("Invalid PEM key: empty key body");
  }
  const buf = Buffer.from(base64, "base64");
  const out = new Uint8Array(buf.byteLength);
  out.set(buf);
  return out.buffer;
}
