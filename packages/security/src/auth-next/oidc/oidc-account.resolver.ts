import type {
  OAuthTokens,
  OidcProfile,
} from "../interfaces/oidc-provider.interface";
import type { OidcResolveContext } from "../interfaces/oidc.interface";

/**
 * Implemented by the app: maps an external OIDC/OAuth2 identity to a local user.
 */
export abstract class OidcAccountResolver {
  abstract resolveUser(
    profile: OidcProfile,
    tokens: OAuthTokens,
    context: OidcResolveContext,
  ): { id: string } | null | Promise<{ id: string } | null>;
}
