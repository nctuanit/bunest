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
  type OnModuleInit,
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

export type PrismaIsolationLevel =
  | "ReadUncommitted"
  | "ReadCommitted"
  | "RepeatableRead"
  | "Serializable";

export interface PrismaInteractiveTransactionOptions {
  readonly maxWait?: number;
  readonly timeout?: number;
  readonly isolationLevel?: PrismaIsolationLevel;
}

/**
 * Pure structural interface matching any generated `PrismaClient` instance
 * with ZERO external runtime dependencies (ADR-017).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface PrismaClientLike<TTx = any> {
  $transaction<T>(
    fn: (tx: TTx) => Promise<T>,
    options?: PrismaInteractiveTransactionOptions,
  ): Promise<T>;
  $connect?: () => Promise<void>;
  $disconnect?: () => Promise<void>;
}

export interface PrismaTransactionOptions {
  readonly isolationLevel?: OrmIsolationLevel | PrismaIsolationLevel;
  readonly propagation?: OrmTransactionPropagation;
  readonly maxWait?: number;
  readonly timeout?: number;
  readonly retries?: number;
  readonly retryDelayMs?: number;
  readonly dataSource?: string;
}

export interface PrismaTransactionalOptions extends PrismaTransactionOptions {
  readonly token?: string | symbol;
}

export interface PrismaModuleOptions<
  TClient extends PrismaClientLike = PrismaClientLike,
> {
  readonly client: TClient;
  readonly token?: string | symbol;
  /**
   * Registers the module globally so `@InjectPrisma()` and `PrismaTransactionHost`
   * are available across all modules without re-importing.
   * @default true
   */
  readonly global?: boolean;
  /**
   * Calls `await client.$connect()` during module initialization when available.
   * @default false
   */
  readonly autoConnect?: boolean;
  /**
   * Calls `await client.$disconnect()` during application shutdown when available.
   * @default true
   */
  readonly autoDisconnect?: boolean;
  /**
   * When `true`, also registers `PrismaTransactionalAspect` under `@Transactional()`'s
   * default/named ORM aspect token so plain `@Transactional()` weaves Prisma transactions
   * seamlessly via ADR-014 AOP!
   * @default false
   */
  readonly bindTransactional?: boolean;
}

export interface PrismaOptionsFactory<
  TClient extends PrismaClientLike = PrismaClientLike,
> {
  createPrismaOptions():
    | Promise<PrismaModuleOptions<TClient> | TClient>
    | PrismaModuleOptions<TClient>
    | TClient;
}

export interface PrismaModuleAsyncOptions<
  TClient extends PrismaClientLike = PrismaClientLike,
> extends Pick<ModuleMetadata, "imports"> {
  readonly token?: string | symbol;
  readonly global?: boolean;
  readonly autoConnect?: boolean;
  readonly autoDisconnect?: boolean;
  readonly bindTransactional?: boolean;
  readonly useFactory?: (
    ...args: never[]
  ) =>
    | Promise<PrismaModuleOptions<TClient> | TClient>
    | PrismaModuleOptions<TClient>
    | TClient;
  readonly inject?: InjectionToken[];
  readonly useClass?: Type<PrismaOptionsFactory<TClient>>;
  readonly useExisting?: Type<PrismaOptionsFactory<TClient>>;
}

export const DEFAULT_PRISMA_TOKEN = "default";
const PRISMA_DEFAULT_CLIENT_SYMBOL = Symbol.for(
  "bunest:orm:prisma:client:default",
);
const PRISMA_LIFECYCLE_OPTIONS = Symbol.for("bunest:orm:prisma:lifecycle_opts");

function tokenKey(token?: string | symbol): string {
  if (token === undefined || token === DEFAULT_PRISMA_TOKEN) {
    return DEFAULT_PRISMA_TOKEN;
  }
  return typeof token === "symbol" ? (token.description ?? String(token)) : token;
}

/**
 * Resolves the DI injection token for a PrismaClient instance.
 */
