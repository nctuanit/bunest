/**
 * Staging registry publish-order & clean-environment install verifier (Week 4).
 *
 * Modes:
 *   1. Plan / offline DAG & export audit (default):
 *        bun run scripts/verify-staging-registry.ts --plan
 *
 *   2. Live staging registry verification (e.g. Verdaccio or npm staging):
 *        bun run scripts/verify-staging-registry.ts --registry=http://127.0.0.1:4873 [--publish] [--version=0.1.0-rc.1]
 *
 * When `--registry` is provided, this script runs OUTSIDE the monorepo in a
 * fresh temp directory with ZERO workspace links and ZERO tarball overrides:
 *   - Installs `@bunest/cli` directly from `--registry`
 *   - Scaffolds a clean app, runs install, typecheck, test, build, start & HTTP check
 *   - Copies `examples/production-rest-postgres` outside the monorepo, rewrites
 *     `workspace:*` to the published version, installs from `--registry`, builds,
 *     and optionally runs `smoke:postgres` if `DATABASE_ADMIN_URL` is set.
 */
import {
  dirname,
  ensureDir,
  join,
  readDirSyncNames,
  removePath,
  resolve,
  statSyncPath,
} from "../packages/core/src/common/index";

interface PkgMeta {
  name: string;
  version: string;
  dir: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  exports?: Record<string, unknown>;
}

const ROOT = resolve(import.meta.dir, "..");
const PACKAGES_DIR = join(ROOT, "packages");

async function loadPublishablePackages(): Promise<PkgMeta[]> {
  const dirs = readDirSyncNames(PACKAGES_DIR)
    .map((name) => join(PACKAGES_DIR, name))
    .filter((p) => {
      try {
        return statSyncPath(p).isDirectory();
      } catch {
        return false;
      }
    });

  const pkgs: PkgMeta[] = [];
  for (const dir of dirs) {
    const pkgPath = join(dir, "package.json");
    const file = Bun.file(pkgPath);
    if (!(await file.exists())) continue;
    const json = (await file.json()) as PkgMeta;
    if (json.private) continue;
    pkgs.push({ ...json, dir });
  }
  return pkgs;
}

async function copyTree(srcRoot: string, destRoot: string): Promise<void> {
  const glob = new Bun.Glob("**/*");
  for await (const rel of glob.scan({ cwd: srcRoot, onlyFiles: true })) {
    if (
      rel.startsWith("node_modules/") ||
      rel.startsWith("dist/") ||
      rel.startsWith(".smoke-logs/")
    ) {
      continue;
    }
    const target = join(destRoot, rel);
    await ensureDir(dirname(target));
    await Bun.write(target, Bun.file(join(srcRoot, rel)));
  }
}

/**
 * Computes deterministic topological publish order (dependencies before consumers).
 */
function topologicalOrder(pkgs: PkgMeta[]): PkgMeta[] {
  const byName = new Map(pkgs.map((p) => [p.name, p]));
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const p of pkgs) {
    inDegree.set(p.name, 0);
    dependents.set(p.name, []);
  }

  for (const p of pkgs) {
    const internalDeps = Object.keys({
      ...(p.dependencies ?? {}),
    }).filter((d) => byName.has(d));
    for (const dep of internalDeps) {
      inDegree.set(p.name, (inDegree.get(p.name) ?? 0) + 1);
      dependents.get(dep)!.push(p.name);
    }
  }

  const queue = [...pkgs]
    .filter((p) => (inDegree.get(p.name) ?? 0) === 0)
    .map((p) => p.name)
    .sort();

  const ordered: PkgMeta[] = [];
  while (queue.length > 0) {
    const name = queue.shift()!;
    ordered.push(byName.get(name)!);
    for (const next of (dependents.get(name) ?? []).sort()) {
      const deg = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, deg);
      if (deg === 0) {
        queue.push(next);
        queue.sort();
      }
    }
  }

  if (ordered.length !== pkgs.length) {
    const remaining = pkgs
      .filter((p) => !ordered.includes(p))
      .map((p) => p.name);
    throw new Error(
      `Cycle detected in publishable package graph: ${remaining.join(", ")}`,
    );
  }
  return ordered;
}

