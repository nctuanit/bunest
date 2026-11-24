import { not } from "./predicate.util";
import {
  isArray,
  isError,
  isFunction,
  isInstanceof,
  isInteger,
  isNull,
  isString,
  isSymbol,
  isTypeof,
  isUndefined,
} from "./type-guards.util";

const DEFAULT_MAX_ERROR_LENGTH = 2_000;
const utf8Encoder = new TextEncoder();

/**
 * Produces a compact, safe, storable string description of any thrown value.
 * Never throws; replaces NUL characters (`U+0000`) with `U+FFFD` and guarantees
 * well-formed Unicode (no lone surrogates).
 */
export function describeError(
  error: unknown,
  maxLength = DEFAULT_MAX_ERROR_LENGTH,
): string {
  const raw = formatThrown(error).replaceAll("\u0000", "\uFFFD");
  const cut = raw.length > maxLength ? `${raw.slice(0, maxLength)}\u2026` : raw;
  return cut.toWellFormed();
}

function formatThrown(error: unknown): string {
  try {
    if (isInstanceof(error, AggregateError)) {
      return `${error.name}: ${error.message} [${error.errors.map(formatThrown).join("; ")}]`;
    }
    if (isError(error)) {
      return `${error.name}: ${error.message}`;
    }
    if (isString(error)) {
      return error;
    }
    if (isFunction(error)) {
      return `[function ${error.name || "anonymous"}]`;
    }
    if (isSymbol(error) || isUndefined(error)) {
      return String(error);
    }
    return JSON.stringify(error) ?? String(error);
  } catch {
    try {
      return String(error);
    } catch {
      return Object.prototype.toString.call(error);
    }
  }
}

/**
 * Formats an arbitrary value for diagnostic / configuration validation messages
 * (e.g. `the string "false"`, `the number 42`, `null`, `an array`, `an object`).
 */
export function describeValue(value: unknown): string {
  if (isNull(value)) {
    return "null";
  }
  if (isString(value)) {
    return `the string ${JSON.stringify(value)}`;
  }
  if (isTypeof(value, ["number", "boolean", "bigint"])) {
    return `the ${typeof value} ${String(value)}`;
  }
  if (isFunction(value)) {
    return `the function ${value.name || "(anonymous)"}`;
  }
  if (isArray(value)) {
    return "an array";
  }
  if (isTypeof(value, "object")) {
    return "an object";
  }
  return typeof value;
}

/**
 * Truncates `text` so its UTF-8 encoded byte length does not exceed `maxBytes`,
 * never splitting multi-byte code points or UTF-16 surrogate pairs.
 */
export function truncateUtf8(
  text: string,
  maxBytes: number,
  suffix = "\u2026",
): string {
  if (not(isInteger(maxBytes)) || maxBytes < 0) {
    throw new RangeError(
      `truncateUtf8: maxBytes must be a non-negative integer (got ${maxBytes})`,
    );
  }
  const safeText = text.toWellFormed();
  if (utf8Encoder.encode(safeText).byteLength <= maxBytes) {
    return safeText;
  }
  if (maxBytes === 0) {
    return "";
  }

  const suffixBytes = utf8Encoder.encode(suffix).byteLength;
  const budget = suffixBytes <= maxBytes ? maxBytes - suffixBytes : maxBytes;
  const appendSuffix = suffixBytes <= maxBytes;

  let usedBytes = 0;
  let result = "";
  for (const ch of safeText) {
    const chBytes = utf8Encoder.encode(ch).byteLength;
    if (usedBytes + chBytes > budget) {
      break;
    }
    result += ch;
    usedBytes += chBytes;
  }
  return appendSuffix ? `${result}${suffix}` : result;
}
