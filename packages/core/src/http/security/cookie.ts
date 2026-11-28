import { timingSafeEqualBytes, type CookieOptions } from "../../common/index";
import { isDangerousKey } from "./prototype-sanitizer";

const VALID_COOKIE_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const VALID_COOKIE_PATH_RE = /^[\x20-\x3a\x3c-\x7e]*$/;
const VALID_COOKIE_DOMAIN_RE =
  /^\.?[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

const SAME_SITE_MAP = new Map<string, "Strict" | "Lax" | "None">([
  ["strict", "Strict"],
  ["lax", "Lax"],
  ["none", "None"],
]);

const PRIORITY_MAP = new Map<string, "Low" | "Medium" | "High">([
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
]);

function trimSpaceAndTab(input: string): string {
  let start = 0;
  let end = input.length;
  while (start < end && (input.charCodeAt(start) === 0x20 || input.charCodeAt(start) === 0x09)) {
    start++;
  }
  while (end > start && (input.charCodeAt(end - 1) === 0x20 || input.charCodeAt(end - 1) === 0x09)) {
    end--;
  }
  return input.slice(start, end);
}

/**
 * Validates and normalizes cookie signing secrets (`cookies.secret`).
 * Throws if an empty string, empty array, or empty entry is provided.
 */
export function normalizeCookieSecrets(
  secret: string | string[] | undefined,
): readonly string[] | undefined {
  if (secret === undefined) {
    return undefined;
  }
  const list = Array.isArray(secret) ? secret : [secret];
  if (list.length === 0) {
    throw new Error("cookies.secret must not be an empty array.");
  }
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (typeof s !== "string" || s.length === 0) {
      throw new Error("cookies.secret entries must be non-empty strings.");
    }
  }
  return Object.freeze([...list]);
}

function hmacSignBase64(value: string, secret: string): string {
  return new Bun.CryptoHasher("sha256", secret)
    .update(value)
    .digest("base64")
    .replace(/=+$/, "");
}

export const SIGNED_COOKIE_PREFIX = "s:";

/**
 * Signs and verifies cookie values with HMAC-SHA256 (`s:<value>.<sig>`),
 * supporting secret rotation (signs with the first secret, verifies against all).
 * Matches NestJS v12 `CookieSigner`.
 */
export class CookieSigner {
  private readonly secrets: readonly string[];

  constructor(secret: string | string[]) {
    const normalized = normalizeCookieSecrets(secret);
    if (!normalized || normalized.length === 0) {
      throw new Error("cookies.secret must not be empty.");
    }
    this.secrets = normalized;
  }

  /**
   * Returns `s:<value>.<signature>`, signed with the first secret.
   */
  sign(value: string): string {
    return signCookieValue(value, this.secrets[0]!);
  }

  /**
   * Returns the original value when `input` carries a valid signature for
   * any of the secrets, or `undefined` otherwise. The `s:` prefix is optional.
   */
  unsign(input: string): string | undefined {
    const result = unsignCookieValue(input, this.secrets);
    return result === false ? undefined : result;
  }

  /**
   * Returns the normalized read-only list of secrets held by this signer.
   */
  getSecrets(): readonly string[] {
    return this.secrets;
  }
}

/**
 * Signs a cookie value with HMAC-SHA256 (`s:<value>.<sig>`), using standard
 * unpadded base64 matching `cookie-signature` / NestJS v12.
 */
export function signCookieValue(value: string, secret: string): string {
  return `s:${value}.${hmacSignBase64(value, secret)}`;
}

/**
 * Verifies a signed cookie value against one or more secrets using constant-time
 * comparison (supports secret rotation). Accepts payloads with or without the `s:` prefix.
 */
export function unsignCookieValue(
  signedValue: string,
  secrets: readonly string[],
): string | false {
  if (typeof signedValue !== "string") {
    return false;
  }
  const body = signedValue.startsWith(SIGNED_COOKIE_PREFIX)
    ? signedValue.slice(SIGNED_COOKIE_PREFIX.length)
    : signedValue;
  const dotIdx = body.lastIndexOf(".");
  if (dotIdx < 0) {
    return false;
  }
  const rawValue = body.slice(0, dotIdx);
  const providedSig = body.slice(dotIdx + 1);
  if (!providedSig) {
    return false;
  }
  const providedBuf = Buffer.from(providedSig, "utf8");

  for (let i = 0; i < secrets.length; i++) {
    const secret = secrets[i];
    if (!secret) continue;
    const expectedSig = hmacSignBase64(rawValue, secret);
    const expectedBuf = Buffer.from(expectedSig, "utf8");
    if (timingSafeEqualBytes(providedBuf, expectedBuf)) {
      return rawValue;
    }
  }

  return false;
}

