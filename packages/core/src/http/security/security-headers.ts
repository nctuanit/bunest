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

const UNQUOTED_CSP_KEYWORDS = new Set([
  "self",
  "none",
  "unsafe-inline",
  "unsafe-eval",
  "unsafe-hashes",
  "strict-dynamic",
  "report-sample",
  "wasm-unsafe-eval",
  "unsafe-allow-redirects",
]);

function toKebabCase(name: string): string {
  return name.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

function validateCspDirectiveName(rawKey: string): string {
  if (!rawKey) {
    throw new Error('Invalid Content-Security-Policy directive name "".');
  }
  const isKebab = /^[a-z0-9]+(-[a-z0-9]+)*$/.test(rawKey);
  const isCamel = /^[a-z][a-zA-Z0-9]*$/.test(rawKey) && !/[A-Z]{2}/.test(rawKey);
  if (!isKebab && !isCamel) {
    throw new Error(
      `Invalid Content-Security-Policy directive name "${rawKey}".`,
    );
  }
  const key = toKebabCase(rawKey);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(key)) {
    throw new Error(
      `Invalid Content-Security-Policy directive name "${rawKey}".`,
    );
  }
  return key;
}

function validateCspValueItem(key: string, item: unknown): string {
  if (typeof item !== "string") {
    throw new Error(
      `Invalid Content-Security-Policy directive "${key}": expected string value.`,
    );
  }
  if (item.length === 0) {
    throw new Error(
      `Invalid Content-Security-Policy directive "${key}": value must not be empty.`,
    );
  }
  if (/[;,\r\n\t]|[^\x20-\x7e]/.test(item)) {
    throw new Error(
      `Invalid Content-Security-Policy directive "${key}": value contains forbidden character.`,
    );
  }
  for (const token of item.split(" ")) {
    if (!token) continue;
    const lower = token.toLowerCase();
    if (
      UNQUOTED_CSP_KEYWORDS.has(lower) ||
      /^(?:nonce|sha256|sha384|sha512)-/.test(lower)
    ) {
      throw new Error(
        `Invalid Content-Security-Policy directive "${key}": keyword/nonce "${token}" must be single-quoted.`,
      );
    }
  }
  return item;
}

const VALID_COEP_POLICIES = new Set([
  "require-corp",
  "credentialless",
  "unsafe-none",
]);
const VALID_COOP_POLICIES = new Set([
  "same-origin",
  "same-origin-allow-popups",
  "unsafe-none",
]);
const VALID_CORP_POLICIES = new Set([
  "same-origin",
  "same-site",
  "cross-origin",
]);
const VALID_REFERRER_POLICIES = new Set([
  "no-referrer",
  "no-referrer-when-downgrade",
  "same-origin",
  "origin",
  "strict-origin",
  "origin-when-cross-origin",
  "strict-origin-when-cross-origin",
  "unsafe-url",
  "",
]);
const VALID_X_FRAME_ACTIONS = new Set(["deny", "sameorigin"]);
const VALID_PERMITTED_POLICIES = new Set([
  "none",
  "master-only",
  "by-content-type",
  "by-ftp-filename",
  "all",
]);

function isPlainObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertAllowedKeys(
  obj: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  parentName: string,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new Error(
        `Unknown security headers option "${parentName}.${key}".`,
      );
    }
  }
}

function assertBooleanOnly(value: unknown, name: string): void {
  if (value !== undefined && typeof value !== "boolean") {
    throw new Error(`Invalid security headers option "${name}": expected boolean.`);
  }
}

