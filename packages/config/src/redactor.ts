import { DEFAULT_REDACT_KEYS } from "@bunest/common";
import type { SecretRedactorOptions } from "./interfaces/config.interface";

const EXTRA_CONFIG_SECRET_KEYS: readonly string[] = [
  "databaseurl",
  "dburl",
  "connectionstring",
  "dsn",
  "signingkey",
  "encryptionkey",
  "webhooksecret",
  "credentials",
  "auth",
  "passphrase",
  "accesskey",
  "secretkey",
];

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_\s.]/g, "");
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Creates an immutable deep redactor function that masks any configuration keys
 * matching secret patterns or explicit `secretKeys` without mutating the input.
 */
export function createSecretRedactor(
  options: SecretRedactorOptions = {},
): <T>(value: T) => T {
  const mask = options.redactionMask ?? "[REDACTED]";
  const normalizedSet = new Set<string>([
    ...DEFAULT_REDACT_KEYS.map(normalizeKey),
    ...EXTRA_CONFIG_SECRET_KEYS.map(normalizeKey),
  ]);

  if (options.secretKeys) {
    for (const key of options.secretKeys) {
      const normalized = normalizeKey(key);
      if (normalized) {
        normalizedSet.add(normalized);
      }
    }
  }

  const secretPatterns = [...normalizedSet];

  const isSecret = (key: string): boolean => {
    const normalized = normalizeKey(key);
    for (let i = 0; i < secretPatterns.length; i++) {
      const pattern = secretPatterns[i]!;
      if (normalized === pattern || normalized.includes(pattern)) {
        return true;
      }
    }
    return false;
  };

  const redactInternal = (
    value: unknown,
    seen: WeakSet<object>,
  ): unknown => {
    if (value === null || typeof value !== "object") {
      return value;
    }

    if (seen.has(value)) {
      return "[Circular]";
    }

    if (value instanceof Date) {
      return value.toISOString();
    }

    if (value instanceof RegExp) {
      return value.toString();
    }

    seen.add(value);
    try {
      if (Array.isArray(value)) {
        return value.map((item) => redactInternal(item, seen));
      }

      if (!isPlainObject(value)) {
        return value;
      }

      const out: Record<string, unknown> = {};
      for (const [key, propVal] of Object.entries(value)) {
        if (isSecret(key)) {
          out[key] = mask;
        } else {
          out[key] = redactInternal(propVal, seen);
        }
      }
      return out;
    } finally {
      seen.delete(value);
    }
  };

  return <T>(value: T): T => redactInternal(value, new WeakSet()) as T;
}
