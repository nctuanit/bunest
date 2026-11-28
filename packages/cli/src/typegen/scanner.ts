import { toArray } from "@bunest/core/common";
import {
  dirname,
  existsSyncPath,
  extname,
  join,
  readDirSyncNames,
  readTextSync,
  relative,
  resolve,
  statSyncPath,
} from "@bunest/core";
import {
  Node,
  Project,
  SyntaxKind,
  TypeFormatFlags,
  type CallExpression,
  type ClassDeclaration,
  type Decorator,
  type Expression,
  type MethodDeclaration,
  type ParameterDeclaration,
  type SourceFile,
  type Type as TsType,
} from "../ast";
import {
  collectCustomMacros,
  getGlobalMacroDefaultsSnapshot,
  type BunestConfigLike,
  type CustomMacroDefinitionLike,
  type CustomMacroPluginInput,
  type GlobalMacroDefaultsLike,
} from "../config/bunest-config.loader";
import {
  BUILTIN_CLASS_MACRO_NAMES,
  BUILTIN_FIELD_MACRO_NAMES,
  BUILTIN_REPOSITORY_DECORATOR_NAMES,
  parseBaseEntityDecoratorAst,
  resolveComposedDecorators,
  type ResolvedDecoratorEntry,
} from "../decorators";
import { sanitizeTypeText } from "./emitter";
import {
  selectActiveTypegenPlugins,
  type BunestTypegenPlugin,
  type TypegenPluginEmitContext,
  type TypegenPluginScanContext,
} from "./plugins";
import {
  ALL_TYPEGEN_TARGETS,
  type ExtractedBaseEntityField,
  type ExtractedCallSite,
  type ExtractedClassMacroEntry,
  type ExtractedConfigNamespaceEntry,
  type ExtractedConnectionEntry,
  type ExtractedCqrsCommandEntry,
  type ExtractedCqrsQueryEntry,
  type ExtractedCustomMacroMember,
  type ExtractedCustomMacroRef,
  type ExtractedDelegateInfo,
  type ExtractedEnvKeyEntry,
  type ExtractedEventEntry,
  type ExtractedEventPatternEntry,
  type ExtractedImportRef,
  type ExtractedInjectableLoggerEntry,
  type ExtractedMacroAccessors,
  type ExtractedMacroField,
  type ExtractedMacroFieldRef,
  type ExtractedMessagePatternEntry,
  type ExtractedModelEntry,
  type ExtractedPluginScanResult,
  type ExtractedRouteEntry,
  type ExtractedTokenEntry,
  type SourceLocation,
  type TypegenIncludeTarget,
  type TypegenScanResult,
  type TypegenTarget,
} from "./types";

const CLASS_MACRO_DECORATORS = BUILTIN_CLASS_MACRO_NAMES;
const FIELD_MACRO_DECORATORS = BUILTIN_FIELD_MACRO_NAMES;
const REPOSITORY_CLASS_DECORATORS = BUILTIN_REPOSITORY_DECORATOR_NAMES;

/**
 * Converts a Bunest native TypeScript AST node to a 1-based line/column + 0-based byte/char offset location.
 */
export function nodeToLocation(node: Node): SourceLocation {
  const sf = node.getSourceFile();
  const start = node.getStart();
  const end = node.getEnd();
  const startPos = sf.getLineAndColumnAtPos(start);
  const endPos = sf.getLineAndColumnAtPos(end);
  return {
    filePath: sf.getFilePath(),
    line: startPos.line,
    column: startPos.column,
    endLine: endPos.line,
    endColumn: endPos.column,
    start,
    end,
  };
}

const IGNORED_DIRS = new Set([
  "node_modules",
  "dist",
  ".git",
  ".bunest",
  "coverage",
  ".cache",
  ".turbo",
]);

const DEFAULT_ENV_FILES = [
  ".env.example",
  ".env",
  ".env.development",
  ".env.local",
] as const;

const HTTP_METHOD_DECORATORS: Readonly<Record<string, string>> = {
  Get: "GET",
  Post: "POST",
  Put: "PUT",
  Patch: "PATCH",
  Delete: "DELETE",
  Options: "OPTIONS",
  Head: "HEAD",
  All: "ALL",
  Search: "SEARCH",
  Propfind: "PROPFIND",
  Proppatch: "PROPPATCH",
  Mkcol: "MKCOL",
  Copy: "COPY",
  Move: "MOVE",
  Lock: "LOCK",
  Unlock: "UNLOCK",
  QueryMethod: "QUERY",
  Sse: "GET",
};

const REQUEST_METHOD_ENUM_MAP: Readonly<Record<string, string>> = {
  "0": "GET",
  "1": "POST",
  "2": "PUT",
  "3": "DELETE",
  "4": "PATCH",
  "5": "ALL",
  "6": "OPTIONS",
  "7": "HEAD",
  "8": "SEARCH",
  GET: "GET",
  POST: "POST",
  PUT: "PUT",
  DELETE: "DELETE",
  PATCH: "PATCH",
  ALL: "ALL",
  OPTIONS: "OPTIONS",
  HEAD: "HEAD",
  SEARCH: "SEARCH",
};

function isSourceTsFile(filePath: string): boolean {
  if (!filePath.endsWith(".ts") && !filePath.endsWith(".tsx")) return false;
  if (filePath.endsWith(".d.ts")) return false;
  if (/\.(?:spec|test)\.tsx?$/i.test(filePath)) return false;
  return true;
}

function walkTsSourceFiles(dir: string): string[] {
  if (!existsSyncPath(dir)) return [];
  const results: string[] = [];
  let entries: string[];
  try {
    entries = readDirSyncNames(dir);
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSyncPath(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      results.push(...walkTsSourceFiles(full));
    } else if (stat.isFile() && isSourceTsFile(full)) {
      results.push(full);
    }
  }
  return results.sort();
}

function getDecoratorShortName(dec: Decorator): string {
  const name = dec.getName();
  const dotIdx = name.lastIndexOf(".");
  return dotIdx !== -1 ? name.slice(dotIdx + 1) : name;
}

function unwrapParensAndAs(
  expr: Expression | undefined,
): Expression | undefined {
  let current = expr;
  while (current) {
    if (Node.isParenthesizedExpression(current)) {
      current = current.getExpression();
    } else if (Node.isAsExpression(current)) {
      current = current.getExpression();
    } else if (Node.isSatisfiesExpression(current)) {
      current = current.getExpression();
    } else {
      break;
    }
  }
  return current;
}

function extractStringLiteral(
  expr: Expression | undefined,
): string | undefined {
  const unwrapped = unwrapParensAndAs(expr);
  if (!unwrapped) return undefined;
  if (
    Node.isStringLiteral(unwrapped) ||
    Node.isNoSubstitutionTemplateLiteral(unwrapped)
  ) {
    return unwrapped.getLiteralValue();
  }
  return undefined;
}

function extractStringOrArrayLiterals(expr: Expression | undefined): string[] {
  const unwrapped = unwrapParensAndAs(expr);
  if (!unwrapped) return [];
  const single = extractStringLiteral(unwrapped);
  if (single !== undefined) return [single];
  if (Node.isArrayLiteralExpression(unwrapped)) {
    const out: string[] = [];
    for (const el of unwrapped.getElements()) {
      if (Node.isExpression(el)) {
        const s = extractStringLiteral(el);
        if (s !== undefined) out.push(s);
      }
    }
    return out;
  }
  return [];
}

function extractStaticJsonValue(
  expr: Expression | undefined,
): { ok: true; value: unknown } | { ok: false } {
  const unwrapped = unwrapParensAndAs(expr);
  if (!unwrapped) return { ok: false };
  if (
    Node.isStringLiteral(unwrapped) ||
    Node.isNoSubstitutionTemplateLiteral(unwrapped)
  ) {
    return { ok: true, value: unwrapped.getLiteralValue() };
  }
  if (Node.isNumericLiteral(unwrapped)) {
    return { ok: true, value: unwrapped.getLiteralValue() };
  }
  if (unwrapped.getKind() === SyntaxKind.TrueKeyword) {
    return { ok: true, value: true };
  }
  if (unwrapped.getKind() === SyntaxKind.FalseKeyword) {
    return { ok: true, value: false };
  }
  if (unwrapped.getKind() === SyntaxKind.NullKeyword) {
    return { ok: true, value: null };
  }
  if (Node.isArrayLiteralExpression(unwrapped)) {
    const arr: unknown[] = [];
    for (const el of unwrapped.getElements()) {
      if (!Node.isExpression(el)) return { ok: false };
      const parsed = extractStaticJsonValue(el);
      if (!parsed.ok) return { ok: false };
      arr.push(parsed.value);
    }
    return { ok: true, value: arr };
  }
  if (Node.isObjectLiteralExpression(unwrapped)) {
    const obj: Record<string, unknown> = {};
    for (const prop of unwrapped.getProperties()) {
      if (!Node.isPropertyAssignment(prop)) return { ok: false };
      const rawName = prop.getName();
      const cleanName =
        (rawName.startsWith('"') && rawName.endsWith('"')) ||
        (rawName.startsWith("'") && rawName.endsWith("'"))
          ? rawName.slice(1, -1)
          : rawName;
      const parsed = extractStaticJsonValue(prop.getInitializer());
      if (!parsed.ok) return { ok: false };
      obj[cleanName] = parsed.value;
    }
    return { ok: true, value: obj };
  }
  return { ok: false };
}

