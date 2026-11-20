import { AsyncLocalStorage } from "node:async_hooks";
import {
  DecoratorRegistry,
  Injectable,
  Module,
  type DynamicModule,
  type FactoryDependency,
  type InjectionToken,
  type MethodAspectContext,
  type MethodAspectHandler,
  type ModuleExport,
  type ModuleImport,
  type OnModuleDestroy,
  type Provider,
  type Type,
} from "@bunest/common";
import type { SqlTransactionalOptions } from "../interfaces";
import {
  DEFAULT_DRIZZLE_CONNECTION,
  getDrizzleOptionsToken,
  getDrizzleServiceToken,
  getDrizzleToken,
  getDrizzleTransactionalAspectToken,
} from "../tokens";

/**
 * Structural contract compatible with Drizzle ORM database instances
 * (`drizzle-orm/bun-sqlite`, `drizzle-orm/bun-sql`, `drizzle-orm/postgres-js`, etc.)
 * without requiring `drizzle-orm` as a hard runtime dependency.
 */
export interface DrizzleDatabaseLike<TTx = unknown> {
  transaction?<T>(
    fn: (tx: TTx) => Promise<T> | T,
    config?: Record<string, unknown>,
  ): Promise<T> | T;
  execute?(query: unknown): Promise<unknown> | unknown;
  run?(query: unknown): unknown;
}

export interface DrizzleClosableClient {
  close?(): Promise<void> | void;
  end?(): Promise<void> | void;
  healthCheck?(): Promise<boolean> | boolean;
  query?(sql: string): Promise<unknown> | unknown;
  queryOne?(sql: string): Promise<unknown> | unknown;
  unsafe?(sql: string): Promise<unknown> | unknown;
}

export interface DrizzleModuleOptions<
  TDb extends DrizzleDatabaseLike<any> = DrizzleDatabaseLike,
> {
  /**
   * Named connection identifier for multi-database applications.
   * @default "default"
   */
  readonly name?: string;

  /**
   * Drizzle ORM database instance created via `drizzle(...)`.
   */
  readonly db: TDb;

  /**
   * Optional underlying database client (`bun:sqlite` `Database`, `Bun.SQL`, pool, etc.)
   * to close automatically during `onModuleDestroy()`.
   */
  readonly client?: DrizzleClosableClient;

  /**
   * Optional custom cleanup hook invoked during `onModuleDestroy()`.
   */
  readonly onDestroy?: (db: TDb) => Promise<void> | void;

  /**
   * Optional custom health check probe invoked by `DrizzleService.healthCheck()`.
   */
  readonly healthCheck?: (db: TDb) => Promise<boolean> | boolean;

  /**
   * When `true`, `@InjectDrizzle()` injects an ALS-aware `Proxy` that automatically
   * routes every property access and method call to the active `drizzleService.transaction()`
   * / `transactionSync()` context (falling back to the root DB outside transactions).
   * @default false
   */
  readonly transactionalProxy?: boolean;

  /**
   * Whether to close `client` automatically during `onModuleDestroy()`.
   * @default true
   */
  readonly autoClose?: boolean;

  /**
   * Register the module globally.
   * @default false
   */
  readonly global?: boolean;
}

export interface DrizzleOptionsFactory<
  TDb extends DrizzleDatabaseLike<any> = DrizzleDatabaseLike,
> {
  createDrizzleOptions():
    | Promise<DrizzleModuleOptions<TDb>>
    | DrizzleModuleOptions<TDb>;
}

export interface DrizzleModuleAsyncOptions<
  TDb extends DrizzleDatabaseLike<any> = DrizzleDatabaseLike,
> {
  readonly name?: string;
  readonly global?: boolean;
  readonly imports?: ModuleImport[];
  readonly useFactory?: (
    ...args: any[]
  ) => Promise<DrizzleModuleOptions<TDb>> | DrizzleModuleOptions<TDb>;
  readonly inject?: FactoryDependency[];
  readonly useClass?: Type<DrizzleOptionsFactory<TDb>>;
  readonly useExisting?: InjectionToken<DrizzleOptionsFactory<TDb>>;
  readonly extraProviders?: Provider[];
}

/**
 * Lifecycle & `AsyncLocalStorage` transaction context wrapper for Drizzle ORM.
 * - Supports both async drivers (`drizzle-orm/bun-sql`, `postgres-js`) via `transaction()`
 *   AND synchronous `drizzle-orm/bun-sqlite` via `transactionSync()` (and sync callbacks to `transaction()`).
 * - Exposes an ALS-aware `transactionalDb` `Proxy` (also wired to `@InjectDrizzle()` when `transactionalProxy: true`).
 */
