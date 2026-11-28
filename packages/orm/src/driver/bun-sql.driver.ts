import { ContextStorage as AsyncLocalStorage } from "@bunest/core";
import { SQL, type TransactionSQL } from "bun";
import {
  emitOrmTransactionDiagnostic,
  hasOrmTransactionSubscribers,
} from "../diagnostics";
import { QueryFailedError } from "../errors";
import { normalizeDialect } from "../identifiers";
import {
  assertTransactionPropagation,
  completeTransactionHookCommit,
  completeTransactionHookRollback,
  createTransactionHookCollector,
  executeWithTransactionRetries,
  exitTransactionHookScope,
  isRetryableTransactionError,
  runInTransactionHookScope,
  validateIsolationLevel,
  validateTransactionPropagation,
} from "../transaction-hooks";
import type {
  OrmDialect,
  OrmIsolationLevel,
  OrmQueryExecutor,
  OrmQueryLogEvent,
  OrmQueryResult,
  OrmSslOption,
  OrmTransactionOptions,
} from "../types";
import {
  emitQueryTelemetry,
  shouldTrackQuery,
  type OrmDriver,
} from "./driver.interface";

export interface BunSqlOrmDriverOptions {
  readonly dialect?: OrmDialect;
  readonly url?: string | URL;
  readonly host?: string;
  readonly hostname?: string;
  readonly port?: number;
  readonly username?: string;
  readonly user?: string;
  readonly password?: string | (() => Promise<string> | string);
  readonly database?: string;
  readonly schema?: string;
  readonly ssl?: OrmSslOption;
  readonly tls?: OrmSslOption;
  readonly socketPath?: string;
  readonly path?: string;
  readonly poolSize?: number;
  readonly max?: number;
  readonly idleTimeout?: number;
  readonly connectionTimeout?: number;
  readonly connectTimeoutMS?: number;
  readonly maxLifetime?: number;
  readonly bigint?: boolean;
  readonly prepare?: boolean;
  readonly allowPublicKeyRetrieval?: boolean;
  readonly applicationName?: string;
  readonly connection?: Record<string, string | boolean | number>;
  readonly readonly?: boolean;
  readonly create?: boolean;
  readonly readwrite?: boolean;
  readonly safeIntegers?: boolean;
  readonly strict?: boolean;
  readonly enableWAL?: boolean;
  readonly enforceForeignKeys?: boolean;
  readonly onconnect?: (err: Error | null) => void;
  readonly onclose?: (err: Error | null) => void;
  readonly client?: SQL;
  readonly logging?: boolean | ((event: OrmQueryLogEvent) => void);
  readonly dataSourceName?: string;
}

/**
 * Maps TypeORM-style connection options into Bun's native `Bun.SQL` constructor
 * options (`postgres`, `cockroachdb`, `aurora-postgres`, `mysql`, `mariadb`,
 * `aurora-mysql`, and `sqlite`).
 */
