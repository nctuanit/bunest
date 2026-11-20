import type { KeyObject } from "node:crypto";
import type { JwksClient } from "../jwt/jwks.client";
import type { Duration } from "./duration.interface";
import type { JwksClientOptions } from "./jwks-client-options.interface";
import type { ClaimRules, JwsAlgorithm } from "./jwt.interface";

export type { JwksClientOptions };

export interface JwtVerifierOptions extends ClaimRules {
  key?: KeyObject | string | Buffer;
  jwks?: string | JwksClient;
  algorithms?: JwsAlgorithm[];
  type?: string;
  allowShortSecret?: boolean;
}

export interface JwtSignerOptions {
  key: KeyObject | string | Buffer;
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
