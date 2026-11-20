import { AsyncLocalStorage } from "node:async_hooks";
import {
  BadRequestException,
  ConflictException,
  DecoratorRegistry,
  Injectable,
  Module,
  NotFoundException,
  ServiceUnavailableException,
  type DynamicModule,
  type FactoryDependency,
  type HttpException,
  type InjectionToken,
  type MethodAspectContext,
  type MethodAspectHandler,
  type ModuleExport,
  type ModuleImport,
  type OnModuleDestroy,
  type OnModuleInit,
  type Provider,
  type Type,
} from "@bunest/common";
import type { SqlTransactionalOptions } from "../interfaces";
import {
  DEFAULT_PRISMA_CONNECTION,
  getPrismaOptionsToken,
  getPrismaServiceToken,
  getPrismaToken,
  getPrismaTransactionalAspectToken,
} from "../tokens";

/**
 * Structural contract compatible with generated Prisma Client instances
 * without requiring `@prisma/client` at install time.
 */
export interface PrismaClientLike<TTx = unknown> {
  $connect(): Promise<void>;
  $disconnect(): Promise<void>;
  $transaction?:
    | (<T>(
        fn: (tx: TTx) => Promise<T>,
        options?: Record<string, unknown>,
      ) => Promise<T>)
    | ((arg: any, options?: Record<string, unknown>) => Promise<any>);
  $queryRawUnsafe?(query: string, ...values: unknown[]): Promise<unknown>;
  $runCommandRaw?(command: Record<string, unknown>): Promise<unknown>;
}

export interface PrismaServiceOptions<
  TClient extends PrismaClientLike<any> = PrismaClientLike,
> {
  /**
   * Named connection identifier for multi-database applications.
   * @default "default"
   */
  readonly name?: string;

  /**
   * Automatically invoke `$connect()` during `onModuleInit()`.
   * @default true
   */
  readonly connectOnInit?: boolean;

  /**
   * Automatically invoke `$disconnect()` during `onModuleDestroy()`.
   * @default true
   */
  readonly disconnectOnDestroy?: boolean;

  /**
   * When `true`, `@InjectPrisma()` injects an ALS-aware `Proxy` that automatically
   * routes every property access and method call to the active `prismaService.transaction()`
   * client (falling back to the root client outside transactions).
   * @default false
   */
  readonly transactionalProxy?: boolean;

  /**
   * Optional custom health check callback invoked by `PrismaServiceBase.healthCheck()`.
   */
  readonly healthCheck?: (client: TClient) => Promise<boolean> | boolean;
}

export interface PrismaModuleOptions<
  TClient extends PrismaClientLike<any> = PrismaClientLike,
> extends PrismaServiceOptions<TClient> {
  /**
   * Prisma client instance to manage.
   */
  readonly client: TClient;

  /**
   * Register the module globally.
   * @default false
   */
  readonly global?: boolean;
}

export interface PrismaOptionsFactory<
  TClient extends PrismaClientLike<any> = PrismaClientLike,
> {
  createPrismaOptions():
    | Promise<PrismaModuleOptions<TClient>>
    | PrismaModuleOptions<TClient>;
}

export interface PrismaModuleAsyncOptions<
  TClient extends PrismaClientLike<any> = PrismaClientLike,
> {
  readonly name?: string;
  readonly global?: boolean;
  readonly imports?: ModuleImport[];
  readonly useFactory?: (
    ...args: any[]
  ) => Promise<PrismaModuleOptions<TClient>> | PrismaModuleOptions<TClient>;
  readonly inject?: FactoryDependency[];
  readonly useClass?: Type<PrismaOptionsFactory<TClient>>;
  readonly useExisting?: InjectionToken<PrismaOptionsFactory<TClient>>;
  readonly extraProviders?: Provider[];
}

/**
 * Maps known Prisma Client error codes (`P2002`, `P2025`, `P2003`, `P2000`, `P2024`, etc.)
 * to corresponding Bunest `HttpException` instances, returning `undefined` for unrecognized errors.
 */
export function mapPrismaErrorToHttp(error: unknown): HttpException | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const code =
    "code" in error && typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : undefined;
  if (!code) {
    return undefined;
  }
  const message =
    error instanceof Error ? error.message : `Database error (${code})`;

  switch (code) {
    case "P2002":
      return new ConflictException(message);
    case "P2025":
    case "P2015":
      return new NotFoundException(message);
    case "P2000":
    case "P2003":
    case "P2005":
    case "P2006":
    case "P2011":
    case "P2012":
    case "P2014":
    case "P2023":
      return new BadRequestException(message);
    case "P2024":
    case "P1001":
    case "P1002":
      return new ServiceUnavailableException(message);
    default:
      return undefined;
  }
}

