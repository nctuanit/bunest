import type { Duration } from "../interfaces/duration.interface";

export type AuthenticatorTransport =
  | "usb"
  | "nfc"
  | "ble"
  | "smart-card"
  | "hybrid"
  | "internal";

export type UserVerificationRequirement =
  | "required"
  | "preferred"
  | "discouraged";

export type ResidentKeyRequirement = "discouraged" | "preferred" | "required";

export type AttestationConveyancePreference =
  | "none"
  | "indirect"
  | "direct"
  | "enterprise";

export type AuthenticatorAttachment = "platform" | "cross-platform";

export type PasskeyDeviceType = "singleDevice" | "multiDevice";

export type PasskeyChallengeType = "registration" | "authentication";

/** Supported COSE algorithm identifiers: ES256 (-7), RS256 (-257), EdDSA/Ed25519 (-8). */
export type CoseAlgorithmIdentifier = -7 | -257 | -8;

export interface PublicKeyCredentialDescriptorJSON {
  type: "public-key";
  /** Base64url-encoded credential ID. */
  id: string;
  transports?: AuthenticatorTransport[];
}

export interface PasskeyCredential {
  /** Base64url-encoded credential ID. */
  id: string;
  /** Owning user ID. */
  userId: string;
  /** Base64url-encoded CBOR COSE_Key public key bytes. */
  publicKey: string;
  /** COSE algorithm identifier (-7 ES256, -257 RS256, -8 Ed25519). */
  algorithm: number;
  /** Monotonic signature counter (uint32) from authenticatorData. */
  counter: number;
  /** Authenticator transports reported during registration. */
  transports?: AuthenticatorTransport[];
  /** Device backup eligibility derived from BE flag. */
  deviceType?: PasskeyDeviceType;
  /** Current backup state derived from BS flag. */
  backedUp?: boolean;
  /** Authenticator AAGUID formatted as a canonical UUID string. */
  aaguid?: string;
  /** Optional user-facing credential label (e.g. "MacBook Touch ID"). */
  name?: string;
  createdAt: Date;
  lastUsedAt?: Date;
}

export interface PasskeyChallengeRecord {
  /** Base64url-encoded challenge string. */
  challenge: string;
  type: PasskeyChallengeType;
  /** Associated user ID (set for registration, optional for discoverable authentication). */
  userId?: string;
  createdAt: Date;
  expiresAt: Date;
}

/**
 * Storage contract for WebAuthn passkey credentials and single-use challenges.
 */
export interface PasskeyStore {
  getPasskey(credentialId: string): Promise<PasskeyCredential | undefined>;
  savePasskey(credential: PasskeyCredential): Promise<void>;
  listUserPasskeys(userId: string): Promise<PasskeyCredential[]>;
  /**
   * Atomically advances a credential's signature counter.
   *
   * Per WebAuthn §7.2:
   * - If `counter === 0`, succeeds only when the stored counter is also `0` (authenticators without counter support).
   * - If `counter > 0`, succeeds only when `counter > storedCounter` (strictly monotonic replay guard).
   */
  updatePasskeyCounter(
    credentialId: string,
    counter: number,
    lastUsedAt?: Date,
  ): Promise<boolean>;
  deletePasskey(credentialId: string): Promise<boolean>;
  deleteUserPasskeys(userId: string): Promise<void>;
  savePasskeyChallenge(record: PasskeyChallengeRecord): Promise<void>;
  /**
   * Atomically retrieves and deletes a pending challenge matching `challenge` and `type`.
   * Returns `undefined` when unknown, already consumed, or wrong `type`.
   */
  consumePasskeyChallenge(
    challenge: string,
    type: PasskeyChallengeType,
  ): Promise<PasskeyChallengeRecord | undefined>;
}

export interface AuthenticatorSelectionCriteria {
  authenticatorAttachment?: AuthenticatorAttachment;
  residentKey?: ResidentKeyRequirement;
  requireResidentKey?: boolean;
  userVerification?: UserVerificationRequirement;
}

export interface WebAuthnOptions {
  /** Relying Party ID (domain name, e.g. `"example.com"` or `"localhost"`). */
  rpId: string;
  /** Human-readable Relying Party display name. */
  rpName: string;
  /** Allowed exact origin(s) for `clientDataJSON.origin` verification (e.g. `"https://example.com"`). */
  origin: string | readonly string[];
  /** Challenge TTL (number in ms or duration string). Default `"5m"`. */
  challengeTtl?: Duration;
  /** Default ceremony timeout hint in milliseconds. Default `60_000`. */
  timeout?: number;
  /** Supported COSE algorithm identifiers in preference order. Default `[-7, -257, -8]`. */
  supportedAlgorithms?: readonly number[];
  /** Default attestation conveyance preference. Default `"none"`. */
  attestation?: AttestationConveyancePreference;
  /** Default user verification requirement. Default `"preferred"`. */
  userVerification?: UserVerificationRequirement;
  /** Default authenticator selection criteria for registration ceremonies. */
  authenticatorSelection?: AuthenticatorSelectionCriteria;
  /** Optional clock source returning epoch milliseconds (for deterministic tests). */
  now?: () => number;
}

