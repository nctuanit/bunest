import type { JwsAlgorithm } from "./jwt.interface";

export interface OidcProfile {
  /** Config key of the provider (`google`, `github`, ...). */
  provider: string;
  /** Stable account id at the provider. */
  subject: string;
  email?: string;
  /** Only `true` when the provider asserted it. */
  emailVerified: boolean;
  name?: string;
  picture?: string;
  /** Verified ID token claims merged with userinfo (OIDC), or raw userinfo (OAuth 2.0). */
  claims: Record<string, unknown>;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresIn?: number;
  scope?: string;
}

export interface ProfileContext {
  provider: string;
  tokens: OAuthTokens;
  /** GET with the access token, JSON response. */
  fetchJson<T = unknown>(url: string): Promise<T>;
}

export interface OidcProviderConfig {
  /** `oidc` (default) or `oauth2`. */
  kind?: "oidc" | "oauth2";
  /** OIDC issuer; discovery is `${issuer}/.well-known/openid-configuration`. */
  issuer?: string;
  clientId: string;
  clientSecret?: string;
  /** Default `openid email profile` for OIDC. */
  scopes?: string[];
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  userinfoEndpoint?: string;
  jwksUri?: string;
  /** Accepted ID token algorithms. Default `RS256`, `ES256`. */
  idTokenAlgorithms?: JwsAlgorithm[];
  tokenEndpointAuthMethod?:
    "client_secret_basic" | "client_secret_post" | "none";
  authorizationParams?: Record<string, string>;
  /** `oauth2` only: builds the profile from the userinfo response. */
  profile?(
    userinfo: any,
    context: ProfileContext,
  ): OidcProfile | Promise<OidcProfile>;
}
