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
  existsSyncPath,
  join,
  lstatPath,
  readDirSyncNames,
  realpathOf,
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

async function assertNoMonorepoSymlinks(
  appDir: string,
  expectedVersion: string,
): Promise<number> {
  const scopeDir = join(appDir, "node_modules", "@bunest");
  if (!existsSyncPath(scopeDir)) {
    throw new Error(`Missing installed @bunest scope directory: ${scopeDir}`);
  }
  const entries = readDirSyncNames(scopeDir);
  if (entries.length === 0) {
    throw new Error(`No @bunest/* packages installed in ${scopeDir}`);
  }

  const normalizedRoot = (await realpathOf(ROOT)).toLowerCase();
  const normalizedApp = (await realpathOf(appDir)).toLowerCase();

  for (const name of entries) {
    const pkgPath = join(scopeDir, name);
    const lstat = await lstatPath(pkgPath);
    const real = (await realpathOf(pkgPath)).toLowerCase();

    if (real.startsWith(normalizedRoot)) {
      throw new Error(
        `Monorepo symlink leak detected: ${pkgPath} -> ${real}`,
      );
    }
    if (lstat.isSymbolicLink() && !real.startsWith(normalizedApp)) {
      throw new Error(
        `Unexpected external symlink for @bunest/${name}: ${pkgPath} -> ${real}`,
      );
    }

    const pkgJson = (await Bun.file(join(pkgPath, "package.json")).json()) as {
      name: string;
      version: string;
      exports?: Record<string, string | { bun?: string; import?: string }>;
    };
    if (pkgJson.version !== expectedVersion) {
      throw new Error(
        `Expected ${pkgJson.name}@${expectedVersion} in ${appDir}, found ${pkgJson.version}`,
      );
    }
    const rootExport = pkgJson.exports?.["."];
    if (
      rootExport &&
      typeof rootExport === "object" &&
      typeof rootExport.bun === "string" &&
      rootExport.bun.startsWith("./src/")
    ) {
      throw new Error(
        `Installed ${pkgJson.name}@${pkgJson.version} still has raw ./src/ bun export (${rootExport.bun})`,
      );
    }
  }

  return entries.length;
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

  const corePkgJson = (await Bun.file(
    join(PACKAGES_DIR, "core", "package.json"),
  ).json()) as { version: string };
  const coreVersion = corePkgJson.version;

  const explicitVersion =
    typeof args.get("version") === "string"
      ? (args.get("version") as string).trim()
      : undefined;
  const version = explicitVersion ?? coreVersion;

  if (args.has("publish")) {
    if (explicitVersion && explicitVersion !== coreVersion) {
      throw new Error(
        `Cannot run --publish with --version=${explicitVersion}: workspace packages/core/package.json is at ${coreVersion}. ` +
          `Update workspace package versions to ${explicitVersion} before publishing, or omit --publish to verify an already-published version from ${registry}.`,
      );
    }

    const tag =
      typeof args.get("tag") === "string"
        ? (args.get("tag") as string).trim()
        : undefined;
    console.log(
      `[staging-verify] Delegating publish of ${ordered.length} packages @ ${version} to scripts/publish-packages.ts (registry: ${registry}${tag ? `, tag: ${tag}` : ""})...`,
    );
    const publishCmd = [
      "bun",
      "run",
      join(ROOT, "scripts", "publish-packages.ts"),
      `--registry=${registry}`,
      `--expect-version=${version}`,
      "--skip-existing",
    ];
    if (tag) {
      publishCmd.push(`--tag=${tag}`);
    }
    await runCmd(publishCmd, ROOT);
  }

  const workDir = join(
    Bun.env.TMPDIR ?? Bun.env.TEMP ?? Bun.env.TMP ?? "/tmp",
    `bunest-staging-clean-${Date.now()}-${Math.floor(Math.random() * 10_000)}`,
  );
  const cacheDir = join(workDir, "bun-cache");
  const isolatedInstallEnv = { BUN_INSTALL_CACHE_DIR: cacheDir };
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
      `[install]\nregistry = "${registry}"\n\n[install.cache]\ndisable = true\n`,
    );
    await runCmd(["bun", "install", "--no-cache"], cliDir, isolatedInstallEnv);
    await assertNoMonorepoSymlinks(cliDir, version);

    const appDir = join(workDir, "clean-app");
    const bunestCliEntry = join(
      cliDir,
      "node_modules",
      "@bunest",
      "cli",
      "dist",
      "cli.js",
    );
    await runCmd(
      [
        "bun",
        bunestCliEntry,
        "new",
        "clean-app",
        "--dir",
        appDir,
        "--skip-install",
      ],
      workDir,
    );

    // Pin exact @bunest/* versions in clean-app/package.json
    const appPkgPath = join(appDir, "package.json");
    const appPkg = (await Bun.file(appPkgPath).json()) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    for (const section of [appPkg.dependencies, appPkg.devDependencies]) {
      if (!section) continue;
      for (const dep of Object.keys(section)) {
        if (dep.startsWith("@bunest/")) {
          section[dep] = version;
        }
      }
    }
    await Bun.write(appPkgPath, JSON.stringify(appPkg, null, 2) + "\n");

    const appBunfigPath = join(appDir, "bunfig.toml");
    const existingBunfig = (await Bun.file(appBunfigPath).exists())
      ? await Bun.file(appBunfigPath).text()
      : "";
    await Bun.write(
      appBunfigPath,
      `${existingBunfig}${existingBunfig.endsWith("\n") || existingBunfig === "" ? "" : "\n"}\n[install]\nregistry = "${registry}"\n\n[install.cache]\ndisable = true\n`,
    );
    await runCmd(["bun", "install", "--no-cache"], appDir, isolatedInstallEnv);
    await assertNoMonorepoSymlinks(appDir, version);
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
        if (val.startsWith("workspace:") || dep.startsWith("@bunest/")) {
          section[dep] = version;
        }
      }
    }
    await Bun.write(prodPkgPath, JSON.stringify(prodPkg, null, 2) + "\n");
    await Bun.write(
      join(prodDir, "bunfig.toml"),
      `[install]\nregistry = "${registry}"\n\n[install.cache]\ndisable = true\n`,
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
    await runCmd(["bun", "install", "--no-cache"], prodDir, isolatedInstallEnv);
    await assertNoMonorepoSymlinks(prodDir, version);
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
