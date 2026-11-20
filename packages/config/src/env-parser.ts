import { existsSync, readFileSync } from "node:fs";
import type { ExpandVariablesOptions } from "./interfaces/config.interface";
import type { Parser } from "./types/path.types";

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

export interface ParsedEnvEntry {
  readonly value: string;
  readonly singleQuoted: boolean;
}

function unescapeDoubleQuoted(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (ch === "\\" && i + 1 < raw.length) {
      const next = raw[i + 1]!;
      if (next === "n") {
        out += "\n";
        i++;
        continue;
      }
      if (next === "r") {
        out += "\r";
        i++;
        continue;
      }
      if (next === "t") {
        out += "\t";
        i++;
        continue;
      }
      if (next === '"' || next === "\\") {
        out += next;
        i++;
        continue;
      }
      if (next === "$") {
        // Keep `\$` sentinel so variable expansion treats it as a literal `$`
        out += "\\$";
        i++;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

function stripInlineComment(raw: string): string {
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "#" && i > 0 && /\s/.test(raw[i - 1]!)) {
      return raw.slice(0, i).trimEnd();
    }
  }
  return raw.trimEnd();
}

/**
 * Parses `.env` content supporting comments, `export` prefixes, single/double/backtick
 * quotes, multiline quoted strings, escaped newlines (`\n`), and inline comments.
 */
export function parseEnvEntries(content: string): Map<string, ParsedEnvEntry> {
  const entries = new Map<string, ParsedEnvEntry>();
  const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const len = normalized.length;
  let pos = 0;

  while (pos < len) {
    // Skip leading whitespace and blank lines
    while (
      pos < len &&
      (normalized[pos] === " " ||
        normalized[pos] === "\t" ||
        normalized[pos] === "\n")
    ) {
      pos++;
    }
    if (pos >= len) break;

    // Skip full-line comments
    if (normalized[pos] === "#") {
      const nl = normalized.indexOf("\n", pos);
      pos = nl === -1 ? len : nl + 1;
      continue;
    }

    // Optional `export ` prefix
    if (normalized.startsWith("export", pos)) {
      const afterExport = normalized[pos + 6];
      if (afterExport === " " || afterExport === "\t") {
        pos += 6;
        while (
          pos < len &&
          (normalized[pos] === " " || normalized[pos] === "\t")
        ) {
          pos++;
        }
      }
    }

    // Read key up to `=` or newline
    const eqIdx = normalized.indexOf("=", pos);
    const nlIdx = normalized.indexOf("\n", pos);
    if (eqIdx === -1 || (nlIdx !== -1 && nlIdx < eqIdx)) {
      pos = nlIdx === -1 ? len : nlIdx + 1;
      continue;
    }

    const key = normalized.slice(pos, eqIdx).trim();
    pos = eqIdx + 1;

    // Skip horizontal spaces after `=`
    while (pos < len && (normalized[pos] === " " || normalized[pos] === "\t")) {
      pos++;
    }

    let value = "";
    let singleQuoted = false;

    const quote = normalized[pos];
    if (quote === '"' || quote === "'" || quote === "`") {
      singleQuoted = quote === "'";
      pos++; // consume opening quote
      const start = pos;
      let end = -1;

      while (pos < len) {
        const ch = normalized[pos]!;
        if (ch === "\\" && quote === '"' && pos + 1 < len) {
          pos += 2;
          continue;
        }
        if (ch === quote) {
          end = pos;
          pos++; // consume closing quote
          break;
        }
        pos++;
      }

      const rawQuoted =
        end === -1 ? normalized.slice(start) : normalized.slice(start, end);
      value = quote === '"' ? unescapeDoubleQuoted(rawQuoted) : rawQuoted;

      // Consume rest of line after closing quote
      const restNl = normalized.indexOf("\n", pos);
      pos = restNl === -1 ? len : restNl + 1;
    } else {
      const lineEnd = normalized.indexOf("\n", pos);
      const rawLine =
        lineEnd === -1 ? normalized.slice(pos) : normalized.slice(pos, lineEnd);
      value = stripInlineComment(rawLine).trim();
      pos = lineEnd === -1 ? len : lineEnd + 1;
    }

    if (key && ENV_KEY_RE.test(key) && !DANGEROUS_KEYS.has(key)) {
      entries.set(key, { value, singleQuoted });
    }
  }

  return entries;
}

/**
 * Convenience helper returning a plain key-value record from `.env` content
 * (accepts `string` or `Buffer` for upstream `@nestjs/config` parser compatibility).
 */
export function parseEnvContent(
  content: string | Buffer,
): Record<string, string> {
  const text =
    typeof content === "string" ? content : content.toString("utf8");
  const entries = parseEnvEntries(text);
  const out: Record<string, string> = {};
  for (const [key, entry] of entries.entries()) {
    Object.defineProperty(out, key, {
      value: entry.singleQuoted
        ? entry.value
        : entry.value.replace(/\\\$/g, "$"),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

/**
 * Returns Bunest's default `.env` parser function (`parseEnvContent`).
 */
export const getDefaultParser = (): Parser => parseEnvContent;

function expandStringValue(
  raw: string,
  lookup: (name: string) => string | undefined,
  visiting: Set<string>,
): string {
  let result = "";
  let i = 0;

  while (i < raw.length) {
    const ch = raw[i]!;

    // Escaped dollar `\$` -> literal `$`
    if (ch === "\\" && raw[i + 1] === "$") {
      result += "$";
      i += 2;
      continue;
    }

    if (ch === "$") {
      // Braced expression `${VAR}`, `${VAR:-default}`, `${VAR-default}`
      if (raw[i + 1] === "{") {
        let depth = 1;
        let j = i + 2;
        while (j < raw.length && depth > 0) {
          if (raw[j] === "\\" && j + 1 < raw.length) {
            j += 2;
            continue;
          }
          if (raw[j] === "$" && raw[j + 1] === "{") {
            depth++;
            j += 2;
            continue;
          }
          if (raw[j] === "}") {
            depth--;
            if (depth === 0) break;
          }
          j++;
        }

        if (depth === 0) {
          const expr = raw.slice(i + 2, j);
          result += evaluateBraceExpression(expr, lookup, visiting);
          i = j + 1;
          continue;
        }
      }

      // Unbraced `$VAR`
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(raw.slice(i + 1));
      if (match) {
        const varName = match[0]!;
        result += resolveVariable(varName, lookup, visiting) ?? "";
        i += 1 + varName.length;
        continue;
      }
    }

    result += ch;
    i++;
  }

  return result;
}

function evaluateBraceExpression(
  expr: string,
  lookup: (name: string) => string | undefined,
  visiting: Set<string>,
): string {
  const opMatch = /^([A-Za-z_][A-Za-z0-9_]*)(?:(:-|:=|-|=)([\s\S]*))?$/.exec(
    expr,
  );
  if (!opMatch) {
    return `\${${expr}}`;
  }

  const varName = opMatch[1]!;
  const operator = opMatch[2];
  const fallbackRaw = opMatch[3] ?? "";

  const resolved = resolveVariable(varName, lookup, visiting);

  if (operator === undefined) {
    return resolved ?? "";
  }

  if (operator === ":-" || operator === ":=") {
    if (resolved !== undefined && resolved !== "") {
      return resolved;
    }
    return expandStringValue(fallbackRaw, lookup, visiting);
  }

  // `-` or `=`: use fallback only when completely unset
  if (resolved !== undefined) {
    return resolved;
  }
  return expandStringValue(fallbackRaw, lookup, visiting);
}

function resolveVariable(
  name: string,
  lookup: (varName: string) => string | undefined,
  visiting: Set<string>,
): string | undefined {
  if (visiting.has(name)) {
    return "";
  }
  const raw = lookup(name);
  if (raw === undefined) {
    return undefined;
  }
  visiting.add(name);
  try {
    return expandStringValue(raw, lookup, visiting);
  } finally {
    visiting.delete(name);
  }
}

/**
 * Expands `${VAR}` / `${VAR:-default}` / `$VAR` references across parsed `.env` entries.
 * Single-quoted values are preserved literally; escaped `\$` becomes `$`.
 */
export function expandEnvEntries(
  entries: ReadonlyMap<string, ParsedEnvEntry>,
  externalEnv: Readonly<Record<string, string | undefined>>,
  options: ExpandVariablesOptions & { override?: boolean } = {},
): Record<string, string> {
  const expanded = new Map<string, string>();
  const effectiveExternal = options.processEnv ?? externalEnv;

  const makeLookup =
    (currentKey: string) =>
    (name: string): string | undefined => {
      if (DANGEROUS_KEYS.has(name)) return undefined;
      if (options.override) {
        // When override: true, `.env` file values win over externalEnv,
        // except self-references (e.g. `PATH=/opt/bin:$PATH`) resolve from externalEnv.
        if (name === currentKey) {
          return options.ignoreProcessEnv ? undefined : effectiveExternal[name];
        }
        if (expanded.has(name)) {
          return expanded.get(name);
        }
        const entry = entries.get(name);
        if (entry !== undefined) {
          return entry.value;
        }
        if (!options.ignoreProcessEnv && effectiveExternal[name] !== undefined) {
          return effectiveExternal[name];
        }
        return undefined;
      }

      if (!options.ignoreProcessEnv && effectiveExternal[name] !== undefined) {
        return effectiveExternal[name];
      }
      if (expanded.has(name)) {
        return expanded.get(name);
      }
      const entry = entries.get(name);
      return entry?.value;
    };

  const out: Record<string, string> = {};
  for (const [key, entry] of entries.entries()) {
    const finalValue = entry.singleQuoted
      ? entry.value
      : expandStringValue(entry.value, makeLookup(key), new Set([key]));
    expanded.set(key, finalValue);
    Object.defineProperty(out, key, {
      value: finalValue,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  return out;
}

export interface LoadEnvOptions {
  readonly envFilePath?: string | readonly string[];
  readonly ignoreEnvFile?: boolean;
  readonly ignoreEnvVars?: boolean;
  readonly expandVariables?: boolean | ExpandVariablesOptions;
  readonly override?: boolean;
  readonly parser?: Parser;
  readonly envSource?: Readonly<Record<string, string | undefined>>;
}

export interface LoadedEnvSnapshot {
  readonly fileValues: Record<string, unknown>;
  readonly runtimeEnv: Record<string, string>;
  readonly combined: Record<string, unknown>;
}

/**
 * Internal helper returning separated `.env` file values, runtime environment values,
 * and merged output so `ConfigModule` can apply `validatePredefined`, `override`, and
 * `skipProcessEnv` accurately without reading files twice.
 */
export function loadEnvironmentSnapshot(
  options: LoadEnvOptions = {},
): LoadedEnvSnapshot {
  const rawRuntimeEnv = options.ignoreEnvVars
    ? {}
    : (options.envSource ?? process.env);

  const runtimeEnv: Record<string, string> = {};
  if (!options.ignoreEnvVars) {
    for (const [key, val] of Object.entries(rawRuntimeEnv)) {
      if (val !== undefined && !DANGEROUS_KEYS.has(key)) {
        Object.defineProperty(runtimeEnv, key, {
          value: val,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    }
  }

  const useCustomParser =
    typeof options.parser === "function" && options.parser !== parseEnvContent;
  const mergedEntries = new Map<string, ParsedEnvEntry>();
  const customParsedValues: Record<string, unknown> = {};

  if (!options.ignoreEnvFile) {
    const paths =
      options.envFilePath === undefined
        ? [".env"]
        : typeof options.envFilePath === "string"
          ? [options.envFilePath]
          : [...options.envFilePath];

    // Load in reverse order so earlier paths override later paths cleanly
    for (let i = paths.length - 1; i >= 0; i--) {
      const filePath = paths[i];
      if (!filePath || !existsSync(filePath)) {
        continue;
      }
      const raw = readFileSync(filePath, "utf8");
      if (useCustomParser && options.parser) {
        const parsedObj = options.parser(raw);
        if (parsedObj && typeof parsedObj === "object") {
          for (const [key, val] of Object.entries(parsedObj)) {
            if (!key || DANGEROUS_KEYS.has(key)) continue;
            Object.defineProperty(customParsedValues, key, {
              value: val,
              enumerable: true,
              writable: true,
              configurable: true,
            });
            if (typeof val === "string") {
              mergedEntries.set(key, { value: val, singleQuoted: false });
            } else {
              mergedEntries.delete(key);
            }
          }
        }
      } else {
        const parsed = parseEnvEntries(raw);
        for (const [key, entry] of parsed.entries()) {
          mergedEntries.set(key, entry);
        }
      }
    }
  }

  const fileValues: Record<string, unknown> = {};
  if (useCustomParser) {
    // Preserve non-string values produced by custom parsers (e.g. JSON/YAML parsers)
    for (const [key, val] of Object.entries(customParsedValues)) {
      if (!DANGEROUS_KEYS.has(key)) {
        Object.defineProperty(fileValues, key, {
          value: val,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    }
    if (options.expandVariables && mergedEntries.size > 0) {
      const expandOpts: ExpandVariablesOptions =
        typeof options.expandVariables === "object"
          ? options.expandVariables
          : {};
      const expandedStrings = expandEnvEntries(mergedEntries, runtimeEnv, {
        ...expandOpts,
        override: options.override,
      });
      for (const [key, val] of Object.entries(expandedStrings)) {
        if (!DANGEROUS_KEYS.has(key)) {
          Object.defineProperty(fileValues, key, {
            value: val,
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
      }
    }
  } else if (options.expandVariables) {
    const expandOpts: ExpandVariablesOptions =
      typeof options.expandVariables === "object"
        ? options.expandVariables
        : {};
    const expanded = expandEnvEntries(mergedEntries, runtimeEnv, {
      ...expandOpts,
      override: options.override,
    });
    for (const [key, val] of Object.entries(expanded)) {
      if (!DANGEROUS_KEYS.has(key)) {
        Object.defineProperty(fileValues, key, {
          value: val,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    }
  } else {
    for (const [key, entry] of mergedEntries.entries()) {
      Object.defineProperty(fileValues, key, {
        value: entry.singleQuoted
          ? entry.value
          : entry.value.replace(/\\\$/g, "$"),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }

  const combined: Record<string, unknown> = {};
  if (options.override) {
    // `.env` values override runtime env vars when `override: true`
    for (const [key, val] of Object.entries(runtimeEnv)) {
      Object.defineProperty(combined, key, {
        value: val,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    for (const [key, val] of Object.entries(fileValues)) {
      if (!DANGEROUS_KEYS.has(key)) {
        Object.defineProperty(combined, key, {
          value: val,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    }
  } else {
    // Default precedence: runtime env > earlier `.env` > later `.env`
    for (const [key, val] of Object.entries(fileValues)) {
      if (!DANGEROUS_KEYS.has(key)) {
        Object.defineProperty(combined, key, {
          value: val,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    }
    for (const [key, val] of Object.entries(runtimeEnv)) {
      Object.defineProperty(combined, key, {
        value: val,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }

  return { fileValues, runtimeEnv, combined };
}

/**
 * Loads `.env` file(s) and merges with runtime environment variables.
 * Precedence (highest to lowest):
 * 1. Runtime env vars (`envSource` / `process.env`, unless `ignoreEnvVars: true` or `override: true`)
 * 2. Earlier `.env` files in `envFilePath` (e.g. `.env.local` overrides `.env`)
 */
export function loadEnvironmentVariables(
  options: LoadEnvOptions = {},
): Record<string, unknown> {
  return loadEnvironmentSnapshot(options).combined;
}
