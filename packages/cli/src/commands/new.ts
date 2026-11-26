import {
  basename,
  existsSyncPath,
  join,
  resolve,
  writeTextSync,
} from "@bunest/core";
import { buildProjectTemplateFiles } from "../templates/project.templates";
import type {
  CliIO,
  CreateProjectOptions,
  CreateProjectResult,
  ProjectPreset,
  SpawnFn,
} from "../types";
import { writePlannedFiles } from "../utils/fs-writer";
import { validateProjectName } from "../utils/naming";

const VALID_PACKAGE_MANAGERS = new Set(["bun", "npm", "yarn", "pnpm"]);
const VALID_PRESETS = new Set<ProjectPreset>(["default", "rest-sqlite"]);
const EXTRA_BOOTSTRAP_FILES = ["bunest.json", "preload.ts", "bunfig.toml"] as const;

function formatShellPath(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

const defaultSpawn: SpawnFn = async (cmd, options) => {
  const proc = Bun.spawn(cmd, {
    cwd: options.cwd,
    env: options.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  return { exitCode };
};

/**
 * Scaffolds a new Bunest application project (`bunest new <project-name>`).
 */
export async function createProject(
  options: CreateProjectOptions,
  io?: CliIO,
): Promise<CreateProjectResult> {
  const cwd = options.cwd ?? io?.cwd ?? process.cwd();
  const isCurrentDir = options.projectName.trim() === ".";
  const targetDir = isCurrentDir
    ? options.dir
      ? resolve(cwd, options.dir)
      : resolve(cwd)
    : options.dir
      ? resolve(cwd, options.dir)
      : resolve(cwd, validateProjectName(options.projectName));
  const projectName = isCurrentDir
    ? basename(targetDir) || "bunest-app"
    : validateProjectName(options.projectName);
  const dryRun = options.dryRun ?? false;
  const skipInstall = options.skipInstall ?? false;
  const skipGit = options.skipGit ?? true;
  const strict = options.strict ?? true;
  const packageManager = options.packageManager ?? "bun";
  const preset: ProjectPreset = options.preset ?? "default";
  const force = options.force ?? false;

  if (!VALID_PACKAGE_MANAGERS.has(packageManager)) {
    throw new Error(
      `Invalid package manager "${packageManager}". Expected one of: bun, npm, yarn, pnpm.`,
    );
  }

  if (!VALID_PRESETS.has(preset)) {
    throw new Error(
      `Invalid preset "${String(preset)}". Expected one of: default, rest-sqlite.`,
    );
  }

  const plannedFiles = buildProjectTemplateFiles(projectName, {
    strict,
    preset,
  });
  const files = await writePlannedFiles({
    baseDir: targetDir,
    files: plannedFiles,
    dryRun,
    force,
  });

  if (!dryRun) {
    const bunestJsonPath = join(targetDir, "bunest.json");
    if (!existsSyncPath(bunestJsonPath) || force) {
      const defaultBunestConfig = {
        collection: "@bunest/schematics",
        sourceRoot: "src",
        entryFile: "main",
        compilerOptions: {
          deleteOutDir: true,
          assets: [],
          plugins: [],
        },
        generateOptions: {
          spec: true,
          flat: false,
          specFileSuffix: "spec",
        },
      };
      writeTextSync(
        bunestJsonPath,
        `${JSON.stringify(defaultBunestConfig, null, 2)}\n`,
      );
    }

    const preloadPath = join(targetDir, "preload.ts");
    if (!existsSyncPath(preloadPath) || force) {
      writeTextSync(
        preloadPath,
        `import { registerBunestPlugin } from "@bunest/cli";\n\nregisterBunestPlugin({ classMacros: false });\n`,
      );
    }

    const bunfigPath = join(targetDir, "bunfig.toml");
    if (!existsSyncPath(bunfigPath) || force) {
      writeTextSync(
        bunfigPath,
        `preload = ["./preload.ts"]\n\n[test]\npreload = ["./preload.ts"]\n`,
      );
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
      for (const extraFile of EXTRA_BOOTSTRAP_FILES) {
        io.stdout(`  DRY-RUN ${extraFile}`);
      }
    }
  }

  const spawn = options.spawn ?? defaultSpawn;

  let gitInitialized = false;
  if (!dryRun && !skipGit) {
    const gitRes = await spawn(["git", "init"], {
      cwd: targetDir,
      env: Bun.env,
    });
    gitInitialized = gitRes.exitCode === 0;
  }

  let installed = false;
  if (!dryRun && !skipInstall) {
    const installCmd =
      packageManager === "bun"
        ? [process.execPath, "install"]
        : [packageManager, "install"];
    const { exitCode } = await spawn(installCmd, {
      cwd: targetDir,
      env: Bun.env,
    });
    if (exitCode !== 0) {
      throw new Error(
        `Dependency installation failed ("${packageManager} install" exited with code ${exitCode}).`,
      );
    }
    installed = true;
  }

  if (io) {
    if (dryRun) {
      io.stdout(
        `\n[dry-run] Planned ${files.length + EXTRA_BOOTSTRAP_FILES.length} file(s) for "${projectName}" in ${targetDir}.`,
      );
    } else {
      const cdTarget = options.dir
        ? options.dir
        : isCurrentDir
          ? targetDir
          : projectName;
      const quotedCdTarget = formatShellPath(cdTarget);
      io.stdout(
        `\nCreated Bunest project "${projectName}" in ${targetDir} (${files.length} files).`,
      );
      if (skipInstall) {
        io.stdout(
          `Next steps:\n  cd ${quotedCdTarget}\n  ${packageManager} install\n  ${packageManager} run dev`,
        );
      } else {
        io.stdout(
          `Next steps:\n  cd ${quotedCdTarget}\n  ${packageManager} run dev`,
        );
      }
    }
  }

  return {
    projectName,
    targetDir,
    preset,
    files,
    installed,
    gitInitialized,
    packageManager,
    dryRun,
  };
}
