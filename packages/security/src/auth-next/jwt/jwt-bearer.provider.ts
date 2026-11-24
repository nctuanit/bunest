import { Inject, Optional, type ExecutionContext } from "@bunest/core";
import { AUTHENTICATION_MODULE_OPTIONS } from "../authentication.constants";
import { AuthenticationError } from "../errors/authentication.error";
import { JwtError } from "../errors/jwt.error";
import type { AuthenticationModuleOptions } from "../interfaces/authentication-module-options.interface";
import type {
  AuthenticatedUser,
  AuthenticationResult,
  MfaState,
} from "../interfaces/authentication-result.interface";
import type { JwtClaims } from "../interfaces/jwt.interface";
import type { JwtBearerProviderOptions } from "../interfaces/jwt-options.interface";
import {
  AuthenticationProvider,
  PROVIDER_INIT,
} from "../providers/authentication.provider";
import { API_KEY_PATTERN } from "../utils/api-key.util";
import { bearerToken } from "../utils/bearer.util";
import { hasMfaAmr } from "./amr.util";
import { JwtVerifier, verifierForSigner } from "./jwt-verifier.service";

/**
 * Base class for `Authorization: Bearer <jwt>` authentication. Extend it,
 * inject what `validate()` needs, and load the user.
 */
export abstract class JwtBearerProvider<
  TUser = AuthenticatedUser,
> extends AuthenticationProvider<TUser, JwtClaims> {
  @Optional()
  @Inject(AUTHENTICATION_MODULE_OPTIONS)
  private moduleOptions?: AuthenticationModuleOptions;

  private readonly realm: string;
  private verifier?: JwtVerifier;

  constructor(private readonly options: JwtBearerProviderOptions = {}) {
    super();
    this.realm = options.realm ?? "api";
    const named = (["key", "jwks"] as const).filter((name) =>
      Object.hasOwn(options, name),
    );
    if (named.length > 0 && !options.key && !options.jwks) {
      throw new TypeError(
        `${new.target.name}: \`${named.join("` and `")}\` ${named.length > 1 ? "are" : "is"} empty: is the environment ` +
          "variable it reads set? Leave both out to verify the tokens the module's `accessToken` issues.",
      );
    }
    if (options.key !== undefined || options.jwks !== undefined) {
      this.verifier = new JwtVerifier(options);
    }
  }

  override async authenticate(
    context: ExecutionContext,
  ): Promise<AuthenticationResult<TUser, JwtClaims> | null> {
    const token = this.extract(context);
    if (token === undefined) {
      return null;
    }
    let claims: JwtClaims;
    try {
      claims = await this.getVerifier().verify(token);
    } catch (error) {
      if (error instanceof JwtError) {
        this.reject(error.message);
      }
      throw error;
    }
    const user = await this.validate(claims);
    if (user === null || user === undefined) {
      this.reject("unknown subject");
    }
    return { user: user as TUser, session: claims, mfa: this.mfaState(claims) };
  }

  override challenge(): string {
    return `Bearer realm="${this.realm}"`;
  }

  /** Map verified claims to a user, or `null` to answer 401. */
  abstract validate(
    claims: JwtClaims,
  ): Promise<TUser | null | undefined> | TUser | null | undefined;

  protected mfaState(claims: JwtClaims): MfaState | undefined {
    return hasMfaAmr(claims.amr) ? "verified" : undefined;
  }

  /** @internal */
  [PROVIDER_INIT](
    resolve: <T>(
      token: string | symbol | (abstract new (...args: any[]) => T),
    ) => T,
  ): void {
    this.moduleOptions ??= resolve(AUTHENTICATION_MODULE_OPTIONS);
    this.getVerifier();
  }

  private getVerifier(): JwtVerifier {
    if (this.verifier) {
      return this.verifier;
    }
    const accessToken = this.moduleOptions?.accessToken;
    if (!accessToken) {
      throw new Error(
        `${this.constructor.name}: nothing to verify tokens with. Configure \`accessToken\` in the ` +
          "AuthenticationModule options, or pass `key` or `jwks` to super().",
      );
    }
    const { realm: _realm, key: _key, jwks: _jwks, ...rules } = this.options;
    const defined = Object.fromEntries(
      Object.entries(rules).filter(([, value]) => value !== undefined),
    );
    this.verifier = verifierForSigner(accessToken, defined);
    return this.verifier;
  }

  private extract(context: ExecutionContext): string | undefined {
    const token = bearerToken(context, this.header(context, "authorization"));
    if (token === null) {
      this.reject("malformed authorization header");
    }
    return token === undefined || API_KEY_PATTERN.test(token)
      ? undefined
      : token;
  }

  private reject(description: string): never {
    throw new AuthenticationError(description, {
      challenge: `Bearer realm="${this.realm}", error="invalid_token", error_description="${description}"`,
    });
  }
}
