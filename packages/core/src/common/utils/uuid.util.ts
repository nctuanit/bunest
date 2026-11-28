import { not } from "./predicate.util";
import { isString, isUndefined } from "./type-guards.util";

/** RFC 4122 DNS namespace UUID (`6ba7b810-9dad-11d1-80b4-00c04fd430c8`). */
export const UUID_NAMESPACE_DNS = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
/** RFC 4122 URL namespace UUID (`6ba7b811-9dad-11d1-80b4-00c04fd430c8`). */
export const UUID_NAMESPACE_URL = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";
/** RFC 4122 OID namespace UUID (`6ba7b812-9dad-11d1-80b4-00c04fd430c8`). */
export const UUID_NAMESPACE_OID = "6ba7b812-9dad-11d1-80b4-00c04fd430c8";
/** RFC 4122 X.500 DN namespace UUID (`6ba7b814-9dad-11d1-80b4-00c04fd430c8`). */
export const UUID_NAMESPACE_X500 = "6ba7b814-9dad-11d1-80b4-00c04fd430c8";

/**
 * Generates an RFC 9562 monotonic UUIDv7 using Bun's native `Bun.randomUUIDv7()`.
 */
export function uuidv7(): string {
  return Bun.randomUUIDv7();
}

/**
 * Generates a deterministic RFC 4122 / RFC 9562 name-based UUIDv5 (SHA-1) using
 * Bun's native `Bun.randomUUIDv5()`.
 */
export function uuidv5(
  name: string | Uint8Array,
  namespace: string | Uint8Array,
): string {
  const fn = (
    Bun as unknown as {
      randomUUIDv5: (
        n: string | Uint8Array,
        ns: string | Uint8Array,
      ) => string;
    }
  ).randomUUIDv5;
  return fn(name, namespace);
}

/**
 * Generates an RFC 4122 / RFC 9562 random UUIDv4 using Web Crypto `crypto.randomUUID()`.
 */
export function uuidv4(): string {
  return crypto.randomUUID();
}

const GENERIC_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Validates whether a value is a canonical UUID string (optionally constrained to a specific version 1–8).
 */
export function isValidUuid(
  value: unknown,
  version?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8,
): value is string {
  if (!isString(value)) {
    return false;
  }
  if (not(GENERIC_UUID_PATTERN.test(value))) {
    return false;
  }
  if (not(isUndefined(version))) {
    return value[14] === String(version);
  }
  return true;
}
