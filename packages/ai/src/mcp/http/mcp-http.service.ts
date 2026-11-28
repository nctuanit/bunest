import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnApplicationShutdown,
  type OnModuleInit,
} from "@bunest/core";
import { HttpAdapterHost } from "@bunest/core";
import { isString } from "@bunest/core/common";
import { McpAuthGate } from "../auth/mcp-auth-gate";
import type {
  McpAuthInfo,
  McpModuleOptions,
  McpProtocolEra,
  McpTokenVerifier,
} from "../interfaces/mcp-types";
import {
  MCP_HTTP_ENDPOINT,
  MCP_MODULE_OPTIONS,
  MCP_TOKEN_VERIFIER,
} from "../mcp.constants";
import {
  type JsonRpcNotification,
  type JsonRpcResponse,
  LEGACY_PROTOCOL_VERSION,
  McpServerFactory,
  MODERN_PROTOCOL_VERSION,
} from "../services/mcp-server.factory";
import {
  InsufficientScopeError,
  JSON_RPC_ERROR_CODES,
} from "../utils/errors.util";

const DEFAULT_MAX_BODY_SIZE = 4 * 1024 * 1024;
const DEFAULT_LOCALHOST_ORIGINS = ["localhost", "127.0.0.1", "[::1]"];

function extractHostName(hostHeader: string): string {
  const trimmed = hostHeader.trim().toLowerCase();
  if (trimmed.startsWith("[")) {
    const endBracket = trimmed.indexOf("]");
    return endBracket === -1 ? trimmed : trimmed.slice(0, endBracket + 1);
  }
  const colon = trimmed.indexOf(":");
  return colon === -1 ? trimmed : trimmed.slice(0, colon);
}

function originAllowed(originHeader: string, allowed: string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(originHeader);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  const bracketedHost = host.includes(":") ? `[${host}]` : host;
  const scheme = parsed.protocol.replace(/:$/, "").toLowerCase();

  for (const rule of allowed) {
    const norm = rule.trim().toLowerCase();
    if (norm.endsWith("://*")) {
      const ruleScheme = norm.slice(0, -4);
      if (scheme === ruleScheme) return true;
      continue;
    }
    if (norm.includes("://")) {
      try {
        const ruleUrl = new URL(norm);
        if (ruleUrl.origin.toLowerCase() === parsed.origin.toLowerCase()) {
          return true;
        }
      } catch {
        // Ignore malformed rule
      }
      continue;
    }
    if (host === norm || bracketedHost === norm) {
      return true;
    }
  }
  return false;
}

function detectEra(request: Request, body: unknown): McpProtocolEra {
  const versionHeader = request.headers.get("mcp-protocol-version");
  if (versionHeader) {
    return versionHeader >= MODERN_PROTOCOL_VERSION ? "modern" : "legacy";
  }
  if (
    body &&
    typeof body === "object" &&
    (body as { method?: unknown }).method === "initialize"
  ) {
    return "legacy";
  }
  return "modern";
}

function toPlainRequestObject(request: Request): {
  method: string;
  url: string;
  headers: Record<string, string>;
} {
  const headers: Record<string, string> = {};
  request.headers.forEach((v, k) => {
    headers[k.toLowerCase()] = v;
  });
  return {
    method: request.method,
    url: request.url,
    headers,
  };
}

/**
 * The Streamable HTTP endpoint serving every MCP request statelessly over Web `Request`/`Response`
 * with Host/Origin validation, OAuth 2.1 gate, and JSON / SSE response modes.
 */
