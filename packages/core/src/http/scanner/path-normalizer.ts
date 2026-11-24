import {
  RequestMethod,
  type RouteHttpMethod,
  type RouteInfo,
  VERSION_NEUTRAL,
  type VersionValue,
} from "../../common/index";
import type { CompiledMiddlewareConfig } from "../interfaces/http-bridge.interface";
import { normalizeVersionValue } from "./version-resolver";

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
    if (/^\*[A-Za-z_][A-Za-z0-9_]*$/.test(segment)) {
      return "*";
    }
    if (/^\{\*[A-Za-z_][A-Za-z0-9_]*\}$/.test(segment)) {
      return "{*}";
    }
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

    // Reject inline regex/glob/optional/sub-segment param/percent metacharacters in static segments
    if (
      segment.includes("*") ||
      segment.includes("?") ||
      segment.includes("(") ||
      segment.includes(")") ||
      segment.includes("{") ||
      segment.includes("}") ||
      segment.includes(":") ||
      segment.includes("%")
    ) {
      return false;
    }
  }

  return true;
}

function isWildcardSegment(seg: string): boolean {
  return (
    seg === "*" ||
    seg === "(.*)" ||
    (seg.startsWith("*") && seg.length > 1) ||
    (seg.startsWith("{*") && seg.endsWith("}"))
  );
}

function segmentMatches(
  pSeg: string,
  tSeg: string,
  caseSensitive: boolean,
): boolean {
  if (SIMPLE_PARAM_SEGMENT_RE.test(pSeg)) {
    return true;
  }
  // Parameterized segment with literal suffix/prefix, e.g. `:id.json`
  const paramMatch = PARAM_PREFIX_RE.exec(pSeg);
  if (paramMatch && paramMatch[2]) {
    const suffix = paramMatch[2];
    const cmpTarget = caseSensitive ? tSeg : tSeg.toLowerCase();
    const cmpSuffix = caseSensitive ? suffix : suffix.toLowerCase();
    return cmpTarget.length > cmpSuffix.length && cmpTarget.endsWith(cmpSuffix);
  }
  if (caseSensitive) {
    return pSeg === tSeg;
  }
  return pSeg.toLowerCase() === tSeg.toLowerCase();
}

/**
 * Matches a route path against a middleware or global-prefix-exclude pattern.
 */
