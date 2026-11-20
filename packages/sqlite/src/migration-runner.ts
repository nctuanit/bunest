import { assertSafeSqlIdentifier, quoteSqlIdentifier } from "./identifiers";
import type {
  SqliteMigration,
  SqliteMigrationRecord,
  SqliteMigrationStatus,
  SqliteQueryExecutor,
} from "./interfaces";

interface RawMigrationRow {
  readonly id: string;
  readonly name: string;
  readonly batch: number;
  readonly applied_at: string;
}

interface MaxBatchRow {
  readonly max_batch: number | null;
}

/**
 * Tracks and executes SQLite schema migrations in `_bunest_migrations` (or a custom table).
 * Supports transactional `up()`, `down()`, read-only safe `status()`, and idempotent re-runs.
 */
export class SqliteMigrationRunner {
  private readonly tableName: string;
  private readonly quotedTable: string;

  constructor(
    private readonly sqlite: SqliteQueryExecutor,
    private readonly defaultMigrations: readonly SqliteMigration[] = [],
    migrationsTable: string = "_bunest_migrations",
  ) {
    this.tableName = assertSafeSqlIdentifier(
      migrationsTable,
      "migrations table name",
    );
    this.quotedTable = quoteSqlIdentifier(
      this.tableName,
      "migrations table name",
    );
  }

  get migrationsTableName(): string {
    return this.tableName;
  }

  private hasMigrationsTable(): boolean {
    const row = this.sqlite.queryOne<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
      [this.tableName],
    );
    return row !== null;
  }

  ensureMigrationsTable(): void {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS ${this.quotedTable} (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        batch INTEGER NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
  }

  /**
   * Returns all applied migrations without executing write DDL (safe on `readonly: true` connections).
   */
  getApplied(): SqliteMigrationRecord[] {
    if (!this.hasMigrationsTable()) {
      return [];
    }
    const rows = this.sqlite.query<RawMigrationRow>(
      `SELECT id, name, batch, applied_at FROM ${this.quotedTable} ORDER BY batch ASC, rowid ASC`,
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      batch: row.batch,
      appliedAt: row.applied_at,
    }));
  }

  getPending(
    migrations: readonly SqliteMigration[] = this.defaultMigrations,
  ): SqliteMigration[] {
    this.assertUniqueMigrationIds(migrations);
    const appliedIds = new Set(this.getApplied().map((m) => m.id));
    return migrations.filter((m) => !appliedIds.has(m.id));
  }

  status(
    migrations: readonly SqliteMigration[] = this.defaultMigrations,
  ): SqliteMigrationStatus {
    this.assertUniqueMigrationIds(migrations);
    const applied = this.getApplied();
    const appliedIds = new Set(applied.map((m) => m.id));
    const pending = migrations.filter((m) => !appliedIds.has(m.id));
    return { applied, pending };
  }

  /**
   * Applies pending migrations in order. Idempotent: already-applied migrations are skipped.
   * Each migration runs transactionally by default (`transactional !== false`).
   */
  async up(
    migrations: readonly SqliteMigration[] = this.defaultMigrations,
    options?: { readonly steps?: number },
  ): Promise<SqliteMigrationRecord[]> {
    this.assertUniqueMigrationIds(migrations);
    this.ensureMigrationsTable();

    const pending = this.getPending(migrations);
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

    const maxBatchRow = this.sqlite.queryOne<MaxBatchRow>(
      `SELECT MAX(batch) AS max_batch FROM ${this.quotedTable}`,
    );
    const nextBatch = (maxBatchRow?.max_batch ?? 0) + 1;
    const appliedRecords: SqliteMigrationRecord[] = [];

    for (const migration of toApply) {
      const name = migration.name ?? migration.id;
      const appliedAt = new Date().toISOString();

      const executeMigration = async () => {
        if (typeof migration.up === "string") {
          this.sqlite.exec(migration.up);
        } else {
          await migration.up(this.sqlite);
        }
        this.sqlite.run(
          `INSERT INTO ${this.quotedTable} (id, name, batch, applied_at) VALUES (?, ?, ?, ?)`,
          [migration.id, name, nextBatch, appliedAt],
        );
      };

      if (migration.transactional === false) {
        await executeMigration();
      } else {
        await this.sqlite.transaction(async () => {
          await executeMigration();
        });
      }

      this.sqlite.clearStatementCache?.();

      appliedRecords.push({
        id: migration.id,
        name,
        batch: nextBatch,
        appliedAt,
      });
    }

    return appliedRecords;
  }

  /**
   * Reverts applied migrations in reverse order.
   * By default reverts the latest batch; pass `{ steps: N }` to revert `N` migrations,
   * or `{ all: true }` to revert every applied migration.
   */
  async down(
    migrations: readonly SqliteMigration[] = this.defaultMigrations,
    options?: { readonly steps?: number; readonly all?: boolean },
  ): Promise<SqliteMigrationRecord[]> {
    this.assertUniqueMigrationIds(migrations);
    if (!this.hasMigrationsTable()) {
      return [];
    }

    const applied = this.getApplied();
    if (applied.length === 0) {
      return [];
    }

    const byId = new Map<string, SqliteMigration>();
    for (const m of migrations) {
      byId.set(m.id, m);
    }

    const reversed = [...applied].reverse();
    let targets: SqliteMigrationRecord[];

    if (options?.all) {
      targets = reversed;
    } else if (options?.steps !== undefined) {
      const limit = Math.max(0, Math.floor(options.steps));
      targets = reversed.slice(0, limit);
    } else {
      const latestBatch = reversed[0]!.batch;
      targets = reversed.filter((record) => record.batch === latestBatch);
    }

    const reverted: SqliteMigrationRecord[] = [];

    for (const record of targets) {
      const definition = byId.get(record.id);
      if (!definition) {
        throw new Error(
          `Cannot revert migration "${record.id}": migration definition not found.`,
        );
      }
      if (!definition.down) {
        throw new Error(
          `Cannot revert migration "${record.id}": no "down" handler is defined.`,
        );
      }

      const downHandler = definition.down;
      const executeRollback = async () => {
        if (typeof downHandler === "string") {
          this.sqlite.exec(downHandler);
        } else {
          await downHandler(this.sqlite);
        }
        this.sqlite.run(`DELETE FROM ${this.quotedTable} WHERE id = ?`, [
          record.id,
        ]);
      };

      if (definition.transactional === false) {
        await executeRollback();
      } else {
        await this.sqlite.transaction(async () => {
          await executeRollback();
        });
      }

      this.sqlite.clearStatementCache?.();
      reverted.push(record);
    }

    return reverted;
  }

  private assertUniqueMigrationIds(
    migrations: readonly SqliteMigration[],
  ): void {
    const seen = new Set<string>();
    for (const migration of migrations) {
      if (!migration.id || migration.id.trim().length === 0) {
        throw new Error("Migration id must be a non-empty string.");
      }
      if (seen.has(migration.id)) {
        throw new Error(`Duplicate migration id "${migration.id}".`);
      }
      seen.add(migration.id);
    }
  }
}
