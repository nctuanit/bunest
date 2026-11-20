import { realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { StaticAssetsOptions } from "@bunest/common";
import { matchesPathPattern, normalizePath } from "../scanner/path-normalizer";
import {
  evaluateCors,
  mergeCorsHeaders,
  type NormalizedCorsOptions,
} from "../security/cors";

export interface ExtendedStaticAssetsOptions
  extends Omit<StaticAssetsOptions, "index" | "cacheControl" | "maxAge"> {
  index?: boolean | string | string[];
  cacheControl?: boolean | string;
  maxAge?: number | string;
  exclude?: string[] | RegExp;
  renderPath?: string | RegExp;
  transformIndexHtml?: (
    indexHtml: string,
    req: unknown,
  ) => string | Promise<string>;
  extensions?: string[];
  setHeaders?: (res: any, path: string, stat: any) => any;
  preCompressed?: boolean;
  acceptRanges?: boolean;
  lastModified?: boolean;
  fallthrough?: boolean;
  redirect?: boolean;
}

export interface StaticAssetsMount {
  readonly rootDir: string;
  readonly resolvedRoot: string;
  readonly prefix: string;
  readonly index: false | readonly string[];
  readonly cacheControl?: string;
  readonly dotfiles: "allow" | "deny" | "ignore";
  readonly etag: boolean;
  readonly spaFallback?: string;
  readonly exclude?: readonly string[] | RegExp;
  readonly renderPath?: string | RegExp;
  readonly transformIndexHtml?: (
    indexHtml: string,
    req: unknown,
  ) => string | Promise<string>;
  readonly extensions?: readonly string[];
  readonly setHeaders?: (res: any, path: string, stat: any) => any;
  readonly preCompressed: boolean;
  readonly acceptRanges: boolean;
  readonly lastModified: boolean;
}

const DURATION_RE = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w|y)?$/i;

/**
 * Parses a numeric or duration-string `maxAge` (e.g. `3600`, `"7d"`, `"1h"`, `"30m"`, `"500ms"`)
 * into whole non-negative seconds for HTTP `Cache-Control: max-age=<seconds>`.
 */
export function parseMaxAgeSeconds(
  maxAge: number | string | undefined,
): number | undefined {
  if (maxAge === undefined) {
    return undefined;
  }
  if (typeof maxAge === "number") {
    return Number.isFinite(maxAge) ? Math.max(0, Math.floor(maxAge)) : undefined;
  }
  const trimmed = maxAge.trim();
  if (!trimmed) {
    return undefined;
  }
  const match = DURATION_RE.exec(trimmed);
  if (!match) {
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : undefined;
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value)) {
    return undefined;
  }
  const unit = (match[2] ?? "s").toLowerCase();
  let seconds: number;
  switch (unit) {
    case "ms":
      seconds = value / 1000;
      break;
    case "s":
      seconds = value;
      break;
    case "m":
      seconds = value * 60;
      break;
    case "h":
      seconds = value * 3600;
      break;
    case "d":
      seconds = value * 86_400;
      break;
    case "w":
      seconds = value * 604_800;
      break;
    case "y":
      seconds = value * 31_536_000;
      break;
    default:
      seconds = value;
  }
  return Math.max(0, Math.floor(seconds));
}

function buildStaticCacheControl(
  options: ExtendedStaticAssetsOptions,
): string | undefined {
  if (options.cacheControl === false) {
    return undefined;
  }
  if (typeof options.cacheControl === "string") {
    return options.cacheControl;
  }
  const seconds = parseMaxAgeSeconds(options.maxAge);
  if (seconds !== undefined) {
    return options.immutable
      ? `public, max-age=${seconds}, immutable`
      : `public, max-age=${seconds}`;
  }
  if (options.cacheControl === true) {
    return options.immutable
      ? "public, max-age=0, immutable"
      : "public, max-age=0";
  }
  return undefined;
}

function normalizeIndexOption(
  index: boolean | string | string[] | undefined,
): false | readonly string[] {
  if (index === false) {
    return false;
  }
  if (index === undefined || index === true) {
    return ["index.html"];
  }
  if (typeof index === "string") {
    return [index];
  }
  return index.length > 0 ? [...index] : false;
}

