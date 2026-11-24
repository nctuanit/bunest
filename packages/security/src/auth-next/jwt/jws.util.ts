import { Logger } from "@bunest/core";
import { JwtError } from "../errors/jwt.error";
import type {
  ClaimRules,
  JwsAlgorithm,
  JwtClaims,
} from "../interfaces/jwt.interface";
import type {
  JwsKeyInput,
  JwsKeyObjectLike,
} from "../interfaces/jwt-options.interface";
import { timingSafeEqualBytes } from "../utils/crypto.util";
import { toMs } from "../utils/duration.util";

/** The algorithms a public key verifies: the only ones a JWKS can serve (HS secrets are never published). */
export const ASYMMETRIC_ALGORITHMS: readonly JwsAlgorithm[] = [
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
];

export interface JwsHeader {
  alg: string;
  kid?: string;
  typ?: string;
  crit?: unknown;
  [key: string]: unknown;
}

export interface KeyRules {
  allowShortSecret?: boolean;
}

export interface DecodedJws {
  header: JwsHeader;
  payload: JwtClaims;
  signingInput: Buffer;
  signature: Buffer;
}

export interface AsymmetricKeyDetails {
  readonly modulusLength?: number;
  readonly namedCurve?: string;
}

/**
 * WebCrypto-backed normalized key representation replacing `node:crypto`'s `KeyObject`.
 * Carries synchronous metadata for constructor-time validation and caches imported
 * `CryptoKey` instances per `(algorithm, usage)`.
 */
export class JwsKey {
  readonly type: "secret" | "public" | "private";
  readonly asymmetricKeyType?: string;
  readonly asymmetricKeyDetails?: AsymmetricKeyDetails;
  readonly symmetricKeySize?: number;

  readonly rawSecret?: Uint8Array<ArrayBuffer>;
  readonly spkiDer?: Uint8Array<ArrayBuffer>;
  readonly pkcs8Der?: Uint8Array<ArrayBuffer>;
  readonly jwk?: Record<string, unknown>;
  readonly cryptoKey?: CryptoKey;

  private readonly cache = new Map<string, Promise<CryptoKey>>();
  private derivedPublicJwk?: Promise<SubtleJwk>;

  constructor(init: {
    type: "secret" | "public" | "private";
    asymmetricKeyType?: string;
    asymmetricKeyDetails?: AsymmetricKeyDetails;
    symmetricKeySize?: number;
    rawSecret?: Uint8Array<ArrayBuffer>;
    spkiDer?: Uint8Array<ArrayBuffer>;
    pkcs8Der?: Uint8Array<ArrayBuffer>;
    jwk?: Record<string, unknown>;
    cryptoKey?: CryptoKey;
  }) {
    this.type = init.type;
    this.asymmetricKeyType = init.asymmetricKeyType;
    this.asymmetricKeyDetails = init.asymmetricKeyDetails;
    this.symmetricKeySize = init.symmetricKeySize;
    this.rawSecret = init.rawSecret;
    this.spkiDer = init.spkiDer;
    this.pkcs8Der = init.pkcs8Der;
    this.jwk = init.jwk;
    this.cryptoKey = init.cryptoKey;
  }

  /** Derives a public view of a private key synchronously (or lazily for Ed25519/EC PKCS#8 without embedded pubkey). */
  toPublicKey(): JwsKey {
    if (this.type !== "private") {
      return this;
    }
    const pubJwk = this.jwk ? stripPrivateJwkFields(this.jwk) : undefined;
    return new JwsKey({
      type: "public",
      asymmetricKeyType: this.asymmetricKeyType,
      asymmetricKeyDetails: this.asymmetricKeyDetails,
      spkiDer: this.spkiDer,
      jwk: pubJwk,
      // Retain pkcs8Der only as a fallback to lazily derive public JWK via WebCrypto when spkiDer & jwk are absent
      ...(!this.spkiDer && !pubJwk && this.pkcs8Der
        ? { pkcs8Der: this.pkcs8Der }
        : {}),
    });
  }

  /** Imports and caches a WebCrypto `CryptoKey` for the given JWS algorithm and usage. */
  getCryptoKey(
    alg: JwsAlgorithm,
    usage: "sign" | "verify",
  ): Promise<CryptoKey> {
    const cacheKey = `${alg}:${usage}`;
    const existing = this.cache.get(cacheKey);
    if (existing) {
      return existing;
    }
    const promise = this.importCryptoKey(alg, usage);
    this.cache.set(cacheKey, promise);
    promise.catch(() => {
      if (this.cache.get(cacheKey) === promise) {
        this.cache.delete(cacheKey);
      }
    });
    return promise;
  }

  private async importCryptoKey(
    alg: JwsAlgorithm,
    usage: "sign" | "verify",
  ): Promise<CryptoKey> {
    if (this.cryptoKey) {
      return this.cryptoKey;
    }
    const importAlg = webCryptoImportAlgorithm(alg);
    if (usage === "sign") {
      if (this.type === "secret" && this.rawSecret) {
        return crypto.subtle.importKey("raw", this.rawSecret, importAlg, false, [
          "sign",
        ]);
      }
      if (this.pkcs8Der) {
        return crypto.subtle.importKey(
          "pkcs8",
          this.pkcs8Der,
          importAlg,
          false,
          ["sign"],
        );
      }
      if (this.jwk) {
        return crypto.subtle.importKey(
          "jwk",
          sanitizeJwkForImport(this.jwk),
          importAlg,
          false,
          ["sign"],
        );
      }
      throw new JwtError(`cannot import ${alg} signing key`);
    }

    // usage === "verify"
    if (this.type === "secret" && this.rawSecret) {
      return crypto.subtle.importKey("raw", this.rawSecret, importAlg, false, [
        "verify",
      ]);
    }
    if (this.spkiDer) {
      return crypto.subtle.importKey("spki", this.spkiDer, importAlg, false, [
        "verify",
      ]);
    }
    if (this.jwk) {
      return crypto.subtle.importKey(
        "jwk",
        sanitizeJwkForImport(stripPrivateJwkFields(this.jwk)),
        importAlg,
        false,
        ["verify"],
      );
    }
    if (this.pkcs8Der) {
      this.derivedPublicJwk ??= derivePublicJwkFromPkcs8(
        this.pkcs8Der,
        importAlg,
      );
      const derived = await this.derivedPublicJwk;
      return crypto.subtle.importKey("jwk", derived, importAlg, false, [
        "verify",
      ]);
    }
    throw new JwtError(`cannot import ${alg} verification key`);
  }
}

