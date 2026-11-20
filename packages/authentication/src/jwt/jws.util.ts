import {
  KeyObject,
  X509Certificate,
  constants,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  createSecretKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  timingSafeEqual,
} from "node:crypto";
import { Logger } from "@bunest/common";
import { JwtError } from "../errors/jwt.error";
import type {
  ClaimRules,
  JwsAlgorithm,
  JwtClaims,
} from "../interfaces/jwt.interface";
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

const hashOf = (alg: JwsAlgorithm): string => `sha${alg.slice(2)}`;
const CURVES: Record<"ES256" | "ES384" | "ES512", string> = {
  ES256: "prime256v1",
  ES384: "secp384r1",
  ES512: "secp521r1",
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
const PEM = /-----BEGIN ([A-Z0-9 ]+)-----/g;

/**
 * Converts key configuration into a `KeyObject`, refusing JWK/DER strings
 * that would otherwise be silently interpreted as weak HS256 secrets.
 */
export function toKeyObject(key: KeyObject | string | Buffer): KeyObject {
  if (key instanceof KeyObject) {
    return key;
  }
  const text = typeof key === "string" ? key : key.toString("latin1");
  const labels = [...text.matchAll(PEM)].map((match) => match[1]!);
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
    return createSecretKey(typeof key === "string" ? Buffer.from(key) : key);
  }
  const label =
    labels.find((name) => name.includes("PRIVATE KEY")) ?? labels[0]!;
  try {
    return label.includes("PRIVATE KEY")
      ? createPrivateKey(key)
      : createPublicKey(key);
  } catch (error) {
    throw new TypeError(
      `Cannot read the PEM ${label.toLowerCase()}: ${(error as Error).message}`,
    );
  }
}

export function algorithmFor(key: KeyObject): JwsAlgorithm | undefined {
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

export function unsupportedKeyError(key: KeyObject, owner: string): TypeError {
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
  key: KeyObject,
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
  key: KeyObject,
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
  key: KeyObject,
  owner: string,
): void {
  if (!isHmac(alg) || key.type !== "secret") {
    return;
  }
  const size = key.symmetricKeySize ?? 0;
  const minimum = HMAC_SECRET_BYTES[alg as "HS256" | "HS384" | "HS512"];
  const digest = createHash("sha256").update(key.export()).digest("hex");
  if (size >= minimum || warnedShortSecrets.has(digest)) {
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
  key: KeyObject,
  owner: string,
  rules: KeyRules = {},
): void {
  assertKeyFits(alg, key, owner, rules);
  if (!isHmac(alg) && key.type !== "private") {
    throw new TypeError(`${owner}: ${alg} signing needs a private key.`);
  }
}

export function signJws(
  header: JwsHeader & { alg: JwsAlgorithm },
  payload: object,
  key: KeyObject,
  rules: KeyRules = {},
): string {
  assertSigningKey(header.alg, key, "JwtSigner", rules);
  const input = `${encode(header)}.${encode(payload)}`;
  const data = Buffer.from(input);
  const { alg } = header;
  let signature: Buffer;
  switch (alg) {
    case "HS256":
    case "HS384":
    case "HS512":
      signature = createHmac(hashOf(alg), key).update(data).digest();
      break;
    case "RS256":
    case "RS384":
    case "RS512":
      signature = cryptoSign(hashOf(alg), data, key);
      break;
    case "PS256":
    case "PS384":
    case "PS512":
      signature = cryptoSign(hashOf(alg), data, pss(key));
      break;
    case "ES256":
    case "ES384":
    case "ES512":
      signature = cryptoSign(hashOf(alg), data, {
        key,
        dsaEncoding: "ieee-p1363",
      });
      break;
    case "EdDSA":
      signature = cryptoSign(null, data, key);
      break;
  }
  return `${input}.${signature.toString("base64url")}`;
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

export function verifySignature(
  alg: JwsAlgorithm,
  key: KeyObject,
  decoded: DecodedJws,
  rules: KeyRules = {},
): void {
  const publicKey = key.type === "private" ? createPublicKey(key) : key;
  if (!keyFits(alg, publicKey, rules)) {
    throw new JwtError(`key is not a valid ${alg} key`);
  }
  const { signingInput, signature } = decoded;
  let valid: boolean;
  switch (alg) {
    case "HS256":
    case "HS384":
    case "HS512": {
      const expected = createHmac(hashOf(alg), publicKey)
        .update(signingInput)
        .digest();
      valid =
        signature.length === expected.length &&
        timingSafeEqual(signature, expected);
      break;
    }
    case "RS256":
    case "RS384":
    case "RS512":
      valid = cryptoVerify(hashOf(alg), signingInput, publicKey, signature);
      break;
    case "PS256":
    case "PS384":
    case "PS512":
      valid = cryptoVerify(
        hashOf(alg),
        signingInput,
        pss(publicKey),
        signature,
      );
      break;
    case "ES256":
    case "ES384":
    case "ES512":
      valid =
        signature.length === ECDSA_SIGNATURE_BYTES[alg] &&
        cryptoVerify(
          hashOf(alg),
          signingInput,
          { key: publicKey, dsaEncoding: "ieee-p1363" },
          signature,
        );
      break;
    case "EdDSA":
      valid =
        signature.length === 64 &&
        cryptoVerify(null, signingInput, publicKey, signature);
      break;
    default:
      valid = false;
  }
  if (!valid) {
    throw new JwtError("invalid signature");
  }
}

function pss(key: KeyObject) {
  return {
    key,
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
  };
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

function isEncodedKey(key: string | Buffer): boolean {
  const candidates: Buffer[] = [];
  if (Buffer.isBuffer(key)) {
    candidates.push(key);
  }
  const compact = (
    typeof key === "string" ? key : key.toString("latin1")
  ).replace(/\s+/g, "");
  if (/^[A-Za-z0-9+/_-]{40,}={0,2}$/.test(compact)) {
    candidates.push(Buffer.from(compact, "base64"));
  }
  const readers = [
    (der: Buffer) => createPublicKey({ key: der, format: "der", type: "spki" }),
    (der: Buffer) => createPublicKey({ key: der, format: "der", type: "pkcs1" }),
    (der: Buffer) =>
      createPrivateKey({ key: der, format: "der", type: "pkcs8" }),
    (der: Buffer) =>
      createPrivateKey({ key: der, format: "der", type: "pkcs1" }),
    (der: Buffer) => createPrivateKey({ key: der, format: "der", type: "sec1" }),
    (der: Buffer) => new X509Certificate(der),
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
