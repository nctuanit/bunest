import {
  Inject,
  Injectable,
  Module,
  Optional,
  type DynamicModule,
  type FactoryDependency,
  type ModuleMetadata,
} from "@bunest/core";
import {
  JwtExpiredException,
  JwtInvalidException,
  JwtNotBeforeException,
} from "../jwt/jwt.errors";
import type { JwtPayload } from "../jwt/jwt.interface";
import {
  base64UrlDecode,
  base64UrlDecodeUtf8,
  timingSafeEqualString,
  utf8Encode,
} from "../utils/crypto.util";

export const JWKS_CLIENT_OPTIONS = Symbol.for(
  "bunest:security:jwks_client_options",
);

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type JwksAlgorithm =
  "RS256" | "RS384" | "RS512" | "ES256" | "ES384" | "ES512";

export interface JwksKey {
  kty: string;
  kid?: string;
  use?: string;
  key_ops?: readonly string[];
  alg?: string;
  // RSA public components
  n?: string;
  e?: string;
  // EC public components
  crv?: string;
  x?: string;
  y?: string;
  // Symmetric key component (explicitly rejected)
  k?: string;
  [key: string]: unknown;
}

export interface JsonWebKeySet {
  keys: readonly JwksKey[];
}

export interface JwksClientOptions {
  jwksUri: string;
  /** How long fetched JWKS entries remain cached (ms). Default: 600_000 (10 minutes). */
  cacheTtlMs?: number;
  /** Minimum cooldown between unknown-`kid` forced refreshes (ms) to mitigate JWKS DoS. Default: 30_000 (30 seconds). */
  rateLimitRefreshMs?: number;
  /** HTTP request timeout when fetching JWKS (ms). Default: 5_000 (5 seconds). */
  timeoutMs?: number;
  /** Custom HTTP headers sent when fetching the JWKS endpoint. */
  headers?: Record<string, string>;
  /** Injectable fetch implementation for offline / deterministic testing. */
  fetchFn?: FetchLike;
  /** Injectable clock (returns epoch ms) for deterministic testing. */
  nowFn?: () => number;
  /** Default allowed asymmetric algorithms. Defaults to RS256/RS384/RS512/ES256/ES384/ES512. */
  algorithms?: readonly JwksAlgorithm[];
  /** Default expected `iss` claim(s). */
  issuer?: string | readonly string[];
  /** Default expected `aud` claim(s). */
  audience?: string | RegExp | ReadonlyArray<string | RegExp>;
  /** Default clock skew tolerance in seconds. */
  clockTolerance?: number;
  /** Register `JwksModule` globally. */
  global?: boolean;
}

export interface JwksModuleAsyncOptions {
  imports?: ModuleMetadata["imports"];
  inject?: FactoryDependency[];
  useFactory: (
    ...args: any[]
  ) => JwksClientOptions | Promise<JwksClientOptions>;
  global?: boolean;
}

export interface JwksVerifyOptions {
  issuer?: string | readonly string[];
  audience?: string | RegExp | ReadonlyArray<string | RegExp>;
  algorithms?: readonly JwksAlgorithm[];
  clockTolerance?: number;
  subject?: string;
  jwtid?: string;
  nonce?: string;
  ignoreExpiration?: boolean;
  ignoreNotBefore?: boolean;
  currentDate?: Date;
}

const RSA_ALGS = new Set<JwksAlgorithm>(["RS256", "RS384", "RS512"]);
const EC_ALGS = new Set<JwksAlgorithm>(["ES256", "ES384", "ES512"]);
const ALL_JWKS_ALGS = new Set<JwksAlgorithm>([
  "RS256",
  "RS384",
  "RS512",
  "ES256",
  "ES384",
  "ES512",
]);

