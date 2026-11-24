import type {
  MigrationSqlOptions,
  MigrationStatementsOptions,
} from "../../interfaces/migration-sql-options.interface";
import type {
  SqlExecutor as AnySqlExecutor,
  SqlTransaction as AnySqlTransaction,
} from "../../interfaces/sql-executor.interface";
import type { StoreSchemaErrorDetails } from "../../interfaces/store-schema-options.interface";
import {
  checkSchemaOptions,
  latestVersion,
  migrationRange,
  migrationScript,
  migrationsBetween,
  Readiness,
  resolveStoreOptions,
  schemaBehindMessage,
} from "../../schema/index";
import { databaseMessage } from "../../utils/error.util";
import { hasMethod } from "../../utils/executor.util";
import type {
  MySqlServer,
  MySqlStoreReadiness,
  ResolvedStoreOptions,
  StoreMigration,
  StoreOptions,
  StoreReadinessOptions,
  StoreSchemaOptions,
} from "../interfaces/mysql-store.interface";
import { mysqlErrorCode } from "../sql/errors";
import { checkSchema, quoteTable, tableName } from "../sql/identifiers";
import { SqlParams } from "../sql/sql-params";
import { MYSQL } from "./mysql-dialect";
import { checkServer } from "./server-check";

/** ER_LOCK_WAIT_TIMEOUT */
const LOCK_WAIT_TIMEOUT = 1205;

/** The first word of the statements a MySQL migration may hold: DDL, which MySQL commits on its own. */
const DDL = /^(CREATE|ALTER|DROP)\b/i;

/** What MySQL says when a DDL statement that already ran runs again. */
const ALREADY_APPLIED = new Set<number>([
  1050, // ER_TABLE_EXISTS_ERROR
  1051, // ER_BAD_TABLE_ERROR (DROP TABLE)
  1060, // ER_DUP_FIELDNAME
  1061, // ER_DUP_KEYNAME
  1068, // ER_MULTIPLE_PRI_KEY
  1091, // ER_CANT_DROP_FIELD_OR_KEY
  1826, // ER_FK_DUP_NAME
  3822, // ER_CHECK_CONSTRAINT_DUP_NAME
]);

/**
 * A store's MySQL schema: its versioned migrations, and all a store does with them.
 */
export class StoreSchema {
  /** The database it's for: `runStoreCli()` picks a package's schema by the URL's dialect. */
  readonly dialect = "mysql" as const;
  readonly packageName: string;
  readonly storeName: string;
  readonly command: string;
  readonly defaultSchema: string;
  /** The version the store needs: its last migration's. A store's `static schemaVersion`. */
  readonly latest: number;
  private readonly migrations: readonly StoreMigration[];
  private readonly createError: (
    message: string,
    details: StoreSchemaErrorDetails,
  ) => Error;
  private readonly mariadb: boolean;
  private readonly lockWaitSeconds = 600;
  private readonly metadataLockWait = {
    seconds: 10,
    attempts: 3,
    pauseMs: 1_000,
  };

  constructor(options: StoreSchemaOptions) {
    checkSchemaOptions(options, MYSQL);
    this.packageName = options.packageName;
    this.storeName = options.storeName;
    this.command = options.command;
    this.defaultSchema = options.defaultSchema;
    this.migrations = Object.freeze([...options.migrations]);
    this.latest = latestVersion(this.migrations);
    this.createError = options.createError;
    if (options.mariadb !== undefined && typeof options.mariadb !== "boolean") {
      throw new TypeError(
        `${options.storeName}'s StoreSchema: \`mariadb\` must be a boolean, not ${JSON.stringify(options.mariadb)}.`,
      );
    }
    this.mariadb = options.mariadb ?? false;
    for (const migration of this.migrations) {
      this.migrationStatements(migration, this.defaultSchema);
    }
  }

