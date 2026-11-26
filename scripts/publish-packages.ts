/**
 * Deterministic topological npm publisher, tarball packer & registry status auditor
 * for all publishable @bunest/* packages.
 *
 * Usage:
 *   bun run scripts/publish-packages.ts --dry-run
 *   bun run scripts/publish-packages.ts --pack=./dist-tarballs
 *   bun run scripts/publish-packages.ts --registry=https://registry.npmjs.org --skip-existing
 *   bun run scripts/publish-packages.ts --expect-version=0.1.0 --skip-existing --provenance
 *   bun run scripts/publish-packages.ts --status --registry=https://registry.npmjs.org [--version=0.1.0] [--json]
 */
import {
  ensureDir,
  join,
  readDirSyncNames,
  resolve,
  statSyncPath,
} from "../packages/core/src/common/index";
import { withPublishableManifest } from "./publish-manifest";

export interface PkgMeta {
  name: string;
  version: string;
  dir: string;
  private?: boolean;
  dependencies?: Record<string, string>;
  publishConfig?: { access?: string; registry?: string };
}

export interface IsAlreadyPublishedOptions {
  token?: string;
  fetchImpl?: typeof fetch;
}

export interface RegistryPackageStatus {
  name: string;
  version: string;
  published: boolean;
}

export interface RegistryStatusReport {
  registry: string;
  version: string;
  total: number;
  published: string[];
  missing: string[];
  packages: RegistryPackageStatus[];
}

export interface CheckRegistryStatusOptions extends IsAlreadyPublishedOptions {
  versionOverride?: string;
}

export interface PublishProgress {
  registry: string;
  version: string;
  distTag: string;
  provenance: boolean;
  published: string[];
  skipped: string[];
  failed?: {
    name: string;
    version: string;
    error: string;
  };
  remaining: string[];
}

export interface RunPublishOptions {
  packages: PkgMeta[];
  registry: string;
  version: string;
  distTag: string;
  dryRun?: boolean;
  skipExisting?: boolean;
  provenance?: boolean;
  token?: string;
  fetchImpl?: typeof fetch;
  execCommand?: (cmd: string[], cwd: string) => Promise<void>;
  wrapManifest?: <R>(pkgDir: string, fn: () => Promise<R>) => Promise<R>;
  log?: (message: string) => void;
  logError?: (message: string) => void;
}

const ROOT = resolve(import.meta.dir, "..");
const PACKAGES_DIR = join(ROOT, "packages");
export const DEFAULT_REGISTRY = "https://registry.npmjs.org";

export function normalizeRegistry(registry: string): string {
  return registry.replace(/\/+$/, "");
}

export function normalizeVersion(version: string): string {
  return version.replace(/^v/, "");
}

