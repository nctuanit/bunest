import { AsyncLocalStorage } from "node:async_hooks";
import {
  DecoratorRegistry,
  Inject,
  Injectable,
  Optional,
  type BunestInterceptor,
  type BunestMiddleware,
  type CallHandler,
  type ExecutionContext,
  type NextFunction,
  type ResponseContext,
} from "@bunest/common";

export const CLS_MODULE_OPTIONS = Symbol.for("bunest:core:cls_module_options");
export const CLS_ID = Symbol.for("bunest:core:cls_id");

export type ClsStore = Map<string | symbol, unknown>;

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
}

const defaultClsStorage = new AsyncLocalStorage<ClsStore>();

/**
 * Generalized `AsyncLocalStorage`-backed continuation-local storage service
 * usable uniformly across HTTP requests, WebSockets, Queues, Cron jobs,
 * Microservices, and standalone background tasks (`cls.run()`).
 */
@Injectable()
export class ClsService<
  TStore extends Record<PropertyKey, unknown> = Record<string, unknown>,
> {
  private readonly storage: AsyncLocalStorage<ClsStore>;
  private readonly generateId: boolean;
  private readonly idGenerator: (req?: Request) => string;

  constructor(
    @Optional()
    @Inject(CLS_MODULE_OPTIONS)
    options: ClsModuleOptions = {},
    @Optional()
    storage: AsyncLocalStorage<ClsStore> = defaultClsStorage,
  ) {
    this.storage = storage;
    this.generateId = options.generateId ?? true;
    this.idGenerator =
      options.idGenerator ??
      ((req) => req?.headers.get("x-request-id") || crypto.randomUUID());
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
   */
  get<T = unknown>(key: keyof TStore | string | symbol): T | undefined {
    const store = this.storage.getStore();
    return store?.get(key as string | symbol) as T | undefined;
  }

  /**
   * Stores a key/value pair inside the active CLS context.
   * Throws if called outside an active CLS context (`run()` / `enter()` / middleware).
   */
  set<K extends keyof TStore>(key: K, value: TStore[K]): void;
  set<T = unknown>(key: string | symbol, value: T): void;
  set(key: string | symbol, value: unknown): void {
    const store = this.storage.getStore();
    if (!store) {
      throw new Error(
        "ClsService.set() called outside an active CLS context. Wrap execution in cls.run(), ClsMiddleware, or ClsInterceptor.",
      );
    }
    store.set(key, value);
  }

  /**
   * Stores a value only if the key does not already exist in the active store.
   */
  setIfUndefined<T = unknown>(key: string | symbol, value: T): boolean {
    const store = this.storage.getStore();
    if (!store) {
      throw new Error(
        "ClsService.setIfUndefined() called outside an active CLS context.",
      );
    }
    if (store.has(key)) {
      return false;
    }
    store.set(key, value);
    return true;
  }

  has(key: string | symbol): boolean {
    return this.storage.getStore()?.has(key) ?? false;
  }

  delete(key: string | symbol): boolean {
    return this.storage.getStore()?.delete(key) ?? false;
  }

  /**
   * Runs `callback` inside a fresh isolated CLS context (inheriting nothing from outer stores).
   */
  run<T>(
    callback: () => T,
    initial?: Record<string, unknown>,
    req?: Request,
  ): T {
    const store: ClsStore = new Map();
    if (this.generateId) {
      store.set(CLS_ID, this.idGenerator(req));
    }
    if (initial) {
      for (const [k, v] of Object.entries(initial)) {
        store.set(k, v);
      }
    }
    return this.storage.run(store, callback);
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
    initial?: Record<string, unknown>,
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
  enter(initial?: Record<string, unknown>, req?: Request): void {
    const store: ClsStore = new Map();
    if (this.generateId) {
      store.set(CLS_ID, this.idGenerator(req));
    }
    if (initial) {
      for (const [k, v] of Object.entries(initial)) {
        store.set(k, v);
      }
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
    _res: ResponseContext,
    next: NextFunction,
  ): Promise<Response | void> {
    return this.cls.run(
      async () => {
        if (this.options.setup) {
          await this.options.setup(this.cls, req);
        }
        return await next();
      },
      undefined,
      req,
    );
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
    return this.cls.runIfNotActive(
      async () => {
        if (this.options.setup) {
          await this.options.setup(this.cls, req);
        }
        return await next.handle();
      },
      undefined,
      req,
    );
  }
}

DecoratorRegistry.markInternal(ClsService, ClsMiddleware, ClsInterceptor);
