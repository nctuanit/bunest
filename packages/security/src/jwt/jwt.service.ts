import { Inject, Injectable, Optional } from "@bunest/core";
import {
  base64UrlDecode,
  base64UrlDecodeUtf8,
  base64UrlEncode,
  parseDurationToSeconds,
  pemToArrayBuffer,
  timingSafeEqualBytes,
  utf8Encode,
} from "../utils/crypto.util";
import {
  JwtExpiredException,
  JwtInvalidException,
  JwtNotBeforeException,
  WrongSecretProviderError,
} from "./jwt.errors";
import {
  JWT_MODULE_OPTIONS,
  JwtSecretRequestType,
  type DecodedJwt,
  type GetSecretKeyResult,
  type JwtAlgorithm,
  type JwtAsymmetricKeyInput,
  type JwtHeader,
  type JwtModuleOptions,
  type JwtPayload,
  type JwtSecretInput,
  type JwtSignOptions,
  type JwtVerifyOptions,
} from "./jwt.interface";

const HMAC_ALGS = new Set<JwtAlgorithm>(["HS256", "HS384", "HS512"]);
const ASYMMETRIC_ALGS = new Set<JwtAlgorithm>(["RS256", "ES256"]);
const ALL_SUPPORTED_ALGS = new Set<JwtAlgorithm>([
  "HS256",
  "HS384",
  "HS512",
  "RS256",
  "ES256",
]);

const CLAIM_SIGN_OPTION_KEYS: ReadonlyArray<keyof JwtSignOptions> = [
  "expiresIn",
  "notBefore",
  "audience",
  "issuer",
  "subject",
  "jwtid",
];

function getHashName(alg: JwtAlgorithm): "SHA-256" | "SHA-384" | "SHA-512" {
  switch (alg) {
    case "HS256":
    case "RS256":
    case "ES256":
      return "SHA-256";
    case "HS384":
      return "SHA-384";
    case "HS512":
      return "SHA-512";
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array)
  );
}

function isCryptoKey(value: unknown): value is CryptoKey {
  return typeof CryptoKey !== "undefined" && value instanceof CryptoKey;
}

const ASYMMETRIC_PEM_PUBLIC_OR_CERT_REGEX =
  /-----BEGIN (?:[A-Z0-9 ]*PUBLIC KEY|CERTIFICATE)-----/;

function containsAsymmetricPublicPem(
  secret: string | Uint8Array | CryptoKey,
): boolean {
  if (typeof secret === "string") {
    return ASYMMETRIC_PEM_PUBLIC_OR_CERT_REGEX.test(secret);
  }
  if (secret instanceof Uint8Array) {
    const text = Buffer.from(
      secret.buffer,
      secret.byteOffset,
      secret.byteLength,
    ).toString("latin1");
    return ASYMMETRIC_PEM_PUBLIC_OR_CERT_REGEX.test(text);
  }
  return false;
}

function normalizeSecretMaterial(
  raw: GetSecretKeyResult | undefined,
  kind: "hmac" | "private" | "public",
): JwtSecretInput | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (
    typeof raw === "string" ||
    raw instanceof Uint8Array ||
    isCryptoKey(raw)
  ) {
    return raw;
  }
  if (typeof raw === "object") {
    if ("key" in raw) {
      const inner = (raw as { key: unknown }).key;
      if (
        typeof inner === "string" ||
        inner instanceof Uint8Array ||
        isCryptoKey(inner)
      ) {
        return inner;
      }
    }
    if (
      "export" in raw &&
      typeof (raw as { export?: unknown }).export === "function"
    ) {
      const keyObj = raw as {
        type?: string;
        export: (opts?: Record<string, unknown>) => string | Buffer;
      };
      if (kind === "hmac") {
        if (keyObj.type !== "secret") {
          throw new JwtInvalidException(
            `Refused to use asymmetric "${String(keyObj.type)}" KeyObject for HMAC JWT operation`,
          );
        }
        const exported = keyObj.export();
        return typeof exported === "string"
          ? exported
          : new Uint8Array(exported);
      }
      if (kind === "private") {
        if (keyObj.type !== "private") {
          throw new JwtInvalidException(
            `Expected private KeyObject for asymmetric signing, received "${String(keyObj.type)}"`,
          );
        }
        return String(keyObj.export({ type: "pkcs8", format: "pem" }));
      }
      if (keyObj.type !== "public") {
        throw new JwtInvalidException(
          `Expected public KeyObject for asymmetric verification, received "${String(keyObj.type)}"`,
        );
      }
      return String(keyObj.export({ type: "spki", format: "pem" }));
    }
  }
  return undefined;
}