type SubtleImportAlgorithm = Parameters<typeof crypto.subtle.importKey>[2];
type SubtleJwk = Extract<
  Parameters<typeof crypto.subtle.importKey>[1],
  { kty?: string }
>;

async function derivePublicJwkFromPkcs8(
  pkcs8Der: Uint8Array<ArrayBuffer>,
  importAlg: SubtleImportAlgorithm,
): Promise<SubtleJwk> {
  const privKey = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8Der,
    importAlg,
    true,
    ["sign"],
  );
  const fullJwk = (await crypto.subtle.exportKey("jwk", privKey)) as Record<
    string,
    unknown
  >;
  return sanitizeJwkForImport(stripPrivateJwkFields(fullJwk));
}

const BUN_HASH: Record<
  "HS256" | "HS384" | "HS512",
  "sha256" | "sha384" | "sha512"
> = {
  HS256: "sha256",
  HS384: "sha384",
  HS512: "sha512",
};

const WEB_HASH: Record<Exclude<JwsAlgorithm, "EdDSA">, "SHA-256" | "SHA-384" | "SHA-512"> = {
  HS256: "SHA-256",
  HS384: "SHA-384",
  HS512: "SHA-512",
  RS256: "SHA-256",
  RS384: "SHA-384",
  RS512: "SHA-512",
  PS256: "SHA-256",
  PS384: "SHA-384",
  PS512: "SHA-512",
  ES256: "SHA-256",
  ES384: "SHA-384",
  ES512: "SHA-512",
};

const PSS_SALT_LENGTH: Record<"PS256" | "PS384" | "PS512", number> = {
  PS256: 32,
  PS384: 48,
  PS512: 64,
};

const CURVES: Record<"ES256" | "ES384" | "ES512", string> = {
  ES256: "prime256v1",
  ES384: "secp384r1",
  ES512: "secp521r1",
};

const WEB_CURVES: Record<"ES256" | "ES384" | "ES512", "P-256" | "P-384" | "P-521"> = {
  ES256: "P-256",
  ES384: "P-384",
  ES512: "P-521",
};

const WEB_CURVE_TO_OPENSSL: Record<string, string> = {
  "P-256": "prime256v1",
  "P-384": "secp384r1",
  "P-521": "secp521r1",
};

const CURVE_ALGORITHMS: Record<string, JwsAlgorithm> = {
  prime256v1: "ES256",
  secp384r1: "ES384",
  secp521r1: "ES512",
};

const ECDSA_SIGNATURE_BYTES: Record<"ES256" | "ES384" | "ES512", number> = {
  ES256: 64,
  ES384: 96,
  ES512: 132,
};

const SEGMENT = /^[A-Za-z0-9_-]+$/;
const PEM_HEADER = /-----BEGIN ([A-Z0-9 ]+)-----/g;

const OID_RSA = "1.2.840.113549.1.1.1";
const OID_RSA_PSS = "1.2.840.113549.1.1.10";
const OID_EC = "1.2.840.10045.2.1";
const OID_ED25519 = "1.3.101.112";
const OID_ED448 = "1.3.101.113";
const OID_X25519 = "1.3.101.110";
const OID_X448 = "1.3.101.111";

const CURVE_OIDS: Record<string, string> = {
  "1.2.840.10045.3.1.7": "prime256v1",
  "1.3.132.0.34": "secp384r1",
  "1.3.132.0.35": "secp521r1",
  "1.3.132.0.10": "secp256k1",
};

const RSA_ALG_ID_DER = new Uint8Array([
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
  0x05, 0x00,
]);

function webCryptoImportAlgorithm(alg: JwsAlgorithm): SubtleImportAlgorithm {
  switch (alg) {
    case "HS256":
    case "HS384":
    case "HS512":
      return { name: "HMAC", hash: WEB_HASH[alg] };
    case "RS256":
    case "RS384":
    case "RS512":
      return { name: "RSASSA-PKCS1-v1_5", hash: WEB_HASH[alg] };
    case "PS256":
    case "PS384":
    case "PS512":
      return { name: "RSA-PSS", hash: WEB_HASH[alg] };
    case "ES256":
    case "ES384":
    case "ES512":
      return { name: "ECDSA", namedCurve: WEB_CURVES[alg] };
    case "EdDSA":
      return "Ed25519";
  }
}

/**
 * Converts key configuration into a {@link JwsKey}, refusing JWK/DER strings
 * that would otherwise be silently interpreted as weak HS256 secrets.
 */
export function toKeyObject(key: JwsKeyInput): JwsKey {
  if (key instanceof JwsKey) {
    return key;
  }
  if (isCryptoKey(key)) {
    return fromCryptoKey(key);
  }
  if (isKeyObjectLike(key)) {
    return fromKeyObjectLike(key);
  }
  if (typeof key !== "string" && !(key instanceof Uint8Array)) {
    throw new TypeError("Unsupported key input");
  }
  const text =
    typeof key === "string"
      ? key
      : Buffer.from(key.buffer, key.byteOffset, key.byteLength).toString(
          "latin1",
        );
  const labels = [...text.matchAll(PEM_HEADER)].map((match) => match[1]!);
  if (labels.length === 0) {
    if (isJwk(text)) {
      throw new TypeError(
        "The key is a JWK, which would be read as an HS256 secret. Import it and pass the KeyObject: " +
          "`createPublicKey({ key: JSON.parse(jwk), format: 'jwk' })`, or `createPrivateKey` for a private key.",
      );
    }
    if (isEncodedKey(key)) {
      throw new TypeError(
        "The key is DER (binary, or base64 of it, as Keycloak shows `public_key`), which would be read as an " +
          "HS256 secret. Pass PEM text, or the KeyObject: `createPublicKey({ key, format: 'der', type: 'spki' })`.",
      );
    }
    const raw = toArrayBufferUint8Array(
      typeof key === "string" ? Buffer.from(key, "utf8") : key,
    );
    return new JwsKey({
      type: "secret",
      symmetricKeySize: raw.byteLength,
      rawSecret: raw,
    });
  }
  const label =
    labels.find((name) => name.includes("PRIVATE KEY")) ?? labels[0]!;
  try {
    return parsePemBlock(text, label);
  } catch (error) {
    throw new TypeError(
      `Cannot read the PEM ${label.toLowerCase()}: ${(error as Error).message}`,
    );
  }
}

/**
 * Imports and validates a public JWK (used by {@link JwksClient}) via WebCrypto.
 */
