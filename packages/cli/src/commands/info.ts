import {
  dirname,
  existsSyncPath,
  getArch,
  getCpuCount,
  getPlatform,
  join,
  readTextSync,
  realpathSyncOf,
  resolve,
  semverSatisfies,
} from "@bunest/core";
import type { EnvironmentInfo } from "../types";
import { CLI_VERSION } from "../version";

export type ResolvedPackageStatus = "installed" | "workspace" | "missing";

export interface ResolvedPackageInfo {
  readonly name: string;
  readonly declared: string;
  readonly resolved: string | null;
  readonly status: ResolvedPackageStatus;
  readonly resolvedPath?: string;
}

export type EnvironmentInfoFormat = "pretty" | "json" | "table";

export interface FormatEnvironmentInfoOptions {
  readonly format?: EnvironmentInfoFormat;
}

export interface ExtendedEnvironmentInfo extends EnvironmentInfo {
  readonly resolvedPackages?: readonly ResolvedPackageInfo[];
  readonly requiredBunRange?: string;
  readonly bunVersionSatisfied?: boolean;
}

function formatGiB(bytes: number): string {
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

function runSyncTrimmed(cmd: string[]): string | undefined {
  if (typeof Bun === "undefined" || typeof Bun.spawnSync !== "function") {
    return undefined;
  }
  try {
    const res = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "ignore" });
    if (res.exitCode === 0) {
      const text = res.stdout.toString("utf8").trim();
      if (text.length > 0) return text;
    }
  } catch {
    // Ignore when system utility is unavailable
  }
  return undefined;
}

function detectSystemDetails(platform: string): {
  readonly osRelease: string;
  readonly cpuModel: string;
  readonly totalMemoryBytes: number;
  readonly freeMemoryBytes: number;
} {
  let osRelease = "";
  let cpuModel = "unknown";
  let totalMemoryBytes = 0;
  let freeMemoryBytes = 0;

  if (platform === "darwin") {
    osRelease = runSyncTrimmed(["uname", "-r"]) ?? "";
    cpuModel =
      runSyncTrimmed(["sysctl", "-n", "machdep.cpu.brand_string"]) ?? "unknown";
    const totalStr = runSyncTrimmed(["sysctl", "-n", "hw.memsize"]);
    if (totalStr) {
      const parsed = Number(totalStr);
      if (Number.isFinite(parsed) && parsed > 0) totalMemoryBytes = parsed;
    }
    const vmStat = runSyncTrimmed(["vm_stat"]);
    if (vmStat) {
      const pageSizeMatch = /page size of (\d+) bytes/i.exec(vmStat);
      const pageSize = pageSizeMatch ? Number(pageSizeMatch[1]) : 4096;
      const freeMatch = /Pages free:\s+(\d+)/i.exec(vmStat);
      const inactiveMatch = /Pages inactive:\s+(\d+)/i.exec(vmStat);
      const freePages =
        (freeMatch ? Number(freeMatch[1]) : 0) +
        (inactiveMatch ? Number(inactiveMatch[1]) : 0);
      if (freePages > 0) {
        freeMemoryBytes = freePages * pageSize;
      }
    }
  } else if (platform === "linux") {
    osRelease = runSyncTrimmed(["uname", "-r"]) ?? "";
    if (existsSyncPath("/proc/cpuinfo")) {
      try {
        const cpuinfo = readTextSync("/proc/cpuinfo");
        const m = /^model name\s*:\s*(.+)$/m.exec(cpuinfo);
        if (m?.[1]) cpuModel = m[1].trim();
      } catch {
        // ignore
      }
    }
    if (existsSyncPath("/proc/meminfo")) {
      try {
        const meminfo = readTextSync("/proc/meminfo");
        const totalMatch = /^MemTotal:\s+(\d+)\s+kB/m.exec(meminfo);
        const availMatch =
          /^MemAvailable:\s+(\d+)\s+kB/m.exec(meminfo) ??
          /^MemFree:\s+(\d+)\s+kB/m.exec(meminfo);
        if (totalMatch?.[1]) totalMemoryBytes = Number(totalMatch[1]) * 1024;
        if (availMatch?.[1]) freeMemoryBytes = Number(availMatch[1]) * 1024;
      } catch {
        // ignore
      }
    }
  }

  if (totalMemoryBytes <= 0) {
    const rss =
      typeof process !== "undefined" && typeof process.memoryUsage === "function"
        ? process.memoryUsage().rss
        : 0;
    totalMemoryBytes = Math.max(rss, 64 * 1024 * 1024);
  }
  if (freeMemoryBytes <= 0) {
    const rss =
      typeof process !== "undefined" && typeof process.memoryUsage === "function"
        ? process.memoryUsage().rss
        : 0;
    freeMemoryBytes = Math.max(0, totalMemoryBytes - rss);
  }

  return { osRelease, cpuModel, totalMemoryBytes, freeMemoryBytes };
}