function encodeStringWithEncoding(
  value: string,
  encoding?: string,
): Uint8Array {
  if (
    !encoding ||
    encoding.toLowerCase() === "utf8" ||
    encoding.toLowerCase() === "utf-8"
  ) {
    return utf8Encode(value);
  }
  return new Uint8Array(Buffer.from(value, encoding as BufferEncoding));
}

/**
 * Pure WebCrypto (`crypto.subtle`) JWT service supporting HS256/HS384/HS512,
 * RS256, and ES256 with constant-time signature verification, strict `alg: "none"`
 * & algorithm-confusion protection, and full RFC 7519 claims validation.
 */
@Injectable()
export class JwtService {
  private readonly keyCache = new Map<string, Promise<CryptoKey>>();

  constructor(
    @Optional()
    @Inject(JWT_MODULE_OPTIONS)
    private readonly options: JwtModuleOptions = {},
  ) {}

  sign(payload: string, overrideOptions?: JwtSignOptions): Promise<string>;
  sign(payload: Uint8Array, overrideOptions?: JwtSignOptions): Promise<string>;
  sign<T extends object = JwtPayload>(
    payload: T,
    overrideOptions?: JwtSignOptions,
  ): Promise<string>;
  async sign(
    payload: JwtPayload | string | Uint8Array,
    overrideOptions: JwtSignOptions = {},
  ): Promise<string> {
    const merged: JwtSignOptions = {
      ...this.options.signOptions,
      ...overrideOptions,
    };

    const isStringPayload = typeof payload === "string";
    const isBinaryPayload = payload instanceof Uint8Array;
    const isObjectPayload = isPlainRecord(payload);

    if (!isStringPayload && !isBinaryPayload && !isObjectPayload) {
      throw new JwtInvalidException(
        "JWT payload must be a plain object, string, or Uint8Array",
      );
    }

    if (isStringPayload || isBinaryPayload) {
      const invalidClaimKeys = CLAIM_SIGN_OPTION_KEYS.filter(
        (key) => merged[key] !== undefined,
      );
      if (invalidClaimKeys.length > 0) {
        throw new JwtInvalidException(
          `Payload as ${isStringPayload ? "string" : "Uint8Array"} is not allowed with sign options: ${invalidClaimKeys.join(", ")}`,
        );
      }
    }

    const resolvedKeyMaterial = await this.resolveSigningMaterial(
      payload,
      merged,
    );
    const alg =
      merged.algorithm ??
      this.inferDefaultSignAlgorithm(merged, resolvedKeyMaterial);

    if (!ALL_SUPPORTED_ALGS.has(alg)) {
      throw new JwtInvalidException(
        `Unsupported JWT algorithm: "${String(alg)}"`,
      );
    }

    let encodedPayload: string;
    const header: JwtHeader = {
      ...(merged.header ?? {}),
      alg,
      ...(merged.keyid !== undefined ? { kid: merged.keyid } : {}),
    };

    if (isObjectPayload) {
      if (header.typ === undefined) {
        header.typ = "JWT";
      }

      const nowSec = Math.floor(Date.now() / 1000);
      const claims: JwtPayload = merged.mutatePayload
        ? (payload as JwtPayload)
        : { ...(payload as JwtPayload) };

      if (!merged.noTimestamp && claims.iat === undefined) {
        claims.iat = nowSec;
      }

      if (merged.expiresIn !== undefined && claims.exp === undefined) {
        const baseTime = typeof claims.iat === "number" ? claims.iat : nowSec;
        claims.exp = baseTime + parseDurationToSeconds(merged.expiresIn);
      }

      if (merged.notBefore !== undefined && claims.nbf === undefined) {
        const baseTime = typeof claims.iat === "number" ? claims.iat : nowSec;
        claims.nbf = baseTime + parseDurationToSeconds(merged.notBefore);
      }

      if (merged.issuer !== undefined && claims.iss === undefined) {
        claims.iss = merged.issuer;
      }
      if (merged.subject !== undefined && claims.sub === undefined) {
        claims.sub = merged.subject;
      }
      if (merged.audience !== undefined && claims.aud === undefined) {
        claims.aud = merged.audience;
      }
      if (merged.jwtid !== undefined && claims.jti === undefined) {
        claims.jti = merged.jwtid;
      }

      encodedPayload = base64UrlEncode(
        encodeStringWithEncoding(JSON.stringify(claims), merged.encoding),
      );
    } else if (isStringPayload) {
      encodedPayload = base64UrlEncode(
        encodeStringWithEncoding(payload, merged.encoding),
      );
    } else {
      encodedPayload = base64UrlEncode(payload);
    }

    const encodedHeader = base64UrlEncode(JSON.stringify(header));
    const signingInput = `${encodedHeader}.${encodedPayload}`;

    const key = await this.importSigningKey(alg, merged, resolvedKeyMaterial);
    const signatureBytes = await this.computeSignature(
      alg,
      key,
      utf8Encode(signingInput),
    );
    const encodedSig = base64UrlEncode(signatureBytes);

    return `${signingInput}.${encodedSig}`;
  }

