import { basename, existsSyncPath, join, resolve } from "@bunest/core";
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
import {
  declareInNearestModule,
  getModuleDeclarationTarget,
} from "../utils/module-declarator";
import {
  parseSchematicName,
  toCamelCase,
  toKebabCase,
  toPascalCase,
  type ParsedSchematicName,
} from "../utils/naming";

const PRESERVABLE_APP_FILES = new Set(["README.md", ".gitignore"]);

function normalizeAppSegment(segment: string): string {
  const leadingUnderscores = /^_+/.exec(segment)?.[0] ?? "";
  const rest = segment.slice(leadingUnderscores.length);
  const normalizedRest = rest
    .split(".")
    .map((part) => toKebabCase(part))
    .filter((part) => part.length > 0)
    .join(".");
  return `${leadingUnderscores}${normalizedRest}`;
}

function parseApplicationSchematicName(
  input: string,
  cwd: string,
): {
  readonly parsed: ParsedSchematicName;
  readonly packageName: string;
  readonly forceFlat?: boolean;
} {
  const trimmed = input.trim();
  if (trimmed === ".") {
    const folderName = basename(resolve(cwd)) || "bunest-app";
    return {
      parsed: {
        subDir: "",
        rawName: folderName,
        kebab: folderName,
        pascal: toPascalCase(folderName) || "App",
        camel: toCamelCase(folderName) || "app",
      },
      packageName: folderName,
      forceFlat: true,
    };
  }

  if (trimmed.startsWith("@")) {
    const slashIdx = trimmed.indexOf("/");
    if (slashIdx === -1) {
      throw new Error(`Invalid scoped application name "${input}".`);
    }
    const rawScope = trimmed.slice(0, slashIdx);
    const rawPkg = trimmed.slice(slashIdx + 1);
    const pkgKebab = normalizeAppSegment(rawPkg);
    if (!pkgKebab) {
      throw new Error(`Invalid scoped application name "${input}".`);
    }
    if (rawScope === "@") {
      return {
        parsed: {
          subDir: "@",
          rawName: rawPkg,
          kebab: pkgKebab,
          pascal: toPascalCase(rawPkg) || "App",
          camel: toCamelCase(rawPkg) || "app",
        },
        packageName: pkgKebab,
      };
    }
    const scopeBody = rawScope.slice(1);
    const normScope = /^\s+$/.test(scopeBody)
      ? "-"
      : normalizeAppSegment(scopeBody);
    const scopeDir = `@${normScope}`;
    return {
      parsed: {
        subDir: scopeDir,
        rawName: rawPkg,
        kebab: pkgKebab,
        pascal: toPascalCase(rawPkg) || "App",
        camel: toCamelCase(rawPkg) || "app",
      },
      packageName: `${scopeDir}/${pkgKebab}`,
    };
  }

  if (/^\d+$/.test(trimmed)) {
    return {
      parsed: {
        subDir: "",
        rawName: trimmed,
        kebab: trimmed,
        pascal: `App${trimmed}`,
        camel: `app${trimmed}`,
      },
      packageName: trimmed,
    };
  }

  const parsed = parseSchematicName(trimmed);
  return { parsed, packageName: parsed.kebab };
}

const WORKSPACE_ROOT_SCHEMATICS = new Set<SchematicType>([
  "configuration",
  "library",
  "sub-app",
  "application",
]);

const DEFAULT_FLAT_SCHEMATICS = new Set<SchematicType>([
  "class",
  "decorator",
  "filter",
  "gateway",
  "guard",
  "interceptor",
  "interface",
  "provider",
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
  const cwd = options.cwd ?? io?.cwd ?? process.cwd();
  const appMeta =
    schematic === "application"
      ? parseApplicationSchematicName(options.name, cwd)
      : undefined;
  const parsedName = appMeta ? appMeta.parsed : parseSchematicName(options.name);
  const loadedConfig = await loadCliConfiguration(cwd, options.config);
  const { config } = loadedConfig;
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

  const explicitDir = options.dir ?? options.directory;
  const targetDir = resolve(cwd, explicitDir ?? defaultBaseDir);
  const configuredFlat =
    project?.generateOptions?.flat !== undefined
      ? project.generateOptions.flat
      : loadedConfig.found
        ? genOpts.flat
        : undefined;
  const appDirFlat =
    schematic === "application" &&
    explicitDir !== undefined &&
    options.flat === undefined
      ? true
      : undefined;
  const flat =
    options.flat ??
    appMeta?.forceFlat ??
    appDirFlat ??
    configuredFlat ??
    (io ? false : DEFAULT_FLAT_SCHEMATICS.has(schematic));

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

  let plannedFiles = buildSchematicFiles(schematic, parsedName, {
    flat,
    spec,
    specFileSuffix,
    language: options.language,
    collection: options.collection,
    strict: options.strict,
    minimal: options.minimal,
    packageName: appMeta?.packageName,
  });

  if (schematic === "application" && !force && !dryRun) {
    plannedFiles = plannedFiles.filter((file) => {
      const base = basename(file.relativePath);
      if (
        PRESERVABLE_APP_FILES.has(base) &&
        existsSyncPath(join(targetDir, file.relativePath))
      ) {
        return false;
      }
      return true;
    });
  }

  const files = await writePlannedFiles({
    baseDir: targetDir,
    files: plannedFiles,
    dryRun,
    force,
  });

  if (!dryRun && !options.skipImport) {
    const declTarget = getModuleDeclarationTarget(schematic, parsedName);
    if (declTarget) {
      const primaryFile = files.find((f) =>
        f.relativePath.endsWith(declTarget.fileSuffix),
      );
      if (primaryFile) {
        const updatedModule = await declareInNearestModule({
          schematic,
          parsedName,
          generatedFilePath: primaryFile.path,
          rootBoundary: cwd,
          explicitModule: options.module,
        });
        if (updatedModule && io) {
          io.stdout(`  UPDATE ${updatedModule}`);
        }
      }
    }
  }

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