@Injectable()
export class DrizzleService<
  TDb extends DrizzleDatabaseLike<any> = DrizzleDatabaseLike,
> implements OnModuleDestroy, AsyncDisposable
{
  public readonly connectionName: string;

  private readonly instance: TDb;
  private readonly client?: DrizzleClosableClient;
  private readonly onDestroyHook?: (db: TDb) => Promise<void> | void;
  private readonly healthCheckHook?: (db: TDb) => Promise<boolean> | boolean;
  private readonly autoClose: boolean;
  private readonly txStorage = new AsyncLocalStorage<TDb>();
  private cachedProxy?: TDb;
  private closed = false;

  constructor(options: DrizzleModuleOptions<TDb>) {
    this.connectionName = options.name ?? DEFAULT_DRIZZLE_CONNECTION;
    this.instance = options.db;
    this.client = options.client;
    this.onDestroyHook = options.onDestroy;
    this.healthCheckHook = options.healthCheck;
    this.autoClose = options.autoClose ?? true;
  }

  /**
   * Returns the active ALS transaction client when called inside `transaction()` or
   * `transactionSync()`, otherwise returns the root Drizzle database instance.
   */
  get db(): TDb {
    this.assertOpen();
    return this.txStorage.getStore() ?? this.instance;
  }

  /**
   * Always returns the root Drizzle database instance.
   */
  get rootDb(): TDb {
    return this.instance;
  }

  /**
   * Returns a stable ALS-routing `Proxy` over `this.db` so callers injecting
   * the proxy automatically participate in active transactions.
   */
  get transactionalDb(): TDb {
    if (!this.cachedProxy) {
      this.cachedProxy = this.createTransactionalProxy();
    }
    return this.cachedProxy;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  getCurrentTransaction(): TDb | undefined {
    return this.txStorage.getStore();
  }

  isInTransaction(): boolean {
    return this.txStorage.getStore() !== undefined;
  }

  /**
   * Creates an ALS-aware `Proxy` delegating every property lookup and method call
   * to `this.db` (active transaction if inside `transaction()`/`transactionSync()`, else root DB).
   */
  createTransactionalProxy(): TDb {
    const service = this;
    const LIFECYCLE_HOOKS = new Set<PropertyKey>([
      "onModuleInit",
      "onApplicationBootstrap",
      "onModuleDestroy",
      "beforeApplicationShutdown",
      "onApplicationShutdown",
    ]);
    return new Proxy(this.instance as object, {
      get(_target, prop, _receiver) {
        if (LIFECYCLE_HOOKS.has(prop)) {
          return undefined;
        }
        if (prop === "then" && service.isClosed) {
          return undefined;
        }
        const active = service.db as Record<PropertyKey, unknown>;
        const value = Reflect.get(active, prop, active);
        if (typeof value === "function") {
          return value.bind(active);
        }
        return value;
      },
      set(_target, prop, value) {
        const active = service.db as Record<PropertyKey, unknown>;
        return Reflect.set(active, prop, value, active);
      },
      has(_target, prop) {
        if (LIFECYCLE_HOOKS.has(prop)) {
          return false;
        }
        return Reflect.has(service.db as object, prop);
      },
      ownKeys() {
        return Reflect.ownKeys(service.db as object);
      },
      getOwnPropertyDescriptor(_target, prop) {
        if (LIFECYCLE_HOOKS.has(prop)) {
          return undefined;
        }
        return Reflect.getOwnPropertyDescriptor(service.db as object, prop);
      },
      getPrototypeOf() {
        return Reflect.getPrototypeOf(service.instance as object);
      },
    }) as TDb;
  }

  /**
   * Executes `fn` inside a Drizzle transaction and propagates the transaction client
   * through `AsyncLocalStorage`. Nested calls delegate to `tx.transaction()` (Drizzle savepoint).
   * Note: Passes a non-async wrapper callback to `active.transaction()` so synchronous callbacks
   * also remain compatible with `drizzle-orm/bun-sqlite`.
   */
  async transaction<T>(
    fn: (tx: TDb) => Promise<T> | T,
    config?: Record<string, unknown>,
  ): Promise<T> {
    this.assertOpen();
    const active = this.txStorage.getStore() ?? this.instance;
    if (typeof active.transaction !== "function") {
      throw new Error(
        `Drizzle connection "${this.connectionName}" does not implement transaction().`,
      );
    }

    return await active.transaction((tx: TDb) => {
      return this.txStorage.run(tx, () => fn(tx));
    }, config);
  }

  /**
   * Synchronous transaction wrapper required by `drizzle-orm/bun-sqlite` (where
   * `db.transaction()` throws if given an `async` callback returning a Promise).
   */
  transactionSync<T>(
    fn: (tx: TDb) => T,
    config?: Record<string, unknown>,
  ): T {
    this.assertOpen();
    const active = this.txStorage.getStore() ?? this.instance;
    if (typeof active.transaction !== "function") {
      throw new Error(
        `Drizzle connection "${this.connectionName}" does not implement transaction().`,
      );
    }

    return active.transaction((tx: TDb) => {
      return this.txStorage.run(tx, () => fn(tx));
    }, config) as T;
  }

  /**
   * Probes connectivity of the underlying Drizzle DB/client.
   */
  async healthCheck(): Promise<boolean> {
    if (this.closed) {
      return false;
    }
    try {
      if (this.healthCheckHook) {
        return Boolean(await this.healthCheckHook(this.instance));
      }
      if (typeof this.client?.healthCheck === "function") {
        return Boolean(await this.client.healthCheck());
      }
      if (typeof this.client?.queryOne === "function") {
        await this.client.queryOne("SELECT 1");
        return true;
      }
      if (typeof this.client?.query === "function") {
        await this.client.query("SELECT 1");
        return true;
      }
      if (typeof this.client?.unsafe === "function") {
        await this.client.unsafe("SELECT 1");
        return true;
      }
      if (typeof this.instance.execute === "function") {
        await this.instance.execute("SELECT 1");
        return true;
      }
      if (typeof this.instance.run === "function") {
        await this.instance.run("SELECT 1");
        return true;
      }
      return true;
    } catch {
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;

    try {
      if (this.onDestroyHook) {
        await this.onDestroyHook(this.instance);
      }
    } finally {
      if (this.autoClose && this.client) {
        if (typeof this.client.close === "function") {
          await this.client.close();
        } else if (typeof this.client.end === "function") {
          await this.client.end();
        }
      }
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error(
        `Drizzle connection "${this.connectionName}" has been closed.`,
      );
    }
  }
}

/**
 * Core Method Aspect handler powering `@Transactional({ adapter: "drizzle" })`.
 */
@Injectable()
export class DrizzleTransactionalAspect
  implements MethodAspectHandler<SqlTransactionalOptions | undefined>
{
  constructor(private readonly drizzle: DrizzleService<any>) {}

  intercept(
    ctx: MethodAspectContext<SqlTransactionalOptions | undefined>,
  ): unknown {
    const opts = ctx.options;
    if (opts?.sync) {
      return this.drizzle.transactionSync(() => ctx.proceed(), opts.config);
    }
    return this.drizzle.transaction(() => ctx.proceed(), opts?.config);
  }
}

DecoratorRegistry.markInternal(DrizzleService, DrizzleTransactionalAspect);

/**
 * Dynamic module integrating Drizzle ORM instances into Bunest DI and lifecycle hooks
 * without forcing `drizzle-orm` as a runtime dependency.
 */
@Module({})
export class DrizzleModule {
  static forRoot<TDb extends DrizzleDatabaseLike<any> = DrizzleDatabaseLike>(
    options: DrizzleModuleOptions<TDb>,
  ): DynamicModule {
    const connectionName = options.name ?? DEFAULT_DRIZZLE_CONNECTION;
    const optionsToken = getDrizzleOptionsToken(connectionName);
    const serviceToken = getDrizzleServiceToken(connectionName);
    const dbToken = getDrizzleToken(connectionName);
    const txAspectToken = getDrizzleTransactionalAspectToken(connectionName);

    const providers: Provider[] = [
      {
        provide: optionsToken,
        useValue: { ...options, name: connectionName },
      },
      {
        provide: serviceToken,
        useFactory: (resolved: DrizzleModuleOptions<TDb>) =>
          new DrizzleService(resolved),
        inject: [optionsToken],
      },
      {
        provide: dbToken,
        useFactory: (
          service: DrizzleService<TDb>,
          resolved: DrizzleModuleOptions<TDb>,
        ) => (resolved.transactionalProxy ? service.transactionalDb : service.rootDb),
        inject: [serviceToken, optionsToken],
      },
      {
        provide: txAspectToken,
        useFactory: (service: DrizzleService<TDb>) =>
          new DrizzleTransactionalAspect(service),
        inject: [serviceToken],
      },
    ];

    const exportsList: ModuleExport[] = [dbToken, serviceToken, txAspectToken];

    if (connectionName === DEFAULT_DRIZZLE_CONNECTION) {
      providers.push(
        {
          provide: DrizzleService,
          useExisting: serviceToken,
        },
        {
          provide: DrizzleTransactionalAspect,
          useExisting: txAspectToken,
        },
      );
      exportsList.push(DrizzleService, DrizzleTransactionalAspect);
    }

    return {
      module: DrizzleModule,
      global: options.global ?? false,
      providers,
      exports: exportsList,
    };
  }

  static forRootAsync<
    TDb extends DrizzleDatabaseLike<any> = DrizzleDatabaseLike,
  >(options: DrizzleModuleAsyncOptions<TDb>): DynamicModule {
    const connectionName = options.name ?? DEFAULT_DRIZZLE_CONNECTION;
    const optionsToken = getDrizzleOptionsToken(connectionName);
    const serviceToken = getDrizzleServiceToken(connectionName);
    const dbToken = getDrizzleToken(connectionName);
    const txAspectToken = getDrizzleTransactionalAspectToken(connectionName);

    const asyncOptionProviders = DrizzleModule.createAsyncOptionsProviders(
      options,
      optionsToken,
      connectionName,
    );

    const providers: Provider[] = [
      ...asyncOptionProviders,
      ...(options.extraProviders ?? []),
      {
        provide: serviceToken,
        useFactory: (resolved: DrizzleModuleOptions<TDb>) =>
          new DrizzleService({ ...resolved, name: connectionName }),
        inject: [optionsToken],
      },
      {
        provide: dbToken,
        useFactory: (
          service: DrizzleService<TDb>,
          resolved: DrizzleModuleOptions<TDb>,
        ) => (resolved.transactionalProxy ? service.transactionalDb : service.rootDb),
        inject: [serviceToken, optionsToken],
      },
      {
        provide: txAspectToken,
        useFactory: (service: DrizzleService<TDb>) =>
          new DrizzleTransactionalAspect(service),
        inject: [serviceToken],
      },
    ];

    const exportsList: ModuleExport[] = [dbToken, serviceToken, txAspectToken];

    if (connectionName === DEFAULT_DRIZZLE_CONNECTION) {
      providers.push(
        {
          provide: DrizzleService,
          useExisting: serviceToken,
        },
        {
          provide: DrizzleTransactionalAspect,
          useExisting: txAspectToken,
        },
      );
      exportsList.push(DrizzleService, DrizzleTransactionalAspect);
    }

    return {
      module: DrizzleModule,
      global: options.global ?? false,
      imports: options.imports ?? [],
      providers,
      exports: exportsList,
    };
  }

  private static createAsyncOptionsProviders<
    TDb extends DrizzleDatabaseLike<any>,
  >(
    options: DrizzleModuleAsyncOptions<TDb>,
    optionsToken: string,
    connectionName: string,
  ): Provider[] {
    if (options.useFactory) {
      return [
        {
          provide: optionsToken,
          useFactory: async (...args: unknown[]) => {
            const resolved = await options.useFactory!(...args);
            return { ...resolved, name: connectionName };
          },
          inject: options.inject ?? [],
        },
      ];
    }

    if (options.useClass) {
      const factoryClass = options.useClass;
      return [
        {
          provide: factoryClass,
          useClass: factoryClass,
        },
        {
          provide: optionsToken,
          useFactory: async (factory: DrizzleOptionsFactory<TDb>) => {
            const resolved = await factory.createDrizzleOptions();
            return { ...resolved, name: connectionName };
          },
          inject: [factoryClass],
        },
      ];
    }

    if (options.useExisting) {
      return [
        {
          provide: optionsToken,
          useFactory: async (factory: DrizzleOptionsFactory<TDb>) => {
            const resolved = await factory.createDrizzleOptions();
            return { ...resolved, name: connectionName };
          },
          inject: [options.useExisting],
        },
      ];
    }

    throw new Error(
      `DrizzleModule.forRootAsync("${connectionName}") requires one of "useFactory", "useClass", or "useExisting".`,
    );
  }
}
