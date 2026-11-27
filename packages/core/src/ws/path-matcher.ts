import { isDangerousKey, normalizePath } from "../http/index";

const PARAM_WITH_REGEX_RE = /^:([A-Za-z_][A-Za-z0-9_]*)\((.+)\)(\?)?$/;
const OPTIONAL_PARAM_RE = /^:([A-Za-z_][A-Za-z0-9_]*)\?$/;
const SIMPLE_PARAM_RE = /^:([A-Za-z_][A-Za-z0-9_]*)$/;
const NAMED_WILDCARD_RE = /^\*([A-Za-z_][A-Za-z0-9_]*)$/;

type WsPathSegment =
  | { readonly kind: "static"; readonly literal: string }
  | { readonly kind: "param"; readonly name: string; readonly regex?: RegExp }
  | {
      readonly kind: "optional-param";
      readonly name: string;
      readonly regex?: RegExp;
    }
  | { readonly kind: "wildcard"; readonly name?: string };

export interface CompiledWsPath {
  readonly pattern: string;
  readonly isDynamic: boolean;
  readonly paramNames: readonly string[];
  readonly segments: readonly WsPathSegment[];
}

export const EMPTY_WS_PARAMS: Readonly<Record<string, string>> = Object.freeze(
  {},
);

function safeDecodeSegment(raw: string): string {
  if (!raw.includes("%")) {
    return raw;
  }
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function splitPathSegments(normalized: string): string[] {
  if (normalized === "/" || normalized.length === 0) {
    return [];
  }
  return normalized.slice(1).split("/");
}

/**
 * Returns `true` when a normalized WebSocket gateway path template contains
 * dynamic parameter (`:id`) or wildcard (`*`) segments.
 */
export function isDynamicWsPath(path: string): boolean {
  const normalized = normalizePath(path);
  const rawSegments = splitPathSegments(normalized);
  for (let i = 0; i < rawSegments.length; i++) {
    const seg = rawSegments[i]!;
    if (seg.startsWith(":") || seg.startsWith("*")) {
      return true;
    }
  }
  return false;
}

/**
 * Compiles a WebSocket gateway path template (e.g. `"/chat/:roomId/socket"`,
 * `"/rooms/:id([0-9]+)"`, `"/files/*path"`) into a zero-dependency segment matcher.
 */
export function compileWsPathPattern(rawPath: string): CompiledWsPath {
  const pattern = normalizePath(rawPath);
  const rawSegments = splitPathSegments(pattern);
  const segments: WsPathSegment[] = [];
  const paramNames: string[] = [];
  let isDynamic = false;

  for (let i = 0; i < rawSegments.length; i++) {
    const seg = rawSegments[i]!;

    const regexParamMatch = PARAM_WITH_REGEX_RE.exec(seg);
    if (regexParamMatch) {
      const name = regexParamMatch[1]!;
      const regexBody = regexParamMatch[2]!;
      const optional = regexParamMatch[3] === "?";
      const regex = new RegExp(`^(?:${regexBody})$`);
      isDynamic = true;
      paramNames.push(name);
      segments.push({
        kind: optional ? "optional-param" : "param",
        name,
        regex,
      });
      continue;
    }

    const optMatch = OPTIONAL_PARAM_RE.exec(seg);
    if (optMatch) {
      const name = optMatch[1]!;
      isDynamic = true;
      paramNames.push(name);
      segments.push({ kind: "optional-param", name });
      continue;
    }

    const simpleMatch = SIMPLE_PARAM_RE.exec(seg);
    if (simpleMatch) {
      const name = simpleMatch[1]!;
      isDynamic = true;
      paramNames.push(name);
      segments.push({ kind: "param", name });
      continue;
    }

    if (seg === "*") {
      isDynamic = true;
      segments.push({ kind: "wildcard" });
      continue;
    }

    const namedWildcard = NAMED_WILDCARD_RE.exec(seg);
    if (namedWildcard) {
      const name = namedWildcard[1]!;
      isDynamic = true;
      paramNames.push(name);
      segments.push({ kind: "wildcard", name });
      continue;
    }

    segments.push({ kind: "static", literal: seg });
  }

  return {
    pattern,
    isDynamic,
    paramNames,
    segments,
  };
}

/**
 * Matches a request pathname against a compiled WebSocket path pattern and returns
 * a frozen, URL-decoded `Readonly<Record<string, string>>` map on match (or `null`).
 */
export function matchWsPath(
  compiled: CompiledWsPath,
  rawPathname: string,
): Readonly<Record<string, string>> | null {
  const normalized = normalizePath(rawPathname);

  if (!compiled.isDynamic) {
    return normalized === compiled.pattern ? EMPTY_WS_PARAMS : null;
  }

  const inputSegments = splitPathSegments(normalized);
  const patternSegments = compiled.segments;
  const params: Record<string, string> = {};

  let inputIdx = 0;
  for (let i = 0; i < patternSegments.length; i++) {
    const seg = patternSegments[i]!;

    if (seg.kind === "wildcard") {
      const rest = inputSegments
        .slice(inputIdx)
        .map(safeDecodeSegment)
        .join("/");
      if (seg.name && !isDangerousKey(seg.name)) {
        params[seg.name] = rest;
      }
      return Object.freeze(params);
    }

    if (seg.kind === "optional-param") {
      if (inputIdx < inputSegments.length) {
        const rawValue = inputSegments[inputIdx]!;
        const decoded = safeDecodeSegment(rawValue);
        if (seg.regex && !seg.regex.test(decoded) && !seg.regex.test(rawValue)) {
          return null;
        }
        if (!isDangerousKey(seg.name)) {
          params[seg.name] = decoded;
        }
        inputIdx++;
      }
      continue;
    }

    if (inputIdx >= inputSegments.length) {
      return null;
    }

    const rawValue = inputSegments[inputIdx]!;
    if (seg.kind === "static") {
      if (rawValue !== seg.literal) {
        return null;
      }
      inputIdx++;
      continue;
    }

    // seg.kind === "param"
    if (rawValue.length === 0) {
      return null;
    }
    const decoded = safeDecodeSegment(rawValue);
    if (seg.regex && !seg.regex.test(decoded) && !seg.regex.test(rawValue)) {
      return null;
    }
    if (!isDangerousKey(seg.name)) {
      params[seg.name] = decoded;
    }
    inputIdx++;
  }

  if (inputIdx !== inputSegments.length) {
    return null;
  }

  return Object.freeze(params);
}