export async function fromPublicJwk(
  jwk: Record<string, unknown>,
  probeAlgorithm: JwsAlgorithm,
): Promise<JwsKey> {
  const publicJwk = stripPrivateJwkFields(jwk);
  const cleanJwk = sanitizeJwkForImport(publicJwk);
  await crypto.subtle.importKey(
    "jwk",
    cleanJwk,
    webCryptoImportAlgorithm(probeAlgorithm),
    false,
    ["verify"],
  );
  return jwkToJwsKey(publicJwk, "public");
}

export function algorithmFor(key: JwsKey): JwsAlgorithm | undefined {
  if (key.type === "secret") {
    return "HS256";
  }
  switch (key.asymmetricKeyType) {
    case "rsa":
      return "RS256";
    case "ec":
      return CURVE_ALGORITHMS[key.asymmetricKeyDetails?.namedCurve ?? ""];
    case "ed25519":
      return "EdDSA";
    default:
      return undefined;
  }
}

export function unsupportedKeyError(key: JwsKey, owner: string): TypeError {
  const curve =
    key.asymmetricKeyType === "ec"
      ? key.asymmetricKeyDetails?.namedCurve
      : undefined;
  return new TypeError(
    curve
      ? `${owner}: EC keys on ${curve} are not supported (use P-256, P-384 or P-521).`
      : `${owner}: ${key.asymmetricKeyType} keys are not supported.`,
  );
}

const HMAC_SECRET_BYTES: Record<"HS256" | "HS384" | "HS512", number> = {
  HS256: 32,
  HS384: 48,
  HS512: 64,
};

export function keyFits(
  alg: JwsAlgorithm,
  key: JwsKey,
  { allowShortSecret = false }: KeyRules = {},
): boolean {
  const details = key.asymmetricKeyDetails;
  switch (alg) {
    case "HS256":
    case "HS384":
    case "HS512":
      return (
        key.type === "secret" &&
        (key.symmetricKeySize ?? 0) >=
          (allowShortSecret ? 1 : HMAC_SECRET_BYTES[alg])
      );
    case "RS256":
    case "RS384":
    case "RS512":
    case "PS256":
    case "PS384":
    case "PS512":
      return (
        key.asymmetricKeyType === "rsa" && (details?.modulusLength ?? 0) >= 2048
      );
    case "ES256":
    case "ES384":
    case "ES512":
      return (
        key.asymmetricKeyType === "ec" && details?.namedCurve === CURVES[alg]
      );
    case "EdDSA":
      return key.asymmetricKeyType === "ed25519";
    default:
      return false;
  }
}

const RSA_KEY = "an RSA key of at least 2048 bits";
const REQUIREMENTS: Record<JwsAlgorithm, string> = {
  HS256: "a secret of at least 32 bytes (`openssl rand -base64 32`)",
  HS384: "a secret of at least 48 bytes (`openssl rand -base64 48`)",
  HS512: "a secret of at least 64 bytes (`openssl rand -base64 64`)",
  RS256: RSA_KEY,
  RS384: RSA_KEY,
  RS512: RSA_KEY,
  PS256: RSA_KEY,
  PS384: RSA_KEY,
  PS512: RSA_KEY,
  ES256: "a P-256 key",
  ES384: "a P-384 key",
  ES512: "a P-521 key",
  EdDSA: "an Ed25519 key",
};

export const isHmac = (alg: JwsAlgorithm): boolean => alg.startsWith("HS");

export function assertKeyFits(
  alg: JwsAlgorithm,
  key: JwsKey,
  owner: string,
  rules: KeyRules = {},
): void {
  if (!keyFits(alg, key, rules)) {
    const short =
      isHmac(alg) && key.type === "secret" && (key.symmetricKeySize ?? 0) > 0;
    throw new TypeError(
      `${owner}: the key is not a valid ${alg} key; ${alg} needs ${REQUIREMENTS[alg]}.` +
        (short
          ? ` To keep an existing shorter secret (${key.symmetricKeySize} bytes), set \`allowShortSecret: true\` ` +
            "next to the key; a short secret can be guessed offline from any token."
          : ""),
    );
  }
}

const warnedShortSecrets = new Set<string>();

export function warnShortSecret(
  alg: JwsAlgorithm,
  key: JwsKey,
  owner: string,
): void {
  if (!isHmac(alg) || key.type !== "secret") {
    return;
  }
  const size = key.symmetricKeySize ?? 0;
  const minimum = HMAC_SECRET_BYTES[alg as "HS256" | "HS384" | "HS512"];
  if (size >= minimum) {
    return;
  }
  const digest = key.rawSecret
    ? new Bun.CryptoHasher("sha256").update(key.rawSecret).digest("hex")
    : `${owner}:${alg}:${size}`;
  if (warnedShortSecrets.has(digest)) {
    return;
  }
  warnedShortSecrets.add(digest);
  new Logger(owner).warn(
    `The ${alg} secret is ${size} bytes, shorter than ${minimum} (\`allowShortSecret: true\`). Anyone holding a ` +
      `token can guess it offline and then sign their own. Replace it with \`openssl rand -base64 ${minimum}\` when you can.`,
  );
}

export function assertSigningKey(
  alg: JwsAlgorithm,
  key: JwsKey,
  owner: string,
  rules: KeyRules = {},
): void {
  assertKeyFits(alg, key, owner, rules);
  if (!isHmac(alg) && key.type !== "private") {
    throw new TypeError(`${owner}: ${alg} signing needs a private key.`);
  }
}

export async function signJws(
  header: JwsHeader & { alg: JwsAlgorithm },
  payload: object,
  key: JwsKey,
  rules: KeyRules = {},
): Promise<string> {
  assertSigningKey(header.alg, key, "JwtSigner", rules);
  const input = `${encode(header)}.${encode(payload)}`;
  const data = toArrayBufferUint8Array(Buffer.from(input, "utf8"));
  const { alg } = header;
  let signature: Uint8Array;
  switch (alg) {
    case "HS256":
    case "HS384":
    case "HS512":
      if (key.rawSecret) {
        signature = new Bun.CryptoHasher(BUN_HASH[alg], key.rawSecret)
          .update(data)
          .digest();
      } else {
        const ck = await key.getCryptoKey(alg, "sign");
        signature = new Uint8Array(await crypto.subtle.sign("HMAC", ck, data));
      }
      break;
    case "RS256":
    case "RS384":
    case "RS512": {
      const ck = await key.getCryptoKey(alg, "sign");
      signature = new Uint8Array(
        await crypto.subtle.sign("RSASSA-PKCS1-v1_5", ck, data),
      );
      break;
    }
    case "PS256":
    case "PS384":
    case "PS512": {
      const ck = await key.getCryptoKey(alg, "sign");
      signature = new Uint8Array(
        await crypto.subtle.sign(
          { name: "RSA-PSS", saltLength: PSS_SALT_LENGTH[alg] },
          ck,
          data,
        ),
      );
      break;
    }
    case "ES256":
    case "ES384":
    case "ES512": {
      const ck = await key.getCryptoKey(alg, "sign");
      signature = new Uint8Array(
        await crypto.subtle.sign(
          { name: "ECDSA", hash: WEB_HASH[alg] },
          ck,
          data,
        ),
      );
      break;
    }
    case "EdDSA": {
      const ck = await key.getCryptoKey(alg, "sign");
      signature = new Uint8Array(await crypto.subtle.sign("Ed25519", ck, data));
      break;
    }
  }
  return `${input}.${Buffer.from(signature.buffer, signature.byteOffset, signature.byteLength).toString("base64url")}`;
}

