import type { EmailVerificationOptions } from "./email-verification.interface";
import type { JwtSignerOptions } from "./jwt-options.interface";
import type { MagicLinkOptions } from "./magic-link.interface";
import type { MfaOptions } from "./mfa-options.interface";
import type { OidcOptions } from "./oidc.interface";
import type { PasswordHasherOptions } from "./password-hasher-options.interface";
import type { PasswordResetOptions } from "./password-reset.interface";
import type { RefreshTokenOptions } from "./refresh-token-options.interface";
import type { SessionOptions } from "./session.interface";
import type { WebAuthnOptions } from "../webauthn/webauthn.interface";

/**
 * Configuration values: what `forRoot()` takes, and what `forRootAsync()`'s
 * factory returns. Injectable as `AUTHENTICATION_MODULE_OPTIONS`.
 */
export interface AuthenticationModuleOptions {
  session?: SessionOptions;
  password?: PasswordHasherOptions;
  /** Enables TOTP enrollment. Requires `encryption`. */
  mfa?: MfaOptions;
  /** Goes with a registered `MagicLinkHandler` (`'magicLink'`). */
  magicLink?: MagicLinkOptions;
  /** The access tokens `TokenService` issues and `JwtBearerProvider` verifies by default. */
  accessToken?: JwtSignerOptions;
  /** Refresh tokens issued with access tokens, or `false` to disable. */
  refreshToken?: RefreshTokenOptions | false;
  /** Goes with a registered `OidcAccountResolver` (`'oidc'`). */
  oidc?: OidcOptions;
  /** Goes with a registered `PasswordResetHandler` (`'passwordReset'`). */
  passwordReset?: PasswordResetOptions;
  /** Goes with a registered `EmailVerificationHandler` (`'emailVerification'`). */
  emailVerification?: EmailVerificationOptions;
  /** Enables WebAuthn / FIDO2 passkey registration and authentication via `WebAuthnService`. */
  webauthn?: WebAuthnOptions;
  /** Lets the app run in production on the in-memory defaults. Default `false`. */
  allowInMemoryStorage?: boolean;
}

export interface AuthenticationModuleExtras {
  /** Default `true`. */
  isGlobal?: boolean;
  /** Registers `AuthenticationGuard` as a global guard. Default `true`. */
  globalGuard?: boolean;
}

export type AuthenticationModuleForRootOptions = AuthenticationModuleOptions &
  AuthenticationModuleExtras;

export interface AuthenticationOptionsFactory {
  createAuthenticationOptions():
    AuthenticationModuleOptions | Promise<AuthenticationModuleOptions>;
}