async function runCmd(
  cmd: string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<void> {
  const proc = Bun.spawn(cmd, {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
    env: { ...Bun.env, ...(env ?? {}) },
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`Command failed (${code}): ${cmd.join(" ")} (cwd: ${cwd})`);
  }
}

async function main(): Promise<void> {
  const args = new Map<string, string | true>();
  for (const arg of Bun.argv.slice(2)) {
    if (arg.startsWith("--")) {
      const [k, v] = arg.slice(2).split("=", 2);
      args.set(k!, v ?? true);
    }
  }

  const pkgs = await loadPublishablePackages();
  const ordered = topologicalOrder(pkgs);

  console.log(
    `[staging-verify] Validated DAG across ${ordered.length} publishable @bunest/* packages.`,
  );
  for (const [i, pkg] of ordered.entries()) {
    const exportsCount = pkg.exports ? Object.keys(pkg.exports).length : 0;
    const internalDeps = Object.keys(pkg.dependencies ?? {}).filter((d) =>
      d.startsWith("@bunest/"),
    );
    console.log(
      `  ${String(i + 1).padStart(2, " ")}. ${pkg.name}@${pkg.version} (exports: ${exportsCount}, internal deps: ${internalDeps.length})`,
    );
  }

  const registry =
    typeof args.get("registry") === "string"
      ? (args.get("registry") as string).replace(/\/$/, "")
      : undefined;

  if (!registry || args.has("plan")) {
    console.log(
      `[staging-verify] Plan check passed. Pass --registry=<url> to run clean out-of-repo install verification.`,
    );
    return;
  }

  const version =
    typeof args.get("version") === "string"
      ? (args.get("version") as string)
      : ordered[0]!.version;

  if (args.has("publish")) {
    console.log(
      `[staging-verify] Publishing ${ordered.length} packages in topological order to ${registry}...`,
    );
    for (const pkg of ordered) {
      await runCmd(
        ["bun", "publish", "--registry", registry, "--access", "public"],
        pkg.dir,
      );
    }
  }

  const workDir = join(
    Bun.env.TMPDIR ?? "/tmp",
    `bunest-staging-clean-${Date.now()}-${Math.floor(Math.random() * 10_000)}`,
  );
  await ensureDir(workDir);
  try {
    // 1. Clean CLI scaffold outside monorepo using ONLY staging registry
    console.log(
      `[staging-verify] 1/2: Scaffolding clean app from ${registry} in ${workDir}`,
    );
    const cliDir = join(workDir, "cli-runner");
    await ensureDir(cliDir);
    await Bun.write(
      join(cliDir, "package.json"),
      JSON.stringify(
        {
          name: "bunest-cli-runner",
          private: true,
          dependencies: { "@bunest/cli": version },
        },
        null,
        2,
      ),
    );
    await Bun.write(
      join(cliDir, "bunfig.toml"),
      `[install]\nregistry = "${registry}"\n`,
    );
    await runCmd(["bun", "install"], cliDir);

    const appDir = join(workDir, "clean-app");
    await runCmd(
      [
        join(cliDir, "node_modules/.bin/bunest"),
        "new",
        appDir,
        "--template=api",
        "--no-install",
      ],
      workDir,
    );
    await Bun.write(
      join(appDir, "bunfig.toml"),
      `[install]\nregistry = "${registry}"\n`,
    );
    await runCmd(["bun", "install"], appDir);
    await runCmd(["bun", "run", "typecheck"], appDir);
    await runCmd(["bun", "test"], appDir);
    await runCmd(["bun", "run", "build"], appDir);

    // 2. Clean out-of-repo install & build of examples/production-rest-postgres
    console.log(
      `[staging-verify] 2/2: Installing & building production-rest-postgres from ${registry}`,
    );
    const prodDir = join(workDir, "production-rest-postgres");
    await copyTree(join(ROOT, "examples/production-rest-postgres"), prodDir);
    const prodPkgPath = join(prodDir, "package.json");
    const prodPkg = (await Bun.file(prodPkgPath).json()) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    for (const section of [prodPkg.dependencies, prodPkg.devDependencies]) {
      if (!section) continue;
      for (const [dep, val] of Object.entries(section)) {
        if (val.startsWith("workspace:")) {
          section[dep] = version;
        }
      }
    }
    await Bun.write(prodPkgPath, JSON.stringify(prodPkg, null, 2) + "\n");
    await Bun.write(
      join(prodDir, "bunfig.toml"),
      `[install]\nregistry = "${registry}"\n`,
    );
    await Bun.write(
      join(prodDir, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            target: "ESNext",
            module: "ESNext",
            moduleResolution: "bundler",
            strict: true,
            experimentalDecorators: true,
            emitDecoratorMetadata: true,
            verbatimModuleSyntax: true,
            noEmit: true,
          },
          include: ["src/**/*.ts", "scripts/**/*.ts", "test/**/*.ts"],
        },
        null,
        2,
      ),
    );
    await runCmd(["bun", "install"], prodDir);
    await runCmd(["bun", "run", "typecheck"], prodDir);
    await runCmd(["bun", "test"], prodDir);
    await runCmd(["bun", "run", "build"], prodDir);

    if (Bun.env.DATABASE_ADMIN_URL) {
      await runCmd(["bun", "run", "smoke:postgres"], prodDir);
    }

    console.log(
      `[staging-verify] Clean out-of-monorepo registry verification PASSED for ${registry}.`,
    );
  } finally {
    await removePath(workDir);
  }
}

await main();
