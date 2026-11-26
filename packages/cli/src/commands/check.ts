import { readTextSync, relative, resolve, writeTextSync } from "@bunest/core";
import {
  BunestStaticAnalyzer,
  buildConvertTypeImportEdit,
  buildWrapMongooseRefEdit,
  type BunestDiagnostic,
  type CustomDiagnosticRule,
} from "../analyzer";
import {
  loadBunestConfig,
  type BunestConfigLike,
} from "../config/bunest-config.loader";
import { loadCliConfiguration } from "../config/configuration.loader";
import type { CliIO } from "../types";

export interface CheckCommandOptions {
  readonly cwd?: string;
  readonly sourceRoot?: string;
  readonly tsconfig?: string;
  readonly config?: string;
  readonly bunestConfig?: BunestConfigLike;
  readonly customRules?: readonly CustomDiagnosticRule[];
  readonly presetRules?: readonly string[];
  readonly format?: "pretty" | "json";
  readonly strict?: boolean;
  readonly fix?: boolean;
  readonly dryRun?: boolean;
  readonly silent?: boolean;
}

export interface CheckCommandResult {
  readonly exitCode: number;
  readonly diagnostics: readonly BunestDiagnostic[];
  readonly errors: number;
  readonly warnings: number;
  readonly infos: number;
  readonly fixedCount: number;
  readonly fixedFiles: readonly string[];
  readonly durationMs: number;
}

function applySingleLineReplacement(
  text: string,
  start: number,
  end: number,
  replacement: string,
): string {
  return text.slice(0, start) + replacement + text.slice(end);
}

/**
 * Runs all Bunest static diagnostics (`BUNEST001..007`, `BUNEST_REPO001..007`,
 * `BUNEST_MACRO001..005`, plus configured architecture & custom rules from
 * `bunest.config.ts`) from the CLI, with optional `--fix` and `--format json`.
 */