export function buildBunSqlConfig(
  options: BunSqlOrmDriverOptions,
  dialect: OrmDialect,
): Bun.SQL.Options {
  if (dialect === "sqlite") {
    const filename =
      options.database ??
      (options.url !== undefined ? String(options.url) : ":memory:");
    const sqliteCfg: Bun.SQL.SQLiteOptions = {
      adapter: "sqlite",
      filename,
    };
    if (options.readonly !== undefined) sqliteCfg.readonly = options.readonly;
    if (options.create !== undefined) sqliteCfg.create = options.create;
    if (options.readwrite !== undefined) sqliteCfg.readwrite = options.readwrite;
    if (options.safeIntegers !== undefined) {
      sqliteCfg.safeIntegers = options.safeIntegers;
    }
    if (options.strict !== undefined) sqliteCfg.strict = options.strict;
    if (options.bigint !== undefined) sqliteCfg.bigint = options.bigint;
    if (options.onconnect) sqliteCfg.onconnect = options.onconnect;
    if (options.onclose) sqliteCfg.onclose = options.onclose;
    return sqliteCfg;
  }

  // PostgreSQL, CockroachDB (Postgres wire protocol), MySQL, MariaDB
  const adapter: "postgres" | "mysql" | "mariadb" =
    dialect === "mariadb" || dialect === "mysql" ? dialect : "postgres";

  const cfg: Bun.SQL.PostgresOrMySQLOptions = { adapter };

  if (options.url !== undefined) {
    // CockroachDB URLs use `cockroachdb://` which is Postgres wire compatible
    const urlStr = String(options.url);
    cfg.url = urlStr.startsWith("cockroachdb://")
      ? `postgres://${urlStr.slice("cockroachdb://".length)}`
      : options.url;
  }

  const host = options.hostname ?? options.host;
  if (host !== undefined) cfg.hostname = host;
  if (options.port !== undefined) cfg.port = options.port;
  const username = options.username ?? options.user;
  if (username !== undefined) cfg.username = username;
  if (options.password !== undefined) cfg.password = options.password;
  if (options.database !== undefined) cfg.database = options.database;

  const tlsOpt = options.tls ?? options.ssl;
  if (tlsOpt !== undefined) {
    cfg.tls = tlsOpt as Bun.SQL.PostgresOrMySQLOptions["tls"];
  }

  const sock = options.path ?? options.socketPath;
  if (sock !== undefined) cfg.path = sock;

  const poolMax = options.max ?? options.poolSize;
  if (poolMax !== undefined) cfg.max = poolMax;
  if (options.idleTimeout !== undefined) cfg.idleTimeout = options.idleTimeout;
  if (options.connectionTimeout !== undefined) {
    cfg.connectionTimeout = options.connectionTimeout;
  } else if (options.connectTimeoutMS !== undefined) {
    cfg.connectionTimeout = Math.ceil(options.connectTimeoutMS / 1000);
  }
  if (options.maxLifetime !== undefined) cfg.maxLifetime = options.maxLifetime;
  if (options.bigint !== undefined) cfg.bigint = options.bigint;
  if (options.prepare !== undefined && adapter === "postgres") {
    cfg.prepare = options.prepare;
  }
  if (options.onconnect) cfg.onconnect = options.onconnect;
  if (options.onclose) cfg.onclose = options.onclose;

  if (adapter === "postgres") {
    const connParams: Record<string, string | boolean | number> = {
      ...(options.connection ?? {}),
    };
    if (options.schema && !("search_path" in connParams)) {
      connParams.search_path = options.schema;
    }
    if (options.applicationName && !("application_name" in connParams)) {
      connParams.application_name = options.applicationName;
    }
    if (Object.keys(connParams).length > 0) {
      cfg.connection = connParams;
    }
  }

  return cfg;
}

function buildSetTransactionSql(
  isolationLevel: OrmIsolationLevel | undefined,
  readOnly: boolean | undefined,
): string | undefined {
  const parts: string[] = [];
  if (isolationLevel !== undefined) {
    parts.push(`ISOLATION LEVEL ${isolationLevel}`);
  }
  if (readOnly === true) {
    parts.push("READ ONLY");
  }
  if (parts.length === 0) {
    return undefined;
  }
  return `SET TRANSACTION ${parts.join(", ")}`;
}

/**
 * Multi-dialect native `Bun.SQL` driver powering:
 * - PostgreSQL (`postgres`, `postgresql`, `aurora-postgres`)
 * - CockroachDB (`cockroachdb`, over Postgres wire protocol)
 * - MySQL (`mysql`, `mysql2`, `aurora-mysql`)
 * - MariaDB (`mariadb`)
 * - SQLite (`sqlite`, when `useBunSql: true` or `sqlite://` URL)
 *
 * Uses Bun's built-in C/Zig `Bun.SQL` connection pool, TLS, prepared statements,
 * `AsyncLocalStorage`-propagated transactions & nested `SAVEPOINT`s, isolation levels,
 * propagation modes, retries, lifecycle hooks, and zero-overhead diagnostics channel emission.
 */
interface BunSqlTxContext {
  readonly tx: TransactionSQL;
  readonly readOnly: boolean;
}

export class BunSqlOrmDriver implements OrmDriver {
  readonly dialect: OrmDialect;
  readonly driverKind = "bun-sql";
  readonly supportsManagedTransactions = true;
  readonly dataSourceName?: string;

  private client?: SQL;
  private readonly options: BunSqlOrmDriverOptions;
  private readonly txStorage = new AsyncLocalStorage<BunSqlTxContext>();
  private readonly ownsClient: boolean;

  constructor(options: BunSqlOrmDriverOptions = {}) {
    this.options = options;
    this.dataSourceName = options.dataSourceName;
    this.ownsClient = options.client === undefined;
    this.dialect =
      options.dialect ?? this.inferDialectFromUrl(options.url) ?? "postgres";
  }

