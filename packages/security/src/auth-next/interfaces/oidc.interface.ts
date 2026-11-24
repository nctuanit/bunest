import type { CookieAttributes } from "../session/cookies.util";
import type { Duration } from "./duration.interface";
import type { OidcProviderConfig } from "./oidc-provider.interface";

export interface OidcTransaction {
  state: string;
  provider: string;
  nonce?: string;
  codeVerifier: string;
  redirectTo?: string;
  createdAt: Date;
  expiresAt: Date;
  link?: {
    userId: string;
    sessionId: string;
  };
}

export interface OidcClientOptions {
  fetch?: typeof fetch;
  now?: () => number;
  discoveryTtl?: Duration;
  clockTolerance?: Duration;
  jwks?: {
    cacheTtl?: Duration;
    cooldown?: Duration;
  };
}

export interface OidcResolveContext {
  linkTo?: {
    id: string;
  };
}

/** The HTTP request of a login or callback. */
export type OidcRequest = {
  headers: Record<string, string | string[] | undefined> | Headers;
  method?: string;
};

export interface OidcOptions extends OidcClientOptions {
  callbackUrl: string | ((request: OidcRequest) => string | Promise<string>);
  providers:
    | Record<string, OidcProviderConfig>
    | ((
        name: string,
      ) =>
        | OidcProviderConfig
        | null
        | undefined
        | Promise<OidcProviderConfig | null | undefined>);
  redirectAfterLogin?: string;
  transactionTtl?: Duration;
  cookie?: CookieAttributes;
}

export interface OidcRedirect {
  url: string;
  cookies: string[];
}

export interface OidcStartOptions {
  redirectTo?: unknown;
  link?: boolean;
  request?: OidcRequest;
}
