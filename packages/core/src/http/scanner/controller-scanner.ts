import {
  escapeRegExp,
  type ExceptionFilterLike,
  type GuardLike,
  type HeaderMetadata,
  type InterceptorLike,
  type LoggerService,
  MetadataRegistry,
  type MiddlewareLike,
  type ParameterMetadata,
  type PipeLike,
  type RedirectMetadata,
  type RouteConflictPolicy,
  type RouteConflictPolicyLevel,
  type RouteDefinition,
  type RouteResolutionStrategy,
  type Scope,
  type SseOptions,
  ternary,
  toArray,
  type Type,
  VERSION_NEUTRAL,
  type VersionValue,
  type VersioningOptions,
  VersioningType,
} from "../../common/index";
import {
  DuplicateRouteException,
  InvalidControllerException,
  InvalidRouteException,
} from "../errors/routing.errors";
import type { GlobalPrefixOptions } from "../interfaces/http-bridge.interface";
import {
  canonicalizePath,
  isNativeBunRoutePath,
  matchesGlobalPrefixExclude,
  normalizePath,
} from "./path-normalizer";
import {
  formatUriVersionSegment,
  formatVersionCollisionKey,
  formatVersionLabel,
  normalizeVersionValue,
  type NormalizedVersionToken,
} from "./version-resolver";

export interface ScannedRoute extends RouteDefinition {
  readonly rawPathWithoutPrefix: string;
  readonly canonicalPath: string;
  readonly host?: string | RegExp | Array<string | RegExp>;
  readonly scope?: Scope;
  readonly versions?: readonly NormalizedVersionToken[];
  readonly handlerFn: Function;
  readonly isNativePathEligible: boolean;
  readonly controllerMiddlewares: readonly MiddlewareLike[];
  readonly methodMiddlewares: readonly MiddlewareLike[];
  readonly controllerGuards: readonly GuardLike[];
  readonly methodGuards: readonly GuardLike[];
  readonly controllerPipes: readonly PipeLike[];
  readonly methodPipes: readonly PipeLike[];
  readonly controllerInterceptors: readonly InterceptorLike[];
  readonly methodInterceptors: readonly InterceptorLike[];
  readonly controllerFilters: readonly ExceptionFilterLike[];
  readonly methodFilters: readonly ExceptionFilterLike[];
}

export interface ScanControllersOptions {
  readonly globalPrefix?: string | readonly string[];
  readonly globalPrefixOptions?: GlobalPrefixOptions;
  readonly controllerPrefixes?: ReadonlyMap<
    Type<unknown>,
    string | readonly string[]
  >;
  readonly versioning?: VersioningOptions;
  readonly routeConflictPolicy?: RouteConflictPolicy;
  readonly routeResolutionStrategy?: RouteResolutionStrategy;
  readonly logger?: LoggerService;
  readonly preserveDuplicates?: boolean;
}

function normalizeConflictLevels(policy: RouteConflictPolicy | undefined): {
  duplicate: RouteConflictPolicyLevel;
  shadow: RouteConflictPolicyLevel;
} {
  if (!policy || policy === "throw") {
    return { duplicate: "error", shadow: "off" };
  }
  if (policy === "warn") {
    return { duplicate: "warn", shadow: "off" };
  }
  if (policy === "allow") {
    return { duplicate: "off", shadow: "off" };
  }
  return {
    duplicate: policy.duplicate ?? "off",
    shadow: policy.shadow ?? "off",
  };
}

function segmentKindRank(segment: string): number {
  if (segment === "*" || segment.includes("*")) return 3;
  const requiredPart = segment.replace(/\{[^}]*\}/g, "");
  if (/^:[A-Za-z0-9_]+(?:\([^)]*\))?\??$/.test(requiredPart)) return 2;
  if (requiredPart.includes(":")) return 1;
  if (segment.includes("{")) return 1;
  return 0;
}

