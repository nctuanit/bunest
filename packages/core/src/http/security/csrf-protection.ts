import {
  ForbiddenException,
  RequestMethod,
  type CsrfProtectionOptions,
  type RouteInfo,
  VERSION_NEUTRAL,
  type VersioningOptions,
  type VersionValue,
} from "../../common/index";
import {
  extractRequestVersions,
  isRuntimeVersioning,
  normalizeVersionValue,
} from "../scanner/version-resolver";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function extractSerializedOrigin(parsed: URL): string | null {
  if (parsed.origin && parsed.origin !== "null") {
    return parsed.origin.toLowerCase();
  }
  if (parsed.protocol && parsed.host) {
    return `${parsed.protocol}//${parsed.host}`.toLowerCase();
  }
  return null;
}

function normalizeOrigin(raw: string): string {
  if (
    !/^[a-z][a-z0-9+.-]*:\/\/[^/?#\\@\s]+$/i.test(raw) ||
    raw.includes("*")
  ) {
    throw new Error(
      `Invalid trusted origin "${raw}": must be a serialized origin "scheme://host[:port]" without path, query, fragment, credentials, or wildcard.`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      `Invalid trusted origin "${raw}": expected scheme://host[:port].`,
    );
  }
  if (
    parsed.username !== "" ||
    parsed.password !== "" ||
    (parsed.pathname !== "/" && parsed.pathname !== "") ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    !parsed.host
  ) {
    throw new Error(
      `Invalid trusted origin "${raw}": must be a serialized origin "scheme://host[:port]" without path, query, fragment, or wildcard.`,
    );
  }
  const serialized = extractSerializedOrigin(parsed);
  if (!serialized) {
    throw new Error(
      `Invalid trusted origin "${raw}": expected scheme://host[:port].`,
    );
  }
  return serialized;
}

function isNonCanonicalPath(pathname: string): boolean {
  if (
    pathname.includes("//") ||
    pathname.includes(";") ||
    pathname.includes("\\") ||
    /[\x00-\x1f\x7f\u2028\u2029]/.test(pathname)
  ) {
    return true;
  }
  const lower = pathname.toLowerCase();
  if (
    lower.includes("%2f") ||
    lower.includes("%2e") ||
    lower.includes("%5c") ||
    lower.includes("%e2%80%a8") ||
    lower.includes("%e2%80%a9") ||
    /%(?:0[0-9a-f]|1[0-9a-f]|7f)/.test(lower)
  ) {
    return true;
  }
  const segments = pathname.split("/");
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg === "." || seg === "..") {
      return true;
    }
  }
  return false;
}

function normalizeExcludeRoutePath(
  path: string,
  globalPrefix?: string,
): string {
  const clean = path.startsWith("/") ? path : `/${path}`;
  if (!globalPrefix) {
    return clean;
  }
  const prefix = globalPrefix.startsWith("/")
    ? globalPrefix.replace(/\/+$/, "")
    : `/${globalPrefix.replace(/\/+$/, "")}`;
  if (!prefix || prefix === "/") {
    return clean;
  }
  if (clean === prefix || clean.startsWith(`${prefix}/`)) {
    return clean;
  }
  return clean === "/" ? prefix : `${prefix}${clean}`;
}

function compileExcludePattern(pattern: string): (pathname: string) => boolean {
  const starIdx = pattern.indexOf("*");
  if (starIdx === -1) {
    return (pathname: string) => pathname === pattern;
  }
  // Wildcard suffix like `/api/webhooks/*path` or `/api/hooks/github/*`:
  // must match at least one non-empty character/segment after the prefix
  // (never matches the parent path or trailing slash alone).
  const prefix = pattern.slice(0, starIdx);
  return (pathname: string) => {
    if (!pathname.startsWith(prefix)) return false;
    const rest = pathname.slice(prefix.length);
    return rest.length > 0 && rest !== "/";
  };
}

function isRouteExcludedFromGlobalPrefix(
  rawPath: string,
  globalPrefixExclude?: readonly (string | RouteInfo)[],
): boolean {
  if (!globalPrefixExclude || globalPrefixExclude.length === 0) {
    return false;
  }
  const clean = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  const matcher = compileExcludePattern(clean);
  for (const entry of globalPrefixExclude) {
    const p = typeof entry === "string" ? entry : entry.path;
    const norm = p.startsWith("/") ? p : `/${p}`;
    if (norm === clean || matcher(norm)) {
      return true;
    }
  }
  return false;
}

export interface CompiledCsrfProtection {
  readonly evaluate: (req: Request, pathname: string) => void;
}

/**
 * Compiles NestJS v12 Fetch-Metadata CSRF protection (`Sec-Fetch-Site` with
 * `Origin`/`Host` fallback, modeled on Go's `net/http.CrossOriginProtection`).
 */
