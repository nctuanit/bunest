import type { EmailTokenStore } from "./email-token-store.interface";
import type { MagicLinkStore } from "./magic-link-store.interface";
import type { MfaStore } from "./mfa-store.interface";
import type { OidcStateStore } from "./oidc-state-store.interface";
import type { RefreshTokenStore } from "./refresh-token-store.interface";
import type { SessionStore } from "./session-store.interface";

/** The storage contracts, by name: what `registerSource()` takes. */
export interface AuthenticationStorageSources {
  sessions?: SessionStore;
  refreshTokens?: RefreshTokenStore;
  /** Authenticators, recovery codes and failed attempts. */
  mfa?: MfaStore;
  /** Pending magic links. */
  magicLinks?: MagicLinkStore;
  /** OAuth / OpenID Connect logins in progress. */
  oidcStates?: OidcStateStore;
  /** Pending password reset and email verification links. */
  emailTokens?: EmailTokenStore;
}

export type AuthenticationStorageContract = keyof AuthenticationStorageSources;

/** `registerSource()` options. */
export interface AuthenticationStorageRegisterOptions {
  /** Replace the source of a contract that is already registered (tests, wrappers). */
  replace?: boolean;
}