  signAsync(payload: string, overrideOptions?: JwtSignOptions): Promise<string>;
  signAsync(
    payload: Uint8Array,
    overrideOptions?: JwtSignOptions,
  ): Promise<string>;
  signAsync<T extends object = JwtPayload>(
    payload: T,
    overrideOptions?: JwtSignOptions,
  ): Promise<string>;
  async signAsync(
    payload: JwtPayload | string | Uint8Array,
    overrideOptions: JwtSignOptions = {},
  ): Promise<string> {
    if (typeof payload === "string") {
      return this.sign(payload, overrideOptions);
    }
    if (payload instanceof Uint8Array) {
      return this.sign(payload, overrideOptions);
    }
    return this.sign(payload, overrideOptions);
  }

  verify<T = JwtPayload>(
    token: string,
    overrideOptions: JwtVerifyOptions & { complete: true },
  ): Promise<DecodedJwt<T>>;
  verify<T = JwtPayload>(
    token: string,
    overrideOptions?: JwtVerifyOptions & { complete?: false },
  ): Promise<T>;
  verify<T = JwtPayload>(
    token: string,
    overrideOptions?: JwtVerifyOptions,
  ): Promise<T>;
  async verify<T = JwtPayload>(
    token: string,
    overrideOptions: JwtVerifyOptions = {},
  ): Promise<T | DecodedJwt<T>> {
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
    let payloadStr: string;
    let signatureBytes: Uint8Array<ArrayBuffer>;

    try {
      header = JSON.parse(base64UrlDecodeUtf8(encodedHeader));
      payloadStr = base64UrlDecodeUtf8(encodedPayload);
      signatureBytes = base64UrlDecode(encodedSig);
    } catch {
      throw new JwtInvalidException("Malformed JWT encoding or JSON");
    }

    if (!isPlainRecord(header)) {
      throw new JwtInvalidException("Malformed JWT header or payload");
    }

    let parsedPayload: unknown = payloadStr;
    let payloadIsObject = false;
    try {
      const json = JSON.parse(payloadStr);
      if (isPlainRecord(json)) {
        parsedPayload = json;
        payloadIsObject = true;
      } else {
        throw new JwtInvalidException("Malformed JWT header or payload");
      }
    } catch (err) {
      if (err instanceof JwtInvalidException) {
        throw err;
      }
      // Non-JSON payload (e.g., signed raw string/binary payload)
      parsedPayload = payloadStr;
      payloadIsObject = false;
    }

    const rawAlg = header.alg;
    if (
      typeof rawAlg !== "string" ||
      rawAlg.toLowerCase() === "none" ||
      !ALL_SUPPORTED_ALGS.has(rawAlg as JwtAlgorithm)
    ) {
      throw new JwtInvalidException(
        `Rejected unsupported or forbidden JWT algorithm: "${String(rawAlg)}"`,
      );
    }

    const alg = rawAlg as JwtAlgorithm;
    const merged: JwtVerifyOptions = {
      ...this.options.verifyOptions,
      ...overrideOptions,
    };

    // Enforce explicit or key-derived algorithm allowlist (prevents RS256 -> HS256 confusion!)
    const allowedAlgorithms = this.resolveAllowedAlgorithms(merged);
    if (!allowedAlgorithms.has(alg)) {
      throw new JwtInvalidException(
        `JWT algorithm "${alg}" is not permitted by allowlist`,
      );
    }

    const key = await this.resolveVerifyKey(alg, merged, token);
    const signingInputBytes = utf8Encode(`${encodedHeader}.${encodedPayload}`);
    const validSignature = await this.verifySignature(
      alg,
      key,
      signingInputBytes,
      signatureBytes,
    );

    if (!validSignature) {
      throw new JwtInvalidException("Invalid JWT signature");
    }

    if (payloadIsObject) {
      this.validateClaims(parsedPayload as JwtPayload, merged);
    } else if (
      merged.issuer !== undefined ||
      merged.audience !== undefined ||
      merged.subject !== undefined ||
      merged.jwtid !== undefined ||
      merged.maxAge !== undefined ||
      merged.nonce !== undefined
    ) {
      throw new JwtInvalidException(
        "Claim validation options require a JSON object JWT payload",
      );
    }

    if (merged.complete) {
      return {
        header: header as JwtHeader,
        payload: parsedPayload as T,
        signature: encodedSig,
      };
    }

    return parsedPayload as T;
  }