  private inferDialectFromUrl(url?: string | URL): OrmDialect | undefined {
    if (!url) return undefined;
    const raw = typeof url === "string" ? url : url.toString();
    if (raw.startsWith("cockroachdb://")) return "cockroachdb";
    if (raw.startsWith("postgres://") || raw.startsWith("postgresql://")) {
      return "postgres";
    }
    if (raw.startsWith("mysql://") || raw.startsWith("mysql2://")) {
      return "mysql";
    }
    if (raw.startsWith("mariadb://")) {
      return "mariadb";
    }
    if (
      raw.startsWith("sqlite://") ||
      raw.startsWith("file:") ||
      raw === ":memory:"
    ) {
      return "sqlite";
    }
    return undefined;
  }

  get isConnected(): boolean {
    return this.client !== undefined;
  }

  /**
   * Underlying native `Bun.SQL` client instance (available after `connect()`).
   */
  get raw(): SQL | undefined {
    return this.client;
  }

  /**
   * Exposes the normalized `Bun.SQL` configuration (useful for diagnostics and tests).
   */
  getResolvedBunSqlConfig(): Bun.SQL.Options {
    return buildBunSqlConfig(this.options, this.dialect);
  }

  async connect(): Promise<void> {
    if (this.client) return;
    if (this.options.client) {
      this.client = this.options.client;
    } else {
      const cfg = buildBunSqlConfig(this.options, this.dialect);
      this.client = new SQL(cfg);
    }

    const adapter = (this.client.options as { adapter?: string } | undefined)
      ?.adapter;
    if (adapter && !this.options.dialect) {
      (this as { dialect: OrmDialect }).dialect = normalizeDialect(adapter);
    }

    if (typeof this.client.connect === "function") {
      await this.client.connect();
    }

    if (this.dialect === "sqlite" && !this.options.readonly) {
      if (this.options.enforceForeignKeys !== false) {
        await this.client.unsafe("PRAGMA foreign_keys = ON;");
      }
      const dbFile = this.options.database ?? String(this.options.url ?? ":memory:");
      if (
        dbFile !== ":memory:" &&
        !dbFile.includes(":memory:") &&
        this.options.enableWAL !== false
      ) {
        await this.client.unsafe("PRAGMA journal_mode = WAL;");
      }
    }
  }

  async close(): Promise<void> {
    if (!this.client) return;
    if (this.ownsClient && typeof this.client.close === "function") {
      await this.client.close();
    }
    this.client = undefined;
  }

  async ping(): Promise<boolean> {
    if (!this.client) return false;
    const res = await this.query<{ ok: number }>("SELECT 1 AS ok");
    return Number(res.rows[0]?.ok) === 1;
  }

  isInTransaction(): boolean {
    return this.txStorage.getStore() !== undefined;
  }

  async setForeignKeysEnabled(enabled: boolean): Promise<void> {
    if (this.dialect === "sqlite") {
      await this.execute(
        enabled ? "PRAGMA foreign_keys = ON;" : "PRAGMA foreign_keys = OFF;",
      );
    }
  }

  private getRootClient(): SQL {
    if (!this.client) {
      throw new Error("BunSqlOrmDriver is not connected.");
    }
    return this.client;
  }

  private getActiveClient(): SQL {
    const active = this.txStorage.getStore()?.tx ?? this.client;
    if (!active) {
      throw new Error("BunSqlOrmDriver is not connected.");
    }
    return active as SQL;
  }

