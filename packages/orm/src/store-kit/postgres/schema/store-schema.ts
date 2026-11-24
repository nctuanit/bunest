import type {
  MigrationSqlOptions,
  MigrationStatementsOptions,
} from "../../interfaces/migration-sql-options.interface";
import type {
  SqlExecutor,
  SqlTransaction,
} from "../../interfaces/sql-executor.interface";
import type { StoreMigration } from "../../interfaces/store-migration.interface";
import type {
  ResolvedStoreOptions,
  StoreOptions,
} from "../../interfaces/store-options.interface";
import type {
  StoreReadiness,
  StoreReadinessOptions,
} from "../../interfaces/store-readiness.interface";
import type {
  StoreSchemaErrorDetails,
  StoreSchemaOptions,
} from "../../interfaces/store-schema-options.interface";
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
import { assertReadCommittedDefault } from "../isolation/read-committed";
import { advisoryLock } from "../sql/advisory-lock";
import { quoteSchema } from "../sql/quote-schema";
import { POSTGRES } from "./postgres-dialect";

/**
 * A store's PostgreSQL schema: its versioned migrations, and all a store does with them.
 */
export class StoreSchema {
  /** The database it's for: `runStoreCli()` picks a package's schema by the URL's dialect. */
  readonly dialect = "postgres" as const;
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

  constructor(options: StoreSchemaOptions) {
    checkSchemaOptions(options, POSTGRES);
    this.packageName = options.packageName;
    this.storeName = options.storeName;
    this.command = options.command;
    this.defaultSchema = options.defaultSchema;
    this.migrations = Object.freeze([...options.migrations]);
    this.latest = latestVersion(this.migrations);
    this.createError = options.createError;
  }

  /**
   * The statements that bring the schema from version `from` (default `0`, a new database) to `to`
   * (default: the latest), bookkeeping included.
   */
  statements(options: MigrationStatementsOptions = {}): string[] {
    const s = quoteSchema(options.schema ?? this.defaultSchema, this.storeName);
    const { from, to } = migrationRange(this.storeName, this.latest, options);
    const statements: string[] = [];
    if (from === 0 && to > 0) {
      statements.push(
        createSchemaStatement(s),
        `CREATE TABLE IF NOT EXISTS ${s}.migrations (
  version integer PRIMARY KEY,
  name text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
)`,
      );
    }
    for (const migration of migrationsBetween(this.migrations, from, to)) {
      statements.push(
        ...migration.up(s),
        `INSERT INTO ${s}.migrations (version, name) VALUES (${migration.version}, '${migration.name}')`,
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
    const header = [
      `-- ${this.packageName}: ${this.storeName}'s schema "${options.schema ?? this.defaultSchema}", from version ${from} to ${to}.`,
      "-- Run it in one transaction.",
    ];
    return migrationScript(header, statements, options.statementBreakpoints);
  }

  /** The last version applied to `schema`: `0` when it has none, or doesn't exist. */
  async version(db: SqlTransaction, schema: string): Promise<number> {
    const [table] = await db.query<{ exists: string }>(
      `SELECT EXISTS (
  SELECT FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = $1::text AND c.relname = 'migrations' AND c.relkind = 'r'
)::text AS exists`,
      [schema],
    );
    if (table?.exists !== "true") {
      return 0;
    }
    const [row] = await db.query<{ version: string }>(
      `SELECT coalesce(max(version), 0)::text AS version FROM ${quoteSchema(schema, this.storeName)}.migrations`,
    );
    return Number(row?.version ?? 0);
  }

  /**
   * Throws the package's error (`createError`) unless `schema` has every migration.
   */
  async assertMigrated(
    db: SqlTransaction,
    schema: string,
    hint?: string,
  ): Promise<void> {
    const version = await this.version(db, schema);
    if (version >= this.latest) {
      return;
    }
    throw this.createError(
      schemaBehindMessage(this, schema, version, this.latest, hint),
      { schema, version, requiredVersion: this.latest },
    );
  }

  /**
   * Applies the migrations `schema` hasn't had yet, in one READ COMMITTED transaction under an advisory lock.
   */
  async migrate(executor: SqlExecutor, schema: string): Promise<number[]> {
    const s = quoteSchema(schema, this.storeName);
    return executor.transaction(
      async (tx) => {
        await advisoryLock(tx, `${this.packageName}:migrate:${schema}`);
        const version = await this.version(tx, schema);
        if (version >= this.latest) {
          return [];
        }
        const skip = (await schemaExists(tx, schema))
          ? createSchemaStatement(s)
          : undefined;
        for (const statement of this.statements({ schema, from: version })) {
          if (statement !== skip) {
            try {
              await tx.query(statement);
            } catch (error) {
              throw this.createError(
                `${this.storeName}: migrating schema "${schema}" from version ${version} to ${this.latest} failed, and nothing was applied: ${databaseMessage(error)}`,
                {
                  schema,
                  version,
                  requiredVersion: this.latest,
                  cause: error,
                },
              );
            }
          }
        }
        return migrationsBetween(this.migrations, version, this.latest).map(
          (migration) => migration.version,
        );
      },
      { isolationLevel: "read committed" },
    );
  }

  /**
   * The store's `executor`, `schema` and `migrate` options, checked and defaulted.
   */
  resolveOptions(options: StoreOptions): ResolvedStoreOptions<"postgres"> {
    return resolveStoreOptions(this, POSTGRES, options);
  }

  /**
   * The store's readiness (see `StoreReadiness`).
   */
  readiness(options: StoreReadinessOptions): StoreReadiness {
    const { executor, schema } = options;
    return new Readiness(this.storeName, options, {
      check: (db) => assertReadCommittedDefault(db, this.storeName),
      assertMigrated: (db, hint) => this.assertMigrated(db, schema, hint),
      migrate: () => this.migrate(executor, schema),
    });
  }
}

function createSchemaStatement(s: string): string {
  return `CREATE SCHEMA IF NOT EXISTS ${s}`;
}

async function schemaExists(
  tx: SqlTransaction,
  schema: string,
): Promise<boolean> {
  const [row] = await tx.query<{ exists: string }>(
    "SELECT EXISTS (SELECT FROM pg_catalog.pg_namespace WHERE nspname = $1::text)::text AS exists",
    [schema],
  );
  return row?.exists === "true";
}
