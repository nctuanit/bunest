import * as BunestCore from "@bunest/core";
import {
  dirname,
  existsSyncPath,
  join,
  readTextSync,
  resolve,
  statSyncPath,
} from "@bunest/core";
import {
  SyntaxKind,
  parseTypeScript,
  type RawArrayLiteralExpression,
  type RawCallExpression,
  type RawIdentifier,
  type RawImportDeclaration,
  type RawNode,
  type RawNumericLiteral,
  type RawObjectLiteralExpression,
  type RawPropertyAccessExpression,
  type RawPropertyAssignment,
  type RawStringLiteral,
  type RawVariableStatement,
} from "../ast";

export const GLOBAL_MACRO_DEFAULTS_SYMBOL = Symbol.for(
  "bunest:macro_defaults",
);
export const CUSTOM_MACROS_REGISTRY_SYMBOL = Symbol.for(
  "bunest:custom_macros:registry",
);
export const CUSTOM_ORM_OPERATORS_SYMBOL = Symbol.for(
  "bunest:orm:custom_query_operators",
);
export const CUSTOM_ORM_OPERATORS_VERSION_SYMBOL = Symbol.for(
  "bunest:orm:custom_query_operators_version",
);

export const BUNEST_CONFIG_FILES = [
  "bunest.config.ts",
  "bunest.config.mts",
  "bunest.config.js",
  "bunest.config.mjs",
] as const;

// ============================================================================
// Portable Structural Config Types (Zero Upward Package Dependencies)
// ============================================================================

export interface CustomMacroFieldSpecLike {
  readonly name: string;
  readonly type: string;
  readonly optional?: boolean;
  readonly readonly?: boolean;
  readonly defaultValue?: unknown;
}

export interface CustomMacroMethodSpecLike<TOptions = unknown> {
  readonly signature: string;
  readonly impl?: (self: unknown, ...args: unknown[]) => unknown;
  readonly delombokBody?: string;
  readonly _optionsBrand?: TOptions;
}

export interface CustomMacroStaticSpecLike<TOptions = unknown> {
  readonly signature: string;
  readonly impl?: (...args: unknown[]) => unknown;
  readonly delombokBody?: string;
  readonly _optionsBrand?: TOptions;
}

export interface CustomMacroGeneratedMemberLike {
  readonly kind: "instance" | "static" | "builder";
  readonly name: string;
  readonly signature: string;
  readonly sourceDecorator?: string;
}

export interface CustomMacroTypegenContextLike<TOptions = any> {
  readonly className: string;
  readonly fields: readonly {
    readonly name: string;
    readonly typeText: string;
    readonly optional: boolean;
    readonly isReadonly: boolean;
  }[];
  readonly options: TOptions;
  readonly decorators?: readonly string[];
  readonly ownMethodNames?: readonly string[];
  readonly ownPropertyNames?: readonly string[];
  readonly sourceFile?: string;
}

export interface CustomMacroDelombokContextLike<TOptions = any> {
  readonly className: string;
  readonly fields: readonly {
    readonly name: string;
    readonly typeText: string;
    readonly optional: boolean;
    readonly isReadonly: boolean;
  }[];
  readonly options: TOptions;
  readonly indent?: string;
  readonly ownMethodNames?: readonly string[];
  readonly ownPropertyNames?: readonly string[];
}

export interface CustomMacroDefinitionLike<TOptions = any> {
  readonly name: string;
  readonly compose?: (options: TOptions) => readonly ClassDecorator[];
  readonly composedNames?: readonly string[];
  readonly fields?: readonly CustomMacroFieldSpecLike[];
  readonly methods?: Readonly<
    Record<string, CustomMacroMethodSpecLike<TOptions>>
  >;
  readonly statics?: Readonly<
    Record<string, CustomMacroStaticSpecLike<TOptions>>
  >;
  readonly apply?: (ctx: any) => void;
  readonly typegen?: (
    ctx: CustomMacroTypegenContextLike<TOptions>,
  ) => readonly CustomMacroGeneratedMemberLike[];
  readonly delombok?: (
    ctx: CustomMacroDelombokContextLike<TOptions>,
  ) => readonly string[];
}

export type CustomMacroPluginInput =
  | CustomMacroDefinitionLike<any>
  | {
      readonly macroDefinition: CustomMacroDefinitionLike<any>;
      readonly macroName?: string;
    };

