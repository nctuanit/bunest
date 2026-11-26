// ============================================================================
// Unified `bunest.config.ts` Schema (Structural & Zero Upward Dependencies)
// ============================================================================

/**
 * Structural SQL context shape for custom `@bunest/orm` derived query operators.
 */
export interface BunestQueryOperatorSqlContext {
  readonly column: string;
  readonly quotedColumn: string;
  readonly property: string;
  readonly args: readonly unknown[];
  readonly dialect: string;
  readonly placeholder: (index?: number) => string;
  readonly [key: string]: unknown;
}

/**
 * Structural configuration entry for a custom `@bunest/orm` derived query operator
 * (compatible with `@bunest/orm`'s `CustomQueryOperator` without creating an upward dependency).
 */
export interface BunestQueryOperatorConfig {
  /** PascalCase operator suffix recognized in derived finder method names (e.g. `"Matches"`, `"JsonContains"`). */
  readonly suffix: string;
  /** Number of method arguments consumed by this operator (`0`, `1`, `2`, ...). */
  readonly arity: number;
  /** Compiles the operator into a parameterized SQL predicate fragment. */
  readonly toSql?: (ctx: any) => {
    readonly sql: string;
    readonly params?: readonly unknown[];
  };
  /** Optional human-readable description surfaced in IDE completions and hovers. */
  readonly description?: string;
}

/**
 * Configuration for `@bunest/orm` declarative repositories and implicit scopes.
 */
export interface BunestOrmConfig {
  /** Custom derived query operators registered for ORM execution and static analyzer validation. */
  readonly queryOperators?: readonly BunestQueryOperatorConfig[];
  /** Named repository scopes enabled by default across repositories. */
  readonly defaultScopes?: readonly string[];
}

/**
 * Structural matcher criteria for declarative AOP pointcuts.
 */
export interface BunestAopPointcutMatchConfig {
  readonly className?:
    | string
    | RegExp
    | ((name: string, target: any) => boolean);
  readonly methodName?: string | RegExp | ((name: string) => boolean);
  readonly excludeMethods?: readonly string[];
  readonly metadataKey?: string | symbol;
  readonly predicate?: (target: any, methodName: string | symbol) => boolean;
}

/**
 * Structural configuration entry for a declarative AOP pointcut rule
 * (compatible with `PointcutRule` without introducing circular imports).
 */
export interface BunestAopPointcutConfig {
  readonly name?: string;
  readonly match: BunestAopPointcutMatchConfig;
  readonly aspects: readonly unknown[];
}

/**
 * Configuration for Bunest Service-Layer AOP pointcuts.
 */
export interface BunestAopConfig {
  readonly pointcuts?: readonly BunestAopPointcutConfig[];
}

/**
 * Structural interface for extensible `@bunest/cli` typegen plugins.
 */
export interface BunestTypegenPluginConfig<TData = any> {
  readonly name: string;
  readonly target?: string;
  readonly description?: string;
  readonly scan: (ctx: any) => TData | Promise<TData>;
  readonly emit: (data: TData, ctx: any) => string | readonly string[];
}

/**
 * Configuration for `bunest typegen`.
 */
export interface BunestTypegenConfig {
  readonly enabled?: boolean;
  readonly outDir?: string;
  readonly fileName?: string;
  readonly tsconfigPath?: string;
  readonly envFiles?: readonly string[];
  readonly include?: readonly string[];
  readonly debounceMs?: number;
  readonly includeGlobalNamespace?: boolean;
  readonly plugins?: readonly BunestTypegenPluginConfig<any>[];
}

export type BunestDiagnosticSeverity = "error" | "warning" | "info";

/**
 * Structural interface for custom static architecture diagnostic rules used by `bunest check`.
 */
export interface BunestDiagnosticRuleConfig {
  readonly code: string;
  readonly severity: BunestDiagnosticSeverity;
  readonly description: string;
  readonly check: (ctx: any) => readonly any[];
}

/**
 * Configuration for `bunest check` static architecture diagnostics.
 */
export interface BunestDiagnosticsConfig {
  readonly rules?: readonly BunestDiagnosticRuleConfig[];
  readonly presetRules?: readonly string[];
}

/**
 * Custom source transform stage executed inside Bunest's unified `Bun.plugin` `onLoad` pipeline.
 */
export interface BunestSourceTransformConfig {
  readonly name: string;
  readonly filter?: RegExp | ((filePath: string) => boolean);
  readonly transform: (
    source: string,
    filePath: string,
  ) =>
    | string
    | null
    | undefined
    | void
    | Promise<string | null | undefined | void>;
}

/**
 * Configuration for Bunest's unified `Bun.plugin` transpile-time transform pipeline.
 */
export interface BunestPluginConfig {
  readonly swaggerMetadata?: boolean;
  readonly ormCircularSafe?: boolean;
  readonly autoModuleManifest?: boolean;
  readonly expandAutoModuleGlobs?: boolean;
  /** Emit TDZ-safe `design:paramtypes` metadata at transpile time for DI classes. */
  readonly aotDiMetadata?: boolean;
  readonly transforms?: readonly BunestSourceTransformConfig[];
}

/**
 * Root configuration schema for `bunest.config.ts`.
 */
export interface BunestConfig {
  readonly orm?: BunestOrmConfig;
  readonly aop?: BunestAopConfig;
  readonly typegen?: BunestTypegenConfig;
  readonly diagnostics?: BunestDiagnosticsConfig;
  readonly plugin?: BunestPluginConfig;
}

/**
 * Identity helper providing strict type-checking and IDE autocompletion for `bunest.config.ts`.
 */
export function defineBunestConfig(config: BunestConfig): BunestConfig {
  return config;
}
