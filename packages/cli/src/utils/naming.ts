import {
  basename,
  dirname,
  isAbsolute,
  realpathSyncOf,
  relative,
  resolve,
} from "@bunest/core";

const VALID_PROJECT_NAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const VALID_SEGMENT_REGEX = /^_*[a-zA-Z][a-zA-Z0-9._-]{0,63}$/;

export interface ParsedSchematicName {
  readonly subDir: string;
  readonly rawName: string;
  readonly kebab: string;
  readonly pascal: string;
  readonly camel: string;
}

/**
 * Converts PascalCase, camelCase, snake_case, or space-separated names into kebab-case.
 */
export function toKebabCase(input: string): string {
  return input
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/[_\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

/**
 * Converts kebab-case, snake_case, or camelCase strings into PascalCase.
 */
export function toPascalCase(input: string): string {
  const kebab = toKebabCase(input);
  return kebab
    .split(/[-.]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/**
 * Converts kebab-case, snake_case, or PascalCase strings into camelCase.
 */
export function toCamelCase(input: string): string {
  const pascal = toPascalCase(input);
  if (pascal.length === 0) {
    return "";
  }
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

/**
 * Validates a project name for `bunest new`, strictly preventing path traversal
 * and unsafe filesystem characters.
 */
export function validateProjectName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Error("Project name is required.");
  }
  if (
    trimmed.includes("..") ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("\0")
  ) {
    throw new Error(
      `Invalid project name "${name}": path separators and traversal segments ("..") are not allowed.`,
    );
  }
  if (!VALID_PROJECT_NAME_REGEX.test(trimmed)) {
    throw new Error(
      `Invalid project name "${name}": must start with an alphanumeric character and contain only letters, digits, ".", "_", or "-".`,
    );
  }
  return trimmed;
}

/**
 * Validates a schematic name (supporting optional nested folders such as
 * `admin/user-profile`) while strictly blocking path traversal or invalid
 * TypeScript identifier segments.
 */
function normalizeSchematicSegment(segment: string): string {
  const leadingUnderscores = /^_+/.exec(segment)?.[0] ?? "";
  const rest = segment.slice(leadingUnderscores.length);
  const normalizedRest = rest
    .split(".")
    .map((part) => toKebabCase(part))
    .filter((part) => part.length > 0)
    .join(".");
  return `${leadingUnderscores}${normalizedRest}`;
}

export function parseSchematicName(input: string): ParsedSchematicName {
  const normalized = input.trim().replace(/\\/g, "/");
  if (normalized.length === 0) {
    throw new Error("Schematic name is required.");
  }
  if (
    normalized.includes("\0") ||
    normalized.startsWith("/") ||
    /^[a-zA-Z]:/.test(normalized)
  ) {
    throw new Error(
      `Invalid schematic name "${input}": absolute paths and null bytes are not allowed.`,
    );
  }

  const rawSegments = normalized.split("/");
  const segments: string[] = [];

  for (const segment of rawSegments) {
    if (
      segment === "" ||
      segment === "." ||
      segment === ".." ||
      segment.includes("..") ||
      segment.startsWith(".") ||
      segment.endsWith(".")
    ) {
      throw new Error(
        `Invalid schematic name "${input}": empty or path-traversal segments ("..", ".") are not allowed.`,
      );
    }
    if (!VALID_SEGMENT_REGEX.test(segment)) {
      throw new Error(
        `Invalid schematic name segment "${segment}": must start with a letter or "_" and contain only letters, digits, ".", "-", or "_".`,
      );
    }
    segments.push(segment);
  }

  const leaf = segments[segments.length - 1]!;
  const dirSegments = segments.slice(0, -1).map((s) => normalizeSchematicSegment(s));
  const kebab = normalizeSchematicSegment(leaf);
  const pascal = toPascalCase(leaf);
  const camel = toCamelCase(leaf);

  if (kebab.length === 0 || pascal.length === 0) {
    throw new Error(`Invalid schematic name "${input}".`);
  }

  return {
    subDir: dirSegments.join("/"),
    rawName: leaf,
    kebab,
    pascal,
    camel,
  };
}

function isOutsideOrEqual(rel: string): boolean {
  return (
    rel === "" ||
    rel === ".." ||
    rel.startsWith("../") ||
    rel.startsWith("..\\") ||
    isAbsolute(rel)
  );
}

function resolveRealPath(targetPath: string): string {
  let probe = targetPath;
  const suffixParts: string[] = [];
  while (true) {
    try {
      const realProbe = realpathSyncOf(probe);
      return suffixParts.length > 0
        ? resolve(realProbe, ...suffixParts.reverse())
        : realProbe;
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return targetPath;
      suffixParts.push(basename(probe));
      probe = parent;
    }
  }
}

/**
 * Resolves `relativePath` under `baseDir` and verifies the resulting path
 * cannot escape `baseDir` (lexically or via symlinks) and is not `baseDir` itself.
 */
export function resolveSafeChildPath(
  baseDir: string,
  relativePath: string,
): string {
  const resolvedBase = resolve(baseDir);
  const resolvedTarget = resolve(resolvedBase, relativePath);
  const rel = relative(resolvedBase, resolvedTarget);

  if (isOutsideOrEqual(rel)) {
    throw new Error(
      `Unsafe target path "${relativePath}": outside of or equal to the project directory "${resolvedBase}".`,
    );
  }

  const realBase = resolveRealPath(resolvedBase);
  const realTarget = resolveRealPath(resolvedTarget);
  const realRel = relative(realBase, realTarget);
  if (isOutsideOrEqual(realRel)) {
    throw new Error(
      `Unsafe target path "${relativePath}": resolves outside of or equal to the project directory "${resolvedBase}".`,
    );
  }

  return resolvedTarget;
}