function compareRouteSpecificity(a: ScannedRoute, b: ScannedRoute): number {
  const segA = a.fullPath.split("/").filter(Boolean);
  const segB = b.fullPath.split("/").filter(Boolean);
  const minLen = Math.min(segA.length, segB.length);
  for (let i = 0; i < minLen; i++) {
    const rankDiff = segmentKindRank(segA[i]!) - segmentKindRank(segB[i]!);
    if (rankDiff !== 0) {
      return rankDiff;
    }
  }
  if (segA.length === segB.length) {
    return 0;
  }
  // A shorter path ending in a wildcard (e.g. /files/*rest) can absorb longer paths
  // (/files/*rest/:action), so the longer path is more specific.
  if (minLen > 0 && segmentKindRank(segA[minLen - 1]!) === 3) {
    return segB.length - segA.length;
  }
  // End-of-path has rank 0.5: static continuation (0) beats exact parent (0.5),
  // while exact parent (0.5) beats mixed (1), param (2), and wildcard (3).
  const rankA = segA.length > minLen ? segmentKindRank(segA[minLen]!) : 0.5;
  const rankB = segB.length > minLen ? segmentKindRank(segB[minLen]!) : 0.5;
  if (rankA !== rankB) {
    return rankA - rankB;
  }
  return segB.length - segA.length;
}