export interface GlobalMacroDefaultsLike {
  readonly accessors?: {
    readonly fluent?: boolean;
    readonly chain?: boolean;
    readonly prefix?: string | readonly string[];
  };
  readonly toString?:
    | {
        readonly include?: readonly string[];
        readonly exclude?: readonly string[];
        readonly mask?: readonly string[];
        readonly maskValue?: string;
        readonly callSuper?: boolean;
        readonly includeFieldNames?: boolean;
        readonly onlyExplicitlyIncluded?: boolean;
      }
    | (() => string);
  readonly toStringOptions?: {
    readonly include?: readonly string[];
    readonly exclude?: readonly string[];
    readonly mask?: readonly string[];
    readonly maskValue?: string;
    readonly callSuper?: boolean;
    readonly includeFieldNames?: boolean;
    readonly onlyExplicitlyIncluded?: boolean;
  };
  readonly equalsAndHashCode?: {
    readonly include?: readonly string[];
    readonly exclude?: readonly string[];
    readonly callSuper?: boolean;
    readonly deep?: boolean;
    readonly onlyExplicitlyIncluded?: boolean;
  };
  readonly builder?: {
    readonly toBuilder?: boolean;
    readonly builderMethodName?: string;
    readonly buildMethodName?: string;
    readonly setterPrefix?: string;
  };
  readonly data?: {
    readonly accessorsEnabled?: boolean;
    readonly accessors?: GlobalMacroDefaultsLike["accessors"];
    readonly exclude?: readonly string[];
    readonly mask?: readonly string[];
  };
  readonly value?: {
    readonly accessors?: GlobalMacroDefaultsLike["accessors"];
    readonly exclude?: readonly string[];
    readonly mask?: readonly string[];
  };
  readonly jsonSerializable?: {
    readonly exclude?: readonly string[];
  };
  readonly withLogger?: {
    readonly propertyName?: string;
    readonly context?: string;
  };
  readonly fieldNameConstants?: {
    readonly innerName?: string;
    readonly uppercase?: boolean;
    readonly onlyExplicitlyIncluded?: boolean;
  };
}

export interface CustomQueryOperatorSqlContextLike {
  readonly column: string;
  readonly quotedColumn: string;
  readonly property: string;
  readonly propertyName: string;
  readonly dialect: "sqlite" | "postgres" | "mysql";
  readonly args: readonly unknown[];
  readonly ignoreCase: boolean;
  readonly nextPlaceholder: () => string;
  readonly placeholder: (index?: number) => string;
  readonly placeholders: readonly string[];
  readonly quoteIdentifier: (identifier: string, context?: string) => string;
  readonly serializeValue: (value: unknown) => unknown;
}

export interface CustomQueryOperatorConfigLike {
  readonly suffix: string;
  readonly arity: number;
  readonly toSql?: (
    ctx: any,
  ) => { readonly sql: string; readonly params?: readonly unknown[] } | string;
  readonly description?: string;
  readonly allowedCategories?: readonly (
    | "string"
    | "number"
    | "boolean"
    | "date"
    | "other"
  )[];
  readonly expectsArrayParam?: boolean;
}

export interface BunestSourceTransformConfigLike {
  readonly name: string;
  readonly filter?: RegExp | ((filePath: string) => boolean);
  readonly transform: (
    source: string,
    filePath: string,
  ) =>
    | string
    | { readonly code: string }
    | null
    | undefined
    | void
    | Promise<string | { readonly code: string } | null | undefined | void>;
}

export interface BunestTypegenPluginConfigLike<TData = any> {
  readonly name: string;
  readonly target?: string;
  readonly scan: (ctx: any) => TData | Promise<TData>;
  readonly emit: (data: TData, ctx: any) => string | readonly string[];
}

export interface BunestDiagnosticRuleConfigLike {
  readonly code: string;
  readonly severity: "error" | "warning" | "info";
  readonly description: string;
  readonly check: (ctx: any) => readonly any[];
}

export interface BunestConfigLike {
  readonly macros?: {
    readonly defaults?: GlobalMacroDefaultsLike;
    readonly presets?: Readonly<Record<string, readonly string[]>>;
    readonly plugins?: readonly CustomMacroPluginInput[];
  };
  readonly orm?: {
    readonly queryOperators?: readonly CustomQueryOperatorConfigLike[];
    readonly defaultScopes?: readonly string[];
  };
  readonly aop?: {
    readonly pointcuts?: readonly unknown[];
  };
  readonly typegen?: {
    readonly enabled?: boolean;
    readonly outDir?: string;
    readonly fileName?: string;
    readonly sourceRoot?: string;
    readonly tsconfigPath?: string;
    readonly envFiles?: readonly string[];
    readonly include?: readonly string[];
    readonly includeGlobalNamespace?: boolean;
    readonly plugins?: readonly BunestTypegenPluginConfigLike[];
  };
  readonly diagnostics?: {
    readonly rules?: readonly BunestDiagnosticRuleConfigLike[];
    readonly presetRules?: readonly string[];
  };
  readonly plugin?: {
    readonly classMacros?: boolean;
    readonly swaggerMetadata?: boolean | Record<string, unknown>;
    readonly ormCircularSafe?: boolean;
    readonly autoModuleManifest?: boolean;
    readonly expandAutoModuleGlobs?: boolean;
    readonly aotMacros?: boolean;
    readonly aotDiMetadata?: boolean;
    readonly transforms?: readonly BunestSourceTransformConfigLike[];
  };
}

export interface LoadBunestConfigOptions {
  /** Explicit path to a bunest config file (absolute or relative to `cwd`). */
  readonly configPath?: string;
  /**
   * Apply loaded `macros.defaults`, `macros.plugins`, and `orm.queryOperators`
   * to the single-realm global registries immediately after loading.
   * @default true
   */
  readonly applyRuntime?: boolean;
  /**
   * Bypass Bun's ESM module cache using file mtime / cache-busting query param.
   * @default true
   */
  readonly cacheBust?: boolean;
}