  /**
   * The statements that bring the schema from version `from` to `to`, bookkeeping included.
   */
  statements(options: MigrationStatementsOptions = {}): string[] {
    const schema = options.schema ?? this.defaultSchema;
    checkSchema(schema, this.storeName);
    const { from, to } = migrationRange(this.storeName, this.latest, options);
    const statements: string[] = [];
    if (from === 0 && to > 0) {
      statements.push(...this.bookkeeping(schema));
    }
    for (const migration of migrationsBetween(this.migrations, from, to)) {
      statements.push(
        ...this.migrationStatements(migration, schema),
        `INSERT INTO ${this.table(schema, "migrations")} (version, name, applied_at) VALUES (${migration.version}, '${migration.name}', UNIX_TIMESTAMP() * 1000)`,
      );
    }
    return statements;
  }

  /**
   * `statements()` as one script, for teams that migrate with their own tool and run the store with `migrate: false`.
   */
  sql(options: MigrationSqlOptions = {}): string {
    const statements = this.statements(options);
    const { from, to } = migrationRange(this.storeName, this.latest, options);
    const schema = options.schema ?? this.defaultSchema;
    const header = [
      `-- ${this.packageName}: ${this.storeName}'s schema "${schema}" (tables ${schema}_*), from version ${from} to ${to}.`,
      "-- The statements don't run in one transaction: MySQL commits each DDL statement on its own. Apply them in order, each once.",
    ];
    return migrationScript(header, statements, options.statementBreakpoints);
  }

  /** The last version applied to `schema`: `0` when it has none. Checks the server first. */
  async version(db: AnySqlTransaction, schema: string): Promise<number> {
    await checkServer(db, this.storeName, { mariadb: this.mariadb });
    return this.readVersion(db, schema);
  }

  /**
   * Throws the package's error (`createError`) unless `schema` has every migration.
   */
  async assertMigrated(
    db: AnySqlTransaction,
    schema: string,
    hint?: string,
  ): Promise<void> {
    await checkServer(db, this.storeName, { mariadb: this.mariadb });
    await this.assertVersion(db, schema, hint);
  }

  /**
   * Applies the migrations `schema` hasn't had yet, one statement at a time, under `GET_LOCK()`.
   */
  async migrate(executor: AnySqlExecutor, schema: string): Promise<number[]> {
    checkSchema(schema, this.storeName);
    return executor.transaction(
      async (tx) => {
        const { database } = await checkServer(tx, this.storeName, {
          mariadb: this.mariadb,
        });
        const current = await this.readVersion(tx, schema);
        if (current >= this.latest) {
          return [];
        }
        const lock = `store-kit:migrate:${new Bun.CryptoHasher("sha256")
          .update(`${database}\u0000${this.packageName}:migrate:${schema}`)
          .digest("hex")
          .slice(0, 46)}`;
        const [taken] = await tx.query<{
          taken: string | null;
          holder: string | null;
        }>(
          "SELECT CAST(GET_LOCK(?, CAST(? AS SIGNED)) AS CHAR) AS taken, CAST(IS_USED_LOCK(?) AS CHAR) AS holder",
          [lock, String(this.lockWaitSeconds), lock],
        );
        if (taken?.taken !== "1") {
          throw this.createError(
            taken?.taken === "0"
              ? `${this.storeName}: migrating schema "${schema}" from version ${current} to ${this.latest} waited ${this.lockWaitSeconds} seconds for its migration lock, which MySQL connection ${taken.holder} holds: ` +
                  `another process is migrating the schema, or one's release of the lock was cut off (MySQL releases it when that connection closes; KILL ${taken.holder} closes it).`
              : `${this.storeName}: migrating schema "${schema}" from version ${current} to ${this.latest} failed: MySQL didn't grant its migration lock (GET_LOCK() returned ${taken?.taken ?? "NULL"}).`,
            { schema, version: current, requiredVersion: this.latest },
          );
        }
        try {
          await tx.query("COMMIT");
          const [session] = await tx.query<{ wait: string | null }>(
            "SELECT CAST(@@session.lock_wait_timeout AS CHAR) AS wait",
          );
          const previous = session?.wait;
          await tx.query(
            `SET SESSION lock_wait_timeout = ${wholeSeconds(this.metadataLockWait.seconds)}`,
          );
          try {
            return await this.applyPending(tx, schema);
          } finally {
            if (
              previous !== undefined &&
              previous !== null &&
              /^\d+$/.test(previous)
            ) {
              await tx
                .query(`SET SESSION lock_wait_timeout = ${previous}`)
                .catch(() => undefined);
            }
          }
        } finally {
          await tx.query("DO RELEASE_LOCK(?)", [lock]).catch(() => undefined);
        }
      },
      { isolationLevel: "read committed" },
    );
  }

