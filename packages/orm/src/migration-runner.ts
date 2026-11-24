import { getDialectProfile } from "./dialect/dialect-profile";
import { isDocumentDriver } from "./driver/driver.interface";
import {
  assertSafeSqlIdentifier,
  formatPlaceholder,
  quoteIdentifier,
} from "./identifiers";
import type {
  OrmDriverLike,
  OrmMigration,
  OrmMigrationRecord,
  OrmMigrationStatus,
  OrmQueryExecutor,
} from "./types";

export const DEFAULT_ORM_MIGRATIONS_TABLE = "__bunest_orm_migrations";

interface RawOrmMigrationRow {
  readonly id: string;
  readonly name: string;
  readonly batch: number | string;
  readonly applied_at: string;
}

interface MaxBatchRow {
  readonly max_batch: number | string | null;
}

/**
 * Structural host accepted by `OrmMigrationRunner` (implemented by `DataSource`).
 */
export interface OrmMigrationHost {
  readonly driver: OrmDriverLike;
  readonly options?: {
    readonly migrations?: readonly OrmMigration[];
    readonly migrationsTable?: string;
  };
}

function isMigrationHost(
  value: OrmMigrationHost | OrmDriverLike,
): value is OrmMigrationHost {
  return (
    "driver" in value &&
    typeof (value as { execute?: unknown }).execute !== "function"
  );
}

function isMissingTableError(err: unknown): boolean {
  const candidates: unknown[] = [err];
  if (err && typeof err === "object" && "cause" in err && err.cause) {
    candidates.push(err.cause);
  }
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const rec = candidate as {
      code?: unknown;
      errno?: unknown;
      message?: unknown;
    };
    const code = String(rec.code ?? "");
    const errno = Number(rec.errno);
    const message = String(rec.message ?? candidate).toLowerCase();

    if (code === "42P01" || code === "ER_NO_SUCH_TABLE" || errno === 1146) {
      return true;
    }
    if (
      message.includes("no such table") ||
      message.includes("does not exist") ||
      message.includes("doesn't exist")
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Splits a multi-statement SQL script into executable statements while preserving
 * single-quoted strings, double-quoted / backtick identifiers, Postgres `$tag$...$tag$`
 * dollar-quoted bodies, and `--` / `/* ... *\/` comments.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let hasNonCommentToken = false;
  let i = 0;
  const len = sql.length;

  while (i < len) {
    const ch = sql[i]!;

    // Single-quoted string literal '...'
    if (ch === "'") {
      hasNonCommentToken = true;
      current += ch;
      i++;
      while (i < len) {
        const c = sql[i]!;
        current += c;
        i++;
        if (c === "'") {
          if (i < len && sql[i] === "'") {
            current += sql[i]!;
            i++;
          } else {
            break;
          }
        }
      }
      continue;
    }

    // Double-quoted identifier "..."
    if (ch === '"') {
      hasNonCommentToken = true;
      current += ch;
      i++;
      while (i < len) {
        const c = sql[i]!;
        current += c;
        i++;
        if (c === '"') {
          if (i < len && sql[i] === '"') {
            current += sql[i]!;
            i++;
          } else {
            break;
          }
        }
      }
      continue;
    }

    // Backtick-quoted identifier `...`
    if (ch === "`") {
      hasNonCommentToken = true;
      current += ch;
      i++;
      while (i < len) {
        const c = sql[i]!;
        current += c;
        i++;
        if (c === "`") {
          if (i < len && sql[i] === "`") {
            current += sql[i]!;
            i++;
          } else {
            break;
          }
        }
      }
      continue;
    }

    // Single-line comment -- ...
    if (ch === "-" && i + 1 < len && sql[i + 1] === "-") {
      while (i < len && sql[i] !== "\n") {
        current += sql[i]!;
        i++;
      }
      continue;
    }

    // Block comment /* ... */
    if (ch === "/" && i + 1 < len && sql[i + 1] === "*") {
      current += "/*";
      i += 2;
      while (i < len) {
        if (sql[i] === "*" && i + 1 < len && sql[i + 1] === "/") {
          current += "*/";
          i += 2;
          break;
        }
        current += sql[i]!;
        i++;
      }
      continue;
    }

    // PostgreSQL dollar-quoted string $tag$...$tag$
    if (ch === "$") {
      const rest = sql.slice(i);
      const tagMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest);
      if (tagMatch) {
        const tag = tagMatch[0];
        hasNonCommentToken = true;
        current += tag;
        i += tag.length;
        const closeIdx = sql.indexOf(tag, i);
        if (closeIdx === -1) {
          current += sql.slice(i);
          i = len;
        } else {
          current += sql.slice(i, closeIdx + tag.length);
          i = closeIdx + tag.length;
        }
        continue;
      }
    }

    if (ch === ";") {
      const trimmed = current.trim();
      if (trimmed.length > 0 && hasNonCommentToken) {
        statements.push(trimmed);
      }
      current = "";
      hasNonCommentToken = false;
      i++;
      continue;
    }

    if (!/\s/.test(ch)) {
      hasNonCommentToken = true;
    }
    current += ch;
    i++;
  }

  const tail = current.trim();
  if (tail.length > 0 && hasNonCommentToken) {
    statements.push(tail);
  }

  return statements;
}