function matchesIfNoneMatch(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const trimmed = ifNoneMatch.trim();
  if (trimmed === "*") return true;
  const stripWeak = (t: string) =>
    t.startsWith("W/") ? t.slice(2).trim() : t.trim();
  const target = stripWeak(etag);
  for (const part of trimmed.split(",")) {
    if (stripWeak(part) === target) return true;
  }
  return false;
}

function parseByteRange(
  rangeHeader: string,
  totalSize: number,
): { start: number; end: number } | "invalid" | null {
  if (!rangeHeader.startsWith("bytes=")) return null;
  const spec = rangeHeader.slice(6).trim();
  if (spec.includes(",")) return null;
  const dashIdx = spec.indexOf("-");
  if (dashIdx === -1 || totalSize === 0) return "invalid";
  const startStr = spec.slice(0, dashIdx).trim();
  const endStr = spec.slice(dashIdx + 1).trim();
  if (startStr === "") {
    const suffixLen = Number(endStr);
    if (!Number.isInteger(suffixLen) || suffixLen <= 0) return "invalid";
    return { start: Math.max(0, totalSize - suffixLen), end: totalSize - 1 };
  }
  const start = Number(startStr);
  const end = endStr === "" ? totalSize - 1 : Number(endStr);
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start ||
    start >= totalSize
  ) {
    return "invalid";
  }
  return { start, end: Math.min(end, totalSize - 1) };
}

function matchesStaticPattern(
  pattern: string | RegExp,
  pathname: string,
): boolean {
  if (pattern instanceof RegExp) {
    return pattern.test(pathname);
  }
  const trimmed = pattern.trim();
  if (
    trimmed === "*" ||
    trimmed === "/*" ||
    trimmed === "{*any}" ||
    trimmed === "/{*any}" ||
    trimmed === "(.*)" ||
    trimmed === "/(.*)"
  ) {
    return true;
  }
  // Support Express v5 `{*splat}` wildcard syntax
  const normalizedWildcard = trimmed.replace(/\{\*[^}]+\}/g, "*");
  if (process.platform === "win32") {
    return matchesPathPattern(
      normalizedWildcard.toLowerCase(),
      pathname.toLowerCase(),
    );
  }
  return matchesPathPattern(normalizedWildcard, pathname);
}

function isPathExcluded(
  exclude: readonly string[] | RegExp | undefined,
  pathname: string,
): boolean {
  if (!exclude) {
    return false;
  }
  if (exclude instanceof RegExp) {
    return exclude.test(pathname);
  }
  for (let i = 0; i < exclude.length; i++) {
    const rule = exclude[i];
    if (rule !== undefined && matchesStaticPattern(rule, pathname)) {
      return true;
    }
  }
  return false;
}

function parseAcceptedEncodings(req: Request): Set<string> {
  const header = req.headers.get("accept-encoding");
  const out = new Set<string>();
  if (!header) return out;
  for (const raw of header.split(",")) {
    const [encPart, ...params] = raw.trim().toLowerCase().split(";");
    const enc = encPart?.trim();
    if (!enc) continue;
    let q = 1;
    for (const p of params) {
      const trimmed = p.trim();
      if (trimmed.startsWith("q=")) {
        const parsed = Number(trimmed.slice(2));
        if (Number.isFinite(parsed)) {
          q = parsed;
        }
      }
    }
    if (q > 0) {
      out.add(enc);
    }
  }
  return out;
}

function createHeadersAdapter(headers: Headers) {
  return {
    setHeader(name: string, value: string | number | readonly string[]) {
      if (Array.isArray(value)) {
        headers.delete(name);
        for (const item of value) {
          headers.append(name, String(item));
        }
      } else {
        headers.set(name, String(value));
      }
    },
    header(name: string, value: string) {
      headers.set(name, value);
    },
    appendHeader(name: string, value: string) {
      headers.append(name, value);
    },
    getHeader(name: string): string | null {
      return headers.get(name);
    },
    removeHeader(name: string) {
      headers.delete(name);
    },
    headers,
  };
}