  /**
   * The store's `executor`, `schema` and `migrate` options, checked and defaulted.
   */
  resolveOptions(options: StoreOptions): ResolvedStoreOptions {
    const resolved = resolveStoreOptions(this, MYSQL, options);
    if (!hasMethod(resolved.executor, "execute")) {
      throw new TypeError(
        `${this.storeName}: \`executor\` must be a SqlExecutor, such as ${MYSQL.executors}.`,
      );
    }
    return resolved as ResolvedStoreOptions;
  }

  /**
   * The store's readiness (see `MySqlStoreReadiness`).
   */
  readiness(options: StoreReadinessOptions): MySqlStoreReadiness {
    const { executor, schema } = options;
    let server: MySqlServer | undefined;
    const readiness = new Readiness(this.storeName, options, {
      check: async (db) => {
        ({ server } = await checkServer(db, this.storeName, {
          mariadb: this.mariadb,
        }));
      },
      assertMigrated: (db, hint) => this.assertVersion(db, schema, hint),
      migrate: () => this.migrate(executor, schema),
    });
    return Object.defineProperty(readiness, "server", {
      get: () => server,
      enumerable: true,
    }) as unknown as MySqlStoreReadiness;
  }

  private async assertVersion(
    db: AnySqlTransaction,
    schema: string,
    hint?: string,
  ): Promise<void> {
    const version = await this.readVersion(db, schema);
    if (version >= this.latest) {
      return;
    }
    throw this.createError(
      schemaBehindMessage(this, schema, version, this.latest, hint),
      { schema, version, requiredVersion: this.latest },
    );
  }

  private async readVersion(
    db: AnySqlTransaction,
    schema: string,
  ): Promise<number> {
    const [table] = await db.query<{ found: string }>(
      "SELECT CAST(COUNT(*) AS CHAR) AS found FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?",
      [`${schema}_migrations`],
    );
    if (table?.found !== "1") {
      return 0;
    }
    const [row] = await db.query<{ version: string }>(
      `SELECT CAST(COALESCE(MAX(version), 0) AS CHAR) AS version FROM ${this.table(schema, "migrations")} WHERE applied_at IS NOT NULL`,
    );
    return Number(row?.version ?? 0);
  }

