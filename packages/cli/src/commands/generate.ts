import { resolve } from "@bunest/core";
import {
  loadCliConfiguration,
  resolveProjectConfiguration,
} from "../config/configuration.loader";
import {
  buildSchematicFiles,
  resolveSchematicType,
} from "../templates/schematic.templates";
import type {
  CliIO,
  GenerateSchematicOptions,
  GenerateSchematicResult,
  SchematicType,
} from "../types";
import { writePlannedFiles } from "../utils/fs-writer";
import { parseSchematicName } from "../utils/naming";

const WORKSPACE_ROOT_SCHEMATICS = new Set<SchematicType>([
  "configuration",
  "library",
  "sub-app",
  "application",
]);

/**
 * Generates Bunest source & spec files for a schematic
 * (`bunest generate <schematic> <name>` / `bunest g <schematic> <name>`).
 */
export async function generateSchematic(
  options: GenerateSchematicOptions,
  io?: CliIO,
): Promise<GenerateSchematicResult> {
  const schematic = resolveSchematicType(options.schematic);
  const parsedName = parseSchematicName(options.name);
  const cwd = options.cwd ?? io?.cwd ?? process.cwd();
  const { config } = await loadCliConfiguration(cwd, options.config);
  const project = resolveProjectConfiguration(config, options.project);

  const genOpts = {
    ...(config.generateOptions ?? {}),
    ...(project?.generateOptions ?? {}),
  };

  const defaultBaseDir = WORKSPACE_ROOT_SCHEMATICS.has(schematic)
    ? "."
    : (options.sourceRoot ??
      project?.sourceRoot ??
      genOpts.baseDir ??
      config.sourceRoot ??
      "src");

  const targetDir = resolve(cwd, options.dir ?? defaultBaseDir);
  const flat = options.flat ?? genOpts.flat ?? false;

  let defaultSpec = true;
  if (typeof genOpts.spec === "boolean") {
    defaultSpec = genOpts.spec;
  } else if (genOpts.spec && typeof genOpts.spec === "object") {
    defaultSpec = genOpts.spec[schematic] ?? true;
  }
  const spec = options.spec ?? defaultSpec;
  const specFileSuffix =
    options.specFileSuffix ?? genOpts.specFileSuffix ?? "spec";
  const dryRun = options.dryRun ?? false;
  const force = options.force ?? false;

  const plannedFiles = buildSchematicFiles(schematic, parsedName, {
    flat,
    spec,
    specFileSuffix,
    language: options.language,
    collection: options.collection,
  });

  const files = await writePlannedFiles({
    baseDir: targetDir,
    files: plannedFiles,
    dryRun,
    force,
  });

  if (io) {
    for (const file of files) {
      const tag =
        file.action === "dry-run"
          ? "DRY-RUN"
          : file.action === "overwrite"
            ? "OVERWRITE"
            : "CREATE";
      io.stdout(`  ${tag} ${file.relativePath}`);
    }
    if (dryRun) {
      io.stdout(
        `[dry-run] Planned ${files.length} file(s) for ${schematic} "${parsedName.kebab}".`,
      );
    }
  }

  return {
    schematic,
    name: parsedName.kebab,
    targetDir,
    files,
    dryRun,
  };
}