export interface LoadedBunestConfig {
  readonly config: BunestConfigLike;
  readonly configPath: string | null;
}

// ============================================================================
// Single-Realm Global Registry Bridges
// ============================================================================

function getGlobalStore(): Record<symbol, unknown> {
  return globalThis as unknown as Record<symbol, unknown>;
}

export function unwrapCustomMacroDefinition(
  input: CustomMacroPluginInput,
): CustomMacroDefinitionLike<any> {
  if (
    typeof input === "object" &&
    input !== null &&
    "macroDefinition" in input &&
    input.macroDefinition
  ) {
    return input.macroDefinition;
  }
  if (typeof input === "function" && "macroDefinition" in input) {
    return (
      input as unknown as {
        readonly macroDefinition: CustomMacroDefinitionLike<any>;
      }
    ).macroDefinition;
  }
  return input as CustomMacroDefinitionLike<any>;
}

export function getCustomMacrosRegistryMap(): Map<
  string,
  CustomMacroDefinitionLike<any>
> {
  const store = getGlobalStore();
  let map = store[CUSTOM_MACROS_REGISTRY_SYMBOL] as
    | Map<string, CustomMacroDefinitionLike<any>>
    | undefined;
  if (!(map instanceof Map)) {
    map = new Map<string, CustomMacroDefinitionLike<any>>();
    store[CUSTOM_MACROS_REGISTRY_SYMBOL] = map;
  }
  return map;
}

export function getCustomQueryOperatorsRegistryMap(): Map<
  string,
  CustomQueryOperatorConfigLike
> {
  const store = getGlobalStore();
  let map = store[CUSTOM_ORM_OPERATORS_SYMBOL] as
    | Map<string, CustomQueryOperatorConfigLike>
    | undefined;
  if (!(map instanceof Map)) {
    map = new Map<string, CustomQueryOperatorConfigLike>();
    store[CUSTOM_ORM_OPERATORS_SYMBOL] = map;
  }
  return map;
}

export function getGlobalMacroDefaultsSnapshot(
  override?: GlobalMacroDefaultsLike,
): GlobalMacroDefaultsLike {
  const store = getGlobalStore();
  const coreMod = BunestCore as unknown as Record<string, unknown>;
  let globalDefaults: GlobalMacroDefaultsLike | undefined;
  if (typeof coreMod.getGlobalMacroDefaults === "function") {
    globalDefaults = (
      coreMod.getGlobalMacroDefaults as () => GlobalMacroDefaultsLike
    )();
  } else {
    globalDefaults = store[GLOBAL_MACRO_DEFAULTS_SYMBOL] as
      | GlobalMacroDefaultsLike
      | undefined;
  }

  if (!globalDefaults && !override) return {};
  if (!override) return globalDefaults ?? {};
  if (!globalDefaults) return override;

  const getOwnToStringObj = (
    d?: GlobalMacroDefaultsLike,
  ): NonNullable<GlobalMacroDefaultsLike["toStringOptions"]> | undefined => {
    if (!d) return undefined;
    if (
      Object.prototype.hasOwnProperty.call(d, "toString") &&
      typeof d.toString === "object" &&
      d.toString !== null
    ) {
      return d.toString;
    }
    return d.toStringOptions;
  };
  const baseToString = getOwnToStringObj(globalDefaults);
  const overrideToString = getOwnToStringObj(override);

  return {
    ...globalDefaults,
    ...override,
    accessors:
      globalDefaults.accessors || override.accessors
        ? { ...globalDefaults.accessors, ...override.accessors }
        : undefined,
    toString:
      baseToString || overrideToString
        ? { ...baseToString, ...overrideToString }
        : undefined,
    toStringOptions:
      baseToString || overrideToString
        ? { ...baseToString, ...overrideToString }
        : undefined,
    equalsAndHashCode:
      globalDefaults.equalsAndHashCode || override.equalsAndHashCode
        ? { ...globalDefaults.equalsAndHashCode, ...override.equalsAndHashCode }
        : undefined,
    builder:
      globalDefaults.builder || override.builder
        ? { ...globalDefaults.builder, ...override.builder }
        : undefined,
    data:
      globalDefaults.data || override.data
        ? { ...globalDefaults.data, ...override.data }
        : undefined,
    value:
      globalDefaults.value || override.value
        ? { ...globalDefaults.value, ...override.value }
        : undefined,
    jsonSerializable:
      globalDefaults.jsonSerializable || override.jsonSerializable
        ? { ...globalDefaults.jsonSerializable, ...override.jsonSerializable }
        : undefined,
    withLogger:
      globalDefaults.withLogger || override.withLogger
        ? { ...globalDefaults.withLogger, ...override.withLogger }
        : undefined,
    fieldNameConstants:
      globalDefaults.fieldNameConstants || override.fieldNameConstants
        ? {
            ...globalDefaults.fieldNameConstants,
            ...override.fieldNameConstants,
          }
        : undefined,
  };
}

