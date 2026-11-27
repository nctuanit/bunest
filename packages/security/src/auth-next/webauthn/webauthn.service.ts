import { Inject, Injectable, Optional } from "@bunest/core";
import {
  base64UrlDecode,
  base64UrlEncode,
  randomBytes,
  timingSafeEqualBytes,
  timingSafeEqualString,
  utf8Decode,
  utf8Encode,
} from "../../utils/crypto.util";
import { AUTHENTICATION_MODULE_OPTIONS } from "../authentication.constants";
import { AuthenticationError } from "../errors/authentication.error";
import type { AuthenticationModuleOptions } from "../interfaces/authentication-module-options.interface";
import { AuthenticationStorage } from "../storage/authentication.storage";
import { durationOr, hasExpired } from "../utils/duration.util";
import { requireIntegerOption, requireOption } from "../utils/options.util";
import {
  CborDecodeError,
  decodeCbor,
  decodeCborPrefix,
  type CborKey,
  type CborValue,
} from "./cbor.util";
import {
  CoseKeyError,
  DEFAULT_WEBAUTHN_ALGORITHMS,
  importCosePublicKey,
  parseCosePublicKey,
  verifyCoseSignature,
} from "./cose.util";
import { InMemoryPasskeyStore } from "./in-memory-passkey.store";
import type {
  AuthenticationOptions,
  GenerateAuthenticationOptionsInput,
  GenerateRegistrationOptionsInput,
  PasskeyCredential,
  PasskeyStore,
  PublicKeyCredentialDescriptorJSON,
  RegistrationOptions,
  VerifiedAuthenticationResult,
  VerifiedRegistrationResult,
  VerifyAuthenticationInput,
  VerifyRegistrationInput,
  WebAuthnOptions,
} from "./webauthn.interface";

const FLAG_UP = 0x01; // User Present
const FLAG_UV = 0x04; // User Verified
const FLAG_BE = 0x08; // Backup Eligibility
const FLAG_BS = 0x10; // Backup State
const FLAG_AT = 0x40; // Attested Credential Data included
const FLAG_ED = 0x80; // Extension Data included

interface ParsedClientData {
  type: string;
  challenge: string;
  origin: string;
  crossOrigin?: boolean;
}

export interface ParsedAuthenticatorData {
  readonly rpIdHash: Uint8Array<ArrayBuffer>;
  readonly flags: number;
  readonly userPresent: boolean;
  readonly userVerified: boolean;
  readonly backupEligible: boolean;
  readonly backupState: boolean;
  readonly attestedCredentialDataIncluded: boolean;
  readonly extensionDataIncluded: boolean;
  readonly signCount: number;
  readonly attestedCredentialData?: {
    readonly aaguid: string;
    readonly credentialId: Uint8Array<ArrayBuffer>;
    readonly credentialPublicKeyBytes: Uint8Array<ArrayBuffer>;
    readonly credentialPublicKeyMap: Map<CborKey, CborValue>;
  };
  readonly extensions?: Map<CborKey, CborValue>;
}

function sha256Bytes(data: Uint8Array): Uint8Array<ArrayBuffer> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(data);
  const digest = hasher.digest();
  const out = new Uint8Array(digest.byteLength);
  out.set(digest);
  return out;
}

function formatAaguid(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < 16; i++) {
    hex += bytes[i]!.toString(16).padStart(2, "0");
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function normalizeOrigins(origin: string | readonly string[]): string[] {
  const list = Array.isArray(origin) ? origin : [origin];
  const normalized: string[] = [];
  for (const item of list) {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new TypeError(
        "WebAuthn: `origin` must be a non-empty origin string or array of origin strings",
      );
    }
    const trimmed = item.trim().replace(/\/+$/, "");
    normalized.push(trimmed);
  }
  if (normalized.length === 0) {
    throw new TypeError("WebAuthn: `origin` must contain at least one allowed origin");
  }
  return normalized;
}

