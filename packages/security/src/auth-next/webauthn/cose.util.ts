import { base64UrlEncode } from "../../utils/crypto.util";
import { decodeCbor, type CborKey, type CborValue } from "./cbor.util";

export const COSE_ALG_ES256 = -7 as const;
export const COSE_ALG_RS256 = -257 as const;
export const COSE_ALG_EDDSA = -8 as const;

export const COSE_KTY_OKP = 1 as const;
export const COSE_KTY_EC2 = 2 as const;
export const COSE_KTY_RSA = 3 as const;

export const COSE_CRV_P256 = 1 as const;
export const COSE_CRV_ED25519 = 6 as const;

export const DEFAULT_WEBAUTHN_ALGORITHMS = [
  COSE_ALG_ES256,
  COSE_ALG_RS256,
  COSE_ALG_EDDSA,
] as const;

export type ParsedCosePublicKey =
  | {
      readonly kty: typeof COSE_KTY_EC2;
      readonly algorithm: typeof COSE_ALG_ES256;
      readonly crv: typeof COSE_CRV_P256;
      readonly x: Uint8Array<ArrayBuffer>;
      readonly y: Uint8Array<ArrayBuffer>;
    }
  | {
      readonly kty: typeof COSE_KTY_RSA;
      readonly algorithm: typeof COSE_ALG_RS256;
      readonly n: Uint8Array<ArrayBuffer>;
      readonly e: Uint8Array<ArrayBuffer>;
    }
  | {
      readonly kty: typeof COSE_KTY_OKP;
      readonly algorithm: typeof COSE_ALG_EDDSA;
      readonly crv: typeof COSE_CRV_ED25519;
      readonly x: Uint8Array<ArrayBuffer>;
    };

export class CoseKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoseKeyError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function toArrayBufferBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function stripLeadingZeroBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  let start = 0;
  while (start < bytes.byteLength - 1 && bytes[start] === 0) {
    start += 1;
  }
  return toArrayBufferBytes(bytes.subarray(start));
}

function readIntParam(
  map: Map<CborKey, CborValue>,
  label: number,
  name: string,
): number {
  const val = map.get(label);
  if (typeof val !== "number" || !Number.isSafeInteger(val)) {
    throw new CoseKeyError(
      `COSE key missing or invalid integer parameter ${name} (label ${label})`,
    );
  }
  return val;
}

function readBytesParam(
  map: Map<CborKey, CborValue>,
  label: number,
  name: string,
): Uint8Array<ArrayBuffer> {
  const val = map.get(label);
  if (!(val instanceof Uint8Array) || val.byteLength === 0) {
    throw new CoseKeyError(
      `COSE key missing or invalid byte-string parameter ${name} (label ${label})`,
    );
  }
  return toArrayBufferBytes(val);
}

/**
 * Parses a CBOR-encoded COSE_Key (or already-decoded CBOR map) for
 * ES256 (-7, P-256), RS256 (-257, RSA), or EdDSA (-8, Ed25519).
 */
export function parseCosePublicKey(
  input: Uint8Array | Map<CborKey, CborValue>,
): ParsedCosePublicKey {
  const decoded = input instanceof Uint8Array ? decodeCbor(input) : input;
  if (!(decoded instanceof Map)) {
    throw new CoseKeyError("COSE public key must decode to a CBOR map");
  }

  const kty = readIntParam(decoded, 1, "kty");
  const alg = readIntParam(decoded, 3, "alg");

  if (alg === COSE_ALG_ES256) {
    if (kty !== COSE_KTY_EC2) {
      throw new CoseKeyError(
        `ES256 COSE key requires kty=2 (EC2), got ${kty}`,
      );
    }
    const crv = readIntParam(decoded, -1, "crv");
    if (crv !== COSE_CRV_P256) {
      throw new CoseKeyError(
        `ES256 COSE key requires crv=1 (P-256), got ${crv}`,
      );
    }
    const x = readBytesParam(decoded, -2, "x");
    const y = readBytesParam(decoded, -3, "y");
    if (x.byteLength !== 32 || y.byteLength !== 32) {
      throw new CoseKeyError(
        `ES256 P-256 coordinates must be 32 bytes each (got x=${x.byteLength}, y=${y.byteLength})`,
      );
    }
    return {
      kty: COSE_KTY_EC2,
      algorithm: COSE_ALG_ES256,
      crv: COSE_CRV_P256,
      x,
      y,
    };
  }

  if (alg === COSE_ALG_RS256) {
    if (kty !== COSE_KTY_RSA) {
      throw new CoseKeyError(
        `RS256 COSE key requires kty=3 (RSA), got ${kty}`,
      );
    }
    const rawN = readBytesParam(decoded, -1, "n");
    const rawE = readBytesParam(decoded, -2, "e");
    const n = stripLeadingZeroBytes(rawN);
    const e = stripLeadingZeroBytes(rawE);
    if (n.byteLength < 256) {
      throw new CoseKeyError(
        `RS256 RSA modulus must be at least 2048 bits (got ${n.byteLength * 8} bits)`,
      );
    }
    if (e.byteLength === 0 || (e[e.byteLength - 1]! & 1) === 0) {
      throw new CoseKeyError("RS256 RSA public exponent must be a positive odd integer");
    }
    // Reject e === 1
    if (e.byteLength === 1 && e[0]! < 3) {
      throw new CoseKeyError("RS256 RSA public exponent must be >= 3");
    }
    return {
      kty: COSE_KTY_RSA,
      algorithm: COSE_ALG_RS256,
      n,
      e,
    };
  }

  if (alg === COSE_ALG_EDDSA) {
    if (kty !== COSE_KTY_OKP) {
      throw new CoseKeyError(
        `EdDSA COSE key requires kty=1 (OKP), got ${kty}`,
      );
    }
    const crv = readIntParam(decoded, -1, "crv");
    if (crv !== COSE_CRV_ED25519) {
      throw new CoseKeyError(
        `EdDSA COSE key requires crv=6 (Ed25519), got ${crv}`,
      );
    }
    const x = readBytesParam(decoded, -2, "x");
    if (x.byteLength !== 32) {
      throw new CoseKeyError(
        `Ed25519 public key must be 32 bytes (got ${x.byteLength})`,
      );
    }
    return {
      kty: COSE_KTY_OKP,
      algorithm: COSE_ALG_EDDSA,
      crv: COSE_CRV_ED25519,
      x,
    };
  }

  throw new CoseKeyError(
    `Unsupported COSE algorithm ${alg}; supported algorithms are ES256 (-7), RS256 (-257), and Ed25519 (-8)`,
  );
}

