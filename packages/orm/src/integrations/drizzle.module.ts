import {
  ContextStorage,
  DecoratorRegistry,
  Inject,
  Injectable,
  Module,
  ModuleRef,
  createMethodAspectDecorator,
  type DynamicModule,
  type InjectionToken,
  type MethodAspectContext,
  type MethodAspectHandler,
  type ModuleExport,
  type ModuleMetadata,
  type OnApplicationShutdown,
  type Provider,
  type Type,
} from "@bunest/core";
import {
  emitOrmTransactionDiagnostic,
  hasOrmTransactionSubscribers,
} from "../diagnostics";
import {
  DEFAULT_ORM_DATA_SOURCE,
  getOrmTransactionalAspectToken,
} from "../di/tokens";
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
  OrmIsolationLevel,
  OrmTransactionPropagation,
} from "../types";

export type DrizzleIsolationLevel =
  | "read uncommitted"
  | "read committed"
  | "repeatable read"
  | "serializable";

export interface DrizzleTransactionConfig {
  readonly isolationLevel?: DrizzleIsolationLevel;
  readonly accessMode?: "read only" | "read write";
  readonly deferrable?: boolean;
  readonly [key: string]: unknown;
}

/**
 * Pure structural interface matching any Drizzle ORM database / transaction
 * instance (`drizzle-orm/node-postgres`, `/postgres-js`, `/bun-sql`, `/bun-sqlite`,
 * `/mysql2`, `/libsql`, etc.) with ZERO external runtime dependencies (ADR-017).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface DrizzleDatabaseLike<TTx = any> {
  transaction<T>(
    transaction: (tx: TTx) => Promise<T>,
    config?: DrizzleTransactionConfig,
  ): Promise<T>;
}

export interface DrizzleTransactionOptions {
  readonly isolationLevel?: OrmIsolationLevel | DrizzleIsolationLevel;
  readonly propagation?: OrmTransactionPropagation;
  readonly readOnly?: boolean;
  readonly deferrable?: boolean;
  readonly retries?: number;
  readonly retryDelayMs?: number;
  readonly dataSource?: string;
}

export interface DrizzleTransactionalOptions extends DrizzleTransactionOptions {
  readonly token?: string | symbol;
}

export interface DrizzleModuleOptions<
  TDb extends DrizzleDatabaseLike = DrizzleDatabaseLike,
> {
  readonly db: TDb;
  readonly token?: string | symbol;
  /**
   * Registers the module globally so `@InjectDrizzle()` and `DrizzleTransactionHost`
   * are available in every module without re-importing.
   * @default true
   */
  readonly global?: boolean;
  /**
   * When `true`, also registers `DrizzleTransactionalAspect` under `@Transactional()`'s
   * default/named ORM aspect token so plain `@Transactional()` weaves Drizzle transactions
   * seamlessly via ADR-014 AOP!
   * @default false
   */
  readonly bindTransactional?: boolean;
  readonly onShutdown?: (db: TDb) => Promise<void> | void;
}

export interface DrizzleOptionsFactory<
  TDb extends DrizzleDatabaseLike = DrizzleDatabaseLike,
> {
  createDrizzleOptions():
    | Promise<DrizzleModuleOptions<TDb> | TDb>
    | DrizzleModuleOptions<TDb>
    | TDb;
}

export interface DrizzleModuleAsyncOptions<
  TDb extends DrizzleDatabaseLike = DrizzleDatabaseLike,
> extends Pick<ModuleMetadata, "imports"> {
  readonly token?: string | symbol;
  readonly global?: boolean;
  readonly bindTransactional?: boolean;
  readonly useFactory?: (
    ...args: never[]
  ) =>
    | Promise<DrizzleModuleOptions<TDb> | TDb>
    | DrizzleModuleOptions<TDb>
    | TDb;
  readonly inject?: InjectionToken[];
  readonly useClass?: Type<DrizzleOptionsFactory<TDb>>;
  readonly useExisting?: Type<DrizzleOptionsFactory<TDb>>;
}