function parseClientDataJson(rawBase64Url: string): {
  bytes: Uint8Array<ArrayBuffer>;
  data: ParsedClientData;
} {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = base64UrlDecode(rawBase64Url);
  } catch {
    throw new AuthenticationError("WebAuthn: invalid base64url clientDataJSON", {
      code: "webauthn_invalid_client_data",
    });
  }

  let json: unknown;
  try {
    json = JSON.parse(utf8Decode(bytes));
  } catch {
    throw new AuthenticationError("WebAuthn: malformed clientDataJSON payload", {
      code: "webauthn_invalid_client_data",
    });
  }

  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new AuthenticationError("WebAuthn: clientDataJSON must be a JSON object", {
      code: "webauthn_invalid_client_data",
    });
  }

  const record = json as Record<string, unknown>;
  if (
    typeof record.type !== "string" ||
    typeof record.challenge !== "string" ||
    typeof record.origin !== "string"
  ) {
    throw new AuthenticationError(
      "WebAuthn: clientDataJSON missing required type, challenge, or origin fields",
      { code: "webauthn_invalid_client_data" },
    );
  }

  return {
    bytes,
    data: {
      type: record.type,
      challenge: record.challenge,
      origin: record.origin,
      crossOrigin:
        typeof record.crossOrigin === "boolean"
          ? record.crossOrigin
          : undefined,
    },
  };
}

/**
 * Parses raw WebAuthn `authenticatorData` bytes according to WebAuthn Level 2/3 §6.1.
 */
export function parseAuthenticatorData(
  authData: Uint8Array,
): ParsedAuthenticatorData {
  if (!(authData instanceof Uint8Array) || authData.byteLength < 37) {
    throw new AuthenticationError(
      "WebAuthn: authenticatorData must be at least 37 bytes",
      { code: "webauthn_invalid_auth_data" },
    );
  }

  const view = new DataView(
    authData.buffer,
    authData.byteOffset,
    authData.byteLength,
  );
  const rpIdHash = new Uint8Array(32);
  rpIdHash.set(authData.subarray(0, 32));

  const flags = authData[32]!;
  const signCount = view.getUint32(33, false);

  const userPresent = (flags & FLAG_UP) !== 0;
  const userVerified = (flags & FLAG_UV) !== 0;
  const backupEligible = (flags & FLAG_BE) !== 0;
  const backupState = (flags & FLAG_BS) !== 0;
  const attestedCredentialDataIncluded = (flags & FLAG_AT) !== 0;
  const extensionDataIncluded = (flags & FLAG_ED) !== 0;

  let offset = 37;
  let attestedCredentialData: ParsedAuthenticatorData["attestedCredentialData"];

  if (attestedCredentialDataIncluded) {
    if (authData.byteLength < offset + 18) {
      throw new AuthenticationError(
        "WebAuthn: truncated attestedCredentialData header in authenticatorData",
        { code: "webauthn_invalid_auth_data" },
      );
    }
    const aaguid = formatAaguid(authData.subarray(offset, offset + 16));
    offset += 16;

    const credIdLen = view.getUint16(offset, false);
    offset += 2;
    if (credIdLen === 0 || credIdLen > 1023 || offset + credIdLen >= authData.byteLength) {
      throw new AuthenticationError(
        "WebAuthn: invalid credentialIdLength in attestedCredentialData",
        { code: "webauthn_invalid_auth_data" },
      );
    }

    const credentialId = new Uint8Array(credIdLen);
    credentialId.set(authData.subarray(offset, offset + credIdLen));
    offset += credIdLen;

    let decodedKey: { value: CborValue; bytesRead: number };
    try {
      decodedKey = decodeCborPrefix(authData, offset);
    } catch (err) {
      throw new AuthenticationError(
        `WebAuthn: malformed COSE public key CBOR: ${err instanceof Error ? err.message : String(err)}`,
        { code: "webauthn_invalid_cose_key" },
      );
    }

    if (!(decodedKey.value instanceof Map)) {
      throw new AuthenticationError(
        "WebAuthn: credentialPublicKey must be a CBOR map",
        { code: "webauthn_invalid_cose_key" },
      );
    }

    const credentialPublicKeyBytes = new Uint8Array(decodedKey.bytesRead);
    credentialPublicKeyBytes.set(
      authData.subarray(offset, offset + decodedKey.bytesRead),
    );
    offset += decodedKey.bytesRead;

    attestedCredentialData = {
      aaguid,
      credentialId,
      credentialPublicKeyBytes,
      credentialPublicKeyMap: decodedKey.value,
    };
  }

  let extensions: Map<CborKey, CborValue> | undefined;
  if (extensionDataIncluded) {
    if (offset >= authData.byteLength) {
      throw new AuthenticationError(
        "WebAuthn: ED flag set but no extension data present",
        { code: "webauthn_invalid_auth_data" },
      );
    }
    let decodedExt: { value: CborValue; bytesRead: number };
    try {
      decodedExt = decodeCborPrefix(authData, offset);
    } catch (err) {
      throw new AuthenticationError(
        `WebAuthn: malformed extension CBOR in authenticatorData: ${err instanceof Error ? err.message : String(err)}`,
        { code: "webauthn_invalid_auth_data" },
      );
    }
    if (!(decodedExt.value instanceof Map)) {
      throw new AuthenticationError(
        "WebAuthn: authenticatorData extensions must be a CBOR map",
        { code: "webauthn_invalid_auth_data" },
      );
    }
    extensions = decodedExt.value;
    offset += decodedExt.bytesRead;
  }

  if (offset !== authData.byteLength) {
    throw new AuthenticationError(
      `WebAuthn: unexpected trailing bytes in authenticatorData (${authData.byteLength - offset} byte(s))`,
      { code: "webauthn_invalid_auth_data" },
    );
  }

  return {
    rpIdHash,
    flags,
    userPresent,
    userVerified,
    backupEligible,
    backupState,
    attestedCredentialDataIncluded,
    extensionDataIncluded,
    signCount,
    ...(attestedCredentialData ? { attestedCredentialData } : {}),
    ...(extensions ? { extensions } : {}),
  };
}

