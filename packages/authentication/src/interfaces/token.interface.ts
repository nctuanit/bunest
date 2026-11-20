import type { AuthenticationTypes } from "./authentication-types.interface";

/**
 * Maps a refresh-token family's claims to the successor's, given the
 * family's current claims and the `userId` it belongs to.
 */
export type RefreshClaimsMapper = (
  current: Record<string, unknown>,
  userId: string,
) => Record<string, unknown> | Promise<Record<string, unknown>>;

export interface RefreshTokenMapOptions {
  /** Replaces the family's claims with the mapper's result for every token minted from now on. */
  claims?: RefreshClaimsMapper;
}

export interface IssueTokensOptions {
  /** Claims that describe the sign-in (`amr`, `auth_time`, ...). */
  claims?: Record<string, unknown>;
  /** How the user proved who they are, recorded on the `sign-in` event. */
  method?: string;
  /** The code the client sent for a user with a confirmed authenticator. */
  secondFactor?: {
    code?: string;
    recoveryCode?: string;
  };
}

/** What `TokenService.issue()` returns with `refreshToken: false`. */
export interface AccessTokenResult {
  /** A JWT signed with the `accessToken` options. */
  accessToken: string;
  /** Seconds until the access token expires (OAuth's `expires_in`). */
  expiresIn: number;
}

/** What a token endpoint returns to a client that signed in. */
export interface TokenPair extends AccessTokenResult {
  /** Opaque, single use: `refresh()` exchanges it for a new pair. */
  refreshToken: string;
}

/** What `TokenService.issue()` returns. */
export type IssuedTokens<Types = AuthenticationTypes> = Types extends {
  refreshTokens: false;
}
  ? AccessTokenResult
  : TokenPair;