/**
 * Lifecycle & `AsyncLocalStorage` transaction wrapper for Prisma Clients.
 *
 * Supports two idiomatic patterns:
 * 1. Composition via `PrismaModule.forRoot({ client })` / `forRootAsync(...)`
 * 2. Inheritance: `class AppPrismaService extends PrismaServiceBase<PrismaClient>`
 *    passing the client to `super(prismaClient)` or overriding `getClient()`.
 */
@Injectable()
export class PrismaServiceBase<
  TClient extends PrismaClientLike<any> = PrismaClientLike,
  TTx = TClient,
> implements OnModuleInit, OnModuleDestroy, AsyncDisposable
{
  public readonly connectionName: string;

  private readonly providedClient?: TClient;
  private readonly connectOnInit: boolean;
  private readonly disconnectOnDestroy: boolean;
  private readonly healthCheckHook?: (
    client: TClient,
  ) => Promise<boolean> | boolean;
  private readonly txStorage = new AsyncLocalStorage<TTx>();
  private cachedProxy?: TClient;
  private connected = false;
  private disconnected = false;

  constructor(client?: TClient, options: PrismaServiceOptions<TClient> = {}) {
    this.providedClient = client;
    this.connectionName = options.name ?? DEFAULT_PRISMA_CONNECTION;
    this.connectOnInit = options.connectOnInit ?? true;
    this.disconnectOnDestroy = options.disconnectOnDestroy ?? true;
    this.healthCheckHook = options.healthCheck;
  }

  /**
   * Override in subclasses that lazily construct or hold their own Prisma client.
   */
  protected getClient(): TClient {
    if (this.providedClient) {
      return this.providedClient;
    }
    const self = this as unknown as Partial<PrismaClientLike>;
    if (
      typeof self.$connect === "function" &&
      typeof self.$disconnect === "function"
    ) {
      return this as unknown as TClient;
    }
    throw new Error(
      `PrismaServiceBase("${this.connectionName}") has no Prisma client configured. Pass a client to super(client) or PrismaModule.forRoot({ client }).`,
    );
  }

  /**
   * Returns the active ALS transaction client when inside `transaction()`,
   * otherwise returns the root Prisma client. Throws if disconnected.
   */
  get client(): TClient | TTx {
    this.assertNotDisconnected();
    return this.txStorage.getStore() ?? this.getClient();
  }

  /**
   * Always returns the underlying root Prisma client.
   */
  get rawClient(): TClient {
    return this.getClient();
  }

  /**
   * Returns a stable ALS-routing `Proxy` over `this.client` so callers injecting
   * the proxy automatically participate in active `transaction()` scopes.
   */
  get transactionalClient(): TClient {
    if (!this.cachedProxy) {
      this.cachedProxy = this.createTransactionalProxy();
    }
    return this.cachedProxy;
  }

  get isConnected(): boolean {
    return this.connected && !this.disconnected;
  }

  get isDisconnected(): boolean {
    return this.disconnected;
  }

  getCurrentTransaction(): TTx | undefined {
    return this.txStorage.getStore();
  }

  isInTransaction(): boolean {
    return this.txStorage.getStore() !== undefined;
  }

  /**
   * Creates an ALS-aware `Proxy` delegating every property lookup and method call
   * to `this.client` (active transaction client if inside `transaction()`, else root client).
   */
  createTransactionalProxy(): TClient {
    const service = this;
    const root = this.getClient();
    const LIFECYCLE_HOOKS = new Set<PropertyKey>([
      "onModuleInit",
      "onApplicationBootstrap",
      "onModuleDestroy",
      "beforeApplicationShutdown",
      "onApplicationShutdown",
    ]);
    return new Proxy(root as object, {
      get(_target, prop, _receiver) {
        if (LIFECYCLE_HOOKS.has(prop)) {
          return undefined;
        }
        if (prop === "then" && service.isDisconnected) {
          return undefined;
        }
        const active = service.client as Record<PropertyKey, unknown>;
        const value = Reflect.get(active, prop, active);
        if (typeof value === "function") {
          return value.bind(active);
        }
        return value;
      },
      set(_target, prop, value) {
        const active = service.client as Record<PropertyKey, unknown>;
        return Reflect.set(active, prop, value, active);
      },
      has(_target, prop) {
        if (LIFECYCLE_HOOKS.has(prop)) {
          return false;
        }
        return Reflect.has(service.client as object, prop);
      },
      ownKeys() {
        return Reflect.ownKeys(service.client as object);
      },
      getOwnPropertyDescriptor(_target, prop) {
        if (LIFECYCLE_HOOKS.has(prop)) {
          return undefined;
        }
        return Reflect.getOwnPropertyDescriptor(service.client as object, prop);
      },
      getPrototypeOf() {
        return Reflect.getPrototypeOf(root as object);
      },
    }) as TClient;
  }

  async onModuleInit(): Promise<void> {
    if (this.connectOnInit && !this.connected) {
      await this.connect();
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.disconnectOnDestroy && !this.disconnected) {
      await this.disconnect();
    }
  }

  async connect(): Promise<void> {
    if (this.connected && !this.disconnected) {
      return;
    }
    await this.getClient().$connect();
    this.connected = true;
    this.disconnected = false;
  }

  async disconnect(): Promise<void> {
    if (this.disconnected) {
      return;
    }
    await this.getClient().$disconnect();
    this.disconnected = true;
    this.connected = false;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.disconnect();
  }

  /**
   * Probes connectivity of the Prisma Client (compatible with `PrismaHealthIndicator`).
   */
  async healthCheck(): Promise<boolean> {
    if (this.disconnected) {
      return false;
    }
    try {
      const root = this.getClient();
      if (this.healthCheckHook) {
        return Boolean(await this.healthCheckHook(root));
      }
      if (typeof root.$queryRawUnsafe === "function") {
        await root.$queryRawUnsafe("SELECT 1");
        return true;
      }
      if (typeof root.$runCommandRaw === "function") {
        await root.$runCommandRaw({ ping: 1 });
        return true;
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Executes `fn` inside a Prisma interactive `$transaction()` propagated via `AsyncLocalStorage`.
   * If already inside an active transaction context on this service, joins the active transaction
   * (avoiding Prisma's nested `$transaction` limitation).
   */
  async transaction<T>(
    fn: (tx: TTx) => Promise<T>,
    options?: Record<string, unknown>,
  ): Promise<T> {
    this.assertNotDisconnected();
    const existingTx = this.txStorage.getStore();
    if (existingTx !== undefined) {
      return await fn(existingTx);
    }

    const root = this.getClient();
    if (typeof root.$transaction !== "function") {
      throw new Error(
        `Prisma client "${this.connectionName}" does not implement $transaction().`,
      );
    }

    return await (
      root.$transaction as <R>(
        cb: (tx: TTx) => Promise<R>,
        opts?: Record<string, unknown>,
      ) => Promise<R>
    )(async (tx: TTx) => {
      return await this.txStorage.run(tx, () => fn(tx));
    }, options);
  }

  /**
   * Executes a Prisma batch array `$transaction([...queries], options?)`.
   */
  async batchTransaction<T extends readonly unknown[]>(
    queries: [...T],
    options?: Record<string, unknown>,
  ): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }> {
    this.assertNotDisconnected();
    const root = this.getClient();
    if (typeof root.$transaction !== "function") {
      throw new Error(
        `Prisma client "${this.connectionName}" does not implement $transaction().`,
      );
    }

    return await (
      root.$transaction as (
        ops: [...T],
        opts?: Record<string, unknown>,
      ) => Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }>
    )(queries, options);
  }

  private assertNotDisconnected(): void {
    if (this.disconnected) {
      throw new Error(
        `Prisma connection "${this.connectionName}" has been disconnected.`,
      );
    }
  }
}

/**
 * Core Method Aspect handler powering `@Transactional({ adapter: "prisma" })`.
 */
@Injectable()
export class PrismaTransactionalAspect
  implements MethodAspectHandler<SqlTransactionalOptions | undefined>
{
  constructor(private readonly prisma: PrismaServiceBase<any, any>) {}

  intercept(
    ctx: MethodAspectContext<SqlTransactionalOptions | undefined>,
  ): unknown {
    return this.prisma.transaction(
      async () => await ctx.proceed(),
      ctx.options?.config,
    );
  }
}

DecoratorRegistry.markInternal(PrismaServiceBase, PrismaTransactionalAspect);

/**
 * Dynamic module integrating Prisma Client instances into Bunest DI and lifecycle hooks
 * (`$connect` on `onModuleInit`, `$disconnect` on `onModuleDestroy`, ALS transaction hook)
 * without requiring a generated `@prisma/client` package at install time.
 */
@Module({})
export class PrismaModule {
  static forRoot<TClient extends PrismaClientLike<any> = PrismaClientLike>(
    options: PrismaModuleOptions<TClient>,
  ): DynamicModule {
    const connectionName = options.name ?? DEFAULT_PRISMA_CONNECTION;
    const optionsToken = getPrismaOptionsToken(connectionName);
    const serviceToken = getPrismaServiceToken(connectionName);
    const clientToken = getPrismaToken(connectionName);
    const txAspectToken = getPrismaTransactionalAspectToken(connectionName);

    const providers: Provider[] = [
      {
        provide: optionsToken,
        useValue: { ...options, name: connectionName },
      },
      {
        provide: serviceToken,
        useFactory: (resolved: PrismaModuleOptions<TClient>) =>
          new PrismaServiceBase(resolved.client, {
            name: connectionName,
            connectOnInit: resolved.connectOnInit,
            disconnectOnDestroy: resolved.disconnectOnDestroy,
            transactionalProxy: resolved.transactionalProxy,
            healthCheck: resolved.healthCheck,
          }),
        inject: [optionsToken],
      },
      {
        provide: clientToken,
        useFactory: (
          service: PrismaServiceBase<TClient>,
          resolved: PrismaModuleOptions<TClient>,
        ) =>
          resolved.transactionalProxy
            ? service.transactionalClient
            : service.rawClient,
        inject: [serviceToken, optionsToken],
      },
      {
        provide: txAspectToken,
        useFactory: (service: PrismaServiceBase<TClient>) =>
          new PrismaTransactionalAspect(service),
        inject: [serviceToken],
      },
    ];

    const exportsList: ModuleExport[] = [
      clientToken,
      serviceToken,
      txAspectToken,
    ];

    if (connectionName === DEFAULT_PRISMA_CONNECTION) {
      providers.push(
        {
          provide: PrismaServiceBase,
          useExisting: serviceToken,
        },
        {
          provide: PrismaTransactionalAspect,
          useExisting: txAspectToken,
        },
      );
      exportsList.push(PrismaServiceBase, PrismaTransactionalAspect);
    }

    return {
      module: PrismaModule,
      global: options.global ?? false,
      providers,
      exports: exportsList,
    };
  }

  static forRootAsync<TClient extends PrismaClientLike<any> = PrismaClientLike>(
    options: PrismaModuleAsyncOptions<TClient>,
  ): DynamicModule {
    const connectionName = options.name ?? DEFAULT_PRISMA_CONNECTION;
    const optionsToken = getPrismaOptionsToken(connectionName);
    const serviceToken = getPrismaServiceToken(connectionName);
    const clientToken = getPrismaToken(connectionName);
    const txAspectToken = getPrismaTransactionalAspectToken(connectionName);

    const asyncOptionProviders = PrismaModule.createAsyncOptionsProviders(
      options,
      optionsToken,
      connectionName,
    );

    const providers: Provider[] = [
      ...asyncOptionProviders,
      ...(options.extraProviders ?? []),
      {
        provide: serviceToken,
        useFactory: (resolved: PrismaModuleOptions<TClient>) =>
          new PrismaServiceBase(resolved.client, {
            name: connectionName,
            connectOnInit: resolved.connectOnInit,
            disconnectOnDestroy: resolved.disconnectOnDestroy,
            transactionalProxy: resolved.transactionalProxy,
            healthCheck: resolved.healthCheck,
          }),
        inject: [optionsToken],
      },
      {
        provide: clientToken,
        useFactory: (
          service: PrismaServiceBase<TClient>,
          resolved: PrismaModuleOptions<TClient>,
        ) =>
          resolved.transactionalProxy
            ? service.transactionalClient
            : service.rawClient,
        inject: [serviceToken, optionsToken],
      },
      {
        provide: txAspectToken,
        useFactory: (service: PrismaServiceBase<TClient>) =>
          new PrismaTransactionalAspect(service),
        inject: [serviceToken],
      },
    ];

    const exportsList: ModuleExport[] = [
      clientToken,
      serviceToken,
      txAspectToken,
    ];

    if (connectionName === DEFAULT_PRISMA_CONNECTION) {
      providers.push(
        {
          provide: PrismaServiceBase,
          useExisting: serviceToken,
        },
        {
          provide: PrismaTransactionalAspect,
          useExisting: txAspectToken,
        },
      );
      exportsList.push(PrismaServiceBase, PrismaTransactionalAspect);
    }

    return {
      module: PrismaModule,
      global: options.global ?? false,
      imports: options.imports ?? [],
      providers,
      exports: exportsList,
    };
  }

  private static createAsyncOptionsProviders<
    TClient extends PrismaClientLike<any>,
  >(
    options: PrismaModuleAsyncOptions<TClient>,
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
          useFactory: async (factory: PrismaOptionsFactory<TClient>) => {
            const resolved = await factory.createPrismaOptions();
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
          useFactory: async (factory: PrismaOptionsFactory<TClient>) => {
            const resolved = await factory.createPrismaOptions();
            return { ...resolved, name: connectionName };
          },
          inject: [options.useExisting],
        },
      ];
    }

    throw new Error(
      `PrismaModule.forRootAsync("${connectionName}") requires one of "useFactory", "useClass", or "useExisting".`,
    );
  }
}