/**
 * Native WebAuthn / FIDO2 Passkeys service using pure-TypeScript CBOR/COSE
 * parsing and WebCrypto (`crypto.subtle`) signature verification (`ES256`,
 * `RS256`, `Ed25519`), single-use TTL challenges, origin & RP ID hash checks,
 * UP/UV flag enforcement, and monotonic `signCount` replay protection.
 */
@Injectable()
export class WebAuthnService {
  private readonly options?: WebAuthnOptions;
  private readonly challengeTtlMs: number;
  private readonly allowedOrigins: readonly string[];
  private readonly supportedAlgorithms: readonly number[];

  constructor(
    private readonly storage: AuthenticationStorage,
    @Optional()
    @Inject(AUTHENTICATION_MODULE_OPTIONS)
    options?: AuthenticationModuleOptions,
  ) {
    this.options = options?.webauthn;
    this.challengeTtlMs = durationOr(this.options?.challengeTtl, "5m");

    if (!this.options) {
      this.allowedOrigins = [];
      this.supportedAlgorithms = [...DEFAULT_WEBAUTHN_ALGORITHMS];
      return;
    }

    requireOption(this.options.rpId, "webauthn.rpId", "Relying Party ID");
    requireOption(this.options.rpName, "webauthn.rpName", "Relying Party name");
    this.allowedOrigins = normalizeOrigins(this.options.origin);
    requireIntegerOption(this.options.timeout, "webauthn.timeout", {
      min: 1_000,
    });
    this.supportedAlgorithms =
      this.options.supportedAlgorithms &&
      this.options.supportedAlgorithms.length > 0
        ? [...this.options.supportedAlgorithms]
        : [...DEFAULT_WEBAUTHN_ALGORITHMS];
  }

  /**
   * Convenience factory for standalone usage outside `AuthenticationModule` DI.
   */
  static create(
    options: WebAuthnOptions,
    store: PasskeyStore = new InMemoryPasskeyStore(),
  ): WebAuthnService {
    const storage = new AuthenticationStorage();
    storage.registerSource({ passkeys: store }, { replace: true });
    return new WebAuthnService(storage, { webauthn: options });
  }