  private normalizeParams(params: readonly unknown[]): unknown[] {
    if (this.dialect === "sqlite") {
      return params.map((p) => {
        if (p === undefined) return null;
        if (typeof p === "boolean") return p ? 1 : 0;
        if (p instanceof Date) return p.toISOString();
        return p;
      });
    }
    return params.map((p) => (p === undefined ? null : p));
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<OrmQueryResult<T>> {
    const active = this.getActiveClient();
    const track = shouldTrackQuery(this.options.logging);
    const start = track ? performance.now() : 0;
    const bound = this.normalizeParams(params);
    let queryResult: OrmQueryResult<T>;
    let telemetryCount: number;
    try {
      const result =
        bound.length > 0
          ? await active.unsafe<T[]>(sql, bound)
          : await active.unsafe<T[]>(sql);
      const rows = Array.isArray(result) ? ([...result] as T[]) : [];
      let affectedRows = rows.length;
      if (typeof result.affectedRows === "number") {
        affectedRows = result.affectedRows;
      } else if (typeof result.count === "number") {
        affectedRows = result.count;
      }
      telemetryCount = rows.length > 0 ? rows.length : affectedRows;
      queryResult = {
        rows,
        affectedRows,
        lastInsertRowid: result.lastInsertRowid ?? null,
      };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (track) {
        emitQueryTelemetry(
          this.options.logging,
          this.dialect,
          sql,
          params,
          start,
          undefined,
          error,
          this.dataSourceName,
        );
      }
      throw new QueryFailedError(error.message, sql, params, error);
    }
    if (track) {
      emitQueryTelemetry(
        this.options.logging,
        this.dialect,
        sql,
        params,
        start,
        telemetryCount,
        undefined,
        this.dataSourceName,
      );
    }
    return queryResult;
  }

  async execute(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<OrmQueryResult> {
    return this.query(sql, params);
  }

  async transaction<T>(
    run: (executor: OrmQueryExecutor) => Promise<T> | T,
    options: OrmTransactionOptions = {},
  ): Promise<T> {
    const propagation = validateTransactionPropagation(
      options.propagation ?? "REQUIRED",
    );
    const isolationLevel =
      options.isolationLevel !== undefined
        ? validateIsolationLevel(options.isolationLevel)
        : undefined;
    const dataSource = options.dataSource ?? this.dataSourceName;
    const parentTx = this.txStorage.getStore();

    assertTransactionPropagation(propagation, parentTx !== undefined);

    if (propagation === "NEVER") {
      return await exitTransactionHookScope(() => run(this));
    }

    // Nested savepoint inside an active transaction:
    // - REQUIRED / MANDATORY always savepoint inside parentTx.
    // - REQUIRES_NEW on SQLite uses an isolated savepoint + independent hook scope
    //   (SQLite is single-writer, so opening a concurrent writer would deadlock).
    if (
      parentTx &&
      (propagation === "REQUIRED" ||
        propagation === "MANDATORY" ||
        (propagation === "REQUIRES_NEW" && this.dialect === "sqlite"))
    ) {
      const isRequiresNew = propagation === "REQUIRES_NEW";
      const runSavepoint = async (isFinalAttempt: boolean): Promise<T> => {
        const collector = createTransactionHookCollector(!isRequiresNew);
        const trackTx = hasOrmTransactionSubscribers();
        const start = trackTx ? performance.now() : 0;
        const setQueryOnly =
          this.dialect === "sqlite" &&
          options.readOnly === true &&
          !parentTx.readOnly;
        const nextReadOnly = parentTx.readOnly || options.readOnly === true;

        if (trackTx) {
          emitOrmTransactionDiagnostic({
            phase: "begin",
            ...(isolationLevel !== undefined ? { isolationLevel } : {}),
            propagation,
            ...(dataSource !== undefined ? { dataSource } : {}),
          });
        }

        let result!: T;
        try {
          result = (await parentTx.tx.savepoint(async (sp) => {
            if (setQueryOnly) {
              await sp.unsafe("PRAGMA query_only = ON;");
              try {
                return await this.txStorage.run(
                  { tx: sp, readOnly: nextReadOnly },
                  () => runInTransactionHookScope(collector, () => run(this)),
                );
              } finally {
                try {
                  await sp.unsafe("PRAGMA query_only = OFF;");
                } catch {
                  // Ignore secondary pragma reset error
                }
              }
            }
            return await this.txStorage.run(
              { tx: sp, readOnly: nextReadOnly },
              () => runInTransactionHookScope(collector, () => run(this)),
            );
          })) as T;
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          if (trackTx) {
            emitOrmTransactionDiagnostic({
              phase: "rollback",
              ...(isolationLevel !== undefined ? { isolationLevel } : {}),
              propagation,
              durationMs: performance.now() - start,
              error,
              ...(dataSource !== undefined ? { dataSource } : {}),
            });
          }
          const willRetry =
            isRequiresNew && !isFinalAttempt && isRetryableTransactionError(err);
          if (!willRetry) {
            await this.txStorage.exit(() =>
              completeTransactionHookRollback(collector),
            );
          }
          throw err;
        }

        if (trackTx) {
          emitOrmTransactionDiagnostic({
            phase: "commit",
            ...(isolationLevel !== undefined ? { isolationLevel } : {}),
            propagation,
            durationMs: performance.now() - start,
            ...(dataSource !== undefined ? { dataSource } : {}),
          });
        }
        if (isRequiresNew) {
          await this.txStorage.exit(() =>
            completeTransactionHookCommit(collector),
          );
        } else {
          await completeTransactionHookCommit(collector);
        }
        return result;
      };

      if (isRequiresNew && options.retries && options.retries > 0) {
        return await executeWithTransactionRetries(
          options.retries,
          options.retryDelayMs,
          (_attempt, isFinal) => runSavepoint(isFinal),
        );
      }
      return await runSavepoint(true);
    }

    // Top-level transaction OR pooled `REQUIRES_NEW` (suspending any outer ALS tx!)
    const root = this.getRootClient();

    return await executeWithTransactionRetries(
      options.retries,
      options.retryDelayMs,
      async (_attempt, isFinalAttempt) => {
        const collector = createTransactionHookCollector(false);
        const trackTx = hasOrmTransactionSubscribers();
        const start = trackTx ? performance.now() : 0;

        if (trackTx) {
          emitOrmTransactionDiagnostic({
            phase: "begin",
            ...(isolationLevel !== undefined ? { isolationLevel } : {}),
            propagation,
            ...(dataSource !== undefined ? { dataSource } : {}),
          });
        }

        let result!: T;
        try {
          const setTxSql = buildSetTransactionSql(
            isolationLevel,
            options.readOnly,
          );
          const isReadOnly = options.readOnly === true;

          if (this.dialect === "sqlite") {
            let sqliteMode: "DEFERRED" | "IMMEDIATE" | undefined;
            if (isReadOnly || isolationLevel === "READ UNCOMMITTED") {
              sqliteMode = "DEFERRED";
            } else if (isolationLevel === "SERIALIZABLE") {
              sqliteMode = "IMMEDIATE";
            }

            const body = async (tx: TransactionSQL) => {
              if (isReadOnly) {
                await tx.unsafe("PRAGMA query_only = ON;");
                try {
                  return await this.txStorage.run(
                    { tx, readOnly: true },
                    () => runInTransactionHookScope(collector, () => run(this)),
                  );
                } finally {
                  try {
                    await tx.unsafe("PRAGMA query_only = OFF;");
                  } catch {
                    // Ignore secondary pragma reset error
                  }
                }
              }
              return await this.txStorage.run({ tx, readOnly: false }, () =>
                runInTransactionHookScope(collector, () => run(this)),
              );
            };

            result = (
              sqliteMode !== undefined
                ? await root.begin(sqliteMode, body)
                : await root.begin(body)
            ) as T;
          } else if (
            (this.dialect === "mysql" || this.dialect === "mariadb") &&
            setTxSql &&
            typeof root.reserve === "function"
          ) {
            // MySQL/MariaDB require SET TRANSACTION before START TRANSACTION on the same connection
            const conn = await root.reserve();
            try {
              await conn.unsafe(setTxSql);
              result = (await conn.begin(async (tx) =>
                this.txStorage.run({ tx, readOnly: isReadOnly }, () =>
                  runInTransactionHookScope(collector, () => run(this)),
                ),
              )) as T;
            } finally {
              await conn.release();
            }
          } else {
            // PostgreSQL / CockroachDB (and fallback for minimal mock clients)
            result = (await root.begin(async (tx) => {
              if (setTxSql) {
                await tx.unsafe(setTxSql);
              }
              return await this.txStorage.run(
                { tx, readOnly: isReadOnly },
                () => runInTransactionHookScope(collector, () => run(this)),
              );
            })) as T;
          }
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          if (trackTx) {
            emitOrmTransactionDiagnostic({
              phase: "rollback",
              ...(isolationLevel !== undefined ? { isolationLevel } : {}),
              propagation,
              durationMs: performance.now() - start,
              error,
              ...(dataSource !== undefined ? { dataSource } : {}),
            });
          }
          const willRetry =
            !isFinalAttempt && isRetryableTransactionError(err);
          if (!willRetry) {
            await this.txStorage.exit(() =>
              completeTransactionHookRollback(collector),
            );
          }
          throw err;
        }

        if (trackTx) {
          emitOrmTransactionDiagnostic({
            phase: "commit",
            ...(isolationLevel !== undefined ? { isolationLevel } : {}),
            propagation,
            durationMs: performance.now() - start,
            ...(dataSource !== undefined ? { dataSource } : {}),
          });
        }
        await this.txStorage.exit(() =>
          completeTransactionHookCommit(collector),
        );
        return result;
      },
    );
  }
}
