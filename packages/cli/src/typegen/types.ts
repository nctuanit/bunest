import type { Project, SourceFile, Type as TsType } from "../ast";
import type {
  BunestConfigLike,
  CustomMacroPluginInput,
  GlobalMacroDefaultsLike,
} from "../config/bunest-config.loader";

export interface TypegenPluginScanContext {
  readonly cwd: string;
  readonly sourceRootDir: string;
  readonly sourceFiles: readonly SourceFile[];
  readonly project: Project;
  readonly scan: TypegenScanResult;
  /**
   * Formats a resolved AST type into portable TypeScript text and registers any
   * required `import type` references in the emitted `.d.ts` header.
   */
  readonly printType: (tsType: TsType, fallback?: string) => string;
  /**
   * Registers extra `import type` references required by emitted declarations.
   */
  readonly addImports: (imports: readonly ExtractedImportRef[]) => void;
}

export interface TypegenPluginEmitContext {
  readonly cwd: string;
  readonly outputPath: string;
  readonly outputDir: string;
  readonly includeGlobalNamespace: boolean;
  readonly formatImportSpecifier: (filePath: string) => string;
  readonly formatPropKey: (key: string) => string;
}

export interface BunestTypegenPlugin<TData = any> {
  readonly name: string;
  readonly target?: string;
  readonly scan: (ctx: TypegenPluginScanContext) => TData | Promise<TData>;
  readonly emit: (
    data: TData,
    ctx: TypegenPluginEmitContext,
  ) => string | readonly string[];
}

export type TypegenTarget =
  | "mongoose"
  | "config"
  | "events"
  | "microservices"
  | "routes"
  | "cqrs"
  | "tokens"
  | "macros"
  | "i18n"
  | "jobs"
  | "workflows"
  | "authz"
  | "ai";

export type TypegenIncludeTarget = TypegenTarget | (string & {});

export const ALL_TYPEGEN_TARGETS: readonly TypegenTarget[] = [
  "mongoose",
  "config",
  "events",
  "microservices",
  "routes",
  "cqrs",
  "tokens",
  "macros",
  "i18n",
  "jobs",
  "workflows",
  "authz",
  "ai",
] as const;

/**
 * Source range for an AST node (1-based `line`/`column`, 0-based `start`/`end` offsets).
 */
export interface SourceLocation {
  readonly filePath: string;
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
  readonly endColumn: number;
  readonly start: number;
  readonly end: number;
}

export type CallSiteKind =
  | "event"
  | "messagePattern"
  | "eventPattern"
  | "model"
  | "connection"
  | "config"
  | "command"
  | "query"
  | "token";

export interface ExtractedCallSite {
  readonly kind: CallSiteKind;
  readonly key: string;
  readonly location: SourceLocation;
  readonly context?: string;
}

export interface TypegenConfiguration {
  /**
   * Enable automatic type generation during `bunest dev` and `bunest start --watch`.
   * @default true
   */
  readonly enabled?: boolean;
  /**
   * Output directory for generated `.d.ts` files (relative to project root).
   * @default ".bunest/types"
   */
  readonly outDir?: string;
  /**
   * Output declaration filename inside `outDir`.
   * @default "bunest.d.ts"
   */
  readonly fileName?: string;
  /**
   * Explicit path to `tsconfig.json`.
   */
  readonly tsconfigPath?: string;
  /**
   * Environment files scanned for key names (defaults to `.env.example`, `.env`, `.env.local`, `.env.development`).
   */
  readonly envFiles?: readonly string[];
  /**
   * Subset of registries (or plugin targets/names) to scan and emit. Defaults to all registries.
   */
  readonly include?: readonly TypegenIncludeTarget[];
  /**
   * Debounce window in milliseconds for live dev watcher regeneration.
   * @default 120
   */
  readonly debounceMs?: number;
  /**
   * Emit convenience `declare global { namespace Bunest { ... } }` helper aliases.
   * @default true
   */
  readonly includeGlobalNamespace?: boolean;
  /**
   * Additional custom typegen plugins to run alongside built-in scanners.
   */
  readonly plugins?: readonly BunestTypegenPlugin<any>[];
}

export interface TypegenOptions {
  readonly cwd?: string;
  readonly sourceRoot?: string;
  readonly outDir?: string;
  readonly fileName?: string;
  readonly tsconfigPath?: string;
  readonly config?: string;
  readonly envFiles?: readonly string[];
  readonly include?: readonly TypegenIncludeTarget[];
  readonly includeGlobalNamespace?: boolean;
  readonly plugins?: readonly BunestTypegenPlugin<any>[];
  readonly macroDefaults?: GlobalMacroDefaultsLike;
  readonly macroPresets?: Readonly<Record<string, readonly string[]>>;
  readonly customMacros?: readonly CustomMacroPluginInput[];
  readonly bunestConfig?: BunestConfigLike;
  readonly bunestConfigPath?: string;
  readonly loadBunestConfig?: boolean;
  readonly dryRun?: boolean;
  readonly check?: boolean;
  readonly silent?: boolean;
}