  /**
   * Generates WebAuthn registration options (`PublicKeyCredentialCreationOptionsJSON`)
   * and persists a single-use challenge with TTL in `PasskeyStore`.
   */
  async generateRegistrationOptions(
    input: GenerateRegistrationOptionsInput,
  ): Promise<RegistrationOptions> {
    const opts = this.requireConfigured();
    if (!input.userId || !input.userName) {
      throw new TypeError(
        "WebAuthnService.generateRegistrationOptions(): `userId` and `userName` are required",
      );
    }

    const challenge = base64UrlEncode(randomBytes(32));
    const createdAt = new Date(this.now());
    const expiresAt = new Date(createdAt.getTime() + this.challengeTtlMs);

    await this.store.savePasskeyChallenge({
      challenge,
      type: "registration",
      userId: input.userId,
      createdAt,
      expiresAt,
    });

    const excludeMap = new Map<string, PublicKeyCredentialDescriptorJSON>();
    if (input.excludeExistingCredentials !== false) {
      const existing = await this.store.listUserPasskeys(input.userId);
      for (const cred of existing) {
        excludeMap.set(cred.id, {
          type: "public-key",
          id: cred.id,
          ...(cred.transports ? { transports: [...cred.transports] } : {}),
        });
      }
    }
    if (input.excludeCredentials) {
      for (const descriptor of input.excludeCredentials) {
        excludeMap.set(descriptor.id, { ...descriptor });
      }
    }

    const authenticatorSelection =
      input.authenticatorSelection ?? opts.authenticatorSelection;

    return {
      challenge,
      rp: {
        id: opts.rpId,
        name: input.rpName ?? opts.rpName,
      },
      user: {
        id: base64UrlEncode(utf8Encode(input.userId)),
        name: input.userName,
        displayName: input.userDisplayName ?? input.userName,
      },
      pubKeyCredParams: this.supportedAlgorithms.map((alg) => ({
        type: "public-key" as const,
        alg,
      })),
      timeout: input.timeout ?? opts.timeout ?? 60_000,
      attestation: input.attestation ?? opts.attestation ?? "none",
      excludeCredentials: [...excludeMap.values()],
      ...(authenticatorSelection ? { authenticatorSelection } : {}),
    };
  }