export function decodeJws(token: string): DecodedJws {
  if (typeof token !== "string") {
    throw new JwtError("malformed token");
  }
  const parts = token.split(".");
  if (parts.length !== 3 || !parts.every((p) => SEGMENT.test(p))) {
    throw new JwtError("malformed token");
  }
  const header = decodeJson(parts[0]!) as JwsHeader;
  if (typeof header.alg !== "string") {
    throw new JwtError("malformed token");
  }
  const signature = Buffer.from(parts[2]!, "base64url");
  if (signature.toString("base64url") !== parts[2]) {
    throw new JwtError("malformed token");
  }
  return {
    header,
    payload: decodeJson(parts[1]!) as JwtClaims,
    signingInput: Buffer.from(`${parts[0]}.${parts[1]}`),
    signature,
  };
}

export async function verifySignature(
  alg: JwsAlgorithm,
  key: JwsKey,
  decoded: DecodedJws,
  rules: KeyRules = {},
): Promise<void> {
  const publicKey = key.toPublicKey();
  if (!keyFits(alg, publicKey, rules)) {
    throw new JwtError(`key is not a valid ${alg} key`);
  }
  const signingInput = toArrayBufferUint8Array(decoded.signingInput);
  const signature = toArrayBufferUint8Array(decoded.signature);
  let valid = false;
  try {
    switch (alg) {
      case "HS256":
      case "HS384":
      case "HS512": {
        if (publicKey.rawSecret) {
          const expected = new Bun.CryptoHasher(
            BUN_HASH[alg],
            publicKey.rawSecret,
          )
            .update(signingInput)
            .digest();
          valid = timingSafeEqualBytes(signature, expected);
        } else {
          const ck = await publicKey.getCryptoKey(alg, "verify");
          valid = await crypto.subtle.verify("HMAC", ck, signature, signingInput);
        }
        break;
      }
      case "RS256":
      case "RS384":
      case "RS512": {
        const ck = await publicKey.getCryptoKey(alg, "verify");
        valid = await crypto.subtle.verify(
          "RSASSA-PKCS1-v1_5",
          ck,
          signature,
          signingInput,
        );
        break;
      }
      case "PS256":
      case "PS384":
      case "PS512": {
        const ck = await publicKey.getCryptoKey(alg, "verify");
        valid = await crypto.subtle.verify(
          { name: "RSA-PSS", saltLength: PSS_SALT_LENGTH[alg] },
          ck,
          signature,
          signingInput,
        );
        break;
      }
      case "ES256":
      case "ES384":
      case "ES512": {
        if (signature.byteLength === ECDSA_SIGNATURE_BYTES[alg]) {
          const ck = await publicKey.getCryptoKey(alg, "verify");
          valid = await crypto.subtle.verify(
            { name: "ECDSA", hash: WEB_HASH[alg] },
            ck,
            signature,
            signingInput,
          );
        }
        break;
      }
      case "EdDSA": {
        if (signature.byteLength === 64) {
          const ck = await publicKey.getCryptoKey(alg, "verify");
          valid = await crypto.subtle.verify(
            "Ed25519",
            ck,
            signature,
            signingInput,
          );
        }
        break;
      }
      default:
        valid = false;
    }
  } catch {
    valid = false;
  }
  if (!valid) {
    throw new JwtError("invalid signature");
  }
}

export function validateClaims(claims: JwtClaims, rules: ClaimRules): void {
  const now = Math.floor((rules.now?.() ?? Date.now()) / 1000);
  const leeway = toMs(rules.clockTolerance ?? 0) / 1000;
  for (const name of rules.required ?? ["exp"]) {
    if (claims[name] === undefined) {
      throw new JwtError(`missing ${name}`);
    }
  }
  for (const name of ["exp", "nbf", "iat"] as const) {
    if (
      claims[name] !== undefined &&
      (typeof claims[name] !== "number" || !Number.isFinite(claims[name]))
    ) {
      throw new JwtError(`invalid ${name}`);
    }
  }
  for (const name of ["iss", "sub", "jti"] as const) {
    if (claims[name] !== undefined && typeof claims[name] !== "string") {
      throw new JwtError(`invalid ${name}`);
    }
  }
  if (claims.exp !== undefined && now >= claims.exp + leeway) {
    throw new JwtError("token expired");
  }
  if (claims.nbf !== undefined && now < claims.nbf - leeway) {
    throw new JwtError("token not yet valid");
  }
  if (claims.iat !== undefined && claims.iat > now + leeway) {
    throw new JwtError("token issued in the future");
  }
  if (rules.maxAge !== undefined) {
    if (claims.iat === undefined) {
      throw new JwtError("missing iat");
    }
    if (now - claims.iat > toMs(rules.maxAge) / 1000 + leeway) {
      throw new JwtError("token too old");
    }
  }
  if (rules.issuer !== undefined && claims.iss !== rules.issuer) {
    throw new JwtError("unexpected issuer");
  }
  if (rules.audience !== undefined && rules.audience !== false) {
    const accepted = Array.isArray(rules.audience)
      ? rules.audience
      : [rules.audience];
    const given =
      claims.aud === undefined
        ? []
        : Array.isArray(claims.aud)
          ? claims.aud
          : [claims.aud];
    if (
      !given.some((aud) => typeof aud === "string" && accepted.includes(aud))
    ) {
      throw new JwtError("unexpected audience");
    }
  }
}

