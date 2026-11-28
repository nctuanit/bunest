import {
  randomToken,
  timingSafeEqualString,
} from "../utils/crypto.util";

export type PkceCodeChallengeMethod = "S256";

export interface PkcePair {
  readonly codeVerifier: string;
  readonly codeChallenge: string;
  readonly codeChallengeMethod: PkceCodeChallengeMethod;
}

const RFC7636_VERIFIER_REGEX = /^[A-Za-z0-9\-._~]{43,128}$/;

/**
 * Generates a cryptographically random OAuth2 `state` parameter (base64url).
 * Defaults to 32 random bytes (256 bits of entropy).
 */
export function generateState(byteLength = 32): string {
  if (!Number.isInteger(byteLength) || byteLength < 16 || byteLength > 128) {
    throw new Error(
      `OAuth2 state byteLength must be an integer between 16 and 128 (received ${byteLength})`,
    );
  }
  return randomToken(byteLength);
}

/**
 * Generates a cryptographically random OIDC `nonce` parameter (base64url).
 * Defaults to 32 random bytes (256 bits of entropy).
 */
export function generateNonce(byteLength = 32): string {
  if (!Number.isInteger(byteLength) || byteLength < 16 || byteLength > 128) {
    throw new Error(
      `OIDC nonce byteLength must be an integer between 16 and 128 (received ${byteLength})`,
    );
  }
  return randomToken(byteLength);
}

/**
 * Validates that a PKCE `code_verifier` complies with RFC 7636 §4.1
 * (43..128 unreserved ASCII characters).
 */
export function isValidPkceVerifier(codeVerifier: string): boolean {
  return (
    typeof codeVerifier === "string" &&
    RFC7636_VERIFIER_REGEX.test(codeVerifier)
  );
}

/**
 * Synchronously computes an RFC 7636 `S256` PKCE `code_challenge` from a
 * `code_verifier` using Bun's Zig-native `Bun.CryptoHasher`
 * (`BASE64URL(SHA256(ASCII(code_verifier)))`).
 */
export function computePkceChallengeSync(codeVerifier: string): string {
  if (!isValidPkceVerifier(codeVerifier)) {
    throw new Error(
      "Invalid PKCE code_verifier: must be 43-128 characters from [A-Za-z0-9-._~]",
    );
  }
  return Bun.CryptoHasher.hash("sha256", codeVerifier, "base64url");
}

/**
 * Computes an RFC 7636 `S256` PKCE `code_challenge` from a `code_verifier`
 * using Bun's Zig-native `Bun.CryptoHasher` (`BASE64URL(SHA256(ASCII(code_verifier)))`).
 */
export async function computePkceChallenge(
  codeVerifier: string,
): Promise<string> {
  return computePkceChallengeSync(codeVerifier);
}

/**
 * Generates a cryptographically random PKCE `codeVerifier` and its SHA-256
 * base64url `codeChallenge` (`S256`) per RFC 7636.
 *
 * `byteLength` must be between 32 (43 chars) and 96 (128 chars). Defaults to 32.
 */
export async function generatePkcePair(byteLength = 32): Promise<PkcePair> {
  if (!Number.isInteger(byteLength) || byteLength < 32 || byteLength > 96) {
    throw new Error(
      `PKCE byteLength must be an integer between 32 and 96 (received ${byteLength})`,
    );
  }
  const codeVerifier = randomToken(byteLength);
  const codeChallenge = await computePkceChallenge(codeVerifier);
  return {
    codeVerifier,
    codeChallenge,
    codeChallengeMethod: "S256",
  };
}

/**
 * Verifies a PKCE `codeVerifier` against an expected `S256` `codeChallenge`
 * using constant-time string comparison.
 */
export async function verifyPkceChallenge(
  codeVerifier: string,
  expectedChallenge: string,
): Promise<boolean> {
  if (
    !isValidPkceVerifier(codeVerifier) ||
    typeof expectedChallenge !== "string" ||
    expectedChallenge.length === 0
  ) {
    return false;
  }
  const actualChallenge = await computePkceChallenge(codeVerifier);
  return timingSafeEqualString(actualChallenge, expectedChallenge);
}
