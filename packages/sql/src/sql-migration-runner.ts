import type {
  AppliedMigration,
  MigrationDefinition,
  MigrationRunner,
  MigrationStatus,
} from "./contracts";
import type {
  SqlMigrationExecutor,
  SqlMigrationRunnerOptions,
} from "./interfaces";

const SAFE_TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_PG_ADVISORY_LOCK_ID = 7_421_903;

interface RawSqlMigrationRow {
  readonly id: string;
  readonly name: string;
  readonly batch: number;
  readonly applied_at: string;
}

interface MaxBatchRow {
  readonly max_batch: number | null;
}

function isMissingTableError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const rec = err as {
    code?: unknown;
    errno?: unknown;
    message?: unknown;
  };
  const code = String(rec.code ?? "");
  const errno = Number(rec.errno);
  const message = String(rec.message ?? err).toLowerCase();

  if (code === "42P01" || code === "ER_NO_SUCH_TABLE" || errno === 1146) {
    return true;
  }
  return (
    message.includes("no such table") ||
    message.includes("does not exist") ||
    message.includes("doesn't exist")
  );
}

function hashStringToInt32(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) || DEFAULT_PG_ADVISORY_LOCK_ID;
}

/**
 * Dialect-agnostic migration runner implementing `MigrationRunner<TExecutor>`
 * backed by Bun's native `Bun.SQL` tagged templates (PostgreSQL, MySQL/MariaDB, and SQLite).
 *
 * - Read-only safe `getApplied()` & `status()` (never executes write DDL)
 * - PostgreSQL multi-statement migration scripts executed via `.simple()` protocol
 * - Optional distributed advisory locking (`pg_advisory_lock` / `GET_LOCK`)
 */
export class SqlMigrationRunner<
  TExecutor extends SqlMigrationExecutor = SqlMigrationExecutor,
