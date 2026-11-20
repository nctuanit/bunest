import type { EmailVerificationHandler } from "../account/email-verification.handler";
import type { PasswordResetHandler } from "../account/password-reset.handler";
import type { MagicLinkHandler } from "../magic-link/magic-link.handler";
import type { OidcAccountResolver } from "../oidc/oidc-account.resolver";
import type { AuthenticationProvider } from "../providers/authentication.provider";

export interface AuthenticationHandlers {
  emailVerification: EmailVerificationHandler;
  passwordReset: PasswordResetHandler;
  magicLink: MagicLinkHandler;
  oidc: OidcAccountResolver;
}

export type AuthenticationHandlerName = keyof AuthenticationHandlers;

export interface RegisterProviderOptions {
  order?: number;
  replace?: boolean;
}

export interface RegisterHandlerOptions {
  replace?: boolean;
}

export type CredentialProvider<TUser = any, TSession = any> = Pick<
  AuthenticationProvider<TUser, TSession>,
  "authenticate" | "challenge"
>;