export interface GenerateRegistrationOptionsInput {
  userId: string;
  userName: string;
  userDisplayName?: string;
  rpName?: string;
  timeout?: number;
  attestation?: AttestationConveyancePreference;
  authenticatorSelection?: AuthenticatorSelectionCriteria;
  /** Whether to populate `excludeCredentials` from the user's stored passkeys. Default `true`. */
  excludeExistingCredentials?: boolean;
  /** Additional credentials to exclude from registration. */
  excludeCredentials?: PublicKeyCredentialDescriptorJSON[];
}

export interface RegistrationOptions {
  /** Base64url-encoded random challenge. */
  challenge: string;
  rp: {
    id: string;
    name: string;
  };
  user: {
    /** Base64url-encoded UTF-8 user handle. */
    id: string;
    name: string;
    displayName: string;
  };
  pubKeyCredParams: Array<{
    type: "public-key";
    alg: number;
  }>;
  timeout: number;
  attestation: AttestationConveyancePreference;
  excludeCredentials: PublicKeyCredentialDescriptorJSON[];
  authenticatorSelection?: AuthenticatorSelectionCriteria;
}

export interface VerifyRegistrationInput {
  /** User ID registering the passkey (verified against the stored challenge's userId). */
  userId: string;
  /** Optional expected challenge (when omitted, extracted from `clientDataJSON` and consumed from store). */
  expectedChallenge?: string;
  /** Optional per-call origin allowlist override. */
  expectedOrigin?: string | readonly string[];
  /** Optional per-call RP ID override. */
  expectedRpId?: string;
  /** Require UV (User Verified) flag in `authenticatorData`. */
  requireUserVerification?: boolean;
  /** Optional friendly label persisted on the credential. */
  name?: string;
  /** Optional base64url credential ID (WebAuthn JSON top-level shape). */
  id?: string;
  /** Optional base64url rawId (WebAuthn JSON top-level shape). */
  rawId?: string;
  response: {
    id?: string;
    rawId?: string;
    /** Base64url-encoded `clientDataJSON` bytes. */
    clientDataJSON: string;
    /** Base64url-encoded CBOR `attestationObject` bytes. */
    attestationObject: string;
    /** Optional authenticator transports reported by the browser. */
    transports?: AuthenticatorTransport[];
  };
}

export interface VerifiedRegistrationResult {
  verified: true;
  credential: PasskeyCredential;
  fmt: string;
  userPresent: boolean;
  userVerified: boolean;
}

export interface GenerateAuthenticationOptionsInput {
  /** Scope `allowCredentials` to this user's passkeys (omit for discoverable/usernameless sign-in). */
  userId?: string;
  timeout?: number;
  userVerification?: UserVerificationRequirement;
  allowCredentials?: PublicKeyCredentialDescriptorJSON[];
}

export interface AuthenticationOptions {
  /** Base64url-encoded random challenge. */
  challenge: string;
  rpId: string;
  timeout: number;
  userVerification: UserVerificationRequirement;
  allowCredentials: PublicKeyCredentialDescriptorJSON[];
}

export interface VerifyAuthenticationInput {
  /** Optional expected user ID (when set, verifies the credential belongs to this user). */
  userId?: string;
  /** Optional expected challenge (when omitted, extracted from `clientDataJSON` and consumed from store). */
  expectedChallenge?: string;
  /** Optional per-call origin allowlist override. */
  expectedOrigin?: string | readonly string[];
  /** Optional per-call RP ID override. */
  expectedRpId?: string;
  /** Require UV (User Verified) flag in `authenticatorData`. */
  requireUserVerification?: boolean;
  /** Base64url credential ID (can also be supplied on `response.id`). */
  id?: string;
  /** Optional base64url rawId (when present, must match `id`). */
  rawId?: string;
  response: {
    id?: string;
    rawId?: string;
    /** Base64url-encoded `clientDataJSON` bytes. */
    clientDataJSON: string;
    /** Base64url-encoded `authenticatorData` bytes. */
    authenticatorData: string;
    /** Base64url-encoded assertion signature bytes. */
    signature: string;
    /** Optional base64url-encoded userHandle. */
    userHandle?: string | null;
  };
}

export interface VerifiedAuthenticationResult {
  verified: true;
  userId: string;
  credential: PasskeyCredential;
  newCounter: number;
  userPresent: boolean;
  userVerified: boolean;
}
