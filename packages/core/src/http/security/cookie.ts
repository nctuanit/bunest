import { timingSafeEqualBytes, type CookieOptions } from "../../common/index";
import { isDangerousKey } from "./prototype-sanitizer";

const INVALID_COOKIE_NAME_RE = /[\x00-\x1f\x7f\s;,=]/;
const INVALID_HEADER_VALUE_RE = /[\r\n]/;

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

function hmacSignBase64Url(value: string, secret: string): string {
  return new Bun.CryptoHasher("sha256", secret)
    .update(value)
    .digest("base64url");
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
    const candidate = input.startsWith(SIGNED_COOKIE_PREFIX)
      ? input
      : `${SIGNED_COOKIE_PREFIX}${input}`;
    const result = unsignCookieValue(candidate, this.secrets);
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
 * Signs a cookie value with HMAC-SHA256 (`s:<value>.<sig>`).
 */
export function signCookieValue(value: string, secret: string): string {
  return `s:${value}.${hmacSignBase64Url(value, secret)}`;
}

/**
 * Verifies a signed cookie value against one or more secrets using constant-time
 * comparison (supports secret rotation). Returns the original unsigned value if valid.
 */
export function unsignCookieValue(
  signedValue: string,
  secrets: readonly string[],
): string | false {
  if (!signedValue.startsWith("s:")) {
    return false;
  }
  const body = signedValue.slice(2);
  const dotIdx = body.lastIndexOf(".");
  if (dotIdx <= 0) {
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
    const expectedSig = hmacSignBase64Url(rawValue, secret);
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
  const out: Record<string, string> = {};
  if (!secrets || secrets.length === 0) {
    return out;
  }
  for (const [name, val] of Object.entries(cookies)) {
    if (isDangerousKey(name)) continue;
    const verified = unsignCookieValue(val, secrets);
    if (verified !== false) {
      Object.defineProperty(out, name, {
        value: verified,
        enumerable: true,
        writable: true,
        configurable: true,
      });
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
 * Parses an HTTP `Cookie` header string into a sanitized key-value record.
 */
export function parseCookieHeader(
  header: string | null | undefined,
): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) {
    return cookies;
  }

  const pairs = header.split(";");
  for (let i = 0; i < pairs.length; i++) {
    const part = pairs[i];
    if (!part) continue;
    const eqIndex = part.indexOf("=");
    if (eqIndex <= 0) continue;

    const rawName = part.slice(0, eqIndex).trim();
    if (!rawName || isDangerousKey(rawName)) {
      continue;
    }

    let rawValue = part.slice(eqIndex + 1).trim();
    if (
      rawValue.length >= 2 &&
      rawValue.charCodeAt(0) === 34 &&
      rawValue.charCodeAt(rawValue.length - 1) === 34
    ) {
      rawValue = rawValue.slice(1, -1);
    }

    if (!Object.prototype.hasOwnProperty.call(cookies, rawName)) {
      Object.defineProperty(cookies, rawName, {
        value: safeDecodeURIComponent(rawValue),
        enumerable: true,
        writable: true,
        configurable: true,
      });
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
    const out: Record<string, string> = {};
    let hasEntries = false;
    for (const [rawName, rawValue] of bunCookies) {
      hasEntries = true;
      if (!rawName || isDangerousKey(rawName)) {
        continue;
      }
      Object.defineProperty(out, rawName, {
        value: rawValue,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    if (hasEntries) {
      return out;
    }
  }

  return parseCookieHeader(req.headers.get("cookie"));
}

/**
 * Serializes a cookie name, value, and options into a compliant `Set-Cookie` header value.
 */
export function serializeCookie(
  name: string,
  value: string,
  options: CookieOptions = {},
): string {
  if (!name || INVALID_COOKIE_NAME_RE.test(name)) {
    throw new TypeError(`Invalid cookie name: "${name}"`);
  }
  if (options.maxAge !== undefined && !Number.isFinite(options.maxAge)) {
    throw new TypeError(`Invalid cookie maxAge: ${options.maxAge}`);
  }
  if (options.domain !== undefined && INVALID_HEADER_VALUE_RE.test(options.domain)) {
    throw new TypeError("Invalid cookie domain");
  }
  if (options.path !== undefined && INVALID_HEADER_VALUE_RE.test(options.path)) {
    throw new TypeError("Invalid cookie path");
  }

  const sameSite: "strict" | "lax" | "none" | undefined =
    options.sameSite === true || options.sameSite === "strict"
      ? "strict"
      : options.sameSite === "lax"
        ? "lax"
        : options.sameSite === "none"
          ? "none"
          : undefined;

  const cookie = new Bun.Cookie(name, value, {
    ...(options.domain !== undefined ? { domain: options.domain } : {}),
    ...(options.path !== undefined ? { path: options.path } : {}),
    ...(options.maxAge !== undefined
      ? { maxAge: Math.floor(options.maxAge) }
      : {}),
    ...(options.expires !== undefined ? { expires: options.expires } : {}),
    ...(options.httpOnly ? { httpOnly: true } : {}),
    ...(options.secure ? { secure: true } : {}),
    ...(options.partitioned ? { partitioned: true } : {}),
    ...(sameSite !== undefined ? { sameSite } : {}),
  });

  let serialized = cookie.serialize();
  if (options.path === undefined) {
    // Bun.Cookie defaults Path=/ when omitted; strip default Path=/ if caller explicitly left path undefined
    serialized = serialized.replace(/;\s*Path=\//, "");
  }
  if (sameSite === undefined) {
    // Bun.Cookie defaults SameSite=Lax when omitted; strip default SameSite=Lax if caller did not specify sameSite
    serialized = serialized.replace(/;\s*SameSite=Lax/, "");
  }
  if (options.priority !== undefined) {
    const cap =
      options.priority === "high"
        ? "High"
        : options.priority === "medium"
          ? "Medium"
          : "Low";
    serialized += `; Priority=${cap}`;
  }
  return serialized;
}