function getHashForJwksAlg(
  alg: JwksAlgorithm,
): "SHA-256" | "SHA-384" | "SHA-512" {
  switch (alg) {
    case "RS256":
    case "ES256":
      return "SHA-256";
    case "RS384":
    case "ES384":
      return "SHA-384";
    case "RS512":
    case "ES512":
      return "SHA-512";
  }
}

function getExpectedEcCurve(alg: JwksAlgorithm): "P-256" | "P-384" | "P-521" {
  switch (alg) {
    case "ES256":
      return "P-256";
    case "ES384":
      return "P-384";
    case "ES512":
      return "P-521";
    default:
      throw new JwtInvalidException(
        `Algorithm "${alg}" is not an ECDSA algorithm`,
      );
  }
}

function inferAlgFromEcCurve(crv: string | undefined): JwksAlgorithm | null {
  switch (crv) {
    case "P-256":
      return "ES256";
    case "P-384":
      return "ES384";
    case "P-521":
      return "ES512";
    default:
      return null;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates and imports a public RSA or EC JWK into a WebCrypto `CryptoKey`
 * suitable for JWT signature verification.
 *
 * Explicitly rejects symmetric `oct` keys, `alg: "none"`, encryption-only keys,
 * and mismatched key types / curves / algorithms.
 */
export async function importPublicJwk(
  jwk: JwksKey,
  alg?: JwksAlgorithm,
): Promise<{ key: CryptoKey; algorithm: JwksAlgorithm }> {
  if (!isPlainRecord(jwk) || typeof jwk.kty !== "string") {
    throw new JwtInvalidException("Malformed JWK: missing kty");
  }

  if (jwk.kty.toLowerCase() === "oct") {
    throw new JwtInvalidException(
      'Rejected symmetric JWK (kty: "oct"): JWKS verification requires asymmetric public keys',
    );
  }

  if (typeof jwk.alg === "string" && jwk.alg.toLowerCase() === "none") {
    throw new JwtInvalidException('Rejected JWK with forbidden alg: "none"');
  }

  if (jwk.use !== undefined && jwk.use !== "sig") {
    throw new JwtInvalidException(
      `Rejected JWK with non-signature use: "${String(jwk.use)}"`,
    );
  }

  if (Array.isArray(jwk.key_ops) && !jwk.key_ops.includes("verify")) {
    throw new JwtInvalidException(
      'Rejected JWK whose key_ops does not include "verify"',
    );
  }

  let resolvedAlg: JwksAlgorithm;
  if (alg !== undefined) {
    if (!ALL_JWKS_ALGS.has(alg)) {
      throw new JwtInvalidException(
        `Rejected unsupported JWKS algorithm: "${String(alg)}"`,
      );
    }
    if (jwk.alg !== undefined && jwk.alg !== alg) {
      throw new JwtInvalidException(
        `JWK algorithm "${jwk.alg}" does not match requested algorithm "${alg}"`,
      );
    }
    resolvedAlg = alg;
  } else if (typeof jwk.alg === "string") {
    if (!ALL_JWKS_ALGS.has(jwk.alg as JwksAlgorithm)) {
      throw new JwtInvalidException(
        `Rejected unsupported JWK algorithm: "${jwk.alg}"`,
      );
    }
    resolvedAlg = jwk.alg as JwksAlgorithm;
  } else if (jwk.kty === "RSA") {
    resolvedAlg = "RS256";
  } else if (jwk.kty === "EC") {
    const inferred = inferAlgFromEcCurve(jwk.crv);
    if (!inferred) {
      throw new JwtInvalidException(
        `Unsupported EC JWK curve: "${String(jwk.crv)}"`,
      );
    }
    resolvedAlg = inferred;
  } else {
    throw new JwtInvalidException(`Unsupported JWK key type: "${jwk.kty}"`);
  }

  if (RSA_ALGS.has(resolvedAlg)) {
    if (jwk.kty !== "RSA") {
      throw new JwtInvalidException(
        `JWK key type "${jwk.kty}" is incompatible with RSA algorithm "${resolvedAlg}"`,
      );
    }
    if (
      typeof jwk.n !== "string" ||
      jwk.n.length === 0 ||
      typeof jwk.e !== "string" ||
      jwk.e.length === 0
    ) {
      throw new JwtInvalidException("Malformed RSA JWK: missing n or e");
    }
    // Import strictly public components only (never pass private fields d/p/q/dp/dq/qi)
    const sanitized = {
      kty: "RSA",
      n: jwk.n,
      e: jwk.e,
      ext: true,
    };
    try {
      const key = await crypto.subtle.importKey(
        "jwk",
        sanitized,
        {
          name: "RSASSA-PKCS1-v1_5",
          hash: getHashForJwksAlg(resolvedAlg),
        },
        false,
        ["verify"],
      );
      return { key, algorithm: resolvedAlg };
    } catch {
      throw new JwtInvalidException(
        `Failed to import RSA JWK for "${resolvedAlg}"`,
      );
    }
  }

  if (EC_ALGS.has(resolvedAlg)) {
    if (jwk.kty !== "EC") {
      throw new JwtInvalidException(
        `JWK key type "${jwk.kty}" is incompatible with ECDSA algorithm "${resolvedAlg}"`,
      );
    }
    const expectedCurve = getExpectedEcCurve(resolvedAlg);
    if (jwk.crv !== expectedCurve) {
      throw new JwtInvalidException(
        `EC JWK curve "${String(jwk.crv)}" does not match algorithm "${resolvedAlg}" (expected "${expectedCurve}")`,
      );
    }
    if (
      typeof jwk.x !== "string" ||
      jwk.x.length === 0 ||
      typeof jwk.y !== "string" ||
      jwk.y.length === 0
    ) {
      throw new JwtInvalidException("Malformed EC JWK: missing x or y");
    }
    const sanitized = {
      kty: "EC",
      crv: jwk.crv,
      x: jwk.x,
      y: jwk.y,
      ext: true,
    };
    try {
      const key = await crypto.subtle.importKey(
        "jwk",
        sanitized,
        {
          name: "ECDSA",
          namedCurve: expectedCurve,
        },
        false,
        ["verify"],
      );
      return { key, algorithm: resolvedAlg };
    } catch {
      throw new JwtInvalidException(
        `Failed to import EC JWK for "${resolvedAlg}"`,
      );
    }
  }

  throw new JwtInvalidException(`Unsupported JWKS algorithm: "${resolvedAlg}"`);
}

interface CachedJwksState {
  keys: readonly JwksKey[];
  expiresAt: number;
}

/**
 * Pure WebCrypto JSON Web Key Set (JWKS) client with TTL caching, single-flight
 * fetch deduplication, automatic key rotation on unknown `kid`, unknown-`kid`
 * DoS refresh cooldown, strict `oct` / `alg: "none"` rejection, and RFC 7519
 * JWT signature & claims verification.
 */
@Injectable()
export class JwksClient {
  private readonly jwksUri: string;
  private readonly cacheTtlMs: number;
  private readonly rateLimitRefreshMs: number;
  private readonly timeoutMs: number;
  private readonly headers?: Record<string, string>;
  private readonly fetchFn: FetchLike;
  private readonly nowFn: () => number;
  private readonly defaultAlgorithms?: readonly JwksAlgorithm[];
  private readonly defaultIssuer?: string | readonly string[];
  private readonly defaultAudience?:
    string | RegExp | ReadonlyArray<string | RegExp>;
  private readonly defaultClockTolerance?: number;

  private cache: CachedJwksState | null = null;
  private lastForcedRefreshAt = -Infinity;
  private inFlightFetch: Promise<readonly JwksKey[]> | null = null;
  private readonly importedKeyCache = new Map<string, CryptoKey>();

  constructor(
    @Optional()
    @Inject(JWKS_CLIENT_OPTIONS)
    options?: JwksClientOptions,
  ) {
    if (
      !options ||
      typeof options.jwksUri !== "string" ||
      options.jwksUri.trim().length === 0
    ) {
      throw new Error("JwksClient requires a non-empty jwksUri option");
    }
    this.jwksUri = options.jwksUri.trim();
    this.cacheTtlMs = options.cacheTtlMs ?? 10 * 60 * 1000;
    this.rateLimitRefreshMs = options.rateLimitRefreshMs ?? 30 * 1000;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.headers = options.headers;
    this.fetchFn =
      options.fetchFn ?? ((input, init) => globalThis.fetch(input, init));
    this.nowFn = options.nowFn ?? (() => Date.now());
    this.defaultAlgorithms = options.algorithms;
    this.defaultIssuer = options.issuer;
    this.defaultAudience = options.audience;
    this.defaultClockTolerance = options.clockTolerance;
  }

  /**
   * Clears cached JWKS entries, imported CryptoKeys, and rate-limit state.
   */
  clearCache(): void {
    this.cache = null;
    this.lastForcedRefreshAt = -Infinity;
    this.importedKeyCache.clear();
  }

  /**
   * Forces a refresh of the remote JWKS document (deduplicated across concurrent callers).
   */
  async refresh(): Promise<readonly JwksKey[]> {
    return this.fetchJwks();
  }

  /**
   * Returns cached JWKS keys, fetching from `jwksUri` if cache is empty or expired.
   */
  async getKeys(forceRefresh = false): Promise<readonly JwksKey[]> {
    const now = this.nowFn();
    if (!forceRefresh && this.cache !== null && now < this.cache.expiresAt) {
      return this.cache.keys;
    }
    return this.fetchJwks();
  }

  /**
   * Resolves and imports a public `CryptoKey` matching `kid` and `alg`.
   * Automatically refreshes once on an unknown `kid` unless within `rateLimitRefreshMs` cooldown.
   */
  async getSigningKey(
    kid: string | undefined,
    alg: JwksAlgorithm,
  ): Promise<CryptoKey> {
    if (!ALL_JWKS_ALGS.has(alg)) {
      throw new JwtInvalidException(
        `Rejected unsupported JWKS algorithm: "${String(alg)}"`,
      );
    }

    const now = this.nowFn();
    let fetchedFresh = false;
    let keys: readonly JwksKey[];

    if (this.cache !== null && now < this.cache.expiresAt) {
      keys = this.cache.keys;
    } else {
      keys = await this.fetchJwks();
      fetchedFresh = true;
    }

    let jwk = this.findMatchingJwk(keys, kid, alg);

    // Unknown kid -> piggyback on any in-flight refresh or attempt a single cooldown-gated refresh
    if (!jwk && kid !== undefined && !fetchedFresh) {
      if (this.inFlightFetch) {
        keys = await this.inFlightFetch;
        jwk = this.findMatchingJwk(keys, kid, alg);
      } else {
        const elapsed = this.nowFn() - this.lastForcedRefreshAt;
        if (elapsed < this.rateLimitRefreshMs) {
          throw new JwtInvalidException(
            `Signing key with kid "${kid}" not found in JWKS (refresh rate-limited)`,
          );
        }
        this.lastForcedRefreshAt = this.nowFn();
        keys = await this.fetchJwks();
        jwk = this.findMatchingJwk(keys, kid, alg);
      }
    }

    if (!jwk) {
      throw new JwtInvalidException(
        kid !== undefined
          ? `Signing key with kid "${kid}" not found in JWKS`
          : `No compatible public signing key found in JWKS for algorithm "${alg}"`,
      );
    }

    const keyIndex = keys.indexOf(jwk);
    const cacheKey = `${kid ?? `__idx_${keyIndex}`}:${alg}:${jwk.kty}:${jwk.crv ?? ""}`;
    const existing = this.importedKeyCache.get(cacheKey);
    if (existing) {
      return existing;
    }

    const { key } = await importPublicJwk(jwk, alg);
    this.importedKeyCache.set(cacheKey, key);
    return key;
  }

  /**
   * Verifies a JWT using keys fetched from this JWKS client:
   * - Rejects `alg: "none"`, symmetric algorithms (`HS*`), and symmetric `oct` JWKs.
   * - Reads JWT header `kid` + `alg`, fetches & imports the matching public `CryptoKey`.
   * - Verifies RSA/ECDSA cryptographic signature via `crypto.subtle.verify`.
   * - Validates standard claims (`exp`, `nbf`, `iss`, `aud`, `sub`, `jti`, `nonce`).
   * - Throws `JwtExpiredException`, `JwtNotBeforeException`, or `JwtInvalidException`.
   */
  async verifyJwtWithJwks<T extends JwtPayload = JwtPayload>(
    token: string,
    options: JwksVerifyOptions = {},
  ): Promise<T> {
    if (typeof token !== "string" || token.length === 0) {
      throw new JwtInvalidException("JWT must be a non-empty string");
    }

    const parts = token.split(".");
    if (parts.length !== 3) {
      throw new JwtInvalidException("Malformed JWT: expected 3 segments");
    }

    const [encodedHeader, encodedPayload, encodedSig] = parts as [
      string,
      string,
      string,
    ];
    if (!encodedHeader || !encodedPayload || !encodedSig) {
      throw new JwtInvalidException("Malformed JWT: empty segment");
    }

    let header: unknown;
    let payload: unknown;
    let signatureBytes: Uint8Array<ArrayBuffer>;

    try {
      header = JSON.parse(base64UrlDecodeUtf8(encodedHeader));
      payload = JSON.parse(base64UrlDecodeUtf8(encodedPayload));
      signatureBytes = base64UrlDecode(encodedSig);
    } catch {
      throw new JwtInvalidException("Malformed JWT encoding or JSON");
    }

    if (!isPlainRecord(header) || !isPlainRecord(payload)) {
      throw new JwtInvalidException("Malformed JWT header or payload");
    }

    const rawAlg = header.alg;
    if (
      typeof rawAlg !== "string" ||
      rawAlg.toLowerCase() === "none" ||
      !ALL_JWKS_ALGS.has(rawAlg as JwksAlgorithm)
    ) {
      throw new JwtInvalidException(
        `Rejected unsupported or forbidden JWT algorithm: "${String(rawAlg)}"`,
      );
    }
    const alg = rawAlg as JwksAlgorithm;

    const allowedAlgs = options.algorithms ?? this.defaultAlgorithms;
    if (allowedAlgs && allowedAlgs.length > 0 && !allowedAlgs.includes(alg)) {
      throw new JwtInvalidException(
        `JWT algorithm "${alg}" is not permitted by allowlist`,
      );
    }

    const rawKid = header.kid;
    if (
      rawKid !== undefined &&
      (typeof rawKid !== "string" || rawKid.length === 0)
    ) {
      throw new JwtInvalidException("Malformed JWT header kid");
    }

    const publicKey = await this.getSigningKey(rawKid, alg);
    const signingInputBytes = utf8Encode(`${encodedHeader}.${encodedPayload}`);

    let validSignature: boolean;
    try {
      if (RSA_ALGS.has(alg)) {
        validSignature = await crypto.subtle.verify(
          "RSASSA-PKCS1-v1_5",
          publicKey,
          signatureBytes,
          signingInputBytes,
        );
      } else {
        validSignature = await crypto.subtle.verify(
          { name: "ECDSA", hash: getHashForJwksAlg(alg) },
          publicKey,
          signatureBytes,
          signingInputBytes,
        );
      }
    } catch {
      throw new JwtInvalidException("Invalid JWT signature");
    }

    if (!validSignature) {
      throw new JwtInvalidException("Invalid JWT signature");
    }

    this.validateClaims(payload as JwtPayload, {
      ...options,
      issuer: options.issuer ?? this.defaultIssuer,
      audience: options.audience ?? this.defaultAudience,
      clockTolerance: options.clockTolerance ?? this.defaultClockTolerance,
    });

    return payload as T;
  }

  private findMatchingJwk(
    keys: readonly JwksKey[],
    kid: string | undefined,
    alg: JwksAlgorithm,
  ): JwksKey | undefined {
    const expectedKty = RSA_ALGS.has(alg) ? "RSA" : "EC";
    const expectedCurve = EC_ALGS.has(alg)
      ? getExpectedEcCurve(alg)
      : undefined;

    if (kid !== undefined) {
      const byKid = keys.filter((k) => isPlainRecord(k) && k.kid === kid);
      if (byKid.length === 0) {
        return undefined;
      }

      // Explicitly detect symmetric oct key matching requested kid so we fail immediately
      // with a clear rejection error rather than treating it as a missing key and triggering refresh.
      const octMatch = byKid.find(
        (k) => typeof k.kty === "string" && k.kty.toLowerCase() === "oct",
      );
      if (octMatch) {
        throw new JwtInvalidException(
          'Rejected symmetric JWK (kty: "oct"): JWKS verification requires asymmetric public keys',
        );
      }

      // Prefer signature-use key matching algorithm/key type
      const exact = byKid.find(
        (k) =>
          (k.use === undefined || k.use === "sig") &&
          k.kty === expectedKty &&
          (expectedCurve === undefined || k.crv === expectedCurve) &&
          (k.alg === undefined || k.alg === alg),
      );
      if (exact) {
        return exact;
      }

      // Return first matching kid so importPublicJwk emits the exact mismatch/rejection error
      return byKid[0];
    }

    // No kid in JWT header: reject if JWKS only contains oct keys
    const sigKeys = keys.filter(
      (k) => isPlainRecord(k) && (k.use === undefined || k.use === "sig"),
    );
    if (
      sigKeys.length > 0 &&
      sigKeys.every(
        (k) => typeof k.kty === "string" && k.kty.toLowerCase() === "oct",
      )
    ) {
      throw new JwtInvalidException(
        'Rejected symmetric JWK (kty: "oct"): JWKS verification requires asymmetric public keys',
      );
    }

    const compatible = sigKeys.filter(
      (k) =>
        k.kty === expectedKty &&
        (expectedCurve === undefined || k.crv === expectedCurve) &&
        (k.alg === undefined || k.alg === alg),
    );
    if (compatible.length === 1) {
      return compatible[0];
    }
    if (compatible.length > 1) {
      throw new JwtInvalidException(
        "JWT header missing kid while JWKS contains multiple compatible signing keys",
      );
    }
    return undefined;
  }

  private async fetchJwks(): Promise<readonly JwksKey[]> {
    if (this.inFlightFetch) {
      return this.inFlightFetch;
    }

    const task = (async (): Promise<readonly JwksKey[]> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      let response: Response;
      try {
        response = await this.fetchFn(this.jwksUri, {
          method: "GET",
          headers: {
            Accept: "application/json",
            ...(this.headers ?? {}),
          },
          signal: controller.signal,
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Unknown network error";
        throw new JwtInvalidException(
          `Failed to fetch JWKS from ${this.jwksUri}: ${message}`,
        );
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        throw new JwtInvalidException(
          `Failed to fetch JWKS from ${this.jwksUri}: HTTP ${response.status}`,
        );
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new JwtInvalidException(
          `Invalid JSON returned by JWKS endpoint ${this.jwksUri}`,
        );
      }

      if (!isPlainRecord(body) || !Array.isArray(body.keys)) {
        throw new JwtInvalidException(
          `Invalid JWKS payload from ${this.jwksUri}: expected { keys: [...] }`,
        );
      }

      const keys = (body.keys as unknown[]).filter(isPlainRecord) as JwksKey[];
      const now = this.nowFn();
      this.cache = {
        keys,
        expiresAt: now + this.cacheTtlMs,
      };
      this.importedKeyCache.clear();
      return keys;
    })();

    this.inFlightFetch = task;
    try {
      return await task;
    } finally {
      if (this.inFlightFetch === task) {
        this.inFlightFetch = null;
      }
    }
  }

  private validateClaims(payload: JwtPayload, opts: JwksVerifyOptions): void {
    const nowSec = Math.floor(
      (opts.currentDate?.getTime() ?? this.nowFn()) / 1000,
    );
    const tolerance = opts.clockTolerance ?? 0;

    if (
      payload.iat !== undefined &&
      (typeof payload.iat !== "number" || !Number.isFinite(payload.iat))
    ) {
      throw new JwtInvalidException("Invalid JWT iat claim");
    }

    if (!opts.ignoreExpiration && payload.exp !== undefined) {
      if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
        throw new JwtInvalidException("Invalid JWT exp claim");
      }
      if (nowSec >= payload.exp + tolerance) {
        throw new JwtExpiredException(new Date(payload.exp * 1000));
      }
    }

    if (!opts.ignoreNotBefore && payload.nbf !== undefined) {
      if (typeof payload.nbf !== "number" || !Number.isFinite(payload.nbf)) {
        throw new JwtInvalidException("Invalid JWT nbf claim");
      }
      if (nowSec + tolerance < payload.nbf) {
        throw new JwtNotBeforeException(new Date(payload.nbf * 1000));
      }
    }

    if (opts.issuer !== undefined) {
      const allowedIssuers = Array.isArray(opts.issuer)
        ? opts.issuer
        : [opts.issuer];
      if (
        typeof payload.iss !== "string" ||
        !allowedIssuers.includes(payload.iss)
      ) {
        throw new JwtInvalidException("JWT issuer mismatch");
      }
    }

    if (opts.audience !== undefined) {
      const expectedList = Array.isArray(opts.audience)
        ? opts.audience
        : [opts.audience];
      const tokenAudiences =
        typeof payload.aud === "string"
          ? [payload.aud]
          : Array.isArray(payload.aud)
            ? payload.aud.filter((a): a is string => typeof a === "string")
            : [];

      const matched = expectedList.some((expected) =>
        expected instanceof RegExp
          ? tokenAudiences.some((a) => expected.test(a))
          : tokenAudiences.includes(expected),
      );

      if (!matched) {
        throw new JwtInvalidException("JWT audience mismatch");
      }
    }

    if (opts.subject !== undefined && payload.sub !== opts.subject) {
      throw new JwtInvalidException("JWT subject mismatch");
    }

    if (opts.jwtid !== undefined && payload.jti !== opts.jwtid) {
      throw new JwtInvalidException("JWT jti mismatch");
    }

    if (opts.nonce !== undefined) {
      if (
        typeof payload.nonce !== "string" ||
        !timingSafeEqualString(payload.nonce, opts.nonce)
      ) {
        throw new JwtInvalidException("JWT nonce mismatch");
      }
    }
  }
}

export { JwksClient as JwksService };

@Module({})
export class JwksModule {
  static register(options: JwksClientOptions): DynamicModule {
    return {
      module: JwksModule,
      global: options.global,
      providers: [
        { provide: JWKS_CLIENT_OPTIONS, useValue: options },
        JwksClient,
      ],
      exports: [JwksClient, JWKS_CLIENT_OPTIONS],
    };
  }

  static registerAsync(options: JwksModuleAsyncOptions): DynamicModule {
    return {
      module: JwksModule,
      global: options.global,
      imports: options.imports,
      providers: [
        {
          provide: JWKS_CLIENT_OPTIONS,
          useFactory: options.useFactory,
          inject: options.inject,
        },
        JwksClient,
      ],
      exports: [JwksClient, JWKS_CLIENT_OPTIONS],
    };
  }
}
