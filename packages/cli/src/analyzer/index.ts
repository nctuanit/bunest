import { resolve } from "@bunest/core";
import type { Project, SourceFile } from "../ast";
import type {
  BunestConfigLike,
  CustomMacroPluginInput,
  CustomQueryOperatorConfigLike,
  GlobalMacroDefaultsLike,
} from "../config/bunest-config.loader";
import { BunestTypegenScanner } from "../typegen/scanner";
import type {
  TypegenIncludeTarget,
  TypegenScanResult,
} from "../typegen/types";
import {
  isGlobalConfigFile,
  selectAffectedTests,
  type AffectedTestSelection,
  type AffectedTestsOptions,
  type AffectedTestsPlan,
} from "./affected-tests";
import {
  canonicalJson,
  diffBodyContracts,
  formatBodyContractDiffJson,
  formatBodyContractDiffPretty,
  type BodyContractChangeKind,
  type BodyContractDiffFinding,
  type BodyContractDiffReport,
  type BodyContractDiffStatus,
  type BodyContractDiffSummary,
  type BodyContractPayload,
  type BodyContractSeverity,
  type BodyFieldConstraints,
  type BodyFieldContract,
  type BodySourceLocation,
  type BodyUnsupportedKind,
  type BodyUnsupportedReason,
  type CandidatePayload,
  type ConstraintName,
  type DiffBodyContractsOptions,
  type PipeProfileInfo,
  type ReplayEvidenceRecord as DiffReplayEvidenceRecord,
  type ReplayEvidenceSection,
  type ReplayVerdict,
  type RouteBodyContract,
  type UnknownPropertyBehavior,
  type VerifiedReplayEvidence,
} from "./body-contract-diff";
import {
  extractValidationErrorFields,
  replayBodyContractCandidates,
  type ReplayBodyContractOptions,
  type ReplayCandidate,
  type ReplayEvidenceRecord,
  type ReplayFetchHandler,
  type ReplayPipeProfile,
  type ReplayTargetApp,
  type ReplayTargetFactory,
  type ReplayTargetInstance,
} from "./body-contract-replay";
import {
  scanRouteBodyContracts,
  type BodyFieldContract as ScannedBodyFieldContract,
  type BodyUnsupportedReason as ScannedBodyUnsupportedReason,
  type BodyUnsupportedReasonKind,
  type RouteBodyContract as ScannedRouteBodyContract,
  type RouteBodyLocation,
  type ScanBodyContractsOptions,
  type ScanBodyContractsResult,
} from "./body-dto-scanner";
import {
  resolveClassMacroMembers,
  type ClassMacroDiagnostic,
  type GeneratedMacroMember,
  type ResolveClassMacroMembersOptions,
} from "./class-macros";
import {
  BUILTIN_ARCHITECTURE_RULES,
  collectConfiguredDiagnosticRules,
  defineDiagnosticRule,
  noRepositoryInControllerRule,
  requireGuardOnMutationsRule,
  resolvePresetDiagnosticRules,
  runCustomDiagnosticRules,
  type CustomDiagnosticHit,
  type CustomDiagnosticQuickFix,
  type CustomDiagnosticRule,
  type CustomRuleDiagnostic,
  type DiagnosticRuleContext,
} from "./custom-rules";
import {
  analyzeProjectDiagnostics,
  runAllBunestDiagnostics,
  runDecoratorDiagnostics,
  type AnalyzeProjectDiagnosticsOptions,
  type BunestDiagnostic,
  type BunestDiagnosticCode,
  type CoreDiagnosticCode,
  type DecoratorDiagnosticCode,
} from "./diagnostics";
import {
  buildAddProviderToModuleEdit,
  buildCollapseLoggerBoilerplateEdit,
  buildConvertDerivedToQueryEdit,
  buildConvertTypeImportEdit,
  buildDelombokEdit,
  buildGenerateRepositorySource,
  buildSyncDiConstructorEdit,
  buildWrapMongooseRefEdit,
  type MagicEditResult,
  type TextEditSpan,
} from "./magic-edits";
import {
  buildStaticModuleGraph,
  type ConstructorDependencyInfo,
  type ErasedTypeKind,
  type InjectTokenKind,
  type ProviderScope,
  type StaticModuleExportItem,
  type StaticModuleGraph,
  type StaticModuleNode,
  type StaticProviderNode,
  type UnknownRegistrationEntry,
  type UnknownRegistrationKind,
} from "./module-graph";
import {
  explainRoute,
  matchesRouteQuery,
  normalizeRoutePath,
  parseRouteQuery,
  type DiDependencyStatus,
  type DiDependencyTrace,
  type DiOwnerModuleInfo,
  type ExplainRouteOptions,
  type RouteExplainConfirmationStatus,
  type RouteExplainControllerInfo,
  type RouteExplainMatch,
  type RouteExplainModuleInfo,
  type RouteExplainPipelineEntry,
  type RouteExplainPipelineScope,
  type RouteExplainPipelineSource,
  type RouteExplainPipelineStage,
  type RouteExplainQuery,
  type RouteExplainQuickFix,
  type RouteExplainQuickFixKind,
  type RouteExplainReport,
  type RouteExplainRuntimeInfo,
  type RouteExplainUnknown,
} from "./route-explain";
import {
  analyzeEntityClass,
  findClosestMatch,
  getRepositoryDerivedCompletions,
  levenshteinDistance,
  matchDerivedPrefix,
  parseDerivedMethodName,
  scanEntitiesAndRepositories,
  scanSqlPlaceholders,
  type AnalyzedEntity,
  type AnalyzedQueryMethod,
  type AnalyzedRepository,
  type DerivedConditionToken,
  type DerivedOrderToken,
  type DerivedQueryKind,
  type EntityFieldCategory,
  type EntityFieldInfo,
  type ParsedDerivedQuery,
  type RepoSqlDialect,
  type RepositoryCompletionItem,
  type RepositoryDiagnostic,
  type RepositoryScopeInfo,
  type ScanEntitiesAndRepositoriesOptions,
} from "./repository-query";

