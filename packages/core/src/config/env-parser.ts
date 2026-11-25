import { existsSyncPath, readTextSync } from "../common/index";
import type { ExpandVariablesOptions } from "./interfaces/config.interface";
import type { Parser } from "./types/path.types";

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
export const MAX_EXPANDED_ENV_VALUE_LENGTH = 128 * 1024;

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
  const text = typeof content === "string" ? content : content.toString("utf8");
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
  options?: {
    selfKey?: string;
    selfLookup?: () => string | undefined;
    maxLength?: number;
    targetKey?: string;
    noRecursiveExpand?: boolean;
  },
): string {
  let result = "";
  let i = 0;
  const maxLength = options?.maxLength;

  const append = (chunk: string) => {
    result += chunk;
    if (maxLength !== undefined && result.length > maxLength) {
      throw new Error(
        `Environment variable "${options?.targetKey ?? ""}" is too long after variable expansion`,
      );
    }
  };

  while (i < raw.length) {
    const ch = raw[i]!;

    // Escaped dollar `\$` -> literal `$`
    if (ch === "\\" && raw[i + 1] === "$") {
      append("$");
      i += 2;
      continue;
    }

    if (ch === "$") {
      // Braced expression `${VAR}`, `${VAR:-default}`, `${VAR-default}`, `${VAR:+alt}`, `${VAR+alt}`
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
          append(evaluateBraceExpression(expr, lookup, visiting, options));
          i = j + 1;
          continue;
        }
      }

      // Unbraced `$VAR`
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(raw.slice(i + 1));
      if (match) {
        const varName = match[0]!;
        append(resolveVariable(varName, lookup, visiting, options) ?? "");
        i += 1 + varName.length;
        continue;
      }
    }

    append(ch);
    i++;
  }

  return result;
}

function evaluateBraceExpression(
  expr: string,
  lookup: (name: string) => string | undefined,
  visiting: Set<string>,
  options?: {
    selfKey?: string;
    selfLookup?: () => string | undefined;
    maxLength?: number;
    targetKey?: string;
    noRecursiveExpand?: boolean;
  },
): string {
  const opMatch = /^([A-Za-z_][A-Za-z0-9_]*)(?:(:-|:=|:\+|-|=|\+)([\s\S]*))?$/.exec(
    expr,
  );
  if (!opMatch) {
    return `\${${expr}}`;
  }

  const varName = opMatch[1]!;
  const operator = opMatch[2];
  const fallbackRaw = opMatch[3] ?? "";

  const resolved = resolveVariable(varName, lookup, visiting, options);

  if (operator === undefined) {
    return resolved ?? "";
  }

  if (operator === ":+") {
    if (resolved !== undefined && resolved !== "") {
      return expandStringValue(fallbackRaw, lookup, visiting, options);
    }
    return "";
  }

  if (operator === "+") {
    if (resolved !== undefined) {
      return expandStringValue(fallbackRaw, lookup, visiting, options);
    }
    return "";
  }

  if (operator === ":-" || operator === ":=") {
    if (resolved !== undefined && resolved !== "") {
      return resolved;
    }
    return expandStringValue(fallbackRaw, lookup, visiting, options);
  }

  // `-` or `=`: use fallback only when completely unset
  if (resolved !== undefined) {
    return resolved;
  }
  return expandStringValue(fallbackRaw, lookup, visiting, options);
}

function resolveVariable(
  name: string,
  lookup: (varName: string) => string | undefined,
  visiting: Set<string>,
  options?: {
    selfKey?: string;
    selfLookup?: () => string | undefined;
    maxLength?: number;
    targetKey?: string;
    noRecursiveExpand?: boolean;
  },
): string | undefined {
  if (options?.selfKey === name && options.selfLookup) {
    return options.selfLookup();
  }
  if (visiting.has(name)) {
    return "";
  }
  const raw = lookup(name);
  if (raw === undefined) {
    return undefined;
  }
  if (options?.noRecursiveExpand) {
    return raw;
  }
  visiting.add(name);
  try {
    return expandStringValue(raw, lookup, visiting, options);
  } finally {
    visiting.delete(name);
  }
}

/**
 * Expands a single raw template string using an explicit lookup function,
 * enforcing `MAX_EXPANDED_ENV_VALUE_LENGTH` to prevent exponential blowup.
 */
