import { JwtError } from "../errors/jwt.error";
import type { JwsAlgorithm, JwtClaims } from "../interfaces/jwt.interface";
import type {
  JwtSignerOptions,
  JwtVerifierOptions,
} from "../interfaces/jwt-options.interface";
import { toMs } from "../utils/duration.util";
import { JwksClient } from "./jwks.client";
import {
  algorithmFor,
  assertKeyFits,
  decodeJws,
  isHmac,
  type JwsKey,
  toKeyObject,
  unsupportedKeyError,
  validateClaims,
  verifySignature,
  warnShortSecret,
} from "./jws.util";

/**
 * Verifies compact JWS tokens and their registered claims. `verify()`
 * throws {@link JwtError}; a configuration that could not verify anything
 * throws a `TypeError` in the constructor.
 */
export class JwtVerifier {
  private readonly options: JwtVerifierOptions;
  private readonly key?: JwsKey;
  private readonly jwks?: JwksClient;
  readonly algorithms: JwsAlgorithm[];

  constructor(options: JwtVerifierOptions) {
    this.options = options;
    if (!!options.key === !!options.jwks) {
      throw new TypeError("JwtVerifier: pass exactly one of `key` or `jwks`.");
    }
    let given: JwsKey | undefined;
    if (options.key) {
      given = toKeyObject(options.key);
      this.key = given.toPublicKey();
    }
    if (options.jwks) {
      this.jwks =
        typeof options.jwks === "string"
          ? new JwksClient(options.jwks)
          : options.jwks;
    }
    if (this.key) {
      const implied = algorithmFor(this.key);
      if (!implied) {
        throw unsupportedKeyError(this.key, "JwtVerifier");
      }
      this.algorithms = options.algorithms ?? [implied];
      for (const alg of this.algorithms) {
        assertKeyFits(alg, this.key, "JwtVerifier", {
          allowShortSecret: options.allowShortSecret,
        });
        if (options.allowShortSecret) {
          warnShortSecret(alg, this.key, "JwtVerifier");
        }
      }
      if (given?.type === "public") {
        requireIssuerAndAudience(options, "public `key`");
      }
    } else {
      this.algorithms = options.algorithms ?? ["RS256", "ES256"];
      const hmac = this.algorithms.find(isHmac);
      if (hmac) {
        throw new TypeError(
          `JwtVerifier: ${hmac} cannot be combined with a JWKS.`,
        );
      }
      requireIssuerAndAudience(options, "`jwks`");
    }
    toMs(options.clockTolerance ?? 0);
    toMs(options.maxAge ?? 0);
  }

  async verify(token: string): Promise<JwtClaims> {
    const decoded = decodeJws(token);
    const { header } = decoded;
    const alg = header.alg as JwsAlgorithm;
    if (!this.algorithms.includes(alg)) {
      throw new JwtError("unsupported algorithm");
    }
    if (header.crit !== undefined) {
      throw new JwtError("unsupported critical header");
    }
    if (
      this.options.type !== undefined &&
      (typeof header.typ !== "string" ||
        mediaType(header.typ) !== mediaType(this.options.type))
    ) {
      throw new JwtError("unexpected token type");
    }
    const key = this.key ?? (await this.jwks!.getKey(header));
    await verifySignature(alg, key, decoded, {
      allowShortSecret: this.options.allowShortSecret,
    });
    validateClaims(decoded.payload, this.options);
    return decoded.payload;
  }
}

function requireIssuerAndAudience(
  options: JwtVerifierOptions,
  what: string,
): void {
  if (typeof options.issuer === "string" && options.audience !== undefined) {
    return;
  }
  throw new TypeError(
    `JwtVerifier: a ${what} verifier needs \`issuer\` and \`audience\`. An identity provider signs tokens for ` +
      "all of its clients with the same keys, so without them tokens issued to other applications verify " +
      "too. For tokens that carry no audience, pass `audience: false` and check the claim that names your " +
      "client in `validate()`.",
  );
}

function mediaType(typ: string): string {
  const lower = typ.toLowerCase();
  return lower.includes("/") ? lower : `application/${lower}`;
}

/**
 * @internal A verifier for what a `JwtSigner` with these options issues.
 */
export function verifierForSigner(
  signer: JwtSignerOptions,
  overrides: Omit<JwtVerifierOptions, "key" | "jwks"> = {},
): JwtVerifier {
  const key = toKeyObject(signer.key);
  const alg = signer.alg ?? algorithmFor(key);
  return new JwtVerifier({
    issuer: signer.issuer,
    audience: signer.audience,
    type: signer.type,
    now: signer.now,
    allowShortSecret: signer.allowShortSecret,
    ...(alg ? { algorithms: [alg] } : {}),
    ...overrides,
    key,
  });
}
