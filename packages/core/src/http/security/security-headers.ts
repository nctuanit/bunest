import type {
  ContentSecurityPolicyDirectiveValue,
  ContentSecurityPolicyOptions,
  HttpSecurityHeadersOptions,
} from "../../common/index";

const ALLOWED_OPTION_KEYS = new Set<string>([
  "contentSecurityPolicy",
  "crossOriginEmbedderPolicy",
  "crossOriginOpenerPolicy",
  "crossOriginResourcePolicy",
  "originAgentCluster",
  "referrerPolicy",
  "strictTransportSecurity",
  "xContentTypeOptions",
  "xDnsPrefetchControl",
  "xDownloadOptions",
  "xFrameOptions",
  "xPermittedCrossDomainPolicies",
  "xPoweredBy",
  "xXssProtection",
]);

const DEFAULT_CSP_DIRECTIVES: Readonly<
  Record<string, ContentSecurityPolicyDirectiveValue>
> = {
  "default-src": ["'self'"],
  "base-uri": ["'self'"],
  "font-src": ["'self'", "https:", "data:"],
  "form-action": ["'self'"],
  "frame-ancestors": ["'self'"],
  "img-src": ["'self'", "data:"],
  "object-src": ["'none'"],
  "script-src": ["'self'"],
  "script-src-attr": ["'none'"],
  "style-src": ["'self'", "https:", "'unsafe-inline'"],
  "upgrade-insecure-requests": [],
};

