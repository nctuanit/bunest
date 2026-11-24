import {
  METADATA_KEYS,
  MetadataRegistry,
  type Type,
  type UriVersioningOptions,
  VERSION_NEUTRAL,
  type VersioningOptions,
  VersioningType,
  type VersionValue,
} from "../../common/index";

export type NormalizedVersionToken = string | typeof VERSION_NEUTRAL;

const EMPTY_VERSIONS: readonly string[] = Object.freeze([]);

/**
 * Returns `true` when versioning requires per-request runtime resolution
 * (`HEADER`, `MEDIA_TYPE`, or `CUSTOM`). `URI` versioning compiles statically
 * into distinct route paths with zero per-request overhead.
 */
export function isRuntimeVersioning(
  options: VersioningOptions | undefined,
): boolean {
  return options !== undefined && options.type !== VersioningType.URI;
}

/**
 * Normalizes a `VersionValue` into a deduplicated non-empty array of version tokens.
 */
export function normalizeVersionValue(
  value: VersionValue | undefined,
): NormalizedVersionToken[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const list = Array.isArray(value) ? value : [value];
  const deduped: NormalizedVersionToken[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (item === VERSION_NEUTRAL) {
      if (!deduped.includes(VERSION_NEUTRAL)) {
        deduped.push(VERSION_NEUTRAL);
      }
    } else if (typeof item === "string") {
      const trimmed = item.trim();
      if (trimmed.length > 0 && !deduped.includes(trimmed)) {
        deduped.push(trimmed);
      }
    }
  }
  return deduped.length > 0 ? deduped : undefined;
}

/**
 * Resolves effective route version tokens following NestJS precedence:
 * `@Version()` on method > `@Version()` on controller class > `@Controller({ version })` > `options.defaultVersion`.
 *
 * When versioning is enabled and none of the above specify a version, returns `[VERSION_NEUTRAL]`
 * so undecorated routes (e.g. `/health`) remain reachable without a version prefix or header.
 */
export function resolveRouteVersions(
  controller: Type<unknown>,
  handlerFn: Function,
  controllerOptionVersion: VersionValue | undefined,
  versioning: VersioningOptions | undefined,
): readonly NormalizedVersionToken[] | undefined {
  if (!versioning) {
    return undefined;
  }

  const methodVersion = MetadataRegistry.get<VersionValue>(
    METADATA_KEYS.VERSION,
    handlerFn,
  );
  if (methodVersion !== undefined) {
    return normalizeVersionValue(methodVersion) ?? [VERSION_NEUTRAL];
  }

  const classDecoratorVersion = MetadataRegistry.get<VersionValue>(
    METADATA_KEYS.VERSION,
    controller,
  );
  if (classDecoratorVersion !== undefined) {
    return normalizeVersionValue(classDecoratorVersion) ?? [VERSION_NEUTRAL];
  }

  if (controllerOptionVersion !== undefined) {
    return normalizeVersionValue(controllerOptionVersion) ?? [VERSION_NEUTRAL];
  }

  if (versioning.defaultVersion !== undefined) {
    return (
      normalizeVersionValue(versioning.defaultVersion) ?? [VERSION_NEUTRAL]
    );
  }

  return [VERSION_NEUTRAL];
}

/**
 * Formats a stable string key for a `NormalizedVersionToken` (used for duplicate route detection).
 */
export function formatVersionCollisionKey(
  token: NormalizedVersionToken,
): string {
  return token === VERSION_NEUTRAL ? "ver:__neutral__" : `ver:${token}`;
}

/**
 * Formats a human-readable version label for error diagnostics.
 */
export function formatVersionLabel(token: NormalizedVersionToken): string {
  return token === VERSION_NEUTRAL ? "VERSION_NEUTRAL" : token;
}

/**
 * Formats the URI path segment for `VersioningType.URI` (e.g. `"v1"` or `"1"` when `prefix: false`).
 * Returns `undefined` for `VERSION_NEUTRAL`.
 */
export function formatUriVersionSegment(
  token: NormalizedVersionToken,
  options: UriVersioningOptions,
): string | undefined {
  if (token === VERSION_NEUTRAL) {
    return undefined;
  }
  if (options.prefix === false) {
    return token;
  }
  const prefix = options.prefix ?? "v";
  return `${prefix}${token}`;
}

/**
 * Extracts requested API version(s) from an incoming Web `Request` for
 * `HEADER`, `MEDIA_TYPE`, or `CUSTOM` versioning strategies.
 * Ordered from highest to lowest priority.
 */
