import type { OidcProviderConfig } from "../interfaces/oidc-provider.interface";

type Credentials = {
  clientId: string;
  clientSecret: string;
};

export function google(credentials: Credentials): OidcProviderConfig {
  return { issuer: "https://accounts.google.com", ...credentials };
}

const TENANT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Microsoft Entra ID, single tenant, by its tenant id (a GUID).
 */
export function microsoft({
  tenant,
  ...credentials
}: Credentials & { tenant: string }): OidcProviderConfig {
  if (typeof tenant !== "string" || !TENANT_ID.test(tenant)) {
    throw new Error(
      `microsoft(): pass the tenant id, a GUID (Entra admin center, Overview), not ${JSON.stringify(tenant)}: ` +
        "for a domain, and for the multi-tenant common, organizations and consumers, Microsoft publishes an " +
        "issuer that is not the one discovery was asked for, and every sign-in would fail.",
    );
  }
  return {
    issuer: `https://login.microsoftonline.com/${tenant.toLowerCase()}/v2.0`,
    ...credentials,
  };
}

/**
 * GitHub OAuth 2.0 preset.
 */
export function github(credentials: Credentials): OidcProviderConfig {
  return {
    kind: "oauth2",
    authorizationEndpoint: "https://github.com/login/oauth/authorize",
    tokenEndpoint: "https://github.com/login/oauth/access_token",
    userinfoEndpoint: "https://api.github.com/user",
    scopes: ["read:user", "user:email"],
    ...credentials,
    async profile(user: any, { provider, fetchJson }) {
      if (typeof user?.id !== "number" && typeof user?.id !== "string") {
        throw new Error("unexpected GitHub user");
      }
      const emails = await fetchJson(`${this.userinfoEndpoint}/emails`);
      const primary = Array.isArray(emails)
        ? emails.find(
            (e: any) =>
              e?.primary === true &&
              e.verified === true &&
              typeof e.email === "string",
          )
        : undefined;
      return {
        provider,
        subject: String(user.id),
        email: primary?.email,
        emailVerified: !!primary,
        name: user.name ?? user.login,
        picture: user.avatar_url,
        claims: user,
      };
    },
  };
}
