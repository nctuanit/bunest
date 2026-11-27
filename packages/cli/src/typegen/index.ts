import { resolve } from "@bunest/core";
import { loadBunestConfig } from "../config/bunest-config.loader";
import type { CliIO } from "../types";
import {
  buildTypegenSummary,
  emitBunestDeclaration,
  emitClientRouteTypes,
  formatTypegenSummary,
  sanitizeTypeText,
  validateGeneratedDeclaration,
  writeClientRouteTypes,
  writeTypegenOutput,
  type EmitClientRouteTypesOptions,
} from "./emitter";
import {
  BUILTIN_TYPEGEN_PLUGINS,
  aiToolsTypegenPlugin,
  authzTypegenPlugin,
  defineTypegenPlugin,
  i18nTypegenPlugin,
  jobsTypegenPlugin,
  selectActiveTypegenPlugins,
  workflowsTypegenPlugin,
  type BunestTypegenPlugin,
  type ExtractedAiToolEntry,
  type ExtractedI18nKeyEntry,
  type ExtractedQueueEntry,
  type ExtractedQueueJobEntry,
  type ExtractedWorkflowEntry,
  type TypegenPluginEmitContext,
  type TypegenPluginScanContext,
} from "./plugins";
import { BunestTypegenScanner } from "./scanner";
import type {
  TypegenClientTypesResult,
  TypegenOptions,
  TypegenResult,
} from "./types";
import { startTypegenWatcher } from "./watcher";

/**
 * One-shot global type generation powered by the Bunest native TypeScript AST engine.
 * Scans the project AST (plus built-in & custom typegen plugins) and emits
 * `.bunest/types/bunest.d.ts` with Module Augmentation registries for Mongoose,
 * Config, Events, Microservices, Routes, CQRS, DI Tokens, Class Macros, i18n,
 * Jobs, Workflows, Authz, and AI Tools.
 */
export async function generateBunestTypes(
  options: TypegenOptions = {},
  io?: CliIO,
): Promise<TypegenResult> {
  const cwd = resolve(options.cwd ?? io?.cwd ?? process.cwd());
  const bunestConfig =
    options.bunestConfig ??
    (options.loadBunestConfig === false
      ? {}
      : (
          await loadBunestConfig(cwd, {
            configPath: options.bunestConfigPath,
          })
        ).config);

  const cfgTypegen = bunestConfig.typegen as
    | (typeof bunestConfig.typegen & { readonly clientTypes?: string })
    | undefined;
  const sourceRoot = options.sourceRoot ?? cfgTypegen?.sourceRoot ?? "src";
  const outDir = options.outDir ?? cfgTypegen?.outDir ?? ".bunest/types";
  const fileName = options.fileName ?? cfgTypegen?.fileName ?? "bunest.d.ts";
  const outputPath = resolve(cwd, outDir, fileName);
  const clientTypesPath = options.clientTypes ?? cfgTypegen?.clientTypes;
  const includeGlobalNamespace =
    options.includeGlobalNamespace ?? cfgTypegen?.includeGlobalNamespace ?? true;

  const scanner = new BunestTypegenScanner({
    cwd,
    sourceRoot,
    tsconfigPath: options.tsconfigPath ?? cfgTypegen?.tsconfigPath,
    envFiles: options.envFiles ?? cfgTypegen?.envFiles,
    include: options.include ?? cfgTypegen?.include,
    plugins: options.plugins,
    macroDefaults: options.macroDefaults,
    macroPresets: options.macroPresets,
    customMacros: options.customMacros,
    bunestConfig,
  });

  const scan = await scanner.scanAsync({
    outputPath,
    includeGlobalNamespace,
  });
  const baseResult = await writeTypegenOutput(scan, {
    cwd,
    outputPath,
    includeGlobalNamespace,
    dryRun: options.dryRun,
    check: options.check,
  });

  let clientTypes: TypegenClientTypesResult | undefined;
  if (clientTypesPath) {
    clientTypes = await writeClientRouteTypes(scan, {
      cwd,
      outputPath: clientTypesPath,
      dryRun: options.dryRun,
      check: options.check,
    });
  }

  const result: TypegenResult = clientTypes
    ? {
        ...baseResult,
        changed: baseResult.changed || clientTypes.changed,
        upToDate: baseResult.upToDate && clientTypes.upToDate,
        clientTypes,
      }
    : baseResult;

  if (io && !options.silent) {
    const summaryText = formatTypegenSummary(result.summary);
    if (options.check) {
      if (baseResult.upToDate) {
        io.stdout(
          `[typegen] Up-to-date: ${result.relativePath} (${summaryText}) in ${result.durationMs.toFixed(1)}ms`,
        );
      } else {
        io.stderr(
          `[typegen] Out-of-date: ${result.relativePath} (${summaryText}). Run "bunest typegen" to update.`,
        );
      }
      if (clientTypes) {
        const routesText = `${result.summary.routes} route${result.summary.routes === 1 ? "" : "s"}`;
        if (clientTypes.upToDate) {
          io.stdout(
            `[typegen] Up-to-date: ${clientTypes.relativePath} (${routesText})`,
          );
        } else {
          io.stderr(
            `[typegen] Out-of-date: ${clientTypes.relativePath} (${routesText}). Run "bunest typegen --client-types ${clientTypesPath}" to update.`,
          );
        }
      }
    } else if (options.dryRun) {
      io.stdout(
        `[typegen] [dry-run] Would write ${result.relativePath} (${summaryText}) in ${result.durationMs.toFixed(1)}ms`,
      );
      if (clientTypes) {
        const routesText = `${result.summary.routes} route${result.summary.routes === 1 ? "" : "s"}`;
        io.stdout(
          `[typegen] [dry-run] Would write ${clientTypes.relativePath} (${routesText})`,
        );
      }
    } else {
      const verb = baseResult.changed ? "Generated" : "Up-to-date";
      io.stdout(
        `[typegen] ${verb} ${result.relativePath} (${summaryText}) in ${result.durationMs.toFixed(1)}ms`,
      );
      if (clientTypes) {
        const clientVerb = clientTypes.changed ? "Generated" : "Up-to-date";
        const routesText = `${result.summary.routes} route${result.summary.routes === 1 ? "" : "s"}`;
        io.stdout(
          `[typegen] ${clientVerb} ${clientTypes.relativePath} (${routesText})`,
        );
      }
    }
  }

  return result;
}

