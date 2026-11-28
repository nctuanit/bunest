import {
  ContextStorage,
  DecoratorRegistry,
  Inject,
  Injectable,
  Optional,
  registerLogContextProvider,
  type BunestInterceptor,
  type BunestMiddleware,
  type CallHandler,
  type ContextStorageLike,
  type ExecutionContext,
  type FactoryDependency,
  type ModuleImport,
  type NextFunction,
  type ResponseContext,
  type RouteInfo,
  type Type,
} from "../common/index";
import { registerAmbientClsStoreGetter } from "./cls-context-carrier";

export const CLS_MODULE_OPTIONS = Symbol.for("bunest:core:cls_module_options");
export const CLS_ID = Symbol.for("bunest:core:cls_id");

export type ClsStore = Map<string | symbol, unknown>;

/**
 * Extracts explicit (non-index-signature) keys from a typed CLS store interface/type.
 */
export type ClsKnownKeys<T> = {
  [K in keyof T]-?: string extends K
    ? never
    : number extends K
      ? never
      : symbol extends K
        ? never
        : K;
}[keyof T];

export interface ClsMiddlewareMountOptions {
  /**
   * Automatically mount `ClsMiddleware` globally on HTTP routes during module configuration.
   * @default false
   */
  readonly mount?: boolean;
  /**
   * Routes or controllers to mount `ClsMiddleware` on when `mount: true`.
   * @default ["*"]
   */
  readonly forRoutes?: readonly (string | Type<unknown> | RouteInfo)[];
  /**
   * Routes to exclude when auto-mounting `ClsMiddleware`.
   */
  readonly exclude?: readonly (string | RouteInfo)[];
  /**
   * Optional setup hook invoked inside the CLS context by `ClsMiddleware`.
   */
  readonly setup?: (
    cls: ClsService,
    req: Request,
    res: ResponseContext,
  ) => void | Promise<void>;
  /**
   * Override `generateId` specifically for `ClsMiddleware`.
   */
  readonly generateId?: boolean;
  /**
   * Override `idGenerator` specifically for `ClsMiddleware`.
   */
  readonly idGenerator?: (req: Request) => string;
}

export interface ClsInterceptorMountOptions {
  /**
   * Automatically mount `ClsInterceptor` globally via `APP_INTERCEPTOR`.
   * @default false
   */
  readonly mount?: boolean;
  /**
   * Optional setup hook invoked inside the CLS context by `ClsInterceptor`.
   */
  readonly setup?: (
    cls: ClsService,
    context: ExecutionContext,
  ) => void | Promise<void>;
  /**
   * Override `generateId` specifically for `ClsInterceptor`.
   */
  readonly generateId?: boolean;
  /**
   * Override `idGenerator` specifically for `ClsInterceptor`.
   */
  readonly idGenerator?: (context: ExecutionContext) => string;
}

export interface ClsModuleOptions {
  /**
   * Register `ClsModule` globally across all modules.
   * @default true
   */
  readonly global?: boolean;
  /**
   * Automatically generate a unique ID stored under `CLS_ID` for each context.
   * @default true
   */
  readonly generateId?: boolean;
  /**
   * Custom ID generator invoked when starting a new CLS context.
   */
  readonly idGenerator?: (req?: Request) => string;
  /**
   * Optional setup hook invoked whenever a new CLS context starts via middleware/interceptor.
   */
  readonly setup?: (cls: ClsService, req?: Request) => void | Promise<void>;
  /**
   * HTTP `ClsMiddleware` auto-mounting and per-request setup configuration.
   */
  readonly middleware?: ClsMiddlewareMountOptions;
  /**
   * Global `ClsInterceptor` auto-mounting and execution-context setup configuration.
   */
  readonly interceptor?: ClsInterceptorMountOptions;
  /**
   * Automatically enrich `Logger` / `ConsoleLogger` JSON logs with active CLS
   * store entries:
   * - `true`: includes all string-keyed entries (and `clsId` when `CLS_ID` is set).
   * - `string[]`: includes only the listed string keys from the active CLS store.
   * @default false
   */
  readonly enrichLogs?: boolean | readonly string[];
}

