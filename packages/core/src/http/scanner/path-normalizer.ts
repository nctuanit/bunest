import {
  RequestMethod,
  type RouteHttpMethod,
  type RouteInfo,
} from "../../common/index";
import type { CompiledMiddlewareConfig } from "../interfaces/http-bridge.interface";

const SIMPLE_PARAM_SEGMENT_RE = /^:[A-Za-z_][A-Za-z0-9_]*$/;
const PARAM_PREFIX_RE = /^:([A-Za-z_][A-Za-z0-9_]*)(.*)$/;

/**
 * Normalizes and joins path segments per RFC-001 §3:
 * - trims leading/trailing slashes and collapses consecutive slashes
 * - joins non-empty segments with `/` and prepends `/`
 * - root path is `"/"`; non-root paths never end with `/`
 */
export function normalizePath(
  ...segments: ReadonlyArray<string | undefined | null>
): string {
  const cleaned: string[] = [];

  for (let i = 0; i < segments.length; i++) {
    const raw = segments[i];
    if (!raw) continue;
    const collapsed = raw.replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
    if (collapsed.length > 0) {
      cleaned.push(collapsed);
    }
  }

  if (cleaned.length === 0) {
    return "/";
  }

  return `/${cleaned.join("/")}`;
}

/**
 * Produces the canonical collision key for a normalized route path (RFC-001 §3):
 * replaces every named parameter (`:id`, `:userId`, `:id?`, `:id(\d+)`) with
 * positional placeholder `:_` (preserving any optional `?` or regex suffix).
 */
export function canonicalizePath(normalizedPath: string): string {
  if (normalizedPath === "/") {
    return "/";
  }
  const segments = normalizedPath.slice(1).split("/");
  const canonicalSegments = segments.map((segment) => {
    const match = PARAM_PREFIX_RE.exec(segment);
    if (match) {
      return `:_` + (match[2] ?? "");
    }
    return segment;
  });
  return `/${canonicalSegments.join("/")}`;
}

/**
 * Determines whether a normalized path can be registered directly in
 * `Bun.serve({ routes })` per ADR-011 §2:
 * only static segments, simple `:param` segments, and/or a single trailing `/*`.
 */
export function isNativeBunRoutePath(normalizedPath: string): boolean {
  if (normalizedPath === "/") {
    return true;
  }

  const segments = normalizedPath.slice(1).split("/");
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment === undefined || segment.length === 0) {
      return false;
    }

    if (segment === "*") {
      // Only a single trailing wildcard `/*` is natively supported by Bun.serve({ routes })
      if (i !== segments.length - 1) {
        return false;
      }
      continue;
    }

    if (segment.startsWith(":")) {
      if (!SIMPLE_PARAM_SEGMENT_RE.test(segment)) {
        return false;
      }
      continue;
    }

    // Reject inline regex/glob/optional metacharacters in static segments
    if (
      segment.includes("*") ||
      segment.includes("?") ||
      segment.includes("(") ||
      segment.includes(")")
    ) {
      return false;
    }
  }

  return true;
}

/**
 * Matches a route path against a middleware or global-prefix-exclude pattern.
 */
export function matchesPathPattern(
  pattern: string,
  targetPath: string,
): boolean {
  const trimmed = pattern.trim();
  if (
    trimmed === "*" ||
    trimmed === "/*" ||
    trimmed === "(.*)" ||
    trimmed === "/(.*)"
  ) {
    return true;
  }

  const normalizedPattern = normalizePath(trimmed);
  const normalizedTarget = normalizePath(targetPath);

  if (normalizedPattern === normalizedTarget) {
    return true;
  }

  const patternSegments =
    normalizedPattern === "/" ? [] : normalizedPattern.slice(1).split("/");
  const targetSegments =
    normalizedTarget === "/" ? [] : normalizedTarget.slice(1).split("/");

  for (let i = 0; i < patternSegments.length; i++) {
    const pSeg = patternSegments[i];
    if (pSeg === undefined) break;

    if (pSeg === "*" || pSeg === "(.*)") {
      // Trailing wildcard matches the prefix itself as well as any child path
      if (i === patternSegments.length - 1) {
        return true;
      }
      // Mid-pattern wildcard consumes one segment
      if (i >= targetSegments.length) {
        return false;
      }
      continue;
    }

    const tSeg = targetSegments[i];
    if (tSeg === undefined) {
      return false;
    }

    if (pSeg.startsWith(":") || tSeg.startsWith(":")) {
      continue;
    }

    if (pSeg !== tSeg) {
      return false;
    }
  }

  // Handle trailing wildcard when pattern has one extra `*` segment (e.g. `/users/*` matching `/users`)
  if (
    patternSegments.length === targetSegments.length + 1 &&
    (patternSegments[patternSegments.length - 1] === "*" ||
      patternSegments[patternSegments.length - 1] === "(.*)")
  ) {
    return true;
  }

  return patternSegments.length === targetSegments.length;
}

function methodMatches(
  ruleMethod: RequestMethod | RouteHttpMethod,
  routeMethod: RouteHttpMethod,
): boolean {
  if (ruleMethod === RequestMethod.ALL || routeMethod === "ALL") {
    return true;
  }
  return ruleMethod === routeMethod;
}

export function matchesRouteInfo(
  rule: string | RouteInfo,
  routeMethod: RouteHttpMethod,
  candidatePaths: readonly string[],
): boolean {
  if (typeof rule === "string") {
    return candidatePaths.some((p) => matchesPathPattern(rule, p));
  }
  if (!methodMatches(rule.method, routeMethod)) {
    return false;
  }
  return candidatePaths.some((p) => matchesPathPattern(rule.path, p));
}

export function matchesGlobalPrefixExclude(
  routeMethod: RouteHttpMethod,
  rawRoutePath: string,
  excludes: ReadonlyArray<string | RouteInfo> | undefined,
): boolean {
  if (!excludes || excludes.length === 0) {
    return false;
  }
  return excludes.some((rule) =>
    matchesRouteInfo(rule, routeMethod, [rawRoutePath]),
  );
}

/**
 * Determines at bootstrap whether a module middleware configuration applies to a route.
 */
export function matchesMiddlewareForRoute(
  config: CompiledMiddlewareConfig,
  routeMethod: RouteHttpMethod,
  fullPath: string,
  rawPathWithoutPrefix: string,
): boolean {
  const candidates =
    fullPath === rawPathWithoutPrefix
      ? [fullPath]
      : [fullPath, rawPathWithoutPrefix];

  if (config.include && config.include.length > 0) {
    const included = config.include.some((rule) =>
      matchesRouteInfo(rule, routeMethod, candidates),
    );
    if (!included) {
      return false;
    }
  }

  if (config.exclude && config.exclude.length > 0) {
    const excluded = config.exclude.some((rule) =>
      matchesRouteInfo(rule, routeMethod, candidates),
    );
    if (excluded) {
      return false;
    }
  }

  return true;
}
