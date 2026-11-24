import type { Duration } from "../interfaces/duration.interface";
import type { JwsAlgorithm, JwtClaims } from "../interfaces/jwt.interface";
import type { JwtSignerOptions } from "../interfaces/jwt-options.interface";
import { randomToken } from "../utils/crypto.util";
import { durationOr, toMs } from "../utils/duration.util";
import {
  algorithmFor,
  assertSigningKey,
  type JwsKey,
  signJws,
  toKeyObject,
  unsupportedKeyError,
  warnShortSecret,
} from "./jws.util";

/**
 * Issues signed JWTs using WebCrypto (`crypto.subtle`) and `Bun.CryptoHasher`.
 * Adds `iat`, `exp`, `jti` and the configured `iss`/`aud`.
 */
export class JwtSigner {
  private readonly options: JwtSignerOptions;
  private readonly key: JwsKey;
  private readonly alg: JwsAlgorithm;

  constructor(options: JwtSignerOptions) {
    this.options = options;
    this.key = toKeyObject(options.key);
    const alg = options.alg ?? algorithmFor(this.key);
    if (!alg) {
      throw unsupportedKeyError(this.key, "JwtSigner");
    }
    assertSigningKey(alg, this.key, "JwtSigner", {
      allowShortSecret: options.allowShortSecret,
    });
    if (options.allowShortSecret) {
      warnShortSecret(alg, this.key, "JwtSigner");
    }
    this.alg = alg;
    toMs(options.ttl ?? 0);
  }

  async sign(
    claims: JwtClaims,
    { ttl }: { ttl?: Duration } = {},
  ): Promise<string> {
    const iat = Math.floor((this.options.now?.() ?? Date.now()) / 1000);
    const lifetime = Math.floor(
      durationOr(ttl ?? this.options.ttl, "15m") / 1000,
    );
    const payload: JwtClaims = {
      ...(this.options.issuer !== undefined && { iss: this.options.issuer }),
      ...(this.options.audience !== undefined && {
        aud: this.options.audience,
      }),
      jti: randomToken(16),
      ...claims,
      iat,
      exp: iat + lifetime,
    };
    return signJws(
      {
        alg: this.alg,
        typ: this.options.type ?? "JWT",
        ...(this.options.kid ? { kid: this.options.kid } : {}),
      },
      payload,
      this.key,
      { allowShortSecret: this.options.allowShortSecret },
    );
  }
}
