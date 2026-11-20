export interface OAuth2ProviderPreset {
  readonly provider: string;
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly userInfoUrl?: string;
  readonly revocationUrl?: string;
  readonly issuer?: string;
  readonly discoveryUrl?: string;
  readonly jwksUri?: string;
  readonly scopes: readonly string[];
  readonly extraAuthorizationParams?: Record<string, string>;
}

export interface OidcProviderPreset extends OAuth2ProviderPreset {
  readonly issuer: string;
  readonly discoveryUrl: string;
  readonly jwksUri: string;
}

export interface GoogleProviderOptions {
  scopes?: readonly string[];
  accessType?: "online" | "offline";
  prompt?: string;
  hostedDomain?: string;
}

export interface GitHubProviderOptions {
  scopes?: readonly string[];
  enterpriseDomain?: string;
}

export interface MicrosoftProviderOptions {
  tenant?: string;
  scopes?: readonly string[];
}

export interface OktaProviderOptions {
  domain: string;
  /**
   * Authorization server ID. Defaults to `"default"`.
   * Pass `""` for the Okta Org Authorization Server.
   */
  authorizationServerId?: string;
  scopes?: readonly string[];
}

export interface Auth0ProviderOptions {
  domain: string;
  audience?: string;
  scopes?: readonly string[];
}

function normalizeHost(rawDomain: string, providerName: string): string {
  const trimmed = rawDomain.trim();
  if (trimmed.length === 0) {
    throw new Error(`${providerName} provider requires a non-empty domain`);
  }
  const withScheme =
    trimmed.startsWith("https://") || trimmed.startsWith("http://")
      ? trimmed
      : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error(`Invalid ${providerName} domain: "${rawDomain}"`);
  }
  if (!parsed.host || parsed.username || parsed.password) {
    throw new Error(`Invalid ${providerName} domain: "${rawDomain}"`);
  }
  return parsed.host;
}

/**
 * Built-in OAuth2 / OIDC endpoint presets for major identity providers.
 * Spread directly into `OAuth2Module.register(...)` or `OidcModule.register(...)`.
 */
export const OAuth2Providers = {
  google(options: GoogleProviderOptions = {}): OidcProviderPreset {
    const extraAuthorizationParams: Record<string, string> = {};
    if (options.accessType) {
      extraAuthorizationParams.access_type = options.accessType;
    }
    if (options.prompt) {
      extraAuthorizationParams.prompt = options.prompt;
    }
    if (options.hostedDomain) {
      extraAuthorizationParams.hd = options.hostedDomain;
    }

    return {
      provider: "google",
      issuer: "https://accounts.google.com",
      discoveryUrl:
        "https://accounts.google.com/.well-known/openid-configuration",
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      userInfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
      revocationUrl: "https://oauth2.googleapis.com/revoke",
      jwksUri: "https://www.googleapis.com/oauth2/v3/certs",
      scopes: options.scopes ? [...options.scopes] : ["openid", "email", "profile"],
      ...(Object.keys(extraAuthorizationParams).length > 0
        ? { extraAuthorizationParams }
        : {}),
    };
  },

  github(options: GitHubProviderOptions = {}): OAuth2ProviderPreset {
    const host = options.enterpriseDomain
      ? normalizeHost(options.enterpriseDomain, "GitHub")
      : "github.com";
    const base = `https://${host}`;
    const apiBase = options.enterpriseDomain
      ? `${base}/api/v3`
      : "https://api.github.com";

    return {
      provider: "github",
      authorizationUrl: `${base}/login/oauth/authorize`,
      tokenUrl: `${base}/login/oauth/access_token`,
      userInfoUrl: `${apiBase}/user`,
      scopes: options.scopes ? [...options.scopes] : ["read:user", "user:email"],
    };
  },

  microsoft(options: MicrosoftProviderOptions = {}): OidcProviderPreset {
    const tenant = (options.tenant ?? "common").trim();
    if (tenant.length === 0) {
      throw new Error("Microsoft provider tenant must be a non-empty string");
    }
    const encodedTenant = encodeURIComponent(tenant);
    const issuer = `https://login.microsoftonline.com/${encodedTenant}/v2.0`;
    const oauthBase = `https://login.microsoftonline.com/${encodedTenant}/oauth2/v2.0`;

    return {
      provider: "microsoft",
      issuer,
      discoveryUrl: `${issuer}/.well-known/openid-configuration`,
      authorizationUrl: `${oauthBase}/authorize`,
      tokenUrl: `${oauthBase}/token`,
      userInfoUrl: "https://graph.microsoft.com/oidc/userinfo",
      jwksUri: `https://login.microsoftonline.com/${encodedTenant}/discovery/v2.0/keys`,
      scopes: options.scopes
        ? [...options.scopes]
        : ["openid", "profile", "email"],
    };
  },

  okta(options: OktaProviderOptions): OidcProviderPreset {
    const host = normalizeHost(options.domain, "Okta");
    const serverId =
      options.authorizationServerId === undefined
        ? "default"
        : options.authorizationServerId.trim();
    const isOrgServer = serverId.length === 0;
    const issuer = isOrgServer
      ? `https://${host}`
      : `https://${host}/oauth2/${encodeURIComponent(serverId)}`;
    const oauthBase = isOrgServer
      ? `https://${host}/oauth2`
      : `https://${host}/oauth2/${encodeURIComponent(serverId)}`;

    return {
      provider: "okta",
      issuer,
      discoveryUrl: `${issuer}/.well-known/openid-configuration`,
      authorizationUrl: `${oauthBase}/v1/authorize`,
      tokenUrl: `${oauthBase}/v1/token`,
      userInfoUrl: `${oauthBase}/v1/userinfo`,
      revocationUrl: `${oauthBase}/v1/revoke`,
      jwksUri: `${oauthBase}/v1/keys`,
      scopes: options.scopes
        ? [...options.scopes]
        : ["openid", "profile", "email"],
    };
  },

  auth0(options: Auth0ProviderOptions): OidcProviderPreset {
    const host = normalizeHost(options.domain, "Auth0");
    const origin = `https://${host}`;

    return {
      provider: "auth0",
      issuer: `${origin}/`,
      discoveryUrl: `${origin}/.well-known/openid-configuration`,
      authorizationUrl: `${origin}/authorize`,
      tokenUrl: `${origin}/oauth/token`,
      userInfoUrl: `${origin}/userinfo`,
      revocationUrl: `${origin}/oauth/revoke`,
      jwksUri: `${origin}/.well-known/jwks.json`,
      scopes: options.scopes
        ? [...options.scopes]
        : ["openid", "profile", "email"],
      ...(options.audience
        ? { extraAuthorizationParams: { audience: options.audience } }
        : {}),
    };
  },
} as const;