export const DEFAULT_DRIZZLE_TOKEN = "default";
const DRIZZLE_DEFAULT_DB_SYMBOL = Symbol.for("bunest:orm:drizzle:db:default");
const DRIZZLE_SHUTDOWN_OPTIONS = Symbol.for("bunest:orm:drizzle:shutdown_opts");

function tokenKey(token?: string | symbol): string {
  if (token === undefined || token === DEFAULT_DRIZZLE_TOKEN) {
    return DEFAULT_DRIZZLE_TOKEN;
  }
  return typeof token === "symbol" ? (token.description ?? String(token)) : token;
}

/**
 * Resolves the DI injection token for a Drizzle database instance.
 */
export function getDrizzleToken(token?: string | symbol): InjectionToken {
  if (token === undefined || token === DEFAULT_DRIZZLE_TOKEN) {
    return DRIZZLE_DEFAULT_DB_SYMBOL;
  }
  if (typeof token === "symbol") {
    return token;
  }
  return `bunest:orm:drizzle:db:${token}`;
}

/**
 * Resolves the DI injection token for a `DrizzleTransactionHost`.
 */
export function getDrizzleTransactionHostToken(
  token?: string | symbol,
): InjectionToken {
  if (token === undefined || token === DEFAULT_DRIZZLE_TOKEN) {
    return DrizzleTransactionHost;
  }
  return `bunest:orm:drizzle:tx_host:${tokenKey(token)}`;
}

/**
 * Resolves the ADR-014 AOP method aspect token for `@DrizzleTransactional()`.
 */
export function getDrizzleTransactionalAspectToken(
  token?: string | symbol,
): string {
  return `bunest:orm:drizzle:tx_aspect:${tokenKey(token)}`;
}

/**
 * Injects the configured Drizzle database instance (`@InjectDrizzle()` or `@InjectDrizzle("analytics")`).
 */
export function InjectDrizzle(
  token?: string | symbol,
): ParameterDecorator & PropertyDecorator {
  return Inject(getDrizzleToken(token));
}

/**
 * Injects the `DrizzleTransactionHost` for the default or named Drizzle connection.
 */
export function InjectDrizzleTransactionHost(
  token?: string | symbol,
): ParameterDecorator & PropertyDecorator {
  return Inject(getDrizzleTransactionHostToken(token));
}

function toDrizzleTxConfig(
  isolationLevel: OrmIsolationLevel | undefined,
  readOnly: boolean | undefined,
  deferrable: boolean | undefined,
): DrizzleTransactionConfig | undefined {
  const cfg: Record<string, unknown> = {};
  if (isolationLevel !== undefined) {
    cfg.isolationLevel = isolationLevel.toLowerCase() as DrizzleIsolationLevel;
  }
  if (readOnly === true) {
    cfg.accessMode = "read only";
  }
  if (deferrable !== undefined) {
    cfg.deferrable = deferrable;
  }
  return Object.keys(cfg).length > 0
    ? (cfg as DrizzleTransactionConfig)
    : undefined;
}

/**
 * AsyncLocalStorage-backed ambient transaction host for Drizzle ORM.
 *
 * Call `host.getDb()` inside any repository or service to transparently receive
 * the active transaction client when inside `withTransaction()` / `@DrizzleTransactional()`,
 * or the root Drizzle `db` instance otherwise!
 */
export class DrizzleTransactionHost<
  TDb extends DrizzleDatabaseLike = DrizzleDatabaseLike,