export function getPrismaToken(token?: string | symbol): InjectionToken {
  if (token === undefined || token === DEFAULT_PRISMA_TOKEN) {
    return PRISMA_DEFAULT_CLIENT_SYMBOL;
  }
  if (typeof token === "symbol") {
    return token;
  }
  return `bunest:orm:prisma:client:${token}`;
}

/**
 * Resolves the DI injection token for a `PrismaTransactionHost`.
 */
export function getPrismaTransactionHostToken(
  token?: string | symbol,
): InjectionToken {
  if (token === undefined || token === DEFAULT_PRISMA_TOKEN) {
    return PrismaTransactionHost;
  }
  return `bunest:orm:prisma:tx_host:${tokenKey(token)}`;
}

/**
 * Resolves the ADR-014 AOP method aspect token for `@PrismaTransactional()`.
 */
export function getPrismaTransactionalAspectToken(
  token?: string | symbol,
): string {
  return `bunest:orm:prisma:tx_aspect:${tokenKey(token)}`;
}

/**
 * Injects the configured PrismaClient (`@InjectPrisma()` or `@InjectPrisma("replica")`).
 */
export function InjectPrisma(
  token?: string | symbol,
): ParameterDecorator & PropertyDecorator {
  return Inject(getPrismaToken(token));
}

/**
 * Injects the `PrismaTransactionHost` for the default or named Prisma client.
 */
export function InjectPrismaTransactionHost(
  token?: string | symbol,
): ParameterDecorator & PropertyDecorator {
  return Inject(getPrismaTransactionHostToken(token));
}

const ORM_TO_PRISMA_ISOLATION: Record<OrmIsolationLevel, PrismaIsolationLevel> = {
  "READ UNCOMMITTED": "ReadUncommitted",
  "READ COMMITTED": "ReadCommitted",
  "REPEATABLE READ": "RepeatableRead",
  SERIALIZABLE: "Serializable",
};

const PRISMA_TO_ORM_ISOLATION: Record<PrismaIsolationLevel, OrmIsolationLevel> = {
  ReadUncommitted: "READ UNCOMMITTED",
  ReadCommitted: "READ COMMITTED",
  RepeatableRead: "REPEATABLE READ",
  Serializable: "SERIALIZABLE",
};

function normalizePrismaIsolation(
  raw: OrmIsolationLevel | PrismaIsolationLevel | undefined,
): { orm?: OrmIsolationLevel; prisma?: PrismaIsolationLevel } {
  if (raw === undefined) {
    return {};
  }
  if (raw in PRISMA_TO_ORM_ISOLATION) {
    const prisma = raw as PrismaIsolationLevel;
    return { orm: PRISMA_TO_ORM_ISOLATION[prisma], prisma };
  }
  const orm = validateIsolationLevel(raw as OrmIsolationLevel);
  return { orm, prisma: ORM_TO_PRISMA_ISOLATION[orm] };
}

/**
 * AsyncLocalStorage-backed interactive `$transaction` propagation host for Prisma.
 *
 * Services call `host.getClient()` to transparently use the active interactive
 * transaction client inside `withTransaction()` / `@PrismaTransactional()`, or
 * the root `PrismaClient` outside transactions — avoiding manual `tx` plumbing!
 */
export class PrismaTransactionHost<
  TClient extends PrismaClientLike = PrismaClientLike,
  TTx = TClient extends PrismaClientLike<infer T> ? T : TClient,