export function matchesPathPattern(
  pattern: string,
  targetPath: string,
  caseSensitive = false,
): boolean {
  const trimmed = pattern.trim();
  if (
    trimmed === "*" ||
    trimmed === "/*" ||
    trimmed === "(.*)" ||
    trimmed === "/(.*)" ||
    /^\/*(?:\*[A-Za-z0-9_]+|\{\*[A-Za-z0-9_]+\})$/.test(trimmed)
  ) {
    return true;
  }

  const normalizedPattern = normalizePath(trimmed);
  const normalizedTarget = normalizePath(targetPath);

  if (
    caseSensitive
      ? normalizedPattern === normalizedTarget
      : normalizedPattern.toLowerCase() === normalizedTarget.toLowerCase()
  ) {
    return true;
  }

  const patternSegments =
    normalizedPattern === "/" ? [] : normalizedPattern.slice(1).split("/");
  const targetSegments =
    normalizedTarget === "/" ? [] : normalizedTarget.slice(1).split("/");

  for (let i = 0; i < patternSegments.length; i++) {
    const pSeg = patternSegments[i];
    if (pSeg === undefined) break;

    if (isWildcardSegment(pSeg)) {
      if (i >= targetSegments.length) {
        return false;
      }
      // Trailing wildcard matches one or more child segments (not the parent path itself)
      if (i === patternSegments.length - 1) {
        return true;
      }
      continue;
    }

    const tSeg = targetSegments[i];
    if (tSeg === undefined) {
      return false;
    }

    if (!segmentMatches(pSeg, tSeg, caseSensitive)) {
      return false;
    }
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

export type VersionedRouteRule = RouteInfo & { readonly version?: VersionValue };

function isPlainStaticPrefix(pattern: string): boolean {
  const trimmed = pattern.trim();
  return (
    trimmed.length > 0 &&
    !trimmed.includes("*") &&
    !trimmed.includes(":") &&
    !trimmed.includes("{") &&
    !trimmed.includes("}") &&
    !trimmed.includes("(") &&
    !trimmed.includes(")")
  );
}

export function matchesStringPrefixMount(
  pattern: string,
  targetPath: string,
  caseSensitive = false,
): boolean {
  if (!isPlainStaticPrefix(pattern)) {
    return false;
  }
  const normPat = normalizePath(pattern);
  const normTarget = normalizePath(targetPath);
  const p = caseSensitive ? normPat : normPat.toLowerCase();
  const t = caseSensitive ? normTarget : normTarget.toLowerCase();
  if (p === "/") return true;
  return t === p || t.startsWith(`${p}/`);
}

export function versionsMatchRule(
  ruleVersion: VersionValue | undefined,
  candidateVersions: readonly (string | typeof VERSION_NEUTRAL)[] | undefined,
): boolean {
  if (ruleVersion === undefined) {
    return true;
  }
  if (!candidateVersions || candidateVersions.length === 0) {
    const allowed = normalizeVersionValue(ruleVersion);
    return allowed ? allowed.includes(VERSION_NEUTRAL) : false;
  }
  const allowed = normalizeVersionValue(ruleVersion);
  if (!allowed || allowed.length === 0) {
    return false;
  }
  for (const v of candidateVersions) {
    if (allowed.includes(v)) {
      return true;
    }
  }
  return false;
}

export function matchesRouteInfo(
  rule: string | VersionedRouteRule,
  routeMethod: RouteHttpMethod,
  candidatePaths: readonly string[],
  routeVersions?: readonly (string | typeof VERSION_NEUTRAL)[],
  options?: { allowStringPrefixMount?: boolean },
): boolean {
  if (typeof rule === "string") {
    return candidatePaths.some(
      (p) =>
        matchesPathPattern(rule, p) ||
        (options?.allowStringPrefixMount === true &&
          matchesStringPrefixMount(rule, p)),
    );
  }
  if (!methodMatches(rule.method, routeMethod)) {
    return false;
  }
  if (
    rule.version !== undefined &&
    routeVersions !== undefined &&
    !versionsMatchRule(rule.version, routeVersions)
  ) {
    return false;
  }
  const allowPrefix =
    options?.allowStringPrefixMount === true &&
    rule.method === RequestMethod.ALL &&
    isPlainStaticPrefix(rule.path);
  return candidatePaths.some(
    (p) =>
      matchesPathPattern(rule.path, p) ||
      (allowPrefix && matchesStringPrefixMount(rule.path, p)),
  );
}

export function matchesGlobalPrefixExclude(
  routeMethod: RouteHttpMethod,
  rawRoutePath: string,
  excludes: ReadonlyArray<string | RouteInfo> | undefined,
): boolean {
  if (!excludes || excludes.length === 0) {
    return false;
  }
  return excludes.some((rule) => {
    if (matchesRouteInfo(rule, routeMethod, [rawRoutePath])) {
      return true;
    }
    // Optional wildcard group like `reports/{*path}` also excludes the parent `/reports`
    const rawRulePath = typeof rule === "string" ? rule : rule.path;
    const stripped = rawRulePath.replace(/\/?\{\*[^}]+\}$/, "");
    if (stripped !== rawRulePath) {
      const parentRule =
        typeof rule === "string" ? stripped || "/" : { ...rule, path: stripped || "/" };
      return matchesRouteInfo(parentRule, routeMethod, [rawRoutePath]);
    }
    return false;
  });
}

export type MiddlewareRouteMatchMode = "skip" | "always" | "runtime";

export function evaluateMiddlewareForRoute(
  config: CompiledMiddlewareConfig,
  routeMethod: RouteHttpMethod,
  fullPath: string,
  rawPathWithoutPrefix: string,
  routeVersions?: readonly (string | typeof VERSION_NEUTRAL)[],
  isRuntimeVersioningActive = false,
): MiddlewareRouteMatchMode {
  const candidates =
    fullPath === rawPathWithoutPrefix
      ? [fullPath]
      : [fullPath, rawPathWithoutPrefix];
  const isDynamicRoute =
    fullPath.includes(":") || fullPath.includes("*") || fullPath.includes("{");

  let needsRuntimeCheck = false;

  if (config.include && config.include.length > 0) {
    let matchedInclude = false;
    for (const rule of config.include) {
      if (
        matchesRouteInfo(rule, routeMethod, candidates, routeVersions, {
          allowStringPrefixMount: true,
        })
      ) {
        matchedInclude = true;
        if (
          isRuntimeVersioningActive &&
          typeof rule !== "string" &&
          (rule as VersionedRouteRule).version !== undefined
        ) {
          needsRuntimeCheck = true;
        }
        break;
      }
      // A plain static ALL mount like `shop/admin` (normalized by MiddlewareConsumer to
      // `{ path: '/shop/admin', method: ALL }`) can match runtime requests served by a dynamic route like `shop/:id`
      const rulePathStr = typeof rule === "string" ? rule : rule.path;
      const isPlainAllRule =
        typeof rule === "string" || rule.method === RequestMethod.ALL;
      if (isDynamicRoute && isPlainAllRule && isPlainStaticPrefix(rulePathStr)) {
        const ruleSegs = normalizePath(rulePathStr).slice(1).split("/").filter(Boolean);
        for (const cand of candidates) {
          const candSegs = normalizePath(cand).slice(1).split("/").filter(Boolean);
          const minLen = Math.min(ruleSegs.length, candSegs.length);
          let prefixCompatible = minLen > 0;
          for (let i = 0; i < minLen; i++) {
            const rs = ruleSegs[i]!;
            const cs = candSegs[i]!;
            if (
              cs.startsWith(":") ||
              cs.includes(":") ||
              cs.includes("*") ||
              cs.includes("{") ||
              rs.toLowerCase() === cs.toLowerCase()
            ) {
              continue;
            }
            prefixCompatible = false;
            break;
          }
          if (prefixCompatible) {
            matchedInclude = true;
            needsRuntimeCheck = true;
            break;
          }
        }
        if (matchedInclude) break;
      }
    }
    if (!matchedInclude) {
      return "skip";
    }
  }

  if (config.exclude && config.exclude.length > 0) {
    for (const rule of config.exclude) {
      const ruleObj =
        typeof rule === "string" ? undefined : (rule as VersionedRouteRule);
      const hasRuleVersion = ruleObj?.version !== undefined;

      // Under runtime versioning, a versioned exclude (e.g. exclude({ path: 'reports', version: '1' }))
      // must be evaluated per request against the incoming request's extracted version.
      if (isRuntimeVersioningActive && hasRuleVersion) {
        if (matchesRouteInfo({ ...ruleObj!, version: undefined }, routeMethod, candidates)) {
          needsRuntimeCheck = true;
        }
        continue;
      }

      if (matchesRouteInfo(rule, routeMethod, candidates, routeVersions)) {
        // On dynamic routes (e.g. `/statements/:id.pdf`), evaluate exclude at runtime
        // so malformed/line-terminator pathnames (`%0A`, `%0D`, `%E2%80%A8`, `%E2%80%A9`)
        // cannot bypass middleware via the exclude pattern.
        if (isDynamicRoute) {
          needsRuntimeCheck = true;
          continue;
        }
        return "skip";
      }
    }
  }

  return needsRuntimeCheck ? "runtime" : "always";
}

/**
 * Determines at bootstrap whether a module middleware configuration applies to a route.
 */
export function matchesMiddlewareForRoute(
  config: CompiledMiddlewareConfig,
  routeMethod: RouteHttpMethod,
  fullPath: string,
  rawPathWithoutPrefix: string,
  routeVersions?: readonly (string | typeof VERSION_NEUTRAL)[],
): boolean {
  return (
    evaluateMiddlewareForRoute(
      config,
      routeMethod,
      fullPath,
      rawPathWithoutPrefix,
      routeVersions,
      false,
    ) !== "skip"
  );
}
