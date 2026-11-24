import { randomInt, timingSafeEqualBytes } from "@bunest/core";

export { randomInt, timingSafeEqualBytes };

/** Cryptographically secure random bytes. */
export function randomBytes(length: number): Buffer {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** 256 random bits, base64url (43 chars). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Pattern of a {@link randomToken} of 32 bytes. */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * SHA-256, base64url. Used as the storage key for high-entropy bearer
 * secrets (session ids, magic links, refresh tokens), so a leaked store
 * cannot be replayed.
 */
export function sha256(value: string): string {
  return Bun.CryptoHasher.hash("sha256", value, "base64url");
}

/** Constant-time string comparison (length is not secret). */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return timingSafeEqualBytes(left, right);
}

const MAX_REDIRECT_LENGTH = 2_048;

/**
 * Accepts only same-origin relative paths (`/x`, not `//evil`, `/\evil`,
 * or absolute URLs), to prevent open redirects.
 */
export function safeRedirectPath(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.length > MAX_REDIRECT_LENGTH
  ) {
    return undefined;
  }
  if (
    value.startsWith("//") ||
    value.includes("\\") ||
    !/^[\x21-\x7e]+$/.test(value)
  ) {
    return undefined;
  }
  return value;
}