export interface BunestAnalyzerOptions {
  readonly cwd: string;
  readonly sourceRoot?: string;
  readonly tsconfigPath?: string;
  readonly envFiles?: readonly string[];
  readonly include?: readonly TypegenIncludeTarget[];
  readonly bunestConfig?: BunestConfigLike;
  readonly customRules?: readonly CustomDiagnosticRule[];
  readonly presetRules?: readonly string[];
  readonly macroDefaults?: GlobalMacroDefaultsLike;
  readonly macroPresets?: Readonly<Record<string, readonly string[]>>;
  readonly customMacros?: readonly CustomMacroPluginInput[];
  readonly customQueryOperators?: readonly CustomQueryOperatorConfigLike[];
}

export interface BunestWorkspaceSnapshot {
  readonly cwd: string;
  readonly scan: TypegenScanResult;
  readonly entities: readonly AnalyzedEntity[];
  readonly repositories: readonly AnalyzedRepository[];
  readonly moduleGraph: StaticModuleGraph;
  readonly diagnostics: readonly BunestDiagnostic[];
  readonly durationMs: number;
}

/**
 * Unified Bun- & VS Code-compatible static analysis facade powering both
 * `@bunest/cli` (`bunest typegen`, `bunest check`, `bunest delombok`, `bunest dev`)
 * and the `vscode-bunest` VS Code extension. Reuses a single persistent Bunest
 * native TypeScript AST `Project`.
 */
export class BunestStaticAnalyzer {
  private readonly scanner: BunestTypegenScanner;
  private readonly bunestConfig?: BunestConfigLike;
  private readonly customRules?: readonly CustomDiagnosticRule[];
  private readonly presetRules?: readonly string[];
  private readonly customQueryOperators?: readonly CustomQueryOperatorConfigLike[];
  private lastSnapshot?: BunestWorkspaceSnapshot;

  constructor(options: BunestAnalyzerOptions) {
    this.bunestConfig = options.bunestConfig;
    this.customRules = options.customRules;
    this.presetRules = options.presetRules;
    this.customQueryOperators = options.customQueryOperators;
    this.scanner = new BunestTypegenScanner({
      cwd: resolve(options.cwd),
      sourceRoot: options.sourceRoot ?? "src",
      tsconfigPath: options.tsconfigPath,
      envFiles: options.envFiles,
      include: options.include,
      bunestConfig: options.bunestConfig,
      macroDefaults: options.macroDefaults,
      macroPresets: options.macroPresets,
      customMacros: options.customMacros,
    });
  }

  getProject(): Project {
    return this.scanner.getProject();
  }

