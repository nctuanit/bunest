const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

const BASE64URL_REGEX = /^[A-Za-z0-9_-]+$/;

export function utf8Encode(value: string): Uint8Array<ArrayBuffer> {
  return textEncoder.encode(value) as Uint8Array<ArrayBuffer>;
}

export function utf8Decode(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}

export function base64UrlEncode(input: Uint8Array | string): string {
  const bytes = typeof input === "string" ? utf8Encode(input) : input;
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

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

/**
 * Constant-time comparison of two byte buffers to prevent timing side channels.
 */
export function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  const lenA = a.length;
  const lenB = b.length;
  const maxLen = Math.max(lenA, lenB);
  let diff = lenA ^ lenB;
  for (let i = 0; i < maxLen; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

export function timingSafeEqualString(a: string, b: string): boolean {
  return timingSafeEqualBytes(utf8Encode(a), utf8Encode(b));
}

export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function randomToken(byteLength = 32): string {
  return base64UrlEncode(randomBytes(byteLength));
}

const DURATION_REGEX = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w|y)?$/i;

/**
 * Parses a duration in seconds (number) or shorthand string ("30s", "15m", "2h", "7d", "2w", "1y", "500ms")
 * into seconds.
 */
export function parseDurationToSeconds(value: number | string): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
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

  switch (unit) {
    case "ms":
      return Math.floor(amount / 1000);
    case "s":
      return Math.floor(amount);
    case "m":
      return Math.floor(amount * 60);
    case "h":
      return Math.floor(amount * 3600);
    case "d":
      return Math.floor(amount * 86400);
    case "w":
      return Math.floor(amount * 604800);
    case "y":
      return Math.floor(amount * 31557600);
    default:
      throw new Error(`Unsupported duration unit: "${unit}"`);
  }
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
