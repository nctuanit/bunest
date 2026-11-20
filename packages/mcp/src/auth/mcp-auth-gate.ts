import { HttpException, type LoggerService } from "@bunest/common";
import type {
  McpAuthInfo,
  McpAuthOptions,
  McpTokenVerifier,
  OAuthProtectedResourceMetadata,
} from "../interfaces/mcp-types";

function escapeHeaderParam(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function normalizeResourceUrl(value: string | URL): string {
  const url = value instanceof URL ? new URL(value) : new URL(value);
  url.hash = "";
  const cleanedPath =
    url.pathname.length > 1 && url.pathname.endsWith("/")
      ? url.pathname.slice(0, -1)
      : url.pathname;
  return `${url.origin}${cleanedPath === "/" ? "" : cleanedPath}`;
}

/**
 * The OAuth 2.1 resource server gate for the MCP HTTP endpoint (RFC 9728 & RFC 8707).
 */
export class McpAuthGate {
  private readonly logger: LoggerService;
  readonly metadataUrl: string;
  readonly metadataPaths: string[];
  readonly metadata: OAuthProtectedResourceMetadata;
  private readonly resource: string;
  private readonly requiredScopes: string[];
  private readonly verifier: McpTokenVerifier;

  constructor(
    options: McpAuthOptions,
    verifier: McpTokenVerifier | undefined,
    logger: LoggerService,
  ) {
    this.logger = logger;
    if (!options.resource) {
      throw new TypeError("McpAuthOptions requires a `resource` URI");
    }
    const resourceUrl = new URL(options.resource);
    this.resource = normalizeResourceUrl(resourceUrl);
    this.requiredScopes = options.requiredScopes ?? [];

    const resolvedVerifier =
      verifier ??
      (typeof options.verifier === "object" ? options.verifier : undefined);
    if (!resolvedVerifier || typeof resolvedVerifier.verifyAccessToken !== "function") {
      throw new TypeError(
        "McpAuthOptions requires a `verifier` implementing `verifyAccessToken(token)`",
      );
    }
    this.verifier = resolvedVerifier;

    const cleanPath =
      resourceUrl.pathname === "/"
        ? ""
        : resourceUrl.pathname.replace(/\/+$/, "");
    const pathAware = `/.well-known/oauth-protected-resource${cleanPath}`;
    const rootPath = "/.well-known/oauth-protected-resource";
    this.metadataPaths =
      pathAware === rootPath ? [rootPath] : [pathAware, rootPath];
    this.metadataUrl = `${resourceUrl.origin}${pathAware}`;

    this.metadata = {
      resource: options.resource,
      authorization_servers: [...options.authorizationServers],
      bearer_methods_supported: ["header"],
      ...(options.scopesSupported
        ? { scopes_supported: [...options.scopesSupported] }
        : {}),
      ...(options.resourceName ? { resource_name: options.resourceName } : {}),
      ...(options.resourceDocumentation
        ? { resource_documentation: options.resourceDocumentation }
        : {}),
    };
  }

  challengeResponse(
    status: 401 | 403,
    error: string,
    description: string,
    scopes?: string[],
  ): Response {
    const parts = [
      `resource_metadata="${escapeHeaderParam(this.metadataUrl)}"`,
      `error="${escapeHeaderParam(error)}"`,
      `error_description="${escapeHeaderParam(description)}"`,
    ];
    if (scopes && scopes.length > 0) {
      parts.push(`scope="${escapeHeaderParam(scopes.join(" "))}"`);
    }
    return new Response(
      JSON.stringify({ error, error_description: description }),
      {
        status,
        headers: {
          "content-type": "application/json",
          "www-authenticate": `Bearer ${parts.join(", ")}`,
        },
      },
    );
  }

  async authenticate(request: Request): Promise<McpAuthInfo | Response> {
    const authHeader = request.headers.get("authorization");
    if (!authHeader) {
      return this.challengeResponse(
        401,
        "invalid_token",
        "Missing Authorization header",
        this.requiredScopes.length > 0 ? this.requiredScopes : undefined,
      );
    }
    const match = /^Bearer\s+(\S+)$/i.exec(authHeader.trim());
    if (!match) {
      return this.challengeResponse(
        401,
        "invalid_token",
        "Authorization header must use Bearer scheme",
      );
    }
    const token = match[1]!;

    let info: McpAuthInfo | null | undefined;
    try {
      info = await this.verify(token);
    } catch (err) {
      const status =
        err instanceof HttpException
          ? err.getStatus()
          : typeof err === "object" && err !== null && "status" in err
            ? Number((err as { status?: unknown }).status)
            : undefined;
      const errCode =
        typeof err === "object" && err !== null && "errorCode" in err
          ? String((err as { errorCode?: unknown }).errorCode)
          : undefined;
      if (status === 401 || errCode === "invalid_token") {
        return this.challengeResponse(
          401,
          "invalid_token",
          err instanceof Error ? err.message : "Invalid access token",
        );
      }
      this.logger.error(
        `MCP token verifier failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return new Response(
        JSON.stringify({ error: "server_error", error_description: "Token verification failed" }),
        {
          status: 500,
          headers: { "content-type": "application/json" },
        },
      );
    }

    if (!info) {
      return this.challengeResponse(401, "invalid_token", "Invalid access token");
    }

    const nowSec = Math.floor(Date.now() / 1000);
    if (typeof info.expiresAt !== "number" || info.expiresAt <= nowSec) {
      return this.challengeResponse(
        401,
        "invalid_token",
        "Access token is expired or missing expiresAt",
      );
    }

    if (info.resource !== undefined) {
      const tokenAud = normalizeResourceUrl(info.resource);
      if (tokenAud !== this.resource) {
        return this.challengeResponse(
          401,
          "invalid_token",
          "Access token audience does not match this MCP resource",
        );
      }
    }

    if (this.requiredScopes.length > 0) {
      const granted = new Set(info.scopes ?? []);
      const missing = this.requiredScopes.filter((s) => !granted.has(s));
      if (missing.length > 0) {
        return this.challengeResponse(
          403,
          "insufficient_scope",
          `Missing required scopes: ${missing.join(", ")}`,
          this.requiredScopes,
        );
      }
    }

    return info;
  }

  private async verify(token: string): Promise<McpAuthInfo | null | undefined> {
    return await this.verifier.verifyAccessToken(token);
  }
}
