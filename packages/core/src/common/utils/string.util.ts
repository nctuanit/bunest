import { not } from "./predicate.util";
import { isInteger } from "./type-guards.util";

const WORD_BOUNDARY_REGEX =
  /[A-Z]{2,}(?=[A-Z][a-z]+[0-9]*|\b)|[A-Z]?[a-z]+[0-9]*|[A-Z]|[0-9]+/g;

function splitWords(input: string): string[] {
  return input.match(WORD_BOUNDARY_REGEX) ?? [];
}

/**
 * Uppercases the first character of a string.
 */
export function capitalize(str: string): string {
  if (str.length === 0) {
    return str;
  }
  return `${str.charAt(0).toUpperCase()}${str.slice(1)}`;
}

/**
 * Lowercases the first character of a string.
 */
export function uncapitalize(str: string): string {
  if (str.length === 0) {
    return str;
  }
  return `${str.charAt(0).toLowerCase()}${str.slice(1)}`;
}

/**
 * Converts a string into `camelCase`.
 */
export function camelCase(str: string): string {
  const words = splitWords(str);
  return words
    .map((word, index) => {
      const lower = word.toLowerCase();
      return index === 0 ? lower : capitalize(lower);
    })
    .join("");
}

/**
 * Converts a string into `PascalCase`.
 */
export function pascalCase(str: string): string {
  return splitWords(str)
    .map((word) => capitalize(word.toLowerCase()))
    .join("");
}

/**
 * Converts a string into `snake_case`.
 */
export function snakeCase(str: string): string {
  return splitWords(str)
    .map((word) => word.toLowerCase())
    .join("_");
}

/**
 * Converts a string into `kebab-case`.
 */
export function kebabCase(str: string): string {
  return splitWords(str)
    .map((word) => word.toLowerCase())
    .join("-");
}

/**
 * Converts Unicode text (including Vietnamese diacritics and `đ/Đ`) into a clean URL slug.
 */
export function slugify(str: string, separator = "-"): string {
  const normalized = str
    .replaceAll("đ", "d")
    .replaceAll("Đ", "D")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, separator);

  const escapedSep = escapeRegExp(separator);
  return normalized.replace(
    new RegExp(`^${escapedSep}+|${escapedSep}+$`, "g"),
    "",
  );
}

/**
 * Truncates `str` to at most `maxLength` characters (by Unicode code points) with `suffix`.
 */
export function truncate(
  str: string,
  maxLength: number,
  suffix = "\u2026",
): string {
  if (not(isInteger(maxLength)) || maxLength < 0) {
    throw new RangeError(
      `truncate: maxLength must be a non-negative integer (got ${maxLength})`,
    );
  }
  const chars = [...str];
  if (chars.length <= maxLength) {
    return str;
  }
  const suffixChars = [...suffix];
  if (suffixChars.length >= maxLength) {
    return chars.slice(0, maxLength).join("");
  }
  return `${chars.slice(0, maxLength - suffixChars.length).join("")}${suffix}`;
}

/**
 * Removes `prefix` from the start of `str` if present.
 */
export function trimPrefix(str: string, prefix: string): string {
  return prefix.length > 0 && str.startsWith(prefix)
    ? str.slice(prefix.length)
    : str;
}

/**
 * Removes `suffix` from the end of `str` if present.
 */
export function trimSuffix(str: string, suffix: string): string {
  return suffix.length > 0 && str.endsWith(suffix)
    ? str.slice(0, -suffix.length)
    : str;
}

/**
 * Ensures `str` starts with `prefix` (adds it only if missing).
 */
export function ensurePrefix(str: string, prefix: string): string {
  return str.startsWith(prefix) ? str : `${prefix}${str}`;
}

/**
 * Ensures `str` ends with `suffix` (adds it only if missing).
 */
export function ensureSuffix(str: string, suffix: string): string {
  return str.endsWith(suffix) ? str : `${str}${suffix}`;
}

/**
 * Splits `str` on the first occurrence of `separator` into `[head, rest]`.
 * If `separator` is not found, `rest` is `undefined`.
 */
export function splitOnce(
  str: string,
  separator: string,
): [string, string | undefined] {
  const index = str.indexOf(separator);
  if (index === -1) {
    return [str, undefined];
  }
  return [str.slice(0, index), str.slice(index + separator.length)];
}

/**
 * Escapes special regular expression metacharacters in `str`.
 */
export function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Escapes HTML special characters (`&`, `<`, `>`, `"`, `'`) using Bun's SIMD-accelerated `Bun.escapeHTML()`.
 */
export function escapeHtml(str: string): string {
  return Bun.escapeHTML(str);
}

/**
 * Removes ANSI escape sequences from `str` using Bun's SIMD-accelerated `Bun.stripANSI()`.
 */
export function stripAnsi(str: string): string {
  return Bun.stripANSI(str);
}

/**
 * Returns the visual terminal column width of `str` (handling ANSI codes, East Asian wide chars, and emoji)
 * via Bun's native `Bun.stringWidth()`.
 */
export function stringWidth(str: string): number {
  return Bun.stringWidth(str);
}

/**
 * Masks sensitive strings (API keys, tokens, emails) leaving `visibleStart` and `visibleEnd`
 * characters exposed.
 */
export function maskSecret(
  secret: string,
  visibleStart = 3,
  visibleEnd = 3,
  maskChar = "*",
): string {
  if (secret.length === 0) {
    return "";
  }
  if (secret.length <= visibleStart + visibleEnd) {
    return maskChar.repeat(secret.length);
  }
  const start = visibleStart > 0 ? secret.slice(0, visibleStart) : "";
  const end = visibleEnd > 0 ? secret.slice(-visibleEnd) : "";
  const maskedLen = secret.length - visibleStart - visibleEnd;
  return `${start}${maskChar.repeat(maskedLen)}${end}`;
}