/**
 * Multi-dialect migration runner for `@bunest/orm`.
 *
 * Automatically provided & exported by `OrmModule.forRoot()` / `OrmModule.forRootAsync()`.
 * Supports both raw SQL string migrations (including multi-statement scripts) and
 * programmatic callback migrations across SQLite, PostgreSQL, MySQL, MariaDB, LibSQL, D1,
 * MongoDB, and custom `OrmDriver`s.
 */
export class OrmMigrationRunner {
  private readonly host: OrmMigrationHost | OrmDriverLike;
  private readonly explicitMigrations?: readonly OrmMigration[];
  private readonly tableName: string;

  constructor(
    hostOrDriver: OrmMigrationHost | OrmDriverLike,
    defaultMigrations?: readonly OrmMigration[],
    migrationsTable?: string,
  ) {
    this.host = hostOrDriver;
    this.explicitMigrations = defaultMigrations;
    const rawTable =
      migrationsTable ??
      (isMigrationHost(hostOrDriver)
        ? hostOrDriver.options?.migrationsTable
        : undefined) ??
      DEFAULT_ORM_MIGRATIONS_TABLE;
    this.tableName = assertSafeSqlIdentifier(rawTable, "migrations table name");
  }

  get migrationsTableName(): string {
    return this.tableName;
  }

  private getDriver(): OrmDriverLike {
    return isMigrationHost(this.host) ? this.host.driver : this.host;
  }

  private getDefaultMigrations(): readonly OrmMigration[] {
    if (this.explicitMigrations !== undefined) {
      return this.explicitMigrations;
    }
    if (isMigrationHost(this.host)) {
      return this.host.options?.migrations ?? [];
    }
    return [];
  }

  async ensureMigrationsTable(): Promise<void> {
    const driver = this.getDriver();
    if (isDocumentDriver(driver)) {
      await driver.ensureCollection(this.tableName);
      return;
    }

    const dialect = driver.dialect;
    const profile = getDialectProfile(dialect);
    const tbl = quoteIdentifier(this.tableName, dialect, "migrations table name");
    const idCol = quoteIdentifier("id", dialect, "column name");
    const nameCol = quoteIdentifier("name", dialect, "column name");
    const batchCol = quoteIdentifier("batch", dialect, "column name");
    const appliedCol = quoteIdentifier("applied_at", dialect, "column name");

    const idType = profile.columnSqlType({
      columnName: "id",
      type: "varchar",
      length: 255,
      primary: true,
      unique: true,
      hasDefault: false,
      nullable: false,
    });
    const nameType = profile.columnSqlType({
      columnName: "name",
      type: "text",
      primary: false,
      unique: false,
      hasDefault: false,
      nullable: false,
    });
    const batchType = profile.columnSqlType({
      columnName: "batch",
      type: "integer",
      primary: false,
      unique: false,
      hasDefault: false,
      nullable: false,
    });
    const appliedType = profile.columnSqlType({
      columnName: "applied_at",
      type: "varchar",
      length: 64,
      primary: false,
      unique: false,
      hasDefault: false,
      nullable: false,
    });

    await driver.execute(
      `${profile.formatCreateTablePrefix(tbl)} (${idCol} ${idType} PRIMARY KEY, ${nameCol} ${nameType} NOT NULL, ${batchCol} ${batchType} NOT NULL, ${appliedCol} ${appliedType} NOT NULL)`,
    );
  }