  verifyAsync<T = JwtPayload>(
    token: string,
    overrideOptions: JwtVerifyOptions & { complete: true },
  ): Promise<DecodedJwt<T>>;
  verifyAsync<T = JwtPayload>(
    token: string,
    overrideOptions?: JwtVerifyOptions & { complete?: false },
  ): Promise<T>;
  verifyAsync<T = JwtPayload>(
    token: string,
    overrideOptions?: JwtVerifyOptions,
  ): Promise<T>;
  async verifyAsync<T = JwtPayload>(
    token: string,
    overrideOptions: JwtVerifyOptions = {},
  ): Promise<T | DecodedJwt<T>> {
    return this.verify<T>(token, overrideOptions);
  }

  decode<T = JwtPayload>(
    token: string,
    options: { complete: true },
  ): DecodedJwt<T> | null;
  decode<T = JwtPayload>(
    token: string,
    options?: { complete?: false },
  ): T | null;
  decode<T = JwtPayload>(
    token: string,
    options?: { complete?: boolean },
  ): T | DecodedJwt<T> | null {
    if (typeof token !== "string") {
      return null;
    }
    const parts = token.split(".");
    if (parts.length !== 3) {
      return null;
    }
    const [encodedHeader, encodedPayload, signature] = parts as [
      string,
      string,
      string,
    ];
    try {
      const header = JSON.parse(base64UrlDecodeUtf8(encodedHeader));
      if (!isPlainRecord(header)) {
        return null;
      }
      const rawPayload = base64UrlDecodeUtf8(encodedPayload);
      let payload: unknown;
      try {
        payload = JSON.parse(rawPayload);
      } catch {
        payload = rawPayload;
      }
      if (options?.complete) {
        return {
          header: header as JwtHeader,
          payload: payload as T,
          signature,
        };
      }
      return payload as T;
    } catch {
      return null;
    }
  }