> {
  private readonly txStorage = new ContextStorage<TTx>();
  private readonly label: string;

  constructor(
    readonly client: TClient,
    token?: string | symbol,
  ) {
    this.label = `prisma:${tokenKey(token)}`;
  }

  /**
   * Returns the active ALS-bound interactive transaction client if inside a
   * transaction, or the root `PrismaClient` otherwise.
   */
  getClient(): TClient | TTx {
    return this.txStorage.getStore() ?? this.client;
  }

  /**
   * Returns the active ALS-bound transaction client, or `undefined` outside a transaction.
   */
  getTx(): TTx | undefined {
    return this.txStorage.getStore();
  }

  /**
   * Returns `true` when executing inside an active `withTransaction()` / `@PrismaTransactional()` scope.
   */
  isInTransaction(): boolean {
    return this.txStorage.getStore() !== undefined;
  }

  /**
   * Executes `fn` inside an ALS-propagated Prisma interactive `$transaction`,
   * supporting nested participation (`REQUIRED` / `MANDATORY`), independent
   * transactions (`REQUIRES_NEW`), `NEVER`, isolation level mapping, `maxWait`/
   * `timeout`, automatic retries, `onTransactionCommit` / `onTransactionRollback`,
   * and `"bunest:orm:transaction"` diagnostics events.
   */
  async withTransaction<T>(
    fn: (tx: TTx) => Promise<T> | T,
    options: PrismaTransactionOptions = {},
  ): Promise<T> {
    const propagation = validateTransactionPropagation(
      options.propagation ?? "REQUIRED",
    );
    const { orm: ormIsolation, prisma: prismaIsolation } =
      normalizePrismaIsolation(options.isolationLevel);
    const dataSource = options.dataSource ?? this.label;
    const parentTx = this.txStorage.getStore();

    assertTransactionPropagation(propagation, parentTx !== undefined);

    if (propagation === "NEVER") {
      return await exitTransactionHookScope(() =>
        this.txStorage.exit(() => fn(this.client as unknown as TTx)),
      );
    }

    // Nested interactive transaction participation (`REQUIRED` / `MANDATORY`):
    // Prisma's interactive `tx` does not expose nested `$transaction`, so reuse `parentTx`
    // while scoping lifecycle hooks so commit hooks fire only after the outermost commit.
    if (
      parentTx !== undefined &&
      (propagation === "REQUIRED" || propagation === "MANDATORY")
    ) {
      const collector = createTransactionHookCollector(true);
      const trackTx = hasOrmTransactionSubscribers();
      const start = trackTx ? performance.now() : 0;

      if (trackTx) {
        emitOrmTransactionDiagnostic({
          phase: "begin",
          ...(ormIsolation !== undefined ? { isolationLevel: ormIsolation } : {}),
          propagation,
          dataSource,
        });
      }

      let result!: T;
      try {
        result = await this.txStorage.run(parentTx, () =>
          runInTransactionHookScope(collector, () => fn(parentTx)),
        );
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (trackTx) {
          emitOrmTransactionDiagnostic({
            phase: "rollback",
            ...(ormIsolation !== undefined
              ? { isolationLevel: ormIsolation }
              : {}),
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
          ...(ormIsolation !== undefined ? { isolationLevel: ormIsolation } : {}),
          propagation,
          durationMs: performance.now() - start,
          dataSource,
        });
      }
      await completeTransactionHookCommit(collector);
      return result;
    }

    // Top-level OR `REQUIRES_NEW` independent interactive `$transaction` on root `this.client`
    const prismaOpts: PrismaInteractiveTransactionOptions | undefined =
      prismaIsolation !== undefined ||
      options.maxWait !== undefined ||
      options.timeout !== undefined
        ? {
            ...(prismaIsolation !== undefined
              ? { isolationLevel: prismaIsolation }
              : {}),
            ...(options.maxWait !== undefined ? { maxWait: options.maxWait } : {}),
            ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
          }
        : undefined;

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
            ...(ormIsolation !== undefined
              ? { isolationLevel: ormIsolation }
              : {}),
            propagation,
            dataSource,
          });
        }

        let result!: T;
        try {
          result = await this.client.$transaction(
            async (tx: TTx) =>
              this.txStorage.run(tx, () =>
                runInTransactionHookScope(collector, () => fn(tx)),
              ),
            prismaOpts,
          );
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          if (trackTx) {
            emitOrmTransactionDiagnostic({
              phase: "rollback",
              ...(ormIsolation !== undefined
                ? { isolationLevel: ormIsolation }
                : {}),
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
            ...(ormIsolation !== undefined
              ? { isolationLevel: ormIsolation }
              : {}),
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
 * ADR-014 AOP Method Aspect Handler executing `@PrismaTransactional()` (and optionally
 * `@Transactional()`) methods inside `PrismaTransactionHost.withTransaction()`.
 */
@Injectable()
export class PrismaTransactionalAspect
  implements MethodAspectHandler<PrismaTransactionalOptions>
{
  constructor(private readonly host: PrismaTransactionHost) {}

  intercept(ctx: MethodAspectContext<PrismaTransactionalOptions>): unknown {
    return this.host.withTransaction(() => ctx.proceed(), ctx.options);
  }
}

DecoratorRegistry.markInternal(PrismaTransactionalAspect);

/**
 * Declarative `@PrismaTransactional()` method/class decorator powered by Bunest's
 * zero-overhead Method Aspect Weaver (ADR-014) and `PrismaTransactionHost`.
 */
export function PrismaTransactional(
  options: PrismaTransactionalOptions = {},
): ClassDecorator & MethodDecorator {
  return createMethodAspectDecorator<PrismaTransactionalOptions>(
    getPrismaTransactionalAspectToken(options.token),
    options,
  );
}

interface PrismaLifecycleRecord {
  readonly token?: string | symbol;
  readonly autoConnect: boolean;
  readonly autoDisconnect: boolean;
}

function isPrismaOptionsEnvelope<TClient extends PrismaClientLike>(
  val: PrismaModuleOptions<TClient> | TClient,
): val is PrismaModuleOptions<TClient> {
  return (
    typeof val === "object" &&
    val !== null &&
    "client" in val &&
    typeof (val as { client?: unknown }).client === "object" &&
    (val as { client?: unknown }).client !== null
  );
}

/**
 * First-class zero-dependency Bunest DI & ALS transaction module for Prisma.
 */
@Module({})
export class PrismaModule implements OnModuleInit, OnApplicationShutdown {
  constructor(
    @Inject(PRISMA_LIFECYCLE_OPTIONS)
    private readonly lifecycle: PrismaLifecycleRecord,
    private readonly moduleRef: ModuleRef,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.lifecycle.autoConnect) return;
    const client = this.moduleRef.get<PrismaClientLike>(
      getPrismaToken(this.lifecycle.token),
    );
    if (client && typeof client.$connect === "function") {
      await client.$connect();
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (!this.lifecycle.autoDisconnect) return;
    const client = this.moduleRef.get<PrismaClientLike>(
      getPrismaToken(this.lifecycle.token),
    );
    if (client && typeof client.$disconnect === "function") {
      await client.$disconnect();
    }
  }

  static forRoot<TClient extends PrismaClientLike>(
    options: PrismaModuleOptions<TClient>,
  ): DynamicModule {
    const clientToken = getPrismaToken(options.token);
    const hostToken = getPrismaTransactionHostToken(options.token);
    const aspectToken = getPrismaTransactionalAspectToken(options.token);

    const clientProvider: Provider = {
      provide: clientToken,
      useValue: options.client,
    };

    const hostProvider: Provider = {
      provide: hostToken,
      useFactory: (client: TClient) =>
        new PrismaTransactionHost<TClient>(client, options.token),
      inject: [clientToken],
    };

    const aspectProvider: Provider = {
      provide: aspectToken,
      useFactory: (host: PrismaTransactionHost<TClient>) =>
        new PrismaTransactionalAspect(host),
      inject: [hostToken],
    };

    const providers: Provider[] = [
      {
        provide: PRISMA_LIFECYCLE_OPTIONS,
        useValue: {
          token: options.token,
          autoConnect: options.autoConnect === true,
          autoDisconnect: options.autoDisconnect !== false,
        } satisfies PrismaLifecycleRecord,
      },
      clientProvider,
      hostProvider,
      aspectProvider,
    ];
    const exportsList: ModuleExport[] = [
      clientProvider,
      hostProvider,
      aspectProvider,
    ];

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
      module: PrismaModule,
      global: options.global ?? true,
      providers,
      exports: exportsList,
    };
  }

  static forRootAsync<TClient extends PrismaClientLike>(
    options: PrismaModuleAsyncOptions<TClient>,
  ): DynamicModule {
    const clientToken = getPrismaToken(options.token);
    const hostToken = getPrismaTransactionHostToken(options.token);
    const aspectToken = getPrismaTransactionalAspectToken(options.token);
    const rawOptionsToken = Symbol("bunest:orm:prisma:async_options");

    const asyncProviders: Provider[] = [];
    if (options.useFactory) {
      asyncProviders.push({
        provide: rawOptionsToken,
        useFactory: async (...args: unknown[]) => {
          const resolved = await (
            options.useFactory as (
              ...a: unknown[]
            ) =>
              | Promise<PrismaModuleOptions<TClient> | TClient>
              | PrismaModuleOptions<TClient>
              | TClient
          )(...args);
          return isPrismaOptionsEnvelope(resolved)
            ? resolved
            : ({ client: resolved } satisfies PrismaModuleOptions<TClient>);
        },
        inject: options.inject ?? [],
      });
    } else if (options.useClass) {
      asyncProviders.push(
        { provide: options.useClass, useClass: options.useClass },
        {
          provide: rawOptionsToken,
          useFactory: async (factory: PrismaOptionsFactory<TClient>) => {
            const resolved = await factory.createPrismaOptions();
            return isPrismaOptionsEnvelope(resolved)
              ? resolved
              : ({ client: resolved } satisfies PrismaModuleOptions<TClient>);
          },
          inject: [options.useClass],
        },
      );
    } else if (options.useExisting) {
      asyncProviders.push({
        provide: rawOptionsToken,
        useFactory: async (factory: PrismaOptionsFactory<TClient>) => {
          const resolved = await factory.createPrismaOptions();
          return isPrismaOptionsEnvelope(resolved)
            ? resolved
            : ({ client: resolved } satisfies PrismaModuleOptions<TClient>);
        },
        inject: [options.useExisting],
      });
    } else {
      throw new Error(
        'PrismaModule.forRootAsync() requires one of "useFactory", "useClass", or "useExisting".',
      );
    }

    const clientProvider: Provider = {
      provide: clientToken,
      useFactory: (resolved: PrismaModuleOptions<TClient>) => resolved.client,
      inject: [rawOptionsToken],
    };

    const hostProvider: Provider = {
      provide: hostToken,
      useFactory: (client: TClient) =>
        new PrismaTransactionHost<TClient>(client, options.token),
      inject: [clientToken],
    };

    const aspectProvider: Provider = {
      provide: aspectToken,
      useFactory: (host: PrismaTransactionHost<TClient>) =>
        new PrismaTransactionalAspect(host),
      inject: [hostToken],
    };

    const providers: Provider[] = [
      ...asyncProviders,
      {
        provide: PRISMA_LIFECYCLE_OPTIONS,
        useFactory: (
          resolved: PrismaModuleOptions<TClient>,
        ): PrismaLifecycleRecord => ({
          token: options.token,
          autoConnect:
            (resolved.autoConnect ?? options.autoConnect) === true,
          autoDisconnect:
            (resolved.autoDisconnect ?? options.autoDisconnect) !== false,
        }),
        inject: [rawOptionsToken],
      },
      clientProvider,
      hostProvider,
      aspectProvider,
    ];
    const exportsList: ModuleExport[] = [
      clientProvider,
      hostProvider,
      aspectProvider,
    ];

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
      module: PrismaModule,
      global: options.global ?? true,
      imports: options.imports ?? [],
      providers,
      exports: exportsList,
    };
  }
}