function toKebabCase(name: string): string {
  return name.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

function buildCspHeader(
  opt: true | ContentSecurityPolicyOptions,
): [string, string] {
  const cfg: ContentSecurityPolicyOptions = opt === true ? {} : opt;
  const useDefaults = cfg.useDefaults !== false;
  const merged = new Map<string, ContentSecurityPolicyDirectiveValue>();

  if (useDefaults) {
    for (const [k, v] of Object.entries(DEFAULT_CSP_DIRECTIVES)) {
      merged.set(k, v);
    }
  }

  if (cfg.directives) {
    for (const [rawKey, val] of Object.entries(cfg.directives)) {
      const key = toKebabCase(rawKey);
      if (val === null || val === false) {
        merged.delete(key);
      } else {
        merged.set(key, val);
      }
    }
  }

  const serializedParts: string[] = [];
  for (const [key, val] of merged.entries()) {
    if (val === true) {
      serializedParts.push(key);
    } else if (Array.isArray(val)) {
      serializedParts.push(val.length === 0 ? key : `${key} ${val.join(" ")}`);
    } else if (typeof val === "string") {
      serializedParts.push(val.length === 0 ? key : `${key} ${val}`);
    }
  }

  const headerName = cfg.reportOnly
    ? "Content-Security-Policy-Report-Only"
    : "Content-Security-Policy";
  return [headerName, serializedParts.join(";")];
}

export interface CompiledSecurityHeaders {
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly removePoweredBy: boolean;
}

/**
 * Validates and compiles NestJS v12 / Helmet-8 `app.useSecurityHeaders()` options
 * into a static header table with zero per-request option parsing.
 */
export function compileSecurityHeaders(
  options: HttpSecurityHeadersOptions = {},
): CompiledSecurityHeaders {
  for (const key of Object.keys(options)) {
    if (!ALLOWED_OPTION_KEYS.has(key)) {
      throw new Error(
        `Unknown security headers option "${key}". Check HttpSecurityHeadersOptions keys.`,
      );
    }
  }

  const headers: Array<readonly [string, string]> = [];

  if (options.contentSecurityPolicy !== false) {
    headers.push(
      buildCspHeader(
        options.contentSecurityPolicy === undefined
          ? true
          : options.contentSecurityPolicy,
      ),
    );
  }

  if (options.crossOriginEmbedderPolicy) {
    const policy =
      options.crossOriginEmbedderPolicy === true
        ? "require-corp"
        : (options.crossOriginEmbedderPolicy.policy ?? "require-corp");
    headers.push(["Cross-Origin-Embedder-Policy", policy]);
  }

  if (options.crossOriginOpenerPolicy !== false) {
    const policy =
      options.crossOriginOpenerPolicy === undefined ||
      options.crossOriginOpenerPolicy === true
        ? "same-origin"
        : (options.crossOriginOpenerPolicy.policy ?? "same-origin");
    headers.push(["Cross-Origin-Opener-Policy", policy]);
  }

  if (options.crossOriginResourcePolicy !== false) {
    const policy =
      options.crossOriginResourcePolicy === undefined ||
      options.crossOriginResourcePolicy === true
        ? "same-origin"
        : (options.crossOriginResourcePolicy.policy ?? "same-origin");
    headers.push(["Cross-Origin-Resource-Policy", policy]);
  }

  if (options.originAgentCluster !== false) {
    headers.push(["Origin-Agent-Cluster", "?1"]);
  }

  if (options.referrerPolicy !== false) {
    let policyValue = "no-referrer";
    if (
      typeof options.referrerPolicy === "object" &&
      options.referrerPolicy !== null &&
      options.referrerPolicy.policy !== undefined
    ) {
      policyValue = Array.isArray(options.referrerPolicy.policy)
        ? options.referrerPolicy.policy.join(",")
        : String(options.referrerPolicy.policy);
    }
    headers.push(["Referrer-Policy", policyValue]);
  }

  if (options.strictTransportSecurity !== false) {
    const cfg =
      typeof options.strictTransportSecurity === "object" &&
      options.strictTransportSecurity !== null
        ? options.strictTransportSecurity
        : {};
    const maxAge = Math.max(0, Math.floor(cfg.maxAge ?? 31_536_000));
    const parts = [`max-age=${maxAge}`];
    if (cfg.includeSubDomains !== false) {
      parts.push("includeSubDomains");
    }
    if (cfg.preload) {
      parts.push("preload");
    }
    headers.push(["Strict-Transport-Security", parts.join("; ")]);
  }

  if (options.xContentTypeOptions !== false) {
    headers.push(["X-Content-Type-Options", "nosniff"]);
  }

  if (options.xDnsPrefetchControl !== false) {
    const allow =
      typeof options.xDnsPrefetchControl === "object" &&
      options.xDnsPrefetchControl !== null
        ? options.xDnsPrefetchControl.allow === true
        : false;
    headers.push(["X-DNS-Prefetch-Control", allow ? "on" : "off"]);
  }

  if (options.xDownloadOptions !== false) {
    headers.push(["X-Download-Options", "noopen"]);
  }

  if (options.xFrameOptions !== false) {
    const action =
      typeof options.xFrameOptions === "object" &&
      options.xFrameOptions !== null
        ? (options.xFrameOptions.action ?? "sameorigin")
        : "sameorigin";
    headers.push(["X-Frame-Options", action.toUpperCase()]);
  }

  if (options.xPermittedCrossDomainPolicies !== false) {
    const permitted =
      typeof options.xPermittedCrossDomainPolicies === "object" &&
      options.xPermittedCrossDomainPolicies !== null
        ? (options.xPermittedCrossDomainPolicies.permittedPolicies ?? "none")
        : "none";
    headers.push(["X-Permitted-Cross-Domain-Policies", permitted]);
  }

  if (options.xXssProtection !== false) {
    headers.push(["X-XSS-Protection", "0"]);
  }

  return {
    headers,
    removePoweredBy: options.xPoweredBy !== false,
  };
}

/**
 * Applies compiled security headers onto a `Response` without clobbering headers
 * explicitly set by route handlers or `@Header()`, and removes `X-Powered-By`.
 */
export function applySecurityHeaders(
  response: Response,
  compiled: CompiledSecurityHeaders,
): Response {
  let needsClone = false;

  if (compiled.removePoweredBy && response.headers.has("x-powered-by")) {
    needsClone = true;
  } else {
    for (let i = 0; i < compiled.headers.length; i++) {
      const entry = compiled.headers[i];
      if (entry && !response.headers.has(entry[0])) {
        needsClone = true;
        break;
      }
    }
  }

  if (!needsClone) {
    return response;
  }

  const nextHeaders = new Headers(response.headers);
  if (compiled.removePoweredBy) {
    nextHeaders.delete("x-powered-by");
  }
  for (let i = 0; i < compiled.headers.length; i++) {
    const entry = compiled.headers[i];
    if (entry && !nextHeaders.has(entry[0])) {
      nextHeaders.set(entry[0], entry[1]);
    }
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: nextHeaders,
  });
}