  private async resolveSigningMaterial(
    payload: JwtPayload | string | Uint8Array,
    opts: JwtSignOptions,
  ): Promise<GetSecretKeyResult | undefined> {
    if (this.options.secretOrKeyProvider && !opts.secret && !opts.privateKey) {
      const provided = await this.options.secretOrKeyProvider(
        JwtSecretRequestType.SIGN,
        payload,
        opts,
      );
      if (provided === undefined || provided === null || provided === "") {
        throw new WrongSecretProviderError(
          "secretOrKeyProvider returned an empty signing secret",
        );
      }
      return provided;
    }
    return undefined;
  }

  private inferDefaultSignAlgorithm(
    opts: JwtSignOptions,
    providerKey?: GetSecretKeyResult,
  ): JwtAlgorithm {
    const inferFromKeyMaterial = (
      raw: GetSecretKeyResult | undefined,
    ): JwtAlgorithm | undefined => {
      if (raw === undefined || raw === null) return undefined;
      if (isCryptoKey(raw)) {
        if (raw.algorithm.name === "ECDSA") return "ES256";
        if (raw.algorithm.name === "RSASSA-PKCS1-v1_5") return "RS256";
        if (raw.algorithm.name === "HMAC") {
          const hash = (raw.algorithm as { hash?: { name?: string } }).hash
            ?.name;
          if (hash === "SHA-384") return "HS384";
          if (hash === "SHA-512") return "HS512";
          return "HS256";
        }
      }
      if (typeof raw === "object" && "export" in raw && "type" in raw) {
        const keyObj = raw as {
          type?: string;
          asymmetricKeyType?: string;
        };
        if (keyObj.type === "secret") return "HS256";
        if (keyObj.type === "private") {
          return keyObj.asymmetricKeyType === "ec" ? "ES256" : "RS256";
        }
      }
      if (typeof raw === "object" && "key" in raw) {
        return inferFromKeyMaterial((raw as { key: GetSecretKeyResult }).key);
      }
      if (typeof raw === "string" && raw.includes("-----BEGIN")) {
        return "RS256";
      }
      return undefined;
    };

    if (providerKey !== undefined) {
      return inferFromKeyMaterial(providerKey) ?? "HS256";
    }

    const explicitPrivate = opts.privateKey ?? this.options.privateKey;
    if (explicitPrivate) {
      return inferFromKeyMaterial(explicitPrivate) ?? "RS256";
    }

    if (this.options.secretOrPrivateKey) {
      return inferFromKeyMaterial(this.options.secretOrPrivateKey) ?? "HS256";
    }

    return "HS256";
  }