> {
  private readonly txStorage = new ContextStorage<TDb>();
  private readonly label: string;

  constructor(
    readonly db: TDb,
    token?: string | symbol,
  ) {
    this.label = `drizzle:${tokenKey(token)}`;
  }

  /**
   * Returns the active ALS-bound Drizzle transaction client if inside a transaction,
   * otherwise returns the root Drizzle `db` instance.
   */
  getDb(): TDb {
    return this.txStorage.getStore() ?? this.db;
  }

  /**
   * Returns `true` when executing inside an active `withTransaction()` / `@DrizzleTransactional()` scope.
   */
  isInTransaction(): boolean {
    return this.txStorage.getStore() !== undefined;
  }

  /**
   * Executes `fn` inside an ALS-propagated Drizzle transaction with support for
   * nested savepoints (`REQUIRED`), independent transactions (`REQUIRES_NEW`),
   * `MANDATORY`/`NEVER`, isolation levels, retries, `onTransactionCommit` /
   * `onTransactionRollback`, and `"bunest:orm:transaction"` diagnostics events.
   */
  async withTransaction<T>(
    fn: (tx: TDb) => Promise<T> | T,
    options: DrizzleTransactionOptions = {},
  ): Promise<T> {
    const propagation = validateTransactionPropagation(
      options.propagation ?? "REQUIRED",
    );
    const isolationLevel =
      options.isolationLevel !== undefined
        ? validateIsolationLevel(
            options.isolationLevel.toUpperCase() as OrmIsolationLevel,
          )
        : undefined;
    const dataSource = options.dataSource ?? this.label;
    const parentTx = this.txStorage.getStore();

    assertTransactionPropagation(propagation, parentTx !== undefined);

    if (propagation === "NEVER") {
      return await exitTransactionHookScope(() =>
        this.txStorage.exit(() => fn(this.db)),
      );
    }

    // Nested transaction inside active Drizzle transaction (`REQUIRED` / `MANDATORY`)
    if (
      parentTx &&
      (propagation === "REQUIRED" || propagation === "MANDATORY")
    ) {
      const collector = createTransactionHookCollector(true);
      const trackTx = hasOrmTransactionSubscribers();
      const start = trackTx ? performance.now() : 0;

      if (trackTx) {
        emitOrmTransactionDiagnostic({
          phase: "begin",
          ...(isolationLevel !== undefined ? { isolationLevel } : {}),
          propagation,
          dataSource,
        });
      }

      let result!: T;
      try {
        if (typeof parentTx.transaction === "function") {
          result = await parentTx.transaction(async (nestedTx: TDb) =>
            this.txStorage.run(nestedTx, () =>
              runInTransactionHookScope(collector, () => fn(nestedTx)),
            ),
          );
        } else {
          result = await this.txStorage.run(parentTx, () =>
            runInTransactionHookScope(collector, () => fn(parentTx)),
          );
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
            dataSource,
          });
        }
        await this.txStorage.exit(() =>
          completeTransactionHookRollback(collector),
        );
        throw err;
      }

      if (trackTx) {
        emitOrmTransactionDiagnostic({
          phase: "commit",
          ...(isolationLevel !== undefined ? { isolationLevel } : {}),
          propagation,
          durationMs: performance.now() - start,
          dataSource,
        });
      }
      await completeTransactionHookCommit(collector);
      return result;
    }

    // Top-level OR `REQUIRES_NEW` independent transaction on root `this.db`
    const drizzleConfig = toDrizzleTxConfig(
      isolationLevel,
      options.readOnly,
      options.deferrable,
    );

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
            dataSource,
          });
        }

        let result!: T;
        try {
          result = await this.db.transaction(
            async (tx: TDb) =>
              this.txStorage.run(tx, () =>
                runInTransactionHookScope(collector, () => fn(tx)),
              ),
            drizzleConfig,
          );
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          if (trackTx) {
            emitOrmTransactionDiagnostic({
              phase: "rollback",
              ...(isolationLevel !== undefined ? { isolationLevel } : {}),
              propagation,
              durationMs: performance.now() - start,
              error,
              dataSource,
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
            dataSource,
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

/**
 * ADR-014 AOP Method Aspect Handler executing `@DrizzleTransactional()` (and optionally
 * `@Transactional()`) methods inside `DrizzleTransactionHost.withTransaction()`.
 */
@Injectable()
export class DrizzleTransactionalAspect
  implements MethodAspectHandler<DrizzleTransactionalOptions>
{
  constructor(private readonly host: DrizzleTransactionHost) {}

  intercept(ctx: MethodAspectContext<DrizzleTransactionalOptions>): unknown {
    return this.host.withTransaction(() => ctx.proceed(), ctx.options);
  }
}

DecoratorRegistry.markInternal(DrizzleTransactionalAspect);

/**
 * Declarative `@DrizzleTransactional()` method/class decorator powered by Bunest's
 * zero-overhead Method Aspect Weaver (ADR-014) and `DrizzleTransactionHost`.
 */
export function DrizzleTransactional(
  options: DrizzleTransactionalOptions = {},
): ClassDecorator & MethodDecorator {
  return createMethodAspectDecorator<DrizzleTransactionalOptions>(
    getDrizzleTransactionalAspectToken(options.token),
    options,
  );
}

interface DrizzleShutdownRecord {
  readonly token?: string | symbol;
  readonly onShutdown?: (db: DrizzleDatabaseLike) => Promise<void> | void;
}

function isDrizzleOptionsEnvelope<TDb extends DrizzleDatabaseLike>(
  val: DrizzleModuleOptions<TDb> | TDb,
): val is DrizzleModuleOptions<TDb> {
  return (
    typeof val === "object" &&
    val !== null &&
    "db" in val &&
    typeof (val as { db?: unknown }).db === "object" &&
    (val as { db?: unknown }).db !== null
  );
}

/**
 * First-class zero-dependency Bunest DI & ALS transaction module for Drizzle ORM.
 */
@Module({})
export class DrizzleModule implements OnApplicationShutdown {
  constructor(
    @Inject(DRIZZLE_SHUTDOWN_OPTIONS)
    private readonly shutdownRecord: DrizzleShutdownRecord,
    private readonly moduleRef: ModuleRef,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    if (!this.shutdownRecord?.onShutdown) {
      return;
    }
    const db = this.moduleRef.get<DrizzleDatabaseLike>(
      getDrizzleToken(this.shutdownRecord.token),
    );
    if (db) {
      await this.shutdownRecord.onShutdown(db);
    }
  }

  static forRoot<TDb extends DrizzleDatabaseLike>(
    options: DrizzleModuleOptions<TDb>,
  ): DynamicModule {
    const dbToken = getDrizzleToken(options.token);
    const hostToken = getDrizzleTransactionHostToken(options.token);
    const aspectToken = getDrizzleTransactionalAspectToken(options.token);

    const dbProvider: Provider = {
      provide: dbToken,
      useValue: options.db,
    };

    const hostProvider: Provider = {
      provide: hostToken,
      useFactory: (db: TDb) => new DrizzleTransactionHost<TDb>(db, options.token),
      inject: [dbToken],
    };

    const aspectProvider: Provider = {
      provide: aspectToken,
      useFactory: (host: DrizzleTransactionHost<TDb>) =>
        new DrizzleTransactionalAspect(host),
      inject: [hostToken],
    };

    const providers: Provider[] = [
      {
        provide: DRIZZLE_SHUTDOWN_OPTIONS,
        useValue: {
          token: options.token,
          onShutdown: options.onShutdown as
            | ((db: DrizzleDatabaseLike) => Promise<void> | void)
            | undefined,
        } satisfies DrizzleShutdownRecord,
      },
      dbProvider,
      hostProvider,
      aspectProvider,
    ];
    const exportsList: ModuleExport[] = [dbProvider, hostProvider, aspectProvider];

    if (options.bindTransactional) {
      const dsName =
        typeof options.token === "string"
          ? options.token
          : DEFAULT_ORM_DATA_SOURCE;
      const ormAspectToken = getOrmTransactionalAspectToken(dsName);
      providers.push({
        provide: ormAspectToken,
        useExisting: aspectToken,
      });
      exportsList.push(ormAspectToken);
    }

    return {
      module: DrizzleModule,
      global: options.global ?? true,
      providers,
      exports: exportsList,
    };
  }

  static forRootAsync<TDb extends DrizzleDatabaseLike>(
    options: DrizzleModuleAsyncOptions<TDb>,
  ): DynamicModule {
    const dbToken = getDrizzleToken(options.token);
    const hostToken = getDrizzleTransactionHostToken(options.token);
    const aspectToken = getDrizzleTransactionalAspectToken(options.token);
    const rawOptionsToken = Symbol("bunest:orm:drizzle:async_options");

    const asyncProviders: Provider[] = [];
    if (options.useFactory) {
      asyncProviders.push({
        provide: rawOptionsToken,
        useFactory: async (...args: unknown[]) => {
          const resolved = await (
            options.useFactory as (
              ...a: unknown[]
            ) =>
              | Promise<DrizzleModuleOptions<TDb> | TDb>
              | DrizzleModuleOptions<TDb>
              | TDb
          )(...args);
          return isDrizzleOptionsEnvelope(resolved)
            ? resolved
            : ({ db: resolved } satisfies DrizzleModuleOptions<TDb>);
        },
        inject: options.inject ?? [],
      });
    } else if (options.useClass) {
      asyncProviders.push(
        { provide: options.useClass, useClass: options.useClass },
        {
          provide: rawOptionsToken,
          useFactory: async (factory: DrizzleOptionsFactory<TDb>) => {
            const resolved = await factory.createDrizzleOptions();
            return isDrizzleOptionsEnvelope(resolved)
              ? resolved
              : ({ db: resolved } satisfies DrizzleModuleOptions<TDb>);
          },
          inject: [options.useClass],
        },
      );
    } else if (options.useExisting) {
      asyncProviders.push({
        provide: rawOptionsToken,
        useFactory: async (factory: DrizzleOptionsFactory<TDb>) => {
          const resolved = await factory.createDrizzleOptions();
          return isDrizzleOptionsEnvelope(resolved)
            ? resolved
            : ({ db: resolved } satisfies DrizzleModuleOptions<TDb>);
        },
        inject: [options.useExisting],
      });
    } else {
      throw new Error(
        'DrizzleModule.forRootAsync() requires one of "useFactory", "useClass", or "useExisting".',
      );
    }

    const dbProvider: Provider = {
      provide: dbToken,
      useFactory: (resolved: DrizzleModuleOptions<TDb>) => resolved.db,
      inject: [rawOptionsToken],
    };

    const hostProvider: Provider = {
      provide: hostToken,
      useFactory: (db: TDb) => new DrizzleTransactionHost<TDb>(db, options.token),
      inject: [dbToken],
    };

    const aspectProvider: Provider = {
      provide: aspectToken,
      useFactory: (host: DrizzleTransactionHost<TDb>) =>
        new DrizzleTransactionalAspect(host),
      inject: [hostToken],
    };

    const providers: Provider[] = [
      ...asyncProviders,
      {
        provide: DRIZZLE_SHUTDOWN_OPTIONS,
        useFactory: (resolved: DrizzleModuleOptions<TDb>): DrizzleShutdownRecord => ({
          token: options.token,
          onShutdown: resolved.onShutdown as
            | ((db: DrizzleDatabaseLike) => Promise<void> | void)
            | undefined,
        }),
        inject: [rawOptionsToken],
      },
      dbProvider,
      hostProvider,
      aspectProvider,
    ];
    const exportsList: ModuleExport[] = [dbProvider, hostProvider, aspectProvider];

    if (options.bindTransactional) {
      const dsName =
        typeof options.token === "string"
          ? options.token
          : DEFAULT_ORM_DATA_SOURCE;
      const ormAspectToken = getOrmTransactionalAspectToken(dsName);
      providers.push({
        provide: ormAspectToken,
        useExisting: aspectToken,
      });
      exportsList.push(ormAspectToken);
    }

    return {
      module: DrizzleModule,
      global: options.global ?? true,
      imports: options.imports ?? [],
      providers,
      exports: exportsList,
    };
  }
}
