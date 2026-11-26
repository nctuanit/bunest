/**
 * Deterministic topological npm publisher & tarball packer for all publishable @bunest/* packages.
 *
 * Usage:
 *   bun run scripts/publish-packages.ts --dry-run
 *   bun run scripts/publish-packages.ts --pack=./dist-tarballs
 *   bun run scripts/publish-packages.ts --registry=https://registry.npmjs.org --skip-existing
 *   bun run scripts/publish-packages.ts --expect-version=0.1.0 --skip-existing --provenance
 */
import {
  ensureDir,
  join,
  readDirSyncNames,
  resolve,
  statSyncPath,
} from "../packages/core/src/common/index";
import { withPublishableManifest } from "./publish-manifest";

interface PkgMeta {
  name: string;
  version: string;
  dir: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  publishConfig?: { access?: string; registry?: string };
}

const ROOT = resolve(import.meta.dir, "..");
const PACKAGES_DIR = join(ROOT, "packages");
const DEFAULT_REGISTRY = "https://registry.npmjs.org";

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

function topologicalOrder(pkgs: PkgMeta[]): PkgMeta[] {
  const byName = new Map(pkgs.map((p) => [p.name, p]));
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const p of pkgs) {
    inDegree.set(p.name, 0);
    dependents.set(p.name, []);
  }

  for (const p of pkgs) {
    const internalDeps = Object.keys(p.dependencies ?? {}).filter((d) =>
      byName.has(d),
    );
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

async function isAlreadyPublished(
  registry: string,
  name: string,
  version: string,
): Promise<boolean> {
  const encoded = encodeURIComponent(name).replace("%40", "@");
  const url = `${registry}/${encoded}/${encodeURIComponent(version)}`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function runPublish(cmd: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(cmd, {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
    env: Bun.env,
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`Publish command failed (${code}): ${cmd.join(" ")} (cwd: ${cwd})`);
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

  const dryRun = args.has("dry-run");
  const skipExisting = args.has("skip-existing");
  const provenance = args.has("provenance");
  const packOutDir =
    typeof args.get("pack") === "string"
      ? resolve(args.get("pack") as string)
      : undefined;
  const registry = (
    typeof args.get("registry") === "string"
      ? (args.get("registry") as string)
      : DEFAULT_REGISTRY
  ).replace(/\/$/, "");
  const expectVersion =
    typeof args.get("expect-version") === "string"
      ? (args.get("expect-version") as string).replace(/^v/, "")
      : undefined;

  const pkgs = await loadPublishablePackages();
  const ordered = topologicalOrder(pkgs);

  const versions = new Set(ordered.map((p) => p.version));
  if (versions.size !== 1) {
    throw new Error(
      `Version mismatch across workspace packages: ${[...versions].join(", ")}`,
    );
  }
  const version = ordered[0]!.version;

  if (expectVersion && expectVersion !== version) {
    throw new Error(
      `Expected package version ${expectVersion}, but workspace packages are at ${version}.`,
    );
  }

  if (packOutDir) {
    await ensureDir(packOutDir);
    console.log(
      `[pack] Packing ${ordered.length} @bunest/* packages @ ${version} into ${packOutDir}`,
    );
    for (const [idx, pkg] of ordered.entries()) {
      const prefix = `[${String(idx + 1).padStart(2, " ")}/${ordered.length}] ${pkg.name}@${pkg.version}`;
      if (pkg.publishConfig?.access !== "public") {
        throw new Error(`${pkg.name}: missing publishConfig.access = "public"`);
      }
      const cmd = ["bun", "pm", "pack", "--destination", packOutDir, "--quiet"];
      console.log(`${prefix} — running: ${cmd.join(" ")}`);
      await withPublishableManifest(pkg.dir, () => runPublish(cmd, pkg.dir));
    }
    console.log(
      `[pack] Complete: packed ${ordered.length} tarballs to ${packOutDir}.`,
    );
    return;
  }

  const distTag =
    typeof args.get("tag") === "string"
      ? (args.get("tag") as string)
      : version.includes("-")
        ? "next"
        : "latest";

  console.log(
    `[publish] ${dryRun ? "DRY-RUN " : ""}Publishing ${ordered.length} @bunest/* packages @ ${version} (tag: ${distTag}, registry: ${registry})`,
  );

  let published = 0;
  let skipped = 0;

  for (const [idx, pkg] of ordered.entries()) {
    const prefix = `[${String(idx + 1).padStart(2, " ")}/${ordered.length}] ${pkg.name}@${pkg.version}`;

    if (pkg.publishConfig?.access !== "public") {
      throw new Error(`${pkg.name}: missing publishConfig.access = "public"`);
    }

    if (skipExisting && !dryRun) {
      if (await isAlreadyPublished(registry, pkg.name, pkg.version)) {
        console.log(`${prefix} — already published, skipping.`);
        skipped++;
        continue;
      }
    }

    const cmd = [
      "bun",
      "publish",
      "--access",
      "public",
      "--tag",
      distTag,
      "--registry",
      registry,
    ];
    if (dryRun) cmd.push("--dry-run");
    if (provenance && !dryRun) cmd.push("--provenance");

    console.log(`${prefix} — running: ${cmd.join(" ")}`);
    await withPublishableManifest(pkg.dir, () => runPublish(cmd, pkg.dir));
    published++;
  }

  console.log(
    `[publish] Complete: ${published} ${dryRun ? "dry-run checked" : "published"}, ${skipped} skipped.`,
  );
}

await main();