  /**
   * Verifies a WebAuthn registration attestation response, validates challenge
   * (single-use + TTL + user binding), origin allowlist, `rpIdHash`, UP/UV flags,
   * COSE public key, and persists the new `PasskeyCredential`.
   */
  async verifyRegistration(
    input: VerifyRegistrationInput,
  ): Promise<VerifiedRegistrationResult> {
    const opts = this.requireConfigured();
    if (!input.userId) {
      throw new AuthenticationError("WebAuthn: userId is required for registration", {
        code: "webauthn_missing_user",
      });
    }

    // 1. Parse and verify clientDataJSON
    const { bytes: clientDataBytes, data: clientData } = parseClientDataJson(
      input.response.clientDataJSON,
    );

    if (clientData.type !== "webauthn.create") {
      throw new AuthenticationError(
        `WebAuthn: expected clientDataJSON.type "webauthn.create", got "${clientData.type}"`,
        { code: "webauthn_invalid_type" },
      );
    }

    if (clientData.crossOrigin === true) {
      throw new AuthenticationError(
        "WebAuthn: cross-origin registration ceremonies are not permitted",
        { code: "webauthn_cross_origin" },
      );
    }

    if (
      input.expectedChallenge !== undefined &&
      !timingSafeEqualString(clientData.challenge, input.expectedChallenge)
    ) {
      throw new AuthenticationError("WebAuthn: registration challenge mismatch", {
        code: "webauthn_invalid_challenge",
      });
    }

    // 2. Consume single-use challenge from store
    const challengeRecord = await this.store.consumePasskeyChallenge(
      clientData.challenge,
      "registration",
    );
    if (!challengeRecord) {
      throw new AuthenticationError(
        "WebAuthn: registration challenge is unknown or has already been used",
        { code: "webauthn_invalid_challenge" },
      );
    }
    if (hasExpired(challengeRecord.expiresAt, this.now())) {
      throw new AuthenticationError("WebAuthn: registration challenge has expired", {
        code: "webauthn_challenge_expired",
      });
    }
    if (challengeRecord.userId !== input.userId) {
      throw new AuthenticationError(
        "WebAuthn: registration challenge does not belong to this user",
        { code: "webauthn_challenge_user_mismatch" },
      );
    }

    // 3. Verify origin against exact allowlist
    const allowedOrigins = input.expectedOrigin
      ? normalizeOrigins(input.expectedOrigin)
      : this.allowedOrigins;
    if (!allowedOrigins.includes(clientData.origin)) {
      throw new AuthenticationError(
        `WebAuthn: unexpected origin "${clientData.origin}"`,
        { code: "webauthn_invalid_origin" },
      );
    }

    // 4. Decode CBOR attestationObject
    let attestationBytes: Uint8Array<ArrayBuffer>;
    try {
      attestationBytes = base64UrlDecode(input.response.attestationObject);
    } catch {
      throw new AuthenticationError(
        "WebAuthn: invalid base64url attestationObject",
        { code: "webauthn_invalid_attestation" },
      );
    }

    let attestationMap: CborValue;
    try {
      attestationMap = decodeCbor(attestationBytes);
    } catch (err) {
      const msg =
        err instanceof CborDecodeError ? err.message : "malformed CBOR";
      throw new AuthenticationError(
        `WebAuthn: invalid attestationObject CBOR (${msg})`,
        { code: "webauthn_invalid_attestation" },
      );
    }

    if (!(attestationMap instanceof Map)) {
      throw new AuthenticationError(
        "WebAuthn: attestationObject must be a CBOR map",
        { code: "webauthn_invalid_attestation" },
      );
    }

    const fmt = attestationMap.get("fmt");
    const authDataRaw = attestationMap.get("authData");
    const attStmt = attestationMap.get("attStmt");

    if (typeof fmt !== "string" || !(authDataRaw instanceof Uint8Array)) {
      throw new AuthenticationError(
        "WebAuthn: attestationObject missing required fmt or authData",
        { code: "webauthn_invalid_attestation" },
      );
    }
    if (!(attStmt instanceof Map)) {
      throw new AuthenticationError(
        "WebAuthn: attestationObject attStmt must be a CBOR map",
        { code: "webauthn_invalid_attestation" },
      );
    }
    if (fmt === "none" && attStmt.size > 0) {
      throw new AuthenticationError(
        'WebAuthn: attestation fmt "none" must have an empty attStmt map',
        { code: "webauthn_invalid_attestation" },
      );
    }

    // 5. Parse authenticatorData and verify rpIdHash, UP, UV, AT
    const parsedAuthData = parseAuthenticatorData(authDataRaw);
    const expectedRpId = input.expectedRpId ?? opts.rpId;
    const expectedRpIdHash = sha256Bytes(utf8Encode(expectedRpId));
    if (!timingSafeEqualBytes(parsedAuthData.rpIdHash, expectedRpIdHash)) {
      throw new AuthenticationError("WebAuthn: rpIdHash mismatch", {
        code: "webauthn_invalid_rpid",
      });
    }

    if (!parsedAuthData.userPresent) {
      throw new AuthenticationError(
        "WebAuthn: User Present (UP) flag must be set",
        { code: "webauthn_user_not_present" },
      );
    }

    const requireUv =
      input.requireUserVerification ??
      (opts.authenticatorSelection?.userVerification === "required" ||
        opts.userVerification === "required");
    if (requireUv && !parsedAuthData.userVerified) {
      throw new AuthenticationError(
        "WebAuthn: User Verified (UV) flag is required",
        { code: "webauthn_user_verification_required" },
      );
    }

    const attested = parsedAuthData.attestedCredentialData;
    if (!attested) {
      throw new AuthenticationError(
        "WebAuthn: registration authenticatorData missing attestedCredentialData",
        { code: "webauthn_missing_credential_data" },
      );
    }

    const credentialId = base64UrlEncode(attested.credentialId);
    const suppliedId = input.id ?? input.response.id;
    const suppliedRawId = input.rawId ?? input.response.rawId;
    if (suppliedId !== undefined && suppliedId !== credentialId) {
      throw new AuthenticationError(
        "WebAuthn: response credential id does not match attestedCredentialData",
        { code: "webauthn_credential_id_mismatch" },
      );
    }
    if (suppliedRawId !== undefined && suppliedRawId !== credentialId) {
      throw new AuthenticationError(
        "WebAuthn: response rawId does not match attestedCredentialData",
        { code: "webauthn_credential_id_mismatch" },
      );
    }

    // Prevent overwriting an already-registered credential ID
    const existingCred = await this.store.getPasskey(credentialId);
    if (existingCred) {
      throw new AuthenticationError(
        "WebAuthn: credential ID is already registered",
        { code: "webauthn_credential_exists" },
      );
    }

    // 6. Parse and validate COSE public key via crypto.subtle
    let coseKey;
    try {
      coseKey = parseCosePublicKey(attested.credentialPublicKeyMap);
    } catch (err) {
      throw new AuthenticationError(
        `WebAuthn: ${err instanceof CoseKeyError ? err.message : "invalid COSE public key"}`,
        { code: "webauthn_invalid_cose_key" },
      );
    }

    if (!this.supportedAlgorithms.includes(coseKey.algorithm)) {
      throw new AuthenticationError(
        `WebAuthn: COSE algorithm ${coseKey.algorithm} is not allowed by configuration`,
        { code: "webauthn_unsupported_algorithm" },
      );
    }

    try {
      await importCosePublicKey(coseKey);
    } catch (err) {
      throw new AuthenticationError(
        `WebAuthn: public key failed WebCrypto import (${err instanceof Error ? err.message : String(err)})`,
        { code: "webauthn_invalid_cose_key" },
      );
    }

    // 7. Verify packed self-attestation signature when present without x5c
    if (fmt === "packed" && !attStmt.has("x5c") && attStmt.has("sig")) {
      const attAlg = attStmt.get("alg");
      const attSig = attStmt.get("sig");
      if (attAlg !== coseKey.algorithm || !(attSig instanceof Uint8Array)) {
        throw new AuthenticationError(
          "WebAuthn: invalid packed self-attestation statement",
          { code: "webauthn_invalid_attestation" },
        );
      }
      const clientDataHash = sha256Bytes(clientDataBytes);
      const signed = new Uint8Array(
        authDataRaw.byteLength + clientDataHash.byteLength,
      );
      signed.set(authDataRaw, 0);
      signed.set(clientDataHash, authDataRaw.byteLength);

      let validSelfAtt = false;
      try {
        validSelfAtt = await verifyCoseSignature(coseKey, signed, attSig);
      } catch {
        validSelfAtt = false;
      }
      if (!validSelfAtt) {
        throw new AuthenticationError(
          "WebAuthn: packed self-attestation signature verification failed",
          { code: "webauthn_invalid_signature" },
        );
      }
    }

    // 8. Persist passkey credential
    const credential: PasskeyCredential = {
      id: credentialId,
      userId: input.userId,
      publicKey: base64UrlEncode(attested.credentialPublicKeyBytes),
      algorithm: coseKey.algorithm,
      counter: parsedAuthData.signCount,
      deviceType: parsedAuthData.backupEligible
        ? "multiDevice"
        : "singleDevice",
      backedUp: parsedAuthData.backupState,
      aaguid: attested.aaguid,
      ...(input.response.transports
        ? { transports: [...input.response.transports] }
        : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      createdAt: new Date(this.now()),
    };

    await this.store.savePasskey(credential);

    return {
      verified: true,
      credential,
      fmt,
      userPresent: parsedAuthData.userPresent,
      userVerified: parsedAuthData.userVerified,
    };
  }

  /**
   * Generates WebAuthn authentication options (`PublicKeyCredentialRequestOptionsJSON`)
   * and persists a single-use challenge with TTL in `PasskeyStore`.
   */
  async generateAuthenticationOptions(
    input: GenerateAuthenticationOptionsInput = {},
  ): Promise<AuthenticationOptions> {
    const opts = this.requireConfigured();

    const challenge = base64UrlEncode(randomBytes(32));
    const createdAt = new Date(this.now());
    const expiresAt = new Date(createdAt.getTime() + this.challengeTtlMs);

    await this.store.savePasskeyChallenge({
      challenge,
      type: "authentication",
      ...(input.userId !== undefined ? { userId: input.userId } : {}),
      createdAt,
      expiresAt,
    });

    let allowCredentials: PublicKeyCredentialDescriptorJSON[];
    if (input.allowCredentials) {
      allowCredentials = input.allowCredentials.map((d) => ({ ...d }));
    } else if (input.userId !== undefined) {
      const creds = await this.store.listUserPasskeys(input.userId);
      allowCredentials = creds.map((cred) => ({
        type: "public-key" as const,
        id: cred.id,
        ...(cred.transports ? { transports: [...cred.transports] } : {}),
      }));
    } else {
      allowCredentials = [];
    }

    return {
      challenge,
      rpId: opts.rpId,
      timeout: input.timeout ?? opts.timeout ?? 60_000,
      userVerification:
        input.userVerification ?? opts.userVerification ?? "preferred",
      allowCredentials,
    };
  }

  /**
   * Verifies a WebAuthn authentication assertion response: consumes single-use
   * challenge, validates origin, `rpIdHash`, UP/UV flags, cryptographically verifies
   * the signature over `authData || sha256(clientDataJSON)` via `crypto.subtle`,
   * and enforces monotonic `signCount` replay protection.
   */
  async verifyAuthentication(
    input: VerifyAuthenticationInput,
  ): Promise<VerifiedAuthenticationResult> {
    const opts = this.requireConfigured();

    const credentialId = input.id ?? input.response.id;
    const rawId = input.rawId ?? input.response.rawId;
    if (!credentialId) {
      throw new AuthenticationError(
        "WebAuthn: credential id is required for authentication",
        { code: "webauthn_missing_credential_id" },
      );
    }
    if (rawId !== undefined && rawId !== credentialId) {
      throw new AuthenticationError(
        "WebAuthn: response rawId does not match credential id",
        { code: "webauthn_credential_id_mismatch" },
      );
    }

    // 1. Parse and verify clientDataJSON
    const { bytes: clientDataBytes, data: clientData } = parseClientDataJson(
      input.response.clientDataJSON,
    );

    if (clientData.type !== "webauthn.get") {
      throw new AuthenticationError(
        `WebAuthn: expected clientDataJSON.type "webauthn.get", got "${clientData.type}"`,
        { code: "webauthn_invalid_type" },
      );
    }

    if (clientData.crossOrigin === true) {
      throw new AuthenticationError(
        "WebAuthn: cross-origin authentication ceremonies are not permitted",
        { code: "webauthn_cross_origin" },
      );
    }

    if (
      input.expectedChallenge !== undefined &&
      !timingSafeEqualString(clientData.challenge, input.expectedChallenge)
    ) {
      throw new AuthenticationError(
        "WebAuthn: authentication challenge mismatch",
        { code: "webauthn_invalid_challenge" },
      );
    }

    // 2. Consume single-use challenge
    const challengeRecord = await this.store.consumePasskeyChallenge(
      clientData.challenge,
      "authentication",
    );
    if (!challengeRecord) {
      throw new AuthenticationError(
        "WebAuthn: authentication challenge is unknown or has already been used",
        { code: "webauthn_invalid_challenge" },
      );
    }
    if (hasExpired(challengeRecord.expiresAt, this.now())) {
      throw new AuthenticationError(
        "WebAuthn: authentication challenge has expired",
        { code: "webauthn_challenge_expired" },
      );
    }

    // 3. Verify origin against exact allowlist
    const allowedOrigins = input.expectedOrigin
      ? normalizeOrigins(input.expectedOrigin)
      : this.allowedOrigins;
    if (!allowedOrigins.includes(clientData.origin)) {
      throw new AuthenticationError(
        `WebAuthn: unexpected origin "${clientData.origin}"`,
        { code: "webauthn_invalid_origin" },
      );
    }

    // 4. Fetch stored credential and verify ownership
    const credential = await this.store.getPasskey(credentialId);
    if (!credential) {
      throw new AuthenticationError("WebAuthn: unknown passkey credential", {
        code: "webauthn_unknown_credential",
      });
    }
    if (input.userId !== undefined && credential.userId !== input.userId) {
      throw new AuthenticationError(
        "WebAuthn: passkey credential does not belong to this user",
        { code: "webauthn_credential_user_mismatch" },
      );
    }
    if (
      challengeRecord.userId !== undefined &&
      credential.userId !== challengeRecord.userId
    ) {
      throw new AuthenticationError(
        "WebAuthn: passkey credential does not match challenge user",
        { code: "webauthn_challenge_user_mismatch" },
      );
    }
    if (
      typeof input.response.userHandle === "string" &&
      input.response.userHandle.length > 0
    ) {
      let decodedHandle: string;
      try {
        decodedHandle = utf8Decode(base64UrlDecode(input.response.userHandle));
      } catch {
        throw new AuthenticationError(
          "WebAuthn: invalid userHandle encoding",
          { code: "webauthn_invalid_user_handle" },
        );
      }
      if (decodedHandle !== credential.userId) {
        throw new AuthenticationError(
          "WebAuthn: userHandle does not match credential owner",
          { code: "webauthn_credential_user_mismatch" },
        );
      }
    }

    // 5. Parse authenticatorData and verify rpIdHash, UP, UV
    let authDataBytes: Uint8Array<ArrayBuffer>;
    try {
      authDataBytes = base64UrlDecode(input.response.authenticatorData);
    } catch {
      throw new AuthenticationError(
        "WebAuthn: invalid base64url authenticatorData",
        { code: "webauthn_invalid_auth_data" },
      );
    }

    const parsedAuthData = parseAuthenticatorData(authDataBytes);
    const expectedRpId = input.expectedRpId ?? opts.rpId;
    const expectedRpIdHash = sha256Bytes(utf8Encode(expectedRpId));
    if (!timingSafeEqualBytes(parsedAuthData.rpIdHash, expectedRpIdHash)) {
      throw new AuthenticationError("WebAuthn: rpIdHash mismatch", {
        code: "webauthn_invalid_rpid",
      });
    }

    if (!parsedAuthData.userPresent) {
      throw new AuthenticationError(
        "WebAuthn: User Present (UP) flag must be set",
        { code: "webauthn_user_not_present" },
      );
    }

    const requireUv =
      input.requireUserVerification ?? opts.userVerification === "required";
    if (requireUv && !parsedAuthData.userVerified) {
      throw new AuthenticationError(
        "WebAuthn: User Verified (UV) flag is required",
        { code: "webauthn_user_verification_required" },
      );
    }

    // 6. Cryptographically verify signature over authData || sha256(clientDataJSON)
    let signatureBytes: Uint8Array<ArrayBuffer>;
    try {
      signatureBytes = base64UrlDecode(input.response.signature);
    } catch {
      throw new AuthenticationError("WebAuthn: invalid base64url signature", {
        code: "webauthn_invalid_signature",
      });
    }

    let publicKeyBytes: Uint8Array<ArrayBuffer>;
    let coseKey;
    try {
      publicKeyBytes = base64UrlDecode(credential.publicKey);
      coseKey = parseCosePublicKey(publicKeyBytes);
    } catch (err) {
      throw new AuthenticationError(
        `WebAuthn: stored COSE public key is invalid (${err instanceof Error ? err.message : String(err)})`,
        { code: "webauthn_invalid_cose_key" },
      );
    }

    const clientDataHash = sha256Bytes(clientDataBytes);
    const signedData = new Uint8Array(
      authDataBytes.byteLength + clientDataHash.byteLength,
    );
    signedData.set(authDataBytes, 0);
    signedData.set(clientDataHash, authDataBytes.byteLength);

    let signatureValid = false;
    try {
      signatureValid = await verifyCoseSignature(
        coseKey,
        signedData,
        signatureBytes,
      );
    } catch {
      signatureValid = false;
    }

    if (!signatureValid) {
      throw new AuthenticationError(
        "WebAuthn: assertion signature verification failed",
        { code: "webauthn_invalid_signature" },
      );
    }

    // 7. Monotonic signCount replay protection (WebAuthn §7.2 step 21)
    const newCounter = parsedAuthData.signCount;
    const storedCounter = credential.counter;
    if ((newCounter > 0 || storedCounter > 0) && newCounter <= storedCounter) {
      throw new AuthenticationError(
        `WebAuthn: signature counter replay detected (received ${newCounter}, stored ${storedCounter})`,
        { code: "webauthn_replay_detected" },
      );
    }

    const lastUsedAt = new Date(this.now());
    const updated = await this.store.updatePasskeyCounter(
      credential.id,
      newCounter,
      lastUsedAt,
    );
    if (!updated) {
      throw new AuthenticationError(
        "WebAuthn: concurrent signature counter replay detected",
        { code: "webauthn_replay_detected" },
      );
    }

    const updatedCredential: PasskeyCredential = {
      ...credential,
      counter: newCounter,
      lastUsedAt,
    };

    return {
      verified: true,
      userId: credential.userId,
      credential: updatedCredential,
      newCounter,
      userPresent: parsedAuthData.userPresent,
      userVerified: parsedAuthData.userVerified,
    };
  }

  /** Lists registered passkeys for a user. */
  async listPasskeys(userId: string): Promise<PasskeyCredential[]> {
    this.requireConfigured();
    return this.store.listUserPasskeys(userId);
  }

  /** Deletes a single passkey by credential ID. */
  async removePasskey(credentialId: string): Promise<boolean> {
    this.requireConfigured();
    return this.store.deletePasskey(credentialId);
  }

  /** Deletes all passkeys belonging to a user. */
  async removeUserPasskeys(userId: string): Promise<void> {
    this.requireConfigured();
    return this.store.deleteUserPasskeys(userId);
  }

  private requireConfigured(): WebAuthnOptions {
    if (!this.options) {
      throw new Error(
        "WebAuthn is not configured: add `webauthn: { rpId, rpName, origin }` to the AuthenticationModule options",
      );
    }
    return this.options;
  }

  private get store(): PasskeyStore {
    return this.storage.passkeys;
  }

  private now(): number {
    return this.options?.now?.() ?? Date.now();
  }
}