export interface TypegenWatcherOptions extends TypegenOptions {
  readonly debounceMs?: number;
  readonly onUpdate?: (result: TypegenResult) => void;
  readonly onError?: (error: Error) => void;
}

export interface ExtractedImportRef {
  readonly filePath: string;
  readonly exportName: string;
  readonly alias?: string;
  readonly isTypeOnly?: boolean;
}

export interface ExtractedModelEntry {
  readonly name: string;
  readonly typeText: string;
  readonly sourceFile: string;
  readonly location?: SourceLocation;
  readonly imports: readonly ExtractedImportRef[];
}

export interface ExtractedConnectionEntry {
  readonly name: string;
  readonly sourceFile: string;
  readonly location?: SourceLocation;
}

export interface ExtractedConfigNamespaceEntry {
  readonly namespace: string;
  readonly typeText: string;
  readonly usesConfigTypeHelper: boolean;
  readonly sourceFile: string;
  readonly location?: SourceLocation;
  readonly imports: readonly ExtractedImportRef[];
}

export interface ExtractedEnvKeyEntry {
  readonly key: string;
  readonly sourceFile: string;
  readonly location?: SourceLocation;
}

export interface ExtractedEventEntry {
  readonly eventName: string;
  readonly payloadTypeText: string;
  readonly sourceFile: string;
  readonly location?: SourceLocation;
  readonly locations?: readonly SourceLocation[];
  readonly imports: readonly ExtractedImportRef[];
}

export interface ExtractedMessagePatternEntry {
  readonly patternKey: string;
  readonly requestTypeText: string;
  readonly responseTypeText: string;
  readonly sourceFile: string;
  readonly location?: SourceLocation;
  readonly imports: readonly ExtractedImportRef[];
}

export interface ExtractedEventPatternEntry {
  readonly patternKey: string;
  readonly payloadTypeText: string;
  readonly sourceFile: string;
  readonly location?: SourceLocation;
  readonly imports: readonly ExtractedImportRef[];
}

export interface ExtractedRouteEntry {
  readonly key: string;
  readonly method: string;
  readonly path: string;
  readonly paramsTypeText: string;
  readonly queryTypeText: string;
  readonly bodyTypeText: string;
  readonly responseTypeText: string;
  readonly controllerName: string;
  readonly handlerName: string;
  readonly sourceFile: string;
  readonly location?: SourceLocation;
  readonly imports: readonly ExtractedImportRef[];
}

export interface ExtractedCqrsCommandEntry {
  readonly key: string;
  readonly commandTypeText: string;
  readonly resultTypeText: string;
  readonly sourceFile: string;
  readonly location?: SourceLocation;
  readonly imports: readonly ExtractedImportRef[];
}

export interface ExtractedCqrsQueryEntry {
  readonly key: string;
  readonly queryTypeText: string;
  readonly resultTypeText: string;
  readonly sourceFile: string;
  readonly location?: SourceLocation;
  readonly imports: readonly ExtractedImportRef[];
}

export interface ExtractedTokenEntry {
  readonly token: string;
  readonly valueTypeText: string;
  readonly sourceFile: string;
  readonly location?: SourceLocation;
  readonly imports: readonly ExtractedImportRef[];
}

export interface ExtractedMacroAccessors {
  readonly fluent?: boolean;
  readonly chain?: boolean;
  readonly prefix?: readonly string[];
}

export interface ExtractedMacroField {
  readonly name: string;
  readonly typeText: string;
  readonly optional: boolean;
  readonly hasDefault: boolean;
  readonly isReadonly: boolean;
  readonly isNonFinal: boolean;
  readonly isSecret: boolean;
  readonly secretOmitFromJson: boolean;
  readonly toStringInclude: boolean;
  readonly toStringExclude: boolean;
  readonly equalsInclude: boolean;
  readonly equalsExclude: boolean;
  readonly fieldConstantInclude: boolean;
  readonly fieldConstantExclude: boolean;
  readonly hasGetter: boolean;
  readonly hasSetter: boolean;
  readonly hasWith: boolean;
  readonly hasWithBy: boolean;
  readonly isSingular: boolean;
  readonly singularName?: string;
  readonly collectionKind?: "array" | "set" | "map";
  readonly collectionItemTypeText?: string;
  readonly collectionKeyTypeText?: string;
  readonly collectionValueTypeText?: string;
  readonly inherited: boolean;
  readonly location: SourceLocation;
  readonly imports: readonly ExtractedImportRef[];
}

export interface ExtractedDelegateInfo {
  readonly propertyName: string;
  readonly targetTypeName: string;
  readonly targetLocation?: SourceLocation;
  readonly excludes: readonly string[];
  readonly resolved: boolean;
  readonly location: SourceLocation;
  readonly members: readonly {
    readonly name: string;
    readonly signatureText: string;
    readonly imports: readonly ExtractedImportRef[];
  }[];
}

export interface ExtractedMacroFieldRef {
  readonly decoratorName: string;
  readonly optionName: "exclude" | "include" | "mask";
  readonly fieldName: string;
  readonly location: SourceLocation;
}