/**
 * Creates a normalized static assets mount descriptor from `rootDir` and `StaticAssetsOptions`
 * (or extended `ServeStaticModule` options).
 */
export function createStaticAssetsMount(
  rootDir: string,
  options: StaticAssetsOptions | ExtendedStaticAssetsOptions = {},
): StaticAssetsMount {
  const ext = options as ExtendedStaticAssetsOptions;
  const normalizedDotfiles =
    ext.dotfiles === "allow" || ext.dotfiles === "deny"
      ? ext.dotfiles
      : "ignore";

  return {
    rootDir,
    resolvedRoot: resolve(rootDir),
    prefix: ext.prefix ? normalizePath(ext.prefix) : "/",
    index: normalizeIndexOption(ext.index),
    cacheControl: buildStaticCacheControl(ext),
    dotfiles: normalizedDotfiles,
    etag: ext.etag ?? true,
    spaFallback:
      ext.spaFallback === true
        ? "index.html"
        : typeof ext.spaFallback === "string"
          ? ext.spaFallback
          : undefined,
    exclude: Array.isArray(ext.exclude) ? [...ext.exclude] : ext.exclude,
    renderPath: ext.renderPath,
    transformIndexHtml: ext.transformIndexHtml,
    extensions:
      ext.extensions && ext.extensions.length > 0
        ? ext.extensions.map((e) => e.replace(/^\./, "")).filter(Boolean)
        : undefined,
    setHeaders: ext.setHeaders,
    preCompressed: ext.preCompressed === true,
    acceptRanges: ext.acceptRanges !== false,
    lastModified: ext.lastModified !== false,
  };
}

function isInsideDirectory(rootDir: string, candidatePath: string): boolean {
  const normRoot =
    process.platform === "win32" ? rootDir.toLowerCase() : rootDir;
  const normCandidate =
    process.platform === "win32" ? candidatePath.toLowerCase() : candidatePath;

  const rel = relative(normRoot, normCandidate);
  if (rel === "") {
    return true;
  }
  if (isAbsolute(rel)) {
    return false;
  }
  if (rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith("../")) {
    return false;
  }
  return true;
}

function hasUnsafeRawIndicators(rawPath: string): boolean {
  if (
    rawPath.includes("\0") ||
    rawPath.includes("\\") ||
    rawPath.includes(":")
  ) {
    return true;
  }
  const lower = rawPath.toLowerCase();
  if (
    lower.includes("%00") ||
    lower.includes("%5c") ||
    lower.includes("%3a")
  ) {
    return true;
  }
  const rawSegments = rawPath.split("/");
  for (let i = 0; i < rawSegments.length; i++) {
    const seg = rawSegments[i];
    if (seg === "..") {
      return true;
    }
  }
  return false;
}

async function attachCorsIfEnabled(
  headers: Headers,
  req: Request,
  cors: NormalizedCorsOptions | undefined,
): Promise<void> {
  if (!cors) {
    return;
  }
  try {
    const corsResult = await evaluateCors(req, cors, "GET, HEAD");
    mergeCorsHeaders(headers, corsResult.headers);
  } catch {
    // Do not fail static response if dynamic CORS callback fails
  }
}

async function createStaticErrorResponse(
  status: number,
  message: string,
  req: Request,
  cors: NormalizedCorsOptions | undefined,
): Promise<Response> {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
  });
  await attachCorsIfEnabled(headers, req, cors);
  const body =
    req.method === "HEAD"
      ? null
      : JSON.stringify({
          statusCode: status,
          message,
          error: status === 403 ? "Forbidden" : "Bad Request",
        });
  return new Response(body, { status, headers });
}

function isSafeFilename(name: string): boolean {
  return (
    name.length > 0 &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("..") &&
    !name.includes(":") &&
    !name.includes("\0")
  );
}

