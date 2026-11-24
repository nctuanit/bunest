/**
 * Pure-TypeScript POSIX + Win32 path helpers (zero `node:path` dependency).
 */

const CHAR_FORWARD_SLASH = 47; // '/'
const CHAR_BACKWARD_SLASH = 92; // '\'
const CHAR_COLON = 58; // ':'
const CHAR_DOT = 46; // '.'

function isPosixSep(code: number): boolean {
  return code === CHAR_FORWARD_SLASH;
}

function isWin32Sep(code: number): boolean {
  return code === CHAR_FORWARD_SLASH || code === CHAR_BACKWARD_SLASH;
}

function isDriveLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function assertPath(p: string): void {
  if (typeof p !== "string") {
    throw new TypeError(
      `The "path" argument must be of type string. Received ${typeof p}`,
    );
  }
}

function normalizeSegments(
  segments: readonly string[],
  allowAboveRoot: boolean,
): string[] {
  const res: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (seg === "" || seg === ".") {
      continue;
    }
    if (seg === "..") {
      if (res.length > 0 && res[res.length - 1] !== "..") {
        res.pop();
      } else if (allowAboveRoot) {
        res.push("..");
      }
    } else {
      res.push(seg);
    }
  }
  return res;
}

// ---------------------------------------------------------------------------
// POSIX implementation
// ---------------------------------------------------------------------------

function posixIsAbsolute(p: string): boolean {
  assertPath(p);
  return p.length > 0 && p.charCodeAt(0) === CHAR_FORWARD_SLASH;
}

function posixNormalize(p: string): string {
  assertPath(p);
  if (p.length === 0) return ".";

  const isAbs = p.charCodeAt(0) === CHAR_FORWARD_SLASH;
  const trailingSlash = p.charCodeAt(p.length - 1) === CHAR_FORWARD_SLASH;
  const parts = normalizeSegments(p.split("/"), !isAbs);
  let out = parts.join("/");

  if (out.length === 0) {
    if (isAbs) return "/";
    return trailingSlash ? "./" : ".";
  }
  if (trailingSlash) {
    out += "/";
  }
  return isAbs ? `/${out}` : out;
}

function posixJoin(...paths: string[]): string {
  if (paths.length === 0) return ".";
  let joined = "";
  for (let i = 0; i < paths.length; i++) {
    const arg = paths[i]!;
    assertPath(arg);
    if (arg.length > 0) {
      joined = joined.length === 0 ? arg : `${joined}/${arg}`;
    }
  }
  if (joined.length === 0) return ".";
  return posixNormalize(joined);
}

function posixResolve(...paths: string[]): string {
  let resolvedPath = "";
  let resolvedAbsolute = false;

  for (let i = paths.length - 1; i >= -1 && !resolvedAbsolute; i--) {
    const p = i >= 0 ? paths[i]! : process.cwd();
    assertPath(p);
    if (p.length === 0) continue;
    resolvedPath = resolvedPath.length === 0 ? p : `${p}/${resolvedPath}`;
    resolvedAbsolute = p.charCodeAt(0) === CHAR_FORWARD_SLASH;
  }

  const normalized = normalizeSegments(
    resolvedPath.split("/"),
    !resolvedAbsolute,
  ).join("/");

  if (resolvedAbsolute) {
    return `/${normalized}`;
  }
  return normalized.length > 0 ? normalized : ".";
}

function posixRelative(from: string, to: string): string {
  assertPath(from);
  assertPath(to);
  if (from === to) return "";

  const absFrom = posixResolve(from);
  const absTo = posixResolve(to);
  if (absFrom === absTo) return "";

  const fromParts = absFrom === "/" ? [] : absFrom.slice(1).split("/");
  const toParts = absTo === "/" ? [] : absTo.slice(1).split("/");

  const minLen = Math.min(fromParts.length, toParts.length);
  let common = 0;
  while (common < minLen && fromParts[common] === toParts[common]) {
    common++;
  }

  const out: string[] = [];
  for (let i = common; i < fromParts.length; i++) {
    out.push("..");
  }
  for (let i = common; i < toParts.length; i++) {
    out.push(toParts[i]!);
  }
  return out.join("/");
}