/**
 * Strictly converts an ASN.1 DER-encoded ECDSA signature (`SEQUENCE { INTEGER r, INTEGER s }`)
 * into an IEEE P1363 raw `r || s` byte buffer suitable for `crypto.subtle.verify`.
 * Rejects non-canonical lengths, negative integers, leading-zero padding errors, and trailing bytes.
 */
export function derToP1363(
  der: Uint8Array,
  componentLength = 32,
): Uint8Array<ArrayBuffer> {
  if (!(der instanceof Uint8Array) || der.byteLength < 8) {
    throw new CoseKeyError("Invalid ASN.1 DER ECDSA signature: too short");
  }
  if (der[0] !== 0x30) {
    throw new CoseKeyError(
      "Invalid ASN.1 DER ECDSA signature: missing SEQUENCE tag (0x30)",
    );
  }

  let offset = 1;
  let seqLen = der[offset++]!;
  if (seqLen >= 0x80) {
    if (seqLen !== 0x81) {
      throw new CoseKeyError(
        "Invalid ASN.1 DER ECDSA signature: unsupported SEQUENCE length encoding",
      );
    }
    if (offset >= der.byteLength) {
      throw new CoseKeyError(
        "Invalid ASN.1 DER ECDSA signature: truncated SEQUENCE length",
      );
    }
    seqLen = der[offset++]!;
    if (seqLen < 0x80) {
      throw new CoseKeyError(
        "Invalid ASN.1 DER ECDSA signature: non-minimal SEQUENCE length",
      );
    }
  }

  if (offset + seqLen !== der.byteLength) {
    throw new CoseKeyError(
      "Invalid ASN.1 DER ECDSA signature: length mismatch or trailing bytes",
    );
  }

  const readDerInt = (label: string): Uint8Array => {
    if (offset + 2 > der.byteLength) {
      throw new CoseKeyError(
        `Invalid ASN.1 DER ECDSA signature: truncated INTEGER ${label}`,
      );
    }
    if (der[offset++] !== 0x02) {
      throw new CoseKeyError(
        `Invalid ASN.1 DER ECDSA signature: missing INTEGER tag for ${label}`,
      );
    }
    const len = der[offset++]!;
    if (len === 0 || len >= 0x80 || offset + len > der.byteLength) {
      throw new CoseKeyError(
        `Invalid ASN.1 DER ECDSA signature: invalid INTEGER length for ${label}`,
      );
    }
    const raw = der.subarray(offset, offset + len);
    offset += len;

    // DER positive integer checks
    if ((raw[0]! & 0x80) !== 0) {
      throw new CoseKeyError(
        `Invalid ASN.1 DER ECDSA signature: negative INTEGER ${label}`,
      );
    }
    if (raw.byteLength > 1 && raw[0] === 0x00 && (raw[1]! & 0x80) === 0) {
      throw new CoseKeyError(
        `Invalid ASN.1 DER ECDSA signature: non-canonical leading zero in INTEGER ${label}`,
      );
    }

    const unsigned = raw[0] === 0x00 && raw.byteLength > 1 ? raw.subarray(1) : raw;
    if (unsigned.byteLength > componentLength) {
      throw new CoseKeyError(
        `Invalid ASN.1 DER ECDSA signature: INTEGER ${label} exceeds ${componentLength} bytes`,
      );
    }
    let nonZero = false;
    for (let i = 0; i < unsigned.byteLength; i++) {
      if (unsigned[i] !== 0) {
        nonZero = true;
        break;
      }
    }
    if (!nonZero) {
      throw new CoseKeyError(
        `Invalid ASN.1 DER ECDSA signature: INTEGER ${label} must be non-zero`,
      );
    }
    return unsigned;
  };

  const r = readDerInt("r");
  const s = readDerInt("s");

  if (offset !== der.byteLength) {
    throw new CoseKeyError(
      "Invalid ASN.1 DER ECDSA signature: unexpected trailing bytes",
    );
  }

  const out = new Uint8Array(componentLength * 2);
  out.set(r, componentLength - r.byteLength);
  out.set(s, componentLength * 2 - s.byteLength);
  return out;
}