/**
 * Attempts to serve a static file from configured `StaticAssetsMount` entries
 * using `Bun.file()`, enforcing strict path traversal (`..`, encoded `%2e%2e`,
 * backslashes `\`, null bytes `\0`, symlink root escapes), Windows NTFS Alternate
 * Data Streams (`:`), `exclude`, `renderPath`, `transformIndexHtml`, `extensions`,
 * `setHeaders`, `preCompressed` (`.br`/`.gz`), `index` arrays, `acceptRanges`,
 * `lastModified`, `cacheControl`/`maxAge`, `etag`, and `dotfiles` policies.
 *
 * Returns `null` when no mount matches or the target file does not exist (falling
 * through to standard 404 handling).
 */
export async function tryServeStaticAsset(
  mounts: readonly StaticAssetsMount[],
  pathname: string,
  req: Request,
  cors?: NormalizedCorsOptions,
): Promise<Response | null> {
  if (mounts.length === 0) {
    return null;
  }

  const method = req.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    return null;
  }

  for (let m = 0; m < mounts.length; m++) {
    const mount = mounts[m];
    if (!mount) continue;

    // 0. Exclusion check (`exclude` option from ServeStaticModule)
    if (isPathExcluded(mount.exclude, pathname)) {
      continue;
    }

    let rawRelative: string;
    if (mount.prefix === "/") {
      rawRelative = pathname;
    } else if (pathname === mount.prefix) {
      rawRelative = "/";
    } else if (pathname.startsWith(`${mount.prefix}/`)) {
      rawRelative = pathname.slice(mount.prefix.length);
    } else {
      continue;
    }

    // 1. Pre-decode raw security check (null bytes, backslashes, NTFS ADS `:`, literal `..`)
    if (hasUnsafeRawIndicators(rawRelative)) {
      return createStaticErrorResponse(403, "Forbidden static asset path", req, cors);
    }

    // 2. Decode URI path safely
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawRelative);
    } catch {
      return createStaticErrorResponse(400, "Malformed static asset URL", req, cors);
    }

    // 3. Post-decode traversal, backslash, null-byte, and Windows NTFS ADS `:` check
    if (
      decoded.includes("\0") ||
      decoded.includes("\\") ||
      decoded.includes(":")
    ) {
      return createStaticErrorResponse(403, "Forbidden static asset path", req, cors);
    }

    // 3b. Re-check `exclude` against the decoded, normalized full path to prevent percent-encoding bypasses
    const decodedFullPath =
      mount.prefix === "/"
        ? normalizePath(decoded)
        : normalizePath(mount.prefix, decoded);
    if (isPathExcluded(mount.exclude, decodedFullPath)) {
      continue;
    }

    const rawParts = decoded.split("/");
    const segments: string[] = [];
    let isDotfilePath = false;

    for (let i = 0; i < rawParts.length; i++) {
      const seg = rawParts[i];
      if (seg === undefined || seg.length === 0) {
        continue;
      }
      if (seg === ".." || seg === ".") {
        return createStaticErrorResponse(403, "Forbidden static asset path", req, cors);
      }
      if (seg.startsWith(".")) {
        isDotfilePath = true;
      }
      segments.push(seg);
    }

    // 4. Dotfiles policy (`deny` -> 403, `ignore` -> fall through 404, `allow` -> continue)
    if (isDotfilePath) {
      if (mount.dotfiles === "deny") {
        return createStaticErrorResponse(403, "Access to dotfiles is forbidden", req, cors);
      }
      if (mount.dotfiles === "ignore") {
        continue;
      }
    }

    // 5. Resolve path & verify containment inside mount root
    let candidatePath = resolve(mount.resolvedRoot, ...segments);
    if (!isInsideDirectory(mount.resolvedRoot, candidatePath)) {
      return createStaticErrorResponse(403, "Forbidden static asset path", req, cors);
    }

    let isIndexOrSpaHtml = false;
    let fileStat: Awaited<ReturnType<typeof stat>> | undefined;
    try {
      fileStat = await stat(candidatePath);
    } catch {
      // 5a. Extension fallback (`extensions: ["html", "htm"]`) for extensionless paths
      if (
        mount.extensions &&
        mount.extensions.length > 0 &&
        segments.length > 0 &&
        extname(decoded) === ""
      ) {
        for (const ext of mount.extensions) {
          if (!isSafeFilename(ext)) continue;
          const withExt = `${candidatePath}.${ext}`;
          if (!isInsideDirectory(mount.resolvedRoot, withExt)) continue;
          try {
            const extStat = await stat(withExt);
            if (extStat.isFile()) {
              candidatePath = withExt;
              fileStat = extStat;
              break;
            }
          } catch {
            // Try next extension
          }
        }
      }

      // 5b. Optional SPA fallback (subject to `renderPath` if specified)
      if (
        !fileStat &&
        mount.spaFallback &&
        extname(decoded) === "" &&
        (!mount.renderPath ||
          matchesStaticPattern(mount.renderPath, decodedFullPath))
      ) {
        const spaPath = resolve(mount.resolvedRoot, mount.spaFallback);
        if (isInsideDirectory(mount.resolvedRoot, spaPath)) {
          try {
            const spaStat = await stat(spaPath);
            if (spaStat.isFile()) {
              candidatePath = spaPath;
              fileStat = spaStat;
              isIndexOrSpaHtml = true;
            }
          } catch {
            // Fallback file absent
          }
        }
      }

      if (!fileStat) {
        continue;
      }
    }

    // 6. Directory index handling (never expose directory listings; supports `index: string[]`)
    if (fileStat.isDirectory()) {
      if (mount.index === false) {
        continue;
      }
      let matchedIndex = false;
      for (const indexName of mount.index) {
        if (!isSafeFilename(indexName)) {
          continue;
        }
        if (indexName.startsWith(".")) {
          if (mount.dotfiles === "deny") {
            return createStaticErrorResponse(
              403,
              "Access to dotfiles is forbidden",
              req,
              cors,
            );
          }
          if (mount.dotfiles === "ignore") {
            continue;
          }
        }
        const indexPath = resolve(candidatePath, indexName);
        if (!isInsideDirectory(mount.resolvedRoot, indexPath)) {
          return createStaticErrorResponse(
            403,
            "Forbidden static asset path",
            req,
            cors,
          );
        }
        try {
          const indexStat = await stat(indexPath);
          if (indexStat.isFile()) {
            candidatePath = indexPath;
            fileStat = indexStat;
            matchedIndex = true;
            isIndexOrSpaHtml = true;
            break;
          }
        } catch {
          // Try next index candidate
        }
      }
      if (!matchedIndex) {
        continue;
      }
    }

    if (!fileStat.isFile()) {
      continue;
    }

    // 7. Realpath symlink-escape defense
    let realRoot: string;
    let realFile: string;
    try {
      [realRoot, realFile] = await Promise.all([
        realpath(mount.resolvedRoot),
        realpath(candidatePath),
      ]);
    } catch {
      continue;
    }

    if (!isInsideDirectory(realRoot, realFile)) {
      return createStaticErrorResponse(403, "Forbidden static asset path", req, cors);
    }

    // 7b. Optional `transformIndexHtml` hook for HTML index / SPA shell
    if (
      mount.transformIndexHtml &&
      (isIndexOrSpaHtml || extname(realFile).toLowerCase() === ".html")
    ) {
      const originalHtml = await Bun.file(realFile).text();
      const transformedHtml = await mount.transformIndexHtml(originalHtml, req);
      const encoded = new TextEncoder().encode(transformedHtml);
      const headers = new Headers();
      headers.set("Content-Type", "text/html; charset=utf-8");
      if (mount.acceptRanges) {
        headers.set("Accept-Ranges", "bytes");
      }
      if (mount.lastModified) {
        headers.set(
          "Last-Modified",
          new Date(Math.floor(Number(fileStat.mtimeMs))).toUTCString(),
        );
      }
      headers.set("X-Content-Type-Options", "nosniff");
      if (mount.cacheControl !== undefined) {
        headers.set("Cache-Control", mount.cacheControl);
      }
      if (mount.setHeaders) {
        mount.setHeaders(createHeadersAdapter(headers), realFile, fileStat);
      }
      await attachCorsIfEnabled(headers, req, cors);
      headers.set("Content-Length", String(encoded.byteLength));
      if (method === "HEAD") {
        return new Response(null, { status: 200, headers });
      }
      return new Response(encoded, { status: 200, headers });
    }

    // 7c. Optional pre-compressed sibling (`.br` / `.gz`) resolution
    const originalFile = Bun.file(realFile);
    const originalContentType = originalFile.type || "application/octet-stream";
    let servedFilePath = realFile;
    let servedStat = fileStat;
    let contentEncoding: "br" | "gzip" | undefined;

    if (mount.preCompressed) {
      const accepted = parseAcceptedEncodings(req);
      const candidates: Array<{ ext: string; enc: "br" | "gzip" }> = [];
      if (accepted.has("br")) candidates.push({ ext: ".br", enc: "br" });
      if (accepted.has("gzip")) candidates.push({ ext: ".gz", enc: "gzip" });

      for (const cand of candidates) {
        const compPath = `${realFile}${cand.ext}`;
        try {
          const [compStat, realComp] = await Promise.all([
            stat(compPath),
            realpath(compPath),
          ]);
          if (compStat.isFile() && isInsideDirectory(realRoot, realComp)) {
            servedFilePath = realComp;
            servedStat = compStat;
            contentEncoding = cand.enc;
            break;
          }
        } catch {
          // Compressed sibling not present
        }
      }
    }

    // 8. Serve file directly via zero-copy `Bun.file()` with ETag (304) & Range (206) support
    const bunFile =
      servedFilePath === realFile ? originalFile : Bun.file(servedFilePath);
    const headers = new Headers();
    const mtimeMs = Math.floor(Number(servedStat.mtimeMs));
    const fileSize = Number(servedStat.size);
    const etag = `W/"${fileSize.toString(16)}-${mtimeMs.toString(16)}${contentEncoding ? `-${contentEncoding}` : ""}"`;
    headers.set("Content-Type", originalContentType);
    if (contentEncoding) {
      headers.set("Content-Encoding", contentEncoding);
    }
    if (mount.preCompressed) {
      headers.append("Vary", "Accept-Encoding");
    }
    if (mount.acceptRanges) {
      headers.set("Accept-Ranges", "bytes");
    }
    if (mount.lastModified) {
      headers.set("Last-Modified", new Date(mtimeMs).toUTCString());
    }
    headers.set("X-Content-Type-Options", "nosniff");
    if (mount.etag) {
      headers.set("ETag", etag);
    }
    if (mount.cacheControl !== undefined) {
      headers.set("Cache-Control", mount.cacheControl);
    }
    if (mount.setHeaders) {
      mount.setHeaders(createHeadersAdapter(headers), realFile, servedStat);
    }
    await attachCorsIfEnabled(headers, req, cors);

    if (
      mount.etag &&
      matchesIfNoneMatch(req.headers.get("if-none-match"), etag)
    ) {
      return new Response(null, { status: 304, headers });
    }

    const rangeHeader = mount.acceptRanges ? req.headers.get("range") : null;
    if (rangeHeader) {
      const parsedRange = parseByteRange(rangeHeader, fileSize);
      if (parsedRange === "invalid") {
        headers.set("Content-Range", `bytes */${fileSize}`);
        return new Response(null, { status: 416, headers });
      }
      if (parsedRange !== null) {
        const { start, end } = parsedRange;
        headers.set(
          "Content-Range",
          `bytes ${start}-${end}/${fileSize}`,
        );
        headers.set("Content-Length", String(end - start + 1));
        if (method === "HEAD") {
          return new Response(null, { status: 206, headers });
        }
        return new Response(bunFile.slice(start, end + 1), {
          status: 206,
          headers,
        });
      }
    }

    headers.set("Content-Length", String(fileSize));
    if (method === "HEAD") {
      return new Response(null, { status: 200, headers });
    }
    return new Response(bunFile, { status: 200, headers });
  }

  return null;
}
