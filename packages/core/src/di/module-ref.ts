import type {
  BunestTokenRegistry,
  InjectionToken,
  IntrospectionResult,
  Type,
} from "../common/index";
import type {
  ContextId,
  ModuleRefGetOptions,
  ModuleRefHost,
  RequestScopeContainer,
} from "../interfaces/core-types.interface";

/**
 * Injectable module reference enabling dynamic provider lookup (`get`),
 * scoped resolution (`resolve`), and ad-hoc DI instantiation (`create`).
 */
export class ModuleRef {
  constructor(
    private readonly host: ModuleRefHost,
    private readonly moduleId: string,
  ) {}

  /**
   * Synchronously retrieves a resolved singleton provider or controller.
   * Defaults to module-local + visible imports/globals (`strict: true`).
   * Pass `{ strict: false }` to search across all modules, or `{ each: true }`
   * to retrieve all matching instances as an array.
   */
  get<K extends keyof BunestTokenRegistry>(
    token: K,
    options: { strict?: boolean; each: true },
  ): BunestTokenRegistry[K][];
  get<K extends keyof BunestTokenRegistry>(
    token: K,
    options?: { strict?: boolean; each?: false },
  ): BunestTokenRegistry[K];
  get<TInput = unknown, TResult = TInput>(
    token: InjectionToken<TInput>,
    options: { strict?: boolean; each: true },
  ): TResult[];
  get<TInput = unknown, TResult = TInput>(
    token: InjectionToken<TInput>,
    options?: { strict?: boolean; each?: false },
  ): TResult;
  get<TInput = unknown, TResult = TInput>(
    token: InjectionToken<TInput>,
    options?: ModuleRefGetOptions,
  ): TResult | TResult[];
  get<TInput = unknown, TResult = TInput>(
    token: InjectionToken<TInput>,
    options?: ModuleRefGetOptions,
  ): TResult | TResult[] {
    return this.host.getSync<TResult>(
      token as InjectionToken<TResult>,
      this.moduleId,
      options,
    );
  }

  /**
   * Asynchronously resolves a provider of any scope (`SINGLETON`, `TRANSIENT`, `REQUEST`).
   */
  resolve<K extends keyof BunestTokenRegistry>(
    token: K,
    contextIdOrContainer: ContextId | RequestScopeContainer | undefined,
    options: { strict?: boolean; each: true },
  ): Promise<BunestTokenRegistry[K][]>;
  resolve<K extends keyof BunestTokenRegistry>(
    token: K,
    contextIdOrContainer?: ContextId | RequestScopeContainer,
    options?: { strict?: boolean; each?: false },
  ): Promise<BunestTokenRegistry[K]>;
  resolve<TInput = unknown, TResult = TInput>(
    token: InjectionToken<TInput>,
    contextIdOrContainer: ContextId | RequestScopeContainer | undefined,
    options: { strict?: boolean; each: true },
  ): Promise<TResult[]>;
  resolve<TInput = unknown, TResult = TInput>(
    token: InjectionToken<TInput>,
    contextIdOrContainer?: ContextId | RequestScopeContainer,
    options?: { strict?: boolean; each?: false },
  ): Promise<TResult>;
  resolve<TInput = unknown, TResult = TInput>(
    token: InjectionToken<TInput>,
    contextIdOrContainer?: ContextId | RequestScopeContainer,
    options?: ModuleRefGetOptions,
  ): Promise<TResult | TResult[]>;
  resolve<TInput = unknown, TResult = TInput>(
    token: InjectionToken<TInput>,
    contextIdOrContainer?: ContextId | RequestScopeContainer,
    options?: ModuleRefGetOptions,
  ): Promise<TResult | TResult[]> {
    return this.host.resolveAsync<TResult>(
      token as InjectionToken<TResult>,
      this.moduleId,
      contextIdOrContainer,
      options,
    );
  }

  /**
   * Dynamically instantiates a class not registered as a provider, injecting its
   * constructor and property dependencies from this module's DI visibility scope.
   */
  create<T = unknown>(
    type: Type<T>,
    contextIdOrContainer?: ContextId | RequestScopeContainer,
  ): Promise<T> {
    return this.host.createInstance<T>(
      type,
      this.moduleId,
      contextIdOrContainer,
    );
  }

  /**
   * Returns metadata about the registered scope of `token` (NestJS `ModuleRef.introspect()`).
   */
  introspect<T = unknown>(token: InjectionToken<T>): IntrospectionResult {
    return this.host.introspectToken<T>(token, this.moduleId);
  }

  /**
   * Associates a request object with a `ContextId` for resolving `Scope.REQUEST`
   * providers via `moduleRef.resolve(token, contextId)`.
   */
  registerRequestByContextId<T = unknown>(
    request: T,
    contextId: ContextId,
  ): void {
    this.host.registerRequestByContextId<T>(request, contextId);
  }
}