/**
 * Returns all custom macro definitions discovered from the single-realm global
 * registry plus any definitions passed via `bunest.config.ts` or options.
 */
export function collectCustomMacros(
  config?: BunestConfigLike,
  extraPlugins?: readonly CustomMacroPluginInput[],
): Map<string, CustomMacroDefinitionLike<any>> {
  const merged = new Map<string, CustomMacroDefinitionLike<any>>();
  const globalReg = getGlobalStore()[CUSTOM_MACROS_REGISTRY_SYMBOL];
  if (globalReg instanceof Map) {
    for (const [key, def] of globalReg.entries()) {
      if (def && typeof def === "object" && typeof def.name === "string") {
        merged.set(key, def as CustomMacroDefinitionLike<any>);
      }
    }
  }
  for (const item of config?.macros?.plugins ?? []) {
    const def = unwrapCustomMacroDefinition(item);
    if (def && typeof def.name === "string" && def.name.length > 0) {
      merged.set(def.name, def);
    }
  }
  for (const item of extraPlugins ?? []) {
    const def = unwrapCustomMacroDefinition(item);
    if (def && typeof def.name === "string" && def.name.length > 0) {
      merged.set(def.name, def);
    }
  }
  return merged;
}

/**
 * Returns all custom ORM query operators registered in the single-realm global
 * registry plus any operators passed via `bunest.config.ts` or options.
 */
export function collectCustomQueryOperators(
  config?: BunestConfigLike,
  extraOperators?: readonly CustomQueryOperatorConfigLike[],
): CustomQueryOperatorConfigLike[] {
  const bySuffix = new Map<string, CustomQueryOperatorConfigLike>();
  const globalReg = getGlobalStore()[CUSTOM_ORM_OPERATORS_SYMBOL];
  if (globalReg instanceof Map) {
    for (const [suffix, op] of globalReg.entries()) {
      if (op && typeof op === "object" && typeof op.suffix === "string") {
        bySuffix.set(suffix, op as CustomQueryOperatorConfigLike);
      }
    }
  }
  for (const op of config?.orm?.queryOperators ?? []) {
    if (op && typeof op.suffix === "string" && op.suffix.length > 0) {
      bySuffix.set(op.suffix, op);
    }
  }
  for (const op of extraOperators ?? []) {
    if (op && typeof op.suffix === "string" && op.suffix.length > 0) {
      bySuffix.set(op.suffix, op);
    }
  }
  return [...bySuffix.values()].sort(
    (a, b) => b.suffix.length - a.suffix.length,
  );
}

/**
 * Applies a loaded `BunestConfig` to runtime global registries:
 * - `config.macros.defaults` → `@bunest/core`'s `setGlobalMacroDefaults` (when available) + global symbol
 * - `config.macros.plugins` → `@bunest/core`'s `registerCustomMacro` (when available) + global registry
 * - `config.orm.queryOperators` → global `Symbol.for("bunest:orm:custom_query_operators")` registry
 */
export function applyBunestConfigRuntime(config: BunestConfigLike): void {
  const coreMod = BunestCore as unknown as Record<string, unknown>;
  const store = getGlobalStore();

  if (config.macros?.defaults) {
    if (typeof coreMod.setGlobalMacroDefaults === "function") {
      (
        coreMod.setGlobalMacroDefaults as (
          defaults: GlobalMacroDefaultsLike,
        ) => void
      )(config.macros.defaults);
    } else {
      store[GLOBAL_MACRO_DEFAULTS_SYMBOL] = getGlobalMacroDefaultsSnapshot(
        config.macros.defaults,
      );
    }
  }

  if (config.macros?.plugins && config.macros.plugins.length > 0) {
    const reg = getCustomMacrosRegistryMap();
    for (const item of config.macros.plugins) {
      const def = unwrapCustomMacroDefinition(item);
      if (!def || typeof def.name !== "string" || def.name.length === 0) {
        continue;
      }
      if (typeof coreMod.registerCustomMacro === "function") {
        (
          coreMod.registerCustomMacro as (
            d: CustomMacroDefinitionLike<any>,
          ) => void
        )(def);
      }
      reg.set(def.name, def);
    }
  }

  if (config.orm?.queryOperators && config.orm.queryOperators.length > 0) {
    const opReg = getCustomQueryOperatorsRegistryMap();
    for (const op of config.orm.queryOperators) {
      if (op && typeof op.suffix === "string" && op.suffix.length > 0) {
        opReg.set(op.suffix, op);
      }
    }
    const prevVer = store[CUSTOM_ORM_OPERATORS_VERSION_SYMBOL];
    store[CUSTOM_ORM_OPERATORS_VERSION_SYMBOL] =
      (typeof prevVer === "number" ? prevVer : 0) + 1;
  }
}

// ============================================================================
// bunest.config.{ts,mts,js,mjs} Discovery & Loader
// ============================================================================

export function findBunestConfigPath(
  cwd: string,
  explicitPath?: string,
): string | null {
  const baseDir = resolve(cwd);
  if (explicitPath) {
    const abs = resolve(baseDir, explicitPath);
    return existsSyncPath(abs) ? abs : null;
  }

  for (const fileName of BUNEST_CONFIG_FILES) {
    const candidate = join(baseDir, fileName);
    if (existsSyncPath(candidate)) {
      return candidate;
    }
  }
  return null;
}