function canonicalizeObject(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalizeObject);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = canonicalizeObject((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

function extractPatternKeys(expr: Expression | undefined): string[] {
  const unwrapped = unwrapParensAndAs(expr);
  if (!unwrapped) return [];
  const str = extractStringLiteral(unwrapped);
  if (str !== undefined) return [str];
  if (Node.isNumericLiteral(unwrapped)) {
    return [String(unwrapped.getLiteralValue())];
  }
  if (Node.isArrayLiteralExpression(unwrapped)) {
    const out: string[] = [];
    for (const el of unwrapped.getElements()) {
      if (Node.isExpression(el)) {
        out.push(...extractPatternKeys(el));
      }
    }
    return out;
  }
  if (Node.isObjectLiteralExpression(unwrapped)) {
    const parsed = extractStaticJsonValue(unwrapped);
    if (parsed.ok) {
      return [JSON.stringify(canonicalizeObject(parsed.value))];
    }
  }
  return [];
}

function joinRoutePath(prefix: string, routePath: string): string {
  const parts = [prefix, routePath]
    .map((p) => p.trim().replace(/^\/+|\/+$/g, ""))
    .filter((p) => p.length > 0);
  return parts.length === 0 ? "/" : `/${parts.join("/")}`;
}

function extractPathParamNames(routePath: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const m of routePath.matchAll(/:([A-Za-z0-9_]+)/g)) {
    const name = m[1]!;
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

function getPropertyInitializer(
  obj: Expression | undefined,
  propName: string,
): Expression | undefined {
  const unwrapped = unwrapParensAndAs(obj);
  if (!unwrapped || !Node.isObjectLiteralExpression(unwrapped))
    return undefined;
  const prop = unwrapped.getProperty(propName);
  if (prop && Node.isPropertyAssignment(prop)) {
    return prop.getInitializer();
  }
  if (prop && Node.isShorthandPropertyAssignment(prop)) {
    return prop.getNameNode();
  }
  return undefined;
}

function parseEnvKeysFromContent(
  content: string,
): Array<{ key: string; line: number; endColumn: number }> {
  const keys: Array<{ key: string; line: number; endColumn: number }> = [];
  const seen = new Set<string>();
  const rawLines = content.split(/\r?\n/);
  for (let i = 0; i < rawLines.length; i++) {
    const rawLine = rawLines[i]!;
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const cleaned = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eqIdx = cleaned.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = cleaned.slice(0, eqIdx).trim();
    if (/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key) && !seen.has(key)) {
      seen.add(key);
      keys.push({ key, line: i + 1, endColumn: rawLine.length + 1 });
    }
  }
  return keys;
}

function parseEnvKeysFromFile(
  filePath: string,
  overrideContent?: string,
): Array<{ key: string; line: number; endColumn: number }> {
  if (overrideContent !== undefined) {
    return parseEnvKeysFromContent(overrideContent);
  }
  if (!existsSyncPath(filePath)) return [];
  let content: string;
  try {
    content = readTextSync(filePath);
  } catch {
    return [];
  }
  return parseEnvKeysFromContent(content);
}

/**
 * Checks whether a declaration in a user source file is exported so it can be
 * safely referenced via `import type { ... }` in generated `.d.ts` files.
 */
function isDeclarationExported(decl: Node): boolean {
  if (
    Node.isClassDeclaration(decl) ||
    Node.isInterfaceDeclaration(decl) ||
    Node.isTypeAliasDeclaration(decl) ||
    Node.isEnumDeclaration(decl) ||
    Node.isFunctionDeclaration(decl)
  ) {
    return decl.isExported();
  }
  if (Node.isVariableDeclaration(decl)) {
    const stmt = decl.getVariableStatement();
    return stmt ? stmt.isExported() : false;
  }
  return false;
}

function isUserProjectFile(filePath: string, projectRoot: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  if (normalized.includes("/node_modules/")) return false;
  const rel = relative(projectRoot, filePath).replace(/\\/g, "/");
  return !rel.startsWith("..");
}

function unwrapPromiseType(type: TsType): TsType {
  const sym = type.getSymbol();
  const symName = sym?.getName();
  if (symName === "Promise" || symName === "PromiseLike") {
    const args = type.getTypeArguments();
    if (args.length > 0 && args[0]) {
      return unwrapPromiseType(args[0]);
    }
  }
  return type;
}

/**
 * Converts a Bunest AST `Type` into a portable TypeScript type string plus
 * all required `import type` references, rewriting `import("/abs/path").Foo`
 * into clean local alias placeholders.
 */
class TypePrinter {
  private readonly aliasByTarget = new Map<string, string>();
  private readonly usedAliases = new Set<string>();
  private readonly projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
  }

  private allocateAlias(filePath: string, exportName: string): string {
    const key = `${filePath}\0${exportName}`;
    const existing = this.aliasByTarget.get(key);
    if (existing) return existing;

    let candidate = exportName;
    if (this.usedAliases.has(candidate)) {
      let i = 2;
      while (this.usedAliases.has(`${exportName}_${i}`)) {
        i += 1;
      }
      candidate = `${exportName}_${i}`;
    }
    this.aliasByTarget.set(key, candidate);
    this.usedAliases.add(candidate);
    return candidate;
  }

  private resolveTargetFilePath(rawModulePath: string): string {
    const ext = extname(rawModulePath);
    if (ext === ".ts" || ext === ".tsx" || ext === ".mts" || ext === ".cts") {
      return rawModulePath;
    }
    for (const candidate of [
      `${rawModulePath}.ts`,
      `${rawModulePath}.tsx`,
      join(rawModulePath, "index.ts"),
    ]) {
      if (existsSyncPath(candidate)) {
        return candidate;
      }
    }
    return rawModulePath;
  }

  printNamedExport(
    filePath: string,
    exportName: string,
  ): { text: string; imports: ExtractedImportRef[] } {
    const alias = this.allocateAlias(filePath, exportName);
    return {
      text: alias,
      imports: [
        {
          filePath,
          exportName,
          alias: alias !== exportName ? alias : undefined,
          isTypeOnly: true,
        },
      ],
    };
  }

  printType(
    tsType: TsType,
    project: Project,
    fallback = "unknown",
  ): { text: string; imports: ExtractedImportRef[] } {
    const text = tsType.getText(
      undefined,
      TypeFormatFlags.NoTruncation |
        TypeFormatFlags.UseAliasDefinedOutsideCurrentScope,
    );

    if (!text || text === "any") {
      return { text: fallback, imports: [] };
    }

    const imports: ExtractedImportRef[] = [];
    const seenKeys = new Set<string>();
    let hasUnexportedLocalRef = false;

    const importPattern = /import\((["'])([^"']+)\1\)\.([A-Za-z_$][\w$]*)/g;

    const rewritten = text.replace(
      importPattern,
      (_match, _quote: string, rawPath: string, symbolName: string) => {
        // Keep package imports (non-absolute paths) as-is or rewrite user files
        if (!rawPath.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(rawPath)) {
          return _match;
        }
        const resolvedFile = this.resolveTargetFilePath(rawPath);

        if (!isUserProjectFile(resolvedFile, this.projectRoot)) {
          // Node_modules type (e.g., ObjectId from @bunest/mongoose or external lib)
          const pkgMatch = resolvedFile
            .replace(/\\/g, "/")
            .match(/\/node_modules\/((?:@[^/]+\/)?[^/]+)/);
          if (pkgMatch?.[1]) {
            const pkgName = pkgMatch[1];
            const alias = this.allocateAlias(pkgName, symbolName);
            const dedupKey = `${pkgName}\0${symbolName}`;
            if (!seenKeys.has(dedupKey)) {
              seenKeys.add(dedupKey);
              imports.push({
                filePath: pkgName,
                exportName: symbolName,
                alias: alias !== symbolName ? alias : undefined,
                isTypeOnly: true,
              });
            }
            return alias;
          }
          return symbolName;
        }

        // Check whether symbolName is actually exported from resolvedFile
        const sf = project.getSourceFile(resolvedFile);
        if (sf) {
          const exportedDecls = sf.getExportedDeclarations().get(symbolName);
          if (!exportedDecls || exportedDecls.length === 0) {
            hasUnexportedLocalRef = true;
            return "unknown";
          }
        }

        const alias = this.allocateAlias(resolvedFile, symbolName);
        const dedupKey = `${resolvedFile}\0${symbolName}`;
        if (!seenKeys.has(dedupKey)) {
          seenKeys.add(dedupKey);
          imports.push({
            filePath: resolvedFile,
            exportName: symbolName,
            alias: alias !== symbolName ? alias : undefined,
            isTypeOnly: true,
          });
        }
        return alias;
      },
    );

    // If the entire type resolved to an unexported local class/interface,
    // attempt to serialize its own properties structurally as an inline type.
    if (hasUnexportedLocalRef && rewritten.trim() === "unknown") {
      const structural = this.tryInlineStructuralType(tsType, project);
      if (structural) {
        return structural;
      }
      return { text: fallback, imports: [] };
    }

    // Also inspect top-level symbol in case TS omitted import("...") for same-project types
    const sym = tsType.getAliasSymbol() ?? tsType.getSymbol();
    if (sym && !text.includes("import(")) {
      const decls = sym.getDeclarations();
      const firstDecl = decls[0];
      if (firstDecl) {
        const declFile = firstDecl.getSourceFile().getFilePath();
        const name = sym.getName();
        if (
          isUserProjectFile(declFile, this.projectRoot) &&
          name !== "__type" &&
          name !== "__object" &&
          new RegExp(`\\b${name}\\b`).test(rewritten)
        ) {
          if (isDeclarationExported(firstDecl)) {
            const alias = this.allocateAlias(declFile, name);
            const dedupKey = `${declFile}\0${name}`;
            if (!seenKeys.has(dedupKey)) {
              seenKeys.add(dedupKey);
              imports.push({
                filePath: declFile,
                exportName: name,
                alias: alias !== name ? alias : undefined,
                isTypeOnly: true,
              });
            }
            const replaced =
              alias !== name
                ? rewritten.replace(new RegExp(`\\b${name}\\b`, "g"), alias)
                : rewritten;
            return { text: replaced, imports };
          }
          // Unexported local type -> inline structural shape if object
          const structural = this.tryInlineStructuralType(tsType, project);
          if (structural) return structural;
          return { text: fallback, imports: [] };
        }
      }
    }

    const sanitizedRewritten = sanitizeTypeText(rewritten, fallback);
    if (sanitizedRewritten !== rewritten.trim()) {
      return { text: fallback, imports: [] };
    }
    return { text: sanitizedRewritten, imports };
  }

  private tryInlineStructuralType(
    tsType: TsType,
    project: Project,
  ): { text: string; imports: ExtractedImportRef[] } | undefined {
    if (!tsType.isObject() || tsType.isArray() || tsType.isTuple()) {
      return undefined;
    }
    const props = tsType.getProperties();
    if (props.length === 0 || props.length > 25) return undefined;

    const imports: ExtractedImportRef[] = [];
    const members: string[] = [];
    for (const prop of props) {
      const name = prop.getName();
      if (name.startsWith("_") && name.startsWith("__")) continue;
      const decl = prop.getValueDeclaration() ?? prop.getDeclarations()[0];
      if (!decl) continue;
      const propType = prop.getTypeAtLocation(decl);
      if (propType.getCallSignatures().length > 0) continue;
      const printed = this.printType(propType, project, "unknown");
      imports.push(...printed.imports);
      const optional = prop.isOptional() ? "?" : "";
      const key = /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
      members.push(`${key}${optional}: ${printed.text}`);
    }
    if (members.length === 0) return undefined;
    return { text: `{ ${members.join("; ")} }`, imports };
  }
}

function formatPluginImportSpecifier(fromDir: string, filePath: string): string {
  if (!filePath.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(filePath)) {
    return filePath;
  }
  let rel = relative(fromDir, filePath)
    .replace(/\\/g, "/")
    .replace(/\.(?:mts|cts|tsx|ts)$/, "");
  if (!rel.startsWith(".")) {
    rel = `./${rel}`;
  }
  return rel;
}

function formatPluginPropKey(key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
}

function normalizePluginEmitBlocks(raw: string | readonly string[]): string[] {
  const list = typeof raw === "string" ? [raw] : [...raw];
  return list.map((b) => b.trim()).filter((b) => b.length > 0);
}

function estimatePluginEntryCount(
  data: unknown,
  blocks: readonly string[],
): number {
  if (blocks.length === 0) return 0;
  if (Array.isArray(data)) return data.length;
  if (data && typeof data === "object") {
    const keys = Object.keys(data as Record<string, unknown>);
    if (keys.length > 0) return keys.length;
  }
  return blocks.length;
}

function formatCustomMemberSignature(
  memberName: string,
  rawSignature: string,
): string {
  const trimmed = rawSignature.trim().replace(/;+$/, "");
  if (!trimmed) return `${memberName}(): unknown`;
  if (trimmed.startsWith("(") || trimmed.startsWith("<")) {
    // Convert `(a: T) => R` arrow syntax to method signature `memberName(a: T): R`
    let depth = 0;
    let arrowIdx = -1;
    for (let i = 0; i < trimmed.length - 1; i++) {
      const ch = trimmed[i]!;
      if (ch === "(" || ch === "<" || ch === "{" || ch === "[") depth++;
      else if (ch === ")" || ch === ">" || ch === "}" || ch === "]") {
        if (ch === ">" && trimmed[i - 1] === "=") {
          // part of `=>`
        } else {
          depth = Math.max(0, depth - 1);
        }
      } else if (depth === 0 && ch === "=" && trimmed[i + 1] === ">") {
        arrowIdx = i;
        break;
      }
    }
    if (arrowIdx !== -1) {
      const params = trimmed.slice(0, arrowIdx).trim();
      const ret = trimmed.slice(arrowIdx + 2).trim();
      return `${memberName}${params}: ${ret}`;
    }
    return `${memberName}${trimmed}`;
  }
  if (
    trimmed.startsWith(`${memberName}(`) ||
    trimmed.startsWith(`${memberName}<`) ||
    trimmed.startsWith(`${memberName}:`) ||
    trimmed.startsWith(`${memberName}?:`) ||
    trimmed.startsWith("static ") ||
    trimmed.startsWith("readonly ") ||
    trimmed.startsWith("export ")
  ) {
    return trimmed;
  }
  if (/^[A-Za-z_$][\w$]*\s*(?:<[^>]*>)?\s*\(/.test(trimmed)) {
    return trimmed;
  }
  return `${memberName}: ${trimmed}`;
}

export interface BunestTypegenScannerConfig {
  readonly cwd: string;
  readonly sourceRoot: string;
  readonly tsconfigPath?: string;
  readonly envFiles?: readonly string[];
  readonly include?: readonly TypegenIncludeTarget[];
  readonly plugins?: readonly BunestTypegenPlugin<any>[];
  readonly macroDefaults?: GlobalMacroDefaultsLike;
  readonly macroPresets?: Readonly<Record<string, readonly string[]>>;
  readonly customMacros?: readonly CustomMacroPluginInput[];
  readonly bunestConfig?: BunestConfigLike;
}

/**
 * Persistent Bunest native TypeScript AST scanner powering both one-shot
 * `bunest typegen` and incremental live regeneration during `bunest dev` / `bunest start --watch`.
 */
export class BunestTypegenScanner {
  private readonly cwd: string;
  private readonly sourceRootDir: string;
  private readonly envFiles: readonly string[];
  private readonly rawInclude?: readonly TypegenIncludeTarget[];
  private readonly enabledTargets: ReadonlySet<string>;
  private readonly userPlugins: readonly BunestTypegenPlugin<any>[];
  private readonly macroDefaults?: GlobalMacroDefaultsLike;
  private readonly macroPresets?: Readonly<Record<string, readonly string[]>>;
  private readonly customMacros?: readonly CustomMacroPluginInput[];
  private readonly bunestConfig?: BunestConfigLike;
  private readonly project: Project;
  private readonly envOverrides = new Map<string, string>();

  constructor(config: BunestTypegenScannerConfig) {
    this.cwd = resolve(config.cwd);
    this.sourceRootDir = resolve(this.cwd, config.sourceRoot);
    this.envFiles = config.envFiles ?? DEFAULT_ENV_FILES;
    this.rawInclude = config.include;
    this.enabledTargets = new Set<string>(
      config.include ?? ALL_TYPEGEN_TARGETS,
    );
    this.bunestConfig = config.bunestConfig;
    this.macroDefaults = config.macroDefaults;
    this.macroPresets = config.macroPresets;
    this.customMacros = config.customMacros;
    this.userPlugins = [
      ...((config.bunestConfig?.typegen?.plugins ??
        []) as readonly BunestTypegenPlugin<any>[]),
      ...(config.plugins ?? []),
    ];

    const candidateTsconfig = config.tsconfigPath
      ? resolve(this.cwd, config.tsconfigPath)
      : resolve(this.cwd, "tsconfig.json");

    this.project = new Project({
      ...(existsSyncPath(candidateTsconfig)
        ? { tsConfigFilePath: candidateTsconfig }
        : {
            compilerOptions: {
              target: 99, // ESNext
              module: 200, // Preserve
              experimentalDecorators: true,
              emitDecoratorMetadata: true,
              strict: true,
              skipLibCheck: true,
              noEmit: true,
            },
          }),
      skipAddingFilesFromTsConfig: true,
      skipFileDependencyResolution: false,
    });

    this.syncAllSourceFiles();
  }

  /**
   * Returns the underlying persistent Bunest AST `Project` so shared static
   * analyzers and VS Code providers reuse the same parsed AST & TypeResolver.
   */
  getProject(): Project {
    return this.project;
  }

  getCwd(): string {
    return this.cwd;
  }

  getSourceRootDir(): string {
    return this.sourceRootDir;
  }

  getTrackedSourceFiles(): SourceFile[] {
    return this.project
      .getSourceFiles()
      .filter(
        (sf) =>
          sf.getFilePath().startsWith(this.sourceRootDir) &&
          isSourceTsFile(sf.getFilePath()),
      )
      .sort((a, b) => a.getFilePath().localeCompare(b.getFilePath()));
  }

  /**
   * Synchronizes the Bunest AST project file list with all `.ts` files under `sourceRoot`.
   */
  syncAllSourceFiles(): void {
    const diskFiles = new Set(walkTsSourceFiles(this.sourceRootDir));

    for (const existing of this.project.getSourceFiles()) {
      const fp = existing.getFilePath();
      if (fp.startsWith(this.sourceRootDir) && !diskFiles.has(fp)) {
        this.project.removeSourceFile(existing);
      }
    }

    for (const filePath of diskFiles) {
      if (!this.project.getSourceFile(filePath)) {
        this.project.addSourceFileAtPathIfExists(filePath);
      }
    }
  }

  /**
   * Stores an unsaved in-memory `.env*` buffer so live typegen reflects
   * newly typed config keys before the file is saved to disk.
   */
  updateEnvFileContent(filePath: string, content: string): void {
    this.envOverrides.set(resolve(this.cwd, filePath), content);
  }

  /**
   * Clears an in-memory `.env*` override (called on save or close-without-save).
   */
  clearEnvFileOverride(filePath: string): void {
    this.envOverrides.delete(resolve(this.cwd, filePath));
  }

  /**
   * Incrementally refreshes a single changed/added/deleted source file inside
   * the persistent Bunest AST `Project` (avoids full re-parsing in dev mode).
   */
  refreshFile(filePath: string): boolean {
    const absPath = resolve(this.cwd, filePath);
    if (!isSourceTsFile(absPath)) {
      return false;
    }
    const existing = this.project.getSourceFile(absPath);
    if (!existsSyncPath(absPath)) {
      if (existing) {
        this.project.removeSourceFile(existing);
        return true;
      }
      return false;
    }
    if (existing) {
      existing.refreshFromFileSystemSync();
      return true;
    }
    if (absPath.startsWith(this.sourceRootDir)) {
      this.project.addSourceFileAtPathIfExists(absPath);
      return true;
    }
    return false;
  }

  private createPluginContexts(
    baseScan: TypegenScanResult,
    sourceFiles: readonly SourceFile[],
    printer: TypePrinter,
    outputPath?: string,
    includeGlobalNamespace = true,
  ): {
    readonly scanCtx: TypegenPluginScanContext;
    readonly emitCtx: TypegenPluginEmitContext;
    readonly collectedImports: ExtractedImportRef[];
  } {
    const collectedImports: ExtractedImportRef[] = [];
    const resolvedOut = resolve(
      outputPath ?? resolve(this.cwd, ".bunest/types/bunest.d.ts"),
    );
    const outDir = dirname(resolvedOut);

    const scanCtx: TypegenPluginScanContext = {
      cwd: this.cwd,
      sourceRootDir: this.sourceRootDir,
      sourceFiles,
      project: this.project,
      scan: baseScan,
      printType: (tsType: TsType, fallback = "unknown") => {
        const printed = printer.printType(tsType, this.project, fallback);
        collectedImports.push(...printed.imports);
        return printed.text;
      },
      addImports: (imports: readonly ExtractedImportRef[]) => {
        collectedImports.push(...imports);
      },
    };

    const emitCtx: TypegenPluginEmitContext = {
      cwd: this.cwd,
      outputPath: resolvedOut,
      outputDir: outDir,
      includeGlobalNamespace,
      formatImportSpecifier: (filePath: string) =>
        formatPluginImportSpecifier(outDir, filePath),
      formatPropKey: formatPluginPropKey,
    };

    return { scanCtx, emitCtx, collectedImports };
  }

  /**
   * Runs synchronous AST extraction across all tracked source files, configured
   * `.env` files, and synchronous typegen plugins (including all 5 built-in ecosystem plugins).
   */
  scan(options?: {
    readonly outputPath?: string;
    readonly includeGlobalNamespace?: boolean;
  }): TypegenScanResult {
    const startMs = performance.now();
    const printer = new TypePrinter(this.cwd);
    const sourceFiles = this.getTrackedSourceFiles();
    const baseScan = this.scanCore(sourceFiles, printer, startMs);

    const activePlugins = selectActiveTypegenPlugins(
      this.userPlugins,
      this.rawInclude,
    );
    const pluginResults: ExtractedPluginScanResult[] = [];
    for (const plugin of activePlugins) {
      const { scanCtx, emitCtx, collectedImports } = this.createPluginContexts(
        baseScan,
        sourceFiles,
        printer,
        options?.outputPath,
        options?.includeGlobalNamespace ?? true,
      );
      const rawData = plugin.scan(scanCtx);
      if (rawData instanceof Promise) {
        continue;
      }
      const blocks = normalizePluginEmitBlocks(plugin.emit(rawData, emitCtx));
      if (blocks.length > 0) {
        pluginResults.push({
          pluginName: plugin.name,
          target: plugin.target,
          data: rawData,
          blocks,
          imports: collectedImports,
          entryCount: estimatePluginEntryCount(rawData, blocks),
        });
      }
    }

    const durationMs = Math.round((performance.now() - startMs) * 100) / 100;
    return {
      ...baseScan,
      ...(pluginResults.length > 0 ? { pluginResults } : {}),
      durationMs,
    };
  }

  /**
   * Runs full AST extraction including both synchronous and asynchronous typegen plugins.
   */
  async scanAsync(options?: {
    readonly outputPath?: string;
    readonly includeGlobalNamespace?: boolean;
  }): Promise<TypegenScanResult> {
    const startMs = performance.now();
    const printer = new TypePrinter(this.cwd);
    const sourceFiles = this.getTrackedSourceFiles();
    const baseScan = this.scanCore(sourceFiles, printer, startMs);

    const activePlugins = selectActiveTypegenPlugins(
      this.userPlugins,
      this.rawInclude,
    );
    const pluginResults: ExtractedPluginScanResult[] = [];
    for (const plugin of activePlugins) {
      const { scanCtx, emitCtx, collectedImports } = this.createPluginContexts(
        baseScan,
        sourceFiles,
        printer,
        options?.outputPath,
        options?.includeGlobalNamespace ?? true,
      );
      const data = await plugin.scan(scanCtx);
      const blocks = normalizePluginEmitBlocks(plugin.emit(data, emitCtx));
      if (blocks.length > 0) {
        pluginResults.push({
          pluginName: plugin.name,
          target: plugin.target,
          data,
          blocks,
          imports: collectedImports,
          entryCount: estimatePluginEntryCount(data, blocks),
        });
      }
    }

    const durationMs = Math.round((performance.now() - startMs) * 100) / 100;
    return {
      ...baseScan,
      ...(pluginResults.length > 0 ? { pluginResults } : {}),
      durationMs,
    };
  }

  private scanCore(
    sourceFiles: readonly SourceFile[],
    printer: TypePrinter,
    startMs: number,
  ): TypegenScanResult {
    const modelsMap = new Map<string, ExtractedModelEntry>();
    const connectionsMap = new Map<string, ExtractedConnectionEntry>();
    const configNsMap = new Map<string, ExtractedConfigNamespaceEntry>();
    const envKeysMap = new Map<string, ExtractedEnvKeyEntry>();
    const eventsAcc = new Map<
      string,
      {
        types: Set<string>;
        imports: ExtractedImportRef[];
        sourceFile: string;
        location?: SourceLocation;
        locations: SourceLocation[];
      }
    >();
    const msgPatternsMap = new Map<string, ExtractedMessagePatternEntry>();
    const evtPatternsMap = new Map<string, ExtractedEventPatternEntry>();
    const routesMap = new Map<string, ExtractedRouteEntry>();
    const commandsMap = new Map<string, ExtractedCqrsCommandEntry>();
    const queriesMap = new Map<string, ExtractedCqrsQueryEntry>();
    const tokensMap = new Map<string, ExtractedTokenEntry>();
    const classMacros: ExtractedClassMacroEntry[] = [];
    const injectableLoggers: ExtractedInjectableLoggerEntry[] = [];
    const callSites: ExtractedCallSite[] = [];

    // Pre-pass: map SchemaFactory.createForClass(TargetClass) variable names -> TargetClass info
    const schemaFactoryVarMap = new Map<
      string,
      { className: string; filePath: string }
    >();
    if (this.enabledTargets.has("mongoose")) {
      for (const sf of sourceFiles) {
        this.collectSchemaFactoryVariables(sf, schemaFactoryVarMap);
      }
    }

    for (const sf of sourceFiles) {
      if (this.enabledTargets.has("mongoose")) {
        this.scanMongooseInFile(
          sf,
          printer,
          schemaFactoryVarMap,
          modelsMap,
          connectionsMap,
        );
      }
      if (this.enabledTargets.has("config")) {
        this.scanConfigInFile(sf, printer, configNsMap);
      }
      if (this.enabledTargets.has("events")) {
        this.scanEventsInFile(sf, printer, eventsAcc);
      }
      if (this.enabledTargets.has("microservices")) {
        this.scanMicroservicesInFile(
          sf,
          printer,
          msgPatternsMap,
          evtPatternsMap,
        );
      }
      if (this.enabledTargets.has("routes")) {
        this.scanRoutesInFile(sf, printer, routesMap);
      }
      if (this.enabledTargets.has("cqrs")) {
        this.scanCqrsInFile(sf, printer, commandsMap, queriesMap);
      }
      if (this.enabledTargets.has("tokens")) {
        this.scanTokensInFile(sf, printer, tokensMap);
      }
      if (this.enabledTargets.has("macros")) {
        this.scanClassMacrosInFile(sf, printer, classMacros);
      }
      this.scanInjectableLoggersInFile(sf, injectableLoggers);
      this.scanCallSitesInFile(sf, callSites);
    }

    // Scan .env files for top-level config keys (checking unsaved in-memory overrides first)
    if (this.enabledTargets.has("config")) {
      for (const relEnv of this.envFiles) {
        const absEnv = resolve(this.cwd, relEnv);
        for (const entry of parseEnvKeysFromFile(
          absEnv,
          this.envOverrides.get(absEnv),
        )) {
          if (!envKeysMap.has(entry.key) && !configNsMap.has(entry.key)) {
            envKeysMap.set(entry.key, {
              key: entry.key,
              sourceFile: absEnv,
              location: {
                filePath: absEnv,
                line: entry.line,
                column: 1,
                endLine: entry.line,
                endColumn: entry.endColumn,
                start: 0,
                end: 0,
              },
            });
          }
        }
      }
    }

    // Finalize merged events
    const events: ExtractedEventEntry[] = [];
    for (const [eventName, acc] of [...eventsAcc.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const concrete = [...acc.types].filter(
        (t) => t !== "unknown" && t !== "any",
      );
      const chosen = concrete.length > 0 ? concrete : ["unknown"];
      events.push({
        eventName,
        payloadTypeText: chosen.join(" | "),
        sourceFile: acc.sourceFile,
        location: acc.location,
        locations: acc.locations,
        imports: acc.imports,
      });
    }

    const durationMs = Math.round((performance.now() - startMs) * 100) / 100;

    return {
      models: [...modelsMap.values()].sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
      connections: [...connectionsMap.values()].sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
      configNamespaces: [...configNsMap.values()].sort((a, b) =>
        a.namespace.localeCompare(b.namespace),
      ),
      envKeys: [...envKeysMap.values()].sort((a, b) =>
        a.key.localeCompare(b.key),
      ),
      events,
      messagePatterns: [...msgPatternsMap.values()].sort((a, b) =>
        a.patternKey.localeCompare(b.patternKey),
      ),
      eventPatterns: [...evtPatternsMap.values()].sort((a, b) =>
        a.patternKey.localeCompare(b.patternKey),
      ),
      routes: [...routesMap.values()].sort((a, b) =>
        a.key.localeCompare(b.key),
      ),
      commands: [...commandsMap.values()].sort((a, b) =>
        a.key.localeCompare(b.key),
      ),
      queries: [...queriesMap.values()].sort((a, b) =>
        a.key.localeCompare(b.key),
      ),
      tokens: [...tokensMap.values()].sort((a, b) =>
        a.token.localeCompare(b.token),
      ),
      classMacros: classMacros.sort(
        (a, b) =>
          a.sourceFile.localeCompare(b.sourceFile) ||
          a.className.localeCompare(b.className),
      ),
      injectableLoggers: injectableLoggers.sort(
        (a, b) =>
          a.sourceFile.localeCompare(b.sourceFile) ||
          a.className.localeCompare(b.className),
      ),
      callSites,
      scannedFiles: sourceFiles.length,
      durationMs,
    };
  }

  // ─── 1. Mongoose Scanner ──────────────────────────────────────────────────

  private collectSchemaFactoryVariables(
    sf: SourceFile,
    schemaFactoryVarMap: Map<string, { className: string; filePath: string }>,
  ): void {
    for (const varDecl of sf.getVariableDeclarations()) {
      const init = unwrapParensAndAs(varDecl.getInitializer());
      if (!init || !Node.isCallExpression(init)) continue;
      const targetClass = this.extractSchemaFactoryTargetClass(init);
      if (targetClass) {
        schemaFactoryVarMap.set(
          `${sf.getFilePath()}\0${varDecl.getName()}`,
          targetClass,
        );
        // Also index by variable name as fallback across imports
        if (!schemaFactoryVarMap.has(varDecl.getName())) {
          schemaFactoryVarMap.set(varDecl.getName(), targetClass);
        }
      }
    }
  }

  private extractSchemaFactoryTargetClass(
    callExpr: CallExpression,
  ): { className: string; filePath: string } | undefined {
    const callee = callExpr.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) return undefined;
    if (callee.getName() !== "createForClass") return undefined;
    const arg = unwrapParensAndAs(
      callExpr.getArguments()[0] as Expression | undefined,
    );
    if (!arg || !Node.isIdentifier(arg)) return undefined;
    const sym = arg.getSymbol();
    const decl =
      sym?.getAliasedSymbol()?.getDeclarations()[0] ??
      sym?.getDeclarations()[0];
    if (
      decl &&
      Node.isClassDeclaration(decl) &&
      decl.isExported() &&
      decl.getName()
    ) {
      return {
        className: decl.getName()!,
        filePath: decl.getSourceFile().getFilePath(),
      };
    }
    return undefined;
  }

  private scanMongooseInFile(
    sf: SourceFile,
    printer: TypePrinter,
    schemaFactoryVarMap: Map<string, { className: string; filePath: string }>,
    modelsMap: Map<string, ExtractedModelEntry>,
    connectionsMap: Map<string, ExtractedConnectionEntry>,
  ): void {
    const filePath = sf.getFilePath();

    // 1a. @Schema() decorated classes
    for (const cls of sf.getClasses()) {
      const schemaDec = cls
        .getDecorators()
        .find((d) => getDecoratorShortName(d) === "Schema");
      if (!schemaDec) continue;
      const className = cls.getName();
      if (!className || !cls.isExported()) continue;

      if (!modelsMap.has(className)) {
        const ref = printer.printNamedExport(filePath, className);
        modelsMap.set(className, {
          name: className,
          typeText: ref.text,
          sourceFile: filePath,
          location: nodeToLocation(cls.getNameNode() ?? cls),
          imports: ref.imports,
        });
      }
    }

    // 1b. MongooseModule.forRoot / forRootAsync / forFeature / forFeatureAsync
    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const expr = call.getExpression();
      if (!Node.isPropertyAccessExpression(expr)) continue;
      const objText = expr.getExpression().getText();
      if (!objText.endsWith("MongooseModule")) continue;
      const methodName = expr.getName();
      const args = call.getArguments();

      if (methodName === "forRoot") {
        const connName = extractStringLiteral(
          getPropertyInitializer(
            args[1] as Expression | undefined,
            "connectionName",
          ),
        );
        if (connName && !connectionsMap.has(connName)) {
          connectionsMap.set(connName, {
            name: connName,
            sourceFile: filePath,
            location: nodeToLocation(call),
          });
        }
      } else if (methodName === "forRootAsync") {
        const connName = extractStringLiteral(
          getPropertyInitializer(
            args[0] as Expression | undefined,
            "connectionName",
          ),
        );
        if (connName && !connectionsMap.has(connName)) {
          connectionsMap.set(connName, {
            name: connName,
            sourceFile: filePath,
            location: nodeToLocation(call),
          });
        }
      } else if (
        methodName === "forFeature" ||
        methodName === "forFeatureAsync"
      ) {
        const connName = extractStringLiteral(
          args[1] as Expression | undefined,
        );
        if (connName && !connectionsMap.has(connName)) {
          connectionsMap.set(connName, {
            name: connName,
            sourceFile: filePath,
            location: nodeToLocation(call),
          });
        }
        const modelsArg = unwrapParensAndAs(args[0] as Expression | undefined);
        if (modelsArg && Node.isArrayLiteralExpression(modelsArg)) {
          for (const el of modelsArg.getElements()) {
            if (!Node.isObjectLiteralExpression(el)) continue;
            const nameExpr = getPropertyInitializer(el, "name");
            const modelName = this.resolveModelNameExpr(nameExpr);
            if (!modelName) continue;

            // Try to resolve target class from `name: Cat.name` or `schema: CatSchema`
            let targetClass = this.resolveClassFromDotName(nameExpr);
            if (!targetClass) {
              const schemaExpr = unwrapParensAndAs(
                getPropertyInitializer(el, "schema"),
              );
              if (schemaExpr && Node.isCallExpression(schemaExpr)) {
                targetClass = this.extractSchemaFactoryTargetClass(schemaExpr);
              } else if (schemaExpr && Node.isIdentifier(schemaExpr)) {
                const sym = schemaExpr.getSymbol();
                const decl =
                  sym?.getAliasedSymbol()?.getDeclarations()[0] ??
                  sym?.getDeclarations()[0];
                const declKey = decl
                  ? `${decl.getSourceFile().getFilePath()}\0${schemaExpr.getText()}`
                  : "";
                targetClass =
                  schemaFactoryVarMap.get(declKey) ??
                  schemaFactoryVarMap.get(schemaExpr.getText());
              }
            }

            if (targetClass && !modelsMap.has(modelName)) {
              const ref = printer.printNamedExport(
                targetClass.filePath,
                targetClass.className,
              );
              modelsMap.set(modelName, {
                name: modelName,
                typeText: ref.text,
                sourceFile: filePath,
                location: nodeToLocation(el),
                imports: ref.imports,
              });
            }
          }
        }
      }
    }
  }

  private resolveModelNameExpr(
    expr: Expression | undefined,
  ): string | undefined {
    const unwrapped = unwrapParensAndAs(expr);
    if (!unwrapped) return undefined;
    const str = extractStringLiteral(unwrapped);
    if (str !== undefined) return str;
    if (
      Node.isPropertyAccessExpression(unwrapped) &&
      unwrapped.getName() === "name" &&
      Node.isIdentifier(unwrapped.getExpression())
    ) {
      return unwrapped.getExpression().getText();
    }
    return undefined;
  }

  private resolveClassFromDotName(
    expr: Expression | undefined,
  ): { className: string; filePath: string } | undefined {
    const unwrapped = unwrapParensAndAs(expr);
    if (
      !unwrapped ||
      !Node.isPropertyAccessExpression(unwrapped) ||
      unwrapped.getName() !== "name"
    ) {
      return undefined;
    }
    const base = unwrapped.getExpression();
    if (!Node.isIdentifier(base)) return undefined;
    const sym = base.getSymbol();
    const decl =
      sym?.getAliasedSymbol()?.getDeclarations()[0] ??
      sym?.getDeclarations()[0];
    if (
      decl &&
      Node.isClassDeclaration(decl) &&
      decl.isExported() &&
      decl.getName()
    ) {
      return {
        className: decl.getName()!,
        filePath: decl.getSourceFile().getFilePath(),
      };
    }
    return undefined;
  }

  // ─── 2. Config Scanner (`registerAs`) ─────────────────────────────────────

  private scanConfigInFile(
    sf: SourceFile,
    printer: TypePrinter,
    configNsMap: Map<string, ExtractedConfigNamespaceEntry>,
  ): void {
    const filePath = sf.getFilePath();

    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const calleeText = call.getExpression().getText();
      if (calleeText !== "registerAs" && !calleeText.endsWith(".registerAs")) {
        continue;
      }
      const args = call.getArguments();
      const namespace = extractStringLiteral(args[0] as Expression | undefined);
      if (!namespace || configNsMap.has(namespace)) continue;

      // Case A: Assigned to an exported variable -> `ConfigType<typeof dbConfig>`
      const parent = call.getParent();
      if (Node.isVariableDeclaration(parent)) {
        const varStmt = parent.getVariableStatement();
        if (varStmt?.isExported()) {
          const varName = parent.getName();
          const ref = printer.printNamedExport(filePath, varName);
          configNsMap.set(namespace, {
            namespace,
            typeText: `ConfigType<typeof ${ref.text}>`,
            usesConfigTypeHelper: true,
            sourceFile: filePath,
            location: nodeToLocation(parent),
            imports: ref.imports,
          });
          continue;
        }
      }

      // Case B: Inline or default export -> inspect factory function return type
      const factoryExpr = unwrapParensAndAs(args[1] as Expression | undefined);
      if (factoryExpr) {
        const callSigs = factoryExpr.getType().getCallSignatures();
        const retType = callSigs[0]?.getReturnType();
        if (retType) {
          const unwrapped = unwrapPromiseType(retType);
          const printed = printer.printType(
            unwrapped,
            this.project,
            "Record<string, unknown>",
          );
          configNsMap.set(namespace, {
            namespace,
            typeText: printed.text,
            usesConfigTypeHelper: false,
            sourceFile: filePath,
            location: nodeToLocation(call),
            imports: printed.imports,
          });
          continue;
        }
      }

      configNsMap.set(namespace, {
        namespace,
        typeText: "Record<string, unknown>",
        usesConfigTypeHelper: false,
        sourceFile: filePath,
        location: nodeToLocation(call),
        imports: [],
      });
    }
  }

  // ─── 3. Events Scanner (`@OnEvent` & `@EmitEvent`) ────────────────────────

  private scanEventsInFile(
    sf: SourceFile,
    printer: TypePrinter,
    eventsAcc: Map<
      string,
      {
        types: Set<string>;
        imports: ExtractedImportRef[];
        sourceFile: string;
        location?: SourceLocation;
        locations: SourceLocation[];
      }
    >,
  ): void {
    const filePath = sf.getFilePath();

    const recordEvent = (
      eventName: string,
      typeText: string,
      imports: readonly ExtractedImportRef[],
      location: SourceLocation,
    ) => {
      // Skip wildcard patterns (*, **) since concrete event names are emitted
      if (eventName.includes("*")) return;
      let acc = eventsAcc.get(eventName);
      if (!acc) {
        acc = {
          types: new Set(),
          imports: [],
          sourceFile: filePath,
          location,
          locations: [],
        };
        eventsAcc.set(eventName, acc);
      }
      acc.types.add(typeText);
      acc.imports.push(...imports);
      acc.locations.push(location);
    };

    for (const cls of sf.getClasses()) {
      for (const method of cls.getMethods()) {
        for (const dec of method.getDecorators()) {
          const shortName = getDecoratorShortName(dec);
          const args = dec.getArguments();

          if (shortName === "OnEvent") {
            const eventNames = extractStringOrArrayLiterals(
              args[0] as Expression | undefined,
            );
            if (eventNames.length === 0) continue;

            const params = method.getParameters();
            const payloadParam =
              params.find((p) =>
                p
                  .getDecorators()
                  .some((d) => getDecoratorShortName(d) === "EventPayload"),
              ) ?? params[0];

            let payloadTypeText = "void";
            let imports: ExtractedImportRef[] = [];
            if (payloadParam) {
              const printed = printer.printType(
                payloadParam.getType(),
                this.project,
                "unknown",
              );
              payloadTypeText = printed.text;
              imports = printed.imports;
            }

            const loc = nodeToLocation(method.getNameNode());
            for (const eventName of eventNames) {
              recordEvent(eventName, payloadTypeText, imports, loc);
            }
          } else if (shortName === "EmitEvent") {
            const eventName = extractStringLiteral(
              args[0] as Expression | undefined,
            );
            if (!eventName) continue;

            const payloadMapper = getPropertyInitializer(
              args[1] as Expression | undefined,
              "payload",
            );
            let targetType: TsType | undefined;
            if (payloadMapper) {
              const sig = payloadMapper.getType().getCallSignatures()[0];
              targetType = sig?.getReturnType();
            } else {
              targetType = unwrapPromiseType(method.getReturnType());
            }

            const printed = targetType
              ? printer.printType(targetType, this.project, "unknown")
              : { text: "unknown", imports: [] };

            recordEvent(
              eventName,
              printed.text,
              printed.imports,
              nodeToLocation(method.getNameNode()),
            );
          }
        }
      }
    }
  }

  // ─── 4. Microservices Scanner (`@MessagePattern` / `@EventPattern`) ───────

  private extractRpcPayloadParam(
    method: MethodDeclaration,
  ): ParameterDeclaration | undefined {
    const params = method.getParameters();
    const explicit = params.find((p) =>
      p.getDecorators().some((d) => getDecoratorShortName(d) === "Payload"),
    );
    if (explicit) return explicit;
    return params.find(
      (p) => !p.getDecorators().some((d) => getDecoratorShortName(d) === "Ctx"),
    );
  }

  private scanMicroservicesInFile(
    sf: SourceFile,
    printer: TypePrinter,
    msgPatternsMap: Map<string, ExtractedMessagePatternEntry>,
    evtPatternsMap: Map<string, ExtractedEventPatternEntry>,
  ): void {
    const filePath = sf.getFilePath();

    for (const cls of sf.getClasses()) {
      for (const method of cls.getMethods()) {
        for (const dec of method.getDecorators()) {
          const shortName = getDecoratorShortName(dec);
          if (shortName !== "MessagePattern" && shortName !== "EventPattern") {
            continue;
          }
          const patternKeys = extractPatternKeys(
            dec.getArguments()[0] as Expression | undefined,
          );
          if (patternKeys.length === 0) continue;

          const payloadParam = this.extractRpcPayloadParam(method);
          const reqPrinted = payloadParam
            ? printer.printType(payloadParam.getType(), this.project, "unknown")
            : { text: "void", imports: [] };

          if (shortName === "MessagePattern") {
            const retType = unwrapPromiseType(method.getReturnType());
            const resPrinted = printer.printType(
              retType,
              this.project,
              "unknown",
            );
            for (const patternKey of patternKeys) {
              if (!msgPatternsMap.has(patternKey)) {
                msgPatternsMap.set(patternKey, {
                  patternKey,
                  requestTypeText: reqPrinted.text,
                  responseTypeText: resPrinted.text,
                  sourceFile: filePath,
                  location: nodeToLocation(method.getNameNode()),
                  imports: [...reqPrinted.imports, ...resPrinted.imports],
                });
              }
            }
          } else {
            for (const patternKey of patternKeys) {
              if (!evtPatternsMap.has(patternKey)) {
                evtPatternsMap.set(patternKey, {
                  patternKey,
                  payloadTypeText: reqPrinted.text,
                  sourceFile: filePath,
                  location: nodeToLocation(method.getNameNode()),
                  imports: reqPrinted.imports,
                });
              }
            }
          }
        }
      }
    }
  }

  // ─── 5. HTTP Routes Scanner (`@Controller` + `@Get`/`@Post`/...) ──────────

  private extractControllerPrefixes(
    cls: ClassDeclaration,
  ): string[] | undefined {
    const dec = cls
      .getDecorators()
      .find((d) => getDecoratorShortName(d) === "Controller");
    if (!dec) return undefined;
    const firstArg = unwrapParensAndAs(
      dec.getArguments()[0] as Expression | undefined,
    );
    if (!firstArg) return [""];
    const direct = extractStringOrArrayLiterals(firstArg);
    if (direct.length > 0) return direct;
    if (Node.isObjectLiteralExpression(firstArg)) {
      const pathInit = getPropertyInitializer(firstArg, "path");
      const objPaths = extractStringOrArrayLiterals(pathInit);
      return objPaths.length > 0 ? objPaths : [""];
    }
    return [""];
  }

  private extractMethodHttpRoutes(
    method: MethodDeclaration,
  ): Array<{ httpMethod: string; path: string }> {
    const out: Array<{ httpMethod: string; path: string }> = [];
    for (const dec of method.getDecorators()) {
      const shortName = getDecoratorShortName(dec);
      if (shortName in HTTP_METHOD_DECORATORS) {
        const httpMethod = HTTP_METHOD_DECORATORS[shortName]!;
        const args = dec.getArguments();
        const paths = extractStringOrArrayLiterals(
          args[0] as Expression | undefined,
        );
        if (paths.length === 0) {
          out.push({ httpMethod, path: "" });
        } else {
          for (const p of paths) {
            out.push({ httpMethod, path: p });
          }
        }
      } else if (shortName === "RequestMapping") {
        const arg = dec.getArguments()[0] as Expression | undefined;
        const pathExpr = getPropertyInitializer(arg, "path");
        const methodExpr = unwrapParensAndAs(
          getPropertyInitializer(arg, "method"),
        );
        let httpMethod = "GET";
        if (methodExpr) {
          const text = methodExpr
            .getText()
            .replace(/^RequestMethod\./, "")
            .replace(/^['"]|['"]$/g, "");
          httpMethod = REQUEST_METHOD_ENUM_MAP[text] ?? "GET";
        }
        const paths = extractStringOrArrayLiterals(pathExpr);
        if (paths.length === 0) {
          out.push({ httpMethod, path: "" });
        } else {
          for (const p of paths) {
            out.push({ httpMethod, path: p });
          }
        }
      }
    }
    return out;
  }

  // ─── 5b. Standard Schema AST Inference Helpers ────────────────────────────

  private formatInlinePropKey(key: string): string {
    return /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
  }

  private extractParamDecoratorKeyAndSchema(dec: Decorator): {
    readonly key?: string;
    readonly schemaExpr?: Expression;
    readonly explicitSchemaOption: boolean;
  } {
    const args = dec.getArguments();
    const arg0 = unwrapParensAndAs(args[0] as Expression | undefined);
    const arg1 = unwrapParensAndAs(args[1] as Expression | undefined);

    if (!arg0) {
      return { explicitSchemaOption: false };
    }

    const strKey = extractStringLiteral(arg0);
    if (strKey !== undefined) {
      if (!arg1) {
        return { key: strKey, explicitSchemaOption: false };
      }
      if (Node.isObjectLiteralExpression(arg1)) {
        const schemaProp = unwrapParensAndAs(
          getPropertyInitializer(arg1, "schema"),
        );
        const propOverride = extractStringLiteral(
          getPropertyInitializer(arg1, "property"),
        );
        if (schemaProp) {
          return {
            key: propOverride ?? strKey,
            schemaExpr: schemaProp,
            explicitSchemaOption: true,
          };
        }
        return { key: propOverride ?? strKey, explicitSchemaOption: false };
      }
      return {
        key: strKey,
        schemaExpr: arg1,
        explicitSchemaOption: false,
      };
    }

    if (Node.isObjectLiteralExpression(arg0)) {
      const schemaProp = unwrapParensAndAs(
        getPropertyInitializer(arg0, "schema"),
      );
      const propKey = extractStringLiteral(
        getPropertyInitializer(arg0, "property"),
      );
      if (schemaProp) {
        return {
          key: propKey,
          schemaExpr: schemaProp,
          explicitSchemaOption: true,
        };
      }
      // Inline Standard Schema object literal `{ "~standard": { ... } }`
      if (getPropertyInitializer(arg0, "~standard")) {
        return { schemaExpr: arg0, explicitSchemaOption: true };
      }
      return { key: propKey, explicitSchemaOption: false };
    }

    return { schemaExpr: arg0, explicitSchemaOption: false };
  }

  private extractResponseStandardSchemaExpr(
    cls: ClassDeclaration,
    method: MethodDeclaration,
  ): Expression | undefined {
    const fromDecorators = (decs: readonly Decorator[]): Expression | undefined => {
      for (const dec of decs) {
        const short = getDecoratorShortName(dec);
        const arg0 = unwrapParensAndAs(
          dec.getArguments()[0] as Expression | undefined,
        );
        if (short === "UseStandardSchema" && arg0) {
          return arg0;
        }
        if (short === "SerializeOptions" && arg0) {
          const schemaProp = unwrapParensAndAs(
            getPropertyInitializer(arg0, "schema"),
          );
          if (schemaProp) return schemaProp;
        }
      }
      return undefined;
    };

    return (
      fromDecorators(method.getDecorators()) ??
      fromDecorators(cls.getDecorators())
    );
  }

  private resolveSchemaSymbolDeclaration(
    ident: Expression,
    sf: SourceFile,
  ): Node | undefined {
    if (!Node.isIdentifier(ident)) return undefined;
    const sym = sf.getResolver().resolveIdentifierSymbol(ident.getText(), sf, ident);
    const target = sym?.getAliasedSymbol() ?? sym;
    return target?.getValueDeclaration() ?? target?.getDeclarations()[0];
  }

  private unwrapCreateSchemaDtoArg(clsDecl: ClassDeclaration): Expression | undefined {
    const ext = clsDecl.getExtends();
    if (!ext) return undefined;
    const expr = unwrapParensAndAs(ext.getExpression());
    if (!expr || !Node.isCallExpression(expr)) return undefined;
    const calleeText = expr.getExpression().getText();
    if (
      calleeText === "createSchemaDto" ||
      calleeText.endsWith(".createSchemaDto")
    ) {
      return unwrapParensAndAs(
        expr.getArguments()[0] as Expression | undefined,
      );
    }
    return undefined;
  }

  private extractDslSchemaType(
    rawExpr: Expression,
    mode: "input" | "output",
    sf: SourceFile,
    printer: TypePrinter,
    visited: Set<string>,
  ): {
    readonly typeText: string;
    readonly optional: boolean;
    readonly nullable: boolean;
    readonly imports: ExtractedImportRef[];
  } | undefined {
    const expr = unwrapParensAndAs(rawExpr);
    if (!expr) return undefined;

    // Unwrap `new StandardSchemaValidationPipe(schema)`
    if (Node.isNewExpression(expr)) {
      const callee = expr.getExpression().getText();
      if (
        callee === "StandardSchemaValidationPipe" ||
        callee.endsWith(".StandardSchemaValidationPipe")
      ) {
        const arg0 = expr.getArguments()[0] as Expression | undefined;
        if (arg0) {
          return this.extractDslSchemaType(arg0, mode, sf, printer, visited);
        }
      }
      return undefined;
    }

    // Follow identifier to its variable or createSchemaDto class declaration
    if (Node.isIdentifier(expr)) {
      const identName = expr.getText();
      if (identName.endsWith("Pipe")) return undefined;
      const visitKey = `${sf.getFilePath()}\0${identName}`;
      if (visited.has(visitKey)) return undefined;

      const decl = this.resolveSchemaSymbolDeclaration(expr, sf);
      if (!decl) return undefined;

      if (Node.isClassDeclaration(decl)) {
        const innerArg = this.unwrapCreateSchemaDtoArg(decl);
        if (!innerArg) return undefined;
        const nextVisited = new Set(visited);
        nextVisited.add(visitKey);
        return this.extractDslSchemaType(
          innerArg,
          mode,
          decl.getSourceFile(),
          printer,
          nextVisited,
        );
      }

      if (Node.isVariableDeclaration(decl)) {
        const init = unwrapParensAndAs(decl.getInitializer());
        if (init) {
          const nextVisited = new Set(visited);
          nextVisited.add(visitKey);
          const extracted = this.extractDslSchemaType(
            init,
            mode,
            decl.getSourceFile(),
            printer,
            nextVisited,
          );
          if (extracted) return extracted;
        }
      }

      return undefined;
    }

    if (!Node.isCallExpression(expr)) {
      return undefined;
    }

    const callee = expr.getExpression();
    const args = expr.getArguments();

    // Direct function calls: `createSchemaDto(schema)`
    if (Node.isIdentifier(callee)) {
      if (callee.getText() === "createSchemaDto" && args[0]) {
        return this.extractDslSchemaType(
          args[0] as Expression,
          mode,
          sf,
          printer,
          visited,
        );
      }
      return undefined;
    }

    if (!Node.isPropertyAccessExpression(callee)) {
      return undefined;
    }

    const methodName = callee.getName();
    const receiver = unwrapParensAndAs(callee.getExpression());
    if (!receiver) return undefined;
    const receiverText = receiver.getText();

    // Base factory calls: `s.*(...)`, `z.*(...)`, `v.*(...)`, `s.coerce.*(...)`, `z.coerce.*(...)`
    const isFactoryRoot =
      receiverText === "s" ||
      receiverText === "z" ||
      receiverText === "v" ||
      receiverText === "s.coerce" ||
      receiverText === "z.coerce";

    if (isFactoryRoot) {
      switch (methodName) {
        case "string":
          return { typeText: "string", optional: false, nullable: false, imports: [] };
        case "number":
        case "int":
          return { typeText: "number", optional: false, nullable: false, imports: [] };
        case "boolean":
          return { typeText: "boolean", optional: false, nullable: false, imports: [] };
        case "date":
          return { typeText: "Date", optional: false, nullable: false, imports: [] };
        case "bigint":
          return { typeText: "bigint", optional: false, nullable: false, imports: [] };
        case "unknown":
        case "any":
          return { typeText: "unknown", optional: false, nullable: false, imports: [] };
        case "null":
          return { typeText: "null", optional: false, nullable: true, imports: [] };
        case "undefined":
          return { typeText: "undefined", optional: true, nullable: false, imports: [] };
        case "literal": {
          const parsed = extractStaticJsonValue(args[0] as Expression | undefined);
          if (parsed.ok) {
            const lit =
              parsed.value === null ? "null" : JSON.stringify(parsed.value);
            return { typeText: lit, optional: false, nullable: parsed.value === null, imports: [] };
          }
          return { typeText: "unknown", optional: false, nullable: false, imports: [] };
        }
        case "enum":
        case "picklist": {
          const arg0 = unwrapParensAndAs(args[0] as Expression | undefined);
          if (arg0 && Node.isArrayLiteralExpression(arg0)) {
            const lits: string[] = [];
            for (const el of arg0.getElements()) {
              const p = extractStaticJsonValue(el);
              if (p.ok && (typeof p.value === "string" || typeof p.value === "number")) {
                lits.push(JSON.stringify(p.value));
              }
            }
            if (lits.length > 0) {
              return { typeText: lits.join(" | "), optional: false, nullable: false, imports: [] };
            }
          } else if (arg0 && Node.isIdentifier(arg0)) {
            const decl = this.resolveSchemaSymbolDeclaration(arg0, sf);
            if (decl && Node.isEnumDeclaration(decl) && decl.isExported() && decl.getName()) {
              const ref = printer.printNamedExport(
                decl.getSourceFile().getFilePath(),
                decl.getName()!,
              );
              return { typeText: ref.text, optional: false, nullable: false, imports: ref.imports };
            }
          }
          return { typeText: "string", optional: false, nullable: false, imports: [] };
        }
        case "array": {
          const inner = args[0]
            ? this.extractDslSchemaType(args[0] as Expression, mode, sf, printer, visited)
            : undefined;
          const elemText = inner
            ? this.finalizeDslType(inner)
            : "unknown";
          const needsParens =
            elemText.includes(" | ") || elemText.includes(" & ");
          return {
            typeText: needsParens ? `(${elemText})[]` : `${elemText}[]`,
            optional: false,
            nullable: false,
            imports: inner?.imports ?? [],
          };
        }
        case "tuple": {
          const arg0 = unwrapParensAndAs(args[0] as Expression | undefined);
          if (arg0 && Node.isArrayLiteralExpression(arg0)) {
            const imports: ExtractedImportRef[] = [];
            const items = arg0.getElements().map((el) => {
              const parsed = this.extractDslSchemaType(el, mode, sf, printer, visited);
              if (parsed) {
                imports.push(...parsed.imports);
                return this.finalizeDslType(parsed);
              }
              return "unknown";
            });
            return {
              typeText: `[${items.join(", ")}]`,
              optional: false,
              nullable: false,
              imports,
            };
          }
          return { typeText: "unknown[]", optional: false, nullable: false, imports: [] };
        }
        case "record": {
          const keyExpr = args.length >= 2 ? (args[0] as Expression) : undefined;
          const valExpr = (args.length >= 2 ? args[1] : args[0]) as Expression | undefined;
          const kRes = keyExpr
            ? this.extractDslSchemaType(keyExpr, mode, sf, printer, visited)
            : undefined;
          const vRes = valExpr
            ? this.extractDslSchemaType(valExpr, mode, sf, printer, visited)
            : undefined;
          const kText = kRes ? this.finalizeDslType(kRes) : "string";
          const vText = vRes ? this.finalizeDslType(vRes) : "unknown";
          return {
            typeText: `Record<${kText}, ${vText}>`,
            optional: false,
            nullable: false,
            imports: [...(kRes?.imports ?? []), ...(vRes?.imports ?? [])],
          };
        }
        case "object": {
          const shapeArg = unwrapParensAndAs(args[0] as Expression | undefined);
          if (!shapeArg || !Node.isObjectLiteralExpression(shapeArg)) {
            return { typeText: "Record<string, unknown>", optional: false, nullable: false, imports: [] };
          }
          const imports: ExtractedImportRef[] = [];
          const fields: string[] = [];
          for (const prop of shapeArg.getProperties()) {
            if (!Node.isPropertyAssignment(prop)) continue;
            const rawName = prop.getName();
            const cleanName =
              (rawName.startsWith('"') && rawName.endsWith('"')) ||
              (rawName.startsWith("'") && rawName.endsWith("'"))
                ? rawName.slice(1, -1)
                : rawName;
            const valInit = prop.getInitializer();
            const parsed = valInit
              ? this.extractDslSchemaType(valInit, mode, sf, printer, visited)
              : undefined;
            if (parsed) {
              imports.push(...parsed.imports);
              const valType = parsed.nullable
                ? `${parsed.typeText} | null`
                : parsed.typeText;
              const optMark = parsed.optional ? "?" : "";
              fields.push(`${this.formatInlinePropKey(cleanName)}${optMark}: ${valType}`);
            } else {
              fields.push(`${this.formatInlinePropKey(cleanName)}: unknown`);
            }
          }
          return {
            typeText: fields.length > 0 ? `{ ${fields.join("; ")} }` : "Record<string, never>",
            optional: false,
            nullable: false,
            imports,
          };
        }
        case "union":
        case "discriminatedUnion": {
          const arrArg = unwrapParensAndAs(
            (methodName === "discriminatedUnion" ? args[1] : args[0]) as
              | Expression
              | undefined,
          );
          if (arrArg && Node.isArrayLiteralExpression(arrArg)) {
            const imports: ExtractedImportRef[] = [];
            const members: string[] = [];
            for (const el of arrArg.getElements()) {
              const parsed = this.extractDslSchemaType(el, mode, sf, printer, visited);
              if (parsed) {
                imports.push(...parsed.imports);
                members.push(this.finalizeDslType(parsed));
              }
            }
            if (members.length > 0) {
              return {
                typeText: members.join(" | "),
                optional: false,
                nullable: false,
                imports,
              };
            }
          }
          return undefined;
        }
        case "optional": {
          const inner = args[0]
            ? this.extractDslSchemaType(args[0] as Expression, mode, sf, printer, visited)
            : undefined;
          if (!inner) return undefined;
          return { ...inner, optional: true };
        }
        case "nullable": {
          const inner = args[0]
            ? this.extractDslSchemaType(args[0] as Expression, mode, sf, printer, visited)
            : undefined;
          if (!inner) return undefined;
          return { ...inner, nullable: true };
        }
        case "default": {
          const inner = args[0]
            ? this.extractDslSchemaType(args[0] as Expression, mode, sf, printer, visited)
            : undefined;
          if (!inner) return undefined;
          return { ...inner, optional: mode === "input" ? true : inner.optional };
        }
        default:
          return undefined;
      }
    }

    // Chained schema methods: `schema.optional()`, `schema.nullable()`, `schema.min(1)`, `schema.partial()`, `schema.extend({...})`, etc.
    const base = this.extractDslSchemaType(receiver, mode, sf, printer, visited);
    if (!base) return undefined;

    switch (methodName) {
      case "optional":
        return { ...base, optional: true };
      case "nullable":
        return { ...base, nullable: true };
      case "nullish":
        return { ...base, optional: true, nullable: true };
      case "default":
        return {
          ...base,
          optional: mode === "input" ? true : false,
        };
      case "array": {
        const innerText = this.finalizeDslType(base);
        const needsParens = innerText.includes(" | ") || innerText.includes(" & ");
        return {
          typeText: needsParens ? `(${innerText})[]` : `${innerText}[]`,
          optional: false,
          nullable: false,
          imports: base.imports,
        };
      }
      case "partial":
        return {
          ...base,
          typeText: `Partial<${base.typeText}>`,
        };
      case "pick":
      case "omit": {
        const arg0 = unwrapParensAndAs(args[0] as Expression | undefined);
        const keys: string[] = [];
        if (arg0 && Node.isArrayLiteralExpression(arg0)) {
          for (const el of arg0.getElements()) {
            const k = extractStringLiteral(el);
            if (k) keys.push(JSON.stringify(k));
          }
        } else if (arg0 && Node.isObjectLiteralExpression(arg0)) {
          for (const p of arg0.getProperties()) {
            if (Node.isPropertyAssignment(p)) {
              const init = p.getInitializer();
              if (init?.getKind() === SyntaxKind.TrueKeyword) {
                keys.push(JSON.stringify(p.getName().replace(/^['"]|['"]$/g, "")));
              }
            }
          }
        }
        if (keys.length > 0) {
          const util = methodName === "pick" ? "Pick" : "Omit";
          return {
            ...base,
            typeText: `${util}<${base.typeText}, ${keys.join(" | ")}>`,
          };
        }
        return base;
      }
      case "extend": {
        const extArg = unwrapParensAndAs(args[0] as Expression | undefined);
        if (extArg && Node.isObjectLiteralExpression(extArg)) {
          const imports = [...base.imports];
          const extraFields: string[] = [];
          for (const prop of extArg.getProperties()) {
            if (!Node.isPropertyAssignment(prop)) continue;
            const cleanName = prop.getName().replace(/^['"]|['"]$/g, "");
            const valInit = prop.getInitializer();
            const parsed = valInit
              ? this.extractDslSchemaType(valInit, mode, sf, printer, visited)
              : undefined;
            if (parsed) {
              imports.push(...parsed.imports);
              const valType = parsed.nullable
                ? `${parsed.typeText} | null`
                : parsed.typeText;
              extraFields.push(
                `${this.formatInlinePropKey(cleanName)}${parsed.optional ? "?" : ""}: ${valType}`,
              );
            }
          }
          if (extraFields.length > 0) {
            return {
              ...base,
              typeText: `${base.typeText} & { ${extraFields.join("; ")} }`,
              imports,
            };
          }
        }
        return base;
      }
      case "transform":
        // For `.transform()`, output type may differ from input; let Tier 2 handle exported schemas in output mode
        if (mode === "output") {
          return undefined;
        }
        return base;
      default:
        // Refinement/constraint/metadata chains (`.min()`, `.max()`, `.int()`, `.email()`, `.refine()`, `.describe()`, `.meta()`, `.strict()`, etc.)
        return base;
    }
  }

  private finalizeDslType(entry: {
    readonly typeText: string;
    readonly optional: boolean;
    readonly nullable: boolean;
  }): string {
    let text = entry.typeText;
    if (entry.nullable && !text.includes("null")) {
      text = `${text} | null`;
    }
    if (entry.optional && !text.includes("undefined")) {
      text = `${text} | undefined`;
    }
    return text;
  }

  /**
   * Infers a TypeScript input/output type from an inline or referenced Standard Schema
   * expression (`@Body(CreateUserSchema)`, `@Query(s.object(...))`, `@Param("id", IdSchema)`,
   * `@UseStandardSchema(UserResponseSchema)`, or `createSchemaDto(Schema)`).
   *
   * Tier 1: Direct zero-dep AST shape extraction for `s.*` / `z.*` / `v.*` / `createSchemaDto(...)`.
   * Tier 2: Explicit `StandardSchemaV1<In, Out>` type annotation or portable
   *         `StandardSchemaInferInput<typeof Schema>` / `StandardSchemaInferOutput<typeof Schema>`
   *         for any exported external Standard Schema (Zod, Valibot, ArkType, custom).
   */
  private inferTypeFromStandardSchemaExpr(
    rawExpr: Expression,
    mode: "input" | "output",
    sf: SourceFile,
    printer: TypePrinter,
    explicitSchemaContext: boolean,
  ): {
    readonly text: string;
    readonly optional: boolean;
    readonly imports: ExtractedImportRef[];
  } | undefined {
    const expr = unwrapParensAndAs(rawExpr);
    if (!expr) return undefined;

    // Tier 1: AST extraction of fluent DSL / `createSchemaDto(...)`
    const dsl = this.extractDslSchemaType(expr, mode, sf, printer, new Set());
    if (dsl) {
      const baseText = dsl.nullable && !dsl.typeText.includes("null")
        ? `${dsl.typeText} | null`
        : dsl.typeText;
      return {
        text: sanitizeTypeText(baseText, "unknown"),
        optional: dsl.optional,
        imports: dsl.imports,
      };
    }

    // Unwrap `new StandardSchemaValidationPipe(Schema)` for Tier 2 as well
    let candidate: Expression = expr;
    if (Node.isNewExpression(expr)) {
      const callee = expr.getExpression().getText();
      if (
        callee === "StandardSchemaValidationPipe" ||
        callee.endsWith(".StandardSchemaValidationPipe")
      ) {
        const arg0 = unwrapParensAndAs(
          expr.getArguments()[0] as Expression | undefined,
        );
        if (!arg0) return undefined;
        candidate = arg0;
        explicitSchemaContext = true;
      } else {
        return undefined;
      }
    }

    // Tier 2: Exported or annotated Standard Schema variable (Zod/Valibot/ArkType/custom StandardSchemaV1)
    if (Node.isIdentifier(candidate)) {
      const identName = candidate.getText();
      if (!explicitSchemaContext && identName.endsWith("Pipe")) {
        return undefined;
      }

      const decl = this.resolveSchemaSymbolDeclaration(candidate, sf);
      if (!decl) {
        return undefined;
      }

      // Skip plain non-schema classes (e.g. custom PipeTransform classes)
      if (Node.isClassDeclaration(decl)) {
        return undefined;
      }

      if (Node.isVariableDeclaration(decl)) {
        const typeNode = decl.getTypeNode();
        const typeText = typeNode?.getText().trim() ?? "";
        const initText = decl.getInitializer()?.getText() ?? "";
        const declType = decl.getType();
        const resolvedTypeText = declType.getText();
        const looksLikeStandardSchema =
          explicitSchemaContext ||
          typeText.includes("StandardSchema") ||
          typeText.includes("BunestSchema") ||
          typeText.includes("ZodType") ||
          typeText.includes("ZodSchema") ||
          resolvedTypeText.includes("~standard") ||
          resolvedTypeText.includes("StandardSchema") ||
          declType.getProperties().some((p) => p.getName() === "~standard") ||
          initText.includes("~standard") ||
          /^(?:s|z|v)\s*\./.test(initText.trim()) ||
          initText.includes("type(") ||
          /(?:Schema|Validator)$/i.test(identName);

        if (!looksLikeStandardSchema) {
          return undefined;
        }

        // Check explicit `StandardSchemaV1<Input, Output>` type arguments first
        const symName =
          declType.getAliasSymbol()?.getName() ?? declType.getSymbol()?.getName();
        if (
          symName === "StandardSchemaV1" ||
          symName === "BunestSchema" ||
          symName === "BaseSchema"
        ) {
          const typeArgs = declType.getTypeArguments();
          const chosen =
            mode === "output" ? (typeArgs[1] ?? typeArgs[0]) : typeArgs[0];
          if (chosen) {
            const printed = printer.printType(chosen, this.project, "unknown");
            if (printed.text !== "unknown") {
              return {
                text: printed.text,
                optional: false,
                imports: printed.imports,
              };
            }
          }
        }

        // Exported schema variable -> emit portable `StandardSchemaInferInput<typeof Schema>` / `StandardSchemaInferOutput<typeof Schema>`
        if (isDeclarationExported(decl)) {
          const declFile = decl.getSourceFile().getFilePath();
          const exportName = decl.getName();
          const ref = printer.printNamedExport(declFile, exportName);
          const helperName =
            mode === "input"
              ? "StandardSchemaInferInput"
              : "StandardSchemaInferOutput";
          return {
            text: `${helperName}<typeof ${ref.text}>`,
            optional: false,
            imports: ref.imports,
          };
        }
      }
    }

    return undefined;
  }

  private inferTypeFromUnexportedSchemaDtoParam(
    param: ParameterDeclaration,
    sf: SourceFile,
    printer: TypePrinter,
  ): { readonly text: string; readonly imports: ExtractedImportRef[] } | undefined {
    const typeNode = param.getTypeNode();
    if (!typeNode) return undefined;
    const rawName = typeNode.getText().trim().replace(/\s*\|\s*(?:undefined|null)/g, "").trim();
    if (!/^[A-Za-z_$][\w$]*$/.test(rawName)) return undefined;
    const sym = sf.getResolver().resolveIdentifierSymbol(rawName, sf, typeNode);
    const decl =
      sym?.getAliasedSymbol()?.getDeclarations()[0] ??
      sym?.getDeclarations()[0];
    if (!decl || !Node.isClassDeclaration(decl)) return undefined;
    const innerSchema = this.unwrapCreateSchemaDtoArg(decl);
    if (!innerSchema) return undefined;
    const inferred = this.inferTypeFromStandardSchemaExpr(
      innerSchema,
      "input",
      decl.getSourceFile(),
      printer,
      true,
    );
    return inferred
      ? { text: inferred.text, imports: inferred.imports }
      : undefined;
  }

  private scanRoutesInFile(
    sf: SourceFile,
    printer: TypePrinter,
    routesMap: Map<string, ExtractedRouteEntry>,
  ): void {
    const filePath = sf.getFilePath();

    for (const cls of sf.getClasses()) {
      const prefixes = this.extractControllerPrefixes(cls);
      if (!prefixes) continue;
      const controllerName = cls.getName() ?? "AnonymousController";

      for (const method of cls.getMethods()) {
        const httpRoutes = this.extractMethodHttpRoutes(method);
        if (httpRoutes.length === 0) continue;

        const handlerName = method.getName();
        const imports: ExtractedImportRef[] = [];

        // Extract @Param, @Query, @Body from parameters (with inline Standard Schema inference)
        const namedParams = new Map<
          string,
          { type: string; optional: boolean }
        >();
        let wholeParamsType: string | undefined;
        const namedQuery = new Map<
          string,
          { type: string; optional: boolean }
        >();
        let wholeQueryType: string | undefined;
        let bodyTypeText = "never";

        for (const param of method.getParameters()) {
          for (const dec of param.getDecorators()) {
            const decName = getDecoratorShortName(dec);
            if (decName !== "Param" && decName !== "Query" && decName !== "Body") {
              continue;
            }

            const { key: firstArg, schemaExpr, explicitSchemaOption } =
              this.extractParamDecoratorKeyAndSchema(dec);

            const effectiveParamType =
              param.isOptional() || param.hasInitializer()
                ? param.getType().getNonNullableType()
                : param.getType();
            const printed = printer.printType(
              effectiveParamType,
              this.project,
              "unknown",
            );

            const hasConcreteParamType =
              param.getTypeNode() !== undefined &&
              printed.text !== "unknown" &&
              printed.text !== "any";

            let resolvedText = printed.text;
            let resolvedImports: ExtractedImportRef[] = printed.imports;
            let schemaOptional = false;

            if (!hasConcreteParamType && schemaExpr) {
              const inferred = this.inferTypeFromStandardSchemaExpr(
                schemaExpr,
                "input",
                sf,
                printer,
                explicitSchemaOption,
              );
              if (inferred) {
                resolvedText = inferred.text;
                resolvedImports = inferred.imports;
                schemaOptional = inferred.optional;
              }
            } else if (!hasConcreteParamType && !schemaExpr) {
              const dtoInferred = this.inferTypeFromUnexportedSchemaDtoParam(
                param,
                sf,
                printer,
              );
              if (dtoInferred) {
                resolvedText = dtoInferred.text;
                resolvedImports = dtoInferred.imports;
              }
            }

            if (decName === "Param") {
              imports.push(...resolvedImports);
              if (firstArg) {
                namedParams.set(firstArg, {
                  type: resolvedText,
                  optional: param.isOptional() || schemaOptional,
                });
              } else {
                wholeParamsType = resolvedText;
              }
            } else if (decName === "Query") {
              imports.push(...resolvedImports);
              if (firstArg) {
                namedQuery.set(firstArg, {
                  type: resolvedText,
                  optional:
                    param.isOptional() ||
                    param.hasInitializer() ||
                    schemaOptional,
                });
              } else {
                wholeQueryType = resolvedText;
              }
            } else if (decName === "Body" && !firstArg) {
              imports.push(...resolvedImports);
              bodyTypeText = resolvedText;
            }
          }
        }

        let queryTypeText = wholeQueryType ?? "Record<string, unknown>";
        if (!wholeQueryType && namedQuery.size > 0) {
          queryTypeText = `{ ${[...namedQuery.entries()]
            .map(
              ([k, v]) =>
                `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}${v.optional ? "?" : ""}: ${v.type}`,
            )
            .join("; ")} }`;
        }

        const retType = unwrapPromiseType(method.getReturnType());
        const resPrinted = printer.printType(retType, this.project, "unknown");
        let responseTypeText = resPrinted.text;
        let responseImports: ExtractedImportRef[] = resPrinted.imports;

        const responseSchemaExpr = this.extractResponseStandardSchemaExpr(
          cls,
          method,
        );
        const hasExplicitConcreteReturnType =
          method.getReturnTypeNode() !== undefined &&
          resPrinted.text !== "unknown" &&
          resPrinted.text !== "any";

        if (responseSchemaExpr && !hasExplicitConcreteReturnType) {
          const inferredResp = this.inferTypeFromStandardSchemaExpr(
            responseSchemaExpr,
            "output",
            sf,
            printer,
            true,
          );
          if (inferredResp) {
            responseTypeText = inferredResp.optional
              ? `${inferredResp.text} | undefined`
              : inferredResp.text;
            responseImports = inferredResp.imports;
          }
        }
        imports.push(...responseImports);

        for (const prefix of prefixes) {
          for (const route of httpRoutes) {
            const fullPath = joinRoutePath(prefix, route.path);
            const key = `${route.httpMethod} ${fullPath}`;
            if (routesMap.has(key)) continue;

            const pathSegments = extractPathParamNames(fullPath);
            let paramsTypeText = "Record<string, never>";
            if (wholeParamsType) {
              paramsTypeText = wholeParamsType;
            } else if (pathSegments.length > 0 || namedParams.size > 0) {
              const allParamNames = new Set([
                ...pathSegments,
                ...namedParams.keys(),
              ]);
              const entries = [...allParamNames].map((pName) => {
                const known = namedParams.get(pName);
                const t = known ? known.type : "string";
                const opt = known?.optional ? "?" : "";
                const safeKey = /^[A-Za-z_$][\w$]*$/.test(pName)
                  ? pName
                  : JSON.stringify(pName);
                return `${safeKey}${opt}: ${t}`;
              });
              paramsTypeText = `{ ${entries.join("; ")} }`;
            }

            routesMap.set(key, {
              key,
              method: route.httpMethod,
              path: fullPath,
              paramsTypeText,
              queryTypeText,
              bodyTypeText,
              responseTypeText,
              controllerName,
              handlerName,
              sourceFile: filePath,
              location: nodeToLocation(method.getNameNode()),
              imports: [...imports],
            });
          }
        }
      }
    }
  }

  // ─── 6. CQRS Scanner (`@CommandHandler` / `@QueryHandler`) ────────────────

  private scanCqrsInFile(
    sf: SourceFile,
    printer: TypePrinter,
    commandsMap: Map<string, ExtractedCqrsCommandEntry>,
    queriesMap: Map<string, ExtractedCqrsQueryEntry>,
  ): void {
    const filePath = sf.getFilePath();

    for (const cls of sf.getClasses()) {
      for (const dec of cls.getDecorators()) {
        const shortName = getDecoratorShortName(dec);
        if (shortName !== "CommandHandler" && shortName !== "QueryHandler") {
          continue;
        }
        const targetExpr = unwrapParensAndAs(
          dec.getArguments()[0] as Expression | undefined,
        );
        if (!targetExpr || !Node.isIdentifier(targetExpr)) continue;

        const sym = targetExpr.getSymbol();
        const decl =
          sym?.getAliasedSymbol()?.getDeclarations()[0] ??
          sym?.getDeclarations()[0];
        if (
          !decl ||
          !Node.isClassDeclaration(decl) ||
          !decl.isExported() ||
          !decl.getName()
        ) {
          continue;
        }

        const targetName = decl.getName()!;
        const targetFile = decl.getSourceFile().getFilePath();
        const executeMethod = cls.getMethod("execute");
        if (!executeMethod) continue;

        const retType = unwrapPromiseType(executeMethod.getReturnType());
        const resPrinted = printer.printType(retType, this.project, "void");
        const targetRef = printer.printNamedExport(targetFile, targetName);

        if (shortName === "CommandHandler" && !commandsMap.has(targetName)) {
          commandsMap.set(targetName, {
            key: targetName,
            commandTypeText: targetRef.text,
            resultTypeText: resPrinted.text,
            sourceFile: filePath,
            location: nodeToLocation(cls.getNameNode() ?? cls),
            imports: [...targetRef.imports, ...resPrinted.imports],
          });
        } else if (
          shortName === "QueryHandler" &&
          !queriesMap.has(targetName)
        ) {
          queriesMap.set(targetName, {
            key: targetName,
            queryTypeText: targetRef.text,
            resultTypeText: resPrinted.text,
            sourceFile: filePath,
            location: nodeToLocation(cls.getNameNode() ?? cls),
            imports: [...targetRef.imports, ...resPrinted.imports],
          });
        }
      }
    }
  }

  // ─── 7. DI Token Scanner (`{ provide: "TOKEN", useClass/useValue/useFactory }`) ─

  private scanTokensInFile(
    sf: SourceFile,
    printer: TypePrinter,
    tokensMap: Map<string, ExtractedTokenEntry>,
  ): void {
    const filePath = sf.getFilePath();

    for (const obj of sf.getDescendantsOfKind(
      SyntaxKind.ObjectLiteralExpression,
    )) {
      const provideInit = getPropertyInitializer(obj, "provide");
      const tokenStr = extractStringLiteral(provideInit);
      if (!tokenStr || tokensMap.has(tokenStr)) continue;

      const useClass = unwrapParensAndAs(
        getPropertyInitializer(obj, "useClass"),
      );
      const useValue = unwrapParensAndAs(
        getPropertyInitializer(obj, "useValue"),
      );
      const useFactory = unwrapParensAndAs(
        getPropertyInitializer(obj, "useFactory"),
      );
      const useExisting = unwrapParensAndAs(
        getPropertyInitializer(obj, "useExisting"),
      );

      if (!useClass && !useValue && !useFactory && !useExisting) {
        continue;
      }

      let valueType: TsType | undefined;
      if (useClass) {
        const ctorSigs = useClass.getType().getConstructSignatures();
        valueType = ctorSigs[0]?.getReturnType();
      } else if (useFactory) {
        const callSigs = useFactory.getType().getCallSignatures();
        const ret = callSigs[0]?.getReturnType();
        valueType = ret ? unwrapPromiseType(ret) : undefined;
      } else if (useValue) {
        valueType = useValue.getType();
      } else if (useExisting) {
        const ctorSigs = useExisting.getType().getConstructSignatures();
        valueType = ctorSigs[0]?.getReturnType();
      }

      if (!valueType) continue;

      const printed = printer.printType(valueType, this.project, "unknown");
      tokensMap.set(tokenStr, {
        token: tokenStr,
        valueTypeText: printed.text,
        sourceFile: filePath,
        location: nodeToLocation(obj),
        imports: printed.imports,
      });
    }
  }

  // ─── 8. Class Macros Scanner (`@Data`, `@Value`, `@Builder`, `@WithLogger`, `@Delegate`, ...) ─

  private extractBoolProp(
    expr: Expression | undefined,
    propName: string,
  ): boolean | undefined {
    const val = unwrapParensAndAs(getPropertyInitializer(expr, propName));
    if (!val) return undefined;
    if (val.getKind() === SyntaxKind.TrueKeyword) return true;
    if (val.getKind() === SyntaxKind.FalseKeyword) return false;
    return undefined;
  }

  private extractFieldRefList(
    decoratorName: string,
    optionName: "exclude" | "include" | "mask",
    expr: Expression | undefined,
    refsOut: ExtractedMacroFieldRef[],
  ): string[] {
    const init = unwrapParensAndAs(getPropertyInitializer(expr, optionName));
    if (!init || !Node.isArrayLiteralExpression(init)) return [];
    const out: string[] = [];
    for (const el of init.getElements()) {
      if (!Node.isExpression(el)) continue;
      const val = extractStringLiteral(el);
      if (val !== undefined) {
        out.push(val);
        refsOut.push({
          decoratorName,
          optionName,
          fieldName: val,
          location: nodeToLocation(el),
        });
      }
    }
    return out;
  }

  private parseAccessorsOption(
    expr: Expression | undefined,
  ): ExtractedMacroAccessors {
    const fluent = this.extractBoolProp(expr, "fluent");
    const chain = this.extractBoolProp(expr, "chain");
    const prefixInit = getPropertyInitializer(expr, "prefix");
    const prefix = extractStringOrArrayLiterals(prefixInit);
    return {
      ...(fluent !== undefined ? { fluent } : {}),
      ...(chain !== undefined ? { chain } : {}),
      ...(prefix.length > 0 ? { prefix } : {}),
    };
  }

  private parseBaseEntityDecorator(
    entry: ResolvedDecoratorEntry | undefined,
    printer: TypePrinter,
  ): {
    readonly keyTypeText: string;
    readonly fields: ExtractedBaseEntityField[];
    readonly imports: ExtractedImportRef[];
  } {
    const typeArgNode = entry?.resolvedTypeArgNodes[0];
    const typeArgText = entry?.resolvedTypeArgTexts[0];
    const useOverride =
      Boolean(entry?.composedFrom) &&
      typeArgText !== undefined &&
      (!typeArgNode || typeArgNode.getText().trim() !== typeArgText);

    const parsed = parseBaseEntityDecoratorAst({
      decorator: entry?.sourceDecorator,
      arg0: entry?.resolvedArgs[0],
      typeArgNode,
      ...(useOverride ? { keyTypeOverride: typeArgText } : {}),
      formatTypeArg: (node) => {
        const safeRaw = sanitizeTypeText(node.getText().trim(), "number");
        const printed = printer.printType(
          node.getType(),
          this.project,
          safeRaw,
        );
        return {
          text: sanitizeTypeText(printed.text, safeRaw),
          imports: printed.imports,
        };
      },
    });
    return {
      keyTypeText: parsed.keyTypeText,
      fields: [...parsed.fields],
      imports: [...parsed.imports],
    };
  }

  private parseDeclarativeRepositoryDecorator(
    entry: ResolvedDecoratorEntry | undefined,
    sf: SourceFile,
    printer: TypePrinter,
  ): {
    readonly entityTypeText: string;
    readonly keyTypeText: string;
    readonly imports: ExtractedImportRef[];
  } {
    const imports: ExtractedImportRef[] = [];
    let entityTypeText = "Record<string, unknown>";
    let keyTypeText = "number";

    const typeArg0 = entry?.resolvedTypeArgNodes[0];
    const typeArg1 = entry?.resolvedTypeArgNodes[1];

    if (typeArg0) {
      const safeRaw = sanitizeTypeText(
        typeArg0.getText().trim(),
        "Record<string, unknown>",
      );
      const printed = printer.printType(
        typeArg0.getType(),
        this.project,
        safeRaw,
      );
      entityTypeText = sanitizeTypeText(printed.text, safeRaw);
      imports.push(...printed.imports);
    } else if (entry?.resolvedArgs[0]) {
      const arg0 = entry.resolvedArgs[0];
      let entityExpr: Expression | undefined;
      if (Node.isIdentifier(arg0)) {
        entityExpr = arg0;
      } else if (Node.isObjectLiteralExpression(arg0)) {
        entityExpr = getPropertyInitializer(arg0, "entity");
      }
      if (entityExpr && Node.isIdentifier(entityExpr)) {
        const identName = entityExpr.getText().trim();
        const ctorSigs = entityExpr.getType().getConstructSignatures();
        if (ctorSigs.length > 0 && ctorSigs[0]) {
          const printed = printer.printType(
            ctorSigs[0].getReturnType(),
            this.project,
            identName,
          );
          entityTypeText = sanitizeTypeText(printed.text, identName);
          imports.push(...printed.imports);
        } else {
          entityTypeText = sanitizeTypeText(identName, "Record<string, unknown>");
          // Fallback: resolve import from source file declarations
          const localClass = sf.getClass(identName);
          if (localClass && localClass.isExported()) {
            imports.push({
              filePath: sf.getFilePath(),
              exportName: identName,
              isTypeOnly: true,
            });
          } else {
            for (const impDecl of sf.getImportDeclarations()) {
              const named = impDecl
                .getNamedImports()
                .find((n) => (n.getAliasNode()?.getText() ?? n.getName()) === identName);
              if (named) {
                const rawSpec = impDecl.getModuleSpecifierValue();
                const resolvedFilePath = rawSpec.startsWith(".")
                  ? resolve(dirname(sf.getFilePath()), rawSpec)
                  : rawSpec;
                imports.push({
                  filePath: resolvedFilePath,
                  exportName: named.getName(),
                  ...(named.getAliasNode() ? { alias: identName } : {}),
                  isTypeOnly: true,
                });
                break;
              }
            }
          }
        }
      }
    }

    if (typeArg1) {
      const safeRaw = sanitizeTypeText(typeArg1.getText().trim(), "number");
      const printed = printer.printType(
        typeArg1.getType(),
        this.project,
        safeRaw,
      );
      keyTypeText = sanitizeTypeText(printed.text, safeRaw);
      imports.push(...printed.imports);
    }

    return {
      entityTypeText,
      keyTypeText,
      imports,
    };
  }

  private getFullDecoratorName(dec: Decorator): string {
    const expr = dec.getExpression();
    if (Node.isCallExpression(expr)) {
      return expr.getExpression().getText();
    }
    return expr.getText();
  }

  private collectInheritanceChain(cls: ClassDeclaration): ClassDeclaration[] {
    const chain: ClassDeclaration[] = [];
    const visited = new Set<ClassDeclaration>();
    let current: ClassDeclaration | undefined = cls;
    while (current && !visited.has(current)) {
      visited.add(current);
      chain.unshift(current);
      current = current.getBaseClass();
    }
    return chain;
  }

  private inspectCollectionType(
    tsType: TsType,
    printer: TypePrinter,
  ): {
    kind?: "array" | "set" | "map";
    itemTypeText?: string;
    keyTypeText?: string;
    valueTypeText?: string;
    imports: ExtractedImportRef[];
  } {
    const nonNullable = tsType.getNonNullableType();
    if (nonNullable.isArray()) {
      const elem = nonNullable.getArrayElementType();
      if (elem) {
        const printed = printer.printType(elem, this.project, "unknown");
        return {
          kind: "array",
          itemTypeText: printed.text,
          imports: printed.imports,
        };
      }
    }
    const symName = nonNullable.getSymbol()?.getName();
    if (symName === "Array" || symName === "ReadonlyArray") {
      const arg = nonNullable.getTypeArguments()[0];
      const printed = arg
        ? printer.printType(arg, this.project, "unknown")
        : { text: "unknown", imports: [] };
      return {
        kind: "array",
        itemTypeText: printed.text,
        imports: printed.imports,
      };
    }
    if (symName === "Set" || symName === "ReadonlySet") {
      const arg = nonNullable.getTypeArguments()[0];
      const printed = arg
        ? printer.printType(arg, this.project, "unknown")
        : { text: "unknown", imports: [] };
      return {
        kind: "set",
        itemTypeText: printed.text,
        imports: printed.imports,
      };
    }
    if (symName === "Map" || symName === "ReadonlyMap") {
      const args = nonNullable.getTypeArguments();
      const kPrinted = args[0]
        ? printer.printType(args[0], this.project, "unknown")
        : { text: "unknown", imports: [] };
      const vPrinted = args[1]
        ? printer.printType(args[1], this.project, "unknown")
        : { text: "unknown", imports: [] };
      return {
        kind: "map",
        keyTypeText: kPrinted.text,
        valueTypeText: vPrinted.text,
        imports: [...kPrinted.imports, ...vPrinted.imports],
      };
    }
    return { imports: [] };
  }

  private resolveEffectiveMacroConfig(): {
    readonly defaults: GlobalMacroDefaultsLike;
    readonly presets: Readonly<Record<string, readonly string[]>>;
    readonly customMacros: Map<string, CustomMacroDefinitionLike<any>>;
  } {
    const defaults = getGlobalMacroDefaultsSnapshot(
      this.macroDefaults ?? this.bunestConfig?.macros?.defaults,
    );
    const presets: Record<string, readonly string[]> = {
      ...(this.bunestConfig?.macros?.presets ?? {}),
      ...(this.macroPresets ?? {}),
    };
    const customMacros = collectCustomMacros(
      this.bunestConfig,
      this.customMacros,
    );
    return { defaults, presets, customMacros };
  }

  private expandMacroNames(
    initialNames: readonly string[],
    presets: Readonly<Record<string, readonly string[]>>,
    customMacros: ReadonlyMap<string, CustomMacroDefinitionLike<any>>,
  ): {
    readonly expandedBuiltins: Set<string>;
    readonly expandedPresets: string[];
    readonly matchedCustomDefs: CustomMacroDefinitionLike<any>[];
  } {
    const expandedBuiltins = new Set<string>();
    const expandedPresets: string[] = [];
    const matchedCustomDefs: CustomMacroDefinitionLike<any>[] = [];
    const visited = new Set<string>();

    const visit = (name: string): void => {
      if (visited.has(name)) return;
      visited.add(name);

      if (CLASS_MACRO_DECORATORS.has(name)) {
        expandedBuiltins.add(name);
      }

      const presetTargets = presets[name];
      if (presetTargets && presetTargets.length > 0) {
        expandedPresets.push(name);
        for (const sub of presetTargets) {
          visit(sub);
        }
      }

      const customDef = customMacros.get(name);
      if (customDef) {
        matchedCustomDefs.push(customDef);
        if (customDef.composedNames && customDef.composedNames.length > 0) {
          if (!expandedPresets.includes(name)) {
            expandedPresets.push(name);
          }
          for (const sub of customDef.composedNames) {
            visit(sub);
          }
        }
      }
    };

    for (const n of initialNames) {
      visit(n);
    }

    return { expandedBuiltins, expandedPresets, matchedCustomDefs };
  }

  private scanInjectableLoggersInFile(
    sf: SourceFile,
    out: ExtractedInjectableLoggerEntry[],
  ): void {
    const filePath = sf.getFilePath();
    for (const cls of sf.getClasses()) {
      if (!cls.isExported()) continue;
      const className = cls.getName();
      if (!className) continue;

      const hasAutoLoggerDecorator = cls
        .getDecorators()
        .some((d) => {
          const name = getDecoratorShortName(d);
          return (
            name === "Injectable" ||
            name === "Controller" ||
            name === "Module" ||
            name === "AutoModule"
          );
        });
      if (!hasAutoLoggerDecorator) continue;

      const hasOwnLoggerProp = cls
        .getProperties()
        .some((p) => p.getName() === "logger");
      if (hasOwnLoggerProp) continue;

      const hasOwnLoggerMethodOrGetter = cls
        .getMethods()
        .some((m) => m.getName() === "logger");
      if (hasOwnLoggerMethodOrGetter) continue;

      const hasOwnLoggerParam = cls.getConstructors().some((ctor) =>
        ctor
          .getParameters()
          .some(
            (param) =>
              param.getName() === "logger" &&
              /\b(public|private|protected|readonly)\b/.test(param.getText()),
          ),
      );
      if (hasOwnLoggerParam) continue;

      out.push({ className, sourceFile: filePath });
    }
  }

  private scanClassMacrosInFile(
    sf: SourceFile,
    printer: TypePrinter,
    out: ExtractedClassMacroEntry[],
  ): void {
    const filePath = sf.getFilePath();
    const { defaults, presets, customMacros } =
      this.resolveEffectiveMacroConfig();

    for (const cls of sf.getClasses()) {
      const className = cls.getName();
      if (!className) continue;

      const baseClassName = cls.getExtends()?.getExpression().getText() ?? "";
      const extendsCrudRepository = baseClassName === "CrudRepository";

      const resolvedClassDecs = resolveComposedDecorators(cls);
      const classDecNames: string[] = [];
      const classDecMap = new Map<string, ResolvedDecoratorEntry>();
      let repoDecEntry: ResolvedDecoratorEntry | undefined;
      for (const entry of resolvedClassDecs) {
        const short = entry.name;
        if (REPOSITORY_CLASS_DECORATORS.has(short) && !repoDecEntry) {
          repoDecEntry = entry;
        }
        if (
          CLASS_MACRO_DECORATORS.has(short) ||
          Object.prototype.hasOwnProperty.call(presets, short) ||
          customMacros.has(short)
        ) {
          if (!classDecNames.includes(short)) {
            classDecNames.push(short);
          }
          if (!classDecMap.has(short) || !entry.composedFrom) {
            classDecMap.set(short, entry);
          }
        }
      }

      const isDeclarativeRepository =
        !extendsCrudRepository && repoDecEntry !== undefined;

      const hasFieldMacro = cls.getProperties().some((p) =>
        p.getDecorators().some((d) => {
          const full = this.getFullDecoratorName(d);
          const short = getDecoratorShortName(d);
          return (
            FIELD_MACRO_DECORATORS.has(full) ||
            FIELD_MACRO_DECORATORS.has(short)
          );
        }),
      );

      if (
        classDecNames.length === 0 &&
        !hasFieldMacro &&
        !isDeclarativeRepository
      ) {
        continue;
      }

      const { expandedBuiltins, expandedPresets, matchedCustomDefs } =
        this.expandMacroNames(classDecNames, presets, customMacros);

      const imports: ExtractedImportRef[] = [];
      const fieldReferences: ExtractedMacroFieldRef[] = [];
      const maskFields: string[] = [];

      const getArg0 = (decName: string): Expression | undefined =>
        classDecMap.get(decName)?.resolvedArgs[0];

      const isData = expandedBuiltins.has("Data");
      const isValue = expandedBuiltins.has("Value");
      const isBuilder = expandedBuiltins.has("Builder");
      const isSuperBuilder = expandedBuiltins.has("SuperBuilder");
      const isGetter = expandedBuiltins.has("Getter");
      const isSetter = expandedBuiltins.has("Setter");
      const isWith = expandedBuiltins.has("With");
      const isWithBy = expandedBuiltins.has("WithBy");
      const isToString = expandedBuiltins.has("ToString");
      const isEqualsAndHashCode = expandedBuiltins.has("EqualsAndHashCode");
      const isJsonSerializable = expandedBuiltins.has("JsonSerializable");
      const isFieldNameConstants = expandedBuiltins.has("FieldNameConstants");
      const isWithLogger = expandedBuiltins.has("WithLogger");
      const isStandardException = expandedBuiltins.has("StandardException");
      const isUtilityClass = expandedBuiltins.has("UtilityClass");
      const isBaseEntity = expandedBuiltins.has("BaseEntity");

      // Parse options (inheriting project-wide GlobalMacroDefaults where per-class options omit a setting)
      const normalizeDefaultAccessors = (
        raw?: GlobalMacroDefaultsLike["accessors"],
      ): ExtractedMacroAccessors => {
        if (!raw) return {};
        const prefix = raw.prefix ? toArray(raw.prefix) : undefined;
        return {
          ...(raw.fluent !== undefined ? { fluent: raw.fluent } : {}),
          ...(raw.chain !== undefined ? { chain: raw.chain } : {}),
          ...(prefix && prefix.length > 0 ? { prefix } : {}),
        };
      };

      let accessors: ExtractedMacroAccessors = {
        ...normalizeDefaultAccessors(defaults.accessors),
        ...(isData ? normalizeDefaultAccessors(defaults.data?.accessors) : {}),
        ...(isValue ? normalizeDefaultAccessors(defaults.value?.accessors) : {}),
      };
      if (classDecMap.has("Accessors")) {
        accessors = {
          ...accessors,
          ...this.parseAccessorsOption(getArg0("Accessors")),
        };
      }
      if (isData) {
        const arg0 = getArg0("Data");
        const accExpr = getPropertyInitializer(arg0, "accessors");
        if (accExpr) {
          accessors = { ...accessors, ...this.parseAccessorsOption(accExpr) };
        }
        this.extractFieldRefList("Data", "exclude", arg0, fieldReferences);
        maskFields.push(
          ...(defaults.data?.mask ?? []),
          ...this.extractFieldRefList("Data", "mask", arg0, fieldReferences),
        );
        const tsExpr =
          getPropertyInitializer(arg0, "toStringOptions") ??
          getPropertyInitializer(arg0, "toString");
        if (tsExpr) {
          this.extractFieldRefList("Data", "exclude", tsExpr, fieldReferences);
          this.extractFieldRefList("Data", "include", tsExpr, fieldReferences);
          maskFields.push(
            ...this.extractFieldRefList("Data", "mask", tsExpr, fieldReferences),
          );
        }
        const eqExpr = getPropertyInitializer(arg0, "equalsAndHashCode");
        if (eqExpr) {
          this.extractFieldRefList("Data", "exclude", eqExpr, fieldReferences);
          this.extractFieldRefList("Data", "include", eqExpr, fieldReferences);
        }
      }
      if (isValue) {
        const arg0 = getArg0("Value");
        const accExpr = getPropertyInitializer(arg0, "accessors");
        if (accExpr) {
          accessors = { ...accessors, ...this.parseAccessorsOption(accExpr) };
        }
        this.extractFieldRefList("Value", "exclude", arg0, fieldReferences);
        maskFields.push(
          ...(defaults.value?.mask ?? []),
          ...this.extractFieldRefList("Value", "mask", arg0, fieldReferences),
        );
      }
      if (isToString) {
        const arg0 = getArg0("ToString");
        this.extractFieldRefList("ToString", "exclude", arg0, fieldReferences);
        this.extractFieldRefList("ToString", "include", arg0, fieldReferences);
        const defaultToStringMask =
          (typeof defaults.toString === "object" && defaults.toString !== null
            ? defaults.toString.mask
            : undefined) ?? defaults.toStringOptions?.mask;
        maskFields.push(
          ...(defaultToStringMask ?? []),
          ...this.extractFieldRefList("ToString", "mask", arg0, fieldReferences),
        );
      }
      if (isEqualsAndHashCode) {
        const arg0 = getArg0("EqualsAndHashCode");
        this.extractFieldRefList("EqualsAndHashCode", "exclude", arg0, fieldReferences);
        this.extractFieldRefList("EqualsAndHashCode", "include", arg0, fieldReferences);
      }
      if (isJsonSerializable) {
        const arg0 = getArg0("JsonSerializable");
        this.extractFieldRefList("JsonSerializable", "exclude", arg0, fieldReferences);
      }

      const builderArg = getArg0("SuperBuilder") ?? getArg0("Builder");
      const toBuilder =
        this.extractBoolProp(builderArg, "toBuilder") ??
        defaults.builder?.toBuilder ??
        false;
      const builderMethodName =
        extractStringLiteral(
          getPropertyInitializer(builderArg, "builderMethodName"),
        ) ??
        defaults.builder?.builderMethodName ??
        "builder";
      const buildMethodName =
        extractStringLiteral(
          getPropertyInitializer(builderArg, "buildMethodName"),
        ) ??
        defaults.builder?.buildMethodName ??
        "build";
      const setterPrefix =
        extractStringLiteral(
          getPropertyInitializer(builderArg, "setterPrefix"),
        ) ??
        defaults.builder?.setterPrefix ??
        "";

      const fcArg = getArg0("FieldNameConstants");
      const fieldConstantsInnerName =
        extractStringLiteral(getPropertyInitializer(fcArg, "innerName")) ??
        defaults.fieldNameConstants?.innerName ??
        "Fields";
      const fieldConstantsUppercase =
        this.extractBoolProp(fcArg, "uppercase") ??
        defaults.fieldNameConstants?.uppercase ??
        false;
      const fieldConstantsOnlyExplicit =
        this.extractBoolProp(fcArg, "onlyExplicitlyIncluded") ??
        defaults.fieldNameConstants?.onlyExplicitlyIncluded ??
        false;

      const loggerArg = getArg0("WithLogger");
      const loggerContext =
        extractStringLiteral(loggerArg) ??
        extractStringLiteral(getPropertyInitializer(loggerArg, "context")) ??
        defaults.withLogger?.context ??
        className;
      const loggerPropertyName =
        extractStringLiteral(
          getPropertyInitializer(loggerArg, "propertyName"),
        ) ??
        defaults.withLogger?.propertyName ??
        "logger";

      const explicitAccessorsEnabled = this.extractBoolProp(
        getArg0("Data"),
        "accessorsEnabled",
      );
      const accessorsEnabled =
        !isData ||
        (explicitAccessorsEnabled ?? defaults.data?.accessorsEnabled) !== false;

      const ownMethodNames = cls
        .getMethods()
        .filter((m) => !m.isStatic())
        .map((m) => m.getName());
      const ownPropertyNames = cls
        .getProperties()
        .filter((p) => !p.isStatic())
        .map((p) => p.getName());

      // Collect own + inherited properties (for @SuperBuilder/@Builder/inheritance)
      const chain = this.collectInheritanceChain(cls);
      const fieldsByName = new Map<string, ExtractedMacroField>();
      const delegates: ExtractedDelegateInfo[] = [];

      for (const curCls of chain) {
        const inherited = curCls !== cls;
        for (const prop of curCls.getProperties()) {
          if (prop.isStatic()) continue;
          const propName = prop.getName();
          const propDecs = prop.getDecorators();

          let hasDefault = prop.hasInitializer();
          let isSecret = false;
          let secretOmitFromJson = true;
          let toStringInclude = false;
          let toStringExclude = false;
          let equalsInclude = false;
          let equalsExclude = false;
          let fieldConstantInclude = false;
          let fieldConstantExclude = false;
          let hasGetter = false;
          let hasSetter = false;
          let hasWith = false;
          let hasWithBy = false;
          let isNonFinal = false;
          let isSingular = false;
          let singularName: string | undefined;

          for (const d of propDecs) {
            const full = this.getFullDecoratorName(d);
            const short = getDecoratorShortName(d);
            const dArg0 = d.getArguments()[0] as Expression | undefined;

            if (full.endsWith("Builder.Default")) hasDefault = true;
            else if (short === "Secret") {
              isSecret = true;
              const omit = this.extractBoolProp(dArg0, "omitFromJson");
              if (omit !== undefined) secretOmitFromJson = omit;
            } else if (full.endsWith("ToString.Include")) toStringInclude = true;
            else if (full.endsWith("ToString.Exclude")) toStringExclude = true;
            else if (full.endsWith("EqualsAndHashCode.Include")) equalsInclude = true;
            else if (full.endsWith("EqualsAndHashCode.Exclude")) equalsExclude = true;
            else if (full.endsWith("FieldNameConstants.Include")) fieldConstantInclude = true;
            else if (full.endsWith("FieldNameConstants.Exclude")) fieldConstantExclude = true;
            else if (short === "Getter") hasGetter = true;
            else if (short === "Setter") hasSetter = true;
            else if (short === "With") hasWith = true;
            else if (short === "WithBy") hasWithBy = true;
            else if (short === "NonFinal") isNonFinal = true;
            else if (short === "Singular") {
              isSingular = true;
              singularName = extractStringLiteral(dArg0);
            } else if (short === "Delegate" && !inherited) {
              const excludes = new Set([
                "constructor",
                ...extractStringOrArrayLiterals(
                  getPropertyInitializer(dArg0, "excludes"),
                ),
              ]);
              const propType = prop.getType();
              const isPrimitive =
                propType.isString() ||
                propType.isNumber() ||
                propType.isBoolean() ||
                propType.isUndefined() ||
                propType.isNull() ||
                propType.isAny() ||
                propType.isUnknown();

              const targetSym = propType.getSymbol();
              const targetDecl = targetSym?.getDeclarations()[0];
              const targetLocation = targetDecl
                ? nodeToLocation(targetDecl)
                : undefined;

              const delMembers: Array<{
                name: string;
                signatureText: string;
                imports: ExtractedImportRef[];
              }> = [];

              if (!isPrimitive) {
                for (const pSym of propType.getProperties()) {
                  const mName = pSym.getName();
                  if (excludes.has(mName) || mName.startsWith("_")) continue;
                  const mDecl =
                    pSym.getValueDeclaration() ?? pSym.getDeclarations()[0];
                  if (!mDecl) continue;
                  const mType = pSym.getTypeAtLocation(mDecl);
                  const sigs = mType.getCallSignatures();
                  if (sigs.length === 0) continue;
                  const sig = sigs[0]!;
                  const memImports: ExtractedImportRef[] = [];
                  const paramTexts = sig.getParameters().map((paramSym) => {
                    const pDecl = paramSym.getValueDeclaration();
                    const pType = pDecl
                      ? paramSym.getTypeAtLocation(pDecl)
                      : sig.getReturnType();
                    const printed = printer.printType(
                      pType,
                      this.project,
                      "unknown",
                    );
                    memImports.push(...printed.imports);
                    const opt = paramSym.isOptional() ? "?" : "";
                    return `${paramSym.getName()}${opt}: ${printed.text}`;
                  });
                  const retPrinted = printer.printType(
                    sig.getReturnType(),
                    this.project,
                    "unknown",
                  );
                  memImports.push(...retPrinted.imports);
                  imports.push(...memImports);
                  delMembers.push({
                    name: mName,
                    signatureText: `(${paramTexts.join(", ")}): ${retPrinted.text}`,
                    imports: memImports,
                  });
                }
              }

              delegates.push({
                propertyName: propName,
                targetTypeName: targetSym?.getName() ?? propType.getText(),
                targetLocation,
                excludes: [...excludes],
                resolved: !isPrimitive && delMembers.length > 0,
                location: nodeToLocation(prop.getNameNode()),
                members: delMembers,
              });
            }
          }

          const propType = prop.getType();
          const printedType = printer.printType(
            prop.hasQuestionToken() ? propType.getNonNullableType() : propType,
            this.project,
            "unknown",
          );
          imports.push(...printedType.imports);

          let collectionKind: "array" | "set" | "map" | undefined;
          let collectionItemTypeText: string | undefined;
          let collectionKeyTypeText: string | undefined;
          let collectionValueTypeText: string | undefined;
          if (isSingular) {
            const colInfo = this.inspectCollectionType(propType, printer);
            collectionKind = colInfo.kind;
            collectionItemTypeText = colInfo.itemTypeText;
            collectionKeyTypeText = colInfo.keyTypeText;
            collectionValueTypeText = colInfo.valueTypeText;
            imports.push(...colInfo.imports);
          }

          fieldsByName.set(propName, {
            name: propName,
            typeText: printedType.text,
            optional: prop.hasQuestionToken(),
            hasDefault,
            isReadonly: prop.isReadonly(),
            isNonFinal,
            isSecret,
            secretOmitFromJson,
            toStringInclude,
            toStringExclude,
            equalsInclude,
            equalsExclude,
            fieldConstantInclude,
            fieldConstantExclude,
            hasGetter,
            hasSetter,
            hasWith,
            hasWithBy,
            isSingular,
            singularName,
            collectionKind,
            collectionItemTypeText,
            collectionKeyTypeText,
            collectionValueTypeText,
            inherited,
            location: nodeToLocation(prop.getNameNode()),
            imports: printedType.imports,
          });
        }
      }

      let baseEntityKeyType: string | undefined;
      let baseEntityFields: ExtractedBaseEntityField[] | undefined;

      let repositoryEntityType: string | undefined;
      let repositoryKeyType: string | undefined;
      if (isDeclarativeRepository) {
        const parsedRepo = this.parseDeclarativeRepositoryDecorator(
          repoDecEntry,
          sf,
          printer,
        );
        repositoryEntityType = parsedRepo.entityTypeText;
        repositoryKeyType = parsedRepo.keyTypeText;
        imports.push(...parsedRepo.imports);
      }

      if (isBaseEntity) {
        const baseEntry = classDecMap.get("BaseEntity");
        const parsedBase = this.parseBaseEntityDecorator(baseEntry, printer);
        baseEntityKeyType = parsedBase.keyTypeText;
        baseEntityFields = parsedBase.fields;
        imports.push(...parsedBase.imports);

        const baseLoc = baseEntry
          ? nodeToLocation(baseEntry.sourceDecorator)
          : nodeToLocation(cls.getNameNode() ?? cls);

        const makeSyntheticMacroField = (
          bf: ExtractedBaseEntityField,
        ): ExtractedMacroField => ({
          name: bf.name,
          typeText: bf.typeText,
          optional: bf.optional,
          hasDefault: true,
          isReadonly: false,
          isNonFinal: false,
          isSecret: false,
          secretOmitFromJson: true,
          toStringInclude: false,
          toStringExclude: false,
          equalsInclude: false,
          equalsExclude: false,
          fieldConstantInclude: false,
          fieldConstantExclude: false,
          hasGetter: false,
          hasSetter: false,
          hasWith: false,
          hasWithBy: false,
          isSingular: false,
          inherited: false,
          location: baseLoc,
          imports: [],
        });

        // Prepend `id` before user-declared fields, append `createdAt` / `updatedAt` / `deletedAt` after
        const idField = parsedBase.fields.find((f) => f.role === "id");
        if (idField && !fieldsByName.has(idField.name)) {
          const reordered = new Map<string, ExtractedMacroField>();
          reordered.set(idField.name, makeSyntheticMacroField(idField));
          for (const [k, v] of fieldsByName.entries()) {
            reordered.set(k, v);
          }
          fieldsByName.clear();
          for (const [k, v] of reordered.entries()) {
            fieldsByName.set(k, v);
          }
        }
        for (const bf of parsedBase.fields) {
          if (bf.role === "id") continue;
          if (!fieldsByName.has(bf.name)) {
            fieldsByName.set(bf.name, makeSyntheticMacroField(bf));
          }
        }
      }

      const collectedFields = [...fieldsByName.values()];
      const customMembersMap = new Map<string, ExtractedCustomMacroMember>();
      const customMacroRefs: ExtractedCustomMacroRef[] = [];

      for (const def of matchedCustomDefs) {
        const arg0 = getArg0(def.name);
        const parsedOpt = extractStaticJsonValue(arg0);
        const decOptions = parsedOpt.ok ? parsedOpt.value : undefined;
        customMacroRefs.push({
          name: def.name,
          ...(def.composedNames ? { composedNames: def.composedNames } : {}),
          ...(decOptions !== undefined ? { options: decOptions } : {}),
        });

        const srcDec = `@${def.name}`;
        for (const f of def.fields ?? []) {
          const sig = `${f.readonly ? "readonly " : ""}${f.name}${f.optional ? "?" : ""}: ${f.type}`;
          customMembersMap.set(`instance:${f.name}`, {
            kind: "instance",
            name: f.name,
            signature: sig,
            sourceDecorator: srcDec,
          });
        }
        for (const [mName, mSpec] of Object.entries(def.methods ?? {})) {
          customMembersMap.set(`instance:${mName}`, {
            kind: "instance",
            name: mName,
            signature: formatCustomMemberSignature(mName, mSpec.signature),
            sourceDecorator: srcDec,
          });
        }
        for (const [sName, sSpec] of Object.entries(def.statics ?? {})) {
          customMembersMap.set(`static:${sName}`, {
            kind: "static",
            name: sName,
            signature: formatCustomMemberSignature(sName, sSpec.signature),
            sourceDecorator: srcDec,
          });
        }
        if (typeof def.typegen === "function") {
          try {
            const generated = def.typegen({
              className,
              fields: collectedFields.map((f) => ({
                name: f.name,
                typeText: f.typeText,
                optional: f.optional,
                isReadonly: f.isReadonly,
              })),
              options: decOptions,
              decorators: classDecNames,
            });
            for (const g of generated ?? []) {
              if (!g || typeof g.name !== "string" || !g.signature) continue;
              customMembersMap.set(`${g.kind}:${g.name}`, {
                kind: g.kind,
                name: g.name,
                signature: formatCustomMemberSignature(g.name, g.signature),
                sourceDecorator: g.sourceDecorator ?? srcDec,
              });
            }
          } catch {
            // Do not crash scanning if a user typegen hook throws on incomplete AST
          }
        }
      }

      const customMembers = [...customMembersMap.values()];

      out.push({
        className,
        isExported: cls.isExported(),
        sourceFile: filePath,
        location: nodeToLocation(cls.getNameNode() ?? cls),
        decorators: classDecNames,
        fields: collectedFields,
        ownMethodNames,
        ownPropertyNames,
        delegates,
        fieldReferences,
        accessors,
        isData,
        isValue,
        isBuilder,
        isSuperBuilder,
        toBuilder,
        builderMethodName,
        buildMethodName,
        setterPrefix,
        isGetter,
        isSetter,
        isWith,
        isWithBy,
        isToString,
        isEqualsAndHashCode,
        isJsonSerializable,
        isFieldNameConstants,
        fieldConstantsInnerName,
        fieldConstantsUppercase,
        fieldConstantsOnlyExplicit,
        isWithLogger,
        loggerPropertyName,
        loggerContext,
        isStandardException,
        isUtilityClass,
        ...(isBaseEntity
          ? {
              isBaseEntity: true,
              baseEntityKeyType,
              baseEntityFields,
            }
          : {}),
        ...(isDeclarativeRepository
          ? {
              isDeclarativeRepository: true,
              repositoryEntityType,
              repositoryKeyType,
            }
          : {}),
        accessorsEnabled,
        maskFields,
        ...(customMembers.length > 0 ? { customMembers } : {}),
        ...(customMacroRefs.length > 0 ? { customMacros: customMacroRefs } : {}),
        ...(expandedPresets.length > 0 ? { expandedPresets } : {}),
        imports,
      });
    }
  }

  // ─── 9. Call-Site Scanner (Cross-Jump References for VS Code Extension) ───

  private scanCallSitesInFile(
    sf: SourceFile,
    callSites: ExtractedCallSite[],
  ): void {
    // 9a. Decorator call sites (@InjectModel, @InjectConnection, @InjectConfig, @ConfigValue, @Inject, @OnEvent, @EmitEvent)
    for (const dec of sf.getDescendantsOfKind(SyntaxKind.Decorator)) {
      const short = getDecoratorShortName(dec);
      const args = dec.getArguments();
      const arg0 = args[0] as Expression | undefined;
      const arg1 = args[1] as Expression | undefined;

      if (short === "InjectModel") {
        const modelName = this.resolveModelNameExpr(arg0);
        if (modelName && arg0) {
          callSites.push({
            kind: "model",
            key: modelName,
            location: nodeToLocation(arg0),
            context: "@InjectModel",
          });
        }
        const connName = extractStringLiteral(arg1);
        if (connName && arg1) {
          callSites.push({
            kind: "connection",
            key: connName,
            location: nodeToLocation(arg1),
            context: "@InjectModel",
          });
        }
      } else if (short === "InjectConnection") {
        const connName = extractStringLiteral(arg0);
        if (connName && arg0) {
          callSites.push({
            kind: "connection",
            key: connName,
            location: nodeToLocation(arg0),
            context: "@InjectConnection",
          });
        }
      } else if (short === "InjectConfig" || short === "ConfigValue") {
        const cfgKey = extractStringLiteral(arg0);
        if (cfgKey && arg0) {
          callSites.push({
            kind: "config",
            key: cfgKey,
            location: nodeToLocation(arg0),
            context: `@${short}`,
          });
        }
      } else if (short === "Inject") {
        const token = extractStringLiteral(arg0);
        if (token && arg0) {
          callSites.push({
            kind: "token",
            key: token,
            location: nodeToLocation(arg0),
            context: "@Inject",
          });
        }
      } else if (short === "OnEvent" || short === "EmitEvent") {
        const names = extractStringOrArrayLiterals(arg0);
        if (arg0) {
          for (const ev of names) {
            callSites.push({
              kind: "event",
              key: ev,
              location: nodeToLocation(arg0),
              context: `@${short}`,
            });
          }
        }
      }
    }

    // 9b. Method call sites (eventEmitter.emit, client.send, configService.get, commandBus.execute, moduleRef.get)
    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const expr = call.getExpression();
      if (!Node.isPropertyAccessExpression(expr)) continue;
      const methodName = expr.getName();
      const receiverText = expr.getExpression().getText().toLowerCase();
      const arg0 = call.getArguments()[0] as Expression | undefined;
      if (!arg0) continue;

      if (
        (methodName === "emit" ||
          methodName === "emitAsync" ||
          methodName === "on" ||
          methodName === "once" ||
          methodName === "waitFor") &&
        (receiverText.includes("event") || receiverText.includes("emitter"))
      ) {
        const ev = extractStringLiteral(arg0);
        if (ev) {
          callSites.push({
            kind: "event",
            key: ev,
            location: nodeToLocation(arg0),
            context: `.${methodName}()`,
          });
        }
      } else if (
        (methodName === "send" || methodName === "emit") &&
        (receiverText.includes("client") ||
          receiverText.includes("proxy") ||
          receiverText.includes("rpc") ||
          receiverText.includes("microservice"))
      ) {
        const keys = extractPatternKeys(arg0);
        for (const k of keys) {
          callSites.push({
            kind: methodName === "send" ? "messagePattern" : "eventPattern",
            key: k,
            location: nodeToLocation(arg0),
            context: `.${methodName}()`,
          });
        }
      } else if (
        (methodName === "get" || methodName === "getOrThrow") &&
        receiverText.includes("config")
      ) {
        const cfgKey = extractStringLiteral(arg0);
        if (cfgKey) {
          callSites.push({
            kind: "config",
            key: cfgKey,
            location: nodeToLocation(arg0),
            context: `.${methodName}()`,
          });
        }
      } else if (
        (methodName === "get" || methodName === "resolve") &&
        (receiverText.includes("moduleref") || receiverText.includes("app"))
      ) {
        const token = extractStringLiteral(arg0);
        if (token) {
          callSites.push({
            kind: "token",
            key: token,
            location: nodeToLocation(arg0),
            context: `.${methodName}()`,
          });
        }
      } else if (methodName === "execute") {
        const unwrapped = unwrapParensAndAs(arg0);
        if (unwrapped && Node.isNewExpression(unwrapped)) {
          const ctorName = unwrapped.getExpression().getText();
          if (receiverText.includes("command")) {
            callSites.push({
              kind: "command",
              key: ctorName,
              location: nodeToLocation(unwrapped.getExpression()),
              context: "commandBus.execute()",
            });
          } else if (receiverText.includes("query")) {
            callSites.push({
              kind: "query",
              key: ctorName,
              location: nodeToLocation(unwrapped.getExpression()),
              context: "queryBus.execute()",
            });
          }
        }
      }
    }
  }
}
