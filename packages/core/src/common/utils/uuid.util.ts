import { not } from "./predicate.util";
import { isString, isUndefined } from "./type-guards.util";

/**
 * Generates an RFC 9562 monotonic UUIDv7 using Bun's native `Bun.randomUUIDv7()`.
 */
export function uuidv7(): string {
  return Bun.randomUUIDv7();
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
