import type { BunPlugin } from "bun";
import { dirname, relative, resolve } from "@bunest/core";
import { TextEditor } from "../analyzer/text-editor";
import {
  SyntaxKind,
  parseTypeScript,
  type RawArrayLiteralExpression,
  type RawCallExpression,
  type RawClassDeclaration,
  type RawDecorator,
  type RawFunctionDeclaration,
  type RawIdentifier,
  type RawImportDeclaration,
  type RawNode,
  type RawObjectLiteralExpression,
  type RawPropertyAccessExpression,
  type RawPropertyAssignment,
  type RawStringLiteral,
  type RawVariableStatement,
} from "../ast";
import {
  applyBunestConfigRuntime,
  collectCustomMacros,
  type BunestConfigLike,
  type BunestSourceTransformConfigLike,
} from "../config/bunest-config.loader";
import {
  BUILTIN_DI_CLASS_DECORATORS,
  BUILTIN_FIELD_CONTRIBUTING_MACRO_NAMES,
  BUILTIN_REPOSITORY_DECORATOR_NAMES,
} from "../decorators";
import {
  transformControllerMetadataSource,
  transformDtoMetadataSource,
  type BunestMetadataPluginOptions,
} from "./metadata.plugin";

// ============================================================================
// Public Types
// ============================================================================

export type BunestPluginStageName =
  | "classMacros"
  | "aotMacros"
  | "aotDiMetadata"
  | "autoModuleManifest"
  | "swaggerMetadata"
  | "userTransforms"
  | "ormCircularSafe";

export interface BunestSourceTransform extends BunestSourceTransformConfigLike {}

export interface BunestPluginOptions {
  /**
   * File path filter matched by the unified `onLoad` hook.
   * @default /\.tsx?$/
   */
  readonly filter?: RegExp;
  /**
   * File path exclusion regex.
   * @default /(?:^|[/\\])node_modules[/\\]/
   */
  readonly exclude?: RegExp;
  /**
   * Stage 1: Scan classes decorated with Bunest class macros (and custom macros/presets)
   * and auto-append `registerMacroFields(ClassName, [...])` so zero-initializer fields
   * (`email!: string;`) work with zero manual `fields: [...]`.
   * @default true
   */
  readonly classMacros?: boolean;
  /**
   * Additional custom macro or preset decorator names recognized by Stage 1.
   */
  readonly customMacroNames?: readonly string[];
  /**
   * Preset map (`{ DomainEntity: ["Data", "Builder"] }`) recognized by Stage 1.
   */
  readonly presets?: Readonly<Record<string, readonly string[]>>;
  /**
   * Import specifier used when auto-importing `registerMacroFields`.
   * @default "@bunest/core"
   */
  readonly coreImportPath?: string;
  /**
   * Stage 2: Expand `@AutoModule({ scan: "..." })` globs into static
   * `manifest: [() => import("./...")]` arrays in build mode.
   * @default true
   */
  readonly autoModuleManifest?: boolean;
  /**
   * Explicitly enable/disable `@AutoModule({ scan })` glob expansion.
   * When omitted in `createBunestPlugin()`, auto-enabled during `Bun.build()`
   * and disabled during runtime `Bun.plugin()` preload.
   */
  readonly expandAutoModuleGlobs?: boolean;
  /**
   * Stage 3: Emit Swagger/GraphQL metadata for DTO/entity/model/controller files.
   * Pass an options object to customize `BunestMetadataPluginOptions`.
   * @default true
   */
  readonly swaggerMetadata?: boolean | BunestMetadataPluginOptions;
  /**
   * Stage 4: Custom user source transforms executed before final transpilation.
   */
  readonly transforms?: readonly BunestSourceTransform[];
  /**
   * Stage 5: Transpile TypeScript with `experimentalDecorators` + `emitDecoratorMetadata`
   * and apply TDZ-safe metadata rewriting matching `@bunest/orm`'s circular-safe plugin.
   * @default true
   */
  readonly ormCircularSafe?: boolean;
  /**
   * Stage 6 (opt-in AOT): Pre-register `CompiledMacroPlan` (`registerCompiledMacroPlan(..., { fields, skipProbe: true })`)
   * at transpile time so runtime macro methods skip `new Class()` probing on cold start.
   * @default false
   */
  readonly aotMacros?: boolean;
  /**
   * Stage 7 (opt-in AOT): Emit TDZ-safe `MetadataRegistry.define("design:paramtypes", [...], Class)`
   * for DI-managed classes (`@Injectable`, `@Controller`, `@Resolver`, etc.) at transpile time so
   * constructor injection works deterministically even in bundlers without `emitDecoratorMetadata`.
   * @default false
   */
  readonly aotDiMetadata?: boolean;
  /**
   * Custom tsconfig passed to `Bun.Transpiler` in Stage 5.
   */
  readonly tsconfig?: Record<string, unknown>;
  /**
   * Optional loaded `BunestConfig` whose `plugin`, `macros.presets`, and `macros.plugins`
   * settings merge cleanly with explicit options.
   */
  readonly config?: BunestConfigLike;
}

