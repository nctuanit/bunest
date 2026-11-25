import type { BunPlugin } from "bun";
import {
  dirname,
  ensureDir,
  join,
  readDirEntries,
  relative,
  resolve,
} from "@bunest/core";

export interface BunestMetadataPluginOptions {
  /**
   * File name suffixes matched for DTO/entity/model introspection.
   * @default [".dto.ts", ".entity.ts", ".model.ts"]
   */
  dtoFileNameSuffix?: string | readonly string[];
  /**
   * File name suffixes matched for controller introspection.
   * @default [".controller.ts"]
   */
  controllerFileNameSuffix?: string | readonly string[];
  /**
   * Automatically emit Swagger `Symbol.for("bunest:swagger:api_properties")` metadata.
   * @default true
   */
  swagger?: boolean;
  /**
   * Automatically emit GraphQL `Symbol.for("bunest:graphql:fields")` metadata.
   * @default false
   */
  graphql?: boolean;
  /**
   * Extract leading JSDoc comments (`/** ... *\/`) as DTO/controller descriptions.
   * @default true
   */
  introspectComments?: boolean;
  /**
   * Infer OpenAPI validation constraints (`format`, `minimum`, `maximum`, `minLength`,
   * `maxLength`, `pattern`, `minItems`, `maxItems`, `uniqueItems`, etc.) from `class-validator` decorators.
   * @default true
   */
  classValidatorShim?: boolean;
  /**
   * Respect `class-transformer` `@Expose()` / `@Exclude()` decorators.
   * - `false` (default): ignore class-transformer visibility
   * - `true`: exclude `@Exclude()` properties
   * - `"exclusive"`: include only `@Expose()` properties
   */
  classTransformerShim?: boolean | "exclusive";
  /**
   * Property key receiving JSDoc comments on DTO properties.
   * @default "description"
   */
  dtoKeyOfComment?: string;
  /**
   * Property key receiving JSDoc comments on controller operations.
   * @default "summary"
   */
  controllerKeyOfComment?: string;
  /**
   * Emit `.js` import extensions in generated static `metadata.ts`.
   */
  esmCompatible?: boolean;
  /**
   * Internal flag indicating whether `esmCompatible` was explicitly configured.
   */
  esmCompatibleWasConfigured?: boolean;
  /**
   * Emit `readOnly: true` for `readonly` DTO class properties.
   * @default false
   */
  readonly?: boolean;
  /**
   * Source directory root for static `generateMetadataFile()` scanning.
   */
  pathToSource?: string;
  /**
   * Enable diagnostic debug logging during transformation.
   * @default false
   */
  debug?: boolean;
  /**
   * Extract TypeScript constructor parameter properties (`constructor(public id: string)`).
   * @default false
   */
  parameterProperties?: boolean;
  /**
   * Skip auto-emitting default HTTP status codes (200/201) during controller introspection.
   * @default false
   */
  skipAutoHttpCode?: boolean;
  /**
   * Skip emitting property default values inferred from literal initializers (`page = 1`).
   * @default false
   */
  skipDefaultValues?: boolean;
  /**
   * Output directory for static `generateMetadataFile()` (`metadata.ts`).
   */
  outDir?: string;
  /**
   * Custom output filename for static `generateMetadataFile()`.
   * @default "metadata.ts"
   */
  filename?: string;
  /**
   * Project root directory for resolving relative paths.
   */
  rootDir?: string;
  /**
   * Automatically populate `enumName` on properties referencing named TypeScript enums.
   * @default false
   */
  autoFillEnumName?: boolean;
}

export interface ExtractedValidationConstraints {
  readonly typeOverride?: string;
  readonly format?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly uniqueItems?: boolean;
}

export interface ExtractedDtoProperty {
  readonly name: string;
  readonly aliasName?: string;
  readonly rawType: string;
  readonly required: boolean;
  readonly nullable: boolean;
  readonly isArray: boolean;
  readonly isReadonly?: boolean;
  readonly typeExpr?: string;
  readonly enumExpr?: string;
  readonly enumName?: string;
  readonly enumLiterals?: readonly (string | number)[];
  readonly defaultValue?: unknown;
  readonly hasDefaultValue?: boolean;
  readonly description?: string;
  readonly constraints?: ExtractedValidationConstraints;
  readonly hideSwagger: boolean;
  readonly hideGraphql: boolean;
}

export interface ExtractedDtoClass {
  readonly name: string;
  readonly properties: readonly ExtractedDtoProperty[];
}

export interface TransformDtoMetadataResult {
  readonly code: string;
  readonly modified: boolean;
  readonly classes: readonly ExtractedDtoClass[];
}

export interface ExtractedControllerMethod {
  readonly name: string;
  readonly httpMethod: string;
  readonly status?: number;
  readonly summary?: string;
  readonly returnTypeExpr?: string;
  readonly isArray: boolean;
}

export interface ExtractedControllerClass {
  readonly name: string;
  readonly methods: readonly ExtractedControllerMethod[];
}

export interface TransformControllerMetadataResult {
  readonly code: string;
  readonly modified: boolean;
  readonly controllers: readonly ExtractedControllerClass[];
}

export interface GenerateMetadataFileResult {
  readonly outputPath: string;
  readonly code: string;
  readonly modelsCount: number;
  readonly controllersCount: number;
}

const DEFAULT_DTO_SUFFIXES: readonly string[] = [
  ".dto.ts",
  ".entity.ts",
  ".model.ts",
];

const DEFAULT_CONTROLLER_SUFFIXES: readonly string[] = [".controller.ts"];

const SWAGGER_API_PROPERTIES_SYMBOL = "bunest:swagger:api_properties";
const SWAGGER_API_OPERATION_SYMBOL = "bunest:swagger:api_operation";
const SWAGGER_API_RESPONSES_SYMBOL = "bunest:swagger:api_responses";
const GRAPHQL_FIELDS_SYMBOL = "bunest:graphql:fields";

interface FileSymbolTable {
  readonly runtimeValues: Set<string>;
  readonly runtimeEnums: Set<string>;
  readonly typeOnlySymbols: Set<string>;
  readonly typeAliases: Map<string, string>;
}

interface ParsedDecorator {
  readonly name: string;
  readonly shortName: string;
  readonly rawArgs: string;
}

