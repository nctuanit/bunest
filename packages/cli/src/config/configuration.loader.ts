import { join, readTextSync, resolve, statPath } from "@bunest/core";
import type { TypegenConfiguration } from "../typegen/types";
import { stripJsonc } from "../utils/monorepo-updater";

// ============================================================================
// NestJS / Bunest CLI Configuration Types (100% @nestjs/cli parity)
// ============================================================================

export type Asset = string | AssetEntry;

export interface AssetEntry {
  glob: string;
  include?: string;
  flat?: boolean;
  exclude?: string;
  outDir?: string;
  watchAssets?: boolean;
  restartOnChange?: boolean;
}

export interface ActionOnFile {
  action: "change" | "unlink";
  item: AssetEntry;
  path: string;
  sourceRoot: string;
  watchAssetsMode: boolean;
  confinePathsToProject: boolean;
}

export interface SwcBuilderOptions {
  swcrcPath?: string;
  outDir?: string;
  filenames?: string[];
  sync?: boolean;
  extensions?: string[];
  copyFiles?: boolean;
  includeDotfiles?: boolean;
  quiet?: boolean;
}

export interface WebpackBuilderOptions {
  configPath?: string;
}

export interface BundleDependenciesOptions {
  exclude?: string[];
}

export interface RspackBuilderOptions {
  configPath?: string;
}

export interface TscBuilderOptions {
  configPath?: string;
}

export const AVAILABLE_BUILDERS = ["tsc", "webpack", "swc", "rspack"] as const;

export type BuilderVariant = (typeof AVAILABLE_BUILDERS)[number];

export type Builder =
  | BuilderVariant
  | {
      type: "webpack";
      options?: WebpackBuilderOptions;
    }
  | {
      type: "rspack";
      options?: RspackBuilderOptions;
    }
  | {
      type: "swc";
      options?: SwcBuilderOptions;
    }
  | {
      type: "tsc";
      options?: TscBuilderOptions;
    };

export interface PluginOptions {
  name: string;
  options: Record<string, any>;
}

export interface CompilerOptions {
  tsConfigPath?: string;
  /** @deprecated Use `builder` instead. */
  webpack?: boolean;
  /** @deprecated Use `builder.options.configPath` instead. */
  webpackConfigPath?: string;
  plugins?: string[] | PluginOptions[];
  assets?: Asset[];
  deleteOutDir?: boolean;
  allowOutsidePaths?: boolean;
  manualRestart?: boolean;
  builder?: Builder;
  emitDeclarations?: boolean;
  bundleDependencies?: boolean | BundleDependenciesOptions;
  includeLibraryAssets?: string[];
}

export interface GenerateOptions {
  spec?: boolean | Record<string, boolean>;
  flat?: boolean;
  specFileSuffix?: string;
  baseDir?: string;
}

export interface DeployConfiguration {
  command?: string[];
  compile?: boolean;
  outdir?: string;
  entryFile?: string;
}

export interface ProjectConfiguration {
  type?: string;
  root?: string;
  entryFile?: string;
  exec?: string;
  sourceRoot?: string;
  compilerOptions?: CompilerOptions;
  generateOptions?: GenerateOptions;
  deploy?: DeployConfiguration;
  typegen?: boolean | TypegenConfiguration;
}

export interface Configuration {
  language?: string;
  collection?: string;
  sourceRoot?: string;
  entryFile?: string;
  exec?: string;
  monorepo?: boolean;
  compilerOptions?: CompilerOptions;
  generateOptions?: GenerateOptions;
  deploy?: DeployConfiguration;
  typegen?: boolean | TypegenConfiguration;
  projects?: {
    [key: string]: ProjectConfiguration;
  };
}

export const DEFAULT_CONFIGURATION: Required<
  Pick<Configuration, "language" | "collection" | "sourceRoot" | "entryFile">
> &
  Configuration = {
  language: "ts",
  collection: "@bunest/schematics",
  sourceRoot: "src",
  entryFile: "main",
  compilerOptions: {
    deleteOutDir: false,
    assets: [],
    plugins: [],
  },
  generateOptions: {
    spec: true,
    flat: false,
    specFileSuffix: "spec",
  },
};

const DEFAULT_CONFIG_FILENAMES = [
  "bunest.json",
  ".bunestrc.json",
  "nest-cli.json",
  ".nest-cli.json",
  ".nestcli.json",
] as const;

export interface LoadedCliConfiguration {
  readonly config: Configuration;
  readonly configPath?: string;
  readonly found: boolean;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const info = await statPath(filePath);
    return info.isFile();
  } catch {
    return false;
  }
}