function posixDirname(p: string): string {
  assertPath(p);
  if (p.length === 0) return ".";

  const hasRoot = p.charCodeAt(0) === CHAR_FORWARD_SLASH;
  let end = -1;
  let matchedSlash = true;
  for (let i = p.length - 1; i >= 1; i--) {
    if (isPosixSep(p.charCodeAt(i))) {
      if (!matchedSlash) {
        end = i;
        break;
      }
    } else {
      matchedSlash = false;
    }
  }

  if (end === -1) return hasRoot ? "/" : ".";
  if (hasRoot && end === 1) return "//";
  // Strip any extra trailing slashes before `end` except leading root
  let trimEnd = end;
  while (trimEnd > 1 && isPosixSep(p.charCodeAt(trimEnd - 1))) {
    trimEnd--;
  }
  return p.slice(0, trimEnd);
}

function posixBasename(p: string, suffix?: string): string {
  assertPath(p);
  if (suffix !== undefined && typeof suffix !== "string") {
    throw new TypeError('The "suffix" argument must be of type string');
  }
  let end = p.length;
  while (end > 0 && isPosixSep(p.charCodeAt(end - 1))) {
    end--;
  }
  if (end === 0) return "";

  let start = end;
  while (start > 0 && !isPosixSep(p.charCodeAt(start - 1))) {
    start--;
  }
  const base = p.slice(start, end);
  if (suffix && suffix.length > 0 && base.endsWith(suffix)) {
    return base.slice(0, base.length - suffix.length);
  }
  return base;
}

function posixExtname(p: string): string {
  assertPath(p);
  let end = p.length;
  while (end > 0 && isPosixSep(p.charCodeAt(end - 1))) {
    end--;
  }
  if (end === 0) return "";

  let start = end;
  while (start > 0 && !isPosixSep(p.charCodeAt(start - 1))) {
    start--;
  }
  const base = p.slice(start, end);
  if (base === "." || base === "..") return "";
  const dotIdx = base.lastIndexOf(".");
  if (dotIdx <= 0) return "";
  return base.slice(dotIdx);
}

// ---------------------------------------------------------------------------
// Win32 implementation
// ---------------------------------------------------------------------------

interface ParsedWin32Root {
  readonly device: string;
  readonly isAbsolute: boolean;
  readonly rest: string;
}

function parseWin32Root(p: string): ParsedWin32Root {
  const len = p.length;
  if (len === 0) {
    return { device: "", isAbsolute: false, rest: "" };
  }

  const c0 = p.charCodeAt(0);
  if (isWin32Sep(c0)) {
    if (len > 1 && isWin32Sep(p.charCodeAt(1))) {
      // UNC path \\server\share or //server/share
      let j = 2;
      while (j < len && !isWin32Sep(p.charCodeAt(j))) j++;
      if (j < len && j > 2) {
        const hostEnd = j;
        while (j < len && isWin32Sep(p.charCodeAt(j))) j++;
        const shareStart = j;
        while (j < len && !isWin32Sep(p.charCodeAt(j))) j++;
        if (j > shareStart) {
          const server = p.slice(2, hostEnd);
          const share = p.slice(shareStart, j);
          return {
            device: `\\\\${server}\\${share}`,
            isAbsolute: true,
            rest: p.slice(j),
          };
        }
      }
    }
    return { device: "", isAbsolute: true, rest: p.slice(1) };
  }

  if (len >= 2 && isDriveLetter(c0) && p.charCodeAt(1) === CHAR_COLON) {
    const drive = p.slice(0, 2);
    if (len > 2 && isWin32Sep(p.charCodeAt(2))) {
      return { device: drive, isAbsolute: true, rest: p.slice(3) };
    }
    return { device: drive, isAbsolute: false, rest: p.slice(2) };
  }

  return { device: "", isAbsolute: false, rest: p };
}