export interface ClsModuleAsyncOptions {
  /**
   * Register `ClsModule` globally across all modules.
   * @default true
   */
  readonly global?: boolean;
  /**
   * Modules imported so their exported providers can be injected into `useFactory`.
   */
  readonly imports?: ModuleImport[];
  /**
   * Factory returning `ClsModuleOptions` synchronously or asynchronously.
   */
  readonly useFactory: (
    ...args: any[]
  ) => ClsModuleOptions | Promise<ClsModuleOptions>;
  /**
   * Dependencies injected into `useFactory`.
   */
  readonly inject?: FactoryDependency[];
  /**
   * Optional middleware mount defaults (merged with factory result; factory values win).
   */
  readonly middleware?: ClsMiddlewareMountOptions;
  /**
   * Optional interceptor mount defaults (merged with factory result; factory values win).
   */
  readonly interceptor?: ClsInterceptorMountOptions;
}

const defaultClsStorage = new ContextStorage<ClsStore>();
registerAmbientClsStoreGetter(() => defaultClsStorage.getStore());

function applyInitialStoreEntries(
  store: ClsStore,
  initial: Record<PropertyKey, unknown>,
): void {
  for (const [key, value] of Object.entries(initial)) {
    store.set(key, value);
  }
  for (const sym of Object.getOwnPropertySymbols(initial)) {
    if (Object.prototype.propertyIsEnumerable.call(initial, sym)) {
      store.set(sym, initial[sym]);
    }
  }
}

/**
 * Generalized `ContextStorage`-backed continuation-local storage service
 * usable uniformly across HTTP requests, WebSockets, Queues, Cron jobs,
 * Microservices, and standalone background tasks (`cls.run()`).
 */
@Injectable()
export class ClsService<TStore extends object = Record<string, unknown>> {
  private readonly storage: ContextStorageLike<ClsStore>;
  private readonly generateId: boolean;
  private readonly idGenerator: (req?: Request) => string;
  private readonly unregisterLogProvider?: () => void;

  constructor(
    @Optional()
    @Inject(CLS_MODULE_OPTIONS)
    options: ClsModuleOptions = {},
    @Optional()
    storage: ContextStorageLike<ClsStore> = defaultClsStorage,
  ) {
    this.storage = storage;
    this.generateId = options.generateId ?? true;
    this.idGenerator =
      options.idGenerator ??
      ((req) => req?.headers.get("x-request-id") || crypto.randomUUID());

    if (options.enrichLogs) {
      const allowedKeys = Array.isArray(options.enrichLogs)
        ? options.enrichLogs
        : undefined;
      this.unregisterLogProvider = registerLogContextProvider(() => {
        const store = this.storage.getStore();
        if (!store || store.size === 0) return undefined;
        const out: Record<string, unknown> = {};
        let hasAny = false;
        if (allowedKeys) {
          for (let i = 0; i < allowedKeys.length; i++) {
            const k = allowedKeys[i]!;
            let v = store.get(k);
            if (v === undefined && k === "clsId") {
              v = store.get(CLS_ID);
            }
            if (v !== undefined) {
              out[k] = v;
              hasAny = true;
            }
          }
        } else {
          for (const [k, v] of store.entries()) {
            if (typeof k === "string" && v !== undefined) {
              out[k] = v;
              hasAny = true;
            }
          }
          const clsId = store.get(CLS_ID);
          if (typeof clsId === "string" && !("clsId" in out)) {
            out.clsId = clsId;
            hasAny = true;
          }
        }
        return hasAny ? out : undefined;
      });
    }
  }

  onModuleDestroy(): void {
    this.unregisterLogProvider?.();
  }