  private resolveAllowedAlgorithms(opts: JwtVerifyOptions): Set<JwtAlgorithm> {
    if (opts.algorithms && opts.algorithms.length > 0) {
      const set = new Set<JwtAlgorithm>();
      for (const a of opts.algorithms) {
        if (ALL_SUPPORTED_ALGS.has(a)) {
          set.add(a);
        }
      }
      return set;
    }

    // Dynamic secret provider handles key-type matching after resolution
    if (this.options.secretOrKeyProvider && !opts.secret && !opts.publicKey) {
      return new Set(ALL_SUPPORTED_ALGS);
    }

    const publicKey = normalizeSecretMaterial(
      opts.publicKey ?? this.options.publicKey,
      "public",
    );
    const secret = normalizeSecretMaterial(
      opts.secret ?? this.options.secret ?? this.options.secretOrPrivateKey,
      "hmac",
    );

    if (publicKey && !secret) {
      if (isCryptoKey(publicKey)) {
        if (publicKey.algorithm.name === "ECDSA") return new Set(["ES256"]);
        if (publicKey.algorithm.name === "RSASSA-PKCS1-v1_5")
          return new Set(["RS256"]);
      }
      return new Set(ASYMMETRIC_ALGS);
    }

    if (secret && !publicKey) {
      if (isCryptoKey(secret)) {
        if (secret.algorithm.name !== "HMAC") {
          throw new JwtInvalidException(
            "Symmetric secret CryptoKey must use HMAC algorithm",
          );
        }
        const hashName = (secret.algorithm as { hash?: { name?: string } }).hash
          ?.name;
        if (hashName === "SHA-256") return new Set(["HS256"]);
        if (hashName === "SHA-384") return new Set(["HS384"]);
        if (hashName === "SHA-512") return new Set(["HS512"]);
        throw new JwtInvalidException(
          `Unsupported HMAC CryptoKey hash algorithm: "${String(hashName)}"`,
        );
      }
      return new Set(HMAC_ALGS);
    }

    // Both configured: allow asymmetric for publicKey or HMAC for secret based on signOptions if set
    const configuredSignAlg = this.options.signOptions?.algorithm;
    if (configuredSignAlg) {
      return new Set([configuredSignAlg]);
    }
    return new Set(ALL_SUPPORTED_ALGS);
  }

  private async importSigningKey(
    alg: JwtAlgorithm,
    opts: JwtSignOptions,
    providerKey?: GetSecretKeyResult,
  ): Promise<CryptoKey> {
    if (HMAC_ALGS.has(alg)) {
      const secret = normalizeSecretMaterial(
        providerKey ??
          opts.secret ??
          this.options.secret ??
          this.options.secretOrPrivateKey,
        "hmac",
      );
      if (!secret) {
        throw new JwtInvalidException(
          `JWT secret is required for algorithm "${alg}"`,
        );
      }
      return this.importHmacKey(secret, alg, ["sign"]);
    }

    const privateKey = normalizeSecretMaterial(
      providerKey ??
        opts.privateKey ??
        this.options.privateKey ??
        this.options.secretOrPrivateKey,
      "private",
    );
    if (!privateKey || privateKey instanceof Uint8Array) {
      throw new JwtInvalidException(
        `JWT privateKey is required for asymmetric algorithm "${alg}"`,
      );
    }
    return this.importAsymmetricKey(
      privateKey as JwtAsymmetricKeyInput,
      alg,
      "private",
    );
  }

  private async resolveVerifyKey(
    alg: JwtAlgorithm,
    opts: JwtVerifyOptions,
    token: string,
  ): Promise<CryptoKey> {
    let providerKey: GetSecretKeyResult | undefined;
    if (this.options.secretOrKeyProvider && !opts.secret && !opts.publicKey) {
      providerKey = await this.options.secretOrKeyProvider(
        JwtSecretRequestType.VERIFY,
        token,
        opts,
      );
      if (
        providerKey === undefined ||
        providerKey === null ||
        providerKey === ""
      ) {
        throw new WrongSecretProviderError(
          "secretOrKeyProvider returned an empty verification secret",
        );
      }
    }

    if (HMAC_ALGS.has(alg)) {
      // Strictly require symmetric secret — NEVER fall back to publicKey (prevents alg confusion!)
      const secret = normalizeSecretMaterial(
        providerKey ??
          opts.secret ??
          this.options.secret ??
          this.options.secretOrPrivateKey,
        "hmac",
      );
      if (!secret) {
        throw new JwtInvalidException(
          `JWT secret is required to verify "${alg}" token`,
        );
      }
      // Guard against algorithm confusion if a dynamic secretOrKeyProvider returned a PEM public key or certificate (string or Buffer/Uint8Array)
      if (providerKey !== undefined && containsAsymmetricPublicPem(secret)) {
        throw new JwtInvalidException(
          `Refused to use asymmetric public key/certificate PEM to verify HMAC algorithm "${alg}"`,
        );
      }
      return this.importHmacKey(secret, alg, ["sign", "verify"]);
    }

    const publicKey = normalizeSecretMaterial(
      providerKey ?? opts.publicKey ?? this.options.publicKey,
      "public",
    );
    if (!publicKey || publicKey instanceof Uint8Array) {
      throw new JwtInvalidException(
        `JWT publicKey is required to verify "${alg}" token`,
      );
    }
    return this.importAsymmetricKey(
      publicKey as JwtAsymmetricKeyInput,
      alg,
      "public",
    );
  }