function normalizeSuffixes(
  input: string | readonly string[] | undefined,
  defaults: readonly string[],
): readonly string[] {
  if (input === undefined) return defaults;
  const list = (typeof input === "string" ? [input] : [...input]).filter(
    (s) => s.length > 0,
  );
  return list.length > 0 ? list : defaults;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildSuffixFilter(suffixes: readonly string[]): RegExp {
  return new RegExp(`(?:${suffixes.map(escapeRegex).join("|")})$`, "i");
}

const REGEX_PRECEDING_KEYWORDS = new Set([
  "return",
  "throw",
  "case",
  "in",
  "of",
  "typeof",
  "void",
  "delete",
  "new",
  "yield",
  "await",
  "else",
  "do",
]);

function canStartRegexLiteral(
  maskedChars: readonly string[],
  index: number,
): boolean {
  let j = index - 1;
  while (j >= 0 && /\s/.test(maskedChars[j]!)) {
    j--;
  }
  if (j < 0) {
    return true;
  }
  const prev = maskedChars[j]!;
  if ("([{,;: =!?&|^~+-*%<>".includes(prev)) {
    return true;
  }
  if (/[A-Za-z0-9_$]/.test(prev)) {
    let start = j;
    while (start > 0 && /[A-Za-z0-9_$]/.test(maskedChars[start - 1]!)) {
      start--;
    }
    const word = maskedChars.slice(start, j + 1).join("");
    return REGEX_PRECEDING_KEYWORDS.has(word);
  }
  return false;
}

/**
 * Replaces comments, string literal contents, and regex literal contents with
 * whitespace of identical length so character indices map 1:1 back to the original
 * source without false matches inside strings, regexes, or comments. Preserves line breaks.
 */
function maskCommentsAndStrings(source: string): {
  masked: string;
  jsDocs: Array<{ start: number; end: number; text: string }>;
} {
  const len = source.length;
  const out = new Array<string>(len);
  const jsDocs: Array<{ start: number; end: number; text: string }> = [];

  let i = 0;
  while (i < len) {
    const ch = source[i]!;
    const next = source[i + 1];

    // Single-line comment
    if (ch === "/" && next === "/") {
      out[i++] = " ";
      out[i++] = " ";
      while (i < len && source[i] !== "\n") {
        out[i++] = " ";
      }
      continue;
    }

    // Block / JSDoc comment
    if (ch === "/" && next === "*") {
      const start = i;
      const isJsDoc = source[i + 2] === "*" && source[i + 3] !== "/";
      out[i++] = " ";
      out[i++] = " ";
      while (i < len) {
        if (source[i] === "*" && source[i + 1] === "/") {
          out[i++] = " ";
          out[i++] = " ";
          break;
        }
        out[i] = source[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (isJsDoc) {
        jsDocs.push({
          start,
          end: i,
          text: cleanJsDocComment(source.slice(start, i)),
        });
      }
      continue;
    }

    // Regex literal `/pattern/flags`
    if (
      ch === "/" &&
      next !== "/" &&
      next !== "*" &&
      canStartRegexLiteral(out, i)
    ) {
      let scan = i + 1;
      let inCharClass = false;
      let closedAt = -1;
      while (scan < len) {
        const c = source[scan]!;
        if (c === "\n" || c === "\r") {
          break;
        }
        if (c === "\\" && scan + 1 < len) {
          scan += 2;
          continue;
        }
        if (c === "[") {
          inCharClass = true;
        } else if (c === "]") {
          inCharClass = false;
        } else if (c === "/" && !inCharClass) {
          closedAt = scan;
          break;
        }
        scan++;
      }
      if (closedAt !== -1) {
        out[i++] = "/";
        while (i < closedAt) {
          out[i++] = " ";
        }
        out[i++] = "/";
        while (i < len && /[a-z]/i.test(source[i]!)) {
          out[i] = source[i]!;
          i++;
        }
        continue;
      }
    }

    // Single or double quoted string literal
    if (ch === "'" || ch === '"') {
      const quote = ch;
      out[i++] = ch;
      while (i < len) {
        const c = source[i]!;
        if (c === "\\" && i + 1 < len) {
          out[i++] = " ";
          out[i] = source[i] === "\n" ? "\n" : " ";
          i++;
          continue;
        }
        if (c === quote) {
          out[i++] = c;
          break;
        }
        out[i] = c === "\n" ? "\n" : " ";
        i++;
      }
      continue;
    }

    // Template literal
    if (ch === "`") {
      out[i++] = "`";
      let templateDepth = 0;
      while (i < len) {
        const c = source[i]!;
        if (c === "\\" && i + 1 < len) {
          out[i++] = " ";
          out[i] = source[i] === "\n" ? "\n" : " ";
          i++;
          continue;
        }
        if (templateDepth === 0 && c === "$" && source[i + 1] === "{") {
          out[i++] = " ";
          out[i++] = " ";
          templateDepth = 1;
          continue;
        }
        if (templateDepth > 0) {
          if (c === "{") {
            templateDepth++;
          } else if (c === "}") {
            templateDepth--;
          }
          out[i] = c === "\n" ? "\n" : " ";
          i++;
          continue;
        }
        if (c === "`") {
          out[i++] = "`";
          break;
        }
        out[i] = c === "\n" ? "\n" : " ";
        i++;
      }
      continue;
    }

    out[i] = ch;
    i++;
  }

  return { masked: out.join(""), jsDocs };
}

function cleanJsDocComment(raw: string): string {
  const inner = raw.replace(/^\/\*\*/, "").replace(/\*\/$/, "");
  const lines = inner
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\*\s?/, "").trim())
    .filter((line) => line.length > 0 && !line.startsWith("@"));
  return lines.join(" ").trim();
}

function findMatchingDelimiter(
  masked: string,
  openIndex: number,
  openChar: string,
  closeChar: string,
): number {
  let depth = 0;
  for (let i = openIndex; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === openChar) {
      depth++;
    } else if (ch === closeChar) {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

function collectFileSymbols(source: string, masked: string): FileSymbolTable {
  const runtimeValues = new Set<string>();
  const runtimeEnums = new Set<string>();
  const typeOnlySymbols = new Set<string>();
  const typeAliases = new Map<string, string>();

  // 1. Imports
  const importRegex =
    /(?:^|;|\n)\s*import\s+(type\s+)?([\s\S]*?)\s+from\s+["'][^"']+["']/g;
  for (const m of masked.matchAll(importRegex)) {
    const isWholeType = Boolean(m[1]);
    const rawClause = source
      .slice(
        (m.index ?? 0) + m[0].indexOf(m[2]!),
        (m.index ?? 0) + m[0].indexOf(m[2]!) + m[2]!.length,
      )
      .trim();

    const braceStart = rawClause.indexOf("{");
    const braceEnd = rawClause.lastIndexOf("}");
    if (braceStart !== -1 && braceEnd > braceStart) {
      const beforeBrace = rawClause
        .slice(0, braceStart)
        .replace(/,\s*$/, "")
        .trim();
      if (beforeBrace && /^[A-Za-z_$][\w$]*$/.test(beforeBrace)) {
        if (isWholeType) typeOnlySymbols.add(beforeBrace);
        else runtimeValues.add(beforeBrace);
      }
      const items = rawClause
        .slice(braceStart + 1, braceEnd)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      for (const item of items) {
        const isSpecType = isWholeType || /^type\s+/.test(item);
        const cleaned = item.replace(/^type\s+/, "").trim();
        const asMatch = cleaned.match(
          /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/,
        );
        const localName = asMatch ? asMatch[2]! : cleaned;
        if (/^[A-Za-z_$][\w$]*$/.test(localName)) {
          if (isSpecType) typeOnlySymbols.add(localName);
          else runtimeValues.add(localName);
        }
      }
      continue;
    }

    const nsMatch = rawClause.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/);
    if (nsMatch) {
      if (isWholeType) typeOnlySymbols.add(nsMatch[1]!);
      else runtimeValues.add(nsMatch[1]!);
      continue;
    }

    if (/^[A-Za-z_$][\w$]*$/.test(rawClause)) {
      if (isWholeType) typeOnlySymbols.add(rawClause);
      else runtimeValues.add(rawClause);
    }
  }

  // 2. Local classes & enums
  for (const m of masked.matchAll(
    /(?:^|;|\n)\s*(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g,
  )) {
    runtimeValues.add(m[1]!);
  }
  for (const m of masked.matchAll(
    /(?:^|;|\n)\s*(?:export\s+)?(const\s+)?enum\s+([A-Za-z_$][\w$]*)/g,
  )) {
    const isConstEnum = Boolean(m[1]);
    const enumName = m[2]!;
    if (isConstEnum) {
      typeOnlySymbols.add(enumName);
      const openIdx = masked.indexOf("{", (m.index ?? 0) + m[0].length);
      if (openIdx !== -1) {
        const closeIdx = findMatchingDelimiter(masked, openIdx, "{", "}");
        if (closeIdx !== -1) {
          const rawBody = source.slice(openIdx + 1, closeIdx);
          const entries = splitTopLevel(rawBody, ",");
          const literalTokens: string[] = [];
          let nextNumeric = 0;
          let allStatic = entries.length > 0;
          for (const entry of entries) {
            const cleanEntry = entry
              .replace(/\/\*[\s\S]*?\*\//g, "")
              .replace(/\/\/[^\n]*/g, "")
              .trim();
            if (!cleanEntry) continue;
            const eqIdx = cleanEntry.indexOf("=");
            if (eqIdx === -1) {
              literalTokens.push(String(nextNumeric++));
            } else {
              const rhs = cleanEntry.slice(eqIdx + 1).trim();
              const parsed = parseLiteralValue(rhs);
              if (!parsed.ok) {
                allStatic = false;
                break;
              }
              if (typeof parsed.value === "number") {
                nextNumeric = parsed.value + 1;
                literalTokens.push(String(parsed.value));
              } else {
                literalTokens.push(JSON.stringify(parsed.value));
              }
            }
          }
          if (allStatic && literalTokens.length > 0) {
            typeAliases.set(enumName, literalTokens.join(" | "));
          }
        }
      }
      continue;
    }
    runtimeValues.add(enumName);
    runtimeEnums.add(enumName);
  }

  // 3. Local interfaces & type aliases
  for (const m of masked.matchAll(
    /(?:^|;|\n)\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/g,
  )) {
    typeOnlySymbols.add(m[1]!);
  }
  const typeAliasRegex =
    /(?:^|;|\n)\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g;
  for (const m of masked.matchAll(typeAliasRegex)) {
    const name = m[1]!;
    typeOnlySymbols.add(name);
    const valStart = (m.index ?? 0) + m[0].indexOf("=") + 1;
    const rawRhs = source.slice(valStart, (m.index ?? 0) + m[0].length).trim();
    typeAliases.set(name, rawRhs);
  }

  return { runtimeValues, runtimeEnums, typeOnlySymbols, typeAliases };
}

function splitTopLevel(input: string, delimiter: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depthParen = 0;
  let depthBracket = 0;
  let depthBrace = 0;
  let depthAngle = 0;
  let inQuote: string | null = null;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (inQuote) {
      current += ch;
      if (ch === "\\" && i + 1 < input.length) {
        current += input[++i]!;
      } else if (ch === inQuote) {
        inQuote = null;
      }
      continue;
    }

    if (ch === "'" || ch === '"' || ch === "`") {
      inQuote = ch;
      current += ch;
      continue;
    }
    if (ch === "(") depthParen++;
    else if (ch === ")") depthParen--;
    else if (ch === "[") depthBracket++;
    else if (ch === "]") depthBracket--;
    else if (ch === "{") depthBrace++;
    else if (ch === "}") depthBrace--;
    else if (ch === "<") depthAngle++;
    else if (ch === ">" && input[i - 1] !== "=") depthAngle--;

    if (
      ch === delimiter &&
      depthParen === 0 &&
      depthBracket === 0 &&
      depthBrace === 0 &&
      depthAngle === 0
    ) {
      parts.push(current.trim());
      current = "";
      continue;
    }

    current += ch;
  }

  if (current.trim().length > 0) {
    parts.push(current.trim());
  }
  return parts;
}

function stripOuterParens(expr: string): string {
  let trimmed = expr.trim();
  while (trimmed.startsWith("(") && trimmed.endsWith(")")) {
    let depth = 0;
    let wrapsEntire = true;
    for (let i = 0; i < trimmed.length; i++) {
      if (trimmed[i] === "(") depth++;
      else if (trimmed[i] === ")") {
        depth--;
        if (depth === 0 && i < trimmed.length - 1) {
          wrapsEntire = false;
          break;
        }
      }
    }
    if (!wrapsEntire) break;
    trimmed = trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseLiteralValue(
  token: string,
): { ok: true; value: string | number } | { ok: false } {
  const t = token.trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return { ok: true, value: t.slice(1, -1) };
  }
  if (/^[+-]?\d+(?:\.\d+)?$/.test(t)) {
    return { ok: true, value: Number(t) };
  }
  return { ok: false };
}

function parseStaticInitializer(
  rawInit: string,
): { ok: true; value: unknown } | { ok: false } {
  const t = rawInit.trim();
  if (t === "true") return { ok: true, value: true };
  if (t === "false") return { ok: true, value: false };
  if (t === "null") return { ok: true, value: null };
  const lit = parseLiteralValue(t);
  if (lit.ok) return lit;
  if (t === "[]") return { ok: true, value: [] };
  if (t.startsWith("[") && t.endsWith("]")) {
    const items = splitTopLevel(t.slice(1, -1), ",");
    const parsedItems: unknown[] = [];
    for (const item of items) {
      const p = parseStaticInitializer(item);
      if (!p.ok) return { ok: false };
      parsedItems.push(p.value);
    }
    return { ok: true, value: parsedItems };
  }
  return { ok: false };
}

function extractClassValidatorConstraints(
  decorators: readonly ParsedDecorator[],
): ExtractedValidationConstraints | undefined {
  const out: {
    typeOverride?: string;
    format?: string;
    minimum?: number;
    maximum?: number;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    minItems?: number;
    maxItems?: number;
    uniqueItems?: boolean;
  } = {};

  for (const dec of decorators) {
    const firstArg = splitTopLevel(dec.rawArgs, ",")[0]?.trim() ?? "";
    const parsedNum = /^[+-]?\d+(?:\.\d+)?$/.test(firstArg)
      ? Number(firstArg)
      : undefined;

    switch (dec.shortName) {
      case "IsEmail":
        out.format = "email";
        break;
      case "IsUUID":
        out.format = "uuid";
        break;
      case "IsUrl":
        out.format = "uri";
        break;
      case "IsDateString":
        out.format = "date-time";
        break;
      case "IsInt":
        out.typeOverride = '"integer"';
        break;
      case "IsPositive":
        out.minimum = 1;
        break;
      case "IsNegative":
        out.maximum = -1;
        break;
      case "Min":
        if (parsedNum !== undefined) out.minimum = parsedNum;
        break;
      case "Max":
        if (parsedNum !== undefined) out.maximum = parsedNum;
        break;
      case "MinLength":
        if (parsedNum !== undefined) out.minLength = parsedNum;
        break;
      case "MaxLength":
        if (parsedNum !== undefined) out.maxLength = parsedNum;
        break;
      case "IsNotEmpty":
        out.minLength = Math.max(out.minLength ?? 0, 1);
        break;
      case "Matches": {
        const regexMatch = firstArg.match(/^\/((?:\\.|[^/\\])+)\/[a-z]*$/i);
        if (regexMatch) {
          out.pattern = regexMatch[1]!;
        } else {
          const lit = parseLiteralValue(firstArg);
          if (lit.ok && typeof lit.value === "string") {
            out.pattern = lit.value;
          }
        }
        break;
      }
      case "ArrayMinSize":
        if (parsedNum !== undefined) out.minItems = parsedNum;
        break;
      case "ArrayMaxSize":
        if (parsedNum !== undefined) out.maxItems = parsedNum;
        break;
      case "ArrayUnique":
        out.uniqueItems = true;
        break;
      default:
        break;
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function extractExposeAlias(
  decorators: readonly ParsedDecorator[],
): string | undefined {
  for (const dec of decorators) {
    if (dec.shortName !== "Expose") continue;
    const m = dec.rawArgs.match(/\bname\s*:\s*["']([^"']+)["']/);
    if (m) return m[1]!;
  }
  return undefined;
}

interface AnalyzedType {
  readonly isArray: boolean;
  readonly nullable: boolean;
  readonly hasUndefined: boolean;
  readonly typeExpr?: string;
  readonly enumExpr?: string;
  readonly enumLiterals?: readonly (string | number)[];
}

function analyzeTypeExpression(
  rawType: string,
  symbols: FileSymbolTable,
  visitedAliases = new Set<string>(),
): AnalyzedType {
  const cleaned = stripOuterParens(rawType.trim().replace(/^readonly\s+/, ""));
  if (!cleaned) {
    return {
      isArray: false,
      nullable: false,
      hasUndefined: false,
      typeExpr: "Object",
    };
  }

  // Unwrap Promise<T> for controller return types
  const promiseMatch = cleaned.match(/^Promise<([\s\S]+)>$/);
  if (promiseMatch) {
    return analyzeTypeExpression(promiseMatch[1]!, symbols, visitedAliases);
  }

  // Split union types `A | B | null | undefined`
  const unionParts = splitTopLevel(cleaned, "|");
  if (unionParts.length > 1) {
    let nullable = false;
    let hasUndefined = false;
    const remaining: string[] = [];

    for (const part of unionParts) {
      const p = stripOuterParens(part);
      if (p === "null") {
        nullable = true;
      } else if (p === "undefined" || p === "void") {
        hasUndefined = true;
      } else if (p.length > 0) {
        remaining.push(p);
      }
    }

    if (remaining.length === 1) {
      const inner = analyzeTypeExpression(
        remaining[0]!,
        symbols,
        visitedAliases,
      );
      return {
        ...inner,
        nullable: inner.nullable || nullable,
        hasUndefined: inner.hasUndefined || hasUndefined,
      };
    }

    if (remaining.length > 1) {
      const literals: Array<string | number> = [];
      let allLiterals = true;
      for (const part of remaining) {
        const parsed = parseLiteralValue(part);
        if (!parsed.ok) {
          allLiterals = false;
          break;
        }
        literals.push(parsed.value);
      }
      if (allLiterals && literals.length > 0) {
        const allStrings = literals.every((v) => typeof v === "string");
        const allNumbers = literals.every((v) => typeof v === "number");
        return {
          isArray: false,
          nullable,
          hasUndefined,
          typeExpr: allStrings ? "String" : allNumbers ? "Number" : "Object",
          enumLiterals: literals,
        };
      }
    }

    return {
      isArray: false,
      nullable,
      hasUndefined,
      typeExpr: "Object",
    };
  }

  if (cleaned.endsWith("[]")) {
    const elemType = cleaned.slice(0, -2).trim();
    const inner = analyzeTypeExpression(elemType, symbols, visitedAliases);
    return {
      ...inner,
      isArray: true,
    };
  }

  const arrGeneric = cleaned.match(/^(?:Array|ReadonlyArray)<([\s\S]+)>$/);
  if (arrGeneric) {
    const inner = analyzeTypeExpression(
      arrGeneric[1]!,
      symbols,
      visitedAliases,
    );
    return {
      ...inner,
      isArray: true,
    };
  }

  switch (cleaned) {
    case "string":
    case "String":
      return {
        isArray: false,
        nullable: false,
        hasUndefined: false,
        typeExpr: "String",
      };
    case "number":
    case "Number":
    case "bigint":
    case "BigInt":
      return {
        isArray: false,
        nullable: false,
        hasUndefined: false,
        typeExpr: "Number",
      };
    case "boolean":
    case "Boolean":
      return {
        isArray: false,
        nullable: false,
        hasUndefined: false,
        typeExpr: "Boolean",
      };
    case "Date":
      return {
        isArray: false,
        nullable: false,
        hasUndefined: false,
        typeExpr: "Date",
      };
    case "void":
    case "undefined":
    case "never":
      return {
        isArray: false,
        nullable: false,
        hasUndefined: true,
        typeExpr: undefined,
      };
    case "object":
    case "Object":
    case "unknown":
    case "any":
      return {
        isArray: false,
        nullable: false,
        hasUndefined: false,
        typeExpr: "Object",
      };
  }

  const singleLiteral = parseLiteralValue(cleaned);
  if (singleLiteral.ok) {
    return {
      isArray: false,
      nullable: false,
      hasUndefined: false,
      typeExpr: typeof singleLiteral.value === "string" ? "String" : "Number",
      enumLiterals: [singleLiteral.value],
    };
  }

  if (cleaned.startsWith("Record<") || cleaned.startsWith("{")) {
    return {
      isArray: false,
      nullable: false,
      hasUndefined: false,
      typeExpr: "Object",
    };
  }

  const identMatch = cleaned.match(/^([A-Za-z_$][\w$]*)(?:<[\s\S]*>)?$/);
  if (identMatch) {
    const name = identMatch[1]!;
    if (symbols.typeAliases.has(name) && !visitedAliases.has(name)) {
      const nextVisited = new Set(visitedAliases);
      nextVisited.add(name);
      return analyzeTypeExpression(
        symbols.typeAliases.get(name)!,
        symbols,
        nextVisited,
      );
    }
    if (symbols.runtimeEnums.has(name)) {
      return {
        isArray: false,
        nullable: false,
        hasUndefined: false,
        enumExpr: name,
      };
    }
    if (symbols.runtimeValues.has(name) && !symbols.typeOnlySymbols.has(name)) {
      return {
        isArray: false,
        nullable: false,
        hasUndefined: false,
        typeExpr: `() => ${name}`,
      };
    }
  }

  return {
    isArray: false,
    nullable: false,
    hasUndefined: false,
    typeExpr: "Object",
  };
}

function extractLeadingDecoratorsBeforeIndex(
  source: string,
  masked: string,
  classStartIndex: number,
): ParsedDecorator[] {
  // Walk backwards over decorators immediately preceding a class declaration
  const prefixSlice = masked.slice(0, classStartIndex);
  const lastBoundary = Math.max(
    prefixSlice.lastIndexOf(";"),
    prefixSlice.lastIndexOf("}"),
  );
  const regionStart = lastBoundary === -1 ? 0 : lastBoundary + 1;
  const decorators: ParsedDecorator[] = [];
  let cursor = regionStart;

  while (cursor < classStartIndex) {
    if (masked[cursor] === "@") {
      const nameStart = cursor + 1;
      cursor++;
      while (
        cursor < classStartIndex &&
        /[A-Za-z0-9_$.]/.test(masked[cursor]!)
      ) {
        cursor++;
      }
      const name = source.slice(nameStart, cursor).trim();
      const shortName = name.includes(".") ? name.split(".").pop()! : name;
      while (cursor < classStartIndex && /\s/.test(masked[cursor]!)) {
        cursor++;
      }
      let rawArgs = "";
      if (masked[cursor] === "(") {
        const closeParen = findMatchingDelimiter(masked, cursor, "(", ")");
        if (closeParen !== -1 && closeParen < classStartIndex) {
          rawArgs = source.slice(cursor + 1, closeParen).trim();
          cursor = closeParen + 1;
        }
      }
      if (name) {
        decorators.push({ name, shortName, rawArgs });
      }
      continue;
    }
    cursor++;
  }
  return decorators;
}

function extractConstructorParameterProperties(
  rawParams: string,
  symbols: FileSymbolTable,
  options: BunestMetadataPluginOptions,
): ExtractedDtoProperty[] {
  const result: ExtractedDtoProperty[] = [];
  const params = splitTopLevel(rawParams, ",");
  const skipDefaults = options.skipDefaultValues === true;
  const emitReadonly = options.readonly === true;
  const autoFillEnumName = options.autoFillEnumName === true;

  for (const param of params) {
    const cleaned = param
      .replace(/^@[A-Za-z0-9_$.]+(?:\([^)]*\))?\s*/g, "")
      .trim();
    const modMatch = cleaned.match(
      /^(public|protected|readonly)(?:\s+(public|protected|readonly))*\s+([A-Za-z_$][\w$]*)([?!])?\s*:\s*([\s\S]+)$/,
    );
    if (!modMatch) continue;
    const mods = cleaned.slice(0, cleaned.indexOf(modMatch[3]!));
    if (/\bprivate\b/.test(mods)) continue;
    const isReadonly = emitReadonly && /\breadonly\b/.test(mods);
    const propName = modMatch[3]!;
    const modifier = modMatch[4];
    const rhs = modMatch[5]!.trim();

    const eqIdx = rhs.indexOf("=");
    const rawType = (eqIdx === -1 ? rhs : rhs.slice(0, eqIdx)).trim();
    const rawInit = eqIdx === -1 ? undefined : rhs.slice(eqIdx + 1).trim();
    const parsedInit =
      !skipDefaults && rawInit !== undefined
        ? parseStaticInitializer(rawInit)
        : { ok: false as const };

    const analyzed = analyzeTypeExpression(rawType, symbols);
    const required =
      modifier !== "?" && rawInit === undefined && !analyzed.hasUndefined;

    result.push({
      name: propName,
      rawType,
      required,
      nullable: analyzed.nullable,
      isArray: analyzed.isArray,
      isReadonly,
      typeExpr: analyzed.typeExpr,
      enumExpr: analyzed.enumExpr,
      enumName:
        autoFillEnumName && analyzed.enumExpr ? analyzed.enumExpr : undefined,
      enumLiterals: analyzed.enumLiterals,
      defaultValue: parsedInit.ok ? parsedInit.value : undefined,
      hasDefaultValue: parsedInit.ok,
      hideSwagger: false,
      hideGraphql: false,
    });
  }
  return result;
}

function parseClassProperties(
  source: string,
  masked: string,
  bodyStart: number,
  bodyEnd: number,
  jsDocs: readonly { start: number; end: number; text: string }[],
  symbols: FileSymbolTable,
  options: BunestMetadataPluginOptions,
  classHasExclude: boolean,
): ExtractedDtoProperty[] {
  const introspectComments = options.introspectComments !== false;
  const classValidatorShim = options.classValidatorShim !== false;
  const classTransformerShim = options.classTransformerShim ?? false;
  const skipDefaultValues = options.skipDefaultValues === true;
  const emitReadonly = options.readonly === true;
  const autoFillEnumName = options.autoFillEnumName === true;
  const extractParamProps = options.parameterProperties === true;

  const properties: ExtractedDtoProperty[] = [];
  let cursor = bodyStart;

  const findPrecedingJsDoc = (
    memberStart: number,
    prevEnd: number,
  ): string | undefined => {
    if (!introspectComments) return undefined;
    for (let j = jsDocs.length - 1; j >= 0; j--) {
      const doc = jsDocs[j]!;
      if (doc.end <= memberStart && doc.start >= prevEnd) {
        return doc.text.length > 0 ? doc.text : undefined;
      }
    }
    return undefined;
  };

  let prevMemberEnd = bodyStart;

  while (cursor < bodyEnd) {
    while (
      cursor < bodyEnd &&
      (masked[cursor] === " " ||
        masked[cursor] === "\t" ||
        masked[cursor] === "\r" ||
        masked[cursor] === "\n" ||
        masked[cursor] === ";")
    ) {
      cursor++;
    }
    if (cursor >= bodyEnd) break;

    const memberStart = cursor;
    const decorators: ParsedDecorator[] = [];

    while (cursor < bodyEnd && masked[cursor] === "@") {
      const decStart = cursor + 1;
      cursor++;
      while (cursor < bodyEnd && /[A-Za-z0-9_$.]/.test(masked[cursor]!)) {
        cursor++;
      }
      const decName = source.slice(decStart, cursor).trim();
      const shortName = decName.includes(".")
        ? decName.split(".").pop()!
        : decName;
      while (cursor < bodyEnd && /\s/.test(masked[cursor]!)) {
        cursor++;
      }
      let rawArgs = "";
      if (masked[cursor] === "(") {
        const closeParen = findMatchingDelimiter(masked, cursor, "(", ")");
        if (closeParen === -1 || closeParen >= bodyEnd) {
          cursor = bodyEnd;
          break;
        }
        rawArgs = source.slice(cursor + 1, closeParen).trim();
        cursor = closeParen + 1;
      }
      if (decName) {
        decorators.push({ name: decName, shortName, rawArgs });
      }
      while (cursor < bodyEnd && /\s/.test(masked[cursor]!)) {
        cursor++;
      }
    }

    if (cursor >= bodyEnd) break;
    const declStart = cursor;

    let depthParen = 0;
    let depthBracket = 0;
    let depthBrace = 0;
    let depthAngle = 0;
    let colonPos = -1;
    let equalsPos = -1;
    let firstOpenParen = -1;
    let firstCloseParen = -1;
    let seenParenBeforeColon = false;
    let isMethodOrBlock = false;
    let declEnd = bodyEnd;

    while (cursor < bodyEnd) {
      const ch = masked[cursor]!;

      if (
        depthParen === 0 &&
        depthBracket === 0 &&
        depthBrace === 0 &&
        depthAngle === 0
      ) {
        if (ch === "(" && colonPos === -1 && equalsPos === -1) {
          seenParenBeforeColon = true;
          if (firstOpenParen === -1) {
            firstOpenParen = cursor;
            firstCloseParen = findMatchingDelimiter(masked, cursor, "(", ")");
          }
        }
        if (ch === ":" && colonPos === -1 && equalsPos === -1) {
          colonPos = cursor;
          cursor++;
          continue;
        }
        if (ch === "=" && masked[cursor + 1] !== ">" && equalsPos === -1) {
          equalsPos = cursor;
          cursor++;
          continue;
        }
        if (ch === ";") {
          declEnd = cursor;
          cursor++;
          break;
        }
        if (ch === "{") {
          const closeBrace = findMatchingDelimiter(masked, cursor, "{", "}");
          if ((colonPos === -1 && equalsPos === -1) || seenParenBeforeColon) {
            isMethodOrBlock = true;
            declEnd = closeBrace === -1 ? bodyEnd : closeBrace + 1;
            cursor = declEnd;
            break;
          }
          if (closeBrace !== -1 && closeBrace < bodyEnd) {
            cursor = closeBrace + 1;
            continue;
          }
        }
        if (ch === "\n") {
          let lookahead = cursor + 1;
          while (
            lookahead < bodyEnd &&
            (masked[lookahead] === " " || masked[lookahead] === "\t")
          ) {
            lookahead++;
          }
          const nextCh = masked[lookahead];
          if (
            nextCh &&
            nextCh !== "|" &&
            nextCh !== "&" &&
            nextCh !== "?" &&
            nextCh !== ":" &&
            nextCh !== "." &&
            nextCh !== "," &&
            (colonPos !== -1 || equalsPos !== -1)
          ) {
            let lookback = cursor - 1;
            while (lookback > declStart && /\s/.test(masked[lookback]!)) {
              lookback--;
            }
            const prevCh = masked[lookback];
            if (
              prevCh !== "=" &&
              prevCh !== ":" &&
              prevCh !== "|" &&
              prevCh !== "&" &&
              prevCh !== ","
            ) {
              declEnd = cursor;
              cursor++;
              break;
            }
          }
        }
      }

      if (ch === "(") depthParen++;
      else if (ch === ")") depthParen--;
      else if (ch === "[") depthBracket++;
      else if (ch === "]") depthBracket--;
      else if (ch === "{") depthBrace++;
      else if (ch === "}") depthBrace--;
      else if (ch === "<") depthAngle++;
      else if (ch === ">" && masked[cursor - 1] !== "=") depthAngle--;

      cursor++;
    }

    const memberEnd = cursor;
    const jsDoc = findPrecedingJsDoc(memberStart, prevMemberEnd);
    prevMemberEnd = memberEnd;

    if (isMethodOrBlock) {
      if (
        extractParamProps &&
        firstOpenParen !== -1 &&
        firstCloseParen !== -1
      ) {
        const beforeParen = source.slice(declStart, firstOpenParen).trim();
        if (beforeParen === "constructor") {
          const rawParams = source.slice(firstOpenParen + 1, firstCloseParen);
          properties.push(
            ...extractConstructorParameterProperties(
              rawParams,
              symbols,
              options,
            ),
          );
        }
      }
      continue;
    }

    if (colonPos === -1) {
      continue;
    }

    const headRaw = source.slice(declStart, colonPos).trim();
    if (
      /\b(?:static|private)\b/.test(headRaw) ||
      headRaw.includes("(") ||
      headRaw.includes("[") ||
      headRaw.startsWith("#")
    ) {
      continue;
    }

    const isReadonly = emitReadonly && /\breadonly\b/.test(headRaw);

    const strippedHead = headRaw
      .replace(/^(?:(?:public|protected|readonly|declare|override)\s+)+/, "")
      .trim();

    const propMatch = strippedHead.match(/^([A-Za-z_$][\w$]*)([?!])?$/);
    if (!propMatch) {
      continue;
    }

    const propName = propMatch[1]!;
    if (propName === "constructor") {
      continue;
    }

    // class-transformer shim filtering (`@Expose()` / `@Exclude()`)
    const hasExclude = decorators.some((d) => d.shortName === "Exclude");
    const hasExpose = decorators.some((d) => d.shortName === "Expose");
    if (classTransformerShim === "exclusive") {
      if (!hasExpose || hasExclude) continue;
    } else if (classTransformerShim === true) {
      if (hasExclude) continue;
      if (classHasExclude && !hasExpose) continue;
    }
    const aliasName = classTransformerShim
      ? extractExposeAlias(decorators)
      : undefined;

    const modifier = propMatch[2];
    const hasInitializer = equalsPos !== -1 && equalsPos < declEnd;
    const typeEnd = hasInitializer ? equalsPos : declEnd;
    const rawType = source.slice(colonPos + 1, typeEnd).trim();
    if (!rawType) {
      continue;
    }

    const parsedInit =
      hasInitializer && !skipDefaultValues
        ? parseStaticInitializer(source.slice(equalsPos + 1, declEnd))
        : { ok: false as const };

    const analyzed = analyzeTypeExpression(rawType, symbols);
    const hasIsOptionalDecorator = decorators.some(
      (d) => d.shortName === "IsOptional",
    );
    const hideSwagger = decorators.some(
      (d) => d.shortName === "ApiHideProperty",
    );
    const hideGraphql = decorators.some((d) => d.shortName === "HideField");

    const constraints = classValidatorShim
      ? extractClassValidatorConstraints(decorators)
      : undefined;

    const required =
      modifier !== "?" &&
      !hasInitializer &&
      !analyzed.hasUndefined &&
      !hasIsOptionalDecorator;

    properties.push({
      name: propName,
      aliasName,
      rawType,
      required,
      nullable: analyzed.nullable,
      isArray: analyzed.isArray,
      isReadonly,
      typeExpr: constraints?.typeOverride ?? analyzed.typeExpr,
      enumExpr: analyzed.enumExpr,
      enumName:
        autoFillEnumName && analyzed.enumExpr ? analyzed.enumExpr : undefined,
      enumLiterals: analyzed.enumLiterals,
      defaultValue: parsedInit.ok ? parsedInit.value : undefined,
      hasDefaultValue: parsedInit.ok,
      description: jsDoc,
      constraints,
      hideSwagger,
      hideGraphql,
    });
  }

  return properties;
}

function buildSwaggerEntryCode(
  prop: ExtractedDtoProperty,
  dtoKeyOfComment: string,
): string {
  const fields: string[] = [`propertyKey: ${JSON.stringify(prop.name)}`];
  if (prop.aliasName !== undefined) {
    fields.push(`name: ${JSON.stringify(prop.aliasName)}`);
  }
  if (prop.typeExpr !== undefined) {
    fields.push(`type: ${prop.typeExpr}`);
  }
  if (prop.isArray) {
    fields.push("isArray: true");
  }
  fields.push(`required: ${prop.required ? "true" : "false"}`);
  if (prop.nullable) {
    fields.push("nullable: true");
  }
  if (prop.isReadonly) {
    fields.push("readOnly: true");
  }
  if (prop.enumExpr !== undefined) {
    fields.push(`enum: ${prop.enumExpr}`);
    if (prop.enumName !== undefined) {
      fields.push(`enumName: ${JSON.stringify(prop.enumName)}`);
    }
  } else if (prop.enumLiterals !== undefined) {
    fields.push(`enum: ${JSON.stringify(prop.enumLiterals)}`);
  }
  if (prop.hasDefaultValue) {
    fields.push(`default: ${JSON.stringify(prop.defaultValue)}`);
  }
  if (prop.description !== undefined) {
    fields.push(
      `${JSON.stringify(dtoKeyOfComment)}: ${JSON.stringify(prop.description)}`,
    );
  }
  if (prop.constraints) {
    const c = prop.constraints;
    if (c.format !== undefined)
      fields.push(`format: ${JSON.stringify(c.format)}`);
    if (c.minimum !== undefined) fields.push(`minimum: ${c.minimum}`);
    if (c.maximum !== undefined) fields.push(`maximum: ${c.maximum}`);
    if (c.minLength !== undefined) fields.push(`minLength: ${c.minLength}`);
    if (c.maxLength !== undefined) fields.push(`maxLength: ${c.maxLength}`);
    if (c.pattern !== undefined)
      fields.push(`pattern: ${JSON.stringify(c.pattern)}`);
    if (c.minItems !== undefined) fields.push(`minItems: ${c.minItems}`);
    if (c.maxItems !== undefined) fields.push(`maxItems: ${c.maxItems}`);
    if (c.uniqueItems !== undefined) fields.push(`uniqueItems: true`);
  }
  return `{ ${fields.join(", ")} }`;
}

function buildGraphqlEntryCode(prop: ExtractedDtoProperty): string {
  const fields: string[] = [
    `propertyKey: ${JSON.stringify(prop.name)}`,
    `name: ${JSON.stringify(prop.aliasName ?? prop.name)}`,
  ];

  const baseTypeExpr =
    prop.enumExpr !== undefined
      ? prop.enumExpr
      : prop.typeExpr?.startsWith("() => ")
        ? prop.typeExpr.slice(6)
        : prop.typeExpr === '"integer"'
          ? "Number"
          : (prop.typeExpr ?? "String");

  const typeFnBody = prop.isArray ? `[${baseTypeExpr}]` : baseTypeExpr;
  fields.push(`typeFn: () => ${typeFnBody}`);

  if (prop.nullable || !prop.required) {
    fields.push("nullable: true");
  }
  if (prop.description !== undefined) {
    fields.push(`description: ${JSON.stringify(prop.description)}`);
  }
  return `{ ${fields.join(", ")} }`;
}

/**
 * Pure source-to-source TypeScript transformer scanning exported DTO/entity/model
 * classes and appending non-destructive runtime metadata registration calls
 * (Swagger `Symbol.for("bunest:swagger:api_properties")` and optional GraphQL
 * `Symbol.for("bunest:graphql:fields")`).
 */
export function transformDtoMetadataSource(
  source: string,
  filename = "dto.ts",
  options: BunestMetadataPluginOptions = {},
): TransformDtoMetadataResult {
  const emitSwagger = options.swagger !== false;
  const emitGraphql = options.graphql === true;
  const dtoKeyOfComment = options.dtoKeyOfComment ?? "description";

  if (!emitSwagger && !emitGraphql) {
    return { code: source, modified: false, classes: [] };
  }

  const { masked, jsDocs } = maskCommentsAndStrings(source);
  const symbols = collectFileSymbols(source, masked);

  const classes: ExtractedDtoClass[] = [];

  const classRegex =
    /(?:^|;|\n)\s*export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)\b/g;

  for (const match of masked.matchAll(classRegex)) {
    const className = match[1]!;
    const classStartIdx = match.index ?? 0;
    const afterNameIdx = classStartIdx + match[0].length;

    const prefix = masked.slice(classStartIdx, afterNameIdx);
    if (/\bdeclare\b/.test(prefix)) {
      continue;
    }

    const classDecorators = extractLeadingDecoratorsBeforeIndex(
      source,
      masked,
      classStartIdx,
    );
    const classHasExclude = classDecorators.some(
      (d) => d.shortName === "Exclude",
    );

    let braceOpen = -1;
    let angleDepth = 0;
    for (let i = afterNameIdx; i < masked.length; i++) {
      const ch = masked[i];
      if (ch === "<") angleDepth++;
      else if (ch === ">" && masked[i - 1] !== "=") angleDepth--;
      else if (ch === "{" && angleDepth === 0) {
        braceOpen = i;
        break;
      }
    }
    if (braceOpen === -1) continue;

    const braceClose = findMatchingDelimiter(masked, braceOpen, "{", "}");
    if (braceClose === -1) continue;

    const properties = parseClassProperties(
      source,
      masked,
      braceOpen + 1,
      braceClose,
      jsDocs,
      symbols,
      options,
      classHasExclude,
    );

    if (properties.length > 0) {
      classes.push({ name: className, properties });
    }
  }

  if (classes.length === 0) {
    return { code: source, modified: false, classes: [] };
  }

  const registrationBlocks: string[] = [];

  for (const cls of classes) {
    const swaggerProps = emitSwagger
      ? cls.properties.filter((p) => !p.hideSwagger)
      : [];
    const graphqlProps = emitGraphql
      ? cls.properties.filter((p) => !p.hideGraphql)
      : [];

    if (swaggerProps.length === 0 && graphqlProps.length === 0) {
      continue;
    }

    const lines: string[] = [];
    if (swaggerProps.length > 0) {
      const items = swaggerProps
        .map((p) => buildSwaggerEntryCode(p, dtoKeyOfComment))
        .join(", ");
      lines.push(
        `  __register(${cls.name}, Symbol.for(${JSON.stringify(SWAGGER_API_PROPERTIES_SYMBOL)}), [${items}]);`,
      );
    }
    if (graphqlProps.length > 0) {
      const items = graphqlProps.map(buildGraphqlEntryCode).join(", ");
      lines.push(
        `  __register(${cls.name}, Symbol.for(${JSON.stringify(GRAPHQL_FIELDS_SYMBOL)}), [${items}]);`,
      );
    }

    registrationBlocks.push(lines.join("\n"));
  }

  if (registrationBlocks.length === 0) {
    return { code: source, modified: false, classes };
  }

  if (options.debug) {
    console.debug(
      `[bunest-metadata-plugin] Transformed DTO file ${filename}: ${classes.map((c) => c.name).join(", ")}`,
    );
  }

  const trailer = `
;(function __bunestRegisterDtoMetadata() {
  if (typeof Reflect === "undefined" || typeof Reflect.defineMetadata !== "function") {
    return;
  }
  const __register = (target: Function, key: symbol, inferred: ReadonlyArray<{ propertyKey: string; [k: string]: unknown }>) => {
    const existing = (Reflect.getOwnMetadata(key, target) as ReadonlyArray<{ propertyKey: string; [k: string]: unknown }> | undefined) ?? [];
    const merged = new Map<string, { propertyKey: string; [k: string]: unknown }>();
    for (const entry of inferred) {
      merged.set(entry.propertyKey, entry);
    }
    for (const entry of existing) {
      const base = merged.get(entry.propertyKey);
      if (!base) {
        merged.set(entry.propertyKey, entry);
        continue;
      }
      const next: { propertyKey: string; [k: string]: unknown } = { ...base };
      for (const [k, v] of Object.entries(entry)) {
        if (v !== undefined) {
          next[k] = v;
        }
      }
      merged.set(entry.propertyKey, next);
    }
    Reflect.defineMetadata(key, [...merged.values()], target);
  };
${registrationBlocks.join("\n")}
})();
`;

  return {
    code: `${source}${trailer}`,
    modified: true,
    classes,
  };
}

const HTTP_METHOD_DECORATORS = new Map<
  string,
  { method: string; defaultStatus: number }
>([
  ["Get", { method: "GET", defaultStatus: 200 }],
  ["Post", { method: "POST", defaultStatus: 201 }],
  ["Put", { method: "PUT", defaultStatus: 200 }],
  ["Patch", { method: "PATCH", defaultStatus: 200 }],
  ["Delete", { method: "DELETE", defaultStatus: 200 }],
  ["Options", { method: "OPTIONS", defaultStatus: 200 }],
  ["Head", { method: "HEAD", defaultStatus: 200 }],
  ["All", { method: "ALL", defaultStatus: 200 }],
]);

function parseControllerMethods(
  source: string,
  masked: string,
  bodyStart: number,
  bodyEnd: number,
  jsDocs: readonly { start: number; end: number; text: string }[],
  symbols: FileSymbolTable,
  options: BunestMetadataPluginOptions,
): ExtractedControllerMethod[] {
  const introspectComments = options.introspectComments !== false;
  const skipAutoHttpCode = options.skipAutoHttpCode === true;
  const methods: ExtractedControllerMethod[] = [];
  let cursor = bodyStart;
  let prevMemberEnd = bodyStart;

  const findPrecedingJsDoc = (
    memberStart: number,
    prevEnd: number,
  ): string | undefined => {
    if (!introspectComments) return undefined;
    for (let j = jsDocs.length - 1; j >= 0; j--) {
      const doc = jsDocs[j]!;
      if (doc.end <= memberStart && doc.start >= prevEnd) {
        return doc.text.length > 0 ? doc.text : undefined;
      }
    }
    return undefined;
  };

  while (cursor < bodyEnd) {
    while (
      cursor < bodyEnd &&
      (masked[cursor] === " " ||
        masked[cursor] === "\t" ||
        masked[cursor] === "\r" ||
        masked[cursor] === "\n" ||
        masked[cursor] === ";")
    ) {
      cursor++;
    }
    if (cursor >= bodyEnd) break;

    const memberStart = cursor;
    const decorators: ParsedDecorator[] = [];

    while (cursor < bodyEnd && masked[cursor] === "@") {
      const decStart = cursor + 1;
      cursor++;
      while (cursor < bodyEnd && /[A-Za-z0-9_$.]/.test(masked[cursor]!)) {
        cursor++;
      }
      const decName = source.slice(decStart, cursor).trim();
      const shortName = decName.includes(".")
        ? decName.split(".").pop()!
        : decName;
      while (cursor < bodyEnd && /\s/.test(masked[cursor]!)) {
        cursor++;
      }
      let rawArgs = "";
      if (masked[cursor] === "(") {
        const closeParen = findMatchingDelimiter(masked, cursor, "(", ")");
        if (closeParen === -1 || closeParen >= bodyEnd) {
          cursor = bodyEnd;
          break;
        }
        rawArgs = source.slice(cursor + 1, closeParen).trim();
        cursor = closeParen + 1;
      }
      if (decName) {
        decorators.push({ name: decName, shortName, rawArgs });
      }
      while (cursor < bodyEnd && /\s/.test(masked[cursor]!)) {
        cursor++;
      }
    }

    if (cursor >= bodyEnd) break;
    const declStart = cursor;

    let openParen = -1;
    let closeParen = -1;
    let bodyBraceOpen = -1;
    let bodyBraceClose = -1;

    while (cursor < bodyEnd) {
      const ch = masked[cursor]!;
      if (ch === "(" && openParen === -1) {
        openParen = cursor;
        closeParen = findMatchingDelimiter(masked, cursor, "(", ")");
        if (closeParen === -1 || closeParen >= bodyEnd) {
          cursor = bodyEnd;
          break;
        }
        cursor = closeParen + 1;
        continue;
      }
      if (ch === "{") {
        bodyBraceOpen = cursor;
        bodyBraceClose = findMatchingDelimiter(masked, cursor, "{", "}");
        cursor = bodyBraceClose === -1 ? bodyEnd : bodyBraceClose + 1;
        break;
      }
      if (ch === ";") {
        cursor++;
        break;
      }
      cursor++;
    }

    const memberEnd = cursor;
    const jsDoc = findPrecedingJsDoc(memberStart, prevMemberEnd);
    prevMemberEnd = memberEnd;

    if (openParen === -1 || closeParen === -1 || bodyBraceOpen === -1) {
      continue;
    }

    const httpDec = decorators.find((d) =>
      HTTP_METHOD_DECORATORS.has(d.shortName),
    );
    if (!httpDec) {
      continue;
    }

    const headRaw = source
      .slice(declStart, openParen)
      .replace(
        /^(?:(?:public|protected|private|static|async|override)\s+)+/,
        "",
      )
      .trim();
    const methodMatch = headRaw.match(/^([A-Za-z_$][\w$]*)$/);
    if (!methodMatch) continue;
    const methodName = methodMatch[1]!;

    const httpInfo = HTTP_METHOD_DECORATORS.get(httpDec.shortName)!;
    const httpCodeDec = decorators.find((d) => d.shortName === "HttpCode");
    let status: number | undefined;
    if (httpCodeDec && /^\d+$/.test(httpCodeDec.rawArgs)) {
      status = Number(httpCodeDec.rawArgs);
    } else if (!skipAutoHttpCode) {
      status = httpInfo.defaultStatus;
    }

    const afterParen = source.slice(closeParen + 1, bodyBraceOpen).trim();
    let returnTypeExpr: string | undefined;
    let isArray = false;
    if (afterParen.startsWith(":")) {
      const rawRet = afterParen.slice(1).trim();
      const analyzed = analyzeTypeExpression(rawRet, symbols);
      returnTypeExpr = analyzed.typeExpr;
      isArray = analyzed.isArray;
    }

    methods.push({
      name: methodName,
      httpMethod: httpInfo.method,
      status,
      summary: jsDoc,
      returnTypeExpr,
      isArray,
    });
  }

  return methods;
}

/**
 * Pure source-to-source TypeScript transformer scanning exported controller
 * classes to auto-register OpenAPI operation summaries (from JSDoc), return
 * types, and default HTTP status responses without overwriting explicit decorators.
 */
export function transformControllerMetadataSource(
  source: string,
  filename = "controller.ts",
  options: BunestMetadataPluginOptions = {},
): TransformControllerMetadataResult {
  if (options.swagger === false) {
    return { code: source, modified: false, controllers: [] };
  }

  const controllerKeyOfComment = options.controllerKeyOfComment ?? "summary";
  const { masked, jsDocs } = maskCommentsAndStrings(source);
  const symbols = collectFileSymbols(source, masked);
  const controllers: ExtractedControllerClass[] = [];

  const classRegex =
    /(?:^|;|\n)\s*export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)\b/g;

  for (const match of masked.matchAll(classRegex)) {
    const className = match[1]!;
    const classStartIdx = match.index ?? 0;
    const afterNameIdx = classStartIdx + match[0].length;
    if (/\bdeclare\b/.test(masked.slice(classStartIdx, afterNameIdx))) {
      continue;
    }

    let braceOpen = -1;
    let angleDepth = 0;
    for (let i = afterNameIdx; i < masked.length; i++) {
      const ch = masked[i];
      if (ch === "<") angleDepth++;
      else if (ch === ">" && masked[i - 1] !== "=") angleDepth--;
      else if (ch === "{" && angleDepth === 0) {
        braceOpen = i;
        break;
      }
    }
    if (braceOpen === -1) continue;
    const braceClose = findMatchingDelimiter(masked, braceOpen, "{", "}");
    if (braceClose === -1) continue;

    const methods = parseControllerMethods(
      source,
      masked,
      braceOpen + 1,
      braceClose,
      jsDocs,
      symbols,
      options,
    );

    if (methods.length > 0) {
      controllers.push({ name: className, methods });
    }
  }

  if (controllers.length === 0) {
    return { code: source, modified: false, controllers: [] };
  }

  const regLines: string[] = [];
  for (const ctrl of controllers) {
    for (const m of ctrl.methods) {
      if (m.summary) {
        regLines.push(
          `  __regOp(${ctrl.name}.prototype.${m.name}, { ${JSON.stringify(controllerKeyOfComment)}: ${JSON.stringify(m.summary)} });`,
        );
      }
      if (m.returnTypeExpr || m.status !== undefined) {
        const respFields: string[] = [];
        if (m.status !== undefined) respFields.push(`status: ${m.status}`);
        if (m.returnTypeExpr !== undefined) {
          respFields.push(`type: ${m.returnTypeExpr}`);
        }
        if (m.isArray) respFields.push(`isArray: true`);
        regLines.push(
          `  __regResp(${ctrl.name}.prototype.${m.name}, { ${respFields.join(", ")} });`,
        );
      }
    }
  }

  if (regLines.length === 0) {
    return { code: source, modified: false, controllers };
  }

  if (options.debug) {
    console.debug(
      `[bunest-metadata-plugin] Transformed controller file ${filename}: ${controllers.map((c) => c.name).join(", ")}`,
    );
  }

  const trailer = `
;(function __bunestRegisterControllerMetadata() {
  if (typeof Reflect === "undefined" || typeof Reflect.defineMetadata !== "function") {
    return;
  }
  const __opKey = Symbol.for(${JSON.stringify(SWAGGER_API_OPERATION_SYMBOL)});
  const __respKey = Symbol.for(${JSON.stringify(SWAGGER_API_RESPONSES_SYMBOL)});
  const __regOp = (fn: unknown, inferred: Record<string, unknown>) => {
    if (typeof fn !== "function") return;
    const existing = (Reflect.getOwnMetadata(__opKey, fn) as Record<string, unknown> | undefined) ?? {};
    Reflect.defineMetadata(__opKey, { ...inferred, ...existing }, fn);
  };
  const __regResp = (fn: unknown, inferred: { status?: number; [k: string]: unknown }) => {
    if (typeof fn !== "function") return;
    const existing = (Reflect.getOwnMetadata(__respKey, fn) as ReadonlyArray<{ status?: number | string }> | undefined) ?? [];
    if (existing.length > 0 && inferred.status !== undefined && existing.some((e) => String(e.status) === String(inferred.status))) {
      return;
    }
    Reflect.defineMetadata(__respKey, [...existing, inferred], fn);
  };
${regLines.join("\n")}
})();
`;

  return {
    code: `${source}${trailer}`,
    modified: true,
    controllers,
  };
}

async function walkSourceFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await readDirEntries(dir);
  for (const entry of entries) {
    if (
      entry.name === "node_modules" ||
      entry.name === "dist" ||
      entry.name === ".git"
    ) {
      continue;
    }
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await walkSourceFiles(fullPath)));
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".d.ts") &&
      !entry.name.endsWith(".spec.ts") &&
      !entry.name.endsWith(".test.ts")
    ) {
      results.push(fullPath);
    }
  }
  return results;
}