export function expandSingleEnvValue(
  key: string,
  raw: string,
  lookup: (name: string) => string | undefined,
  maxLength: number = MAX_EXPANDED_ENV_VALUE_LENGTH,
): string {
  return expandStringValue(raw, lookup, new Set([key]), {
    maxLength,
    targetKey: key,
    noRecursiveExpand: true,
  });
}

/**
 * Expands `${VAR}` / `${VAR:-default}` / `${VAR:+alt}` / `$VAR` references across parsed `.env` entries.
 * Single-quoted values are preserved literally; escaped `\$` becomes `$`.
 */
export function expandEnvEntries(
  entries: ReadonlyMap<string, ParsedEnvEntry>,
  externalEnv: Readonly<Record<string, string | undefined>>,
  options: ExpandVariablesOptions & {
    override?: boolean;
    predefinedKeys?: ReadonlySet<string>;
  } = {},
): Record<string, string> {
  const expanded = new Map<string, string>();
  const effectiveExternal = options.processEnv ?? externalEnv;
  const predefinedKeys = options.predefinedKeys;

  const isExternalPredefined = (name: string): boolean => {
    if (options.ignoreProcessEnv) return false;
    const extVal = effectiveExternal[name];
    if (extVal === undefined) return false;
    if (predefinedKeys) {
      return predefinedKeys.has(name);
    }
    if (extVal === "" && entries.has(name)) {
      return false;
    }
    const entry = entries.get(name);
    if (entry && extVal === entry.value) {
      return false;
    }
    return true;
  };

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
        if (
          !options.ignoreProcessEnv &&
          effectiveExternal[name] !== undefined
        ) {
          return effectiveExternal[name];
        }
        return undefined;
      }

      if (isExternalPredefined(name)) {
        return effectiveExternal[name];
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
    };

  const out: Record<string, string> = {};
  for (const [key, entry] of entries.entries()) {
    let finalValue: string;
    if (!options.override && isExternalPredefined(key)) {
      finalValue = effectiveExternal[key]!;
    } else if (entry.singleQuoted) {
      finalValue = entry.value;
    } else if (options.override) {
      finalValue = expandStringValue(entry.value, makeLookup(key), new Set([key]), {
        selfKey: key,
        selfLookup: () =>
          options.ignoreProcessEnv ? undefined : effectiveExternal[key],
        maxLength: MAX_EXPANDED_ENV_VALUE_LENGTH,
        targetKey: key,
      });
    } else {
      finalValue = expandStringValue(entry.value, makeLookup(key), new Set([key]), {
        maxLength: MAX_EXPANDED_ENV_VALUE_LENGTH,
        targetKey: key,
      });
    }
    expanded.set(key, finalValue);
    Object.defineProperty(out, key, {
      value: finalValue,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    // Write back into custom processEnv target when supplied (dotenv-expand parity)
    if (options.processEnv) {
      if (
        options.override ||
        !Object.prototype.hasOwnProperty.call(options.processEnv, key) ||
        options.processEnv[key] === undefined ||
        options.processEnv[key] === "" ||
        options.processEnv[key] === entry.value
      ) {
        options.processEnv[key] = finalValue;
      }
    }
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
  readonly previouslyLoadedEnv?: ReadonlyMap<string, string>;
}

export interface LoadedEnvSnapshot {
  readonly fileValues: Record<string, unknown>;
  readonly runtimeEnv: Record<string, string>;
  readonly combined: Record<string, unknown>;
  readonly rawEntries: ReadonlyMap<string, ParsedEnvEntry>;
  readonly predefinedKeys: ReadonlySet<string>;
  readonly invalidNulKey?: string;
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

    // Load in forward order, keeping the first occurrence so earlier paths take precedence
    // AND key insertion order preserves the first env file's definition order.
    for (let i = 0; i < paths.length; i++) {
      const filePath = paths[i];
      if (!filePath || !existsSyncPath(filePath)) {
        continue;
      }
      const raw = readTextSync(filePath);
      if (useCustomParser && options.parser) {
        const parsedObj = options.parser(raw);
        if (parsedObj && typeof parsedObj === "object") {
          for (const [key, val] of Object.entries(parsedObj)) {
            if (!key || DANGEROUS_KEYS.has(key)) continue;
            if (!Object.prototype.hasOwnProperty.call(customParsedValues, key)) {
              Object.defineProperty(customParsedValues, key, {
                value: val,
                enumerable: true,
                writable: true,
                configurable: true,
              });
              if (typeof val === "string") {
                mergedEntries.set(key, { value: val, singleQuoted: false });
              }
            }
          }
        }
      } else {
        const parsed = parseEnvEntries(raw);
        for (const [key, entry] of parsed.entries()) {
          if (!mergedEntries.has(key)) {
            mergedEntries.set(key, entry);
          }
        }
      }
    }
  }

  // Determine which keys in externalEnv were genuinely predefined before `.env` loading.
  const expandOpts: ExpandVariablesOptions | undefined =
    typeof options.expandVariables === "object"
      ? options.expandVariables
      : options.expandVariables
        ? {}
        : undefined;
  const effectiveExternal = expandOpts?.processEnv ?? runtimeEnv;
  const predefinedKeys = new Set<string>();
  if (!options.override && !expandOpts?.ignoreProcessEnv) {
    for (const [key, extVal] of Object.entries(effectiveExternal)) {
      if (extVal === undefined) continue;
      const fileEntry = mergedEntries.get(key);
      if (fileEntry) {
        // Empty predefined variable is replaceable when expandVariables is enabled
        if (options.expandVariables && extVal === "") {
          continue;
        }
        // Predefined value identical to raw `.env` template is expanded
        if (options.expandVariables && extVal === fileEntry.value) {
          continue;
        }
        // Value written by an earlier ConfigModule.forRoot() or ConfigService.set() in the same process
        if (
          !expandOpts?.processEnv &&
          options.previouslyLoadedEnv &&
          options.previouslyLoadedEnv.get(key) === extVal
        ) {
          continue;
        }
      }
      predefinedKeys.add(key);
    }
  }

  // Check for NUL bytes in parsed env file values before expansion
  let invalidNulKey: string | undefined;
  for (const [key, entry] of mergedEntries.entries()) {
    if (entry.value.includes("\0")) {
      invalidNulKey = key;
      break;
    }
  }
  if (!invalidNulKey && useCustomParser) {
    for (const [key, val] of Object.entries(customParsedValues)) {
      if (typeof val === "string" && val.includes("\0")) {
        invalidNulKey = key;
        break;
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
    if (options.expandVariables && mergedEntries.size > 0 && !invalidNulKey) {
      const expandedStrings = expandEnvEntries(mergedEntries, runtimeEnv, {
        ...(expandOpts ?? {}),
        override: options.override,
        predefinedKeys,
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
  } else if (options.expandVariables && !invalidNulKey) {
    const expanded = expandEnvEntries(mergedEntries, runtimeEnv, {
      ...(expandOpts ?? {}),
      override: options.override,
      predefinedKeys,
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

  if (!invalidNulKey) {
    for (const [key, val] of Object.entries(fileValues)) {
      if (typeof val === "string" && val.includes("\0")) {
        invalidNulKey = key;
        break;
      }
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
    // Default precedence: predefined runtime env > earlier `.env` > later `.env`
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
      const hasFileValue = Object.prototype.hasOwnProperty.call(fileValues, key);
      if (hasFileValue && !predefinedKeys.has(key) && !expandOpts?.processEnv) {
        // Replaced by expanded file value (e.g. empty predefined or raw template or earlier bootstrap)
        continue;
      }
      if (hasFileValue && expandOpts?.processEnv) {
        // Custom processEnv target took precedence for expansion
        continue;
      }
      Object.defineProperty(combined, key, {
        value: val,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }

  return {
    fileValues,
    runtimeEnv,
    combined,
    rawEntries: mergedEntries,
    predefinedKeys,
    invalidNulKey,
  };
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

/**
 * Parses a YAML configuration string into a plain object using Bun's native `Bun.YAML.parse()`.
 */
export function parseYamlConfig(content: string): Record<string, unknown> {
  const parsed = Bun.YAML.parse(content);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

/**
 * Parses a TOML configuration string into a plain object using Bun's native `Bun.TOML.parse()`.
 */
export function parseTomlConfig(content: string): Record<string, unknown> {
  const parsed = Bun.TOML.parse(content);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

/**
 * Parses a JSONC (JSON with comments & trailing commas) configuration string using Bun's native `Bun.JSONC.parse()`.
 */
export function parseJsoncConfig(content: string): Record<string, unknown> {
  const parsed = Bun.JSONC.parse(content);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}
