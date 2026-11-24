import { relative, resolve, writeTextSync } from "@bunest/core";
import {
  BunestStaticAnalyzer,
  buildAddProviderToModuleEdit,
  buildCollapseLoggerBoilerplateEdit,
  buildConvertDerivedToQueryEdit,
  buildDelombokEdit,
  buildSyncDiConstructorEdit,
  type MagicEditResult,
} from "../analyzer";
import {
  loadBunestConfig,
  type BunestConfigLike,
} from "../config/bunest-config.loader";
import { loadCliConfiguration } from "../config/configuration.loader";
import type { CliIO } from "../types";

export interface DelombokCommandOptions {
  readonly target: string;
  readonly className?: string;
  readonly decorator?: string;
  readonly sourceRoot?: string;
  readonly tsconfig?: string;
  readonly config?: string;
  readonly bunestConfig?: BunestConfigLike;
  readonly cwd?: string;
  readonly dryRun?: boolean;
  readonly silent?: boolean;
}

export interface DelombokCommandResult {
  readonly exitCode: number;
  readonly filePath: string;
  readonly className: string;
  readonly changed: boolean;
  readonly updated: string;
}

export type CodemodAction =
  | "derived-to-query"
  | "collapse-logger"
  | "sync-di"
  | "add-provider";

export interface CodemodCommandOptions {
  readonly action: CodemodAction | string;
  readonly targetFile: string;
  readonly className?: string;
  readonly methodName?: string;
  readonly moduleName?: string;
  readonly symbolName?: string;
  readonly arrayProperty?: "providers" | "controllers" | "exports" | "imports";
  readonly importSpecifier?: string;
  readonly sourceRoot?: string;
  readonly tsconfig?: string;
  readonly config?: string;
  readonly cwd?: string;
  readonly dryRun?: boolean;
  readonly silent?: boolean;
}

export interface CodemodCommandResult {
  readonly exitCode: number;
  readonly action: string;
  readonly edit: MagicEditResult;
}

/**
 * Expands Bunest Class Macro decorators (`@Data`, `@Value`, `@Builder`,
 * `@WithLogger`, `@FieldNameConstants`, etc.) into explicit TypeScript code
 * using `magic-string`, preserving 100% original formatting & comments.
 */
export async function runDelombokCommand(
  options: DelombokCommandOptions,
  io?: CliIO,
): Promise<DelombokCommandResult> {
  const cwd = resolve(options.cwd ?? io?.cwd ?? process.cwd());
  const loaded = await loadCliConfiguration(cwd, options.config);
  const bunestConfig =
    options.bunestConfig ?? (await loadBunestConfig(cwd)).config;
  const sourceRoot = options.sourceRoot ?? loaded.config.sourceRoot ?? "src";

  const analyzer = new BunestStaticAnalyzer({
    cwd,
    sourceRoot,
    tsconfigPath: options.tsconfig,
    bunestConfig,
  });
  const snap = analyzer.analyze();

  const absTarget = resolve(cwd, options.target);
  const macro = snap.scan.classMacros.find((m) => {
    const fileMatch =
      m.sourceFile === absTarget ||
      m.className === options.target ||
      m.className.toLowerCase() === options.target.toLowerCase();
    if (!fileMatch) return false;
    if (options.className && m.className !== options.className) return false;
    return true;
  });

  if (!macro) {
    io?.stderr(
      `[delombok] No macro-decorated class matching "${options.target}" found under "${sourceRoot}".`,
    );
    return {
      exitCode: 1,
      filePath: absTarget,
      className: options.className ?? options.target,
      changed: false,
      updated: "",
    };
  }

  const sf = analyzer.getSourceFile(macro.sourceFile);
  const cls = sf?.getClass(macro.className);
  if (!sf || !cls) {
    io?.stderr(`[delombok] Failed to load AST for ${macro.className}.`);
    return {
      exitCode: 1,
      filePath: macro.sourceFile,
      className: macro.className,
      changed: false,
      updated: "",
    };
  }

  const res = buildDelombokEdit({
    sourceFile: sf,
    classDecl: cls,
    macro,
    targetDecorator: options.decorator,
    bunestConfig,
  });

  if (res.changed && !options.dryRun) {
    if (typeof Bun !== "undefined") {
      await Bun.write(res.filePath, res.updated);
    } else {
      writeTextSync(res.filePath, res.updated);
    }
  }

  if (io && !options.silent) {
    const rel = relative(cwd, res.filePath).replace(/\\/g, "/");
    if (!res.changed) {
      io.stdout(`[delombok] No macro changes needed for ${macro.className} (${rel}).`);
    } else if (options.dryRun) {
      io.stdout(`[delombok] [dry-run] Preview for ${macro.className} (${rel}):\n${res.updated}`);
    } else {
      io.stdout(
        `[delombok] Expanded ${options.decorator ? `@${options.decorator}` : "class macros"} on ${macro.className} in ${rel}.`,
      );
    }
  }

  return {
    exitCode: 0,
    filePath: res.filePath,
    className: macro.className,
    changed: res.changed,
    updated: res.updated,
  };
}

/**
 * Runs a targeted `magic-string` codemod from the CLI:
 * - `derived-to-query`: converts derived repository method(s) to explicit `@Query(...)`
 * - `collapse-logger`: collapses `private readonly logger = new Logger(...)` to `@WithLogger()`
 * - `sync-di`: auto-syncs DI `constructor(...)` parameters
 * - `add-provider`: adds a class into `@Module({ providers/controllers/... })`
 */