function splitQuoteAware(input: string, delimiter: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let inQuotes = false;
  let escaped = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (inQuotes) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inQuotes = false;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      parts.push(input.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(input.slice(start));
  return parts;
}

function parseRfc9110ParamValue(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('"')) {
    let out = "";
    let escaped = false;
    let closed = false;
    for (let i = 1; i < trimmed.length; i++) {
      const ch = trimmed[i]!;
      if (escaped) {
        out += ch;
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        closed = i === trimmed.length - 1;
        break;
      } else {
        out += ch;
      }
    }
    if (!closed || escaped) {
      return undefined;
    }
    const finalVal = out.trim();
    return finalVal.length > 0 ? finalVal : undefined;
  }
  return trimmed;
}

export function extractRequestVersions(
  req: Request,
  options: VersioningOptions,
): readonly string[] {
  switch (options.type) {
    case VersioningType.URI:
      return EMPTY_VERSIONS;

    case VersioningType.HEADER: {
      const raw = req.headers.get(options.header);
      if (!raw) {
        return EMPTY_VERSIONS;
      }
      const trimmed = raw.trim();
      return trimmed.length > 0 ? [trimmed] : EMPTY_VERSIONS;
    }

    case VersioningType.MEDIA_TYPE: {
      const accept = req.headers.get("accept");
      if (!accept) {
        return EMPTY_VERSIONS;
      }
      const rawKey = options.key;
      const keyName = (
        rawKey.endsWith("=") ? rawKey.slice(0, -1) : rawKey
      )
        .trim()
        .toLowerCase();
      const extracted: string[] = [];

      const mediaRanges = splitQuoteAware(accept, ",");
      for (let i = 0; i < mediaRanges.length; i++) {
        const range = mediaRanges[i];
        if (!range) continue;
        const segments = splitQuoteAware(range, ";");
        if (segments.length <= 1) continue;

        for (let j = 1; j < segments.length; j++) {
          const param = segments[j]?.trim();
          if (!param) continue;
          const eqIdx = param.indexOf("=");
          if (eqIdx === -1) continue;
          const name = param.slice(0, eqIdx).trim().toLowerCase();
          if (name !== keyName) continue;
          const val = parseRfc9110ParamValue(param.slice(eqIdx + 1));
          if (val !== undefined && !extracted.includes(val)) {
            extracted.push(val);
          }
        }
      }

      return extracted.length > 0 ? extracted : EMPTY_VERSIONS;
    }

    case VersioningType.CUSTOM: {
      const extracted = options.extractor(req);
      if (typeof extracted === "string") {
        const trimmed = extracted.trim();
        return trimmed.length > 0 ? [trimmed] : EMPTY_VERSIONS;
      }
      if (Array.isArray(extracted)) {
        const out: string[] = [];
        for (let i = 0; i < extracted.length; i++) {
          const item = extracted[i];
          if (typeof item === "string") {
            const trimmed = item.trim();
            if (trimmed.length > 0 && !out.includes(trimmed)) {
              out.push(trimmed);
            }
          }
        }
        return out.length > 0 ? out : EMPTY_VERSIONS;
      }
      return EMPTY_VERSIONS;
    }
  }
}

/**
 * Selects the best matching route candidate for non-URI runtime versioning
 * (`HEADER`, `MEDIA_TYPE`, `CUSTOM`). Checks exact requested versions in
 * priority order, then falls back to `VERSION_NEUTRAL` (or unversioned) when present.
 */
export function selectVersionedCandidate<T>(
  candidates: ReadonlyArray<{
    readonly versions?: readonly NormalizedVersionToken[];
    readonly value: T;
  }>,
  requestedVersions: readonly string[],
): T | undefined {
  if (candidates.length === 0) {
    return undefined;
  }

  // 1. Exact version match in client preference order
  for (let r = 0; r < requestedVersions.length; r++) {
    const reqVer = requestedVersions[r];
    if (!reqVer) continue;
    for (let c = 0; c < candidates.length; c++) {
      const candidate = candidates[c];
      if (candidate?.versions && candidate.versions.includes(reqVer)) {
        return candidate.value;
      }
    }
  }

  // 2. VERSION_NEUTRAL or unversioned fallback
  for (let c = 0; c < candidates.length; c++) {
    const candidate = candidates[c];
    if (
      candidate &&
      (!candidate.versions ||
        candidate.versions.length === 0 ||
        candidate.versions.includes(VERSION_NEUTRAL))
    ) {
      return candidate.value;
    }
  }

  return undefined;
}
