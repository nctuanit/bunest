/**
 * Emits TypeScript declaration files (`.d.ts`) into `dist/` for all publishable
 * `@bunest/*` workspace packages in a single fast `tsc --emitDeclarationOnly` pass.
 *
 * Keeps in-repo `exports[*].types` pointing to `./src/*.ts` for zero-build monorepo
 * DX while populating `packages/<pkg>/dist/<path>.d.ts` for published tarballs
 * (rewritten at pack/publish time by `scripts/publish-manifest.ts`).
 */
import {
  dirname,
  ensureDir,
  existsSyncPath,
  join,
  readDirSyncNames,
  relative,
  removePath,
  resolve,
  statSyncPath,
} from "../packages/core/src/common/index";
import { toDistDtsPath, type PublishableManifest } from "./publish-manifest";

const ROOT = resolve(import.meta.dir, "..");
const PACKAGES_DIR = join(ROOT, "packages");

function resolveTscCommand(): string[] {
  const binName = process.platform === "win32" ? "tsc.exe" : "tsc";
  const localBin = join(ROOT, "node_modules", ".bin", binName);
  if (existsSyncPath(localBin)) {
    return [localBin];
  }
  return ["bunx", "--no-install", "tsc"];
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

async function main(): Promise<void> {
  const startedAt = performance.now();
  const baseTmp = Bun.env.TMPDIR ?? Bun.env.TEMP ?? Bun.env.TMP ?? "/tmp";
  const tmpDir = join(baseTmp, `bunest-dts-${crypto.randomUUID()}`);
  const outDir = join(tmpDir, "out");
  const tmpTsconfigPath = join(tmpDir, "tsconfig.dts.json");

  await ensureDir(outDir);

  try {
    const rootPosix = toPosix(ROOT);
    const packagesPosix = toPosix(PACKAGES_DIR);
    const tsconfig = {
      extends: `${rootPosix}/tsconfig.base.json`,
      compilerOptions: {
        noEmit: false,
        declaration: true,
        emitDeclarationOnly: true,
        declarationMap: false,
        rootDir: packagesPosix,
        outDir: toPosix(outDir),
        typeRoots: [`${rootPosix}/node_modules/@types`],
      },
      include: [`${packagesPosix}/*/src/**/*.ts`],
      exclude: [
        `${rootPosix}/node_modules`,
        `${packagesPosix}/*/dist`,
        `${packagesPosix}/*/test`,
      ],
    };

    await Bun.write(tmpTsconfigPath, JSON.stringify(tsconfig, null, 2) + "\n");

    const cmd = [...resolveTscCommand(), "-p", tmpTsconfigPath];
    const proc = Bun.spawnSync(cmd, {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
      env: Bun.env,
    });

    if (proc.exitCode !== 0) {
      const stdout = proc.stdout.toString().trim();
      const stderr = proc.stderr.toString().trim();
      throw new Error(
        `[build-dts] tsc --emitDeclarationOnly failed (exit ${proc.exitCode}):\n${stdout}\n${stderr}`,
      );
    }

    const pkgNames = readDirSyncNames(PACKAGES_DIR)
      .filter((name) => {
        const dir = join(PACKAGES_DIR, name);
        return (
          statSyncPath(dir).isDirectory() &&
          existsSyncPath(join(dir, "package.json"))
        );
      })
      .sort();

    let totalDtsFiles = 0;
    const leakedFiles: string[] = [];
    const glob = new Bun.Glob("**/*.d.ts");

    for (const pkgName of pkgNames) {
      const emittedSrcDir = join(outDir, pkgName, "src");
      if (!existsSyncPath(emittedSrcDir)) {
        throw new Error(
          `[build-dts] No .d.ts files emitted for packages/${pkgName}`,
        );
      }

      const targetDistDir = join(PACKAGES_DIR, pkgName, "dist");
      await ensureDir(targetDistDir);

      for await (const rel of glob.scan({ cwd: emittedSrcDir, onlyFiles: true })) {
        const srcFile = join(emittedSrcDir, rel);
        const destFile = join(targetDistDir, rel);
        await ensureDir(dirname(destFile));

        const content = await Bun.file(srcFile).text();
        if (content.includes("/src/") || content.includes("../packages/")) {
          leakedFiles.push(`packages/${pkgName}/dist/${rel.replace(/\\/g, "/")}`);
        }

        await Bun.write(destFile, content);
        totalDtsFiles++;
      }
    }

    if (leakedFiles.length > 0) {
      throw new Error(
        `[build-dts] Emitted .d.ts files contain internal monorepo path leaks:\n  - ${leakedFiles.slice(0, 20).join("\n  - ")}`,
      );
    }

    // Verify every package export subpath has a non-empty .d.ts in dist/
    let verifiedSubpaths = 0;
    const missingTargets: string[] = [];

    for (const pkgName of pkgNames) {
      const pkgDir = join(PACKAGES_DIR, pkgName);
      const pkg = (await Bun.file(
        join(pkgDir, "package.json"),
      ).json()) as PublishableManifest;

      for (const [subpath, entry] of Object.entries(pkg.exports ?? {})) {
        if (subpath === "./package.json" || typeof entry !== "object" || !entry) {
          continue;
        }
        if (typeof entry.types !== "string") {
          missingTargets.push(`packages/${pkgName} exports["${subpath}"] missing "types"`);
          continue;
        }
        const dtsRel = toDistDtsPath(entry.types);
        const dtsAbs = resolve(pkgDir, dtsRel);
        if (!existsSyncPath(dtsAbs) || statSyncPath(dtsAbs).size === 0) {
          missingTargets.push(
            `packages/${pkgName} exports["${subpath}"] -> ${relative(ROOT, dtsAbs)}`,
          );
        } else {
          verifiedSubpaths++;
        }
      }
    }

    if (missingTargets.length > 0) {
      throw new Error(
        `[build-dts] Missing or empty .d.ts export targets:\n  - ${missingTargets.join("\n  - ")}`,
      );
    }

    const elapsedMs = Math.round(performance.now() - startedAt);
    console.log(
      `[build-dts] Emitted ${totalDtsFiles} .d.ts files across ${pkgNames.length} packages (${verifiedSubpaths} export subpaths verified) in ${elapsedMs}ms.`,
    );
  } finally {
    await removePath(tmpDir, { recursive: true, force: true });
  }
}

await main();
