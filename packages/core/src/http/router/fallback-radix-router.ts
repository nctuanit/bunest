import {
  type HttpMethod,
  type RouteHttpMethod,
  VERSION_NEUTRAL,
  type VersioningOptions,
} from "../../common/index";
import type { CompiledRoute } from "../pipeline/execution-pipeline";
import {
  extractRequestVersions,
  isRuntimeVersioning,
} from "../scanner/version-resolver";

const METHOD_ALLOW_ORDER: readonly HttpMethod[] = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "SEARCH",
  "PROPFIND",
  "PROPPATCH",
  "MKCOL",
  "COPY",
  "MOVE",
  "LOCK",
  "UNLOCK",
  "QUERY",
];

const CORE_METHODS_ALLOW_HEADER =
  "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS";
const ALL_METHODS_ALLOW_HEADER = CORE_METHODS_ALLOW_HEADER;

const PARAM_WITH_REGEX_RE = /^:([A-Za-z_][A-Za-z0-9_]*)\((.+)\)(\?)?$/;
const OPTIONAL_PARAM_RE = /^:([A-Za-z_][A-Za-z0-9_]*)\?$/;
const SIMPLE_PARAM_RE = /^:([A-Za-z_][A-Za-z0-9_]*)$/;
const NAMED_WILDCARD_RE = /^\*([A-Za-z_][A-Za-z0-9_]*)$/;

type SegmentKind =
  | { readonly kind: "static"; readonly literal: string }
  | {
      readonly kind: "mixed";
      readonly regexKey: string;
      readonly regex: RegExp;
      readonly names: readonly string[];
    }
  | { readonly kind: "param"; readonly name: string; readonly regex?: RegExp }
  | {
      readonly kind: "optional-param";
      readonly name: string;
      readonly regex?: RegExp;
    }
  | { readonly kind: "mid-wildcard" }
  | { readonly kind: "trailing-wildcard"; readonly name?: string };

interface HostMatcher {
  readonly rules: ReadonlyArray<string | RegExp>;
}

interface RouteSlot {
  readonly compiled: CompiledRoute;
  readonly paramNames: readonly string[];
}

interface VersionedSlotGroup {
  readonly byVersion: Map<string, RouteSlot>;
  neutral?: RouteSlot;
}

interface HostRouteBucket {
  readonly hostKey: string;
  readonly hostMatcher?: HostMatcher;
  readonly methods: Partial<Record<HttpMethod, RouteSlot>>;
  allHandler?: RouteSlot;
  readonly versionedMethods?: Partial<Record<HttpMethod, VersionedSlotGroup>>;
  versionedAll?: VersionedSlotGroup;
  allowHeader: string;
}

interface RadixNode {
  readonly staticChildren: Map<string, RadixNode>;
  readonly mixedSegmentChildren: Array<{
    readonly regexKey: string;
    readonly regex: RegExp;
    readonly groupCount: number;
    readonly node: RadixNode;
    readonly order: number;
  }>;
  readonly regexParamChildren: Array<{
    readonly regexKey: string;
    readonly regex: RegExp;
    readonly node: RadixNode;
  }>;
  paramChild?: RadixNode;
  readonly optionalParamChildren: Array<{
    readonly regexKey: string;
    readonly regex?: RegExp;
    readonly node: RadixNode;
  }>;
  midWildcardChild?: RadixNode;
  trailingWildcardChild?: RadixNode;
  trailingSlashChild?: RadixNode;
  minOrder: number;
  readonly buckets: HostRouteBucket[];
}

function createNode(): RadixNode {
  return {
    staticChildren: new Map(),
    mixedSegmentChildren: [],
    regexParamChildren: [],
    optionalParamChildren: [],
    minOrder: Number.MAX_SAFE_INTEGER,
    buckets: [],
  };
}

function addSlotToVersionGroup(
  group: VersionedSlotGroup,
  slot: RouteSlot,
): void {
  const versions = slot.compiled.route.versions;
  if (!versions || versions.length === 0) {
    group.neutral = slot;
    return;
  }
  for (let i = 0; i < versions.length; i++) {
    const token = versions[i];
    if (token === VERSION_NEUTRAL) {
      group.neutral = slot;
    } else if (typeof token === "string") {
      group.byVersion.set(token, slot);
    }
  }
}