function win32IsAbsolute(p: string): boolean {
  assertPath(p);
  if (p.length === 0) return false;
  const c0 = p.charCodeAt(0);
  if (isWin32Sep(c0)) return true;
  return (
    p.length > 2 &&
    isDriveLetter(c0) &&
    p.charCodeAt(1) === CHAR_COLON &&
    isWin32Sep(p.charCodeAt(2))
  );
}

function win32Normalize(p: string): string {
  assertPath(p);
  if (p.length === 0) return ".";

  const { device, isAbsolute: isAbs, rest } = parseWin32Root(p);
  const trailingSep = isWin32Sep(p.charCodeAt(p.length - 1));
  const parts = normalizeSegments(rest.split(/[\\/]+/), !isAbs);
  let tail = parts.join("\\");

  if (tail.length === 0 && !isAbs) {
    tail = ".";
  }
  if (tail.length > 0 && trailingSep && tail !== ".") {
    tail += "\\";
  }

  if (device.length > 0) {
    if (isAbs) {
      return `${device}\\${tail}`;
    }
    return `${device}${tail}`;
  }
  return isAbs ? `\\${tail}` : tail;
}

function win32Join(...paths: string[]): string {
  if (paths.length === 0) return ".";
  let joined = "";
  for (let i = 0; i < paths.length; i++) {
    const arg = paths[i]!;
    assertPath(arg);
    if (arg.length > 0) {
      joined = joined.length === 0 ? arg : `${joined}\\${arg}`;
    }
  }
  if (joined.length === 0) return ".";
  return win32Normalize(joined);
}

function win32Resolve(...paths: string[]): string {
  let resolvedDevice = "";
  let resolvedTail = "";
  let resolvedAbsolute = false;

  for (let i = paths.length - 1; i >= -1; i--) {
    let p: string;
    if (i >= 0) {
      p = paths[i]!;
      assertPath(p);
      if (p.length === 0) continue;
    } else if (resolvedDevice.length === 0) {
      p = process.cwd();
    } else {
      break;
    }

    const parsed = parseWin32Root(p);
    if (
      parsed.device.length > 0 &&
      resolvedDevice.length > 0 &&
      parsed.device.toLowerCase() !== resolvedDevice.toLowerCase()
    ) {
      continue;
    }
    if (resolvedDevice.length === 0 && parsed.device.length > 0) {
      resolvedDevice = parsed.device;
    }
    if (!resolvedAbsolute) {
      resolvedTail =
        resolvedTail.length === 0
          ? parsed.rest
          : `${parsed.rest}\\${resolvedTail}`;
      resolvedAbsolute = parsed.isAbsolute;
    }
    if (resolvedAbsolute && resolvedDevice.length > 0) {
      break;
    }
  }

  const normalized = normalizeSegments(
    resolvedTail.split(/[\\/]+/),
    !resolvedAbsolute,
  ).join("\\");

  if (resolvedDevice.length > 0) {
    return resolvedAbsolute
      ? `${resolvedDevice}\\${normalized}`
      : `${resolvedDevice}${normalized || "."}`;
  }
  if (resolvedAbsolute) {
    return `\\${normalized}`;
  }
  return normalized.length > 0 ? normalized : ".";
}

function win32Relative(from: string, to: string): string {
  assertPath(from);
  assertPath(to);
  if (from === to) return "";

  const absFrom = win32Resolve(from);
  const absTo = win32Resolve(to);
  if (absFrom.toLowerCase() === absTo.toLowerCase()) return "";

  const fromParsed = parseWin32Root(absFrom);
  const toParsed = parseWin32Root(absTo);
  if (fromParsed.device.toLowerCase() !== toParsed.device.toLowerCase()) {
    return absTo;
  }

  const fromParts = fromParsed.rest
    .split("\\")
    .filter((s) => s.length > 0);
  const toParts = toParsed.rest.split("\\").filter((s) => s.length > 0);

  const minLen = Math.min(fromParts.length, toParts.length);
  let common = 0;
  while (
    common < minLen &&
    fromParts[common]!.toLowerCase() === toParts[common]!.toLowerCase()
  ) {
    common++;
  }

  const out: string[] = [];
  for (let i = common; i < fromParts.length; i++) {
    out.push("..");
  }
  for (let i = common; i < toParts.length; i++) {
    out.push(toParts[i]!);
  }
  return out.join("\\");
}