/** Converts an ASN.1 DER ECDSA signature (`SEQUENCE { r, s }`) to IEEE P1363 raw `r || s`. */
export function ecdsaDerToP1363(
  der: Uint8Array,
  coordBytes: number,
): Uint8Array {
  const seq = readDerTlv(der, 0, der.length);
  if (seq.tag !== 0x30 || seq.next !== der.length) {
    throw new Error("Invalid DER ECDSA signature");
  }
  const rTlv = readDerTlv(der, seq.start, seq.end);
  const sTlv = readDerTlv(der, rTlv.next, seq.end);
  if (rTlv.tag !== 0x02 || sTlv.tag !== 0x02 || sTlv.next !== seq.end) {
    throw new Error("Invalid DER ECDSA integers");
  }
  const out = new Uint8Array(coordBytes * 2);
  writeUnsignedIntPadded(der.subarray(rTlv.start, rTlv.end), out, 0, coordBytes);
  writeUnsignedIntPadded(
    der.subarray(sTlv.start, sTlv.end),
    out,
    coordBytes,
    coordBytes,
  );
  return out;
}

/** Converts an IEEE P1363 raw `r || s` ECDSA signature to ASN.1 DER (`SEQUENCE { r, s }`). */
export function ecdsaP1363ToDer(
  sig: Uint8Array,
  coordBytes: number,
): Uint8Array {
  if (sig.byteLength !== coordBytes * 2) {
    throw new Error("Invalid IEEE P1363 signature length");
  }
  const r = wrapDer(0x02, toDerPositiveInteger(sig.subarray(0, coordBytes)));
  const s = wrapDer(0x02, toDerPositiveInteger(sig.subarray(coordBytes)));
  const body = new Uint8Array(r.length + s.length);
  body.set(r, 0);
  body.set(s, r.length);
  return wrapDer(0x30, body);
}

// ---------------------------------------------------------------- helpers

function isCryptoKey(value: unknown): value is CryptoKey {
  return typeof CryptoKey !== "undefined" && value instanceof CryptoKey;
}

function isKeyObjectLike(value: unknown): value is JwsKeyObjectLike {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    "export" in value &&
    typeof (value as { export?: unknown }).export === "function"
  );
}

function toArrayBufferUint8Array(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out;
}

function fromCryptoKey(key: CryptoKey): JwsKey {
  const algName = key.algorithm.name;
  if (key.type === "secret" || algName === "HMAC") {
    const lengthBits = (key.algorithm as { length?: number }).length ?? 0;
    return new JwsKey({
      type: "secret",
      symmetricKeySize: Math.floor(lengthBits / 8),
      cryptoKey: key,
    });
  }
  const keyType = key.type === "private" ? "private" : "public";
  if (algName === "RSASSA-PKCS1-v1_5" || algName === "RSA-PSS") {
    const modulusLength = (key.algorithm as { modulusLength?: number })
      .modulusLength;
    return new JwsKey({
      type: keyType,
      asymmetricKeyType: "rsa",
      asymmetricKeyDetails: { modulusLength },
      cryptoKey: key,
    });
  }
  if (algName === "ECDSA") {
    const rawCurve = (key.algorithm as { namedCurve?: string }).namedCurve;
    const namedCurve =
      (rawCurve ? WEB_CURVE_TO_OPENSSL[rawCurve] : undefined) ?? rawCurve;
    return new JwsKey({
      type: keyType,
      asymmetricKeyType: "ec",
      asymmetricKeyDetails: { namedCurve },
      cryptoKey: key,
    });
  }
  if (algName === "Ed25519") {
    return new JwsKey({
      type: keyType,
      asymmetricKeyType: "ed25519",
      cryptoKey: key,
    });
  }
  return new JwsKey({
    type: keyType,
    asymmetricKeyType: algName.toLowerCase(),
    cryptoKey: key,
  });
}

function fromKeyObjectLike(key: JwsKeyObjectLike): JwsKey {
  const exporter = key as {
    export(options?: Record<string, unknown>): unknown;
  };
  if (key.type === "secret") {
    const raw = toArrayBufferUint8Array(exporter.export() as Uint8Array);
    return new JwsKey({
      type: "secret",
      symmetricKeySize: key.symmetricKeySize ?? raw.byteLength,
      rawSecret: raw,
    });
  }
  if (key.type === "private") {
    // Try exporting JWK first (gives both private & public parameters synchronously)
    try {
      const jwk = exporter.export({ format: "jwk" }) as Record<string, unknown>;
      if (jwk && typeof jwk === "object" && typeof jwk.kty === "string") {
        return jwkToJwsKey(jwk, "private");
      }
    } catch {
      // Fallback to PKCS#8 DER below
    }
    const pkcs8 = toArrayBufferUint8Array(
      exporter.export({ format: "der", type: "pkcs8" }) as Uint8Array,
    );
    return parsePkcs8(pkcs8);
  }
  if (key.type === "public") {
    try {
      const spki = toArrayBufferUint8Array(
        exporter.export({ format: "der", type: "spki" }) as Uint8Array,
      );
      return parseSpki(spki);
    } catch {
      const jwk = exporter.export({ format: "jwk" }) as Record<string, unknown>;
      return jwkToJwsKey(jwk, "public");
    }
  }
  throw new TypeError(`Unsupported key type: ${String(key.type)}`);
}

function jwkToJwsKey(
  jwk: Record<string, unknown>,
  type: "public" | "private",
): JwsKey {
  if (jwk.kty === "RSA" && typeof jwk.n === "string") {
    const nBytes = Buffer.from(jwk.n, "base64url");
    const modulusLength = unsignedBitLength(nBytes);
    return new JwsKey({
      type,
      asymmetricKeyType: "rsa",
      asymmetricKeyDetails: { modulusLength },
      jwk,
    });
  }
  if (jwk.kty === "EC" && typeof jwk.crv === "string") {
    return new JwsKey({
      type,
      asymmetricKeyType: "ec",
      asymmetricKeyDetails: {
        namedCurve: WEB_CURVE_TO_OPENSSL[jwk.crv] ?? jwk.crv,
      },
      jwk,
    });
  }
  if (jwk.kty === "OKP" && typeof jwk.crv === "string") {
    return new JwsKey({
      type,
      asymmetricKeyType: jwk.crv.toLowerCase(),
      jwk,
    });
  }
  return new JwsKey({
    type,
    asymmetricKeyType: String(jwk.kty ?? "unknown").toLowerCase(),
    jwk,
  });
}

function stripPrivateJwkFields(
  jwk: Record<string, unknown>,
): Record<string, unknown> {
  const {
    d: _d,
    p: _p,
    q: _q,
    dp: _dp,
    dq: _dq,
    qi: _qi,
    oth: _oth,
    ...pub
  } = jwk;
  return pub;
}