function readInstalledBunestPackages(
  cwd?: string,
): Record<string, string> | undefined {
  if (!cwd) return undefined;
  const pkgPath = join(cwd, "package.json");
  if (!existsSyncPath(pkgPath)) return undefined;
  try {
    const pkg = JSON.parse(readTextSync(pkgPath)) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const merged: Record<string, string> = {
      ...(pkg.devDependencies ?? {}),
      ...(pkg.dependencies ?? {}),
    };
    const found: Record<string, string> = {};
    for (const [name, version] of Object.entries(merged)) {
      if (name.startsWith("@bunest/") || name.startsWith("@nestjs/")) {
        found[name] = version;
      }
    }
    return Object.keys(found).length > 0 ? found : undefined;
  } catch {
    return undefined;
  }
}

function readPackageJsonSafe(
  pkgJsonPath: string,
): { readonly name?: string; readonly version?: string } | null {
  try {
    const parsed = JSON.parse(readTextSync(pkgJsonPath)) as {
      name?: unknown;
      version?: unknown;
    };
    if (!parsed || typeof parsed !== "object") return null;
    return {
      name: typeof parsed.name === "string" ? parsed.name : undefined,
      version: typeof parsed.version === "string" ? parsed.version : undefined,
    };
  } catch {
    return null;
  }
}