  private async importHmacKey(
    secret: string | Uint8Array | CryptoKey,
    alg: JwtAlgorithm,
    usages: Array<"sign" | "verify">,
  ): Promise<CryptoKey> {
    const hash = getHashName(alg);

    if (isCryptoKey(secret)) {
      if (secret.algorithm.name !== "HMAC") {
        throw new JwtInvalidException(
          `Expected HMAC CryptoKey for "${alg}", received "${secret.algorithm.name}"`,
        );
      }
      const keyHash = (secret.algorithm as { hash?: { name?: string } }).hash
        ?.name;
      if (keyHash !== hash) {
        throw new JwtInvalidException(
          `HMAC CryptoKey hash "${String(keyHash)}" does not match JWT algorithm "${alg}" (expected "${hash}")`,
        );
      }
      const hasRequiredUsage = usages.some((u) => secret.usages.includes(u));
      if (!hasRequiredUsage) {
        throw new JwtInvalidException(
          `HMAC CryptoKey lacks required usage (${usages.join(" or ")}) for "${alg}"`,
        );
      }
      return secret;
    }

    const rawBytes =
      typeof secret === "string" ? utf8Encode(secret) : new Uint8Array(secret);
    if (rawBytes.byteLength === 0) {
      throw new JwtInvalidException("JWT secret must not be empty");
    }

    if (typeof secret === "string") {
      const cacheKey = `hmac:${alg}:${usages.join(",")}:${secret}`;
      let cached = this.keyCache.get(cacheKey);
      if (!cached) {
        cached = crypto.subtle.importKey(
          "raw",
          rawBytes,
          { name: "HMAC", hash },
          false,
          usages,
        );
        this.keyCache.set(cacheKey, cached);
      }
      return cached;
    }

    return crypto.subtle.importKey(
      "raw",
      rawBytes,
      { name: "HMAC", hash },
      false,
      usages,
    );
  }

  private async importAsymmetricKey(
    keyInput: string | CryptoKey,
    alg: JwtAlgorithm,
    kind: "private" | "public",
  ): Promise<CryptoKey> {
    const expectedAlgoName = alg === "RS256" ? "RSASSA-PKCS1-v1_5" : "ECDSA";

    if (isCryptoKey(keyInput)) {
      if (keyInput.type !== kind) {
        throw new JwtInvalidException(
          `Expected ${kind} CryptoKey for "${alg}", received "${keyInput.type}"`,
        );
      }
      if (keyInput.algorithm.name !== expectedAlgoName) {
        throw new JwtInvalidException(
          `Key algorithm "${keyInput.algorithm.name}" does not match JWT algorithm "${alg}"`,
        );
      }
      return keyInput;
    }

    const cacheKey = `asym:${kind}:${alg}:${keyInput}`;
    let cached = this.keyCache.get(cacheKey);
    if (!cached) {
      let der: ArrayBuffer;
      try {
        der = pemToArrayBuffer(keyInput);
      } catch {
        throw new JwtInvalidException(
          `Malformed or empty ${kind} PEM key for "${alg}"`,
        );
      }
      const format = kind === "private" ? "pkcs8" : "spki";
      const usage: "sign" | "verify" = kind === "private" ? "sign" : "verify";
      const importParams =
        alg === "RS256"
          ? { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }
          : { name: "ECDSA", namedCurve: "P-256" };

      cached = crypto.subtle
        .importKey(format, der, importParams, false, [usage])
        .catch(() => {
          this.keyCache.delete(cacheKey);
          throw new JwtInvalidException(
            `Failed to import ${kind} key for "${alg}"`,
          );
        });
      this.keyCache.set(cacheKey, cached);
    }
    return cached;
  }