function sanitizeJwkForImport(jwk: Record<string, unknown>): SubtleJwk {
  const {
    alg: _alg,
    use: _use,
    key_ops: _keyOps,
    ext: _ext,
    ...rest
  } = jwk;
  return rest as SubtleJwk;
}

function parsePemBlock(text: string, label: string): JwsKey {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `-----BEGIN ${escaped}-----([\\s\\S]*?)-----END ${escaped}-----`,
  );
  const match = re.exec(text);
  if (!match) {
    throw new Error("missing END boundary");
  }
  const b64 = match[1]!.replace(/\s+/g, "");
  if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
    throw new Error("invalid base64 body");
  }
  const der = toArrayBufferUint8Array(Buffer.from(b64, "base64"));
  switch (label) {
    case "PRIVATE KEY":
      return parsePkcs8(der);
    case "RSA PRIVATE KEY":
      return parsePkcs1RsaPrivate(der);
    case "EC PRIVATE KEY":
      return parseSec1EcPrivate(der);
    case "PUBLIC KEY":
      return parseSpki(der);
    case "RSA PUBLIC KEY":
      return parsePkcs1RsaPublic(der);
    case "CERTIFICATE":
      return parseX509Certificate(der);
    default:
      throw new Error(`unsupported PEM label "${label}"`);
  }
}

interface DerTlv {
  tag: number;
  start: number;
  end: number;
  next: number;
}

function readDerTlv(der: Uint8Array, offset: number, limit: number): DerTlv {
  if (offset >= limit) {
    throw new Error("unexpected end of DER input");
  }
  const tag = der[offset++]!;
  if (offset >= limit) {
    throw new Error("truncated DER length");
  }
  const firstLen = der[offset++]!;
  let len: number;
  if ((firstLen & 0x80) === 0) {
    len = firstLen;
  } else {
    const count = firstLen & 0x7f;
    if (count === 0 || count > 4 || offset + count > limit) {
      throw new Error("invalid DER length encoding");
    }
    len = 0;
    for (let i = 0; i < count; i++) {
      len = len * 256 + der[offset++]!;
    }
  }
  const end = offset + len;
  if (end > limit) {
    throw new Error("DER element exceeds buffer");
  }
  return { tag, start: offset, end, next: end };
}

function decodeOid(der: Uint8Array, start: number, end: number): string {
  if (start >= end) {
    throw new Error("empty OID");
  }
  const first = der[start]!;
  const arcs: number[] = [Math.floor(first / 40), first % 40];
  let value = 0;
  let inArc = false;
  for (let i = start + 1; i < end; i++) {
    const byte = der[i]!;
    value = value * 128 + (byte & 0x7f);
    inArc = true;
    if ((byte & 0x80) === 0) {
      arcs.push(value);
      value = 0;
      inArc = false;
    }
  }
  if (inArc) {
    throw new Error("truncated OID");
  }
  return arcs.join(".");
}

function unsignedBitLength(bytes: Uint8Array): number {
  let pos = 0;
  while (pos < bytes.length && bytes[pos] === 0x00) {
    pos++;
  }
  if (pos >= bytes.length) {
    return 0;
  }
  return (bytes.length - pos - 1) * 8 + (32 - Math.clz32(bytes[pos]!));
}

