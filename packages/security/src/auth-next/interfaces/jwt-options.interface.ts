import type { JwksClient } from "../jwt/jwks.client";
import type { JwsKey } from "../jwt/jws.util";
import type { Duration } from "./duration.interface";
import type { JwksClientOptions } from "./jwks-client-options.interface";
import type { ClaimRules, JwsAlgorithm } from "./jwt.interface";

export type { JwksClientOptions };

/** Structural key-object contract (compatible with Node `KeyObject` without importing `node:crypto`). */
export interface JwsKeyObjectLike {
  readonly type: string;
  readonly asymmetricKeyType?: string;
  readonly asymmetricKeyDetails?: {
    readonly modulusLength?: number;
    readonly namedCurve?: string;
  };
  readonly symmetricKeySize?: number;
  export(options?: never): unknown;
}

export type JwsKeyInput =
  | JwsKey
  | CryptoKey
  | JwsKeyObjectLike
  | string
  | Uint8Array;

export interface JwtVerifierOptions extends ClaimRules {
  key?: JwsKeyInput;
  jwks?: string | JwksClient;
  algorithms?: JwsAlgorithm[];
  type?: string;
  allowShortSecret?: boolean;
}

export interface JwtSignerOptions {
  key: JwsKeyInput;
  alg?: JwsAlgorithm;
  kid?: string;
  issuer?: string;
  audience?: string | string[];
  ttl?: Duration;
  type?: string;
  now?: () => number;
  allowShortSecret?: boolean;
}

export interface JwtBearerProviderOptions extends JwtVerifierOptions {
  /** `realm` in the `WWW-Authenticate` challenge. Default `api`. */
  realm?: string;
}