function win32Dirname(p: string): string {
  assertPath(p);
  if (p.length === 0) return ".";

  const parsed = parseWin32Root(p);
  const prefix = parsed.device + (parsed.isAbsolute ? "\\" : "");
  let rest = parsed.rest;
  while (rest.length > 0 && isWin32Sep(rest.charCodeAt(rest.length - 1))) {
    rest = rest.slice(0, -1);
  }
  if (rest.length === 0) {
    return prefix.length > 0 ? prefix : ".";
  }
  let idx = rest.length - 1;
  while (idx >= 0 && !isWin32Sep(rest.charCodeAt(idx))) {
    idx--;
  }
  if (idx < 0) {
    return prefix.length > 0 ? prefix : ".";
  }
  while (idx > 0 && isWin32Sep(rest.charCodeAt(idx - 1))) {
    idx--;
  }
  return `${prefix}${rest.slice(0, idx)}`;
}

function win32Basename(p: string, suffix?: string): string {
  assertPath(p);
  if (suffix !== undefined && typeof suffix !== "string") {
    throw new TypeError('The "suffix" argument must be of type string');
  }
  const { rest } = parseWin32Root(p);
  let end = rest.length;
  while (end > 0 && isWin32Sep(rest.charCodeAt(end - 1))) {
    end--;
  }
  if (end === 0) return "";
  let start = end;
  while (start > 0 && !isWin32Sep(rest.charCodeAt(start - 1))) {
    start--;
  }
  const base = rest.slice(start, end);
  if (suffix && suffix.length > 0 && base.endsWith(suffix)) {
    return base.slice(0, base.length - suffix.length);
  }
  return base;
}

function win32Extname(p: string): string {
  assertPath(p);
  const base = win32Basename(p);
  if (base === "" || base === "." || base === "..") return "";
  const dotIdx = base.lastIndexOf(String.fromCharCode(CHAR_DOT));
  if (dotIdx <= 0) return "";
  return base.slice(dotIdx);
}

export interface PlatformPath {
  readonly sep: "/" | "\\";
  isAbsolute(p: string): boolean;
  normalize(p: string): string;
  join(...paths: string[]): string;
  resolve(...paths: string[]): string;
  relative(from: string, to: string): string;
  dirname(p: string): string;
  basename(p: string, suffix?: string): string;
  extname(p: string): string;
}

export const posixPath: PlatformPath = Object.freeze({
  sep: "/",
  isAbsolute: posixIsAbsolute,
  normalize: posixNormalize,
  join: posixJoin,
  resolve: posixResolve,
  relative: posixRelative,
  dirname: posixDirname,
  basename: posixBasename,
  extname: posixExtname,
});

export const win32Path: PlatformPath = Object.freeze({
  sep: "\\",
  isAbsolute: win32IsAbsolute,
  normalize: win32Normalize,
  join: win32Join,
  resolve: win32Resolve,
  relative: win32Relative,
  dirname: win32Dirname,
  basename: win32Basename,
  extname: win32Extname,
});

const activePath: PlatformPath =
  process.platform === "win32" ? win32Path : posixPath;

export const sep: "/" | "\\" = activePath.sep;

export function isAbsolute(p: string): boolean {
  return activePath.isAbsolute(p);
}

export function normalize(p: string): string {
  return activePath.normalize(p);
}

export function join(...paths: string[]): string {
  return activePath.join(...paths);
}

export function resolve(...paths: string[]): string {
  return activePath.resolve(...paths);
}

export function relative(from: string, to: string): string {
  return activePath.relative(from, to);
}

export function dirname(p: string): string {
  return activePath.dirname(p);
}

export function basename(p: string, suffix?: string): string {
  return activePath.basename(p, suffix);
}

export function extname(p: string): string {
  return activePath.extname(p);
}
