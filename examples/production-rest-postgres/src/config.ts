export interface AppConfig {
  readonly host: string;
  readonly port: number;
  readonly databaseUrl: string;
  readonly dbPoolMax: number;
  readonly dbConnectionTimeoutSec: number;
  readonly dbIdleTimeoutSec: number;
  readonly readyDbTimeoutMs: number;
  readonly bodyLimitBytes: number;
  readonly trustProxy: string[];
  readonly shutdownReadinessDelayMs: number;
  readonly shutdownDrainTimeoutMs: number;
  readonly metricsToken?: string;
  readonly appVersion: string;
}

const SECRET_URL_PATTERN =
  /\b(postgres(?:ql)?:\/\/[^:\s/]+:)([^@\s/]+)(@)/gi;
const BEARER_PATTERN = /\b(Bearer\s+)([A-Za-z0-9._~+/=-]{6,})/gi;

/**
 * Redacts credentials embedded in connection URLs or Bearer headers before logging.
 */
export function redactSecrets(input: string): string {
  return input
    .replace(SECRET_URL_PATTERN, "$1[REDACTED]$3")
    .replace(BEARER_PATTERN, "$1[REDACTED]");
}

export function logJson(
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown> = {},
): void {
  const sanitized: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    event,
  };
  for (const [k, v] of Object.entries(fields)) {
    if (/password|secret|token|authorization/i.test(k)) {
      sanitized[k] = "[REDACTED]";
    } else if (typeof v === "string") {
      sanitized[k] = redactSecrets(v);
    } else if (v instanceof Error) {
      sanitized[k] = {
        name: v.name,
        message: redactSecrets(v.message),
      };
    } else {
      sanitized[k] = v;
    }
  }
  const line = JSON.stringify(sanitized);
  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

function parsePositiveInt(
  raw: string | undefined,
  fallback: number,
  name: string,
): number {
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid non-negative integer for ${name}: "${raw}"`);
  }
  return parsed;
}

export function loadAppConfig(
  env: Record<string, string | undefined> = Bun.env,
): AppConfig {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is required (e.g. postgres://user:pass@127.0.0.1:5432/bunest_prod).",
    );
  }

  const trustProxyRaw =
    env.TRUST_PROXY ?? "127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16";
  const trustProxy = trustProxyRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    host: env.HOST ?? "127.0.0.1",
    port: parsePositiveInt(env.PORT, 3000, "PORT"),
    databaseUrl,
    dbPoolMax: parsePositiveInt(env.DB_POOL_MAX, 10, "DB_POOL_MAX") || 10,
    dbConnectionTimeoutSec:
      parsePositiveInt(
        env.DB_CONNECTION_TIMEOUT_SEC,
        5,
        "DB_CONNECTION_TIMEOUT_SEC",
      ) || 5,
    dbIdleTimeoutSec: parsePositiveInt(
      env.DB_IDLE_TIMEOUT_SEC,
      30,
      "DB_IDLE_TIMEOUT_SEC",
    ),
    readyDbTimeoutMs:
      parsePositiveInt(env.READY_DB_TIMEOUT_MS, 1500, "READY_DB_TIMEOUT_MS") ||
      1500,
    bodyLimitBytes:
      parsePositiveInt(env.BODY_LIMIT_BYTES, 1024 * 1024, "BODY_LIMIT_BYTES") ||
      1024 * 1024,
    trustProxy,
    shutdownReadinessDelayMs: parsePositiveInt(
      env.SHUTDOWN_READINESS_DELAY_MS,
      0,
      "SHUTDOWN_READINESS_DELAY_MS",
    ),
    shutdownDrainTimeoutMs:
      parsePositiveInt(
        env.SHUTDOWN_DRAIN_TIMEOUT_MS,
        10_000,
        "SHUTDOWN_DRAIN_TIMEOUT_MS",
      ) || 10_000,
    metricsToken: env.METRICS_TOKEN?.trim() || undefined,
    appVersion: env.APP_VERSION?.trim() || "0.1.0-preview",
  };
}