/**
 * Converts an IEEE P1363 raw `r || s` ECDSA signature (as produced by WebCrypto
 * `crypto.subtle.sign`) into canonical ASN.1 DER format.
 */
export function p1363ToDer(
  signature: Uint8Array,
  componentLength = 32,
): Uint8Array<ArrayBuffer> {
  if (signature.byteLength !== componentLength * 2) {
    throw new CoseKeyError(
      `Expected ${componentLength * 2}-byte P1363 signature (got ${signature.byteLength})`,
    );
  }

  const encodeInt = (slice: Uint8Array): number[] => {
    let start = 0;
    while (start < slice.byteLength - 1 && slice[start] === 0) {
      start += 1;
    }
    const trimmed = slice.subarray(start);
    const needsPad = (trimmed[0]! & 0x80) !== 0;
    const len = trimmed.byteLength + (needsPad ? 1 : 0);
    const res = [0x02, len];
    if (needsPad) {
      res.push(0x00);
    }
    for (let i = 0; i < trimmed.byteLength; i++) {
      res.push(trimmed[i]!);
    }
    return res;
  };

  const rDer = encodeInt(signature.subarray(0, componentLength));
  const sDer = encodeInt(signature.subarray(componentLength, componentLength * 2));
  const bodyLen = rDer.length + sDer.length;
  const header = bodyLen < 0x80 ? [0x30, bodyLen] : [0x30, 0x81, bodyLen];
  const out = new Uint8Array(header.length + bodyLen);
  out.set(header, 0);
  out.set(rDer, header.length);
  out.set(sDer, header.length + rDer.length);
  return out;
}

/**
 * Imports a parsed COSE public key into a WebCrypto `CryptoKey` for verification.
 */
export async function importCosePublicKey(
  key: ParsedCosePublicKey,
): Promise<CryptoKey> {
  switch (key.algorithm) {
    case COSE_ALG_ES256: {
      return await crypto.subtle.importKey(
        "jwk",
        {
          kty: "EC",
          crv: "P-256",
          x: base64UrlEncode(key.x),
          y: base64UrlEncode(key.y),
          ext: true,
        },
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
      );
    }
    case COSE_ALG_RS256: {
      return await crypto.subtle.importKey(
        "jwk",
        {
          kty: "RSA",
          n: base64UrlEncode(key.n),
          e: base64UrlEncode(key.e),
          alg: "RS256",
          ext: true,
        },
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
    }
    case COSE_ALG_EDDSA: {
      return await crypto.subtle.importKey(
        "raw",
        key.x,
        { name: "Ed25519" },
        false,
        ["verify"],
      );
    }
  }
}

/**
 * Verifies a WebAuthn signature (`authData || sha256(clientDataJSON)`) against
 * a parsed COSE public key using WebCrypto `crypto.subtle`.
 */
export async function verifyCoseSignature(
  key: ParsedCosePublicKey,
  signedData: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  const cryptoKey = await importCosePublicKey(key);
  const data = toArrayBufferBytes(signedData);

  switch (key.algorithm) {
    case COSE_ALG_ES256: {
      const p1363 = derToP1363(signature, 32);
      return await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        cryptoKey,
        p1363,
        data,
      );
    }
    case COSE_ALG_RS256: {
      if (signature.byteLength === 0) {
        return false;
      }
      return await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        cryptoKey,
        toArrayBufferBytes(signature),
        data,
      );
    }
    case COSE_ALG_EDDSA: {
      if (signature.byteLength !== 64) {
        return false;
      }
      return await crypto.subtle.verify(
        { name: "Ed25519" },
        cryptoKey,
        toArrayBufferBytes(signature),
        data,
      );
    }
  }
}