/**
 * Zero-dependency loader for `bunest.json` (falling back to `nest-cli.json`).
 * Merges discovered configuration cleanly onto `DEFAULT_CONFIGURATION`.
 */
export async function loadCliConfiguration(
  cwd: string = process.cwd(),
  explicitConfigPath?: string,
): Promise<LoadedCliConfiguration> {
  let targetPath: string | undefined;

  if (explicitConfigPath) {
    const resolved = resolve(cwd, explicitConfigPath);
    if (!(await fileExists(resolved))) {
      throw new Error(`Configuration file not found: ${resolved}`);
    }
    targetPath = resolved;
  } else {
    for (const filename of DEFAULT_CONFIG_FILENAMES) {
      const candidate = join(cwd, filename);
      if (await fileExists(candidate)) {
        targetPath = candidate;
        break;
      }
    }
  }

  if (!targetPath) {
    return {
      config: {
        ...DEFAULT_CONFIGURATION,
        compilerOptions: { ...DEFAULT_CONFIGURATION.compilerOptions },
        generateOptions: { ...DEFAULT_CONFIGURATION.generateOptions },
      },
      found: false,
    };
  }

  const rawText =
    typeof Bun !== "undefined"
      ? await Bun.file(targetPath).text()
      : readTextSync(targetPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonc(rawText));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid JSON in configuration file ${targetPath}: ${msg}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `Configuration file ${targetPath} must export a JSON object.`,
    );
  }

  const userConfig = parsed as Configuration;
  const merged: Configuration = {
    ...DEFAULT_CONFIGURATION,
    ...userConfig,
    compilerOptions: {
      ...DEFAULT_CONFIGURATION.compilerOptions,
      ...(userConfig.compilerOptions ?? {}),
    },
    generateOptions: {
      ...DEFAULT_CONFIGURATION.generateOptions,
      ...(userConfig.generateOptions ?? {}),
    },
  };

  return {
    config: merged,
    configPath: targetPath,
    found: true,
  };
}

/**
 * Resolves effective project settings for an optional named monorepo project.
 */
export function resolveProjectConfiguration(
  config: Configuration,
  projectName?: string,
): ProjectConfiguration | undefined {
  if (!projectName) {
    return undefined;
  }
  const project = config.projects?.[projectName];
  if (!project) {
    const available = Object.keys(config.projects ?? {});
    const suffix =
      available.length > 0
        ? ` Available projects: ${available.join(", ")}.`
        : " No projects are defined in configuration.";
    throw new Error(`Unknown project "${projectName}".${suffix}`);
  }
  return project;
}

/**
 * Resolves the entrypoint TypeScript file from CLI flags and loaded configuration.
 */
export async function resolveEntryFile(
  cwd: string,
  config: Configuration,
  overrides: {
    readonly entry?: string;
    readonly entryFile?: string;
    readonly sourceRoot?: string;
  } = {},
): Promise<string> {
  const sourceRoot = overrides.sourceRoot ?? config.sourceRoot ?? "src";
  const explicit = overrides.entry ?? overrides.entryFile;

  if (explicit) {
    const candidates: string[] = [];
    const hasExtension = /\.[cm]?[jt]sx?$/i.test(explicit);
    const hasPathSep = explicit.includes("/") || explicit.includes("\\");

    if (hasPathSep) {
      candidates.push(resolve(cwd, explicit));
      if (!hasExtension) {
        candidates.push(resolve(cwd, `${explicit}.ts`));
      }
    } else {
      candidates.push(resolve(cwd, sourceRoot, explicit));
      if (!hasExtension) {
        candidates.push(resolve(cwd, sourceRoot, `${explicit}.ts`));
      }
      candidates.push(resolve(cwd, explicit));
      if (!hasExtension) {
        candidates.push(resolve(cwd, `${explicit}.ts`));
      }
    }

    for (const candidate of candidates) {
      if (await fileExists(candidate)) {
        return candidate;
      }
    }
    return candidates[0]!;
  }

  const configEntry = config.entryFile ?? "main";
  const hasExt = /\.[cm]?[jt]sx?$/i.test(configEntry);
  const defaultCandidate = resolve(
    cwd,
    sourceRoot,
    hasExt ? configEntry : `${configEntry}.ts`,
  );
  if (await fileExists(defaultCandidate)) {
    return defaultCandidate;
  }
  return resolve(cwd, "src/main.ts");
}