function buildCspHeader(
  opt: true | ContentSecurityPolicyOptions,
): [string, string] {
  if (opt !== true) {
    if (!isPlainObject(opt)) {
      throw new Error(
        'Invalid security headers option "contentSecurityPolicy": expected boolean or object.',
      );
    }
    assertAllowedKeys(
      opt as Record<string, unknown>,
      new Set(["useDefaults", "directives", "reportOnly"]),
      "contentSecurityPolicy",
    );
    if (opt.useDefaults !== undefined && typeof opt.useDefaults !== "boolean") {
      throw new Error(
        'Invalid security headers option "contentSecurityPolicy.useDefaults": expected boolean.',
      );
    }
    if (opt.reportOnly !== undefined && typeof opt.reportOnly !== "boolean") {
      throw new Error(
        'Invalid security headers option "contentSecurityPolicy.reportOnly": expected boolean.',
      );
    }
    if (opt.directives !== undefined && !isPlainObject(opt.directives)) {
      throw new Error(
        'Invalid security headers option "contentSecurityPolicy.directives": expected plain object.',
      );
    }
  }
  const cfg: ContentSecurityPolicyOptions = opt === true ? {} : opt;
  const useDefaults = cfg.useDefaults !== false;
  const merged = new Map<string, ContentSecurityPolicyDirectiveValue>();

  if (useDefaults) {
    for (const [k, v] of Object.entries(DEFAULT_CSP_DIRECTIVES)) {
      merged.set(k, v);
    }
  }

  let defaultSrcExplicitlyRemoved = false;
  const seenKeys = new Set<string>();

  if (cfg.directives) {
    for (const [rawKey, val] of Object.entries(cfg.directives)) {
      const key = validateCspDirectiveName(rawKey);
      if (seenKeys.has(key)) {
        throw new Error(
          `Duplicate Content-Security-Policy directive "${key}".`,
        );
      }
      seenKeys.add(key);

      if (val === null || val === false) {
        if (key === "default-src") {
          defaultSrcExplicitlyRemoved = true;
        }
        merged.delete(key);
      } else {
        merged.set(key, val);
      }
    }
  }

  if (!merged.has("default-src") && !defaultSrcExplicitlyRemoved) {
    throw new Error(
      'Content-Security-Policy requires a "default-src" directive unless it is explicitly removed.',
    );
  }

  const serializedParts: string[] = [];
  for (const [key, val] of merged.entries()) {
    if (val === true) {
      serializedParts.push(key);
    } else if (Array.isArray(val)) {
      const validated = val.map((item) => validateCspValueItem(key, item));
      serializedParts.push(
        validated.length === 0 ? key : `${key} ${validated.join(" ")}`,
      );
    } else if (typeof val === "string") {
      if (val.length === 0) {
        serializedParts.push(key);
      } else {
        validateCspValueItem(key, val);
        serializedParts.push(`${key} ${val}`);
      }
    } else {
      throw new Error(
        `Invalid Content-Security-Policy directive "${key}": unsupported value type.`,
      );
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
  if (!isPlainObject(options)) {
    throw new Error("Invalid security headers options: expected plain object.");
  }

  for (const key of Object.keys(options)) {
    if (!ALLOWED_OPTION_KEYS.has(key)) {
      throw new Error(
        `Unknown security headers option "${key}". Check HttpSecurityHeadersOptions keys.`,
      );
    }
  }

  assertBooleanOnly(options.originAgentCluster, "originAgentCluster");
  assertBooleanOnly(options.xContentTypeOptions, "xContentTypeOptions");
  assertBooleanOnly(options.xDownloadOptions, "xDownloadOptions");
  assertBooleanOnly(options.xPoweredBy, "xPoweredBy");
  assertBooleanOnly(options.xXssProtection, "xXssProtection");

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

  if (options.crossOriginEmbedderPolicy !== undefined && options.crossOriginEmbedderPolicy !== false) {
    let policy = "require-corp";
    if (options.crossOriginEmbedderPolicy !== true) {
      if (!isPlainObject(options.crossOriginEmbedderPolicy)) {
        throw new Error(
          'Invalid security headers option "crossOriginEmbedderPolicy": expected boolean or object.',
        );
      }
      assertAllowedKeys(
        options.crossOriginEmbedderPolicy as Record<string, unknown>,
        new Set(["policy"]),
        "crossOriginEmbedderPolicy",
      );
      if (options.crossOriginEmbedderPolicy.policy !== undefined) {
        if (
          typeof options.crossOriginEmbedderPolicy.policy !== "string" ||
          !VALID_COEP_POLICIES.has(options.crossOriginEmbedderPolicy.policy)
        ) {
          throw new Error(
            `Invalid Cross-Origin-Embedder-Policy "${String(options.crossOriginEmbedderPolicy.policy)}".`,
          );
        }
        policy = options.crossOriginEmbedderPolicy.policy;
      }
    }
    headers.push(["Cross-Origin-Embedder-Policy", policy]);
  }

  if (options.crossOriginOpenerPolicy !== false) {
    let policy = "same-origin";
    if (
      options.crossOriginOpenerPolicy !== undefined &&
      options.crossOriginOpenerPolicy !== true
    ) {
      if (!isPlainObject(options.crossOriginOpenerPolicy)) {
        throw new Error(
          'Invalid security headers option "crossOriginOpenerPolicy": expected boolean or object.',
        );
      }
      assertAllowedKeys(
        options.crossOriginOpenerPolicy as Record<string, unknown>,
        new Set(["policy"]),
        "crossOriginOpenerPolicy",
      );
      if (options.crossOriginOpenerPolicy.policy !== undefined) {
        if (
          typeof options.crossOriginOpenerPolicy.policy !== "string" ||
          !VALID_COOP_POLICIES.has(options.crossOriginOpenerPolicy.policy)
        ) {
          throw new Error(
            `Invalid Cross-Origin-Opener-Policy "${String(options.crossOriginOpenerPolicy.policy)}".`,
          );
        }
        policy = options.crossOriginOpenerPolicy.policy;
      }
    }
    headers.push(["Cross-Origin-Opener-Policy", policy]);
  }

  if (options.crossOriginResourcePolicy !== false) {
    let policy = "same-origin";
    if (
      options.crossOriginResourcePolicy !== undefined &&
      options.crossOriginResourcePolicy !== true
    ) {
      if (!isPlainObject(options.crossOriginResourcePolicy)) {
        throw new Error(
          'Invalid security headers option "crossOriginResourcePolicy": expected boolean or object.',
        );
      }
      assertAllowedKeys(
        options.crossOriginResourcePolicy as Record<string, unknown>,
        new Set(["policy"]),
        "crossOriginResourcePolicy",
      );
      if (options.crossOriginResourcePolicy.policy !== undefined) {
        if (
          typeof options.crossOriginResourcePolicy.policy !== "string" ||
          !VALID_CORP_POLICIES.has(options.crossOriginResourcePolicy.policy)
        ) {
          throw new Error(
            `Invalid Cross-Origin-Resource-Policy "${String(options.crossOriginResourcePolicy.policy)}".`,
          );
        }
        policy = options.crossOriginResourcePolicy.policy;
      }
    }
    headers.push(["Cross-Origin-Resource-Policy", policy]);
  }

  if (options.originAgentCluster !== false) {
    headers.push(["Origin-Agent-Cluster", "?1"]);
  }

  if (options.referrerPolicy !== false) {
    let policyValue = "no-referrer";
    if (
      options.referrerPolicy !== undefined &&
      options.referrerPolicy !== true
    ) {
      if (!isPlainObject(options.referrerPolicy)) {
        throw new Error(
          'Invalid security headers option "referrerPolicy": expected boolean or object.',
        );
      }
      assertAllowedKeys(
        options.referrerPolicy as Record<string, unknown>,
        new Set(["policy"]),
        "referrerPolicy",
      );
      if (options.referrerPolicy.policy !== undefined) {
        const rawPolicy = options.referrerPolicy.policy;
        if (Array.isArray(rawPolicy)) {
          if (rawPolicy.length === 0) {
            throw new Error(
              'Invalid Referrer-Policy: "policy" array must not be empty.',
            );
          }
          const seen = new Set<string>();
          for (const token of rawPolicy) {
            if (
              typeof token !== "string" ||
              !VALID_REFERRER_POLICIES.has(token) ||
              seen.has(token)
            ) {
              throw new Error(`Invalid Referrer-Policy token "${String(token)}".`);
            }
            seen.add(token);
          }
          policyValue = rawPolicy.join(",");
        } else if (
          typeof rawPolicy === "string" &&
          VALID_REFERRER_POLICIES.has(rawPolicy)
        ) {
          policyValue = rawPolicy;
        } else {
          throw new Error(`Invalid Referrer-Policy "${String(rawPolicy)}".`);
        }
      }
    }
    headers.push(["Referrer-Policy", policyValue]);
  }

  if (options.strictTransportSecurity !== false) {
    let maxAge = 31_536_000;
    let includeSubDomains = true;
    let preload = false;
    if (
      options.strictTransportSecurity !== undefined &&
      options.strictTransportSecurity !== true
    ) {
      if (!isPlainObject(options.strictTransportSecurity)) {
        throw new Error(
          'Invalid security headers option "strictTransportSecurity": expected boolean or object.',
        );
      }
      const cfg = options.strictTransportSecurity;
      assertAllowedKeys(
        cfg as Record<string, unknown>,
        new Set(["maxAge", "includeSubDomains", "preload"]),
        "strictTransportSecurity",
      );
      if (cfg.maxAge !== undefined) {
        if (
          typeof cfg.maxAge !== "number" ||
          !Number.isFinite(cfg.maxAge) ||
          cfg.maxAge < 0
        ) {
          throw new Error(
            `Invalid Strict-Transport-Security maxAge "${String(cfg.maxAge)}".`,
          );
        }
        maxAge = Math.floor(cfg.maxAge);
      }
      if (cfg.includeSubDomains !== undefined) {
        if (typeof cfg.includeSubDomains !== "boolean") {
          throw new Error(
            'Invalid Strict-Transport-Security "includeSubDomains": expected boolean.',
          );
        }
        includeSubDomains = cfg.includeSubDomains;
      }
      if (cfg.preload !== undefined) {
        if (typeof cfg.preload !== "boolean") {
          throw new Error(
            'Invalid Strict-Transport-Security "preload": expected boolean.',
          );
        }
        preload = cfg.preload;
      }
    }
    const parts = [`max-age=${maxAge}`];
    if (includeSubDomains) {
      parts.push("includeSubDomains");
    }
    if (preload) {
      parts.push("preload");
    }
    headers.push(["Strict-Transport-Security", parts.join("; ")]);
  }

  if (options.xContentTypeOptions !== false) {
    headers.push(["X-Content-Type-Options", "nosniff"]);
  }

  if (options.xDnsPrefetchControl !== false) {
    let allow = false;
    if (
      options.xDnsPrefetchControl !== undefined &&
      options.xDnsPrefetchControl !== true
    ) {
      if (!isPlainObject(options.xDnsPrefetchControl)) {
        throw new Error(
          'Invalid security headers option "xDnsPrefetchControl": expected boolean or object.',
        );
      }
      assertAllowedKeys(
        options.xDnsPrefetchControl as Record<string, unknown>,
        new Set(["allow"]),
        "xDnsPrefetchControl",
      );
      if (options.xDnsPrefetchControl.allow !== undefined) {
        if (typeof options.xDnsPrefetchControl.allow !== "boolean") {
          throw new Error(
            'Invalid X-DNS-Prefetch-Control "allow": expected boolean.',
          );
        }
        allow = options.xDnsPrefetchControl.allow;
      }
    }
    headers.push(["X-DNS-Prefetch-Control", allow ? "on" : "off"]);
  }

  if (options.xDownloadOptions !== false) {
    headers.push(["X-Download-Options", "noopen"]);
  }

  if (options.xFrameOptions !== false) {
    let action = "sameorigin";
    if (options.xFrameOptions !== undefined && options.xFrameOptions !== true) {
      if (!isPlainObject(options.xFrameOptions)) {
        throw new Error(
          'Invalid security headers option "xFrameOptions": expected boolean or object.',
        );
      }
      assertAllowedKeys(
        options.xFrameOptions as Record<string, unknown>,
        new Set(["action"]),
        "xFrameOptions",
      );
      if (options.xFrameOptions.action !== undefined) {
        if (
          typeof options.xFrameOptions.action !== "string" ||
          !VALID_X_FRAME_ACTIONS.has(options.xFrameOptions.action.toLowerCase())
        ) {
          throw new Error(
            `Invalid X-Frame-Options action "${String(options.xFrameOptions.action)}".`,
          );
        }
        action = options.xFrameOptions.action;
      }
    }
    headers.push(["X-Frame-Options", action.toUpperCase()]);
  }

  if (options.xPermittedCrossDomainPolicies !== false) {
    let permitted = "none";
    if (
      options.xPermittedCrossDomainPolicies !== undefined &&
      options.xPermittedCrossDomainPolicies !== true
    ) {
      if (!isPlainObject(options.xPermittedCrossDomainPolicies)) {
        throw new Error(
          'Invalid security headers option "xPermittedCrossDomainPolicies": expected boolean or object.',
        );
      }
      assertAllowedKeys(
        options.xPermittedCrossDomainPolicies as Record<string, unknown>,
        new Set(["permittedPolicies"]),
        "xPermittedCrossDomainPolicies",
      );
      if (options.xPermittedCrossDomainPolicies.permittedPolicies !== undefined) {
        if (
          typeof options.xPermittedCrossDomainPolicies.permittedPolicies !==
            "string" ||
          !VALID_PERMITTED_POLICIES.has(
            options.xPermittedCrossDomainPolicies.permittedPolicies,
          )
        ) {
          throw new Error(
            `Invalid X-Permitted-Cross-Domain-Policies "${String(options.xPermittedCrossDomainPolicies.permittedPolicies)}".`,
          );
        }
        permitted = options.xPermittedCrossDomainPolicies.permittedPolicies;
      }
    }
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