  getScanner(): BunestTypegenScanner {
    return this.scanner;
  }

  getSourceFile(filePath: string): SourceFile | undefined {
    return this.scanner.getProject().getSourceFile(resolve(filePath));
  }

  /**
   * Updates an in-memory unsaved buffer inside the persistent Bunest AST `Project`
   * (enables instant diagnostics & derived query autocomplete while typing in VS Code).
   */
  updateFileContent(filePath: string, content: string): SourceFile {
    const abs = resolve(filePath);
    const existing = this.scanner.getProject().getSourceFile(abs);
    if (existing) {
      existing.replaceWithText(content);
      return existing;
    }
    return this.scanner.getProject().createSourceFile(abs, content, {
      overwrite: true,
    });
  }

  /**
   * Stores an unsaved in-memory `.env*` buffer so live typegen and hover
   * reflect newly typed config keys before the file is saved.
   */
  updateEnvFileContent(filePath: string, content: string): void {
    this.scanner.updateEnvFileContent(filePath, content);
  }

  /**
   * Clears an in-memory `.env*` override (called on save or close-without-save).
   */
  clearEnvFileOverride(filePath: string): void {
    this.scanner.clearEnvFileOverride(filePath);
  }

  refreshFile(filePath: string): boolean {
    return this.scanner.refreshFile(filePath);
  }

  syncAllFiles(): void {
    this.scanner.syncAllSourceFiles();
  }

  private buildSnapshot(
    scan: TypegenScanResult,
    start: number,
  ): BunestWorkspaceSnapshot {
    const sourceFiles = this.scanner.getTrackedSourceFiles();
    const { entities, repositories, diagnostics: repoDiags } =
      scanEntitiesAndRepositories(sourceFiles, this.scanner.getProject(), {
        bunestConfig: this.bunestConfig,
        customOperators: this.customQueryOperators,
      });
    const moduleGraph = buildStaticModuleGraph(sourceFiles);
    const diagnostics = runAllBunestDiagnostics({
      sourceFiles,
      scan,
      moduleGraph,
      repositoryDiagnostics: repoDiags,
      entities,
      repositories,
      customRules: this.customRules,
      presetRules: this.presetRules,
      bunestConfig: this.bunestConfig,
    });

    const durationMs = Math.round((performance.now() - start) * 100) / 100;
    const snapshot: BunestWorkspaceSnapshot = {
      cwd: this.scanner.getCwd(),
      scan,
      entities,
      repositories,
      moduleGraph,
      diagnostics,
      durationMs,
    };
    this.lastSnapshot = snapshot;
    return snapshot;
  }

  analyze(options?: {
    readonly outputPath?: string;
    readonly includeGlobalNamespace?: boolean;
  }): BunestWorkspaceSnapshot {
    const start = performance.now();
    const scan = this.scanner.scan(options);
    return this.buildSnapshot(scan, start);
  }

  async analyzeAsync(options?: {
    readonly outputPath?: string;
    readonly includeGlobalNamespace?: boolean;
  }): Promise<BunestWorkspaceSnapshot> {
    const start = performance.now();
    const scan = await this.scanner.scanAsync(options);
    return this.buildSnapshot(scan, start);
  }

  getLastSnapshot(): BunestWorkspaceSnapshot | undefined {
    return this.lastSnapshot;
  }

  getDerivedCompletions(
    filePath: string,
    repositoryClassName: string,
    currentPrefix: string,
  ): RepositoryCompletionItem[] {
    const snap = this.lastSnapshot ?? this.analyze();
    const abs = resolve(filePath);
    const repo = snap.repositories.find(
      (r) => r.sourceFile === abs && r.className === repositoryClassName,
    );
    if (!repo) return [];
    return getRepositoryDerivedCompletions(repo, currentPrefix, {
      bunestConfig: this.bunestConfig,
      customOperators: this.customQueryOperators,
    });
  }
}

