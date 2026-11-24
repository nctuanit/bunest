/**
 * Pure-Bun runtime host/platform/CPU inspection helpers (zero `node:os` dependency).
 */

let cachedHostname: string | undefined;

/**
 * Returns the host machine name, preferring `process.env.HOSTNAME` / `COMPUTERNAME`
 * and falling back to a cached `Bun.spawnSync(["hostname"])` call.
 */
export function getHostname(): string {
  if (cachedHostname !== undefined) {
    return cachedHostname;
  }
  const envHost =
    process.env.HOSTNAME?.trim() || process.env.COMPUTERNAME?.trim();
  if (envHost) {
    cachedHostname = envHost;
    return cachedHostname;
  }
  try {
    const result = Bun.spawnSync(["hostname"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (result.exitCode === 0) {
      const text = result.stdout.toString("utf8").trim();
      if (text.length > 0) {
        cachedHostname = text;
        return cachedHostname;
      }
    }
  } catch {
    // Fall through to safe default
  }
  cachedHostname = "localhost";
  return cachedHostname;
}

/**
 * Returns the logical CPU core count via Web-standard `navigator.hardwareConcurrency`.
 */
export function getCpuCount(): number {
  const count =
    typeof navigator !== "undefined" ? navigator.hardwareConcurrency : 0;
  return typeof count === "number" && Number.isFinite(count) && count > 0
    ? count
    : 1;
}

/**
 * Returns the operating system platform identifier (e.g. `"darwin"`, `"linux"`, `"win32"`).
 */
export function getPlatform(): string {
  return process.platform;
}

/**
 * Returns the CPU architecture identifier (e.g. `"arm64"`, `"x64"`).
 */
export function getArch(): string {
  return process.arch;
}
