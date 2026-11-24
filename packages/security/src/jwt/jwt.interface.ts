import type {
  FactoryDependency,
  ModuleMetadata,
  Provider,
  Type,
} from "@bunest/core";

/** Structural key-object contract (compatible with Node `KeyObject` without importing `node:crypto`). */
export interface CryptoKeyObjectLike {
  readonly type: string;
  readonly asymmetricKeyType?: string;
  readonly symmetricKeySize?: number;
  export(options?: never): unknown;
}

export const JWT_MODULE_OPTIONS = Symbol.for(
  "bunest:security:jwt_module_options",
);

export enum JwtSecretRequestType {
  SIGN = 0,
  VERIFY = 1,
}

export type JwtAlgorithm = "HS256" | "HS384" | "HS512" | "RS256" | "ES256";

export interface JwtHeader {
  alg: JwtAlgorithm;
  typ?: string;
  kid?: string;
  [key: string]: unknown;
}

export interface JwtPayload {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  iat?: number;
  jti?: string;
  [key: string]: unknown;
}

export interface DecodedJwt<T = JwtPayload> {
  header: JwtHeader;
  payload: T;
  signature: string;
}

export type JwtSecretInput = string | Uint8Array | CryptoKey;
export type JwtAsymmetricKeyInput = string | CryptoKey;

export interface JwtSecretKeyObject {
  key: string | Uint8Array;
  passphrase?: string;
}

export type GetSecretKeyResult =
  | JwtSecretInput
  | CryptoKeyObjectLike
  | JwtSecretKeyObject;

export interface JwtSignOptions {
  algorithm?: JwtAlgorithm;
  secret?: GetSecretKeyResult;
  privateKey?: JwtAsymmetricKeyInput | CryptoKeyObjectLike | JwtSecretKeyObject;
  expiresIn?: number | string;
  notBefore?: number | string;
  audience?: string | string[];
  issuer?: string;
  subject?: string;
  jwtid?: string;
  keyid?: string;
  header?: Record<string, unknown>;
  noTimestamp?: boolean;
  mutatePayload?: boolean;
  encoding?: string;
  allowInsecureKeySizes?: boolean;
  allowInvalidAsymmetricKeyTypes?: boolean;
}

export interface JwtVerifyOptions {
  algorithms?: readonly JwtAlgorithm[];
  secret?: GetSecretKeyResult;
  publicKey?: JwtAsymmetricKeyInput | CryptoKeyObjectLike | JwtSecretKeyObject;
  audience?: string | RegExp | ReadonlyArray<string | RegExp>;
  issuer?: string | readonly string[];
  subject?: string;
  jwtid?: string;
  clockTolerance?: number;
  clockTimestamp?: number;
  ignoreExpiration?: boolean;
  ignoreNotBefore?: boolean;
  currentDate?: Date;
  complete?: boolean;
  maxAge?: string | number;
  nonce?: string;
  allowInvalidAsymmetricKeyTypes?: boolean;
}

export interface JwtModuleOptions {
  secret?: GetSecretKeyResult;
  publicKey?: JwtAsymmetricKeyInput | CryptoKeyObjectLike | JwtSecretKeyObject;
  privateKey?: JwtAsymmetricKeyInput | CryptoKeyObjectLike | JwtSecretKeyObject;
  /** @deprecated Prefer explicit `secret`, `privateKey`/`publicKey`, or `secretOrKeyProvider`. */
  secretOrPrivateKey?: GetSecretKeyResult;
  secretOrKeyProvider?: (
    requestType: JwtSecretRequestType,
    tokenOrPayload: string | object | Uint8Array,
    options?: JwtVerifyOptions | JwtSignOptions,
  ) => GetSecretKeyResult | Promise<GetSecretKeyResult>;
  signOptions?: JwtSignOptions;
  verifyOptions?: JwtVerifyOptions;
  global?: boolean;
}

export interface JwtOptionsFactory {
  createJwtOptions(): Promise<JwtModuleOptions> | JwtModuleOptions;
}

export interface JwtModuleAsyncOptions {
  imports?: ModuleMetadata["imports"];
  useExisting?: Type<JwtOptionsFactory>;
  useClass?: Type<JwtOptionsFactory>;
  useFactory?: (...args: any[]) => JwtModuleOptions | Promise<JwtModuleOptions>;
  inject?: FactoryDependency[];
  extraProviders?: Provider[];
  global?: boolean;
}
