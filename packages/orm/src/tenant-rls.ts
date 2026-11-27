import type { DataSource } from "./data-source";
import type { EntityManager } from "./entity-manager";
import { InvalidTenantIdentifierError, OrmError } from "./errors";
import { quoteIdentifier } from "./identifiers";
import type {
  OrmIsolationLevel,
  OrmTransactionOptions,
  OrmTransactionPropagation,
} from "./types";

export type TenantTransactionMode = "rls" | "schema";

export interface TenantTransactionOptions {
  /**
   * Multi-tenant isolation mode:
   * - `"rls"` (default): sets transaction-local PostgreSQL GUC via parameterized
   *   `SELECT set_config($1, $2, true)` for Row-Level Security policies.
   * - `"schema"`: strictly validates tenant schema identifier and executes
   *   `SET LOCAL search_path TO "<schema>"`.
   */
  readonly mode?: TenantTransactionMode;
  /**
   * PostgreSQL GUC setting name used in `"rls"` mode.
   * @default "app.current_tenant_id"
   */
  readonly settingName?: string;
  /**
   * Optional schema prefix prepended to `tenantId` in `"schema"` mode (e.g. `"tenant_"`).
   * @default ""
   */
  readonly schemaPrefix?: string;
  /**
   * Optional fallback schema appended to `SET LOCAL search_path` in `"schema"` mode
   * (e.g. `"public"` for shared extensions/tables). Omitted by default to guarantee
   * strict tenant schema isolation with zero accidental fallthrough to `public`.
   */
  readonly fallbackSchema?: string;
  readonly isolationLevel?: OrmIsolationLevel;
  readonly propagation?: OrmTransactionPropagation;
  readonly readOnly?: boolean;
  readonly retries?: number;
  readonly retryDelayMs?: number;
}

const SAFE_PG_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const SAFE_TENANT_SUFFIX = /^[a-zA-Z0-9_]+$/;
const SAFE_RLS_SETTING_NAME =
  /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)?$/;
const MAX_PG_IDENTIFIER_LENGTH = 63;

/**
 * Strictly validates a PostgreSQL RLS GUC setting name (e.g. `"app.current_tenant_id"`).
 */
export function validateRlsSettingName(settingName: string): string {
  if (
    typeof settingName !== "string" ||
    settingName.length === 0 ||
    settingName.length > MAX_PG_IDENTIFIER_LENGTH * 2 + 1 ||
    !SAFE_RLS_SETTING_NAME.test(settingName)
  ) {
    throw new InvalidTenantIdentifierError(
      `Invalid RLS setting name "${String(settingName)}". Must match /^[a-zA-Z_][a-zA-Z0-9_]*(\\.[a-zA-Z_][a-zA-Z0-9_]*)?$/.`,
    );
  }
  return settingName;
}

/**
 * Strictly validates a PostgreSQL schema identifier (or `schemaPrefix + tenantId`)
 * against `/^[a-zA-Z_][a-zA-Z0-9_]*$/` (max 63 chars) to prevent SQL injection.
 */
export function validateTenantSchemaIdentifier(
  tenantId: string,
  schemaPrefix = "",
): string {
  if (typeof tenantId !== "string" || tenantId.length === 0) {
    throw new InvalidTenantIdentifierError(
      "Tenant identifier must be a non-empty string.",
    );
  }
  if (typeof schemaPrefix !== "string") {
    throw new InvalidTenantIdentifierError(
      "Tenant schemaPrefix must be a string.",
    );
  }

  if (schemaPrefix.length > 0) {
    if (!SAFE_PG_IDENTIFIER.test(schemaPrefix)) {
      throw new InvalidTenantIdentifierError(
        `Invalid tenant schemaPrefix "${schemaPrefix}". Identifiers must match /^[a-zA-Z_][a-zA-Z0-9_]*$/.`,
      );
    }
    if (!SAFE_TENANT_SUFFIX.test(tenantId)) {
      throw new InvalidTenantIdentifierError(
        `Invalid tenantId "${tenantId}" for schema mode. Only ASCII letters, digits, and underscores are allowed.`,
      );
    }
  } else if (!SAFE_PG_IDENTIFIER.test(tenantId)) {
    throw new InvalidTenantIdentifierError(
      `Invalid tenant schema identifier "${tenantId}". Identifiers must match /^[a-zA-Z_][a-zA-Z0-9_]*$/.`,
    );
  }

  const combined = `${schemaPrefix}${tenantId}`;
  if (
    !SAFE_PG_IDENTIFIER.test(combined) ||
    combined.length > MAX_PG_IDENTIFIER_LENGTH
  ) {
    throw new InvalidTenantIdentifierError(
      `Invalid resolved tenant schema "${combined}". Must match /^[a-zA-Z_][a-zA-Z0-9_]*$/ and be at most ${MAX_PG_IDENTIFIER_LENGTH} characters.`,
    );
  }

  return combined;
}