export {
  BunestTypegenScanner,
  nodeToLocation,
} from "./scanner";
export {
  buildTypegenSummary,
  emitBunestDeclaration,
  emitClientRouteTypes,
  formatTypegenSummary,
  sanitizeTypeText,
  validateGeneratedDeclaration,
  writeClientRouteTypes,
  writeTypegenOutput,
  startTypegenWatcher,
  type EmitClientRouteTypesOptions,
};
export {
  BUILTIN_TYPEGEN_PLUGINS,
  aiToolsTypegenPlugin,
  authzTypegenPlugin,
  defineTypegenPlugin,
  i18nTypegenPlugin,
  jobsTypegenPlugin,
  selectActiveTypegenPlugins,
  workflowsTypegenPlugin,
};
export type {
  BunestTypegenPlugin,
  ExtractedAiToolEntry,
  ExtractedI18nKeyEntry,
  ExtractedQueueEntry,
  ExtractedQueueJobEntry,
  ExtractedWorkflowEntry,
  TypegenPluginEmitContext,
  TypegenPluginScanContext,
};
export { ALL_TYPEGEN_TARGETS } from "./types";
export type {
  CallSiteKind,
  ExtractedBaseEntityField,
  ExtractedCallSite,
  ExtractedClassMacroEntry,
  ExtractedConfigNamespaceEntry,
  ExtractedConnectionEntry,
  ExtractedCqrsCommandEntry,
  ExtractedCqrsQueryEntry,
  ExtractedCustomMacroMember,
  ExtractedCustomMacroRef,
  ExtractedDelegateInfo,
  ExtractedEnvKeyEntry,
  ExtractedEventEntry,
  ExtractedEventPatternEntry,
  ExtractedImportRef,
  ExtractedMacroAccessors,
  ExtractedMacroField,
  ExtractedMacroFieldRef,
  ExtractedMessagePatternEntry,
  ExtractedModelEntry,
  ExtractedPluginScanResult,
  ExtractedRouteEntry,
  ExtractedTokenEntry,
  SourceLocation,
  TypegenClientTypesResult,
  TypegenConfiguration,
  TypegenIncludeTarget,
  TypegenOptions,
  TypegenResult,
  TypegenScanResult,
  TypegenSummary,
  TypegenTarget,
  TypegenWatcherHandle,
  TypegenWatcherOptions,
} from "./types";
