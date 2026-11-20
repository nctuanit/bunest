import os from "node:os";
import type { EnvironmentInfo } from "../types";
import { CLI_VERSION } from "../version";

function formatGiB(bytes: number): string {
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

/**
 * Collects Bunest, Bun runtime, OS, CPU, and memory environment metadata.
 */
export function getEnvironmentInfo(): EnvironmentInfo {
  const cpus = os.cpus();
  return {
    bunestVersion: CLI_VERSION,
    bunVersion: Bun.version,
    bunRevision: Bun.revision,
    platform: os.platform(),
    osRelease: os.release(),
    arch: process.arch,
    cpuModel: cpus[0]?.model?.trim() || "unknown",
    cpuCores: cpus.length,
    totalMemoryBytes: os.totalmem(),
    freeMemoryBytes: os.freemem(),
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