function toImportSpecifier(
  fromDir: string,
  filePath: string,
  esmCompatible: boolean,
): string {
  let rel = relative(fromDir, filePath).replace(/\\/g, "/");
  if (!rel.startsWith(".")) {
    rel = `./${rel}`;
  }
  rel = rel.replace(/\.tsx?$/i, "");
  return esmCompatible ? `${rel}.js` : rel;
}

async function detectTsconfigEsmCompatible(rootDir: string): Promise<boolean> {
  const tsconfigPath = join(rootDir, "tsconfig.json");
  try {
    const file = Bun.file(tsconfigPath);
    if (!(await file.exists())) return false;
    const raw = await file.text();
    const stripped = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/,\s*([}\]])/g, "$1");
    const parsed = JSON.parse(stripped) as {
      compilerOptions?: { moduleResolution?: string };
    };
    const mr = parsed.compilerOptions?.moduleResolution?.toLowerCase();
    return mr === "nodenext" || mr === "node16";
  } catch {
    return false;
  }
}

/**
 * Build-time static metadata generator emitting a `metadata.ts` file directly
 * loadable by `SwaggerModule.loadPluginMetadata(metadata)` (compatible with
 * `bun build --compile` and zero-runtime-hook deployments).
 */
export async function generateMetadataFile(
  options: BunestMetadataPluginOptions = {},
): Promise<GenerateMetadataFileResult> {
  const rootDir = resolve(options.rootDir ?? process.cwd());
  const sourceDir = resolve(rootDir, options.pathToSource ?? "src");
  const outDir = resolve(rootDir, options.outDir ?? sourceDir);
  const outputPath = join(outDir, options.filename ?? "metadata.ts");
  const esmCompatible =
    options.esmCompatible !== undefined
      ? options.esmCompatible === true
      : await detectTsconfigEsmCompatible(rootDir);
  const dtoSuffixes = normalizeSuffixes(
    options.dtoFileNameSuffix,
    DEFAULT_DTO_SUFFIXES,
  );
  const ctrlSuffixes = normalizeSuffixes(
    options.controllerFileNameSuffix,
    DEFAULT_CONTROLLER_SUFFIXES,
  );
  const dtoFilter = buildSuffixFilter(dtoSuffixes);
  const ctrlFilter = buildSuffixFilter(ctrlSuffixes);
  const dtoKeyOfComment = options.dtoKeyOfComment ?? "description";
  const controllerKeyOfComment = options.controllerKeyOfComment ?? "summary";

  const files = (await walkSourceFiles(sourceDir)).sort();
  const modelEntries: string[] = [];
  const controllerEntries: string[] = [];
  let modelsCount = 0;
  let controllersCount = 0;

  for (const filePath of files) {
    const source = await Bun.file(filePath).text();
    const importSpec = toImportSpecifier(
      dirname(outputPath),
      filePath,
      esmCompatible,
    );

    if (dtoFilter.test(filePath)) {
      const dtoRes = transformDtoMetadataSource(source, filePath, options);
      if (dtoRes.classes.length > 0) {
        const classPropsParts: string[] = [];
        for (const cls of dtoRes.classes) {
          modelsCount++;
          const propParts: string[] = [];
          for (const prop of cls.properties) {
            if (prop.hideSwagger) continue;
            const fields: string[] = [];
            fields.push(`required: ${prop.required ? "true" : "false"}`);
            if (prop.nullable) fields.push(`nullable: true`);
            if (prop.isArray) fields.push(`isArray: true`);
            if (prop.isReadonly) fields.push(`readOnly: true`);
            if (prop.typeExpr && !prop.typeExpr.startsWith("() => ")) {
              fields.push(`type: () => ${prop.typeExpr}`);
            } else if (prop.typeExpr?.startsWith("() => ")) {
              // Reference imported class via string name fallback if not primitive
              fields.push(`type: () => Object`);
            }
            if (prop.enumLiterals) {
              fields.push(`enum: ${JSON.stringify(prop.enumLiterals)}`);
            }
            if (prop.enumName) {
              fields.push(`enumName: ${JSON.stringify(prop.enumName)}`);
            }
            if (prop.hasDefaultValue) {
              fields.push(`default: ${JSON.stringify(prop.defaultValue)}`);
            }
            if (prop.description) {
              fields.push(
                `${JSON.stringify(dtoKeyOfComment)}: ${JSON.stringify(prop.description)}`,
              );
            }
            if (prop.constraints) {
              const c = prop.constraints;
              if (c.format) fields.push(`format: ${JSON.stringify(c.format)}`);
              if (c.minimum !== undefined) fields.push(`minimum: ${c.minimum}`);
              if (c.maximum !== undefined) fields.push(`maximum: ${c.maximum}`);
              if (c.minLength !== undefined)
                fields.push(`minLength: ${c.minLength}`);
              if (c.maxLength !== undefined)
                fields.push(`maxLength: ${c.maxLength}`);
              if (c.pattern)
                fields.push(`pattern: ${JSON.stringify(c.pattern)}`);
            }
            propParts.push(
              `          ${JSON.stringify(prop.name)}: { ${fields.join(", ")} }`,
            );
          }
          classPropsParts.push(
            `        ${JSON.stringify(cls.name)}: {\n${propParts.join(",\n")}\n        }`,
          );
        }
        modelEntries.push(
          `      [import(${JSON.stringify(importSpec)}), {\n${classPropsParts.join(",\n")}\n      }]`,
        );
      }
    }

    if (ctrlFilter.test(filePath)) {
      const ctrlRes = transformControllerMetadataSource(
        source,
        filePath,
        options,
      );
      if (ctrlRes.controllers.length > 0) {
        const ctrlParts: string[] = [];
        for (const ctrl of ctrlRes.controllers) {
          controllersCount++;
          const methodParts: string[] = [];
          for (const m of ctrl.methods) {
            const fields: string[] = [];
            if (m.status !== undefined) fields.push(`status: ${m.status}`);
            if (m.summary) {
              fields.push(
                `${JSON.stringify(controllerKeyOfComment)}: ${JSON.stringify(m.summary)}`,
              );
            }
            if (m.isArray) fields.push(`isArray: true`);
            if (m.returnTypeExpr && !m.returnTypeExpr.startsWith("() => ")) {
              fields.push(`type: ${m.returnTypeExpr}`);
            }
            methodParts.push(
              `          ${JSON.stringify(m.name)}: { ${fields.join(", ")} }`,
            );
          }
          ctrlParts.push(
            `        ${JSON.stringify(ctrl.name)}: {\n${methodParts.join(",\n")}\n        }`,
          );
        }
        controllerEntries.push(
          `      [import(${JSON.stringify(importSpec)}), {\n${ctrlParts.join(",\n")}\n      }]`,
        );
      }
    }
  }

  const code = `/* eslint-disable */
// Auto-generated by @bunest/cli generateMetadataFile()
export default async () => {
  return {
    "@nestjs/swagger": {
      models: [
${modelEntries.join(",\n")}
      ],
      controllers: [
${controllerEntries.join(",\n")}
      ],
    },
  };
};
`;

  await ensureDir(dirname(outputPath));
  const existingFile = Bun.file(outputPath);
  const shouldWrite =
    !(await existingFile.exists()) || (await existingFile.text()) !== code;
  if (shouldWrite) {
    await Bun.write(outputPath, code);
  }

  return {
    outputPath,
    code,
    modelsCount,
    controllersCount,
  };
}

