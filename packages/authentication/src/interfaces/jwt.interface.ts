import type { Duration } from "./duration.interface";

/** Supported JWS algorithms (RFC 7518 §3.1). */
export type JwsAlgorithm =
  | "HS256"
  | "HS384"
  | "HS512"
  | "RS256"
  | "RS384"
  | "RS512"
  | "PS256"
  | "PS384"
  | "PS512"
  | "ES256"
  | "ES384"
  | "ES512"
  | "EdDSA";

export interface JwtClaims {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  iat?: number;
  jti?: string;
  [claim: string]: unknown;
}

export interface ClaimRules {
  issuer?: string;
  audience?: string | string[] | false;
  clockTolerance?: Duration;
  maxAge?: Duration;
  required?: string[];
  now?: () => number;
}