  private async applyPending(
    tx: AnySqlTransaction,
    schema: string,
  ): Promise<number[]> {
    const version = await this.readVersion(tx, schema);
    if (version >= this.latest) {
      return [];
    }
    const migrations = this.table(schema, "migrations");
    const fail = (where: string, reached: number, cause: unknown, after = "") =>
      this.createError(
        `${this.storeName}: migrating schema "${schema}" from version ${version} to ${this.latest} ${where}: ${databaseMessage(cause)}${after}`,
        { schema, version: reached, requiredVersion: this.latest, cause },
      );

    const { attempts, pauseMs, seconds } = this.metadataLockWait;
    const ddl = async (statement: string): Promise<void> => {
      for (let attempt = 1; ; attempt++) {
        try {
          await tx.query(statement);
          return;
        } catch (error) {
          if (
            mysqlErrorCode(error) !== LOCK_WAIT_TIMEOUT ||
            attempt >= attempts
          ) {
            throw error;
          }
          await new Promise((resolve) =>
            setTimeout(resolve, pauseMs * attempt),
          );
        }
      }
    };

    const blocked = (error: unknown): string =>
      mysqlErrorCode(error) === LOCK_WAIT_TIMEOUT
        ? `. A transaction that has used the table holds it (MySQL's metadata lock), and the statement waited for it ${attempts} times, ${seconds} s each, then gave up, applying nothing: ` +
          "migrating again, once that transaction ends, resumes at it."
        : ". The statements before it are applied, and migrating again resumes at it.";

    for (const statement of this.bookkeeping(schema)) {
      await ddl(statement).catch((error) => {
        throw fail("failed creating the kit's tables", version, error);
      });
    }

    const applied: number[] = [];
    for (const migration of migrationsBetween(
      this.migrations,
      version,
      this.latest,
    )) {
      const statements = this.migrationStatements(migration, schema);
      const p = new SqlParams();
      await tx.query(
        `INSERT INTO ${migrations} (version, name) VALUES (${p.int(migration.version)}, ${p.text(migration.name)}) ON DUPLICATE KEY UPDATE version = version`,
        p.values,
      );
      const q = new SqlParams();
      const [progress] = await tx.query<{ started: string; applied: string }>(
        `SELECT CAST(started AS CHAR) AS started, CAST(applied AS CHAR) AS applied FROM ${migrations} WHERE version = ${q.int(migration.version)}`,
        q.values,
      );
      let uncertain =
        Number(progress?.started ?? 0) > Number(progress?.applied ?? 0);
      for (
        let index = Number(progress?.applied ?? 0);
        index < statements.length;
        index++
      ) {
        const position = `at migration ${migration.version} (${migration.name}), statement ${index + 1} of ${statements.length}`;
        if (!uncertain) {
          await this.record(tx, migrations, migration.version, {
            started: index + 1,
          });
        }
        try {
          await ddl(statements[index]!);
        } catch (error) {
          const code = mysqlErrorCode(error);
          if (!uncertain || code === undefined || !ALREADY_APPLIED.has(code)) {
            if (code !== undefined) {
              await this.record(tx, migrations, migration.version, {
                started: index,
              }).catch(() => undefined);
            }
            throw fail(
              `stopped ${position}`,
              migration.version - 1,
              error,
              blocked(error),
            );
          }
        }
        uncertain = false;
        await this.record(tx, migrations, migration.version, {
          started: index + 1,
          applied: index + 1,
        });
      }
      const done = new SqlParams();
      await tx.query(
        `UPDATE ${migrations} SET applied_at = UNIX_TIMESTAMP() * 1000 WHERE version = ${done.int(migration.version)}`,
        done.values,
      );
      applied.push(migration.version);
    }
    return applied;
  }

  private record(
    tx: AnySqlTransaction,
    migrations: string,
    version: number,
    progress: { started: number; applied?: number },
  ): Promise<unknown[]> {
    const p = new SqlParams();
    const set = [
      `started = ${p.int(progress.started)}`,
      ...(progress.applied === undefined
        ? []
        : [`applied = ${p.int(progress.applied)}`]),
    ];
    return tx.query(
      `UPDATE ${migrations} SET ${set.join(", ")} WHERE version = ${p.int(version)}`,
      p.values,
    );
  }

  private bookkeeping(schema: string): string[] {
    return [
      `CREATE TABLE IF NOT EXISTS ${this.table(schema, "migrations")} (
  version int NOT NULL PRIMARY KEY,
  name varchar(255) NOT NULL,
  applied_at bigint,
  started int NOT NULL DEFAULT 0,
  applied int NOT NULL DEFAULT 0
)`,
      `CREATE TABLE IF NOT EXISTS ${this.table(schema, "locks")} (
  id char(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY
)`,
    ];
  }

  private migrationStatements(
    migration: StoreMigration,
    schema: string,
  ): string[] {
    const statements = migration.up((table) =>
      quoteTable(schema, table, this.storeName),
    );
    if (!Array.isArray(statements)) {
      throw new TypeError(
        `${this.storeName}'s StoreSchema: migration ${migration.version} (${migration.name}) must return its statements, an array of strings.`,
      );
    }
    for (const statement of statements) {
      if (
        typeof statement !== "string" ||
        !DDL.test(statement.replace(/^(\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)*/, ""))
      ) {
        throw new TypeError(
          `${this.storeName}'s StoreSchema: migration ${migration.version} (${migration.name}) has a statement that isn't DDL: ${JSON.stringify(statement).slice(0, 80)}. ` +
            "A MySQL migration holds CREATE, ALTER and DROP statements, which MySQL commits one by one.",
        );
      }
    }
    return statements;
  }

  private table(schema: string, table: string): string {
    return tableName(schema, table, this.storeName);
  }
}

function wholeSeconds(seconds: number): number {
  if (!Number.isSafeInteger(seconds) || seconds < 1) {
    throw new TypeError(
      `A lock wait is a whole number of seconds from 1, not ${String(seconds)}.`,
    );
  }
  return seconds;
}
