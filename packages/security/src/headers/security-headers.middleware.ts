import {
  Inject,
  Injectable,
  Optional,
  type BunestMiddleware,
  type HttpSecurityHeadersOptions,
  type MiddlewareFunction,
  type NextFunction,
  type ResponseContext,
} from "@bunest/core";
import { compileSecurityHeaders } from "@bunest/core/http";

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

function serializeCspString(
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

function buildStaticHeaders(
  options: SecurityHeadersOptions,
): Array<[string, string]> {
  // Delegate standard Helmet headers to @bunest/http's shared compileSecurityHeaders()
  const httpOpts: HttpSecurityHeadersOptions = {
    xContentTypeOptions:
      options.contentTypeOptions === false
        ? false
        : options.contentTypeOptions === undefined ||
            options.contentTypeOptions === "nosniff"
          ? true
          : false,
    xFrameOptions:
      options.frameOptions === false
        ? false
        : { action: (options.frameOptions ?? "DENY").toLowerCase() as "deny" | "sameorigin" },
    referrerPolicy:
      options.referrerPolicy === false
        ? false
        : {
            policy: (options.referrerPolicy ?? "no-referrer") as NonNullable<
              Exclude<
                HttpSecurityHeadersOptions["referrerPolicy"],
                boolean | undefined
              >["policy"]
            >,
          },
    crossOriginOpenerPolicy:
      options.crossOriginOpenerPolicy === false
        ? false
        : {
            policy: (options.crossOriginOpenerPolicy ??
              "same-origin") as "same-origin" | "same-origin-allow-popups" | "unsafe-none",
          },
    crossOriginResourcePolicy:
      options.crossOriginResourcePolicy === false
        ? false
        : {
            policy: (options.crossOriginResourcePolicy ??
              "same-origin") as "same-origin" | "same-site" | "cross-origin",
          },
    xDnsPrefetchControl:
      options.dnsPrefetchControl === false
        ? false
        : { allow: options.dnsPrefetchControl === "on" },
    contentSecurityPolicy: false,
    strictTransportSecurity:
      options.strictTransportSecurity === false ||
      options.strictTransportSecurity === undefined
        ? false
        : options.strictTransportSecurity === true
          ? { maxAge: 15552000, includeSubDomains: true }
          : {
              maxAge: options.strictTransportSecurity.maxAge ?? 15552000,
              includeSubDomains:
                options.strictTransportSecurity.includeSubDomains !== false,
              preload: options.strictTransportSecurity.preload,
            },
    originAgentCluster: false,
    xDownloadOptions: false,
    xPermittedCrossDomainPolicies: false,
    xXssProtection: false,
    xPoweredBy: false,
  };

  const compiled = compileSecurityHeaders(httpOpts);
  const headers: Array<[string, string]> = compiled.headers.map(
    ([name, value]): [string, string] => [name, value],
  );

  if (
    typeof options.contentTypeOptions === "string" &&
    options.contentTypeOptions !== "nosniff"
  ) {
    headers.push(["X-Content-Type-Options", options.contentTypeOptions]);
  }
  if (options.contentSecurityPolicy) {
    headers.push([
      "Content-Security-Policy",
      serializeCspString(options.contentSecurityPolicy),
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