  /**
   * Returns all applied migrations without executing write DDL (safe for read-only replicas).
   */
  async getApplied(): Promise<OrmMigrationRecord[]> {
    const driver = this.getDriver();

    if (isDocumentDriver(driver)) {
      const docs = await driver.docFind(
        this.tableName,
        {},
        { sort: { batch: 1, appliedAt: 1 } },
      );
      return docs.map((d) => ({
        id: String(d.id ?? d._id),
        name: String(d.name ?? d.id ?? d._id),
        batch: Number(d.batch ?? 1),
        appliedAt: String(d.appliedAt ?? d.applied_at ?? ""),
      }));
    }

    const dialect = driver.dialect;
    if (dialect === "sqlite" || dialect === "libsql" || dialect === "d1") {
      const check = await driver.query<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${formatPlaceholder(1, dialect)} LIMIT 1`,
        [this.tableName],
      );
      if (check.rows.length === 0) {
        return [];
      }
    }

    const tbl = quoteIdentifier(this.tableName, dialect, "migrations table name");
    const idCol = quoteIdentifier("id", dialect, "column name");
    const nameCol = quoteIdentifier("name", dialect, "column name");
    const batchCol = quoteIdentifier("batch", dialect, "column name");
    const appliedCol = quoteIdentifier("applied_at", dialect, "column name");

    try {
      const res = await driver.query<RawOrmMigrationRow>(
        `SELECT ${idCol} AS id, ${nameCol} AS name, ${batchCol} AS batch, ${appliedCol} AS applied_at FROM ${tbl} ORDER BY ${batchCol} ASC, ${appliedCol} ASC, ${idCol} ASC`,
      );
      return res.rows.map((row) => ({
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

  async getPending(
    migrations: readonly OrmMigration[] = this.getDefaultMigrations(),
  ): Promise<OrmMigration[]> {
    this.assertUniqueMigrationIds(migrations);
    const appliedIds = new Set((await this.getApplied()).map((m) => m.id));
    return migrations.filter((m) => !appliedIds.has(m.id));
  }

  async status(
    migrations: readonly OrmMigration[] = this.getDefaultMigrations(),
  ): Promise<OrmMigrationStatus> {
    this.assertUniqueMigrationIds(migrations);
    const applied = await this.getApplied();
    const appliedIds = new Set(applied.map((m) => m.id));
    const pending = migrations.filter((m) => !appliedIds.has(m.id));
    return { applied, pending };
  }

  /**
   * Applies pending migrations in order. Idempotent: already-applied migrations are skipped.
   * Each migration runs transactionally by default (`transactional !== false`).
   */
  async up(
    migrations: readonly OrmMigration[] = this.getDefaultMigrations(),
    options?: { readonly steps?: number },
  ): Promise<OrmMigrationRecord[]> {
    this.assertUniqueMigrationIds(migrations);
    if (migrations.length === 0) {
      return [];
    }

    const driver = this.getDriver();
    await this.ensureMigrationsTable();

    const { applied, pending } = await this.status(migrations);
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

    const nextBatch = await this.computeNextBatch(driver, applied);
    const appliedRecords: OrmMigrationRecord[] = [];

    for (const migration of toApply) {
      const name = migration.name ?? migration.id;
      const appliedAt = new Date().toISOString();

      const executeMigration = async (exec: OrmQueryExecutor) => {
        await this.runMigrationHandler(exec, migration.up);
        await this.recordAppliedMigration(
          driver,
          exec,
          migration.id,
          name,
          nextBatch,
          appliedAt,
        );
      };

      if (migration.transactional === false || isDocumentDriver(driver)) {
        await executeMigration(driver);
      } else {
        await driver.transaction(executeMigration);
      }

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
    migrations: readonly OrmMigration[] = this.getDefaultMigrations(),
    options?: { readonly steps?: number; readonly all?: boolean },
  ): Promise<OrmMigrationRecord[]> {
    this.assertUniqueMigrationIds(migrations);
    const applied = await this.getApplied();
    if (applied.length === 0) {
      return [];
    }

    const byId = new Map<string, OrmMigration>();
    for (const m of migrations) {
      byId.set(m.id, m);
    }

    const reversed = [...applied].reverse();
    let targets: OrmMigrationRecord[];
    if (options?.all) {
      targets = reversed;
    } else if (options?.steps !== undefined) {
      targets = reversed.slice(0, Math.max(0, Math.floor(options.steps)));
    } else {
      const latestBatch = reversed[0]!.batch;
      targets = reversed.filter((r) => r.batch === latestBatch);
    }

    const driver = this.getDriver();
    const reverted: OrmMigrationRecord[] = [];

    for (const record of targets) {
      const definition = byId.get(record.id);
      if (!definition) {
        throw new Error(
          `Cannot revert ORM migration "${record.id}": migration definition not found.`,
        );
      }
      if (!definition.down) {
        throw new Error(
          `Cannot revert ORM migration "${record.id}": no "down" handler is defined.`,
        );
      }

      const downHandler = definition.down;
      const executeRollback = async (exec: OrmQueryExecutor) => {
        await this.runMigrationHandler(exec, downHandler);
        await this.deleteAppliedMigration(driver, exec, record.id);
      };

      if (definition.transactional === false || isDocumentDriver(driver)) {
        await executeRollback(driver);
      } else {
        await driver.transaction(executeRollback);
      }

      reverted.push(record);
    }

    return reverted;
  }

  private async runMigrationHandler(
    exec: OrmQueryExecutor,
    handler: string | ((runner: OrmQueryExecutor) => Promise<void> | void),
  ): Promise<void> {
    if (typeof handler === "string") {
      const statements = splitSqlStatements(handler);
      for (const stmt of statements) {
        await exec.execute(stmt);
      }
      return;
    }
    await handler(exec);
  }

  private async computeNextBatch(
    driver: OrmDriverLike,
    applied: readonly OrmMigrationRecord[],
  ): Promise<number> {
    if (isDocumentDriver(driver)) {
      const maxBatch = applied.reduce((max, r) => Math.max(max, r.batch), 0);
      return maxBatch + 1;
    }
    const dialect = driver.dialect;
    const tbl = quoteIdentifier(this.tableName, dialect, "migrations table name");
    const batchCol = quoteIdentifier("batch", dialect, "column name");
    const res = await driver.query<MaxBatchRow>(
      `SELECT MAX(${batchCol}) AS max_batch FROM ${tbl}`,
    );
    return Number(res.rows[0]?.max_batch ?? 0) + 1;
  }

  private async recordAppliedMigration(
    driver: OrmDriverLike,
    exec: OrmQueryExecutor,
    id: string,
    name: string,
    batch: number,
    appliedAt: string,
  ): Promise<void> {
    if (isDocumentDriver(driver)) {
      await driver.docInsertMany(this.tableName, [
        { _id: id, id, name, batch, appliedAt },
      ]);
      return;
    }
    const dialect = exec.dialect;
    const tbl = quoteIdentifier(this.tableName, dialect, "migrations table name");
    const idCol = quoteIdentifier("id", dialect, "column name");
    const nameCol = quoteIdentifier("name", dialect, "column name");
    const batchCol = quoteIdentifier("batch", dialect, "column name");
    const appliedCol = quoteIdentifier("applied_at", dialect, "column name");
    const p1 = formatPlaceholder(1, dialect);
    const p2 = formatPlaceholder(2, dialect);
    const p3 = formatPlaceholder(3, dialect);
    const p4 = formatPlaceholder(4, dialect);
    await exec.execute(
      `INSERT INTO ${tbl} (${idCol}, ${nameCol}, ${batchCol}, ${appliedCol}) VALUES (${p1}, ${p2}, ${p3}, ${p4})`,
      [id, name, batch, appliedAt],
    );
  }

  private async deleteAppliedMigration(
    driver: OrmDriverLike,
    exec: OrmQueryExecutor,
    id: string,
  ): Promise<void> {
    if (isDocumentDriver(driver)) {
      await driver.docDelete(this.tableName, { _id: id });
      return;
    }
    const dialect = exec.dialect;
    const tbl = quoteIdentifier(this.tableName, dialect, "migrations table name");
    const idCol = quoteIdentifier("id", dialect, "column name");
    const p1 = formatPlaceholder(1, dialect);
    await exec.execute(`DELETE FROM ${tbl} WHERE ${idCol} = ${p1}`, [id]);
  }

  private assertUniqueMigrationIds(migrations: readonly OrmMigration[]): void {
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