function findNearestPackageJson(
  startDir: string,
  expectedName: string,
): { readonly pkgPath: string; readonly version: string } | null {
  let current = resolve(startDir);
  while (true) {
    const candidate = join(current, "package.json");
    if (existsSyncPath(candidate)) {
      const parsed = readPackageJsonSafe(candidate);
      if (parsed?.name === expectedName && parsed.version !== undefined) {
        return { pkgPath: candidate, version: parsed.version };
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function resolveViaBun(
  pkgName: string,
  cwd: string,
): { readonly pkgPath: string; readonly version: string } | null {
  if (typeof Bun === "undefined" || typeof Bun.resolveSync !== "function") {
    return null;
  }

  // First try resolving <pkg>/package.json directly (works when exports allows it or no exports map)
  try {
    const pkgPath = Bun.resolveSync(`${pkgName}/package.json`, cwd);
    if (existsSyncPath(pkgPath)) {
      const parsed = readPackageJsonSafe(pkgPath);
      if (
        parsed &&
        parsed.version !== undefined &&
        (!parsed.name || parsed.name === pkgName)
      ) {
        return { pkgPath, version: parsed.version };
      }
    }
  } catch {
    // Package may define an `exports` map that does not expose `./package.json`
  }

  // Fallback: resolve the package's entry point via Bun's exports/main resolver, then walk up to its package.json
  try {
    const entryPath = Bun.resolveSync(pkgName, cwd);
    const nearest = findNearestPackageJson(dirname(entryPath), pkgName);
    if (nearest) return nearest;
  } catch {
    // Package entry not resolvable via Bun.resolveSync (e.g. subpath-only exports or missing)
  }

  return null;
}

function resolveViaAncestorNodeModules(
  pkgName: string,
  cwd: string,
): { readonly pkgPath: string; readonly version: string } | null {
  const pkgSegments = pkgName.split("/");
  let current = resolve(cwd);
  while (true) {
    const candidate = join(current, "node_modules", ...pkgSegments, "package.json");
    if (existsSyncPath(candidate)) {
      const parsed = readPackageJsonSafe(candidate);
      if (
        parsed &&
        parsed.version !== undefined &&
        (!parsed.name || parsed.name === pkgName)
      ) {
        return { pkgPath: candidate, version: parsed.version };
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function isInsideNodeModules(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  return /(?:^|\/)node_modules(?:\/|$)/.test(normalized);
}

function resolveSinglePackage(
  name: string,
  declared: string,
  cwd: string,
): ResolvedPackageInfo {
  const found =
    resolveViaBun(name, cwd) ?? resolveViaAncestorNodeModules(name, cwd);
  if (!found) {
    return {
      name,
      declared,
      resolved: null,
      status: "missing",
    };
  }

  let realPath = resolve(found.pkgPath);
  try {
    realPath = realpathSyncOf(found.pkgPath);
  } catch {
    // Keep resolved path when realpath is unavailable
  }

  const isWorkspaceSpec =
    declared.startsWith("workspace:") || declared.startsWith("link:");
  const status: ResolvedPackageStatus =
    isWorkspaceSpec || !isInsideNodeModules(realPath) ? "workspace" : "installed";

  return {
    name,
    declared,
    resolved: found.version,
    status,
    resolvedPath: realPath,
  };
}

/**
 * Resolves declared `@bunest/*` (and `@nestjs/*`) packages from `cwd` offline
 * without making any network or registry calls.
 */
export function resolveDeclaredBunestPackages(
  cwd?: string,
  declaredPackages?: Readonly<Record<string, string>>,
): ResolvedPackageInfo[] {
  if (!cwd) return [];
  const declared = declaredPackages ?? readInstalledBunestPackages(cwd);
  if (!declared) return [];

  return Object.entries(declared)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, range]) => resolveSinglePackage(name, range, cwd));
}

function readProjectBunEngineRange(cwd?: string): string | undefined {
  if (!cwd) return undefined;
  const pkgPath = join(cwd, "package.json");
  if (!existsSyncPath(pkgPath)) return undefined;
  try {
    const pkg = JSON.parse(readTextSync(pkgPath)) as {
      engines?: { bun?: string };
    };
    return typeof pkg.engines?.bun === "string" ? pkg.engines.bun : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Collects Bunest, Bun runtime, OS, CPU, and memory environment metadata.
 */
export function getEnvironmentInfo(cwd?: string): ExtendedEnvironmentInfo {
  const platform = getPlatform();
  const sys = detectSystemDetails(platform);
  const packages = readInstalledBunestPackages(cwd);
  const resolvedPackages = packages
    ? resolveDeclaredBunestPackages(cwd, packages)
    : [];
  const hasBun = typeof Bun !== "undefined";
  const bunVersion = hasBun
    ? Bun.version
    : (process.versions?.bun ?? "unknown");
  const bunRevision = hasBun ? Bun.revision : "";
  const requiredBunRange = readProjectBunEngineRange(cwd);
  const bunVersionSatisfied =
    requiredBunRange !== undefined && hasBun
      ? semverSatisfies(bunVersion, requiredBunRange)
      : undefined;
  return {
    bunestVersion: CLI_VERSION,
    bunVersion,
    bunRevision,
    platform: platform as NodeJS.Platform,
    osRelease: sys.osRelease,
    arch: getArch(),
    cpuModel: sys.cpuModel,
    cpuCores: getCpuCount(),
    totalMemoryBytes: sys.totalMemoryBytes,
    freeMemoryBytes: sys.freeMemoryBytes,
    ...(packages ? { packages } : {}),
    ...(resolvedPackages.length > 0 ? { resolvedPackages } : {}),
    ...(requiredBunRange !== undefined
      ? {
          requiredBunRange,
          ...(bunVersionSatisfied !== undefined ? { bunVersionSatisfied } : {}),
        }
      : {}),
  };
}

function formatPackageVersionLine(
  shortName: string,
  declared: string,
  resolvedInfo?: ResolvedPackageInfo,
): string {
  if (!resolvedInfo) {
    return `  ${shortName} version : ${declared}`;
  }
  if (resolvedInfo.status === "missing" || resolvedInfo.resolved === null) {
    return `  ${shortName} version : missing (declared: ${resolvedInfo.declared}, missing)`;
  }
  return `  ${shortName} version : ${resolvedInfo.resolved} (declared: ${resolvedInfo.declared}, ${resolvedInfo.status})`;
}

/**
 * Formats environment metadata into a concise diagnostic table (or JSON) for `bunest info`.
 */
export function formatEnvironmentInfo(
  info: ExtendedEnvironmentInfo,
  options?: FormatEnvironmentInfoOptions,
): string {
  if (options?.format === "json") {
    return JSON.stringify(info, null, 2);
  }
  if (options?.format === "table") {
    const inspectTable =
      typeof Bun !== "undefined"
        ? (
            Bun.inspect as unknown as {
              table?: (rows: readonly Record<string, unknown>[]) => string;
            }
          ).table
        : undefined;
    const rows: Record<string, unknown>[] = [
      { Field: "Bunest CLI", Value: `v${info.bunestVersion}` },
      {
        Field: "Bun",
        Value: `v${info.bunVersion} (${info.bunRevision.slice(0, 8)})`,
      },
      {
        Field: "OS",
        Value: `${info.platform} ${info.osRelease} (${info.arch})`,
      },
      { Field: "CPU", Value: `${info.cpuModel} (${info.cpuCores} cores)` },
      {
        Field: "Memory",
        Value: `${formatGiB(info.freeMemoryBytes)} free / ${formatGiB(info.totalMemoryBytes)} total`,
      },
    ];
    if (info.requiredBunRange !== undefined) {
      rows.push({
        Field: "engines.bun",
        Value: `${info.requiredBunRange} (${info.bunVersionSatisfied ? "compatible" : "mismatch"})`,
      });
    }
    const envTable =
      typeof inspectTable === "function"
        ? inspectTable(rows)
        : rows.map((r) => `${r.Field}: ${r.Value}`).join("\n");
    if (info.resolvedPackages && info.resolvedPackages.length > 0) {
      const pkgRows = info.resolvedPackages.map((p) => ({
        Package: p.name,
        Declared: p.declared,
        Resolved: p.resolved ?? "missing",
        Status: p.status,
      }));
      const pkgTable =
        typeof inspectTable === "function"
          ? inspectTable(pkgRows)
          : pkgRows.map((r) => `${r.Package}: ${r.Resolved}`).join("\n");
      return `${envTable}\n${pkgTable}`;
    }
    return envTable;
  }

  const lines = [
    "Bunest Environment Info",
    "=======================",
    `  Bunest CLI : v${info.bunestVersion}`,
    `  Bun        : v${info.bunVersion} (${info.bunRevision.slice(0, 8)})`,
    `  OS         : ${info.platform} ${info.osRelease} (${info.arch})`,
    `  CPU        : ${info.cpuModel} (${info.cpuCores} cores)`,
    `  Memory     : ${formatGiB(info.freeMemoryBytes)} free / ${formatGiB(info.totalMemoryBytes)} total`,
  ];
  if (info.requiredBunRange && info.bunVersionSatisfied === false) {
    lines.push(
      `  Warning    : Bun v${info.bunVersion} does not satisfy engines.bun (${info.requiredBunRange})`,
    );
  }

  const resolvedMap = new Map<string, ResolvedPackageInfo>();
  if (info.resolvedPackages) {
    for (const pkg of info.resolvedPackages) {
      resolvedMap.set(pkg.name, pkg);
    }
  }

  let packageEntries: Array<[string, string]> = [];
  if (info.packages && Object.keys(info.packages).length > 0) {
    packageEntries = Object.entries(info.packages).sort(([a], [b]) =>
      a.localeCompare(b),
    );
  } else if (info.resolvedPackages && info.resolvedPackages.length > 0) {
    packageEntries = [...info.resolvedPackages]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((pkg) => [pkg.name, pkg.declared] as [string, string]);
  }

  if (packageEntries.length > 0) {
    lines.push("");
    lines.push("Bunest Packages");
    lines.push("===============");
    const names = new Set(packageEntries.map(([name]) => name));
    const hasCore = names.has("@bunest/core");
    const hasCommon =
      names.has("@bunest/common") || names.has("@nestjs/common");
    if (hasCore && !hasCommon) {
      const coreResolved = resolvedMap.get("@bunest/core");
      if (coreResolved) {
        const displayVersion =
          coreResolved.status === "missing" || coreResolved.resolved === null
            ? "missing"
            : coreResolved.resolved;
        lines.push(
          `  common version : ${displayVersion} (via @bunest/core, declared: ${coreResolved.declared}, ${coreResolved.status})`,
        );
      } else {
        const coreDeclared = info.packages?.["@bunest/core"] ?? "";
        lines.push(`  common version : ${coreDeclared} (via @bunest/core)`);
      }
    }
    for (const [name, version] of packageEntries) {
      const shortName = name.replace(/^@(?:bunest|nestjs)\//, "");
      lines.push(
        formatPackageVersionLine(shortName, version, resolvedMap.get(name)),
      );
    }
  }
  return lines.join("\n");
}