  /**
   * Returns `true` if execution is currently inside an active CLS context.
   */
  isActive(): boolean {
    return this.storage.getStore() !== undefined;
  }

  /**
   * Returns the active CLS context ID (stored under `CLS_ID`), if any.
   */
  getId(): string | undefined {
    return this.get<string>(CLS_ID);
  }

  /**
   * Retrieves a value from the active CLS context.
   * Infers `TStore[K] | undefined` for known typed store keys while preserving
   * backward-compatible `get<T = unknown>(key: string | symbol): T | undefined`.
   */
  get<K extends ClsKnownKeys<TStore>>(key: K): TStore[K] | undefined;
  get<
    T = string extends keyof TStore
      ? TStore[string & keyof TStore]
      : unknown,
  >(key: string | symbol): T | undefined;
  get(key: PropertyKey): unknown {
    const store = this.storage.getStore();
    return store?.get(key as string | symbol);
  }

  /**
   * Stores a key/value pair inside the active CLS context.
   * Throws if called outside an active CLS context (`run()` / `enter()` / middleware).
   */
  set<K extends ClsKnownKeys<TStore>>(key: K, value: TStore[K]): void;
  set<T = unknown>(key: string | symbol, value: T): void;
  set(key: PropertyKey, value: unknown): void {
    const store = this.storage.getStore();
    if (!store) {
      throw new Error(
        "ClsService.set() called outside an active CLS context. Wrap execution in cls.run(), ClsMiddleware, or ClsInterceptor.",
      );
    }
    store.set(key as string | symbol, value);
  }

  /**
   * Stores a value only if the key does not already exist in the active store.
   */
  setIfUndefined<K extends ClsKnownKeys<TStore>>(
    key: K,
    value: TStore[K],
  ): boolean;
  setIfUndefined<T = unknown>(key: string | symbol, value: T): boolean;
  setIfUndefined(key: PropertyKey, value: unknown): boolean {
    const store = this.storage.getStore();
    if (!store) {
      throw new Error(
        "ClsService.setIfUndefined() called outside an active CLS context.",
      );
    }
    const normalizedKey = key as string | symbol;
    if (store.has(normalizedKey)) {
      return false;
    }
    store.set(normalizedKey, value);
    return true;
  }

  has(key: keyof TStore | string | symbol): boolean {
    return this.storage.getStore()?.has(key as string | symbol) ?? false;
  }

  delete(key: keyof TStore | string | symbol): boolean {
    return this.storage.getStore()?.delete(key as string | symbol) ?? false;
  }

  /**
   * Runs `callback` inside a fresh isolated CLS context (inheriting nothing from outer stores).
   */
  run<T>(
    callback: () => T,
    initial?: Partial<TStore> | Record<PropertyKey, unknown>,
    req?: Request,
  ): T {
    const store: ClsStore = new Map();
    if (this.generateId) {
      store.set(CLS_ID, this.idGenerator(req));
    }
    if (initial) {
      applyInitialStoreEntries(store, initial as Record<PropertyKey, unknown>);
    }
    return this.storage.run(store, callback);
  }

  /**
   * Runs `callback` inside a child CLS context initialized with a shallow copy
   * of the currently active parent CLS store (if any), optionally applying `overrides`.
   * Mutations inside the child execution never mutate the parent store.
   */
  runChild<R>(
    callback: () => R,
    overrides?: Partial<TStore> | Record<PropertyKey, unknown>,
  ): R {
    const parentStore = this.storage.getStore();
    const childStore: ClsStore = parentStore
      ? new Map(parentStore)
      : new Map();
    if (!parentStore && this.generateId) {
      childStore.set(CLS_ID, this.idGenerator());
    }
    if (overrides) {
      applyInitialStoreEntries(
        childStore,
        overrides as Record<PropertyKey, unknown>,
      );
    }
    return this.storage.run(childStore, callback);
  }