export {
  BUILTIN_ARCHITECTURE_RULES,
  analyzeEntityClass,
  analyzeProjectDiagnostics,
  buildAddProviderToModuleEdit,
  buildCollapseLoggerBoilerplateEdit,
  buildConvertDerivedToQueryEdit,
  buildConvertTypeImportEdit,
  buildDelombokEdit,
  buildGenerateRepositorySource,
  buildStaticModuleGraph,
  buildSyncDiConstructorEdit,
  buildWrapMongooseRefEdit,
  canonicalJson,
  collectConfiguredDiagnosticRules,
  defineDiagnosticRule,
  diffBodyContracts,
  explainRoute,
  extractValidationErrorFields,
  findClosestMatch,
  formatBodyContractDiffJson,
  formatBodyContractDiffPretty,
  getRepositoryDerivedCompletions,
  isGlobalConfigFile,
  levenshteinDistance,
  matchDerivedPrefix,
  matchesRouteQuery,
  noRepositoryInControllerRule,
  normalizeRoutePath,
  parseDerivedMethodName,
  parseRouteQuery,
  replayBodyContractCandidates,
  requireGuardOnMutationsRule,
  resolveClassMacroMembers,
  resolvePresetDiagnosticRules,
  runAllBunestDiagnostics,
  runCustomDiagnosticRules,
  runDecoratorDiagnostics,
  scanEntitiesAndRepositories,
  scanRouteBodyContracts,
  scanSqlPlaceholders,
  selectAffectedTests,
};
export type {
  AffectedTestSelection,
  AffectedTestsOptions,
  AffectedTestsPlan,
  AnalyzeProjectDiagnosticsOptions,
  AnalyzedEntity,
  AnalyzedQueryMethod,
  AnalyzedRepository,
  BodyContractChangeKind,
  BodyContractDiffFinding,
  BodyContractDiffReport,
  BodyContractDiffStatus,
  BodyContractDiffSummary,
  BodyContractPayload,
  BodyContractSeverity,
  BodyFieldConstraints,
  BodyFieldContract,
  BodySourceLocation,
  BodyUnsupportedKind,
  BodyUnsupportedReason,
  BodyUnsupportedReasonKind,
  BunestDiagnostic,
  BunestDiagnosticCode,
  CandidatePayload,
  ClassMacroDiagnostic,
  ConstraintName,
  ConstructorDependencyInfo,
  CoreDiagnosticCode,
  CustomDiagnosticHit,
  CustomDiagnosticQuickFix,
  CustomDiagnosticRule,
  CustomRuleDiagnostic,
  DecoratorDiagnosticCode,
  DerivedConditionToken,
  DerivedOrderToken,
  DerivedQueryKind,
  DiDependencyStatus,
  DiDependencyTrace,
  DiOwnerModuleInfo,
  DiagnosticRuleContext,
  DiffBodyContractsOptions,
  DiffReplayEvidenceRecord,
  EntityFieldCategory,
  EntityFieldInfo,
  ErasedTypeKind,
  ExplainRouteOptions,
  GeneratedMacroMember,
  InjectTokenKind,
  MagicEditResult,
  ParsedDerivedQuery,
  PipeProfileInfo,
  ProviderScope,
  ReplayBodyContractOptions,
  ReplayCandidate,
  ReplayEvidenceRecord,
  ReplayEvidenceSection,
  ReplayFetchHandler,
  ReplayPipeProfile,
  ReplayTargetApp,
  ReplayTargetFactory,
  ReplayTargetInstance,
  ReplayVerdict,
  RepoSqlDialect,
  RepositoryCompletionItem,
  RepositoryDiagnostic,
  RepositoryScopeInfo,
  ResolveClassMacroMembersOptions,
  RouteBodyContract,
  RouteBodyLocation,
  RouteExplainConfirmationStatus,
  RouteExplainControllerInfo,
  RouteExplainMatch,
  RouteExplainModuleInfo,
  RouteExplainPipelineEntry,
  RouteExplainPipelineScope,
  RouteExplainPipelineSource,
  RouteExplainPipelineStage,
  RouteExplainQuery,
  RouteExplainQuickFix,
  RouteExplainQuickFixKind,
  RouteExplainReport,
  RouteExplainRuntimeInfo,
  RouteExplainUnknown,
  ScanBodyContractsOptions,
  ScanBodyContractsResult,
  ScanEntitiesAndRepositoriesOptions,
  ScannedBodyFieldContract,
  ScannedBodyUnsupportedReason,
  ScannedRouteBodyContract,
  StaticModuleExportItem,
  StaticModuleGraph,
  StaticModuleNode,
  StaticProviderNode,
  TextEditSpan,
  UnknownPropertyBehavior,
  UnknownRegistrationEntry,
  UnknownRegistrationKind,
  VerifiedReplayEvidence,
};