  private async computeSignature(
    alg: JwtAlgorithm,
    key: CryptoKey,
    data: Uint8Array<ArrayBuffer>,
  ): Promise<Uint8Array<ArrayBuffer>> {
    let rawSig: ArrayBuffer;
    if (HMAC_ALGS.has(alg)) {
      rawSig = await crypto.subtle.sign("HMAC", key, data);
    } else if (alg === "RS256") {
      rawSig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, data);
    } else {
      rawSig = await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        data,
      );
    }
    return new Uint8Array(rawSig);
  }

  private async verifySignature(
    alg: JwtAlgorithm,
    key: CryptoKey,
    data: Uint8Array<ArrayBuffer>,
    signature: Uint8Array<ArrayBuffer>,
  ): Promise<boolean> {
    if (HMAC_ALGS.has(alg)) {
      if (key.usages.includes("verify")) {
        return crypto.subtle.verify("HMAC", key, signature, data);
      }
      if (key.usages.includes("sign")) {
        const expected = new Uint8Array(
          await crypto.subtle.sign("HMAC", key, data),
        );
        return timingSafeEqualBytes(expected, signature);
      }
      throw new JwtInvalidException(
        `HMAC CryptoKey lacks "verify" or "sign" usage for "${alg}"`,
      );
    }

    if (alg === "RS256") {
      return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, data);
    }

    return crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      signature,
      data,
    );
  }

  private validateClaims(payload: JwtPayload, opts: JwtVerifyOptions): void {
    if (
      opts.clockTimestamp !== undefined &&
      (typeof opts.clockTimestamp !== "number" ||
        !Number.isFinite(opts.clockTimestamp))
    ) {
      throw new JwtInvalidException("Invalid clockTimestamp option");
    }

    const nowSec =
      opts.clockTimestamp !== undefined
        ? opts.clockTimestamp
        : Math.floor((opts.currentDate?.getTime() ?? Date.now()) / 1000);
    const tolerance = opts.clockTolerance ?? 0;

    if (payload.iat !== undefined && !Number.isFinite(payload.iat)) {
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

    if (opts.maxAge !== undefined) {
      if (typeof payload.iat !== "number" || !Number.isFinite(payload.iat)) {
        throw new JwtInvalidException("iat required when maxAge is specified");
      }
      let maxAgeSec: number;
      try {
        maxAgeSec = parseDurationToSeconds(opts.maxAge);
      } catch {
        throw new JwtInvalidException(
          `Invalid maxAge option: "${String(opts.maxAge)}"`,
        );
      }
      const maxAgeTimestamp = payload.iat + maxAgeSec;
      if (nowSec >= maxAgeTimestamp + tolerance) {
        throw new JwtExpiredException(
          new Date(maxAgeTimestamp * 1000),
          "maxAge exceeded",
        );
      }
    }

    if (opts.nonce !== undefined) {
      if (typeof opts.nonce !== "string" || opts.nonce.trim().length === 0) {
        throw new JwtInvalidException("nonce must be a non-empty string");
      }
      if (payload.nonce !== opts.nonce) {
        throw new JwtInvalidException("JWT nonce mismatch");
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
  }
}