  /**
   * Runs `callback` with an explicitly constructed `ClsStore` map.
   */
  runWith<T>(store: ClsStore, callback: () => T): T {
    return this.storage.run(store, callback);
  }

  /**
   * Runs `callback` inside an existing CLS context if one is already active,
   * otherwise starts a fresh CLS context.
   */
  runIfNotActive<T>(
    callback: () => T,
    initial?: Partial<TStore> | Record<PropertyKey, unknown>,
    req?: Request,
  ): T {
    if (this.isActive()) {
      return callback();
    }
    return this.run(callback, initial, req);
  }

  /**
   * Enters a fresh CLS context for the remainder of the current async execution frame.
   */
  enter(
    initial?: Partial<TStore> | Record<PropertyKey, unknown>,
    req?: Request,
  ): void {
    const store: ClsStore = new Map();
    if (this.generateId) {
      store.set(CLS_ID, this.idGenerator(req));
    }
    if (initial) {
      applyInitialStoreEntries(store, initial as Record<PropertyKey, unknown>);
    }
    if (typeof this.storage.enterWith !== "function") {
      throw new Error(
        "ClsService.enter() requires an AsyncLocalStorage-compatible ContextStorage implementation.",
      );
    }
    this.storage.enterWith(store);
  }
}

/**
 * HTTP middleware initializing an isolated `ClsService` context for each request.
 */
@Injectable()
export class ClsMiddleware implements BunestMiddleware {
  constructor(
    private readonly cls: ClsService,
    @Optional()
    @Inject(CLS_MODULE_OPTIONS)
    private readonly options: ClsModuleOptions = {},
  ) {}

  use(
    req: Request,
    res: ResponseContext,
    next: NextFunction,
  ): Promise<Response | void> {
    const mwOpts = this.options.middleware;
    const shouldGenerateId =
      mwOpts?.generateId ?? this.options.generateId ?? true;
    const store: ClsStore = new Map();
    if (shouldGenerateId) {
      const id =
        mwOpts?.idGenerator?.(req) ??
        this.options.idGenerator?.(req) ??
        (req.headers.get("x-request-id") || crypto.randomUUID());
      store.set(CLS_ID, id);
    }

    return this.cls.runWith(store, async () => {
      if (this.options.setup) {
        await this.options.setup(this.cls, req);
      }
      if (mwOpts?.setup) {
        await mwOpts.setup(this.cls, req, res);
      }
      return await next();
    });
  }
}

/**
 * Interceptor initializing an isolated `ClsService` context across HTTP, WS, RPC, and GraphQL handlers.
 */
@Injectable()
export class ClsInterceptor implements BunestInterceptor {
  constructor(
    private readonly cls: ClsService,
    @Optional()
    @Inject(CLS_MODULE_OPTIONS)
    private readonly options: ClsModuleOptions = {},
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Promise<unknown> {
    const req =
      context.getType() === "http"
        ? context.switchToHttp().getRequest<Request>()
        : undefined;
    const intOpts = this.options.interceptor;

    if (this.cls.isActive()) {
      return (async () => {
        if (intOpts?.setup) {
          await intOpts.setup(this.cls, context);
        }
        return await next.handle();
      })();
    }

    const shouldGenerateId =
      intOpts?.generateId ?? this.options.generateId ?? true;
    const store: ClsStore = new Map();
    if (shouldGenerateId) {
      const id =
        intOpts?.idGenerator?.(context) ??
        this.options.idGenerator?.(req) ??
        (req?.headers.get("x-request-id") || crypto.randomUUID());
      store.set(CLS_ID, id);
    }

    return this.cls.runWith(store, async () => {
      if (this.options.setup) {
        await this.options.setup(this.cls, req);
      }
      if (intOpts?.setup) {
        await intOpts.setup(this.cls, context);
      }
      return await next.handle();
    });
  }
}

DecoratorRegistry.markInternal(ClsService, ClsMiddleware, ClsInterceptor);