/**
 * Extracts and verifies signed cookies from a parsed cookie record.
 */
export function extractSignedCookies(
  cookies: Record<string, string>,
  secrets: readonly string[] | undefined,
): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  if (!secrets || secrets.length === 0) {
    return out;
  }
  for (const [name, val] of Object.entries(cookies)) {
    if (isDangerousKey(name)) continue;
    if (!val.startsWith(SIGNED_COOKIE_PREFIX)) continue;
    const verified = unsignCookieValue(val, secrets);
    if (verified !== false) {
      out[name] = verified;
    }
  }
  return out;
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Parses an HTTP `Cookie` header string (or array of header values) into a
 * prototype-less (`Object.create(null)`) key-value record.
 */
export function parseCookieHeader(
  header: string | readonly string[] | null | undefined,
): Record<string, string> {
  const cookies: Record<string, string> = Object.create(null);
  if (!header) {
    return cookies;
  }
  const rawHeader: string = Array.isArray(header)
    ? header.join("; ")
    : (header as string);
  if (!rawHeader) {
    return cookies;
  }

  const pairs = rawHeader.split(";");
  for (let i = 0; i < pairs.length; i++) {
    const part = pairs[i];
    if (!part) continue;
    const eqIndex = part.indexOf("=");
    if (eqIndex <= 0) continue;

    const rawName = trimSpaceAndTab(part.slice(0, eqIndex));
    if (!rawName) {
      continue;
    }

    let rawValue = trimSpaceAndTab(part.slice(eqIndex + 1));
    if (
      rawValue.length >= 2 &&
      rawValue.charCodeAt(0) === 34 &&
      rawValue.charCodeAt(rawValue.length - 1) === 34
    ) {
      rawValue = rawValue.slice(1, -1);
    }

    if (!Object.prototype.hasOwnProperty.call(cookies, rawName)) {
      cookies[rawName] = safeDecodeURIComponent(rawValue);
    }
  }

  return cookies;
}

/**
 * Extracts cookies from a `Request`, leveraging Bun's native `req.cookies`
 * (`CookieMap`) when available and falling back to parsing the `Cookie` header.
 */
export function extractRequestCookies(req: Request): Record<string, string> {
  const bunCookies = (
    req as Request & {
      cookies?: Iterable<[string, string]>;
    }
  ).cookies;

  if (
    bunCookies !== undefined &&
    bunCookies !== null &&
    typeof bunCookies[Symbol.iterator] === "function"
  ) {
    const out: Record<string, string> = Object.create(null);
    let hasEntries = false;
    for (const [rawName, rawValue] of bunCookies) {
      hasEntries = true;
      if (!rawName || isDangerousKey(rawName)) {
        continue;
      }
      let normalizedValue = rawValue;
      if (
        normalizedValue.length >= 2 &&
        normalizedValue.charCodeAt(0) === 34 &&
        normalizedValue.charCodeAt(normalizedValue.length - 1) === 34
      ) {
        normalizedValue = normalizedValue.slice(1, -1);
      }
      if (!Object.prototype.hasOwnProperty.call(out, rawName)) {
        out[rawName] = normalizedValue;
      }
    }
    if (hasEntries) {
      return out;
    }
  }

  const parsed = parseCookieHeader(req.headers.get("cookie"));
  for (const key of Object.keys(parsed)) {
    if (isDangerousKey(key)) {
      delete parsed[key];
    }
  }
  return parsed;
}

/**
 * Serializes a cookie name, value, and options into a compliant `Set-Cookie` header value.
 */