function matchVersionGroup(
  group: VersionedSlotGroup | undefined,
  requestedVersions: readonly string[],
): RouteSlot | undefined {
  if (!group) {
    return undefined;
  }
  for (let i = 0; i < requestedVersions.length; i++) {
    const ver = requestedVersions[i];
    if (ver !== undefined) {
      const hit = group.byVersion.get(ver);
      if (hit) {
        return hit;
      }
    }
  }
  return group.neutral;
}

function safeDecodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function escapeRegexLiteral(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function expandOptionalPathVariants(rawPath: string): string[] {
  const openIdx = rawPath.indexOf("{");
  if (openIdx === -1) {
    const collapsed = rawPath.replace(/\/+/g, "/");
    return [collapsed || "/"];
  }
  let depth = 0;
  let closeIdx = -1;
  for (let i = openIdx; i < rawPath.length; i++) {
    if (rawPath[i] === "{") depth++;
    else if (rawPath[i] === "}") {
      depth--;
      if (depth === 0) {
        closeIdx = i;
        break;
      }
    }
  }
  if (closeIdx === -1) {
    return [rawPath];
  }
  const before = rawPath.slice(0, openIdx);
  const inside = rawPath.slice(openIdx + 1, closeIdx);
  const after = rawPath.slice(closeIdx + 1);
  const withGroup = expandOptionalPathVariants(before + inside + after);
  const withoutGroup = expandOptionalPathVariants(before + after);
  const out: string[] = [];
  for (const v of withGroup) {
    if (!out.includes(v)) out.push(v);
  }
  for (const v of withoutGroup) {
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

function parseMixedSegment(
  raw: string,
): { regexKey: string; regex: RegExp; names: string[] } | null {
  if (!raw.includes(":")) return null;
  const names: string[] = [];
  let pattern = "^";
  let i = 0;
  while (i < raw.length) {
    if (
      raw[i] === ":" &&
      i + 1 < raw.length &&
      /[A-Za-z_]/.test(raw[i + 1]!)
    ) {
      let j = i + 1;
      while (j < raw.length && /[A-Za-z0-9_]/.test(raw[j]!)) j++;
      names.push(raw.slice(i + 1, j));
      pattern += "([^/]+)";
      i = j;
    } else {
      pattern += escapeRegexLiteral(raw[i]!);
      i++;
    }
  }
  if (names.length === 0) return null;
  pattern += "$";
  return { regexKey: pattern, regex: new RegExp(pattern), names };
}

function parseRouteSegments(normalizedPath: string): {
  segments: SegmentKind[];
  paramNames: string[];
  requireTrailingSlash: boolean;
} {
  if (normalizedPath === "/") {
    return { segments: [], paramNames: [], requireTrailingSlash: false };
  }

  const requireTrailingSlash =
    normalizedPath.length > 1 && normalizedPath.endsWith("/");
  const trimmed = requireTrailingSlash
    ? normalizedPath.slice(1, -1)
    : normalizedPath.slice(1);
  const rawSegments = trimmed.length === 0 ? [] : trimmed.split("/");
  const segments: SegmentKind[] = [];
  const paramNames: string[] = [];

  for (let i = 0; i < rawSegments.length; i++) {
    const raw = rawSegments[i];
    if (raw === undefined) continue;

    if (raw === "*") {
      if (i === rawSegments.length - 1) {
        segments.push({ kind: "trailing-wildcard" });
      } else {
        segments.push({ kind: "mid-wildcard" });
      }
      continue;
    }

    const namedWildMatch = NAMED_WILDCARD_RE.exec(raw);
    if (namedWildMatch) {
      const name = namedWildMatch[1]!;
      if (i === rawSegments.length - 1) {
        paramNames.push(name);
        segments.push({ kind: "trailing-wildcard", name });
      } else {
        segments.push({ kind: "mid-wildcard" });
      }
      continue;
    }

    const regexMatch = PARAM_WITH_REGEX_RE.exec(raw);
    if (regexMatch) {
      const name = regexMatch[1]!;
      const pattern = regexMatch[2]!;
      const isOptional = regexMatch[3] === "?";
      const regex = new RegExp(`^(?:${pattern})$`);
      paramNames.push(name);
      segments.push(
        isOptional
          ? { kind: "optional-param", name, regex }
          : { kind: "param", name, regex },
      );
      continue;
    }

    const optMatch = OPTIONAL_PARAM_RE.exec(raw);
    if (optMatch) {
      const name = optMatch[1]!;
      paramNames.push(name);
      segments.push({ kind: "optional-param", name });
      continue;
    }

    const simpleMatch = SIMPLE_PARAM_RE.exec(raw);
    if (simpleMatch) {
      const name = simpleMatch[1]!;
      paramNames.push(name);
      segments.push({ kind: "param", name });
      continue;
    }

    const mixed = parseMixedSegment(raw);
    if (mixed) {
      for (const n of mixed.names) {
        paramNames.push(n);
      }
      segments.push({
        kind: "mixed",
        regexKey: mixed.regexKey,
        regex: mixed.regex,
        names: mixed.names,
      });
      continue;
    }

    segments.push({ kind: "static", literal: raw });
  }

  return { segments, paramNames, requireTrailingSlash };
}

export function computeAllowHeader(
  methods: Partial<Record<HttpMethod, unknown>>,
  hasAllHandler: boolean,
): string {
  if (hasAllHandler) {
    return ALL_METHODS_ALLOW_HEADER;
  }

  const present = new Set<HttpMethod>();
  for (const key of Object.keys(methods) as HttpMethod[]) {
    if (methods[key] !== undefined) {
      present.add(key);
    }
  }
  if (present.has("GET")) {
    present.add("HEAD");
  }

  const ordered: HttpMethod[] = [];
  for (const m of METHOD_ALLOW_ORDER) {
    if (present.has(m)) {
      ordered.push(m);
    }
  }
  return ordered.join(", ");
}

function computeVersionedAllowHeader(
  bucket: HostRouteBucket,
  requestedVersions: readonly string[],
): string {
  if (matchVersionGroup(bucket.versionedAll, requestedVersions)) {
    return ALL_METHODS_ALLOW_HEADER;
  }
  if (!bucket.versionedMethods) {
    return "";
  }
  const present = new Set<HttpMethod>();
  for (const key of Object.keys(bucket.versionedMethods) as HttpMethod[]) {
    const group = bucket.versionedMethods[key];
    if (matchVersionGroup(group, requestedVersions)) {
      present.add(key);
    }
  }
  if (present.has("GET")) {
    present.add("HEAD");
  }
  if (present.size === 0) {
    return "";
  }
  const ordered: HttpMethod[] = [];
  for (const m of METHOD_ALLOW_ORDER) {
    if (present.has(m)) {
      ordered.push(m);
    }
  }
  return ordered.join(", ");
}

function serializeHostKey(
  host: string | RegExp | Array<string | RegExp> | undefined,
): string {
  if (host === undefined) return "";
  const list = Array.isArray(host) ? host : [host];
  return list
    .map((h) =>
      h instanceof RegExp
        ? `re:${h.source}/${h.flags}`
        : `s:${h.toLowerCase()}`,
    )
    .join("|");
}

function extractHostname(req: Request): string {
  const hostHeader = req.headers.get("host");
  if (hostHeader) {
    const trimmed = hostHeader.trim().toLowerCase();
    if (trimmed.startsWith("[")) {
      const endBracket = trimmed.indexOf("]");
      return endBracket === -1 ? trimmed : trimmed.slice(0, endBracket + 1);
    }
    const colonIdx = trimmed.indexOf(":");
    return colonIdx === -1 ? trimmed : trimmed.slice(0, colonIdx);
  }

  try {
    return new URL(req.url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function matchSingleHostRule(
  rule: string | RegExp,
  hostname: string,
): Record<string, string> | null {
  if (rule instanceof RegExp) {
    const match = rule.exec(hostname);
    if (!match) return null;
    const params: Record<string, string> = {};
    if (match.groups) {
      for (const [k, v] of Object.entries(match.groups)) {
        if (v !== undefined) {
          params[k] = v;
        }
      }
    }
    return params;
  }

  const normalizedRule = rule.toLowerCase();
  if (!normalizedRule.includes(":")) {
    return normalizedRule === hostname ? {} : null;
  }

  const ruleLabels = normalizedRule.split(".");
  const hostLabels = hostname.split(".");
  if (ruleLabels.length !== hostLabels.length) {
    return null;
  }

  const params: Record<string, string> = {};
  for (let i = 0; i < ruleLabels.length; i++) {
    const rLabel = ruleLabels[i];
    const hLabel = hostLabels[i];
    if (rLabel === undefined || hLabel === undefined) return null;
    if (rLabel.startsWith(":")) {
      const paramName = rLabel.slice(1);
      if (paramName) {
        params[paramName] = hLabel;
      }
    } else if (rLabel !== hLabel) {
      return null;
    }
  }
  return params;
}

function matchHostConstraint(
  matcher: HostMatcher | undefined,
  hostname: string,
): Record<string, string> | null {
  if (!matcher) {
    return {};
  }
  for (let i = 0; i < matcher.rules.length; i++) {
    const rule = matcher.rules[i];
    if (rule === undefined) continue;
    const matched = matchSingleHostRule(rule, hostname);
    if (matched !== null) {
      return matched;
    }
  }
  return null;
}

function buildParamsRecord(
  paramNames: readonly string[],
  paramValues: ReadonlyArray<string | string[] | undefined>,
): Record<string, string> {
  const params: Record<string, unknown> = {};
  const len = Math.min(paramNames.length, paramValues.length);
  for (let i = 0; i < len; i++) {
    const name = paramNames[i];
    const value = paramValues[i];
    if (name !== undefined && value !== undefined) {
      params[name] = value;
    }
  }
  return params as Record<string, string>;
}

export type FallbackMatchResult =
  | {
      readonly kind: "matched";
      readonly route: CompiledRoute;
      readonly params: Record<string, string>;
      readonly hostParams: Record<string, string>;
      readonly allowHeader: string;
    }
  | {
      readonly kind: "method-not-allowed";
      readonly allowHeader: string;
      readonly hostParams: Record<string, string>;
    }
  | {
      readonly kind: "not-found";
    };

/**
 * Lightweight Radix / Segment-Trie router backing non-native routes
 * (host constraints, mid-path wildcards, optional params, regex params)
 * with deterministic precedence (`static > regex > param > optional > wildcard`),
 * runtime API versioning (`HEADER`, `MEDIA_TYPE`, `CUSTOM`), and
 * `405 Method Not Allowed` + `Allow` header support (ADR-011).
 */
export class FallbackRadixRouter {
  private readonly root: RadixNode = createNode();
  private readonly versioning?: VersioningOptions;
  private readonly runtimeVersioning: boolean;
  private routeCount = 0;

  constructor(versioning?: VersioningOptions) {
    this.versioning = versioning;
    this.runtimeVersioning = isRuntimeVersioning(versioning);
  }

  get size(): number {
    return this.routeCount;
  }

  addRoute(compiled: CompiledRoute): void {
    const { fullPath } = compiled.route;
    const variants = fullPath.includes("{")
      ? expandOptionalPathVariants(fullPath)
      : [fullPath];
    const order = this.routeCount;
    for (const variant of variants) {
      this.addConcreteVariant(compiled, variant, order);
    }
    this.routeCount++;
  }

  private addConcreteVariant(
    compiled: CompiledRoute,
    variantPath: string,
    order: number,
  ): void {
    const { method, host } = compiled.route;
    const { segments, paramNames, requireTrailingSlash } =
      parseRouteSegments(variantPath);

    let node = this.root;
    if (order < node.minOrder) node.minOrder = order;

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (!seg) continue;

      if (seg.kind === "static") {
        let next = node.staticChildren.get(seg.literal);
        if (!next) {
          next = createNode();
          node.staticChildren.set(seg.literal, next);
        }
        node = next;
      } else if (seg.kind === "mixed") {
        let child = node.mixedSegmentChildren.find(
          (c) => c.regexKey === seg.regexKey,
        );
        if (!child) {
          child = {
            regexKey: seg.regexKey,
            regex: seg.regex,
            groupCount: seg.names.length,
            node: createNode(),
            order,
          };
          node.mixedSegmentChildren.push(child);
          // More capture groups (e.g. `:name.:locale.:ext`) before fewer (`:name.:ext`)
          node.mixedSegmentChildren.sort((a, b) => b.groupCount - a.groupCount);
        }
        node = child.node;
      } else if (seg.kind === "param" && seg.regex) {
        const regexKey = seg.regex.source;
        let child = node.regexParamChildren.find(
          (c) => c.regexKey === regexKey,
        );
        if (!child) {
          child = { regexKey, regex: seg.regex, node: createNode() };
          node.regexParamChildren.push(child);
        }
        node = child.node;
      } else if (seg.kind === "param") {
        if (!node.paramChild) {
          node.paramChild = createNode();
        }
        node = node.paramChild;
      } else if (seg.kind === "optional-param") {
        const regexKey = seg.regex ? seg.regex.source : "";
        let child = node.optionalParamChildren.find(
          (c) => c.regexKey === regexKey,
        );
        if (!child) {
          child = { regexKey, regex: seg.regex, node: createNode() };
          node.optionalParamChildren.push(child);
        }
        node = child.node;
      } else if (seg.kind === "mid-wildcard") {
        if (!node.midWildcardChild) {
          node.midWildcardChild = createNode();
        }
        node = node.midWildcardChild;
      } else if (seg.kind === "trailing-wildcard") {
        if (!node.trailingWildcardChild) {
          node.trailingWildcardChild = createNode();
        }
        node = node.trailingWildcardChild;
      }
      if (order < node.minOrder) node.minOrder = order;
    }

    if (requireTrailingSlash) {
      if (!node.trailingSlashChild) {
        node.trailingSlashChild = createNode();
      }
      node = node.trailingSlashChild;
      if (order < node.minOrder) node.minOrder = order;
    }

    const hostKey = serializeHostKey(host);
    let bucket = node.buckets.find((b) => b.hostKey === hostKey);
    if (!bucket) {
      bucket = {
        hostKey,
        hostMatcher:
          host !== undefined
            ? { rules: Array.isArray(host) ? host : [host] }
            : undefined,
        methods: {},
        versionedMethods: this.runtimeVersioning ? {} : undefined,
        allowHeader: "",
      };
      // Keep host-constrained buckets ahead of host-agnostic buckets
      if (bucket.hostMatcher) {
        const firstAgnosticIdx = node.buckets.findIndex((b) => !b.hostMatcher);
        if (firstAgnosticIdx === -1) {
          node.buckets.push(bucket);
        } else {
          node.buckets.splice(firstAgnosticIdx, 0, bucket);
        }
      } else {
        node.buckets.push(bucket);
      }
    }

    const slot: RouteSlot = { compiled, paramNames };
    if (this.runtimeVersioning) {
      if (method === "ALL") {
        if (!bucket.versionedAll) {
          bucket.versionedAll = { byVersion: new Map() };
        }
        addSlotToVersionGroup(bucket.versionedAll, slot);
      } else {
        let group = bucket.versionedMethods![method];
        if (!group) {
          group = { byVersion: new Map() };
          bucket.versionedMethods![method] = group;
        }
        addSlotToVersionGroup(group, slot);
      }
      bucket.allowHeader = computeAllowHeader(
        bucket.versionedMethods!,
        bucket.versionedAll !== undefined,
      );
    } else {
      if (method === "ALL") {
        if (!bucket.allHandler) {
          bucket.allHandler = slot;
        }
      } else if (!bucket.methods[method]) {
        bucket.methods[method] = slot;
      }
      bucket.allowHeader = computeAllowHeader(
        bucket.methods,
        bucket.allHandler !== undefined,
      );
    }
  }

  match(pathname: string, req: Request): FallbackMatchResult {
    if (this.routeCount === 0) {
      return { kind: "not-found" };
    }

    const method = req.method.toUpperCase() as RouteHttpMethod;
    const hostname = extractHostname(req);
    const requestedVersions =
      this.runtimeVersioning && this.versioning
        ? extractRequestVersions(req, this.versioning)
        : undefined;
    const hasTrailingSlash = pathname.length > 1 && pathname.endsWith("/");
    const rawSegments =
      pathname === "/"
        ? []
        : hasTrailingSlash
          ? pathname.slice(1, -1).split("/")
          : pathname.slice(1).split("/");

    let methodNotAllowedCandidate:
      { allowHeader: string; hostParams: Record<string, string> } | undefined;

    const capturedValues: Array<string | string[] | undefined> = [];

    const resolveAtNode = (node: RadixNode): FallbackMatchResult | null => {
      if (node.buckets.length === 0) {
        return null;
      }

      for (let i = 0; i < node.buckets.length; i++) {
        const bucket = node.buckets[i];
        if (!bucket) continue;

        const hostParams = matchHostConstraint(bucket.hostMatcher, hostname);
        if (hostParams === null) {
          continue;
        }

        if (this.runtimeVersioning && requestedVersions !== undefined) {
          const slot =
            (method !== "ALL"
              ? matchVersionGroup(
                  bucket.versionedMethods?.[method],
                  requestedVersions,
                )
              : undefined) ??
            (method === "HEAD"
              ? matchVersionGroup(
                  bucket.versionedMethods?.GET,
                  requestedVersions,
                )
              : undefined) ??
            matchVersionGroup(bucket.versionedAll, requestedVersions);

          if (slot) {
            const allowHeader =
              computeVersionedAllowHeader(bucket, requestedVersions) ||
              bucket.allowHeader;
            return {
              kind: "matched",
              route: slot.compiled,
              params: buildParamsRecord(slot.paramNames, capturedValues),
              hostParams,
              allowHeader,
            };
          }

          const versionAllow = computeVersionedAllowHeader(
            bucket,
            requestedVersions,
          );
          if (versionAllow.length > 0 && !methodNotAllowedCandidate) {
            methodNotAllowedCandidate = {
              allowHeader: versionAllow,
              hostParams,
            };
          }
          continue;
        }

        const slot =
          (method !== "ALL" ? bucket.methods[method] : undefined) ??
          (method === "HEAD" ? bucket.methods.GET : undefined) ??
          bucket.allHandler;

        if (slot) {
          return {
            kind: "matched",
            route: slot.compiled,
            params: buildParamsRecord(slot.paramNames, capturedValues),
            hostParams,
            allowHeader: bucket.allowHeader,
          };
        }

        if (!methodNotAllowedCandidate) {
          methodNotAllowedCandidate = {
            allowHeader: bucket.allowHeader,
            hostParams,
          };
        }
      }

      return null;
    };

    const search = (
      node: RadixNode,
      segIndex: number,
    ): FallbackMatchResult | null => {
      if (segIndex === rawSegments.length) {
        // Exact terminal match (only if URL did not have a trailing slash on a non-root static/param route)
        if (!hasTrailingSlash) {
          const hit = resolveAtNode(node);
          if (hit) return hit;

          // Optional parameter children can be skipped when segments are exhausted
          for (let i = 0; i < node.optionalParamChildren.length; i++) {
            const opt = node.optionalParamChildren[i];
            if (!opt) continue;
            capturedValues.push(undefined);
            const optHit = search(opt.node, segIndex);
            capturedValues.pop();
            if (optHit) return optHit;
          }
        }

        // Exact trailing-slash routes (e.g. `/docs{/}` -> `/docs/`, `/named/{*path}` -> `/named/`)
        if (hasTrailingSlash && node.trailingSlashChild) {
          const hit = resolveAtNode(node.trailingSlashChild);
          if (hit) return hit;
        }

        // Trailing wildcard `/api/*` matches `/api/` (empty trailing segment), misses bare `/api`
        if (hasTrailingSlash && node.trailingWildcardChild) {
          const hit = resolveAtNode(node.trailingWildcardChild);
          if (hit) return hit;
        }

        return null;
      }

      const rawSegment = rawSegments[segIndex]!;
      const decodedSegment = safeDecodeSegment(rawSegment);

      // 1. Static segment vs mixed segment (respecting declaration order when mixed precedes static)
      const staticNext =
        node.staticChildren.get(rawSegment) ??
        (decodedSegment !== rawSegment
          ? node.staticChildren.get(decodedSegment)
          : undefined);
      const staticOrder = staticNext ? staticNext.minOrder : Number.MAX_SAFE_INTEGER;

      if (rawSegment.length > 0 && node.mixedSegmentChildren.length > 0) {
        for (let i = 0; i < node.mixedSegmentChildren.length; i++) {
          const child = node.mixedSegmentChildren[i]!;
          if (child.order >= staticOrder) continue;
          const m = child.regex.exec(decodedSegment);
          if (m) {
            for (let g = 1; g <= child.groupCount; g++) {
              capturedValues.push(m[g]);
            }
            const hit = search(child.node, segIndex + 1);
            for (let g = 0; g < child.groupCount; g++) {
              capturedValues.pop();
            }
            if (hit) return hit;
          }
        }
      }

      if (staticNext) {
        const hit = search(staticNext, segIndex + 1);
        if (hit) return hit;
      }

      // 1b. Remaining mixed segments (declared after static or no static match)
      if (rawSegment.length > 0 && node.mixedSegmentChildren.length > 0) {
        for (let i = 0; i < node.mixedSegmentChildren.length; i++) {
          const child = node.mixedSegmentChildren[i]!;
          if (child.order < staticOrder) continue;
          const m = child.regex.exec(decodedSegment);
          if (m) {
            for (let g = 1; g <= child.groupCount; g++) {
              capturedValues.push(m[g]);
            }
            const hit = search(child.node, segIndex + 1);
            for (let g = 0; g < child.groupCount; g++) {
              capturedValues.pop();
            }
            if (hit) return hit;
          }
        }
      }

      // Empty path segments (e.g. from double slashes `/users//posts`) never match param/optional segments
      if (rawSegment.length > 0) {
        // 2. Regex-constrained param segments
        for (let i = 0; i < node.regexParamChildren.length; i++) {
          const child = node.regexParamChildren[i];
          if (!child) continue;
          if (child.regex.test(decodedSegment)) {
            capturedValues.push(decodedSegment);
            const hit = search(child.node, segIndex + 1);
            capturedValues.pop();
            if (hit) return hit;
          }
        }

        // 3. Simple `:param` segment
        if (node.paramChild) {
          capturedValues.push(decodedSegment);
          const hit = search(node.paramChild, segIndex + 1);
          capturedValues.pop();
          if (hit) return hit;
        }

        // 4. Optional `:param?` segment (try consuming 1 segment, then skipping 0 segments)
        for (let i = 0; i < node.optionalParamChildren.length; i++) {
          const child = node.optionalParamChildren[i];
          if (!child) continue;

          if (!child.regex || child.regex.test(decodedSegment)) {
            capturedValues.push(decodedSegment);
            const consumedHit = search(child.node, segIndex + 1);
            capturedValues.pop();
            if (consumedHit) return consumedHit;
          }

          capturedValues.push(undefined);
          const skippedHit = search(child.node, segIndex);
          capturedValues.pop();
          if (skippedHit) return skippedHit;
        }
      }

      // 5. Mid-path wildcard `*` (matches 1 or more segments up to remaining suffix)
      if (node.midWildcardChild) {
        for (
          let nextIdx = segIndex + 1;
          nextIdx <= rawSegments.length;
          nextIdx++
        ) {
          const hit = search(node.midWildcardChild, nextIdx);
          if (hit) return hit;
        }
      }

      // 6. Trailing wildcard `/*` or `/*splat` (matches remaining 1+ segments; splits before decoding)
      if (node.trailingWildcardChild) {
        const splatSegments = rawSegments
          .slice(segIndex)
          .map(safeDecodeSegment);
        capturedValues.push(splatSegments);
        const hit = resolveAtNode(node.trailingWildcardChild);
        capturedValues.pop();
        if (hit) return hit;
      }

      return null;
    };

    const matched = search(this.root, 0);
    if (matched) {
      return matched;
    }

    if (methodNotAllowedCandidate) {
      return {
        kind: "method-not-allowed",
        allowHeader: methodNotAllowedCandidate.allowHeader,
        hostParams: methodNotAllowedCandidate.hostParams,
      };
    }

    return { kind: "not-found" };
  }
}

export interface NativeRouteTarget<T> {
  readonly target: T;
  readonly paramNames: readonly string[];
}

interface NativeMatcherNode<T> {
  readonly staticChildren: Map<string, NativeMatcherNode<T>>;
  paramChild?: NativeMatcherNode<T>;
  trailingWildcardTarget?: NativeRouteTarget<T>;
  exactTarget?: NativeRouteTarget<T>;
}

function createNativeNode<T>(): NativeMatcherNode<T> {
  return { staticChildren: new Map() };
}

/**
 * In-memory native path matcher mirroring Bun 1.4.3's exact `Bun.serve({ routes })`
 * precedence (`static > :param > *`) and trailing-slash / trailing-wildcard rules.
 * Used for `adapter.fetch(req)` and `ignoreTrailingSlash` re-dispatching.
 */
export class NativePathMatcher<T> {
  private readonly staticTable = new Map<string, T>();
  private readonly root: NativeMatcherNode<T> = createNativeNode();
  private hasDynamic = false;

  add(normalizedPath: string, target: T): void {
    if (!normalizedPath.includes(":") && !normalizedPath.includes("*")) {
      this.staticTable.set(normalizedPath, target);
      return;
    }

    this.hasDynamic = true;
    const rawSegments =
      normalizedPath === "/" ? [] : normalizedPath.slice(1).split("/");
    const paramNames: string[] = [];

    let node = this.root;
    for (let i = 0; i < rawSegments.length; i++) {
      const seg = rawSegments[i]!;
      if (seg === "*") {
        node.trailingWildcardTarget = { target, paramNames };
        return;
      }
      if (seg.startsWith(":")) {
        paramNames.push(seg.slice(1));
        if (!node.paramChild) {
          node.paramChild = createNativeNode();
        }
        node = node.paramChild;
        continue;
      }
      let next = node.staticChildren.get(seg);
      if (!next) {
        next = createNativeNode();
        node.staticChildren.set(seg, next);
      }
      node = next;
    }

    node.exactTarget = { target, paramNames };
  }

  match(
    pathname: string,
  ): { target: T; params: Record<string, string> } | null {
    // O(1) static fast path (exact match, preserves strict trailing slash semantics)
    const staticHit = this.staticTable.get(pathname);
    if (staticHit !== undefined) {
      return { target: staticHit, params: {} };
    }

    if (!this.hasDynamic) {
      return null;
    }

    const hasTrailingSlash = pathname.length > 1 && pathname.endsWith("/");
    const segments =
      pathname === "/"
        ? []
        : hasTrailingSlash
          ? pathname.slice(1, -1).split("/")
          : pathname.slice(1).split("/");

    const values: string[] = [];

    const search = (
      node: NativeMatcherNode<T>,
      idx: number,
    ): { target: T; params: Record<string, string> } | null => {
      if (idx === segments.length) {
        if (!hasTrailingSlash && node.exactTarget) {
          return {
            target: node.exactTarget.target,
            params: buildParamsRecord(node.exactTarget.paramNames, values),
          };
        }
        // Per Bun 1.4.3 probe: `/api/*` matches `/api/` and `/api/a/b`, misses bare `/api`
        if (hasTrailingSlash && node.trailingWildcardTarget) {
          return {
            target: node.trailingWildcardTarget.target,
            params: buildParamsRecord(
              node.trailingWildcardTarget.paramNames,
              values,
            ),
          };
        }
        return null;
      }

      const rawSeg = segments[idx]!;

      // 1. Static precedence
      const staticChild = node.staticChildren.get(rawSeg);
      if (staticChild) {
        const hit = search(staticChild, idx + 1);
        if (hit) return hit;
      }

      // 2. `:param` precedence
      if (node.paramChild) {
        values.push(safeDecodeSegment(rawSeg));
        const hit = search(node.paramChild, idx + 1);
        values.pop();
        if (hit) return hit;
      }

      // 3. Trailing `*` precedence
      if (node.trailingWildcardTarget) {
        return {
          target: node.trailingWildcardTarget.target,
          params: buildParamsRecord(
            node.trailingWildcardTarget.paramNames,
            values,
          ),
        };
      }

      return null;
    };

    return search(this.root, 0);
  }
}