@Injectable()
export class McpHttpService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(McpHttpService.name);
  private readonly auth?: McpAuthGate;
  private readonly maxBodySize: number;
  private readonly allowedHosts?: string[];
  private readonly allowedOrigins?: string[];

  constructor(
    private readonly factory: McpServerFactory,
    @Inject(MCP_MODULE_OPTIONS) private readonly options: McpModuleOptions,
    @Inject(MCP_HTTP_ENDPOINT)
    private readonly endpoint: { path: string | null },
    @Optional() private readonly adapterHost?: HttpAdapterHost,
    @Optional()
    @Inject(MCP_TOKEN_VERIFIER)
    verifier?: McpTokenVerifier | null,
  ) {
    if (options.auth) {
      this.auth = new McpAuthGate(
        options.auth,
        verifier ?? undefined,
        this.logger,
      );
    }
    this.maxBodySize =
      options.http?.maxRequestBodySize ?? DEFAULT_MAX_BODY_SIZE;
    this.allowedHosts = options.http?.allowedHosts?.map((h) =>
      extractHostName(h),
    );
    if (options.http?.allowedOrigins === false) {
      this.allowedOrigins = undefined;
    } else if (Array.isArray(options.http?.allowedOrigins)) {
      this.allowedOrigins = options.http.allowedOrigins;
    } else {
      this.allowedOrigins = DEFAULT_LOCALHOST_ORIGINS;
    }
  }

  onModuleInit(): void {
    if (!this.auth || this.endpoint.path === null) {
      return;
    }
    const adapter = this.adapterHost?.httpAdapter;
    if (!adapter || typeof adapter.get !== "function") {
      return;
    }
    const authGate = this.auth;
    for (const metaPath of authGate.metadataPaths) {
      adapter.get(metaPath, () => {
        return new Response(JSON.stringify(authGate.metadata), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "cache-control": "public, max-age=300",
          },
        });
      });
    }
  }

  async onApplicationShutdown(): Promise<void> {
    // Stateless endpoint: nothing persistent to close
  }

  async fetch(
    request: Request,
    opts: { parsedBody?: unknown; platformRequest?: unknown } = {},
  ): Promise<Response> {
    // 1. Host header check (DNS rebinding protection)
    if (this.allowedHosts && this.allowedHosts.length > 0) {
      const hostHeader =
        request.headers.get("host") ?? new URL(request.url).host;
      const hostname = extractHostName(hostHeader);
      if (!this.allowedHosts.includes(hostname)) {
        return new Response(JSON.stringify({ error: "Forbidden host" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      }
    }

    // 2. Origin header check (browser CSRF protection)
    const origin = request.headers.get("origin");
    if (origin && this.allowedOrigins) {
      if (!originAllowed(origin, this.allowedOrigins)) {
        return new Response(JSON.stringify({ error: "Forbidden origin" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      }
    }

    // 3. OAuth Bearer token verification
    let authInfo: McpAuthInfo | undefined;
    if (this.auth) {
      const authResult = await this.auth.authenticate(request);
      if (authResult instanceof Response) {
        return authResult;
      }
      authInfo = authResult;
    }

    const method = request.method.toUpperCase();
    if (method === "GET" || method === "DELETE") {
      return new Response(null, {
        status: 405,
        headers: { allow: "POST" },
      });
    }
    if (method !== "POST") {
      return new Response(null, {
        status: 405,
        headers: { allow: "POST" },
      });
    }

    // 4. Parse request body with size bound
    let payload: unknown = opts.parsedBody;
    if (payload === undefined) {
      const contentLen = request.headers.get("content-length");
      if (contentLen && Number(contentLen) > this.maxBodySize) {
        return new Response(
          JSON.stringify({ error: "Request body too large" }),
          {
            status: 413,
            headers: { "content-type": "application/json" },
          },
        );
      }
      let bytes: Uint8Array;
      try {
        const ab = await request.arrayBuffer();
        if (ab.byteLength > this.maxBodySize) {
          return new Response(
            JSON.stringify({ error: "Request body too large" }),
            {
              status: 413,
              headers: { "content-type": "application/json" },
            },
          );
        }
        bytes = new Uint8Array(ab);
      } catch {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: {
              code: JSON_RPC_ERROR_CODES.PARSE_ERROR,
              message: "Failed to read request body",
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }

      try {
        const text = new TextDecoder().decode(bytes);
        payload = JSON.parse(text);
      } catch {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: {
              code: JSON_RPC_ERROR_CODES.PARSE_ERROR,
              message: "Parse error: invalid JSON",
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
    }

    const era = detectEra(request, payload);
    const responseMode = this.options.http?.responseMode ?? "auto";
    const notifications: JsonRpcNotification[] = [];
    const platformReq = opts.platformRequest ?? toPlainRequestObject(request);

    const server = this.factory.create({
      era,
      transport: "http",
      authInfo,
      requestInfo: request,
      request: platformReq,
      signal: request.signal,
      onNotify: (notif) => {
        if (responseMode !== "json") {
          notifications.push(notif);
        }
      },
    });

    try {
      const messages = Array.isArray(payload) ? payload : [payload];
      const responses: JsonRpcResponse[] = [];
      for (const msg of messages) {
        const res = await server.handleMessage(msg);
        if (res !== null) {
          responses.push(res);
        }
      }

      if (responses.length === 0) {
        return new Response(null, { status: 202 });
      }

      const protocolHeader =
        era === "modern" ? MODERN_PROTOCOL_VERSION : LEGACY_PROTOCOL_VERSION;
      const bodyPayload = Array.isArray(payload) ? responses : responses[0]!;

      if (
        responseMode === "sse" ||
        (responseMode === "auto" && notifications.length > 0)
      ) {
        const chunks: string[] = [];
        for (const notif of notifications) {
          chunks.push(`event: message\ndata: ${JSON.stringify(notif)}\n\n`);
        }
        chunks.push(`event: message\ndata: ${JSON.stringify(bodyPayload)}\n\n`);
        return new Response(chunks.join(""), {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            "mcp-protocol-version": protocolHeader,
          },
        });
      }

      return new Response(JSON.stringify(bodyPayload), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "mcp-protocol-version": protocolHeader,
        },
      });
    } catch (err) {
      if (err instanceof InsufficientScopeError) {
        if (this.auth) {
          return this.auth.challengeResponse(
            403,
            "insufficient_scope",
            err.message,
            err.requiredScopes,
          );
        }
        return new Response(
          JSON.stringify({
            error: "insufficient_scope",
            error_description: err.message,
          }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
      }
      throw err;
    }
  }

  async serve(
    platformRequest: unknown,
    platformResponse: unknown,
  ): Promise<void> {
    const webRequest = this.unwrap(platformRequest);
    const response = await this.fetch(webRequest, { platformRequest });

    if (platformResponse && typeof platformResponse === "object") {
      const res = platformResponse as {
        status?: (code: number) => unknown;
        header?: (k: string, v: string) => unknown;
        setHeader?: (k: string, v: string) => unknown;
        statusCode?: number;
        markHeadersSent?: (r?: Response) => void;
        end?: (chunk?: string | Uint8Array) => unknown;
        send?: (body?: unknown) => unknown;
      };
      if (typeof res.markHeadersSent === "function") {
        res.status?.(response.status);
        response.headers.forEach((v, k) => res.header?.(k, v));
        res.markHeadersSent(response);
        return;
      }
      if (typeof res.status === "function") {
        res.status(response.status);
      } else {
        res.statusCode = response.status;
      }
      response.headers.forEach((v, k) => {
        if (typeof res.header === "function") res.header(k, v);
        else res.setHeader?.(k, v);
      });
      const text = await response.text();
      if (typeof res.end === "function") {
        res.end(text);
      } else if (typeof res.send === "function") {
        res.send(text);
      }
    }
  }

  private unwrap(platformRequest: unknown): Request {
    if (platformRequest instanceof Request) {
      return platformRequest;
    }
    const req = platformRequest as {
      method?: string;
      url?: string;
      headers?: Record<string, string | string[] | undefined>;
      body?: unknown;
    };
    const headers = new Headers();
    if (req?.headers) {
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") headers.set(k, v);
        else if (Array.isArray(v)) headers.set(k, v.join(", "));
      }
    }
    const url = req?.url?.startsWith("http")
      ? req.url
      : `http://localhost${req?.url ?? "/mcp"}`;
    let body: string | undefined;
    if (req?.body !== undefined && req.method?.toUpperCase() !== "GET") {
      body = isString(req.body) ? req.body : JSON.stringify(req.body);
    }
    return new Request(url, {
      method: req?.method ?? "POST",
      headers,
      ...(body !== undefined ? { body } : {}),
    });
  }
}
