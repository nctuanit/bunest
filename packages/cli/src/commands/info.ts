import {
  existsSyncPath,
  getArch,
  getCpuCount,
  getPlatform,
  readTextSync,
} from "@bunest/core";
import type { EnvironmentInfo } from "../types";
import { CLI_VERSION } from "../version";

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

/**
 * Collects Bunest, Bun runtime, OS, CPU, and memory environment metadata.
 */
export function getEnvironmentInfo(): EnvironmentInfo {
  const platform = getPlatform();
  const sys = detectSystemDetails(platform);
  return {
    bunestVersion: CLI_VERSION,
    bunVersion: Bun.version,
    bunRevision: Bun.revision,
    platform: platform as NodeJS.Platform,
    osRelease: sys.osRelease,
    arch: getArch(),
    cpuModel: sys.cpuModel,
    cpuCores: getCpuCount(),
    totalMemoryBytes: sys.totalMemoryBytes,
    freeMemoryBytes: sys.freeMemoryBytes,
  };
}

/**
 * Formats environment metadata into a concise diagnostic table for `bunest info`.
 */
export function formatEnvironmentInfo(info: EnvironmentInfo): string {
  const lines = [
    "Bunest Environment Info",
    "=======================",
    `  Bunest CLI : v${info.bunestVersion}`,
    `  Bun        : v${info.bunVersion} (${info.bunRevision.slice(0, 8)})`,
    `  OS         : ${info.platform} ${info.osRelease} (${info.arch})`,
    `  CPU        : ${info.cpuModel} (${info.cpuCores} cores)`,
    `  Memory     : ${formatGiB(info.freeMemoryBytes)} free / ${formatGiB(info.totalMemoryBytes)} total`,
  ];
  return lines.join("\n");
}