> implements MigrationRunner<TExecutor>
{
  private readonly tableName: string;
  private readonly runnerOptions: SqlMigrationRunnerOptions;

  constructor(
    private readonly sqlService: TExecutor,
    private readonly defaultMigrations: readonly MigrationDefinition<TExecutor>[] = [],
    migrationsTable: string = "_bunest_migrations",
    options: SqlMigrationRunnerOptions = {},
  ) {
    if (!SAFE_TABLE_NAME.test(migrationsTable)) {
      throw new Error(
        `Invalid migrations table name "${migrationsTable}": must match ${SAFE_TABLE_NAME.source}`,
      );
    }
    this.tableName = migrationsTable;
    this.runnerOptions = options;
  }

  get migrationsTableName(): string {
    return this.tableName;
  }

  async ensureMigrationsTable(): Promise<void> {
    const quotedTable = this.quoteDdlIdentifier(this.tableName);
    await this.sqlService.unsafe(
      `CREATE TABLE IF NOT EXISTS ${quotedTable} (
        id VARCHAR(255) PRIMARY KEY,
        name TEXT NOT NULL,
        batch INTEGER NOT NULL,
        applied_at VARCHAR(64) NOT NULL
      )`,
    );
  }

  /**
   * Returns applied migration records without executing write DDL (safe for read-only replicas/users).
   */
  async getApplied(): Promise<AppliedMigration[]> {
    const adapter = this.sqlService.adapter;
    if (adapter === "sqlite") {
      const existsRows = await this.sqlService.sql<{ name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${this.tableName} LIMIT 1
      `;
      if (existsRows.length === 0) {
        return [];
      }
    }

    try {
      const rows = await this.sqlService.sql<RawSqlMigrationRow>`
        SELECT id, name, batch, applied_at
        FROM ${this.sqlService.sql(this.tableName)}
        ORDER BY batch ASC, applied_at ASC, id ASC
      `;
      return [...rows].map((row) => ({
        id: String(row.id),
        name: String(row.name),
        batch: Number(row.batch),
        appliedAt: String(row.applied_at),
      }));
    } catch (err) {
      if (isMissingTableError(err)) {
        return [];
      }
      throw err;
    }
  }

  private quoteDdlIdentifier(identifier: string): string {
    const adapter = this.sqlService.adapter;
    if (adapter === "mysql" || adapter === "mariadb") {
      return `\`${identifier}\``;
    }
    return `"${identifier}"`;
  }

  private async executeRawMigrationSql(sql: string): Promise<void> {
    const adapter = this.sqlService.adapter;
    if (adapter === "postgres" || adapter === "postgresql") {
      await this.sqlService.simple(sql);
    } else {
      await this.sqlService.unsafe(sql);
    }
  }

  private async withAdvisoryLock<R>(
    enabled: boolean,
    lockIdOverride: number | string | undefined,
    fn: () => Promise<R>,
  ): Promise<R> {
    if (!enabled) {
      return await fn();
    }

    const adapter = this.sqlService.adapter;
    const isPostgres = adapter === "postgres" || adapter === "postgresql";
    const isMysql = adapter === "mysql" || adapter === "mariadb";

    if (!isPostgres && !isMysql) {
      // SQLite is already single-writer and serialized by SqlService transaction lock
      return await fn();
    }

    // Session-level advisory locks MUST be acquired and released on the same dedicated connection.
    const reserved =
      typeof this.sqlService.reserve === "function"
        ? await this.sqlService.reserve()
        : undefined;
    const lockSql = (reserved ?? this.sqlService.sql) as unknown as (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => Promise<Record<string, unknown>[]>;

    let acquired = false;
    try {
      if (isPostgres) {
        const lockId =
          typeof lockIdOverride === "number"
            ? Math.trunc(lockIdOverride)
            : typeof lockIdOverride === "string"
              ? hashStringToInt32(lockIdOverride)
              : hashStringToInt32(`bunest:migrations:${this.tableName}`);

        await lockSql`SELECT pg_advisory_lock(${lockId})`;
        acquired = true;
        try {
          return await fn();
        } finally {
          if (acquired) {
            await lockSql`SELECT pg_advisory_unlock(${lockId})`;
          }
        }
      }

      const lockName =
        lockIdOverride !== undefined
          ? String(lockIdOverride)
          : `bunest:migrations:${this.tableName}`;

      const rows = await lockSql`SELECT GET_LOCK(${lockName}, 30) AS acquired`;
      const firstRow = Array.isArray(rows) ? rows[0] : undefined;
      const rawAcquired =
        firstRow && typeof firstRow === "object"
          ? "acquired" in firstRow
            ? firstRow.acquired
            : Object.values(firstRow)[0]
          : undefined;

      if (
        rawAcquired === null ||
        rawAcquired === undefined ||
        Number(rawAcquired) !== 1
      ) {
        throw new Error(
          `Failed to acquire MySQL migration advisory lock "${lockName}" (GET_LOCK returned ${String(rawAcquired)}).`,
        );
      }

      acquired = true;
      try {
        return await fn();
      } finally {
        if (acquired) {
          await lockSql`SELECT RELEASE_LOCK(${lockName})`;
        }
      }
    } finally {
      await reserved?.release();
    }
  }

  async status(
    migrations: readonly MigrationDefinition<TExecutor>[] = this.defaultMigrations,
  ): Promise<MigrationStatus<TExecutor>> {
    this.assertUniqueIds(migrations);
    const applied = await this.getApplied();
    const appliedIds = new Set(applied.map((m) => m.id));
    const pending = migrations.filter((m) => !appliedIds.has(m.id));
    return { applied, pending };
  }

  async up(
    migrations: readonly MigrationDefinition<TExecutor>[] = this.defaultMigrations,
    options?: {
      readonly steps?: number;
      readonly advisoryLock?: boolean;
      readonly advisoryLockId?: number | string;
    },
  ): Promise<AppliedMigration[]> {
    this.assertUniqueIds(migrations);

    const useLock =
      options?.advisoryLock ?? this.runnerOptions.advisoryLock ?? false;
    const lockId = options?.advisoryLockId ?? this.runnerOptions.advisoryLockId;

    return await this.withAdvisoryLock(useLock, lockId, async () => {
      await this.ensureMigrationsTable();
      const { pending } = await this.status(migrations);
      if (pending.length === 0) {
        return [];
      }

      const limit =
        options?.steps !== undefined
          ? Math.max(0, Math.floor(options.steps))
          : pending.length;
      const toApply = pending.slice(0, limit);
      if (toApply.length === 0) {
        return [];
      }

      const maxRows = await this.sqlService.sql<MaxBatchRow>`
        SELECT MAX(batch) AS max_batch
        FROM ${this.sqlService.sql(this.tableName)}
      `;
      const nextBatch = Number(maxRows[0]?.max_batch ?? 0) + 1;
      const appliedRecords: AppliedMigration[] = [];

      for (const migration of toApply) {
        const name = migration.name ?? migration.id;
        const appliedAt = new Date().toISOString();

        const execute = async () => {
          if (typeof migration.up === "string") {
            await this.executeRawMigrationSql(migration.up);
          } else {
            await migration.up(this.sqlService);
          }
          await this.sqlService.sql`INSERT INTO ${this.sqlService.sql(this.tableName)} (id, name, batch, applied_at) VALUES (${migration.id}, ${name}, ${nextBatch}, ${appliedAt})`;
        };

        if (migration.transactional === false) {
          await execute();
        } else {
          await this.sqlService.transaction(async () => {
            await execute();
          });
        }

        appliedRecords.push({
          id: migration.id,
          name,
          batch: nextBatch,
          appliedAt,
        });
      }

      return appliedRecords;
    });
  }

  async down(
    migrations: readonly MigrationDefinition<TExecutor>[] = this.defaultMigrations,
    options?: {
      readonly steps?: number;
      readonly all?: boolean;
      readonly advisoryLock?: boolean;
      readonly advisoryLockId?: number | string;
    },
  ): Promise<AppliedMigration[]> {
    this.assertUniqueIds(migrations);

    const useLock =
      options?.advisoryLock ?? this.runnerOptions.advisoryLock ?? false;
    const lockId = options?.advisoryLockId ?? this.runnerOptions.advisoryLockId;

    return await this.withAdvisoryLock(useLock, lockId, async () => {
      const applied = await this.getApplied();
      if (applied.length === 0) {
        return [];
      }

      const byId = new Map<string, MigrationDefinition<TExecutor>>();
      for (const m of migrations) {
        byId.set(m.id, m);
      }

      const reversed = [...applied].reverse();
      let targets: AppliedMigration[];
      if (options?.all) {
        targets = reversed;
      } else if (options?.steps !== undefined) {
        targets = reversed.slice(0, Math.max(0, Math.floor(options.steps)));
      } else {
        const latestBatch = reversed[0]!.batch;
        targets = reversed.filter((r) => r.batch === latestBatch);
      }

      const reverted: AppliedMigration[] = [];

      for (const record of targets) {
        const def = byId.get(record.id);
        if (!def) {
          throw new Error(
            `Cannot revert SQL migration "${record.id}": migration definition not found.`,
          );
        }
        if (!def.down) {
          throw new Error(
            `Cannot revert SQL migration "${record.id}": no "down" handler is defined.`,
          );
        }

        const downHandler = def.down;
        const execute = async () => {
          if (typeof downHandler === "string") {
            await this.executeRawMigrationSql(downHandler);
          } else {
            await downHandler(this.sqlService);
          }
          await this.sqlService.sql`DELETE FROM ${this.sqlService.sql(this.tableName)} WHERE id = ${record.id}`;
        };

        if (def.transactional === false) {
          await execute();
        } else {
          await this.sqlService.transaction(async () => {
            await execute();
          });
        }

        reverted.push(record);
      }

      return reverted;
    });
  }

  private assertUniqueIds(
    migrations: readonly MigrationDefinition<TExecutor>[],
  ): void {
    const seen = new Set<string>();
    for (const m of migrations) {
      if (!m.id || m.id.trim().length === 0) {
        throw new Error("Migration id must be a non-empty string.");
      }
      if (seen.has(m.id)) {
        throw new Error(`Duplicate migration id "${m.id}".`);
      }
      seen.add(m.id);
    }
  }
}