export function serializeCookie(
  name: string,
  value: string,
  options: CookieOptions = {},
): string {
  if (typeof name !== "string" || !name || !VALID_COOKIE_NAME_RE.test(name)) {
    throw new TypeError(`Invalid cookie name: "${name}"`);
  }
  if (typeof value !== "string") {
    throw new TypeError("Cookie value must be a string");
  }

  let encodedValue: string;
  try {
    encodedValue = encodeURIComponent(value);
  } catch {
    throw new TypeError("Cookie value is not a well-formed UTF-16 string");
  }

  const path = options.path === undefined ? "/" : options.path;
  if (typeof path !== "string" || !VALID_COOKIE_PATH_RE.test(path)) {
    throw new TypeError("Invalid cookie path");
  }

  if (
    options.domain !== undefined &&
    (typeof options.domain !== "string" ||
      !VALID_COOKIE_DOMAIN_RE.test(options.domain))
  ) {
    throw new TypeError("Invalid cookie domain");
  }

  if (
    options.maxAge !== undefined &&
    (typeof options.maxAge !== "number" || !Number.isSafeInteger(options.maxAge))
  ) {
    throw new TypeError(`Invalid cookie maxAge: ${String(options.maxAge)}`);
  }

  if (
    options.expires !== undefined &&
    (!(options.expires instanceof Date) ||
      Number.isNaN(options.expires.getTime()))
  ) {
    throw new TypeError("Invalid cookie expires date");
  }

  let sameSite: "Strict" | "Lax" | "None" | undefined;
  if (options.sameSite !== undefined && options.sameSite !== false) {
    if (options.sameSite === true) {
      sameSite = "Strict";
    } else if (typeof options.sameSite === "string") {
      sameSite = SAME_SITE_MAP.get(options.sameSite.toLowerCase());
      if (!sameSite) {
        throw new TypeError(`Invalid cookie sameSite: "${options.sameSite}"`);
      }
    } else {
      throw new TypeError(`Invalid cookie sameSite: ${String(options.sameSite)}`);
    }
  }

  if (sameSite === "None" && !options.secure) {
    throw new TypeError('Cookie with SameSite="None" requires "secure: true"');
  }

  if (options.partitioned && !options.secure) {
    throw new TypeError('Partitioned cookie requires "secure: true"');
  }

  let priority: "Low" | "Medium" | "High" | undefined;
  if (options.priority !== undefined) {
    if (typeof options.priority !== "string") {
      throw new TypeError(`Invalid cookie priority: ${String(options.priority)}`);
    }
    priority = PRIORITY_MAP.get(options.priority.toLowerCase());
    if (!priority) {
      throw new TypeError(`Invalid cookie priority: "${options.priority}"`);
    }
  }

  // Delegate to Zig-native `Bun.Cookie` whenever its canonical attribute order matches
  // NestJS/RFC 6265 serialization (Bun.Cookie defaults omitted `sameSite` to "lax",
  // omits `Priority`, orders `Domain` before `Path`, `Expires` before `Max-Age`,
  // and `Secure` before `HttpOnly`).
  if (
    sameSite !== undefined &&
    priority === undefined &&
    (options.domain === undefined || !path) &&
    !(options.maxAge !== undefined && options.expires !== undefined) &&
    !(options.httpOnly && options.secure) &&
    typeof Bun !== "undefined" &&
    typeof Bun.Cookie === "function"
  ) {
    const bunCookie = new Bun.Cookie(name, value, {
      path,
      ...(options.domain !== undefined ? { domain: options.domain } : {}),
      ...(options.maxAge !== undefined ? { maxAge: options.maxAge } : {}),
      ...(options.expires !== undefined ? { expires: options.expires } : {}),
      httpOnly: Boolean(options.httpOnly),
      secure: Boolean(options.secure),
      partitioned: Boolean(options.partitioned),
      sameSite: sameSite.toLowerCase() as "strict" | "lax" | "none",
    });
    return bunCookie.toString();
  }

  const parts: string[] = [`${name}=${encodedValue}`];
  if (path) {
    parts.push(`Path=${path}`);
  }
  if (options.domain !== undefined) {
    parts.push(`Domain=${options.domain}`);
  }
  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${options.maxAge}`);
  }
  if (options.expires !== undefined) {
    parts.push(`Expires=${options.expires.toUTCString()}`);
  }
  if (options.httpOnly) {
    parts.push("HttpOnly");
  }
  if (options.secure) {
    parts.push("Secure");
  }
  if (options.partitioned) {
    parts.push("Partitioned");
  }
  if (priority !== undefined) {
    parts.push(`Priority=${priority}`);
  }
  if (sameSite !== undefined) {
    parts.push(`SameSite=${sameSite}`);
  }
  return parts.join("; ");
}
