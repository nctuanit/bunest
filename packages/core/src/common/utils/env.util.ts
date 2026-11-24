import { type Duration, parseDuration } from "./duration.util";
import { safeJsonParse } from "./json.util";
import { include, not } from "./predicate.util";
import {
  isFiniteNumber,
  isNotUndefined,
  isUndefined,
} from "./type-guards.util";

export type EnvSource = Readonly<Record<string, string | undefined>>;

/**
 * Error thrown when a required environment variable is missing or fails validation.
 */
export class EnvError extends Error {
  public readonly variable: string;

  constructor(variable: string, detail: string) {
    super(`Environment variable "${variable}": ${detail}`);
    this.name = "EnvError";
    this.variable = variable;
  }
}

function defaultEnvSource(): EnvSource {
  const proc = (globalThis as { process?: { env?: EnvSource } }).process;
  return proc?.env ?? {};
}

function readRawEnv(name: string, source: EnvSource): string | undefined {
  const raw = source[name];
  if (isUndefined(raw)) {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Reads a string environment variable, returning `defaultValue` if absent or throwing `EnvError`.
 */
export function envString(
  name: string,
  defaultValue?: string,
  source: EnvSource = defaultEnvSource(),
): string {
  const raw = readRawEnv(name, source);
  if (isNotUndefined(raw)) {
    return raw;
  }
  if (isNotUndefined(defaultValue)) {
    return defaultValue;
  }
  throw new EnvError(name, "is required but was not set.");
}

/**
 * Reads a finite numeric environment variable, returning `defaultValue` if absent or throwing `EnvError`.
 */
export function envNumber(
  name: string,
  defaultValue?: number,
  source: EnvSource = defaultEnvSource(),
): number {
  const raw = readRawEnv(name, source);
  if (isUndefined(raw)) {
    if (isNotUndefined(defaultValue)) {
      return defaultValue;
    }
    throw new EnvError(name, "is required (expected a finite number).");
  }
  const parsed = Number(raw);
  if (not(isFiniteNumber(parsed))) {
    throw new EnvError(
      name,
      `expected a finite number, got ${JSON.stringify(raw)}.`,
    );
  }
  return parsed;
}

const TRUTHY_ENV_VALUES: ReadonlySet<string> = new Set([
  "1",
  "true",
  "yes",
  "on",
]);
const FALSY_ENV_VALUES: ReadonlySet<string> = new Set([
  "0",
  "false",
  "no",
  "off",
]);

/**
 * Reads a boolean environment variable (`true`/`false`, `1`/`0`, `yes`/`no`, `on`/`off`).
 */
export function envBool(
  name: string,
  defaultValue?: boolean,
  source: EnvSource = defaultEnvSource(),
): boolean {
  const raw = readRawEnv(name, source);
  if (isUndefined(raw)) {
    if (isNotUndefined(defaultValue)) {
      return defaultValue;
    }
    throw new EnvError(name, "is required (expected a boolean).");
  }
  const lower = raw.toLowerCase();
  if (include(TRUTHY_ENV_VALUES, lower)) {
    return true;
  }
  if (include(FALSY_ENV_VALUES, lower)) {
    return false;
  }
  throw new EnvError(
    name,
    `expected a boolean ("true"/"false"/"1"/"0"/"yes"/"no"), got ${JSON.stringify(raw)}.`,
  );
}

/**
 * Reads an environment variable constrained to a fixed set of allowed literal values.
 */
export function envEnum<const T extends string>(
  name: string,
  allowed: readonly T[],
  defaultValue?: T,
  source: EnvSource = defaultEnvSource(),
): T {
  const raw = readRawEnv(name, source);
  if (isUndefined(raw)) {
    if (isNotUndefined(defaultValue)) {
      return defaultValue;
    }
    throw new EnvError(
      name,
      `is required (expected one of: ${allowed.join(", ")}).`,
    );
  }
  if (include(allowed, raw)) {
    return raw;
  }
  throw new EnvError(
    name,
    `expected one of [${allowed.join(", ")}], got ${JSON.stringify(raw)}.`,
  );
}

/**
 * Reads a delimiter-separated string list from an environment variable (default separator `","`).
 */
export function envList(
  name: string,
  defaultValue?: readonly string[],
  separator = ",",
  source: EnvSource = defaultEnvSource(),
): string[] {
  const raw = readRawEnv(name, source);
  if (isUndefined(raw)) {
    if (isNotUndefined(defaultValue)) {
      return [...defaultValue];
    }
    throw new EnvError(name, "is required (expected a delimited list).");
  }
  return raw
    .split(separator)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * Reads a `Duration` (e.g. `"30s"`, `"15m"`, `"500"`) from an environment variable and returns milliseconds.
 */
export function envDuration(
  name: string,
  defaultValue?: Duration,
  source: EnvSource = defaultEnvSource(),
): number {
  const raw = readRawEnv(name, source);
  if (isUndefined(raw)) {
    if (isNotUndefined(defaultValue)) {
      return parseDuration(defaultValue);
    }
    throw new EnvError(
      name,
      'is required (expected milliseconds or a duration like "30s", "15m").',
    );
  }
  const asNum = Number(raw);
  try {
    return isFiniteNumber(asNum)
      ? parseDuration(asNum)
      : parseDuration(raw as Duration);
  } catch (error) {
    throw new EnvError(name, (error as Error).message);
  }
}

/**
 * Reads and parses a JSON environment variable.
 */
export function envJson<T = unknown>(
  name: string,
  defaultValue?: T,
  source: EnvSource = defaultEnvSource(),
): T {
  const raw = readRawEnv(name, source);
  if (isUndefined(raw)) {
    if (isNotUndefined(defaultValue)) {
      return defaultValue;
    }
    throw new EnvError(name, "is required (expected valid JSON).");
  }
  const parsed = safeJsonParse<T>(raw);
  if (!parsed.ok) {
    throw new EnvError(name, `invalid JSON: ${parsed.error.message}`);
  }
  return parsed.value;
}
