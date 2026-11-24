import type { OidcTransaction } from "./oidc.interface";

/** Storage for OIDC logins in progress (PKCE verifier, nonce, return path). */
export interface OidcStateStore {
  saveOidcState(transaction: OidcTransaction): Promise<void>;
  consumeOidcState(state: string): Promise<OidcTransaction | undefined>;
}