function encodeDerLength(len: number): Uint8Array {
  if (len < 0x80) {
    return new Uint8Array([len]);
  }
  const bytes: number[] = [];
  let n = len;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>>= 8;
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function wrapDer(tag: number, content: Uint8Array): Uint8Array<ArrayBuffer> {
  const len = encodeDerLength(content.length);
  const out = new Uint8Array(1 + len.length + content.length);
  out[0] = tag;
  out.set(len, 1);
  out.set(content, 1 + len.length);
  return out;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let total = 0;
  for (const part of parts) {
    total += part.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function wrapBitString(content: Uint8Array): Uint8Array<ArrayBuffer> {
  const padded = new Uint8Array(1 + content.length);
  padded[0] = 0x00;
  padded.set(content, 1);
  return wrapDer(0x03, padded);
}

function parseSpki(der: Uint8Array<ArrayBuffer>): JwsKey {
  const seq = readDerTlv(der, 0, der.length);
  if (seq.tag !== 0x30 || seq.next !== der.length) {
    throw new Error("invalid SPKI SEQUENCE");
  }
  const algSeq = readDerTlv(der, seq.start, seq.end);
  if (algSeq.tag !== 0x30) {
    throw new Error("invalid SPKI AlgorithmIdentifier");
  }
  const oidTlv = readDerTlv(der, algSeq.start, algSeq.end);
  if (oidTlv.tag !== 0x06) {
    throw new Error("invalid SPKI OID");
  }
  const oid = decodeOid(der, oidTlv.start, oidTlv.end);
  const pubBitStr = readDerTlv(der, algSeq.next, seq.end);
  if (pubBitStr.tag !== 0x03 || pubBitStr.end - pubBitStr.start < 2) {
    throw new Error("invalid SPKI BIT STRING");
  }
  const pubBytes = der.subarray(pubBitStr.start + 1, pubBitStr.end);

  if (oid === OID_RSA) {
    const rsaSeq = readDerTlv(pubBytes, 0, pubBytes.length);
    if (rsaSeq.tag !== 0x30) {
      throw new Error("invalid RSA public key");
    }
    const mod = readDerTlv(pubBytes, rsaSeq.start, rsaSeq.end);
    const exp = readDerTlv(pubBytes, mod.next, rsaSeq.end);
    if (mod.tag !== 0x02 || exp.tag !== 0x02) {
      throw new Error("invalid RSA modulus/exponent");
    }
    return new JwsKey({
      type: "public",
      asymmetricKeyType: "rsa",
      asymmetricKeyDetails: {
        modulusLength: unsignedBitLength(pubBytes.subarray(mod.start, mod.end)),
      },
      spkiDer: der,
    });
  }
  if (oid === OID_EC) {
    const curveTlv = readDerTlv(der, oidTlv.next, algSeq.end);
    if (curveTlv.tag !== 0x06) {
      throw new Error("invalid EC namedCurve OID");
    }
    const curveOid = decodeOid(der, curveTlv.start, curveTlv.end);
    return new JwsKey({
      type: "public",
      asymmetricKeyType: "ec",
      asymmetricKeyDetails: { namedCurve: CURVE_OIDS[curveOid] ?? curveOid },
      spkiDer: der,
    });
  }
  if (oid === OID_ED25519) {
    return new JwsKey({
      type: "public",
      asymmetricKeyType: "ed25519",
      spkiDer: der,
    });
  }
  return new JwsKey({
    type: "public",
    asymmetricKeyType: oidToKeyType(oid),
    spkiDer: der,
  });
}

function parsePkcs1RsaPublic(der: Uint8Array<ArrayBuffer>): JwsKey {
  const seq = readDerTlv(der, 0, der.length);
  if (seq.tag !== 0x30 || seq.next !== der.length) {
    throw new Error("invalid PKCS#1 RSA public key");
  }
  const mod = readDerTlv(der, seq.start, seq.end);
  const exp = readDerTlv(der, mod.next, seq.end);
  if (mod.tag !== 0x02 || exp.tag !== 0x02 || exp.next !== seq.end) {
    throw new Error("invalid PKCS#1 RSA public key fields");
  }
  const spki = wrapDer(0x30, concatBytes(RSA_ALG_ID_DER, wrapBitString(der)));
  return new JwsKey({
    type: "public",
    asymmetricKeyType: "rsa",
    asymmetricKeyDetails: {
      modulusLength: unsignedBitLength(der.subarray(mod.start, mod.end)),
    },
    spkiDer: spki,
  });
}

function parseX509Certificate(der: Uint8Array<ArrayBuffer>): JwsKey {
  const certSeq = readDerTlv(der, 0, der.length);
  if (certSeq.tag !== 0x30 || certSeq.next !== der.length) {
    throw new Error("invalid X.509 Certificate SEQUENCE");
  }
  const tbs = readDerTlv(der, certSeq.start, certSeq.end);
  if (tbs.tag !== 0x30) {
    throw new Error("invalid TBSCertificate");
  }
  let cursor = tbs.start;
  // Optional [0] EXPLICIT version (tag 0xa0)
  const first = readDerTlv(der, cursor, tbs.end);
  if (first.tag === 0xa0) {
    cursor = first.next;
  }
  // serialNumber (INTEGER), signature (AlgorithmIdentifier), issuer (Name),
  // validity (Validity), subject (Name) -> 5 fields before subjectPublicKeyInfo
  for (let i = 0; i < 5; i++) {
    const field = readDerTlv(der, cursor, tbs.end);
    cursor = field.next;
  }
  const spkiTlv = readDerTlv(der, cursor, tbs.end);
  if (spkiTlv.tag !== 0x30) {
    throw new Error("invalid X.509 SubjectPublicKeyInfo");
  }
  const spkiDer = toArrayBufferUint8Array(der.subarray(cursor, spkiTlv.next));
  return parseSpki(spkiDer);
}

function parsePkcs8(der: Uint8Array<ArrayBuffer>): JwsKey {
  const seq = readDerTlv(der, 0, der.length);
  if (seq.tag !== 0x30 || seq.next !== der.length) {
    throw new Error("invalid PKCS#8 SEQUENCE");
  }
  const ver = readDerTlv(der, seq.start, seq.end);
  if (ver.tag !== 0x02) {
    throw new Error("invalid PKCS#8 version");
  }
  const algSeq = readDerTlv(der, ver.next, seq.end);
  if (algSeq.tag !== 0x30) {
    throw new Error("invalid PKCS#8 AlgorithmIdentifier");
  }
  const oidTlv = readDerTlv(der, algSeq.start, algSeq.end);
  if (oidTlv.tag !== 0x06) {
    throw new Error("invalid PKCS#8 OID");
  }
  const oid = decodeOid(der, oidTlv.start, oidTlv.end);
  const privOctet = readDerTlv(der, algSeq.next, seq.end);
  if (privOctet.tag !== 0x04) {
    throw new Error("invalid PKCS#8 privateKey OCTET STRING");
  }
  const inner = der.subarray(privOctet.start, privOctet.end);

  if (oid === OID_RSA) {
    const { modulusLength, spkiDer } = extractRsaPrivateInfo(inner);
    return new JwsKey({
      type: "private",
      asymmetricKeyType: "rsa",
      asymmetricKeyDetails: { modulusLength },
      pkcs8Der: der,
      spkiDer,
    });
  }
  if (oid === OID_EC) {
    const curveTlv = readDerTlv(der, oidTlv.next, algSeq.end);
    if (curveTlv.tag !== 0x06) {
      throw new Error("invalid EC namedCurve OID");
    }
    const curveOid = decodeOid(der, curveTlv.start, curveTlv.end);
    const spkiDer = tryExtractEcSpkiFromPrivate(
      inner,
      der.subarray(algSeq.start - 2 < 0 ? 0 : ver.next, algSeq.next),
    );
    return new JwsKey({
      type: "private",
      asymmetricKeyType: "ec",
      asymmetricKeyDetails: { namedCurve: CURVE_OIDS[curveOid] ?? curveOid },
      pkcs8Der: der,
      ...(spkiDer ? { spkiDer } : {}),
    });
  }
  if (oid === OID_ED25519) {
    return new JwsKey({
      type: "private",
      asymmetricKeyType: "ed25519",
      pkcs8Der: der,
    });
  }
  return new JwsKey({
    type: "private",
    asymmetricKeyType: oidToKeyType(oid),
    pkcs8Der: der,
  });
}

function parsePkcs1RsaPrivate(der: Uint8Array<ArrayBuffer>): JwsKey {
  const { modulusLength, spkiDer } = extractRsaPrivateInfo(der);
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const pkcs8 = wrapDer(
    0x30,
    concatBytes(version, RSA_ALG_ID_DER, wrapDer(0x04, der)),
  );
  return new JwsKey({
    type: "private",
    asymmetricKeyType: "rsa",
    asymmetricKeyDetails: { modulusLength },
    pkcs8Der: pkcs8,
    spkiDer,
  });
}

function extractRsaPrivateInfo(pkcs1Der: Uint8Array): {
  modulusLength: number;
  spkiDer: Uint8Array<ArrayBuffer>;
} {
  const seq = readDerTlv(pkcs1Der, 0, pkcs1Der.length);
  if (seq.tag !== 0x30 || seq.next !== pkcs1Der.length) {
    throw new Error("invalid PKCS#1 RSA private key");
  }
  const ver = readDerTlv(pkcs1Der, seq.start, seq.end);
  const mod = readDerTlv(pkcs1Der, ver.next, seq.end);
  const pubExp = readDerTlv(pkcs1Der, mod.next, seq.end);
  if (ver.tag !== 0x02 || mod.tag !== 0x02 || pubExp.tag !== 0x02) {
    throw new Error("invalid PKCS#1 RSA private key integers");
  }
  const modBytes = pkcs1Der.subarray(mod.start, mod.end);
  const modulusLength = unsignedBitLength(modBytes);
  const rsaPubSeq = wrapDer(
    0x30,
    concatBytes(
      pkcs1Der.subarray(ver.next, mod.next),
      pkcs1Der.subarray(mod.next, pubExp.next),
    ),
  );
  const spkiDer = wrapDer(
    0x30,
    concatBytes(RSA_ALG_ID_DER, wrapBitString(rsaPubSeq)),
  );
  return { modulusLength, spkiDer };
}

function parseSec1EcPrivate(der: Uint8Array<ArrayBuffer>): JwsKey {
  const seq = readDerTlv(der, 0, der.length);
  if (seq.tag !== 0x30 || seq.next !== der.length) {
    throw new Error("invalid SEC1 EC private key");
  }
  const ver = readDerTlv(der, seq.start, seq.end);
  const privOctet = readDerTlv(der, ver.next, seq.end);
  if (ver.tag !== 0x02 || privOctet.tag !== 0x04) {
    throw new Error("invalid SEC1 EC private key structure");
  }
  let curveOidBytes: Uint8Array | undefined;
  let curveOid: string | undefined;
  let pubKeyTlvBytes: Uint8Array | undefined;
  let pubBitStringBytes: Uint8Array | undefined;
  let cursor = privOctet.next;
  while (cursor < seq.end) {
    const field = readDerTlv(der, cursor, seq.end);
    if (field.tag === 0xa0) {
      const innerOid = readDerTlv(der, field.start, field.end);
      if (innerOid.tag !== 0x06) {
        throw new Error("invalid SEC1 EC curve OID");
      }
      curveOid = decodeOid(der, innerOid.start, innerOid.end);
      curveOidBytes = der.subarray(field.start, innerOid.next);
    } else if (field.tag === 0xa1) {
      pubKeyTlvBytes = der.subarray(cursor, field.next);
      pubBitStringBytes = der.subarray(field.start, field.end);
    }
    cursor = field.next;
  }
  if (!curveOid || !curveOidBytes) {
    throw new Error("SEC1 EC private key missing curve parameters");
  }
  const ecAlgOid = new Uint8Array([0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01]);
  const algId = wrapDer(0x30, concatBytes(ecAlgOid, curveOidBytes));
  const innerParts = [
    der.subarray(seq.start, ver.next),
    der.subarray(ver.next, privOctet.next),
    ...(pubKeyTlvBytes ? [pubKeyTlvBytes] : []),
  ];
  const innerEc = wrapDer(0x30, concatBytes(...innerParts));
  const pkcs8 = wrapDer(
    0x30,
    concatBytes(new Uint8Array([0x02, 0x01, 0x00]), algId, wrapDer(0x04, innerEc)),
  );
  const spkiDer = pubBitStringBytes
    ? wrapDer(0x30, concatBytes(algId, pubBitStringBytes))
    : undefined;
  return new JwsKey({
    type: "private",
    asymmetricKeyType: "ec",
    asymmetricKeyDetails: { namedCurve: CURVE_OIDS[curveOid] ?? curveOid },
    pkcs8Der: pkcs8,
    ...(spkiDer ? { spkiDer } : {}),
  });
}

function tryExtractEcSpkiFromPrivate(
  ecPrivateDer: Uint8Array,
  algIdDer: Uint8Array,
): Uint8Array<ArrayBuffer> | undefined {
  try {
    const seq = readDerTlv(ecPrivateDer, 0, ecPrivateDer.length);
    if (seq.tag !== 0x30) return undefined;
    let cursor = seq.start;
    while (cursor < seq.end) {
      const field = readDerTlv(ecPrivateDer, cursor, seq.end);
      if (field.tag === 0xa1) {
        const bitStr = readDerTlv(ecPrivateDer, field.start, field.end);
        if (bitStr.tag === 0x03) {
          return wrapDer(
            0x30,
            concatBytes(algIdDer, ecPrivateDer.subarray(field.start, bitStr.next)),
          );
        }
      }
      cursor = field.next;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function oidToKeyType(oid: string): string {
  switch (oid) {
    case OID_RSA:
      return "rsa";
    case OID_RSA_PSS:
      return "rsa-pss";
    case OID_EC:
      return "ec";
    case OID_ED25519:
      return "ed25519";
    case OID_ED448:
      return "ed448";
    case OID_X25519:
      return "x25519";
    case OID_X448:
      return "x448";
    default:
      return oid;
  }
}

function isEncodedKey(key: string | Uint8Array): boolean {
  const candidates: Uint8Array<ArrayBuffer>[] = [];
  if (key instanceof Uint8Array) {
    candidates.push(toArrayBufferUint8Array(key));
  }
  const compact = (
    typeof key === "string"
      ? key
      : Buffer.from(key.buffer, key.byteOffset, key.byteLength).toString(
          "latin1",
        )
  ).replace(/\s+/g, "");
  if (/^[A-Za-z0-9+/_-]{40,}={0,2}$/.test(compact)) {
    const normalized = compact.replace(/-/g, "+").replace(/_/g, "/");
    candidates.push(toArrayBufferUint8Array(Buffer.from(normalized, "base64")));
  }
  const readers = [
    parseSpki,
    parsePkcs1RsaPublic,
    parsePkcs8,
    parsePkcs1RsaPrivate,
    parseSec1EcPrivate,
    parseX509Certificate,
  ];
  return candidates.some((der) =>
    readers.some((read) => {
      try {
        read(der);
        return true;
      } catch {
        return false;
      }
    }),
  );
}

function isJwk(text: string): boolean {
  if (!text.trimStart().startsWith("{")) {
    return false;
  }
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    return (
      typeof value === "object" &&
      value !== null &&
      typeof value.kty === "string"
    );
  } catch {
    return false;
  }
}

function writeUnsignedIntPadded(
  src: Uint8Array,
  dst: Uint8Array,
  dstOffset: number,
  size: number,
): void {
  let start = 0;
  while (start < src.length && src[start] === 0x00) {
    start++;
  }
  const len = src.length - start;
  if (len > size) {
    throw new Error("DER integer too large for curve size");
  }
  dst.set(src.subarray(start), dstOffset + (size - len));
}

function toDerPositiveInteger(bytes: Uint8Array): Uint8Array {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0x00) {
    start++;
  }
  const trimmed = bytes.subarray(start);
  if ((trimmed[0]! & 0x80) !== 0) {
    const out = new Uint8Array(trimmed.length + 1);
    out[0] = 0x00;
    out.set(trimmed, 1);
    return out;
  }
  return trimmed;
}

function encode(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decodeJson(segment: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    throw new JwtError("malformed token");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new JwtError("malformed token");
  }
  return value as Record<string, unknown>;
}
