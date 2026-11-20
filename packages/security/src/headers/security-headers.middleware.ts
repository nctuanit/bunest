import {
  Inject,
  Injectable,
  Optional,
  type BunestMiddleware,
  type MiddlewareFunction,
  type NextFunction,
  type ResponseContext,
} from "@bunest/common";

export const SECURITY_HEADERS_OPTIONS = Symbol.for(
  "bunest:security:headers_options",
);

export interface StrictTransportSecurityOptions {
  maxAge?: number;
  includeSubDomains?: boolean;
  preload?: boolean;
}

export interface SecurityHeadersOptions {
  contentTypeOptions?: false | string;
  frameOptions?: false | "DENY" | "SAMEORIGIN";
  referrerPolicy?: false | string;
  crossOriginOpenerPolicy?: false | string;
  crossOriginResourcePolicy?: false | string;
  dnsPrefetchControl?: false | "off" | "on";
  contentSecurityPolicy?: false | string | Record<string, string | string[]>;
  strictTransportSecurity?: false | true | StrictTransportSecurityOptions;
  permissionsPolicy?: false | string;
  hidePoweredBy?: boolean;
}

function serializeCsp(
  csp: string | Record<string, string | string[]>,
): string {
  if (typeof csp === "string") {
    return csp;
  }
  return Object.entries(csp)
    .map(([directive, value]) => {
      const joined = Array.isArray(value) ? value.join(" ") : value;
      return joined ? `${directive} ${joined}` : directive;
    })
    .join("; ");
}

function serializeHsts(
  hsts: true | StrictTransportSecurityOptions,
): string {
  if (hsts === true) {
    return "max-age=15552000; includeSubDomains";
  }
  const parts = [`max-age=${hsts.maxAge ?? 15552000}`];
  if (hsts.includeSubDomains !== false) {
    parts.push("includeSubDomains");
  }
  if (hsts.preload) {
    parts.push("preload");
  }
  return parts.join("; ");
}

function buildStaticHeaders(
  options: SecurityHeadersOptions,
): Array<[string, string]> {
  const headers: Array<[string, string]> = [];

  if (options.contentTypeOptions !== false) {
    headers.push([
      "X-Content-Type-Options",
      options.contentTypeOptions ?? "nosniff",
    ]);
  }
  if (options.frameOptions !== false) {
    headers.push(["X-Frame-Options", options.frameOptions ?? "DENY"]);
  }
  if (options.referrerPolicy !== false) {
    headers.push([
      "Referrer-Policy",
      options.referrerPolicy ?? "no-referrer",
    ]);
  }
  if (options.crossOriginOpenerPolicy !== false) {
    headers.push([
      "Cross-Origin-Opener-Policy",
      options.crossOriginOpenerPolicy ?? "same-origin",
    ]);
  }
  if (options.crossOriginResourcePolicy !== false) {
    headers.push([
      "Cross-Origin-Resource-Policy",
      options.crossOriginResourcePolicy ?? "same-origin",
    ]);
  }
  if (options.dnsPrefetchControl !== false) {
    headers.push([
      "X-DNS-Prefetch-Control",
      options.dnsPrefetchControl ?? "off",
    ]);
  }
  if (options.contentSecurityPolicy) {
    headers.push([
      "Content-Security-Policy",
      serializeCsp(options.contentSecurityPolicy),
    ]);
  }
  if (options.strictTransportSecurity) {
    headers.push([
      "Strict-Transport-Security",
      serializeHsts(options.strictTransportSecurity),
    ]);
  }
  if (options.permissionsPolicy) {
    headers.push(["Permissions-Policy", options.permissionsPolicy]);
  }

  return headers;
}

/**
 * Creates a lightweight security headers middleware function with safe defaults.
 */
export function createSecurityHeadersMiddleware(
  options: SecurityHeadersOptions = {},
): MiddlewareFunction {
  const staticHeaders = buildStaticHeaders(options);
  const hidePoweredBy = options.hidePoweredBy ?? true;

  return (_req: Request, res: ResponseContext, next: NextFunction) => {
    for (const [name, value] of staticHeaders) {
      res.header(name, value);
    }
    if (hidePoweredBy) {
      res.removeHeader("X-Powered-By");
    }
    return next();
  };
}

/**
 * Injectable security headers middleware compatible with `MiddlewareConsumer.apply()`
 * and `app.use()`.
 */
@Injectable()
export class SecurityHeadersMiddleware implements BunestMiddleware {
  private readonly middlewareFn: MiddlewareFunction;

  constructor(
    @Optional()
    @Inject(SECURITY_HEADERS_OPTIONS)
    options: SecurityHeadersOptions = {},
  ) {
    this.middlewareFn = createSecurityHeadersMiddleware(options);
  }

  use(req: Request, res: ResponseContext, next: NextFunction) {
    return this.middlewareFn(req, res, next);
  }
}