/**
 * Executes `fn` inside a transaction scoped strictly to a single tenant via
 * PostgreSQL Row-Level Security (`SELECT set_config($1, $2, true)`) or
 * Schema-per-Tenant (`SET LOCAL search_path TO "<schema>"`).
 *
 * Because both mechanisms are transaction-local (`is_local = true` / `SET LOCAL`),
 * tenant state is automatically cleared at `COMMIT` or `ROLLBACK` and can never
 * leak across pooled database connections.
 */
export async function runInTenantTransaction<T>(
  ds: DataSource,
  tenantId: string,
  fn: (entityManager: EntityManager) => Promise<T> | T,
  opts: TenantTransactionOptions = {},
): Promise<T> {
  if (typeof tenantId !== "string" || tenantId.trim().length === 0) {
    throw new InvalidTenantIdentifierError(
      "runInTenantTransaction() requires a non-empty tenantId string.",
    );
  }

  if (ds.dialect !== "postgres" && ds.dialect !== "cockroachdb") {
    throw new OrmError(
      `runInTenantTransaction() requires a PostgreSQL or CockroachDB DataSource (received dialect "${ds.dialect}").`,
    );
  }

  if (opts.propagation === "NEVER") {
    throw new OrmError(
      'runInTenantTransaction() cannot use propagation "NEVER" because transaction-local tenant isolation requires an active transaction.',
    );
  }

  const mode: TenantTransactionMode = opts.mode ?? "rls";
  if (mode !== "rls" && mode !== "schema") {
    throw new OrmError(
      `Invalid tenant transaction mode "${String(mode)}". Expected "rls" or "schema".`,
    );
  }

  const txOpts: OrmTransactionOptions = {
    ...(opts.isolationLevel !== undefined
      ? { isolationLevel: opts.isolationLevel }
      : {}),
    ...(opts.propagation !== undefined ? { propagation: opts.propagation } : {}),
    ...(opts.readOnly !== undefined ? { readOnly: opts.readOnly } : {}),
    ...(opts.retries !== undefined ? { retries: opts.retries } : {}),
    ...(opts.retryDelayMs !== undefined
      ? { retryDelayMs: opts.retryDelayMs }
      : {}),
  };

  if (mode === "rls") {
    const settingName = validateRlsSettingName(
      opts.settingName ?? "app.current_tenant_id",
    );
    return await ds.transaction(async (em) => {
      await em.query("SELECT set_config($1, $2, true)", [
        settingName,
        tenantId,
      ]);
      return await fn(em);
    }, txOpts);
  }

  // Schema-per-tenant mode (`SET LOCAL search_path TO ...`)
  const schemaName = validateTenantSchemaIdentifier(
    tenantId,
    opts.schemaPrefix ?? "",
  );
  const quotedSchemas = [
    quoteIdentifier(schemaName, ds.dialect, "tenant schema"),
  ];

  if (opts.fallbackSchema !== undefined) {
    const safeFallback = validateTenantSchemaIdentifier(opts.fallbackSchema);
    quotedSchemas.push(
      quoteIdentifier(safeFallback, ds.dialect, "fallback schema"),
    );
  }

  const setSearchPathSql = `SET LOCAL search_path TO ${quotedSchemas.join(", ")}`;

  return await ds.transaction(async (em) => {
    await em.query(setSearchPathSql);
    return await fn(em);
  }, txOpts);
}
