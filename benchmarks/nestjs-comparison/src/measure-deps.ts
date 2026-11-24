import {
  dirname,
  existsSyncPath,
  join,
  readDirSyncEntries,
  readTextSync,
  realpathSyncOf,
  statSyncPath,
} from "../../../packages/core/src/index.ts";

interface PkgJson {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

export interface StackFootprint {
  readonly label: string;
  readonly seedPackages: readonly string[];
  readonly totalPackages: number;
  readonly externalNpmPackages: number;
  readonly totalBytes: number;
  readonly totalMb: number;
  readonly packageNames: readonly string[];
}

function getDirBytes(
  dir: string,
  excludeNames: ReadonlySet<string> = new Set(["node_modules"]),
): number {
  if (!existsSyncPath(dir)) return 0;
  let total = 0;
  for (const entry of readDirSyncEntries(dir)) {
    if (excludeNames.has(entry.name)) {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += getDirBytes(full, excludeNames);
    } else if (entry.isFile()) {
      total += statSyncPath(full).size;
    }
  }
  return total;
}

const WORKSPACE_EXCLUDES = new Set([
  "node_modules",
  "test",
  "tests",
  "__tests__",
]);
const NPM_EXCLUDES = new Set(["node_modules"]);

function resolvePackageDir(
  pkgName: string,
  fromDir: string,
  rootNodeModulesDirs: readonly string[],
  workspaceMap: ReadonlyMap<string, string>,
): string | null {
  const ws = workspaceMap.get(pkgName);
  if (ws && existsSyncPath(join(ws, "package.json"))) {
    return ws;
  }

  // Walk up from `fromDir` checking nested node_modules first
  let cur = fromDir;
  for (let depth = 0; depth < 12; depth += 1) {
    const candidate = join(cur, "node_modules", pkgName);
    if (existsSyncPath(join(candidate, "package.json"))) {
      return candidate;
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }

  for (const nm of rootNodeModulesDirs) {
    const candidate = join(nm, pkgName);
    if (existsSyncPath(join(candidate, "package.json"))) {
      return candidate;
    }
  }

  return null;
}

function measureClosure(
  label: string,
  seedPackages: readonly string[],
  baseDir: string,
  rootNodeModulesDirs: readonly string[],
  workspaceMap: ReadonlyMap<string, string>,
): StackFootprint {
  const visitedDirs = new Map<string, { name: string; isWorkspace: boolean }>();
  const queue: Array<{ name: string; fromDir: string }> = seedPackages.map(
    (name) => ({ name, fromDir: baseDir }),
  );

  while (queue.length > 0) {
    const item = queue.shift()!;
    const pkgDir = resolvePackageDir(
      item.name,
      item.fromDir,
      rootNodeModulesDirs,
      workspaceMap,
    );
    if (!pkgDir) continue;
    const realDir = realpathSyncOf(pkgDir);
    if (visitedDirs.has(realDir)) continue;

    const pkg = JSON.parse(
      readTextSync(join(realDir, "package.json")),
    ) as PkgJson;
    const isWorkspace = workspaceMap.has(item.name);
    visitedDirs.set(realDir, { name: pkg.name ?? item.name, isWorkspace });

    const deps = Object.keys(pkg.dependencies ?? {});
    const requiredPeers = Object.keys(pkg.peerDependencies ?? {}).filter(
      (peer) => !pkg.peerDependenciesMeta?.[peer]?.optional,
    );

    for (const dep of [...deps, ...requiredPeers]) {
      queue.push({ name: dep, fromDir: realDir });
    }
  }

  let totalBytes = 0;
  let externalNpmPackages = 0;
  const packageNames: string[] = [];

  for (const [dir, meta] of visitedDirs.entries()) {
    packageNames.push(meta.name);
    if (!meta.isWorkspace) {
      externalNpmPackages += 1;
    }
    totalBytes += getDirBytes(
      dir,
      meta.isWorkspace ? WORKSPACE_EXCLUDES : NPM_EXCLUDES,
    );
  }

  packageNames.sort();

  return {
    label,
    seedPackages,
    totalPackages: visitedDirs.size,
    externalNpmPackages,
    totalBytes,
    totalMb: Math.round((totalBytes / (1024 * 1024)) * 100) / 100,
    packageNames,
  };
}

export function measureAllStackFootprints(
  benchDir: string,
  repoRoot: string,
): {
  readonly withValidation: readonly StackFootprint[];
  readonly coreOnly: readonly StackFootprint[];
} {
  const benchNodeModules = join(benchDir, "node_modules");
  const rootNodeModules = join(repoRoot, "node_modules");

  const bunestWorkspaces = new Map<string, string>([
    ["@bunest/core", join(repoRoot, "packages", "core")],
    ["@bunest/core", join(repoRoot, "packages", "common")],
    ["@bunest/core/http", join(repoRoot, "packages", "http")],
    ["@bunest/validation", join(repoRoot, "packages", "validation")],
  ]);

  const emptyWs = new Map<string, string>();

  const withValidation: StackFootprint[] = [
    measureClosure(
      "Bunest (@bunest/core + validation)",
      ["@bunest/core"],
      repoRoot,
      [rootNodeModules],
      bunestWorkspaces,
    ),
    measureClosure(
      "NestJS + Platform Node (+ validation)",
      [
        "@nestjs/core",
        "@nestjs/common",
        "@nestjs/platform-node",
        "rxjs",
        "reflect-metadata",
        "class-validator",
        "class-transformer",
      ],
      benchDir,
      [benchNodeModules],
      emptyWs,
    ),
    measureClosure(
      "NestJS + Fastify (+ validation)",
      [
        "@nestjs/core",
        "@nestjs/common",
        "@nestjs/platform-fastify",
        "fastify",
        "rxjs",
        "reflect-metadata",
        "class-validator",
        "class-transformer",
      ],
      benchDir,
      [benchNodeModules],
      emptyWs,
    ),
    measureClosure(
      "NestJS + Express (+ validation)",
      [
        "@nestjs/core",
        "@nestjs/common",
        "@nestjs/platform-express",
        "rxjs",
        "reflect-metadata",
        "class-validator",
        "class-transformer",
      ],
      benchDir,
      [benchNodeModules],
      emptyWs,
    ),
  ];

  // Pure core HTTP + DI without class-validator/class-transformer
  const bunestCoreOnlyWs = new Map<string, string>([
    ["@bunest/core", join(repoRoot, "packages", "common")],
    ["@bunest/core/http", join(repoRoot, "packages", "http")],
  ]);
  // Measure @bunest/core's core-only closure by excluding @bunest/validation's validation libs
  const bunestCoreClosure = measureClosure(
    "Bunest (core HTTP + DI, excl. validation libs)",
    ["@bunest/core", "@bunest/core/http", "reflect-metadata"],
    repoRoot,
    [rootNodeModules],
    bunestCoreOnlyWs,
  );
  // Add @bunest/core's own bytes/package
  const coreOwnBytes = getDirBytes(
    join(repoRoot, "packages", "core"),
    WORKSPACE_EXCLUDES,
  );
  const bunestCoreOnly: StackFootprint = {
    label: "Bunest (core HTTP + DI, excl. validation libs)",
    seedPackages: [
      "@bunest/core",
      "@bunest/core",
      "@bunest/core/http",
      "reflect-metadata",
    ],
    totalPackages: bunestCoreClosure.totalPackages + 1,
    externalNpmPackages: bunestCoreClosure.externalNpmPackages,
    totalBytes: bunestCoreClosure.totalBytes + coreOwnBytes,
    totalMb:
      Math.round(
        ((bunestCoreClosure.totalBytes + coreOwnBytes) / (1024 * 1024)) * 100,
      ) / 100,
    packageNames: ["@bunest/core", ...bunestCoreClosure.packageNames].sort(),
  };

  const coreOnly: StackFootprint[] = [
    bunestCoreOnly,
    measureClosure(
      "NestJS + Platform Node (excl. validation libs)",
      [
        "@nestjs/core",
        "@nestjs/common",
        "@nestjs/platform-node",
        "rxjs",
        "reflect-metadata",
      ],
      benchDir,
      [benchNodeModules],
      emptyWs,
    ),
    measureClosure(
      "NestJS + Fastify (excl. validation libs)",
      [
        "@nestjs/core",
        "@nestjs/common",
        "@nestjs/platform-fastify",
        "fastify",
        "rxjs",
        "reflect-metadata",
      ],
      benchDir,
      [benchNodeModules],
      emptyWs,
    ),
    measureClosure(
      "NestJS + Express (excl. validation libs)",
      [
        "@nestjs/core",
        "@nestjs/common",
        "@nestjs/platform-express",
        "rxjs",
        "reflect-metadata",
      ],
      benchDir,
      [benchNodeModules],
      emptyWs,
    ),
  ];

  return { withValidation, coreOnly };
}