export async function runCodemodCommand(
  options: CodemodCommandOptions,
  io?: CliIO,
): Promise<CodemodCommandResult> {
  const cwd = resolve(options.cwd ?? io?.cwd ?? process.cwd());
  const loaded = await loadCliConfiguration(cwd, options.config);
  const sourceRoot = options.sourceRoot ?? loaded.config.sourceRoot ?? "src";
  const absFile = resolve(cwd, options.targetFile);

  const analyzer = new BunestStaticAnalyzer({
    cwd,
    sourceRoot,
    tsconfigPath: options.tsconfig,
  });
  const snap = analyzer.analyze();
  const sf = analyzer.getSourceFile(absFile);

  if (!sf) {
    const empty: MagicEditResult = {
      filePath: absFile,
      original: "",
      updated: "",
      changed: false,
      edits: [],
    };
    io?.stderr(`[codemod] Source file not found in project: ${options.targetFile}`);
    return { exitCode: 1, action: options.action, edit: empty };
  }

  let edit: MagicEditResult = {
    filePath: absFile,
    original: sf.getFullText(),
    updated: sf.getFullText(),
    changed: false,
    edits: [],
  };

  switch (options.action) {
    case "derived-to-query": {
      const repo = snap.repositories.find(
        (r) =>
          r.sourceFile === absFile &&
          (!options.className || r.className === options.className),
      );
      if (!repo) {
        io?.stderr(`[codemod] No declarative repository found in ${options.targetFile}.`);
        return { exitCode: 1, action: options.action, edit };
      }
      const targetMethods = repo.methods
        .filter(
          (m) =>
            m.derived &&
            (!options.methodName || m.name === options.methodName),
        )
        .sort((a, b) => b.methodStart - a.methodStart);

      if (targetMethods.length === 0) {
        io?.stderr(
          `[codemod] No matching derived method found in ${repo.className}.`,
        );
        return { exitCode: 1, action: options.action, edit };
      }

      let currentText = sf.getFullText();
      const origText = currentText;
      for (const m of targetMethods) {
        const res = buildConvertDerivedToQueryEdit({
          filePath: absFile,
          sourceText: currentText,
          method: m,
          repo,
        });
        if (res.changed) currentText = res.updated;
      }
      edit = {
        filePath: absFile,
        original: origText,
        updated: currentText,
        changed: currentText !== origText,
        edits:
          currentText === origText
            ? []
            : [
                {
                  filePath: absFile,
                  start: 0,
                  end: origText.length,
                  newText: currentText,
                  description: `Convert ${targetMethods.length} derived query method(s) to @Query()`,
                },
              ],
      };
      break;
    }

    case "collapse-logger": {
      const cls = options.className
        ? sf.getClass(options.className)
        : sf.getClasses()[0];
      if (!cls) {
        io?.stderr(`[codemod] Target class not found in ${options.targetFile}.`);
        return { exitCode: 1, action: options.action, edit };
      }
      edit = buildCollapseLoggerBoilerplateEdit({ sourceFile: sf, classDecl: cls });
      break;
    }

    case "sync-di": {
      const cls = options.className
        ? sf.getClass(options.className)
        : sf.getClasses()[0];
      if (!cls) {
        io?.stderr(`[codemod] Target class not found in ${options.targetFile}.`);
        return { exitCode: 1, action: options.action, edit };
      }
      edit = buildSyncDiConstructorEdit({ sourceFile: sf, classDecl: cls });
      break;
    }

    case "add-provider": {
      const modName =
        options.moduleName ?? options.className ?? sf.getClasses()[0]?.getName();
      if (!modName || !options.symbolName) {
        io?.stderr(
          "[codemod] add-provider requires --symbol <Name> (and optional --module <ModuleName>).",
        );
        return { exitCode: 1, action: options.action, edit };
      }
      edit = buildAddProviderToModuleEdit({
        sourceFile: sf,
        moduleClassName: modName,
        symbolName: options.symbolName,
        arrayProperty: options.arrayProperty ?? "providers",
        importSpecifier: options.importSpecifier,
      });
      break;
    }

    default: {
      io?.stderr(
        `[codemod] Unknown action "${options.action}". Supported: derived-to-query, collapse-logger, sync-di, add-provider.`,
      );
      return { exitCode: 1, action: options.action, edit };
    }
  }

  if (edit.changed && !options.dryRun) {
    if (typeof Bun !== "undefined") {
      await Bun.write(edit.filePath, edit.updated);
    } else {
      writeTextSync(edit.filePath, edit.updated);
    }
  }

  if (io && !options.silent) {
    const rel = relative(cwd, edit.filePath).replace(/\\/g, "/");
    if (!edit.changed) {
      io.stdout(`[codemod] No changes needed for ${options.action} on ${rel}.`);
    } else if (options.dryRun) {
      io.stdout(`[codemod] [dry-run] ${options.action} on ${rel}:\n${edit.updated}`);
    } else {
      io.stdout(`[codemod] Applied ${options.action} to ${rel}.`);
    }
  }

  return {
    exitCode: 0,
    action: options.action,
    edit,
  };
}