export async function runCheckCommand(
  options: CheckCommandOptions = {},
  io?: CliIO,
): Promise<CheckCommandResult> {
  const cwd = resolve(options.cwd ?? io?.cwd ?? process.cwd());
  const loaded = await loadCliConfiguration(cwd, options.config);
  const bunestConfig =
    options.bunestConfig ?? (await loadBunestConfig(cwd)).config;
  const sourceRoot =
    options.sourceRoot ??
    bunestConfig.typegen?.sourceRoot ??
    loaded.config.sourceRoot ??
    "src";

  const analyzer = new BunestStaticAnalyzer({
    cwd,
    sourceRoot,
    tsconfigPath: options.tsconfig,
    bunestConfig,
    customRules: options.customRules,
    presetRules: options.presetRules,
  });

  let snapshot = analyzer.analyze();
  let fixedCount = 0;
  const fixedFiles = new Set<string>();

  if (options.fix && snapshot.diagnostics.length > 0) {
    // Group span fixes per file (applied bottom-to-top so offsets never shift)
    const byFile = new Map<string, BunestDiagnostic[]>();
    for (const d of snapshot.diagnostics) {
      if (!d.fixData) continue;
      const list = byFile.get(d.location.filePath) ?? [];
      list.push(d);
      byFile.set(d.location.filePath, list);
    }

    for (const [filePath, diags] of byFile) {
      let current =
        typeof Bun !== "undefined"
          ? await Bun.file(filePath).text()
          : readTextSync(filePath);
      const original = current;

      // 1. AST/magic-string fixes first
      const sf = analyzer.getSourceFile(filePath);
      if (sf) {
        for (const d of diags) {
          if (d.fixData?.kind === "convertTypeImport") {
            sf.replaceWithText(current);
            const res = buildConvertTypeImportEdit({
              sourceFile: sf,
              symbolName: String(d.fixData.symbolName),
            });
            if (res.changed) {
              current = res.updated;
              fixedCount++;
            }
          }
        }
      }

      // 2. Offset-based fixes (re-sort descending by start offset if current === original)
      if (current === original) {
        const sorted = [...diags].sort(
          (a, b) => b.location.start - a.location.start,
        );
        for (const d of sorted) {
          const kind = d.fixData?.kind;
          if (kind === "wrapMongooseRef") {
            const res = buildWrapMongooseRefEdit({
              filePath,
              sourceText: current,
              decoratorStart: Number(d.fixData!.decoratorStart),
              decoratorEnd: Number(d.fixData!.decoratorEnd),
            });
            if (res.changed) {
              current = res.updated;
              fixedCount++;
            }
          } else if (
            kind === "renameDerivedProperty" ||
            kind === "fixReturnType" ||
            kind === "replaceFieldName"
          ) {
            const replacement = String(d.fixData?.replacement ?? "");
            if (replacement) {
              current = applySingleLineReplacement(
                current,
                d.location.start,
                d.location.end,
                replacement,
              );
              fixedCount++;
            }
          } else if (kind === "addModifyingDecorator") {
            const lineStart =
              current.lastIndexOf("\n", Math.max(0, d.location.start - 1)) + 1;
            const indent = /^[ \t]*/.exec(current.slice(lineStart))?.[0] ?? "";
            current =
              current.slice(0, lineStart) +
              `${indent}@Modifying()\n` +
              current.slice(lineStart);
            fixedCount++;
          } else if (kind === "addRepositoryDecorator") {
            const decName = "Repository";
            const lineStart =
              current.lastIndexOf("\n", Math.max(0, d.location.start - 1)) + 1;
            const indent = /^[ \t]*/.exec(current.slice(lineStart))?.[0] ?? "";
            current =
              current.slice(0, lineStart) +
              `${indent}@${decName}(${String(d.fixData?.entityName ?? "Entity")})\n` +
              current.slice(lineStart);
            fixedCount++;
          } else if (kind === "customRuleFix") {
            const start = Number(d.fixData?.start);
            const end = Number(d.fixData?.end);
            const newText = String(d.fixData?.newText ?? "");
            if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
              current = applySingleLineReplacement(current, start, end, newText);
              fixedCount++;
            }
          }
        }
      }

      if (current !== original) {
        fixedFiles.add(filePath);
        if (!options.dryRun) {
          if (typeof Bun !== "undefined") {
            await Bun.write(filePath, current);
          } else {
            writeTextSync(filePath, current);
          }
          analyzer.updateFileContent(filePath, current);
        }
      }
    }

    if (!options.dryRun && fixedFiles.size > 0) {
      snapshot = analyzer.analyze();
    }
  }

  const errors = snapshot.diagnostics.filter((d) => d.severity === "error").length;
  const warnings = snapshot.diagnostics.filter((d) => d.severity === "warning").length;
  const infos = snapshot.diagnostics.filter((d) => d.severity === "info").length;
  const exitCode = errors > 0 || (options.strict && warnings > 0) ? 1 : 0;

  if (io && !options.silent) {
    if (options.format === "json") {
      io.stdout(
        JSON.stringify(
          {
            exitCode,
            errors,
            warnings,
            infos,
            fixedCount,
            fixedFiles: [...fixedFiles].map((f) =>
              relative(cwd, f).replace(/\\/g, "/"),
            ),
            diagnostics: snapshot.diagnostics.map((d) => ({
              code: d.code,
              severity: d.severity,
              message: d.message,
              file: relative(cwd, d.location.filePath).replace(/\\/g, "/"),
              line: d.location.line,
              column: d.location.column,
            })),
          },
          null,
          2,
        ),
      );
    } else {
      if (fixedCount > 0) {
        io.stdout(
          `[check] ${options.dryRun ? "[dry-run] Would apply" : "Applied"} ${fixedCount} auto-fix(es) across ${fixedFiles.size} file(s).`,
        );
      }
      for (const d of snapshot.diagnostics) {
        const rel = relative(cwd, d.location.filePath).replace(/\\/g, "/");
        const tag =
          d.severity === "error"
            ? "ERROR"
            : d.severity === "warning"
              ? "WARN "
              : "INFO ";
        const line = `  ${tag} [${d.code}] ${rel}:${d.location.line}:${d.location.column} — ${d.message}`;
        if (d.severity === "error") io.stderr(line);
        else io.stdout(line);
      }
      io.stdout(
        `[check] Found ${errors} error(s), ${warnings} warning(s), ${infos} info(s) across ${snapshot.scan.scannedFiles} file(s) in ${snapshot.durationMs.toFixed(1)}ms.`,
      );
    }
  }

  return {
    exitCode,
    diagnostics: snapshot.diagnostics,
    errors,
    warnings,
    infos,
    fixedCount,
    fixedFiles: [...fixedFiles],
    durationMs: snapshot.durationMs,
  };
}
