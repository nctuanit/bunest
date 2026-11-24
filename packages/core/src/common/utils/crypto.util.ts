import { not } from "./predicate.util";
import { isInteger, isString } from "./type-guards.util";

export type HashEncoding = "hex" | "base64" | "base64url";

/**
 * Computes a SHA-256 digest of a UTF-8 string or byte array using Bun's native `Bun.CryptoHasher`.
 */
export function sha256(
  input: string | Uint8Array,
  encoding: HashEncoding = "hex",
): string {
  return Bun.CryptoHasher.hash("sha256", input, encoding);
}

/**
 * Computes a SHA-512 digest of a UTF-8 string or byte array using Bun's native `Bun.CryptoHasher`.
 */
export function sha512(
  input: string | Uint8Array,
  encoding: HashEncoding = "hex",
): string {
  return Bun.CryptoHasher.hash("sha512", input, encoding);
}

/**
 * Computes an MD5 digest (e.g. for ETags / content checksums) via Bun's native `Bun.CryptoHasher`.
 */
export function md5(
  input: string | Uint8Array,
  encoding: HashEncoding = "hex",
): string {
  return Bun.CryptoHasher.hash("md5", input, encoding);
}

/**
 * Computes an ultra-fast non-cryptographic 64-bit xxHash64 digest via Bun's Zig-native `Bun.hash.xxHash64`.
 * Ideal for cache keys, ETags, sharding, and deduplication fingerprints.
 */
export function fastHash(
  input: string | Uint8Array | ArrayBuffer,
  seed?: bigint,
): bigint {
  return seed !== undefined
    ? Bun.hash.xxHash64(input, seed)
    : Bun.hash.xxHash64(input);
}

/**
 * Computes a hardware-accelerated 32-bit CRC32 checksum via Bun's Zig-native `Bun.hash.crc32`.
 */
export function crc32(input: string | Uint8Array | ArrayBuffer): number {
  return Bun.hash.crc32(input);
}

/**
 * Computes an HMAC-SHA256 signature for `data` using `secret` via Bun's native `Bun.CryptoHasher`.
 */
export function hmacSha256(
  secret: string | Uint8Array,
  data: string | Uint8Array,
  encoding: HashEncoding = "hex",
): string {
  return new Bun.CryptoHasher("sha256", secret).update(data).digest(encoding);
}

/**
 * Constant-time byte-slice comparison using a bitwise XOR accumulator without
 * early exit on byte mismatches (zero `node:crypto` dependency).
 */
export function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  const lenA = a.byteLength;
  const lenB = b.byteLength;
  if (lenA !== lenB) {
    // Perform a dummy sweep over `a` to reduce length-branch timing noise
    let dummy = 0;
    for (let i = 0; i < lenA; i++) {
      dummy |= a[i]! ^ a[i]!;
    }
    return dummy === -1;
  }
  let diff = 0;
  for (let i = 0; i < lenA; i++) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}

/**
 * Constant-time string comparison backed by `timingSafeEqualBytes` to prevent timing attacks.
 * Handles differing lengths without leaking early-exit timing on same-length secrets.
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  return timingSafeEqualBytes(bufA, bufB);
}

const MAX_UINT32_RANGE = 0x1_0000_0000;
const MAX_RANDOM_INT_RANGE = 0x10000_0000_0000; // 2^48 (matching Node `crypto.randomInt`)

/**
 * Generates a cryptographically strong, unbiased random integer in `[min, max)`
 * using rejection sampling on WebCrypto `crypto.getRandomValues()`.
 */
export function randomIntRange(min: number, max: number): number {
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max)) {
    throw new RangeError(
      `randomIntRange: min (${min}) and max (${max}) must be safe integers`,
    );
  }
  if (max <= min) {
    throw new RangeError(
      `randomIntRange: max (${max}) must be greater than min (${min})`,
    );
  }
  const range = max - min;
  if (range > MAX_RANDOM_INT_RANGE) {
    throw new RangeError(
      `randomIntRange: range (${range}) must be <= ${MAX_RANDOM_INT_RANGE}`,
    );
  }
  if (range === 1) {
    return min;
  }

  if (range <= MAX_UINT32_RANGE) {
    const limit = Math.floor(MAX_UINT32_RANGE / range) * range;
    const buf = new Uint32Array(1);
    for (;;) {
      crypto.getRandomValues(buf);
      const value = buf[0]!;
      if (value < limit) {
        return min + (value % range);
      }
    }
  }

  // 48-bit unbiased rejection sampling for ranges in (2^32, 2^48]
  const rangeBig = BigInt(range);
  const spaceBig = BigInt(MAX_RANDOM_INT_RANGE);
  const limitBig = (spaceBig / rangeBig) * rangeBig;
  const buf = new Uint32Array(2);
  for (;;) {
    crypto.getRandomValues(buf);
    const high = BigInt(buf[0]! & 0xffff);
    const low = BigInt(buf[1]!);
    const value = (high << 32n) | low;
    if (value < limitBig) {
      return min + Number(value % rangeBig);
    }
  }
}

/**
 * Generates a cryptographically strong, unbiased random integer in `[0, max)`
 * (single-argument form) or `[min, max)` (two-argument form) using `crypto.getRandomValues()`.
 */
export function randomInt(max: number): number;
export function randomInt(min: number, max: number): number;
export function randomInt(minOrMax: number, maybeMax?: number): number {
  if (maybeMax === undefined) {
    return randomIntRange(0, minOrMax);
  }
  return randomIntRange(minOrMax, maybeMax);
}

/**
 * Generates a cryptographically strong URL-safe random token (`base64url`).
 */
export function randomToken(byteLength = 32): string {
  if (not(isInteger(byteLength)) || byteLength < 1) {
    throw new RangeError(
      `randomToken: byteLength must be a positive integer (got ${byteLength})`,
    );
  }
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
    "base64url",
  );
}

/**
 * Generates a cryptographically strong lowercase hexadecimal string (`2 * byteLength` chars).
 */
export function randomHex(byteLength = 16): string {
  if (not(isInteger(byteLength)) || byteLength < 1) {
    throw new RangeError(
      `randomHex: byteLength must be a positive integer (got ${byteLength})`,
    );
  }
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
    "hex",
  );
}

/**
 * Encodes a UTF-8 string or `Uint8Array` to RFC 4648 base64url (without padding).
 */
export function base64UrlEncode(input: string | Uint8Array): string {
  const buf = isString(input) ? Buffer.from(input, "utf8") : Buffer.from(input);
  return buf.toString("base64url");
}

/**
 * Decodes an RFC 4648 base64url string back to UTF-8 text.
 */
export function base64UrlDecode(encoded: string): string {
  return Buffer.from(encoded, "base64url").toString("utf8");
}