function expandOptionalGroups(pattern: string): string[] {
  const openIdx = pattern.indexOf("{");
  if (openIdx === -1) {
    const cleaned = pattern.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
    return [cleaned];
  }
  let depth = 0;
  let closeIdx = -1;
  for (let i = openIdx; i < pattern.length; i++) {
    if (pattern[i] === "{") depth++;
    else if (pattern[i] === "}") {
      depth--;
      if (depth === 0) {
        closeIdx = i;
        break;
      }
    }
  }
  if (closeIdx === -1) {
    return [pattern];
  }
  const before = pattern.slice(0, openIdx);
  const inside = pattern.slice(openIdx + 1, closeIdx);
  const after = pattern.slice(closeIdx + 1);
  const withoutGroup = expandOptionalGroups(before + after);
  const withGroup = expandOptionalGroups(before + inside + after);
  const out: string[] = [];
  for (const v of withGroup) {
    if (!out.includes(v)) out.push(v);
  }
  for (const v of withoutGroup) {
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

interface SegmentToken {
  readonly kind: "lit" | "param" | "wild";
  readonly value: string;
}

function tokenizeSegment(seg: string): SegmentToken[] {
  const tokens: SegmentToken[] = [];
  let i = 0;
  let litBuf = "";
  const flushLit = () => {
    if (litBuf.length > 0) {
      tokens.push({ kind: "lit", value: litBuf });
      litBuf = "";
    }
  };
  while (i < seg.length) {
    const ch = seg[i]!;
    if (ch === "*") {
      flushLit();
      let j = i + 1;
      while (j < seg.length && /[A-Za-z0-9_]/.test(seg[j]!)) j++;
      tokens.push({ kind: "wild", value: seg.slice(i, j) });
      i = j;
    } else if (ch === ":" && i + 1 < seg.length && /[A-Za-z0-9_]/.test(seg[i + 1]!)) {
      flushLit();
      let j = i + 1;
      while (j < seg.length && /[A-Za-z0-9_]/.test(seg[j]!)) j++;
      if (j < seg.length && seg[j] === "(") {
        let d = 0;
        while (j < seg.length) {
          if (seg[j] === "(") d++;
          else if (seg[j] === ")") {
            d--;
            if (d === 0) {
              j++;
              break;
            }
          }
          j++;
        }
      }
      if (j < seg.length && seg[j] === "?") j++;
      tokens.push({ kind: "param", value: seg.slice(i, j) });
      i = j;
    } else {
      litBuf += ch;
      i++;
    }
  }
  flushLit();
  return tokens;
}

function segmentMatchesLiteral(tokens: readonly SegmentToken[], literal: string): boolean {
  let re = "^";
  for (const t of tokens) {
    if (t.kind === "lit") re += escapeRegExp(t.value);
    else if (t.kind === "param") re += "[^/]+";
    else re += ".*";
  }
  re += "$";
  return new RegExp(re).test(literal);
}

function segmentsOverlap(segA: string, segB: string): boolean {
  if (segA === segB) return true;
  const tokA = tokenizeSegment(segA);
  const tokB = tokenizeSegment(segB);
  const aIsLit = tokA.every((t) => t.kind === "lit");
  const bIsLit = tokB.every((t) => t.kind === "lit");
  if (aIsLit && bIsLit) return segA === segB;
  if (aIsLit) return segmentMatchesLiteral(tokB, segA);
  if (bIsLit) return segmentMatchesLiteral(tokA, segB);

  const aIsWildOrPlainParam =
    tokA.length === 1 && (tokA[0]!.kind === "param" || tokA[0]!.kind === "wild");
  const bIsWildOrPlainParam =
    tokB.length === 1 && (tokB[0]!.kind === "param" || tokB[0]!.kind === "wild");
  if (aIsWildOrPlainParam || bIsWildOrPlainParam) return true;

  // Both are mixed segments: check leading and trailing literal compatibility
  const aFirst = tokA[0];
  const bFirst = tokB[0];
  if (aFirst?.kind === "lit" && bFirst?.kind === "lit") {
    if (
      !aFirst.value.startsWith(bFirst.value) &&
      !bFirst.value.startsWith(aFirst.value)
    ) {
      return false;
    }
  }
  const aLast = tokA[tokA.length - 1];
  const bLast = tokB[tokB.length - 1];
  if (aLast?.kind === "lit" && bLast?.kind === "lit") {
    if (
      !aLast.value.endsWith(bLast.value) &&
      !bLast.value.endsWith(aLast.value)
    ) {
      return false;
    }
  }
  return true;
}

function concretePatternsOverlap(a: string, b: string): boolean {
  const segsA = a.split("/").filter(Boolean);
  const segsB = b.split("/").filter(Boolean);
  const memo = new Map<string, boolean>();

  const dfs = (i: number, j: number): boolean => {
    if (i === segsA.length && j === segsB.length) return true;
    if (i === segsA.length || j === segsB.length) return false;
    const key = `${i}:${j}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;

    const sa = segsA[i]!;
    const sb = segsB[j]!;
    const aHasWild = sa.includes("*");
    const bHasWild = sb.includes("*");

    let result = false;
    if (aHasWild || bHasWild) {
      // Wildcard segment matches >= 1 segment, and must respect any leading literal before '*'
      const wildCompatible = segmentsOverlap(sa, sb);
      if (wildCompatible) {
        // Consume 1 segment on both, or wildcard consumes another segment from the other side
        result =
          dfs(i + 1, j + 1) ||
          (aHasWild && j + 1 < segsB.length && dfs(i, j + 1)) ||
          (bHasWild && i + 1 < segsA.length && dfs(i + 1, j));
      }
    } else if (segmentsOverlap(sa, sb)) {
      result = dfs(i + 1, j + 1);
    }

    memo.set(key, result);
    return result;
  };

  return dfs(0, 0);
}

function canPatternsOverlap(patternA: string, patternB: string): boolean {
  const varsA = expandOptionalGroups(patternA);
  const varsB = expandOptionalGroups(patternB);
  for (const va of varsA) {
    for (const vb of varsB) {
      if (concretePatternsOverlap(va, vb)) {
        return true;
      }
    }
  }
  return false;
}

function expandHostOptionalGroups(pattern: string): string[] {
  const openIdx = pattern.indexOf("{");
  if (openIdx === -1) return [pattern];
  const closeIdx = pattern.indexOf("}", openIdx + 1);
  if (closeIdx === -1) return [pattern];
  const before = pattern.slice(0, openIdx);
  const inside = pattern.slice(openIdx + 1, closeIdx);
  const after = pattern.slice(closeIdx + 1);
  return [
    ...expandHostOptionalGroups(before + inside + after),
    ...expandHostOptionalGroups(before + after),
  ];
}

function hostPatternMatchesString(pattern: string, target: string): boolean {
  const varsA = expandHostOptionalGroups(pattern);
  const varsB = expandHostOptionalGroups(target);
  for (const va of varsA) {
    for (const vb of varsB) {
      const pLabels = va.toLowerCase().split(".");
      const tLabels = vb.toLowerCase().split(".");
      if (pLabels.length !== tLabels.length) continue;
      let match = true;
      for (let i = 0; i < pLabels.length; i++) {
        const pl = pLabels[i]!;
        const tl = tLabels[i]!;
        if (pl.startsWith(":") || tl.startsWith(":")) continue;
        if (pl !== tl) {
          match = false;
          break;
        }
      }
      if (match) return true;
    }
  }
  return false;
}

function singleHostsOverlap(
  a: string | RegExp,
  b: string | RegExp,
): boolean {
  if (typeof a === "string" && typeof b === "string") {
    return hostPatternMatchesString(a, b);
  }
  if (a instanceof RegExp && typeof b === "string") {
    const nonGlobal = new RegExp(a.source, a.flags.replace(/g/g, ""));
    for (const v of expandHostOptionalGroups(b)) {
      // For parameterized hosts like `:tenant.example.com`, substitute a sample label to test RegExp
      const sample = v.replace(/:[A-Za-z0-9_]+/g, "sample");
      if (nonGlobal.test(v) || nonGlobal.test(sample)) return true;
    }
    return false;
  }
  if (typeof a === "string" && b instanceof RegExp) {
    const nonGlobal = new RegExp(b.source, b.flags.replace(/g/g, ""));
    for (const v of expandHostOptionalGroups(a)) {
      const sample = v.replace(/:[A-Za-z0-9_]+/g, "sample");
      if (nonGlobal.test(v) || nonGlobal.test(sample)) return true;
    }
    return false;
  }
  if (a instanceof RegExp && b instanceof RegExp) {
    return a.source === b.source && a.flags === b.flags;
  }
  return false;
}

function compareHostConstraints(
  hostA: string | RegExp | Array<string | RegExp> | undefined,
  hostB: string | RegExp | Array<string | RegExp> | undefined,
): { same: boolean; overlaps: boolean } {
  const listA = toArray(hostA);
  const listB = toArray(hostB);

  if (listA.length === 0 && listB.length === 0) {
    return { same: true, overlaps: true };
  }
  if (listA.length === 0 || listB.length === 0) {
    // Hostless vs host-specific: overlaps (shadow), NOT same
    return { same: false, overlaps: true };
  }

  const toExactHostKey = (item: string | RegExp): string =>
    item instanceof RegExp
      ? `regex:${item.source}/${item.flags}`
      : `host:${item
          .split(".")
          .map((label) => (label.startsWith(":") ? ":_" : label))
          .join(".")}`;

  const keysA = new Set(listA.map(toExactHostKey));
  const keysB = new Set(listB.map(toExactHostKey));
  let same = keysA.size === keysB.size;
  if (same) {
    for (const k of keysA) {
      if (!keysB.has(k)) {
        same = false;
        break;
      }
    }
  }
  if (same) {
    return { same: true, overlaps: true };
  }

  for (const ha of listA) {
    for (const hb of listB) {
      if (singleHostsOverlap(ha, hb)) {
        return { same: false, overlaps: true };
      }
    }
  }
  return { same: false, overlaps: false };
}

function compareRouteVersions(
  vA: readonly (string | typeof VERSION_NEUTRAL)[] | undefined,
  vB: readonly (string | typeof VERSION_NEUTRAL)[] | undefined,
): { same: boolean; overlaps: boolean } {
  if (!vA && !vB) return { same: true, overlaps: true };
  if (!vA || !vB) return { same: false, overlaps: true };
  const setA = new Set(vA);
  const setB = new Set(vB);
  let same = setA.size === setB.size;
  if (same) {
    for (const v of setA) {
      if (!setB.has(v)) {
        same = false;
        break;
      }
    }
  }
  if (same) return { same: true, overlaps: true };
  // Sharing an explicit concrete version string (e.g. "1" vs ["1", "2"]) is a duplicate conflict
  for (const v of setA) {
    if (v !== VERSION_NEUTRAL && setB.has(v)) {
      return { same: true, overlaps: true };
    }
  }
  if (setA.has(VERSION_NEUTRAL) || setB.has(VERSION_NEUTRAL)) {
    return { same: false, overlaps: true };
  }
  return { same: false, overlaps: false };
}

function normalizeHostCollisionKeys(
  host: string | RegExp | Array<string | RegExp> | undefined,
): string[] {
  if (host === undefined) {
    return [""];
  }
  const list = Array.isArray(host) ? host : [host];
  if (list.length === 0) {
    return [""];
  }
  return list.map((item) => {
    if (item instanceof RegExp) {
      return `regex:${item.source}/${item.flags}`;
    }
    // Canonicalize host param names (`:tenant.example.com` -> `:_.example.com`)
    return `host:${item
      .toLowerCase()
      .split(".")
      .map((label) => (label.startsWith(":") ? ":_" : label))
      .join(".")}`;
  });
}

function toStringArray(value: string | readonly string[]): string[] {
  if (Array.isArray(value)) {
    return value.length > 0 ? [...value] : [""];
  }
  return [value as string];
}

function resolveControllerPrefixesForClass(
  controller: Type<unknown>,
  controllerPrefixes:
    ReadonlyMap<Type<unknown>, string | readonly string[]> | undefined,
): string[] {
  if (!controllerPrefixes || controllerPrefixes.size === 0) {
    return [""];
  }
  const entry = controllerPrefixes.get(controller);
  if (entry === undefined) {
    return [""];
  }
  return toStringArray(entry);
}

function assertUniqueParamIndices(
  controllerName: string,
  handlerKey: string | symbol,
  params: readonly ParameterMetadata[],
): void {
  const seen = new Set<number>();
  for (const param of params) {
    if (seen.has(param.index)) {
      throw new InvalidRouteException(
        `Duplicate parameter decorator on ${controllerName}.${String(handlerKey)} at parameter index ${param.index}.`,
      );
    }
    seen.add(param.index);
  }
}

function resolvePrecompiledRouteVersions(
  methodVersion: VersionValue | undefined,
  controllerVersion: VersionValue | undefined,
  versioning: VersioningOptions | undefined,
): readonly NormalizedVersionToken[] | undefined {
  if (!versioning) {
    return undefined;
  }
  if (methodVersion !== undefined) {
    return normalizeVersionValue(methodVersion) ?? [VERSION_NEUTRAL];
  }
  if (controllerVersion !== undefined) {
    return normalizeVersionValue(controllerVersion) ?? [VERSION_NEUTRAL];
  }
  if (versioning.defaultVersion !== undefined) {
    return (
      normalizeVersionValue(versioning.defaultVersion) ?? [VERSION_NEUTRAL]
    );
  }
  return [VERSION_NEUTRAL];
}

/**
 * Scans decorated `@Controller()` classes once at bootstrap using decorator-time
 * pre-indexed `PrecompiledControllerDescriptor`s from `@bunest/core`, expanding
 * multi-path controllers/methods, `RouterModule` controller prefixes, API Versioning
 * (`URI`, `HEADER`, `MEDIA_TYPE`, `CUSTOM`), normalizing paths, and failing fast on
 * duplicate/shadowed routes (RFC-001 & ADR-011).
 */
export function scanControllers(
  controllers: readonly Type<unknown>[],
  options: ScanControllersOptions = {},
): ScannedRoute[] {
  const scanned: ScannedRoute[] = [];
  const allDeclared: Array<{ entry: ScannedRoute; versionLabel?: string }> = [];
  const exactRouteRegistry = new Set<string>();
  const versioning = options.versioning;
  const conflictLevels = normalizeConflictLevels(options.routeConflictPolicy);
  const resolutionStrategy = options.routeResolutionStrategy ?? "declaration";
  const globalPrefixes: string[] = toArray(options.globalPrefix).filter(
    (p): p is string => typeof p === "string" && p.trim().length > 0,
  );

  for (const controller of controllers) {
    if (typeof controller !== "function") {
      throw new InvalidControllerException(
        String(controller),
        `Invalid controller entry "${String(controller)}": expected a class constructor.`,
      );
    }

    const precompiled = MetadataRegistry.getPrecompiledController(controller);
    if (!precompiled) {
      throw new InvalidControllerException(controller.name || "AnonymousClass");
    }

    const controllerMeta = precompiled.metadata;
    const controllerName = controller.name || "AnonymousController";
    const routerPrefixes = resolveControllerPrefixesForClass(
      controller,
      options.controllerPrefixes,
    );
    const controllerPaths = precompiled.paths;
    const controllerMiddlewares = precompiled.controllerMiddlewares;
    const controllerGuards = precompiled.controllerGuards;
    const controllerPipes = precompiled.controllerPipes;
    const controllerInterceptors = precompiled.controllerInterceptors;
    const controllerFilters = precompiled.controllerFilters;
    const hostKeys = normalizeHostCollisionKeys(controllerMeta.host);

    for (const routeMeta of precompiled.routes) {
      if (typeof routeMeta.handlerFn !== "function") {
        throw new InvalidRouteException(
          `Route handler ${controllerName}.${String(routeMeta.handlerKey)} is not a function.`,
        );
      }
      const handlerFn = routeMeta.handlerFn;
      const parameters = routeMeta.parameters;
      assertUniqueParamIndices(
        controllerName,
        routeMeta.handlerKey,
        parameters,
      );

      const httpCode = routeMeta.httpCode;
      const headers = routeMeta.headers as HeaderMetadata[];
      const redirect: RedirectMetadata | undefined = routeMeta.redirect;
      const renderTemplate = routeMeta.renderTemplate;
      const isSse = routeMeta.isSse;
      const sseOptions: SseOptions | undefined = routeMeta.sseOptions;

      const methodMiddlewares = routeMeta.methodMiddlewares;
      const methodGuards = routeMeta.methodGuards;
      const methodPipes = routeMeta.methodPipes;
      const methodInterceptors = routeMeta.methodInterceptors;
      const methodFilters = routeMeta.methodFilters;

      const resolvedVersions = resolvePrecompiledRouteVersions(
        routeMeta.methodVersion,
        precompiled.controllerVersion,
        versioning,
      );

      const methodPaths = routeMeta.paths;

      // Deduplicate raw combined paths for a single handler when RouterModule prefixes collapse
      const emittedRawPaths = new Set<string>();

      for (const routerPrefix of routerPrefixes) {
        for (const ctrlPath of controllerPaths) {
          for (const methodPath of methodPaths) {
            const rawPathWithoutPrefix = normalizePath(
              routerPrefix,
              ctrlPath,
              methodPath,
            );
            if (emittedRawPaths.has(rawPathWithoutPrefix)) {
              continue;
            }
            emittedRawPaths.add(rawPathWithoutPrefix);

            const skipPrefix =
              globalPrefixes.length === 0 ||
              matchesGlobalPrefixExclude(
                routeMeta.method,
                rawPathWithoutPrefix,
                options.globalPrefixOptions?.exclude,
              );

            const activePrefixes: Array<string | undefined> = skipPrefix
              ? [undefined]
              : globalPrefixes;

            const recordScannedRoute = (
              collisionKeys: readonly string[],
              entry: ScannedRoute,
              duplicateVersionLabel?: string,
            ) => {
              allDeclared.push({ entry, versionLabel: duplicateVersionLabel });

              // Keep the first declaration in `scanned` when exact duplicates occur
              // (NestJS duplicate=off/warn first-declaration-wins semantics), unless
              // `preserveDuplicates` is explicitly requested (e.g. SwaggerModule).
              const exactKey = [...collisionKeys].sort().join("||");
              if (options.preserveDuplicates || !exactRouteRegistry.has(exactKey)) {
                exactRouteRegistry.add(exactKey);
                scanned.push(entry);
              }
            };

            for (const activePrefix of activePrefixes) {
              if (versioning && versioning.type === VersioningType.URI) {
                // URI Versioning expands each version token into its own concrete route path:
                // [globalPrefix] + [versionSegment] + [routerPrefix + ctrlPath + methodPath]
                const tokens = resolvedVersions ?? [];
                for (const token of tokens) {
                  const versionSegment = formatUriVersionSegment(
                    token,
                    versioning,
                  );
                  const fullPath = activePrefix
                    ? normalizePath(
                        activePrefix,
                        versionSegment,
                        rawPathWithoutPrefix,
                      )
                    : normalizePath(versionSegment, rawPathWithoutPrefix);
                  const canonicalPath = canonicalizePath(fullPath);

                  const keys = hostKeys.map(
                    (hk) => `${routeMeta.method}|${hk}|${canonicalPath}`,
                  );
                  recordScannedRoute(
                    keys,
                    {
                      method: routeMeta.method,
                      path: rawPathWithoutPrefix,
                      fullPath,
                      rawPathWithoutPrefix,
                      canonicalPath,
                      controller,
                      controllerToken: controller,
                      handlerKey: routeMeta.handlerKey,
                      handlerFn,
                      parameters,
                      httpCode,
                      headers: headers.length > 0 ? headers : undefined,
                      redirect,
                      renderTemplate,
                      isSse: isSse || undefined,
                      sseOptions,
                      version: token,
                      host: controllerMeta.host,
                      scope: controllerMeta.scope,
                      versions: [token],
                      isNativePathEligible:
                        controllerMeta.host === undefined &&
                        isNativeBunRoutePath(fullPath),
                      controllerMiddlewares,
                      methodMiddlewares: [...methodMiddlewares],
                      controllerGuards,
                      methodGuards: [...methodGuards],
                      controllerPipes,
                      methodPipes: [...methodPipes],
                      controllerInterceptors,
                      methodInterceptors: [...methodInterceptors],
                      controllerFilters,
                      methodFilters: [...methodFilters],
                    },
                    formatVersionLabel(token),
                  );
                }
                continue;
              }

              // Standard unversioned OR runtime-versioned (HEADER / MEDIA_TYPE / CUSTOM) route
              const fullPath = activePrefix
                ? normalizePath(activePrefix, rawPathWithoutPrefix)
                : rawPathWithoutPrefix;

              const canonicalPath = canonicalizePath(fullPath);

              const keys: string[] = [];
              let dupVerLabel: string | undefined;
              // When enableVersioning() has not been called yet (e.g. during BunestFactory.create()
              // right before the user invokes app.enableVersioning()), still partition collision keys
              // by any explicit @Version() / @Controller({ version }) metadata so distinctly versioned
              // handlers on the same path don't spuriously throw DuplicateRouteException prematurely.
              const explicitPreVersioningTokens =
                versioning === undefined
                  ? normalizeVersionValue(
                      routeMeta.methodVersion ?? precompiled.controllerVersion,
                    )
                  : undefined;
              const collisionVersionTokens =
                versioning && resolvedVersions && resolvedVersions.length > 0
                  ? resolvedVersions
                  : explicitPreVersioningTokens;

              if (collisionVersionTokens && collisionVersionTokens.length > 0) {
                dupVerLabel = collisionVersionTokens
                  .map(formatVersionLabel)
                  .join(", ");
                for (const hostKey of hostKeys) {
                  for (const token of collisionVersionTokens) {
                    const versionKey = formatVersionCollisionKey(token);
                    keys.push(
                      `${routeMeta.method}|${hostKey}|${versionKey}|${canonicalPath}`,
                    );
                  }
                }
              } else {
                for (const hostKey of hostKeys) {
                  keys.push(`${routeMeta.method}|${hostKey}|${canonicalPath}`);
                }
              }

              recordScannedRoute(
                keys,
                {
                  method: routeMeta.method,
                  path: rawPathWithoutPrefix,
                  fullPath,
                  rawPathWithoutPrefix,
                  canonicalPath,
                  controller,
                  controllerToken: controller,
                  handlerKey: routeMeta.handlerKey,
                  handlerFn,
                  parameters,
                  httpCode,
                  headers: headers.length > 0 ? headers : undefined,
                  redirect,
                  renderTemplate,
                  isSse: isSse || undefined,
                  sseOptions,
                  version: ternary(!resolvedVersions, undefined)
                    .elseIf(
                      () => resolvedVersions!.length === 1,
                      () => resolvedVersions![0],
                    )
                    .elseEval(() => [...resolvedVersions!]),
                  host: controllerMeta.host,
                  scope: controllerMeta.scope,
                  versions: resolvedVersions,
                  isNativePathEligible:
                    controllerMeta.host === undefined &&
                    isNativeBunRoutePath(fullPath),
                  controllerMiddlewares,
                  methodMiddlewares: [...methodMiddlewares],
                  controllerGuards,
                  methodGuards: [...methodGuards],
                  controllerPipes,
                  methodPipes: [...methodPipes],
                  controllerInterceptors,
                  methodInterceptors: [...methodInterceptors],
                  controllerFilters,
                  methodFilters: [...methodFilters],
                },
                dupVerLabel,
              );
            }
          }
        }
      }
    }
  }

  if (resolutionStrategy === "specificity") {
    scanned.sort(compareRouteSpecificity);
    allDeclared.sort((a, b) => compareRouteSpecificity(a.entry, b.entry));
  }

  if (
    (conflictLevels.duplicate !== "off" || conflictLevels.shadow !== "off") &&
    allDeclared.length > 1
  ) {
    interface DetectedConflict {
      readonly kind: "duplicate" | "shadow";
      readonly message: string;
      readonly earlier: ScannedRoute;
      readonly later: ScannedRoute;
      readonly versionLabel?: string;
    }

    const conflicts: DetectedConflict[] = [];

    for (let i = 0; i < allDeclared.length; i++) {
      const earlierItem = allDeclared[i]!;
      const earlier = earlierItem.entry;
      for (let j = i + 1; j < allDeclared.length; j++) {
        const laterItem = allDeclared[j]!;
        const later = laterItem.entry;

        // 1. Method overlap
        if (
          earlier.method !== later.method &&
          earlier.method !== "ALL" &&
          later.method !== "ALL"
        ) {
          continue;
        }

        // 2. Version overlap (URI versioning already baked into fullPath)
        const versionCmp =
          versioning && versioning.type !== VersioningType.URI
            ? compareRouteVersions(earlier.versions, later.versions)
            : !versioning &&
                (earlierItem.versionLabel !== undefined ||
                  laterItem.versionLabel !== undefined)
              ? earlierItem.versionLabel === laterItem.versionLabel
                ? { same: true, overlaps: true }
                : { same: false, overlaps: false }
              : { same: true, overlaps: true };
        if (!versionCmp.overlaps) {
          continue;
        }

        // 3. Host overlap
        const hostCmp = compareHostConstraints(earlier.host, later.host);
        if (!hostCmp.overlaps) {
          continue;
        }

        // 4. Path overlap
        const samePath = earlier.canonicalPath === later.canonicalPath;
        if (!samePath && !canPatternsOverlap(earlier.fullPath, later.fullPath)) {
          continue;
        }

        const isDuplicate =
          samePath &&
          earlier.method === later.method &&
          hostCmp.same &&
          versionCmp.same;

        const earlierCtrl = `${earlier.controller.name}.${String(earlier.handlerKey)}`;
        const laterCtrl = `${later.controller.name}.${String(later.handlerKey)}`;

        if (isDuplicate) {
          if (conflictLevels.duplicate !== "off") {
            conflicts.push({
              kind: "duplicate",
              message: `Duplicate route ${later.method} ${later.fullPath} (${laterCtrl} duplicates ${earlierCtrl})`,
              earlier,
              later,
              versionLabel: laterItem.versionLabel,
            });
          }
        } else if (conflictLevels.shadow !== "off") {
          // If earlier is strictly more specific than later (e.g. /users/me before /users/:id
          // after specificity sorting), earlier does not shadow later.
          if (!samePath && compareRouteSpecificity(earlier, later) < 0) {
            continue;
          }
          conflicts.push({
            kind: "shadow",
            message: `Shadowed route detected: ${earlier.method} ${earlier.fullPath} (${earlierCtrl}) shadows ${later.method} ${later.fullPath} (${laterCtrl})`,
            earlier,
            later,
            versionLabel: laterItem.versionLabel,
          });
        }
      }
    }

    const errorConflicts: DetectedConflict[] = [];
    for (const conflict of conflicts) {
      const level =
        conflict.kind === "duplicate"
          ? conflictLevels.duplicate
          : conflictLevels.shadow;
      if (level === "warn") {
        options.logger?.warn(conflict.message);
      } else if (level === "error") {
        errorConflicts.push(conflict);
      }
    }

    if (errorConflicts.length > 0) {
      const first = errorConflicts[0]!;
      const earlierCtrl = `${first.earlier.controller.name}.${String(first.earlier.handlerKey)}`;
      const laterCtrl = `${first.later.controller.name}.${String(first.later.handlerKey)}`;
      const err = new DuplicateRouteException({
        method: first.later.method,
        path: first.later.fullPath,
        canonicalPath: first.later.canonicalPath,
        host: first.later.host ? String(first.later.host) : undefined,
        version: first.versionLabel,
        existingPath: first.earlier.fullPath,
        existingController: earlierCtrl,
        attemptedController: laterCtrl,
      });
      if (errorConflicts.length > 1 || first.kind === "shadow") {
        err.message = errorConflicts.map((c) => c.message).join("\n");
      }
      throw err;
    }
  }

  return scanned;
}