function pathToFileUrlHref(absPath: string): string {
  if (typeof Bun !== "undefined" && typeof Bun.pathToFileURL === "function") {
    return Bun.pathToFileURL(absPath).href;
  }
  const normalized = absPath.replace(/\\/g, "/");
  const prefixed = normalized.startsWith("/") ? normalized : `/${normalized}`;
  const encoded = prefixed
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  return `file://${encoded}`;
}

interface StaticFileContext {
  readonly filePath: string;
  readonly imports: Map<string, { readonly specifier: string; readonly importedName: string }>;
  readonly vars: Map<string, RawNode>;
}

function resolveRelativeTsFile(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.mts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.mjs`,
    join(base, "index.ts"),
    join(base, "index.js"),
  ];
  for (const c of candidates) {
    if (existsSyncPath(c)) {
      try {
        if (statSyncPath(c).isFile()) return c;
      } catch {
        // ignore
      }
    }
  }
  return null;
}

function buildStaticFileContext(
  filePath: string,
  cache: Map<string, StaticFileContext>,
): StaticFileContext | null {
  const cached = cache.get(filePath);
  if (cached) return cached;
  if (!existsSyncPath(filePath)) return null;
  let source: string;
  try {
    source = readTextSync(filePath);
  } catch {
    return null;
  }
  const ast = parseTypeScript(source);
  const imports = new Map<
    string,
    { readonly specifier: string; readonly importedName: string }
  >();
  const vars = new Map<string, RawNode>();

  for (const stmt of ast.statements) {
    if (stmt.kind === SyntaxKind.ImportDeclaration) {
      const imp = stmt as RawImportDeclaration;
      const spec = imp.moduleSpecifier.value;
      for (const named of imp.namedImports) {
        const local = named.alias?.text ?? named.name.text;
        imports.set(local, { specifier: spec, importedName: named.name.text });
      }
    } else if (stmt.kind === SyntaxKind.VariableStatement) {
      const vs = stmt as RawVariableStatement;
      for (const decl of vs.declarations) {
        if (decl.name.kind === SyntaxKind.Identifier && decl.initializer) {
          vars.set((decl.name as RawIdentifier).text, decl.initializer);
        }
      }
    }
  }

  const ctx: StaticFileContext = { filePath, imports, vars };
  cache.set(filePath, ctx);
  return ctx;
}

function unwrapExpr(node: RawNode | undefined): RawNode | undefined {
  let curr = node;
  while (curr) {
    if (
      curr.kind === SyntaxKind.ParenthesizedExpression ||
      curr.kind === SyntaxKind.AsExpression ||
      curr.kind === SyntaxKind.SatisfiesExpression
    ) {
      curr = (curr as RawNode & { readonly expression: RawNode }).expression;
      continue;
    }
    break;
  }
  return curr;
}

function getPropNameText(nameNode: RawNode): string | null {
  if (nameNode.kind === SyntaxKind.Identifier) {
    return (nameNode as RawIdentifier).text;
  }
  if (
    nameNode.kind === SyntaxKind.StringLiteral ||
    nameNode.kind === SyntaxKind.NoSubstitutionTemplateLiteral
  ) {
    return (nameNode as RawStringLiteral).value;
  }
  if (nameNode.kind === SyntaxKind.NumericLiteral) {
    return String((nameNode as RawNumericLiteral).value);
  }
  return null;
}

function getObjProp(
  obj: RawObjectLiteralExpression,
  propName: string,
): RawNode | undefined {
  for (const prop of obj.properties) {
    if (prop.kind === SyntaxKind.PropertyAssignment) {
      const pa = prop as RawPropertyAssignment;
      if (getPropNameText(pa.name) === propName) {
        return unwrapExpr(pa.initializer);
      }
    }
  }
  return undefined;
}

function evalStaticLiteral(node: RawNode | undefined): unknown {
  const n = unwrapExpr(node);
  if (!n) return undefined;
  if (
    n.kind === SyntaxKind.StringLiteral ||
    n.kind === SyntaxKind.NoSubstitutionTemplateLiteral
  ) {
    return (n as RawStringLiteral).value;
  }
  if (n.kind === SyntaxKind.NumericLiteral) {
    return (n as RawNumericLiteral).value;
  }
  if (n.kind === SyntaxKind.TrueKeyword) return true;
  if (n.kind === SyntaxKind.FalseKeyword) return false;
  if (n.kind === SyntaxKind.NullKeyword) return null;
  if (n.kind === SyntaxKind.ArrayLiteralExpression) {
    return (n as RawArrayLiteralExpression).elements
      .map((el) => evalStaticLiteral(el))
      .filter((v) => v !== undefined);
  }
  if (n.kind === SyntaxKind.ObjectLiteralExpression) {
    const out: Record<string, unknown> = {};
    for (const prop of (n as RawObjectLiteralExpression).properties) {
      if (prop.kind === SyntaxKind.PropertyAssignment) {
        const pa = prop as RawPropertyAssignment;
        const key = getPropNameText(pa.name);
        if (key !== null) {
          const val = evalStaticLiteral(pa.initializer);
          if (val !== undefined) out[key] = val;
        }
      }
    }
    return out;
  }
  return undefined;
}

function resolveExprAcrossFiles(
  expr: RawNode | undefined,
  ctx: StaticFileContext,
  cache: Map<string, StaticFileContext>,
  depth = 0,
): { readonly node: RawNode; readonly ctx: StaticFileContext } | null {
  if (depth > 4) return null;
  const n = unwrapExpr(expr);
  if (!n) return null;

  // Handle `Auditable.macroDefinition` -> resolve `Auditable`
  if (n.kind === SyntaxKind.PropertyAccessExpression) {
    const pa = n as RawPropertyAccessExpression;
    if (pa.name.text === "macroDefinition") {
      return resolveExprAcrossFiles(pa.expression, ctx, cache, depth + 1);
    }
  }

  if (n.kind === SyntaxKind.Identifier) {
    const name = (n as RawIdentifier).text;
    const localInit = ctx.vars.get(name);
    if (localInit) {
      return resolveExprAcrossFiles(localInit, ctx, cache, depth + 1);
    }
    const imp = ctx.imports.get(name);
    if (imp) {
      const targetFile = resolveRelativeTsFile(ctx.filePath, imp.specifier);
      if (targetFile) {
        const targetCtx = buildStaticFileContext(targetFile, cache);
        if (targetCtx) {
          const exportedInit = targetCtx.vars.get(imp.importedName);
          if (exportedInit) {
            return resolveExprAcrossFiles(
              exportedInit,
              targetCtx,
              cache,
              depth + 1,
            );
          }
        }
      }
    }
  }

  return { node: n, ctx };
}

function extractStaticMacroDef(
  expr: RawNode,
  ctx: StaticFileContext,
  cache: Map<string, StaticFileContext>,
): CustomMacroDefinitionLike | null {
  const resolved = resolveExprAcrossFiles(expr, ctx, cache);
  if (!resolved) return null;
  let objNode: RawObjectLiteralExpression | undefined;
  if (resolved.node.kind === SyntaxKind.ObjectLiteralExpression) {
    objNode = resolved.node as RawObjectLiteralExpression;
  } else if (resolved.node.kind === SyntaxKind.CallExpression) {
    const call = resolved.node as RawCallExpression;
    const callee =
      call.expression.kind === SyntaxKind.Identifier
        ? (call.expression as RawIdentifier).text
        : "";
    if (callee === "defineClassMacro" && call.arguments[0]) {
      const arg0 = unwrapExpr(call.arguments[0]);
      if (arg0?.kind === SyntaxKind.ObjectLiteralExpression) {
        objNode = arg0 as RawObjectLiteralExpression;
      }
    } else if (callee === "defineMacroPreset" && call.arguments[0]) {
      const nameVal = evalStaticLiteral(call.arguments[0]);
      const composedVal = call.arguments[2]
        ? evalStaticLiteral(call.arguments[2])
        : undefined;
      if (typeof nameVal === "string" && nameVal.length > 0) {
        return {
          name: nameVal,
          composedNames: Array.isArray(composedVal)
            ? composedVal.filter((v): v is string => typeof v === "string")
            : undefined,
        };
      }
    }
  }
  if (!objNode) return null;
  const name = evalStaticLiteral(getObjProp(objNode, "name"));
  if (typeof name !== "string" || name.length === 0) return null;

  const fieldsRaw = evalStaticLiteral(getObjProp(objNode, "fields"));
  const composedNamesRaw = evalStaticLiteral(getObjProp(objNode, "composedNames"));

  const methods: Record<string, CustomMacroMethodSpecLike> = {};
  const methodsNode = getObjProp(objNode, "methods");
  if (methodsNode?.kind === SyntaxKind.ObjectLiteralExpression) {
    for (const p of (methodsNode as RawObjectLiteralExpression).properties) {
      if (p.kind !== SyntaxKind.PropertyAssignment) continue;
      const pa = p as RawPropertyAssignment;
      const mName = getPropNameText(pa.name);
      const mObj = unwrapExpr(pa.initializer);
      if (mName && mObj?.kind === SyntaxKind.ObjectLiteralExpression) {
        const sig = evalStaticLiteral(
          getObjProp(mObj as RawObjectLiteralExpression, "signature"),
        );
        const delombokBody = evalStaticLiteral(
          getObjProp(mObj as RawObjectLiteralExpression, "delombokBody"),
        );
        if (typeof sig === "string") {
          methods[mName] = {
            signature: sig,
            ...(typeof delombokBody === "string" ? { delombokBody } : {}),
          };
        }
      }
    }
  }

  const statics: Record<string, CustomMacroStaticSpecLike> = {};
  const staticsNode = getObjProp(objNode, "statics");
  if (staticsNode?.kind === SyntaxKind.ObjectLiteralExpression) {
    for (const p of (staticsNode as RawObjectLiteralExpression).properties) {
      if (p.kind !== SyntaxKind.PropertyAssignment) continue;
      const pa = p as RawPropertyAssignment;
      const sName = getPropNameText(pa.name);
      const sObj = unwrapExpr(pa.initializer);
      if (sName && sObj?.kind === SyntaxKind.ObjectLiteralExpression) {
        const sig = evalStaticLiteral(
          getObjProp(sObj as RawObjectLiteralExpression, "signature"),
        );
        const delombokBody = evalStaticLiteral(
          getObjProp(sObj as RawObjectLiteralExpression, "delombokBody"),
        );
        if (typeof sig === "string") {
          statics[sName] = {
            signature: sig,
            ...(typeof delombokBody === "string" ? { delombokBody } : {}),
          };
        }
      }
    }
  }

  return {
    name,
    ...(Array.isArray(composedNamesRaw)
      ? {
          composedNames: composedNamesRaw.filter(
            (v): v is string => typeof v === "string",
          ),
        }
      : {}),
    ...(Array.isArray(fieldsRaw)
      ? { fields: fieldsRaw as CustomMacroFieldSpecLike[] }
      : {}),
    ...(Object.keys(methods).length > 0 ? { methods } : {}),
    ...(Object.keys(statics).length > 0 ? { statics } : {}),
  };
}

function extractStaticQueryOperator(
  expr: RawNode,
  ctx: StaticFileContext,
  cache: Map<string, StaticFileContext>,
): CustomQueryOperatorConfigLike | null {
  const resolved = resolveExprAcrossFiles(expr, ctx, cache);
  if (!resolved || resolved.node.kind !== SyntaxKind.ObjectLiteralExpression) {
    return null;
  }
  const obj = resolved.node as RawObjectLiteralExpression;
  const suffix = evalStaticLiteral(getObjProp(obj, "suffix"));
  const arity = evalStaticLiteral(getObjProp(obj, "arity"));
  const description = evalStaticLiteral(getObjProp(obj, "description"));
  if (typeof suffix !== "string" || suffix.length === 0) return null;
  return {
    suffix,
    arity: typeof arity === "number" ? arity : 1,
    ...(typeof description === "string" ? { description } : {}),
  };
}

const KNOWN_ARCH_RULE_IDENTIFIERS: Readonly<Record<string, string>> = {
  noRepositoryInControllerRule: "no-repository-in-controller",
  requireGuardOnMutationsRule: "require-guard-on-mutations",
};

/**
 * Pure-TS static AST fallback used when `loadBunestConfig()` runs inside a
 * non-Bun Node.js / Electron host (e.g., VS Code Extension Host) that cannot
 * directly `import()` a TypeScript `bunest.config.ts` with workspace specifiers.
 */
function extractStaticBunestConfigFromAst(configPath: string): BunestConfigLike {
  const cache = new Map<string, StaticFileContext>();
  const rootCtx = buildStaticFileContext(configPath, cache);
  if (!rootCtx) return {};

  const source = readTextSync(configPath);
  const ast = parseTypeScript(source);

  let defaultExpr: RawNode | undefined;
  for (const stmt of ast.statements) {
    if (stmt.kind === SyntaxKind.ExportAssignment) {
      defaultExpr = unwrapExpr(
        (stmt as RawNode & { readonly expression: RawNode }).expression,
      );
      break;
    }
  }
  if (!defaultExpr) return {};

  // Unwrap `defineBunestConfig({ ... })`
  let rootObj: RawObjectLiteralExpression | undefined;
  if (defaultExpr.kind === SyntaxKind.CallExpression) {
    const call = defaultExpr as RawCallExpression;
    const arg0 = unwrapExpr(call.arguments[0]);
    if (arg0?.kind === SyntaxKind.ObjectLiteralExpression) {
      rootObj = arg0 as RawObjectLiteralExpression;
    }
  } else if (defaultExpr.kind === SyntaxKind.ObjectLiteralExpression) {
    rootObj = defaultExpr as RawObjectLiteralExpression;
  }
  if (!rootObj) return {};

  const out: {
    macros?: {
      defaults?: GlobalMacroDefaultsLike;
      presets?: Record<string, readonly string[]>;
      plugins?: CustomMacroDefinitionLike[];
    };
    orm?: {
      queryOperators?: CustomQueryOperatorConfigLike[];
      defaultScopes?: readonly string[];
    };
    diagnostics?: {
      presetRules?: string[];
    };
    typegen?: BunestConfigLike["typegen"];
  } = {};

  // 1. macros
  const macrosNode = getObjProp(rootObj, "macros");
  if (macrosNode?.kind === SyntaxKind.ObjectLiteralExpression) {
    const mObj = macrosNode as RawObjectLiteralExpression;
    const defaults = evalStaticLiteral(getObjProp(mObj, "defaults"));
    const presets = evalStaticLiteral(getObjProp(mObj, "presets"));
    const pluginsNode = getObjProp(mObj, "plugins");
    const plugins: CustomMacroDefinitionLike[] = [];
    if (pluginsNode?.kind === SyntaxKind.ArrayLiteralExpression) {
      for (const el of (pluginsNode as RawArrayLiteralExpression).elements) {
        const def = extractStaticMacroDef(el, rootCtx, cache);
        if (def) plugins.push(def);
      }
    }
    out.macros = {
      ...(defaults && typeof defaults === "object"
        ? { defaults: defaults as GlobalMacroDefaultsLike }
        : {}),
      ...(presets && typeof presets === "object"
        ? { presets: presets as Record<string, readonly string[]> }
        : {}),
      ...(plugins.length > 0 ? { plugins } : {}),
    };
  }

  // 2. orm
  const ormNode = getObjProp(rootObj, "orm");
  if (ormNode?.kind === SyntaxKind.ObjectLiteralExpression) {
    const oObj = ormNode as RawObjectLiteralExpression;
    const opsNode = getObjProp(oObj, "queryOperators");
    const queryOperators: CustomQueryOperatorConfigLike[] = [];
    if (opsNode?.kind === SyntaxKind.ArrayLiteralExpression) {
      for (const el of (opsNode as RawArrayLiteralExpression).elements) {
        const op = extractStaticQueryOperator(el, rootCtx, cache);
        if (op) queryOperators.push(op);
      }
    }
    const defaultScopes = evalStaticLiteral(getObjProp(oObj, "defaultScopes"));
    out.orm = {
      ...(queryOperators.length > 0 ? { queryOperators } : {}),
      ...(Array.isArray(defaultScopes)
        ? {
            defaultScopes: defaultScopes.filter(
              (s): s is string => typeof s === "string",
            ),
          }
        : {}),
    };
  }

  // 3. diagnostics (presetRules + known built-in rule identifiers in `rules`)
  const diagNode = getObjProp(rootObj, "diagnostics");
  if (diagNode?.kind === SyntaxKind.ObjectLiteralExpression) {
    const dObj = diagNode as RawObjectLiteralExpression;
    const presetSet = new Set<string>();
    const rawPresets = evalStaticLiteral(getObjProp(dObj, "presetRules"));
    if (Array.isArray(rawPresets)) {
      for (const p of rawPresets) {
        if (typeof p === "string") presetSet.add(p);
      }
    }
    const rulesNode = getObjProp(dObj, "rules");
    if (rulesNode?.kind === SyntaxKind.ArrayLiteralExpression) {
      for (const el of (rulesNode as RawArrayLiteralExpression).elements) {
        const unwrapped = unwrapExpr(el);
        if (unwrapped?.kind === SyntaxKind.Identifier) {
          const ident = (unwrapped as RawIdentifier).text;
          const mapped = KNOWN_ARCH_RULE_IDENTIFIERS[ident];
          if (mapped) presetSet.add(mapped);
        }
      }
    }
    if (presetSet.size > 0) {
      out.diagnostics = { presetRules: [...presetSet] };
    }
  }

  // 4. typegen
  const typegenVal = evalStaticLiteral(getObjProp(rootObj, "typegen"));
  if (typegenVal && typeof typegenVal === "object") {
    out.typegen = typegenVal as BunestConfigLike["typegen"];
  }

  return out;
}

/**
 * Loads `bunest.config.ts`, `bunest.config.mts`, `bunest.config.js`, or
 * `bunest.config.mjs` from `cwd` via native Bun dynamic `import()`.
 *
 * When running inside a Node.js / Electron host (such as the VS Code Extension
 * Host where `Bun` is undefined) and dynamic `import()` cannot execute a
 * TypeScript config file with workspace specifiers, falls back seamlessly to
 * Bunest's pure-TS static AST extractor.
 *
 * Returns `{ config: {}, configPath: null }` when no config file exists.
 * When `applyRuntime` is true (default), applies `macros.defaults`,
 * `macros.plugins`, and `orm.queryOperators` to the shared runtime registries.
 */
export async function loadBunestConfig(
  cwd = process.cwd(),
  options: LoadBunestConfigOptions = {},
): Promise<LoadedBunestConfig> {
  const configPath = findBunestConfigPath(cwd, options.configPath);
  if (!configPath) {
    return { config: {}, configPath: null };
  }

  let importHref = pathToFileUrlHref(configPath);
  if (options.cacheBust !== false) {
    try {
      const stat = statSyncPath(configPath);
      const stamp = `${stat.mtimeMs}-${stat.size}`;
      importHref = `${importHref}?bunest_v=${encodeURIComponent(stamp)}`;
    } catch {
      // Fall back to direct file URL when stat is unavailable
    }
  }

  let config: BunestConfigLike;
  try {
    const mod = (await import(importHref)) as Record<string, unknown>;
    let raw: unknown = mod.default ?? mod.config ?? mod;
    if (typeof raw === "function") {
      raw = await (raw as () => unknown | Promise<unknown>)();
    }
    config = raw && typeof raw === "object" ? (raw as BunestConfigLike) : {};
  } catch (err) {
    if (typeof Bun === "undefined" && /\.m?ts$/i.test(configPath)) {
      config = extractStaticBunestConfigFromAst(configPath);
    } else {
      throw err;
    }
  }

  if (options.applyRuntime !== false) {
    applyBunestConfigRuntime(config);
  }

  return {
    config,
    configPath,
  };
}