/**
 * Bun build & runtime plugin automatically registering Swagger (`@ApiProperty`,
 * `@ApiOperation`, `@ApiResponse`) and optional GraphQL (`@Field`) metadata for
 * exported TypeScript DTO, entity, model, and controller classes.
 */
export function bunestMetadataPlugin(
  options: BunestMetadataPluginOptions = {},
): BunPlugin {
  const dtoSuffixes = normalizeSuffixes(
    options.dtoFileNameSuffix,
    DEFAULT_DTO_SUFFIXES,
  );
  const ctrlSuffixes = normalizeSuffixes(
    options.controllerFileNameSuffix,
    DEFAULT_CONTROLLER_SUFFIXES,
  );
  const dtoFilter = buildSuffixFilter(dtoSuffixes);
  const ctrlFilter = buildSuffixFilter(ctrlSuffixes);
  const combinedFilter = buildSuffixFilter([...dtoSuffixes, ...ctrlSuffixes]);

  return {
    name: "bunest-metadata-plugin",
    setup(build) {
      build.onLoad({ filter: combinedFilter }, async (args) => {
        let code = await Bun.file(args.path).text();
        if (dtoFilter.test(args.path)) {
          code = transformDtoMetadataSource(code, args.path, options).code;
        }
        if (ctrlFilter.test(args.path)) {
          code = transformControllerMetadataSource(
            code,
            args.path,
            options,
          ).code;
        }
        return {
          contents: code,
          loader: args.path.endsWith(".tsx") ? "tsx" : "ts",
        };
      });
    },
  };
}