export interface ExtractedCustomMacroMember {
  readonly kind: "instance" | "static" | "builder";
  readonly name: string;
  readonly signature: string;
  readonly sourceDecorator: string;
}

export interface ExtractedCustomMacroRef {
  readonly name: string;
  readonly composedNames?: readonly string[];
  readonly options?: unknown;
}

export interface ExtractedPluginScanResult {
  readonly pluginName: string;
  readonly target?: string;
  readonly data: unknown;
  readonly blocks: readonly string[];
  readonly imports: readonly ExtractedImportRef[];
  readonly entryCount: number;
}

export interface ExtractedBaseEntityField {
  readonly role: "id" | "createdAt" | "updatedAt" | "deletedAt";
  readonly name: string;
  readonly columnName?: string;
  readonly typeText: string;
  readonly optional: boolean;
  readonly strategy?: "increment" | "uuid" | "objectid" | false;
}

export interface ExtractedClassMacroEntry {
  readonly className: string;
  readonly isExported: boolean;
  readonly sourceFile: string;
  readonly location: SourceLocation;
  readonly decorators: readonly string[];
  readonly fields: readonly ExtractedMacroField[];
  readonly ownMethodNames: readonly string[];
  readonly ownPropertyNames: readonly string[];
  readonly delegates: readonly ExtractedDelegateInfo[];
  readonly fieldReferences: readonly ExtractedMacroFieldRef[];
  readonly accessors: ExtractedMacroAccessors;
  readonly isData: boolean;
  readonly isValue: boolean;
  readonly isBuilder: boolean;
  readonly isSuperBuilder: boolean;
  readonly toBuilder: boolean;
  readonly builderMethodName: string;
  readonly buildMethodName: string;
  readonly setterPrefix: string;
  readonly isGetter: boolean;
  readonly isSetter: boolean;
  readonly isWith: boolean;
  readonly isWithBy: boolean;
  readonly isToString: boolean;
  readonly isEqualsAndHashCode: boolean;
  readonly isJsonSerializable: boolean;
  readonly isFieldNameConstants: boolean;
  readonly fieldConstantsInnerName: string;
  readonly fieldConstantsUppercase: boolean;
  readonly fieldConstantsOnlyExplicit: boolean;
  readonly isWithLogger: boolean;
  readonly loggerPropertyName: string;
  readonly loggerContext?: string;
  readonly isStandardException: boolean;
  readonly isUtilityClass: boolean;
  readonly isBaseEntity?: boolean;
  readonly baseEntityKeyType?: string;
  readonly baseEntityFields?: readonly ExtractedBaseEntityField[];
  readonly accessorsEnabled: boolean;
  readonly maskFields: readonly string[];
  readonly customMembers?: readonly ExtractedCustomMacroMember[];
  readonly customMacros?: readonly ExtractedCustomMacroRef[];
  readonly expandedPresets?: readonly string[];
  readonly imports: readonly ExtractedImportRef[];
}

export interface TypegenSummary {
  readonly models: number;
  readonly connections: number;
  readonly configNamespaces: number;
  readonly envKeys: number;
  readonly events: number;
  readonly messagePatterns: number;
  readonly eventPatterns: number;
  readonly routes: number;
  readonly commands: number;
  readonly queries: number;
  readonly tokens: number;
  readonly classMacros: number;
  readonly plugins?: Readonly<Record<string, number>>;
}

export interface TypegenScanResult {
  readonly models: readonly ExtractedModelEntry[];
  readonly connections: readonly ExtractedConnectionEntry[];
  readonly configNamespaces: readonly ExtractedConfigNamespaceEntry[];
  readonly envKeys: readonly ExtractedEnvKeyEntry[];
  readonly events: readonly ExtractedEventEntry[];
  readonly messagePatterns: readonly ExtractedMessagePatternEntry[];
  readonly eventPatterns: readonly ExtractedEventPatternEntry[];
  readonly routes: readonly ExtractedRouteEntry[];
  readonly commands: readonly ExtractedCqrsCommandEntry[];
  readonly queries: readonly ExtractedCqrsQueryEntry[];
  readonly tokens: readonly ExtractedTokenEntry[];
  readonly classMacros: readonly ExtractedClassMacroEntry[];
  readonly callSites: readonly ExtractedCallSite[];
  readonly pluginResults?: readonly ExtractedPluginScanResult[];
  readonly scannedFiles: number;
  readonly durationMs: number;
}

export interface TypegenResult {
  readonly outputPath: string;
  readonly relativePath: string;
  readonly content: string;
  readonly changed: boolean;
  readonly upToDate: boolean;
  readonly dryRun: boolean;
  readonly summary: TypegenSummary;
  readonly scannedFiles: number;
  readonly durationMs: number;
}

export interface TypegenWatcherHandle {
  readonly initialResult: TypegenResult;
  readonly outputPath: string;
  regenerate(changedPaths?: readonly string[]): Promise<TypegenResult>;
  close(): Promise<void>;
}
