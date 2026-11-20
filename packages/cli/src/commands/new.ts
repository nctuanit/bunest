import { resolve } from "node:path";
import { buildProjectTemplateFiles } from "../templates/project.templates";
import type {
  CliIO,
  CreateProjectOptions,
  CreateProjectResult,
  SpawnFn,
} from "../types";
import { writePlannedFiles } from "../utils/fs-writer";
import { validateProjectName } from "../utils/naming";

const VALID_PACKAGE_MANAGERS = new Set(["bun", "npm", "yarn", "pnpm"]);

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
  const projectName = validateProjectName(options.projectName);
  const cwd = options.cwd ?? io?.cwd ?? process.cwd();
  const targetDir = options.dir
    ? resolve(cwd, options.dir)
    : resolve(cwd, projectName);
  const dryRun = options.dryRun ?? false;
  const skipInstall = options.skipInstall ?? false;
  const skipGit = options.skipGit ?? true;
  const strict = options.strict ?? true;
  const packageManager = options.packageManager ?? "bun";
  const force = options.force ?? false;

  if (!VALID_PACKAGE_MANAGERS.has(packageManager)) {
    throw new Error(
      `Invalid package manager "${packageManager}". Expected one of: bun, npm, yarn, pnpm.`,
    );
  }

  const plannedFiles = buildProjectTemplateFiles(projectName, { strict });
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
  }

  const spawn = options.spawn ?? defaultSpawn;

  let gitInitialized = false;
  if (!dryRun && !skipGit) {
    const gitRes = await spawn(["git", "init"], {
      cwd: targetDir,
      env: process.env,
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
      env: process.env,
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
        `\n[dry-run] Planned ${files.length} file(s) for "${projectName}" in ${targetDir}.`,
      );
    } else {
      io.stdout(
        `\nCreated Bunest project "${projectName}" in ${targetDir} (${files.length} files).`,
      );
      if (skipInstall) {
        io.stdout(
          `Next steps:\n  cd ${projectName}\n  ${packageManager} install\n  ${packageManager} run dev`,
        );
      } else {
        io.stdout(
          `Next steps:\n  cd ${projectName}\n  ${packageManager} run dev`,
        );
      }
    }
  }

  return {
    projectName,
    targetDir,
    files,
    installed,
    gitInitialized,
    packageManager,
    dryRun,
  };
}
