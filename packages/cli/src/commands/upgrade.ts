import {
  join,
  semverOrder,
  semverSatisfies,
  statPath,
} from "@bunest/core";
import { loadCliConfiguration } from "../config/configuration.loader";
import type {
  CliIO,
  SpawnFn,
  UpgradeProjectOptions,
  UpgradeProjectResult,
} from "../types";

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
 * Checks and upgrades `@bunest/*` dependencies in the current project (`bunest upgrade` / `bunest update`).
 */
export async function upgradeProject(
  options: UpgradeProjectOptions = {},
  io?: CliIO,
): Promise<UpgradeProjectResult> {
  const cwd = options.cwd ?? io?.cwd ?? process.cwd();
  const dryRun = options.dryRun === true;
  const skipInstall = options.skipInstall === true;
  const tag = options.tag?.trim();
  const pkgPath = join(cwd, "package.json");

  const packageSet = new Set<string>();
  const declaredVersions = new Map<string, string>();
  let requiredBunRange: string | undefined;
  try {
    const info = await statPath(pkgPath);
    if (info.isFile()) {
      const pkg = (await Bun.file(pkgPath).json()) as {
        engines?: { bun?: string };
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      if (typeof pkg.engines?.bun === "string") {
        requiredBunRange = pkg.engines.bun;
      }
      const mergedDeps: Record<string, string> = {
        ...(pkg.devDependencies ?? {}),
        ...(pkg.dependencies ?? {}),
      };
      for (const [name, spec] of Object.entries(mergedDeps)) {
        if (name.startsWith("@bunest/")) {
          packageSet.add(name);
          declaredVersions.set(name, spec);
        }
      }
    }
  } catch {
    // No package.json in cwd; fall back to plain `bun update`
  }

  if (
    io &&
    requiredBunRange &&
    typeof Bun !== "undefined" &&
    !semverSatisfies(Bun.version, requiredBunRange)
  ) {
    io.stderr(
      `Warning: current Bun v${Bun.version} does not satisfy engines.bun (${requiredBunRange}).`,
    );
  }

  const concreteVersions = [...declaredVersions.values()]
    .map((v) => v.replace(/^[~^=]+/, ""))
    .filter((v) => /^\d+\.\d+\.\d+/.test(v));
  if (io && concreteVersions.length > 1 && typeof Bun !== "undefined") {
    const sortedVersions = [...new Set(concreteVersions)].sort((a, b) =>
      semverOrder(a, b),
    );
    if (sortedVersions.length > 1) {
      io.stdout(
        `Note: detected mixed @bunest/* versions (${sortedVersions[0]} .. ${sortedVersions[sortedVersions.length - 1]}).`,
      );
    }
  }

  let effectiveCollection = options.collection?.trim();
  if (!effectiveCollection) {
    try {
      const loaded = await loadCliConfiguration(cwd);
      if (
        loaded.found &&
        loaded.config.collection &&
        loaded.config.collection !== "@bunest/schematics"
      ) {
        effectiveCollection = loaded.config.collection;
      }
    } catch {
      // ignore invalid config
    }
  }
  if (effectiveCollection) {
    packageSet.add(effectiveCollection);
  }

  if (options.observe === true) {
    packageSet.add("@bunest/observability");
  }

  const packages = [...packageSet].sort();

  const targets =
    tag && packages.length > 0
      ? packages.map((pkg) => `${pkg}@${tag}`)
      : packages;

  const subcommand = tag && targets.length > 0 ? "add" : "update";
  const displayCmd =
    targets.length > 0 ? ["bun", subcommand, ...targets] : ["bun", "update"];
  const spawnCmd =
    targets.length > 0
      ? [process.execPath, subcommand, ...targets]
      : [process.execPath, "update"];

  if (dryRun || skipInstall) {
    if (io) {
      const label = dryRun ? "[dry-run]" : "[skip-install]";
      const pkgList =
        packages.length > 0
          ? packages.join(", ")
          : "(all project dependencies)";
      io.stdout(`${label} Would upgrade: ${pkgList}`);
      io.stdout(`${label} Command: ${displayCmd.join(" ")}`);
    }
    return {
      packages,
      upgraded: false,
      dryRun,
      command: displayCmd,
      exitCode: 0,
    };
  }

  if (io) {
    io.stdout(`Upgrading Bunest dependencies via "${displayCmd.join(" ")}"...`);
  }

  const spawn = options.spawn ?? defaultSpawn;
  const { exitCode } = await spawn(spawnCmd, {
    cwd,
    env: Bun.env,
  });

  if (exitCode !== 0) {
    throw new Error(
      `Upgrade failed ("${displayCmd.join(" ")}" exited with code ${exitCode}).`,
    );
  }

  if (io) {
    io.stdout("Dependencies upgraded successfully.");
  }

  return {
    packages,
    upgraded: true,
    dryRun: false,
    command: displayCmd,
    exitCode: 0,
  };
}