export interface TransformBunestSourceResult {
  readonly code: string;
  readonly loader: "ts" | "tsx" | "js";
  readonly modified: boolean;
  readonly stagesApplied: readonly BunestPluginStageName[];
  readonly registeredMacroClasses: readonly {
    readonly className: string;
    readonly fields: readonly string[];
  }[];
  readonly autoModuleManifests: readonly {
    readonly className: string;
    readonly files: readonly string[];
  }[];
  readonly aotMacroClasses?: readonly {
    readonly className: string;
    readonly fields: readonly string[];
  }[];
  readonly aotDiClasses?: readonly {
    readonly className: string;
    readonly paramTypes: readonly string[];
  }[];
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_FILTER = /\.tsx?$/;
const DEFAULT_EXCLUDE = /(?:^|[/\\])node_modules[/\\]/;

const BUILTIN_FIELD_MACRO_DECORATORS = BUILTIN_FIELD_CONTRIBUTING_MACRO_NAMES;

const DEFAULT_AUTO_MODULE_EXCLUDES = [
  "**/*.spec.ts",
  "**/*.test.ts",
  "**/*.d.ts",
] as const;

const DEFAULT_DTO_SUFFIXES = [".dto.ts", ".entity.ts", ".model.ts"] as const;
const DEFAULT_CONTROLLER_SUFFIXES = [".controller.ts"] as const;

/**
 * Matches Bun's legacy decorator metadata emission:
 * `typeof TargetClass === "undefined" ? Object : TargetClass`
 */
const TDZ_METADATA_PATTERN =
  /typeof\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*===\s*"undefined"\s*\?\s*Object\s*:\s*\1\b/g;

// ============================================================================
// Standalone Stage 5 Helper (Zero `@bunest/orm` Import)
// ============================================================================

/**
 * Rewrites Bun-transpiled legacy decorator metadata expressions to be TDZ-safe
 * (identical behavior to `@bunest/orm`'s `circular-safe.plugin.ts` with zero cross-package coupling).
 */
export function transformCircularMetadataJs(jsCode: string): string {
  if (
    !jsCode.includes("__legacyMetadataTS") &&
    !jsCode.includes("design:type") &&
    !jsCode.includes("design:paramtypes") &&
    !jsCode.includes("design:returntype")
  ) {
    return jsCode;
  }

  return jsCode.replace(
    TDZ_METADATA_PATTERN,
    (_match, ident: string) =>
      `(() => { try { return typeof ${ident} === "undefined" ? Object : ${ident}; } catch { return Object; } })()`,
  );
}

// ============================================================================
// AST Extraction Helpers (Bunest Native Parser)
// ============================================================================

function getRawDecoratorShortName(dec: RawDecorator, source: string): string {
  const expr = dec.expression;
  let callee: RawNode = expr;
  if (expr.kind === SyntaxKind.CallExpression) {
    callee = (expr as RawCallExpression).expression;
  }
  if (callee.kind === SyntaxKind.Identifier) {
    return (callee as RawIdentifier).text;
  }
  if (callee.kind === SyntaxKind.PropertyAccessExpression) {
    return (callee as RawPropertyAccessExpression).name.text;
  }
  const raw = source.slice(callee.start, callee.end).trim();
  const dot = raw.lastIndexOf(".");
  return dot !== -1 ? raw.slice(dot + 1) : raw;
}

function getRawPropertyName(nameNode: RawNode, source: string): string | null {
  if (nameNode.kind === SyntaxKind.PrivateIdentifier) {
    return null;
  }
  if (nameNode.kind === SyntaxKind.Identifier) {
    return (nameNode as RawIdentifier).text;
  }
  if (
    nameNode.kind === SyntaxKind.StringLiteral ||
    nameNode.kind === SyntaxKind.NoSubstitutionTemplateLiteral
  ) {
    return (nameNode as RawStringLiteral).value;
  }
  const text = source.slice(nameNode.start, nameNode.end).trim();
  if (/^[A-Za-z_$][\w$]*$/.test(text)) {
    return text;
  }
  return null;
}

function extractRawStringLiteral(node: RawNode | undefined): string | null {
  if (!node) return null;
  if (
    node.kind === SyntaxKind.StringLiteral ||
    node.kind === SyntaxKind.NoSubstitutionTemplateLiteral
  ) {
    return (node as RawStringLiteral).value;
  }
  return null;
}

function extractRawStringList(node: RawNode | undefined): string[] {
  if (!node) return [];
  const single = extractRawStringLiteral(node);
  if (single !== null) return [single];
  if (node.kind === SyntaxKind.ArrayLiteralExpression) {
    const arr = node as RawArrayLiteralExpression;
    const out: string[] = [];
    for (const el of arr.elements) {
      const s = extractRawStringLiteral(el);
      if (s !== null) out.push(s);
    }
    return out;
  }
  return [];
}

function getRawObjectProperty(
  obj: RawObjectLiteralExpression,
  propName: string,
  source: string,
): RawPropertyAssignment | undefined {
  for (const prop of obj.properties) {
    if (prop.kind === SyntaxKind.PropertyAssignment) {
      const pa = prop as RawPropertyAssignment;
      const name = getRawPropertyName(pa.name, source);
      if (name === propName) return pa;
    }
  }
  return undefined;
}

function hasRawObjectProperty(
  obj: RawObjectLiteralExpression,
  propName: string,
  source: string,
): boolean {
  for (const prop of obj.properties) {
    if (prop.kind === SyntaxKind.PropertyAssignment) {
      const pa = prop as RawPropertyAssignment;
      if (getRawPropertyName(pa.name, source) === propName) return true;
    } else if (prop.kind === SyntaxKind.ShorthandPropertyAssignment) {
      const text = source.slice(prop.start, prop.end).trim();
      if (text === propName) return true;
    }
  }
  return false;
}

function collectClassInstanceFields(
  cls: RawClassDeclaration,
  source: string,
): string[] {
  const fields: string[] = [];
  const seen = new Set<string>();

  for (const prop of cls.properties) {
    const isStatic = prop.modifiers.some(
      (m) => m.kind === SyntaxKind.StaticKeyword,
    );
    if (isStatic) continue;
    const name = getRawPropertyName(prop.name, source);
    if (name && !seen.has(name)) {
      seen.add(name);
      fields.push(name);
    }
  }

  for (const ctor of cls.constructors) {
    for (const param of ctor.parameters) {
      const isParamProp = param.modifiers.some(
        (m) =>
          m.kind === SyntaxKind.PublicKeyword ||
          m.kind === SyntaxKind.PrivateKeyword ||
          m.kind === SyntaxKind.ProtectedKeyword ||
          m.kind === SyntaxKind.ReadonlyKeyword,
      );
      if (!isParamProp) continue;
      const name = getRawPropertyName(param.name, source);
      if (name && !seen.has(name)) {
        seen.add(name);
        fields.push(name);
      }
    }
  }

  return fields;
}

function hasValueImportBinding(
  statements: readonly RawNode[],
  localName: string,
): boolean {
  for (const stmt of statements) {
    if (stmt.kind !== SyntaxKind.ImportDeclaration) continue;
    const imp = stmt as RawImportDeclaration;
    if (imp.isTypeOnly) continue;
    if (imp.defaultImport?.text === localName) return true;
    if (imp.namespaceImport?.text === localName) return true;
    for (const spec of imp.namedImports) {
      if (spec.isTypeOnly) continue;
      const bound = spec.alias?.text ?? spec.name.text;
      if (bound === localName) return true;
    }
  }
  return false;
}

function findImportInsertionOffset(source: string): number {
  let offset = 0;
  // Preserve leading shebang `#!/usr/bin/env bun`
  if (source.startsWith("#!")) {
    const nl = source.indexOf("\n");
    offset = nl === -1 ? source.length : nl + 1;
  }
  // Preserve leading `"use strict";` directive if present
  const rest = source.slice(offset);
  const directiveMatch = /^[ \t]*["']use strict["'];?[ \t]*\r?\n/.exec(rest);
  if (directiveMatch) {
    offset += directiveMatch[0].length;
  }
  return offset;
}

// ============================================================================
// Same-File `applyDecorators(...)` Lightweight Raw-AST Discovery
// ============================================================================

function collectSameFileComposedWrappers(
  statements: readonly RawNode[],
  source: string,
): Map<string, string[]> {
  const map = new Map<string, string[]>();

  const extractApplyDecoratorNames = (text: string): string[] | undefined => {
    const match = /\bapplyDecorators\s*\(([\s\S]*)\)/.exec(text);
    if (!match) return undefined;
    const inner = match[1]!;
    const found: string[] = [];
    const decRe = /\b([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = decRe.exec(inner)) !== null) {
      if (m[1] && m[1] !== "applyDecorators") {
        found.push(m[1]);
      }
    }
    return found.length > 0 ? found : undefined;
  };

  for (const stmt of statements) {
    if (stmt.kind === SyntaxKind.FunctionDeclaration) {
      const fn = stmt as RawFunctionDeclaration;
      if (!fn.name || !fn.body) continue;
      const bodyText = source.slice(fn.body.start, fn.body.end);
      const targets = extractApplyDecoratorNames(bodyText);
      if (targets) map.set(fn.name.text, targets);
    } else if (stmt.kind === SyntaxKind.VariableStatement) {
      const vs = stmt as RawVariableStatement;
      for (const decl of vs.declarations) {
        if (decl.name.kind !== SyntaxKind.Identifier || !decl.initializer) {
          continue;
        }
        const name = (decl.name as RawIdentifier).text;
        const initText = source.slice(
          decl.initializer.start,
          decl.initializer.end,
        );
        const targets = extractApplyDecoratorNames(initText);
        if (targets) map.set(name, targets);
      }
    }
  }
  return map;
}

function expandRawDecoratorNames(
  decorators: readonly RawDecorator[],
  source: string,
  composedMap: ReadonlyMap<string, string[]>,
): Set<string> {
  const expanded = new Set<string>();
  const visited = new Set<string>();
  const visit = (name: string): void => {
    if (visited.has(name)) return;
    visited.add(name);
    expanded.add(name);
    for (const inner of composedMap.get(name) ?? []) {
      visit(inner);
    }
  };
  for (const dec of decorators) {
    visit(getRawDecoratorShortName(dec, source));
  }
  return expanded;
}

// ============================================================================
// Stage 1: Class Macro Compile-Time Field Registration (+ Stage 6 AOT Macro Plans)
// ============================================================================

function resolveMacroDecoratorNames(options: BunestPluginOptions): Set<string> {
  const names = new Set<string>(BUILTIN_FIELD_MACRO_DECORATORS);

  for (const customName of options.customMacroNames ?? []) {
    if (customName) names.add(customName);
  }
  for (const presetName of Object.keys(options.presets ?? {})) {
    if (presetName) names.add(presetName);
  }
  for (const presetName of Object.keys(options.config?.macros?.presets ?? {})) {
    if (presetName) names.add(presetName);
  }
  for (const macroName of collectCustomMacros(options.config).keys()) {
    if (macroName) names.add(macroName);
  }

  return names;
}

function runClassMacrosStage(
  source: string,
  options: BunestPluginOptions,
  emitRegisterFields = true,
  emitAotPlans = false,
): {
  readonly code: string;
  readonly modified: boolean;
  readonly registered: readonly {
    readonly className: string;
    readonly fields: readonly string[];
  }[];
  readonly aotRegistered: readonly {
    readonly className: string;
    readonly fields: readonly string[];
  }[];
} {
  if (!source.includes("@") || !source.includes("class")) {
    return { code: source, modified: false, registered: [], aotRegistered: [] };
  }

  const macroNames = resolveMacroDecoratorNames(options);
  const ast = parseTypeScript(source);
  const composedMap = collectSameFileComposedWrappers(ast.statements, source);
  const editor = new TextEditor(source);
  const registered: Array<{
    readonly className: string;
    readonly fields: readonly string[];
  }> = [];
  const aotRegistered: Array<{
    readonly className: string;
    readonly fields: readonly string[];
  }> = [];

  for (const stmt of ast.statements) {
    if (stmt.kind !== SyntaxKind.ClassDeclaration) continue;
    const cls = stmt as RawClassDeclaration;
    if (!cls.name) continue;
    if (cls.modifiers.some((m) => m.kind === SyntaxKind.DeclareKeyword)) {
      continue;
    }

    const decNames = expandRawDecoratorNames(cls.decorators, source, composedMap);
    const hasMacro = [...decNames].some((name) => macroNames.has(name));
    if (!hasMacro) continue;

    const fields = collectClassInstanceFields(cls, source);
    const className = cls.name.text;

    if (emitRegisterFields && fields.length > 0) {
      registered.push({ className, fields });
      const argsJson = JSON.stringify(fields);
      editor.appendRight(
        cls.end,
        `\nregisterMacroFields(${className}, ${argsJson});`,
      );
    }

    if (emitAotPlans) {
      aotRegistered.push({ className, fields });
      const fieldsJson = JSON.stringify(fields);
      editor.appendRight(
        cls.end,
        `\nregisterCompiledMacroPlan(${className}, { fields: ${fieldsJson}, skipProbe: true });`,
      );
    }
  }

  if (registered.length === 0 && aotRegistered.length === 0) {
    return { code: source, modified: false, registered, aotRegistered };
  }

  const neededImports: string[] = [];
  if (
    registered.length > 0 &&
    !hasValueImportBinding(ast.statements, "registerMacroFields")
  ) {
    neededImports.push("registerMacroFields");
  }
  if (
    aotRegistered.length > 0 &&
    !hasValueImportBinding(ast.statements, "registerCompiledMacroPlan")
  ) {
    neededImports.push("registerCompiledMacroPlan");
  }

  if (neededImports.length > 0) {
    const coreSpec = options.coreImportPath ?? "@bunest/core";
    const insertAt = findImportInsertionOffset(source);
    editor.prependRight(
      insertAt,
      `import { ${neededImports.join(", ")} } from ${JSON.stringify(coreSpec)};\n`,
    );
  }

  const code = editor.toString();
  return {
    code,
    modified: code !== source,
    registered,
    aotRegistered,
  };
}

// ============================================================================
// Stage 7: Opt-In Build-Time AOT DI Metadata (`design:paramtypes`)
// ============================================================================

function collectTypeOnlyOrNonRuntimeSymbols(
  statements: readonly RawNode[],
): Set<string> {
  const nonRuntime = new Set<string>();
  for (const stmt of statements) {
    if (stmt.kind === SyntaxKind.ImportDeclaration) {
      const imp = stmt as RawImportDeclaration;
      if (imp.isTypeOnly) {
        if (imp.defaultImport) nonRuntime.add(imp.defaultImport.text);
        if (imp.namespaceImport) nonRuntime.add(imp.namespaceImport.text);
        for (const spec of imp.namedImports) {
          nonRuntime.add(spec.alias?.text ?? spec.name.text);
        }
      } else {
        for (const spec of imp.namedImports) {
          if (spec.isTypeOnly) {
            nonRuntime.add(spec.alias?.text ?? spec.name.text);
          }
        }
      }
    } else if (
      stmt.kind === SyntaxKind.InterfaceDeclaration ||
      stmt.kind === SyntaxKind.TypeAliasDeclaration
    ) {
      const named = stmt as { name?: RawIdentifier };
      if (named.name?.text) {
        nonRuntime.add(named.name.text);
      }
    }
  }
  return nonRuntime;
}

function resolveAotParamTypeExpr(
  rawTypeText: string | undefined,
  nonRuntimeSymbols: ReadonlySet<string>,
): string {
  if (!rawTypeText) return "Object";
  const trimmed = rawTypeText.trim();
  if (!trimmed) return "Object";

  // Strip nullable unions (`Foo | null | undefined` -> `Foo`)
  const parts = trimmed
    .split("|")
    .map((p) => p.trim())
    .filter((p) => p !== "null" && p !== "undefined");
  if (parts.length !== 1) {
    return "Object";
  }
  const core = parts[0]!;

  if (core === "string") return "String";
  if (core === "number") return "Number";
  if (core === "boolean") return "Boolean";
  if (core === "bigint") return "BigInt";
  if (core === "symbol") return "Symbol";
  if (
    core === "object" ||
    core === "unknown" ||
    core === "any" ||
    core === "void" ||
    core === "never"
  ) {
    return "Object";
  }
  if (core.endsWith("[]") || /^(?:Readonly)?Array\s*</.test(core)) {
    return "Array";
  }
  if (/^Promise\s*</.test(core)) return "Promise";
  if (/^Map\s*</.test(core)) return "Map";
  if (/^Set\s*</.test(core)) return "Set";
  if (core === "Date" || core === "RegExp" || core === "Function") {
    return core;
  }

  // Generic class reference `Repository<User>` -> `Repository`
  const identMatch = /^([A-Za-z_$][\w$]*)(?:\s*<[\s\S]*>)?$/.exec(core);
  if (!identMatch) return "Object";
  const ident = identMatch[1]!;
  if (nonRuntimeSymbols.has(ident)) {
    return "Object";
  }
  return `(() => { try { return typeof ${ident} === "undefined" ? Object : ${ident}; } catch { return Object; } })()`;
}

function runAotDiMetadataStage(
  source: string,
  options: BunestPluginOptions,
): {
  readonly code: string;
  readonly modified: boolean;
  readonly aotDiClasses: readonly {
    readonly className: string;
    readonly paramTypes: readonly string[];
  }[];
} {
  if (!source.includes("@") || !source.includes("constructor")) {
    return { code: source, modified: false, aotDiClasses: [] };
  }

  const ast = parseTypeScript(source);
  const composedMap = collectSameFileComposedWrappers(ast.statements, source);
  const nonRuntimeSymbols = collectTypeOnlyOrNonRuntimeSymbols(ast.statements);
  const editor = new TextEditor(source);
  const aotDiClasses: Array<{
    readonly className: string;
    readonly paramTypes: readonly string[];
  }> = [];

  for (const stmt of ast.statements) {
    if (stmt.kind !== SyntaxKind.ClassDeclaration) continue;
    const cls = stmt as RawClassDeclaration;
    if (!cls.name) continue;
    if (cls.modifiers.some((m) => m.kind === SyntaxKind.DeclareKeyword)) {
      continue;
    }

    const decNames = expandRawDecoratorNames(cls.decorators, source, composedMap);
    const isDiClass = [...decNames].some((name) =>
      BUILTIN_DI_CLASS_DECORATORS.has(name),
    );
    if (!isDiClass) continue;

    const ctor = cls.constructors[0];
    if (!ctor || ctor.parameters.length === 0) continue;

    const paramExprs: string[] = [];
    const paramNames: string[] = [];
    for (const param of ctor.parameters) {
      const rawType = param.typeNode
        ? source.slice(param.typeNode.start, param.typeNode.end).trim()
        : undefined;
      paramNames.push(rawType ?? "Object");
      paramExprs.push(resolveAotParamTypeExpr(rawType, nonRuntimeSymbols));
    }

    const className = cls.name.text;
    aotDiClasses.push({ className, paramTypes: paramNames });
    editor.appendRight(
      cls.end,
      `\nif (!MetadataRegistry.hasOwn("design:paramtypes", ${className})) { MetadataRegistry.define("design:paramtypes", [${paramExprs.join(", ")}], ${className}); }`,
    );
  }

  if (aotDiClasses.length === 0) {
    return { code: source, modified: false, aotDiClasses };
  }

  if (!hasValueImportBinding(ast.statements, "MetadataRegistry")) {
    const coreSpec = options.coreImportPath ?? "@bunest/core";
    const insertAt = findImportInsertionOffset(source);
    editor.prependRight(
      insertAt,
      `import { MetadataRegistry } from ${JSON.stringify(coreSpec)};\n`,
    );
  }

  const code = editor.toString();
  return {
    code,
    modified: code !== source,
    aotDiClasses,
  };
}

// ============================================================================
// Stage 2: @AutoModule({ scan }) Static Manifest Expansion (Build Mode)
// ============================================================================

function toRelativeImportSpecifier(
  fromDir: string,
  targetAbsPath: string,
): string {
  let rel = relative(fromDir, targetAbsPath)
    .replace(/\\/g, "/")
    .replace(/\.(?:tsx|ts)$/, "");
  if (!rel.startsWith(".")) {
    rel = `./${rel}`;
  }
  return rel;
}

function runAutoModuleManifestStage(
  source: string,
  filePath: string,
): {
  readonly code: string;
  readonly modified: boolean;
  readonly manifests: readonly {
    readonly className: string;
    readonly files: readonly string[];
  }[];
} {
  if (!source.includes("@AutoModule") || !source.includes("scan")) {
    return { code: source, modified: false, manifests: [] };
  }

  const ast = parseTypeScript(source);
  const editor = new TextEditor(source);
  const manifests: Array<{
    readonly className: string;
    readonly files: readonly string[];
  }> = [];
  const fileAbs = resolve(filePath);
  const fileDir = dirname(fileAbs);

  for (const stmt of ast.statements) {
    if (stmt.kind !== SyntaxKind.ClassDeclaration) continue;
    const cls = stmt as RawClassDeclaration;

    for (const dec of cls.decorators) {
      if (getRawDecoratorShortName(dec, source) !== "AutoModule") continue;
      if (dec.expression.kind !== SyntaxKind.CallExpression) continue;
      const call = dec.expression as RawCallExpression;
      const arg0 = call.arguments[0];
      if (!arg0 || arg0.kind !== SyntaxKind.ObjectLiteralExpression) continue;
      const obj = arg0 as RawObjectLiteralExpression;

      if (hasRawObjectProperty(obj, "manifest", source)) continue;

      const scanProp = getRawObjectProperty(obj, "scan", source);
      if (!scanProp) continue;

      const scanPatterns = extractRawStringList(scanProp.initializer);
      if (scanPatterns.length === 0) continue;

      const excludeProp = getRawObjectProperty(obj, "exclude", source);
      const excludePatterns = excludeProp
        ? extractRawStringList(excludeProp.initializer)
        : [...DEFAULT_AUTO_MODULE_EXCLUDES];
      const excludeGlobs = excludePatterns.map((p) => new Bun.Glob(p));

      const cwdProp = getRawObjectProperty(obj, "cwd", source);
      const explicitCwd = cwdProp
        ? extractRawStringLiteral(cwdProp.initializer)
        : null;
      const scanRoot = explicitCwd ? resolve(fileDir, explicitCwd) : fileDir;

      const matchedAbs = new Set<string>();
      for (const pattern of scanPatterns) {
        try {
          const glob = new Bun.Glob(pattern);
          for (const entry of glob.scanSync({
            cwd: scanRoot,
            onlyFiles: true,
          })) {
            const normalizedEntry = entry.replace(/\\/g, "/");
            if (excludeGlobs.some((ex) => ex.match(normalizedEntry))) {
              continue;
            }
            const abs = resolve(scanRoot, entry);
            if (abs === fileAbs) continue;
            matchedAbs.add(abs);
          }
        } catch {
          // Ignore unreadable scan directories cleanly
        }
      }

      const sortedSpecs = [...matchedAbs]
        .sort((a, b) => a.localeCompare(b))
        .map((abs) => toRelativeImportSpecifier(fileDir, abs));

      const manifestExpr = `[${sortedSpecs.map((spec) => `() => import(${JSON.stringify(spec)})`).join(", ")}]`;
      const closeBracePos = obj.end - 1;
      const beforeClose = source.slice(obj.start + 1, closeBracePos).trim();
      const needsComma = beforeClose.length > 0 && !beforeClose.endsWith(",");
      const insertion = `${needsComma ? "," : ""} manifest: ${manifestExpr} `;
      editor.appendLeft(closeBracePos, insertion);

      manifests.push({
        className: cls.name?.text ?? "AnonymousAutoModule",
        files: sortedSpecs,
      });
    }
  }

  if (manifests.length === 0) {
    return { code: source, modified: false, manifests };
  }

  const code = editor.toString();
  return {
    code,
    modified: code !== source,
    manifests,
  };
}

// ============================================================================
// Stage 3: Swagger/GraphQL Metadata Helper
// ============================================================================

function normalizeSuffixList(
  input: string | readonly string[] | undefined,
  defaults: readonly string[],
): readonly string[] {
  if (input === undefined) return defaults;
  const list = (typeof input === "string" ? [input] : [...input]).filter(
    (s) => s.length > 0,
  );
  return list.length > 0 ? list : defaults;
}

function matchesAnySuffix(
  filePath: string,
  suffixes: readonly string[],
): boolean {
  const lower = filePath.toLowerCase();
  return suffixes.some((s) => lower.endsWith(s.toLowerCase()));
}

function runSwaggerMetadataStage(
  source: string,
  filePath: string,
  metaOpt: boolean | BunestMetadataPluginOptions,
): { readonly code: string; readonly modified: boolean } {
  const opts: BunestMetadataPluginOptions =
    typeof metaOpt === "object" && metaOpt !== null ? metaOpt : {};
  const dtoSuffixes = normalizeSuffixList(
    opts.dtoFileNameSuffix,
    DEFAULT_DTO_SUFFIXES,
  );
  const ctrlSuffixes = normalizeSuffixList(
    opts.controllerFileNameSuffix,
    DEFAULT_CONTROLLER_SUFFIXES,
  );

  let code = source;
  let modified = false;

  if (matchesAnySuffix(filePath, dtoSuffixes)) {
    const res = transformDtoMetadataSource(code, filePath, opts);
    if (res.modified) {
      code = res.code;
      modified = true;
    }
  }
  if (matchesAnySuffix(filePath, ctrlSuffixes)) {
    const res = transformControllerMetadataSource(code, filePath, opts);
    if (res.modified) {
      code = res.code;
      modified = true;
    }
  }

  return { code, modified };
}

// ============================================================================
// Stage 4: User Transforms
// ============================================================================

function matchesTransformFilter(
  filter: RegExp | ((filePath: string) => boolean) | undefined,
  filePath: string,
): boolean {
  if (!filter) return true;
  if (typeof filter === "function") return Boolean(filter(filePath));
  filter.lastIndex = 0;
  return filter.test(filePath);
}

function normalizeTransformOutput(
  output: unknown,
  fallback: string,
): string {
  if (typeof output === "string") return output;
  if (
    output &&
    typeof output === "object" &&
    "code" in output &&
    typeof (output as { code?: unknown }).code === "string"
  ) {
    return (output as { code: string }).code;
  }
  return fallback;
}

// ============================================================================
// Stage 5: Transpiler Factory
// ============================================================================

function createStage5Transpiler(
  loader: "ts" | "tsx",
  tsconfig?: Record<string, unknown>,
): Bun.Transpiler {
  return new Bun.Transpiler({
    loader,
    tsconfig: JSON.stringify(
      tsconfig ?? {
        compilerOptions: {
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          verbatimModuleSyntax: true,
        },
      },
    ),
  });
}

function resolveMergedPluginOptions(
  options: BunestPluginOptions,
): {
  readonly classMacros: boolean;
  readonly aotMacros: boolean;
  readonly aotDiMetadata: boolean;
  readonly autoModuleManifest: boolean;
  readonly expandAutoModuleGlobs: boolean;
  readonly swaggerMetadata: boolean | BunestMetadataPluginOptions;
  readonly ormCircularSafe: boolean;
  readonly transforms: readonly BunestSourceTransform[];
} {
  const cfgPlugin = options.config?.plugin;
  const classMacros = options.classMacros ?? cfgPlugin?.classMacros ?? true;
  const aotMacros = options.aotMacros ?? cfgPlugin?.aotMacros ?? false;
  const aotDiMetadata =
    options.aotDiMetadata ?? cfgPlugin?.aotDiMetadata ?? false;
  const autoModuleManifest =
    options.autoModuleManifest ?? cfgPlugin?.autoModuleManifest ?? true;
  const expandAutoModuleGlobs =
    options.expandAutoModuleGlobs ?? cfgPlugin?.expandAutoModuleGlobs ?? false;
  const swaggerMetadata =
    options.swaggerMetadata ??
    (cfgPlugin?.swaggerMetadata as
      | boolean
      | BunestMetadataPluginOptions
      | undefined) ??
    true;
  const ormCircularSafe =
    options.ormCircularSafe ?? cfgPlugin?.ormCircularSafe ?? true;
  const transforms: BunestSourceTransform[] = [
    ...(cfgPlugin?.transforms ?? []),
    ...(options.transforms ?? []),
  ];
  return {
    classMacros,
    aotMacros,
    aotDiMetadata,
    autoModuleManifest,
    expandAutoModuleGlobs,
    swaggerMetadata,
    ormCircularSafe,
    transforms,
  };
}

// ============================================================================
// Public Programmatic Transform Functions
// ============================================================================

const NON_ENTITY_TYPE_NAMES = new Set([
  "any",
  "unknown",
  "never",
  "void",
  "object",
  "Object",
  "Record",
  "Partial",
  "Required",
  "Readonly",
  "Pick",
  "Omit",
  "Array",
  "Map",
  "Set",
]);

function getObjectPropName(prop: RawNode): string | undefined {
  if (prop.kind === SyntaxKind.PropertyAssignment) {
    const p = prop as RawPropertyAssignment;
    if (p.name.kind === SyntaxKind.Identifier) {
      return (p.name as RawIdentifier).text;
    }
    if (p.name.kind === SyntaxKind.StringLiteral) {
      return (p.name as RawStringLiteral).text;
    }
  } else if (prop.kind === SyntaxKind.ShorthandPropertyAssignment) {
    const p = prop as unknown as { readonly name: RawIdentifier };
    return p.name?.text;
  }
  return undefined;
}

/**
 * Rewrites generic-only declarative repository decorators:
 *   `@Repository<TaskEntity, number>()` -> `@Repository<TaskEntity, number>(TaskEntity)`
 *   `@Repository<TaskEntity, number>({ table: "tasks" })` -> `@Repository<TaskEntity, number>({ entity: TaskEntity, table: "tasks" })`
 *
 * Also promotes `import type { TaskEntity }` (or `import { type TaskEntity }`) to a
 * value import so `verbatimModuleSyntax: true` remains 100% happy while runtime receives
 * the entity constructor automatically.
 */
function runRepositoryEntityInjectionStage(source: string): {
  readonly code: string;
  readonly modified: boolean;
} {
  if (!source.includes("@") || !source.includes("Repository")) {
    return { code: source, modified: false };
  }

  const parsed = parseTypeScript(source);
  const editor = new TextEditor(source);
  const promotedEntities = new Set<string>();
  let modified = false;

  const visitClasses = (nodes: readonly RawNode[]): void => {
    for (const node of nodes) {
      if (node.kind === SyntaxKind.ClassDeclaration) {
        const cls = node as RawClassDeclaration;
        for (const dec of cls.decorators ?? []) {
          if (dec.expression.kind !== SyntaxKind.CallExpression) continue;
          const call = dec.expression as RawCallExpression;
          let decName: string | undefined;
          if (call.expression.kind === SyntaxKind.Identifier) {
            decName = (call.expression as RawIdentifier).text;
          } else if (call.expression.kind === SyntaxKind.PropertyAccessExpression) {
            decName = (call.expression as RawPropertyAccessExpression).name.text;
          }
          if (!decName || !BUILTIN_REPOSITORY_DECORATOR_NAMES.has(decName)) {
            continue;
          }
          const typeArg0 = call.typeArguments?.[0];
          if (!typeArg0 || typeArg0.kind !== SyntaxKind.TypeReference) {
            continue;
          }
          const typeRef = typeArg0 as unknown as { readonly typeName: RawNode };
          if (typeRef.typeName.kind !== SyntaxKind.Identifier) {
            continue;
          }
          const entityName = (typeRef.typeName as RawIdentifier).text;
          if (!entityName || NON_ENTITY_TYPE_NAMES.has(entityName)) {
            continue;
          }

          if (call.arguments.length === 0) {
            const closeParen = source.lastIndexOf(")", call.end);
            if (closeParen >= call.start) {
              editor.appendLeft(closeParen, entityName);
              promotedEntities.add(entityName);
              modified = true;
            }
          } else if (
            call.arguments.length === 1 &&
            call.arguments[0]!.kind === SyntaxKind.ObjectLiteralExpression
          ) {
            const obj = call.arguments[0] as RawObjectLiteralExpression;
            const hasEntityProp = obj.properties.some(
              (p) => getObjectPropName(p) === "entity",
            );
            if (!hasEntityProp) {
              const openBrace = source.indexOf("{", obj.start);
              if (openBrace >= 0 && openBrace < obj.end) {
                const suffix = obj.properties.length > 0 ? "," : " ";
                editor.appendRight(openBrace + 1, ` entity: ${entityName}${suffix}`);
                promotedEntities.add(entityName);
                modified = true;
              }
            }
          }
        }
      }
      const body = (
        node as unknown as { readonly body?: { readonly statements?: RawNode[] } }
      ).body;
      if (body?.statements) {
        visitClasses(body.statements);
      }
    }
  };

  visitClasses(parsed.statements);

  if (!modified || promotedEntities.size === 0) {
    return { code: source, modified: false };
  }

  for (const stmt of parsed.statements) {
    if (stmt.kind !== SyntaxKind.ImportDeclaration) continue;
    const imp = stmt as RawImportDeclaration;
    if (imp.namedImports.length === 0) continue;

    const matching = imp.namedImports.filter((spec) => {
      const localName = spec.alias?.text ?? spec.name.text;
      return promotedEntities.has(localName);
    });
    if (matching.length === 0) continue;

    if (imp.isTypeOnly) {
      const remaining = imp.namedImports.filter((spec) => !matching.includes(spec));
      const formatSpec = (spec: {
        readonly name: RawIdentifier;
        readonly alias?: RawIdentifier;
      }) => (spec.alias ? `${spec.name.text} as ${spec.alias.text}` : spec.name.text);
      const rawModSpec = imp.moduleSpecifier.text;
      const modSpec =
        (rawModSpec.startsWith('"') && rawModSpec.endsWith('"')) ||
        (rawModSpec.startsWith("'") && rawModSpec.endsWith("'"))
          ? rawModSpec
          : JSON.stringify(rawModSpec);
      const valueLine = `import { ${matching.map(formatSpec).join(", ")} } from ${modSpec};`;
      const replacement =
        remaining.length > 0
          ? `${valueLine}\nimport type { ${remaining.map(formatSpec).join(", ")} } from ${modSpec};`
          : valueLine;
      editor.overwrite(imp.start, imp.end, replacement);
    } else {
      for (const spec of matching) {
        if (spec.isTypeOnly) {
          const specText = source.slice(spec.start, spec.end);
          const nextText = specText.replace(/^type\s+/, "");
          if (nextText !== specText) {
            editor.overwrite(spec.start, spec.end, nextText);
          }
        }
      }
    }
  }

  return { code: editor.toString(), modified: true };
}

/**
 * Synchronously executes the unified Bunest source transform pipeline:
 * 1. `classMacros` — auto-registers AST-discovered fields via `registerMacroFields` (+ optional `aotMacros` `registerCompiledMacroPlan`)
 * 2. `autoModuleManifest` — expands `@AutoModule({ scan })` globs when `expandAutoModuleGlobs: true`
 * 3. `swaggerMetadata` — emits Swagger/GraphQL DTO & controller metadata
 * 4. `aotDiMetadata` — opt-in TDZ-safe `design:paramtypes` emission for DI classes
 * 5. `userTransforms` — executes synchronous custom source transforms
 * 6. `ormCircularSafe` — transpiles via `Bun.Transpiler` & applies TDZ-safe metadata wrapping
 */
export function transformBunestSource(
  source: string,
  filePath: string,
  options: BunestPluginOptions = {},
): TransformBunestSourceResult {
  const merged = resolveMergedPluginOptions(options);
  const stagesApplied: BunestPluginStageName[] = [];
  let code = source;
  let modified = false;
  let registeredMacroClasses: readonly {
    readonly className: string;
    readonly fields: readonly string[];
  }[] = [];
  let aotMacroClasses: readonly {
    readonly className: string;
    readonly fields: readonly string[];
  }[] = [];
  let aotDiClasses: readonly {
    readonly className: string;
    readonly paramTypes: readonly string[];
  }[] = [];
  let autoModuleManifests: readonly {
    readonly className: string;
    readonly files: readonly string[];
  }[] = [];

  const repoInjectRes = runRepositoryEntityInjectionStage(code);
  if (repoInjectRes.modified) {
    code = repoInjectRes.code;
    modified = true;
  }

  if (merged.classMacros || merged.aotMacros) {
    const res = runClassMacrosStage(
      code,
      options,
      merged.classMacros,
      merged.aotMacros,
    );
    if (res.modified) {
      code = res.code;
      modified = true;
      registeredMacroClasses = res.registered;
      aotMacroClasses = res.aotRegistered;
      if (res.registered.length > 0 && merged.classMacros) {
        stagesApplied.push("classMacros");
      }
      if (res.aotRegistered.length > 0 && merged.aotMacros) {
        stagesApplied.push("aotMacros");
      }
    }
  }

  if (merged.aotDiMetadata) {
    const res = runAotDiMetadataStage(code, options);
    if (res.modified) {
      code = res.code;
      modified = true;
      aotDiClasses = res.aotDiClasses;
      stagesApplied.push("aotDiMetadata");
    }
  }

  if (merged.autoModuleManifest && merged.expandAutoModuleGlobs) {
    const res = runAutoModuleManifestStage(code, filePath);
    if (res.modified) {
      code = res.code;
      modified = true;
      autoModuleManifests = res.manifests;
      stagesApplied.push("autoModuleManifest");
    }
  }

  if (merged.swaggerMetadata !== false) {
    const res = runSwaggerMetadataStage(code, filePath, merged.swaggerMetadata);
    if (res.modified) {
      code = res.code;
      modified = true;
      stagesApplied.push("swaggerMetadata");
    }
  }

  if (merged.transforms.length > 0) {
    let anyUserModified = false;
    for (const tr of merged.transforms) {
      if (!matchesTransformFilter(tr.filter, filePath)) continue;
      const out = tr.transform(code, filePath);
      if (out instanceof Promise) {
        throw new Error(
          `[bunest-plugin] Async transform "${tr.name}" cannot run in synchronous transformBunestSource(). Use transformBunestSourceAsync() or createBunestPlugin().`,
        );
      }
      const nextCode = normalizeTransformOutput(out, code);
      if (nextCode !== code) {
        code = nextCode;
        modified = true;
        anyUserModified = true;
      }
    }
    if (anyUserModified) {
      stagesApplied.push("userTransforms");
    }
  }

  const tsLoader: "ts" | "tsx" = filePath.endsWith(".tsx") ? "tsx" : "ts";
  if (merged.ormCircularSafe && (modified || code.includes("@"))) {
    const transpiler = createStage5Transpiler(tsLoader, options.tsconfig);
    const js = transpiler.transformSync(code);
    const safeJs = transformCircularMetadataJs(js);
    stagesApplied.push("ormCircularSafe");
    return {
      code: safeJs,
      loader: "js",
      modified: true,
      stagesApplied,
      registeredMacroClasses,
      autoModuleManifests,
      ...(aotMacroClasses.length > 0 ? { aotMacroClasses } : {}),
      ...(aotDiClasses.length > 0 ? { aotDiClasses } : {}),
    };
  }

  return {
    code,
    loader: tsLoader,
    modified,
    stagesApplied,
    registeredMacroClasses,
    autoModuleManifests,
    ...(aotMacroClasses.length > 0 ? { aotMacroClasses } : {}),
    ...(aotDiClasses.length > 0 ? { aotDiClasses } : {}),
  };
}

/**
 * Async variant of `transformBunestSource()` supporting async user transforms.
 */
export async function transformBunestSourceAsync(
  source: string,
  filePath: string,
  options: BunestPluginOptions = {},
  cachedTranspilers?: { readonly ts: Bun.Transpiler; readonly tsx: Bun.Transpiler },
): Promise<TransformBunestSourceResult> {
  const merged = resolveMergedPluginOptions(options);
  const stagesApplied: BunestPluginStageName[] = [];
  let code = source;
  let modified = false;
  let registeredMacroClasses: readonly {
    readonly className: string;
    readonly fields: readonly string[];
  }[] = [];
  let aotMacroClasses: readonly {
    readonly className: string;
    readonly fields: readonly string[];
  }[] = [];
  let aotDiClasses: readonly {
    readonly className: string;
    readonly paramTypes: readonly string[];
  }[] = [];
  let autoModuleManifests: readonly {
    readonly className: string;
    readonly files: readonly string[];
  }[] = [];

  const repoInjectRes = runRepositoryEntityInjectionStage(code);
  if (repoInjectRes.modified) {
    code = repoInjectRes.code;
    modified = true;
  }

  if (merged.classMacros || merged.aotMacros) {
    const res = runClassMacrosStage(
      code,
      options,
      merged.classMacros,
      merged.aotMacros,
    );
    if (res.modified) {
      code = res.code;
      modified = true;
      registeredMacroClasses = res.registered;
      aotMacroClasses = res.aotRegistered;
      if (res.registered.length > 0 && merged.classMacros) {
        stagesApplied.push("classMacros");
      }
      if (res.aotRegistered.length > 0 && merged.aotMacros) {
        stagesApplied.push("aotMacros");
      }
    }
  }

  if (merged.aotDiMetadata) {
    const res = runAotDiMetadataStage(code, options);
    if (res.modified) {
      code = res.code;
      modified = true;
      aotDiClasses = res.aotDiClasses;
      stagesApplied.push("aotDiMetadata");
    }
  }

  if (merged.autoModuleManifest && merged.expandAutoModuleGlobs) {
    const res = runAutoModuleManifestStage(code, filePath);
    if (res.modified) {
      code = res.code;
      modified = true;
      autoModuleManifests = res.manifests;
      stagesApplied.push("autoModuleManifest");
    }
  }

  if (merged.swaggerMetadata !== false) {
    const res = runSwaggerMetadataStage(code, filePath, merged.swaggerMetadata);
    if (res.modified) {
      code = res.code;
      modified = true;
      stagesApplied.push("swaggerMetadata");
    }
  }

  if (merged.transforms.length > 0) {
    let anyUserModified = false;
    for (const tr of merged.transforms) {
      if (!matchesTransformFilter(tr.filter, filePath)) continue;
      const out = await tr.transform(code, filePath);
      const nextCode = normalizeTransformOutput(out, code);
      if (nextCode !== code) {
        code = nextCode;
        modified = true;
        anyUserModified = true;
      }
    }
    if (anyUserModified) {
      stagesApplied.push("userTransforms");
    }
  }

  const tsLoader: "ts" | "tsx" = filePath.endsWith(".tsx") ? "tsx" : "ts";
  if (merged.ormCircularSafe && (modified || code.includes("@"))) {
    const transpiler = cachedTranspilers
      ? tsLoader === "tsx"
        ? cachedTranspilers.tsx
        : cachedTranspilers.ts
      : createStage5Transpiler(tsLoader, options.tsconfig);
    const js = transpiler.transformSync(code);
    const safeJs = transformCircularMetadataJs(js);
    stagesApplied.push("ormCircularSafe");
    return {
      code: safeJs,
      loader: "js",
      modified: true,
      stagesApplied,
      registeredMacroClasses,
      autoModuleManifests,
      ...(aotMacroClasses.length > 0 ? { aotMacroClasses } : {}),
      ...(aotDiClasses.length > 0 ? { aotDiClasses } : {}),
    };
  }

  return {
    code,
    loader: tsLoader,
    modified,
    stagesApplied,
    registeredMacroClasses,
    autoModuleManifests,
    ...(aotMacroClasses.length > 0 ? { aotMacroClasses } : {}),
    ...(aotDiClasses.length > 0 ? { aotDiClasses } : {}),
  };
}

// ============================================================================
// Unified Bun.plugin Factory & Registration
// ============================================================================

/**
 * Creates the single-pass unified Bunest `BunPlugin` combining:
 * - Stage 1: Class macro AST field auto-registration (`registerMacroFields`)
 * - Stage 2: `@AutoModule({ scan })` build-time static manifest injection
 * - Stage 3: Swagger / GraphQL DTO & controller metadata emission
 * - Stage 4: Custom user source transforms
 * - Stage 5: `Bun.Transpiler` + TDZ-safe `emitDecoratorMetadata` circular safety
 *
 * Uses a single `onLoad` handler so there are ZERO `onLoad` plugin conflicts.
 */
export function createBunestPlugin(
  options: BunestPluginOptions = {},
): BunPlugin {
  if (options.config) {
    applyBunestConfigRuntime(options.config);
  }

  const filter = options.filter ?? DEFAULT_FILTER;
  const exclude = options.exclude ?? DEFAULT_EXCLUDE;
  const cachedTranspilers = {
    ts: createStage5Transpiler("ts", options.tsconfig),
    tsx: createStage5Transpiler("tsx", options.tsconfig),
  };

  return {
    name: "bunest-unified-plugin",
    setup(build) {
      const buildConfig = (
        build as unknown as {
          readonly config?: { readonly entrypoints?: readonly unknown[] };
        }
      ).config;
      const detectedBuildMode = Boolean(
        buildConfig?.entrypoints && buildConfig.entrypoints.length > 0,
      );
      const effectiveOptions: BunestPluginOptions = {
        ...options,
        expandAutoModuleGlobs:
          options.expandAutoModuleGlobs ??
          options.config?.plugin?.expandAutoModuleGlobs ??
          detectedBuildMode,
      };

      const merged = resolveMergedPluginOptions(effectiveOptions);
      const hasUserTransforms = merged.transforms.length > 0;

      build.onLoad({ filter }, async (args) => {
        const defaultLoader: "ts" | "tsx" = args.path.endsWith(".tsx")
          ? "tsx"
          : "ts";
        if (exclude.test(args.path)) {
          if (detectedBuildMode) return undefined;
          return {
            contents: await Bun.file(args.path).text(),
            loader: defaultLoader,
          };
        }
        const source = await Bun.file(args.path).text();

        // Zero-cost fast path: skip untouched non-decorated files when no user transforms/metadata apply
        const mayNeedSwagger =
          merged.swaggerMetadata !== false &&
          (matchesAnySuffix(
            args.path,
            typeof merged.swaggerMetadata === "object"
              ? normalizeSuffixList(
                  merged.swaggerMetadata.dtoFileNameSuffix,
                  DEFAULT_DTO_SUFFIXES,
                )
              : DEFAULT_DTO_SUFFIXES,
          ) ||
            matchesAnySuffix(
              args.path,
              typeof merged.swaggerMetadata === "object"
                ? normalizeSuffixList(
                    merged.swaggerMetadata.controllerFileNameSuffix,
                    DEFAULT_CONTROLLER_SUFFIXES,
                  )
                : DEFAULT_CONTROLLER_SUFFIXES,
            ));

        if (!source.includes("@") && !mayNeedSwagger && !hasUserTransforms) {
          if (detectedBuildMode) return undefined;
          return { contents: source, loader: defaultLoader };
        }

        const result = await transformBunestSourceAsync(
          source,
          args.path,
          effectiveOptions,
          cachedTranspilers,
        );
        if (!result.modified && result.loader !== "js") {
          if (detectedBuildMode) return undefined;
          return { contents: source, loader: defaultLoader };
        }
        return {
          contents: result.code,
          loader: result.loader,
        };
      });
    },
  };
}

/**
 * Registers the unified Bunest transform pipeline globally via `Bun.plugin(...)`.
 * Call once in your `bunfig.toml` preload script before importing application code.
 */
export function registerBunestPlugin(
  options: BunestPluginOptions = {},
): void {
  Bun.plugin(createBunestPlugin(options));
}