export function resolveAuthToken(
  env: Record<string, string | undefined> = Bun.env,
): string | undefined {
  const token = env.NPM_TOKEN ?? env.NODE_AUTH_TOKEN;
  if (!token) return undefined;
  const trimmed = token.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export async function loadPublishablePackages(
  packagesDir: string = PACKAGES_DIR,
): Promise<PkgMeta[]> {
  const dirs = readDirSyncNames(packagesDir)
    .map((name) => join(packagesDir, name))
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

export function topologicalOrder(pkgs: PkgMeta[]): PkgMeta[] {
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

export async function isAlreadyPublished(
  registry: string,
  name: string,
  version: string,
  options: IsAlreadyPublishedOptions = {},
): Promise<boolean> {
  const normalizedRegistry = normalizeRegistry(registry);
  const encoded = encodeURIComponent(name).replace("%40", "@");
  const url = `${normalizedRegistry}/${encoded}/${encodeURIComponent(version)}`;
  const token = options.token ?? resolveAuthToken();
  const fetchFn = options.fetchImpl ?? fetch;

  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "GET",
      headers,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Network error checking ${name}@${version} on ${normalizedRegistry} (${url}): ${detail}`,
    );
  }

  if (res.status === 200) {
    return true;
  }
  if (res.status === 404) {
    return false;
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `Registry auth error (HTTP ${res.status}) checking ${name}@${version} at ${url}. Verify NPM_TOKEN / NODE_AUTH_TOKEN has read access to ${normalizedRegistry}.`,
    );
  }

  throw new Error(
    `Registry error (HTTP ${res.status}) checking ${name}@${version} at ${url}. Retry once the registry is healthy.`,
  );
}

export async function checkRegistryStatus(
  packages: ReadonlyArray<Pick<PkgMeta, "name" | "version">>,
  registry: string,
  options: CheckRegistryStatusOptions = {},
): Promise<RegistryStatusReport> {
  const normalizedRegistry = normalizeRegistry(registry);
  const versionOverride = options.versionOverride
    ? normalizeVersion(options.versionOverride)
    : undefined;

  const statuses: RegistryPackageStatus[] = [];
  const published: string[] = [];
  const missing: string[] = [];

  for (const pkg of packages) {
    const targetVersion = versionOverride ?? pkg.version;
    const isPublished = await isAlreadyPublished(
      normalizedRegistry,
      pkg.name,
      targetVersion,
      {
        token: options.token,
        fetchImpl: options.fetchImpl,
      },
    );
    statuses.push({
      name: pkg.name,
      version: targetVersion,
      published: isPublished,
    });
    if (isPublished) {
      published.push(pkg.name);
    } else {
      missing.push(pkg.name);
    }
  }

  return {
    registry: normalizedRegistry,
    version: versionOverride ?? packages[0]?.version ?? "",
    total: packages.length,
    published,
    missing,
    packages: statuses,
  };
}

export function buildResumeCommand(
  progress: Pick<
    PublishProgress,
    "registry" | "version" | "distTag" | "provenance"
  >,
): string {
  const parts = [
    "bun run scripts/publish-packages.ts",
    `--registry=${normalizeRegistry(progress.registry)}`,
    `--expect-version=${normalizeVersion(progress.version)}`,
    `--tag=${progress.distTag}`,
    "--skip-existing",
  ];
  if (progress.provenance) {
    parts.push("--provenance");
  }
  return parts.join(" ");
}

export function formatPartialPublishSummary(progress: PublishProgress): string {
  const lines: string[] = [
    `[publish] Partial publish checkpoint (${progress.version} @ ${normalizeRegistry(progress.registry)})`,
    `  Published (${progress.published.length}): ${progress.published.length > 0 ? progress.published.join(", ") : "none"}`,
    `  Skipped   (${progress.skipped.length}): ${progress.skipped.length > 0 ? progress.skipped.join(", ") : "none"}`,
  ];

  if (progress.failed) {
    lines.push(
      `  Failed    (1): ${progress.failed.name}@${progress.failed.version} — ${progress.failed.error}`,
    );
  }

  lines.push(
    `  Remaining (${progress.remaining.length}): ${progress.remaining.length > 0 ? progress.remaining.join(", ") : "none"}`,
    "",
    "Resume safely with:",
    `  ${buildResumeCommand(progress)}`,
    "Inspect live registry state with:",
    `  bun run scripts/publish-packages.ts --status --registry=${normalizeRegistry(progress.registry)} --version=${normalizeVersion(progress.version)}`,
  );

  return lines.join("\n");
}

export function formatStatusReport(report: RegistryStatusReport): string {
  const lines: string[] = [
    `[status] Auditing ${report.total} @bunest/* packages @ ${report.version} on ${report.registry}`,
  ];

  for (const [idx, pkg] of report.packages.entries()) {
    const label = `[${String(idx + 1).padStart(2, " ")}/${report.total}]`;
    const badge = pkg.published ? "PUBLISHED" : "MISSING  ";
    lines.push(`${label} [${badge}] ${pkg.name}@${pkg.version}`);
  }

  lines.push(
    `[status] Summary: ${report.published.length}/${report.total} published, ${report.missing.length} missing.`,
  );

  if (report.missing.length > 0) {
    lines.push(`[status] Missing packages: ${report.missing.join(", ")}`);
  }

  return lines.join("\n");
}

async function execPublishCommand(cmd: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(cmd, {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
    env: Bun.env,
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(
      `Publish command failed (${code}): ${cmd.join(" ")} (cwd: ${cwd})`,
    );
  }
}

export async function runPublish(
  options: RunPublishOptions,
): Promise<PublishProgress> {
  const {
    packages: ordered,
    version,
    distTag,
    dryRun = false,
    skipExisting = false,
    provenance = false,
    token,
    fetchImpl,
    execCommand = execPublishCommand,
    wrapManifest = withPublishableManifest,
    log = console.log,
    logError = console.error,
  } = options;
  const registry = normalizeRegistry(options.registry);

  log(
    `[publish] ${dryRun ? "DRY-RUN " : ""}Publishing ${ordered.length} @bunest/* packages @ ${version} (tag: ${distTag}, registry: ${registry})`,
  );

  const published: string[] = [];
  const skipped: string[] = [];

  for (const [idx, pkg] of ordered.entries()) {
    const prefix = `[${String(idx + 1).padStart(2, " ")}/${ordered.length}] ${pkg.name}@${pkg.version}`;

    try {
      if (pkg.publishConfig?.access !== "public") {
        throw new Error(
          `${pkg.name}: missing publishConfig.access = "public"`,
        );
      }

      if (skipExisting && !dryRun) {
        if (
          await isAlreadyPublished(registry, pkg.name, pkg.version, {
            token,
            fetchImpl,
          })
        ) {
          log(`${prefix} — already published, skipping.`);
          skipped.push(pkg.name);
          continue;
        }
      }

      // Bun's `bun publish --dry-run` still requires npm authentication, which
      // fails in unauthenticated CI PRs. Validate packaging via `bun pm pack --dry-run`
      // inside `wrapManifest` so the exact publishable manifest, exports, `.d.ts`
      // targets, `files` whitelist, and workspace:* rewrites are checked offline.
      const cmd = dryRun
        ? ["bun", "pm", "pack", "--dry-run"]
        : [
            "bun",
            "publish",
            "--access",
            "public",
            "--tag",
            distTag,
            "--registry",
            registry,
            ...(provenance ? ["--provenance"] : []),
          ];

      log(`${prefix} — running: ${cmd.join(" ")}`);
      await wrapManifest(pkg.dir, () => execCommand(cmd, pkg.dir));
      published.push(pkg.name);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const remaining = ordered.slice(idx + 1).map((p) => p.name);
      const progress: PublishProgress = {
        registry,
        version,
        distTag,
        provenance,
        published,
        skipped,
        failed: {
          name: pkg.name,
          version: pkg.version,
          error: errorMessage,
        },
        remaining,
      };
      logError(formatPartialPublishSummary(progress));
      throw err;
    }
  }

  log(
    `[publish] Complete: ${published.length} ${dryRun ? "dry-run checked" : "published"}, ${skipped.length} skipped.`,
  );

  if (!dryRun) {
    log(
      `[publish] Verifying all ${ordered.length} packages @ ${version} are visible on ${registry}...`,
    );
    const statusReport = await checkRegistryStatus(ordered, registry, {
      versionOverride: version,
      token,
      fetchImpl,
    });
    if (statusReport.missing.length > 0) {
      throw new Error(
        `Post-publish verification failed: ${statusReport.missing.length}/${statusReport.total} package(s) not visible on ${registry} @ ${version}: ${statusReport.missing.join(", ")}. Re-run with: ${buildResumeCommand({ registry, version, distTag, provenance })}`,
      );
    }
    log(
      `[publish] Verified: all ${statusReport.total}/${statusReport.total} packages @ ${version} are live on ${registry}.`,
    );
  }

  return {
    registry,
    version,
    distTag,
    provenance,
    published,
    skipped,
    remaining: [],
  };
}

export async function main(argv: string[] = Bun.argv.slice(2)): Promise<void> {
  const args = new Map<string, string | true>();
  for (const arg of argv) {
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx === -1) {
        args.set(arg.slice(2), true);
      } else {
        args.set(arg.slice(2, eqIdx), arg.slice(eqIdx + 1));
      }
    }
  }

  const statusMode = args.has("status");
  const jsonOutput = args.has("json");
  const dryRun = args.has("dry-run");
  const skipExisting = args.has("skip-existing");
  const provenance = args.has("provenance");
  const packOutDir =
    typeof args.get("pack") === "string"
      ? resolve(args.get("pack") as string)
      : undefined;
  const registry = normalizeRegistry(
    typeof args.get("registry") === "string"
      ? (args.get("registry") as string)
      : DEFAULT_REGISTRY,
  );
  const expectVersion =
    typeof args.get("expect-version") === "string"
      ? normalizeVersion(args.get("expect-version") as string)
      : undefined;
  const versionOverride =
    typeof args.get("version") === "string"
      ? normalizeVersion(args.get("version") as string)
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

  if (statusMode) {
    const report = await checkRegistryStatus(ordered, registry, {
      versionOverride: versionOverride ?? version,
    });
    if (jsonOutput) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatStatusReport(report));
    }
    if (report.missing.length > 0) {
      process.exit(1);
    }
    return;
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
      await withPublishableManifest(pkg.dir, () =>
        execPublishCommand(cmd, pkg.dir),
      );
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

  await runPublish({
    packages: ordered,
    registry,
    version,
    distTag,
    dryRun,
    skipExisting,
    provenance,
  });
}

if (import.meta.main) {
  await main();
}