export function compileCsrfProtection(
  options: CsrfProtectionOptions<Request> = {},
  globalPrefix?: string,
  globalPrefixExclude?: readonly (string | RouteInfo)[],
  versioning?: VersioningOptions,
): CompiledCsrfProtection {
  const runtimeVersioning = isRuntimeVersioning(versioning);
  const trustedOrigins = new Set<string>();
  if (options.trustedOrigins) {
    for (const origin of options.trustedOrigins) {
      trustedOrigins.add(normalizeOrigin(origin));
    }
  }

  const excludePredicate =
    typeof options.exclude === "function" ? options.exclude : undefined;

  const excludeRoutes: Array<{
    match: (pathname: string) => boolean;
    method?: string;
    versions?: readonly (string | typeof VERSION_NEUTRAL)[];
  }> = [];
  if (Array.isArray(options.exclude)) {
    for (const entry of options.exclude) {
      if (typeof entry === "string") {
        excludeRoutes.push({
          match: compileExcludePattern(
            normalizeExcludeRoutePath(entry, globalPrefix),
          ),
        });
        if (
          globalPrefix &&
          isRouteExcludedFromGlobalPrefix(entry, globalPrefixExclude)
        ) {
          excludeRoutes.push({
            match: compileExcludePattern(
              entry.startsWith("/") ? entry : `/${entry}`,
            ),
          });
        }
      } else {
        const info = entry as RouteInfo & { version?: VersionValue };
        const rawMethod = String(info.method).toUpperCase();
        const method =
          info.method === RequestMethod.ALL || rawMethod === "ALL"
            ? undefined
            : rawMethod;
        const versions =
          info.version !== undefined
            ? normalizeVersionValue(info.version)
            : undefined;
        excludeRoutes.push({
          match: compileExcludePattern(
            normalizeExcludeRoutePath(info.path, globalPrefix),
          ),
          method,
          versions,
        });
        if (
          globalPrefix &&
          isRouteExcludedFromGlobalPrefix(info.path, globalPrefixExclude)
        ) {
          excludeRoutes.push({
            match: compileExcludePattern(
              info.path.startsWith("/") ? info.path : `/${info.path}`,
            ),
            method,
            versions,
          });
        }
      }
    }
  }

  const isExcluded = (
    req: Request,
    pathname: string,
    method: string,
  ): boolean => {
    if (excludePredicate) {
      return excludePredicate(req) === true;
    }
    if (excludeRoutes.length === 0) {
      return false;
    }
    if (isNonCanonicalPath(pathname)) {
      return false;
    }
    const reqVersions =
      runtimeVersioning && versioning
        ? extractRequestVersions(req, versioning)
        : undefined;
    for (let i = 0; i < excludeRoutes.length; i++) {
      const rule = excludeRoutes[i];
      if (!rule) continue;
      if (!rule.match(pathname)) continue;
      if (rule.method !== undefined && rule.method !== method) continue;
      if (rule.versions !== undefined && runtimeVersioning) {
        if (!reqVersions || reqVersions.length === 0) {
          if (!rule.versions.includes(VERSION_NEUTRAL)) continue;
        } else if (!reqVersions.some((v) => rule.versions!.includes(v))) {
          continue;
        }
      }
      return true;
    }
    return false;
  };

  return {
    evaluate(req: Request, pathname: string): void {
      const method = req.method.toUpperCase();
      if (SAFE_METHODS.has(method)) {
        return;
      }

      const secFetchSite = req.headers
        .get("sec-fetch-site")
        ?.trim()
        .toLowerCase();
      const originHeader = req.headers.get("origin")?.trim();

      // Trusted origin exemption applies before rejection
      if (originHeader && trustedOrigins.size > 0) {
        try {
          const normalized = extractSerializedOrigin(new URL(originHeader));
          if (normalized && trustedOrigins.has(normalized)) {
            return;
          }
        } catch {
          // Malformed origin header cannot match trustedOrigins
        }
      }

      if (secFetchSite) {
        if (secFetchSite === "same-origin" || secFetchSite === "none") {
          return;
        }
        if (isExcluded(req, pathname, method)) {
          return;
        }
        throw new ForbiddenException(
          `Cross-origin request rejected (Sec-Fetch-Site: ${secFetchSite})`,
        );
      }

      // No Sec-Fetch-Site: fall back to Origin vs Host comparison
      if (!originHeader) {
        // Non-browser client (no Sec-Fetch-Site and no Origin)
        return;
      }

      if (originHeader.toLowerCase() !== "null") {
        const hostHeader = req.headers.get("host")?.trim().toLowerCase();
        if (hostHeader && !/[/?#\\@\s]/.test(hostHeader)) {
          try {
            const parsedOrigin = new URL(originHeader);
            const originHost = parsedOrigin.host.toLowerCase();
            if (originHost === hostHeader) {
              return;
            }
            // Compare with scheme's default port normalized (e.g. https://app.example vs app.example:443)
            const normalizedHost = new URL(
              `${parsedOrigin.protocol}//${hostHeader}`,
            ).host.toLowerCase();
            if (originHost === normalizedHost) {
              return;
            }
          } catch {
            // Invalid Origin URL falls through to reject
          }
        }
      }

      if (isExcluded(req, pathname, method)) {
        return;
      }

      throw new ForbiddenException(
        "Cross-origin request rejected (Origin does not match Host)",
      );
    },
  };
}
