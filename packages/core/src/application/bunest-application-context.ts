import {
  ConsoleLogger,
  Logger,
  ShutdownSignal,
  isDynamicModule,
  type BunestTokenRegistry,
  type DynamicModule,
  type InjectionToken,
  type LogLevel,
  type LoggerService,
  type ProcessErrorHandlersOptions,
  type ProcessErrorOrigin,
  type ProcessErrorShutdownOptions,
  type ShutdownHooksOptions,
  type Type,
} from "../common/index";
import { DIContainer } from "../di/di-container";
import type {
  BunestApplicationContextOptions,
  ContextId,
  LifecycleManagerLike,
  ModuleRefGetOptions,
  RequestScopeContainer,
  ShutdownSignalInput,
} from "../interfaces/core-types.interface";
import { LifecycleManager } from "../lifecycle/lifecycle-manager";
import type { ModuleNode } from "../module/module-node";

interface BufferedLogEntry {
  readonly level: LogLevel;
  readonly message: unknown;
  readonly optionalParams: unknown[];
}

function resolveLoggerService(
  option: BunestApplicationContextOptions["logger"],
): LoggerService {
  if (option && typeof option === "object" && !Array.isArray(option)) {
    return option;
  }
  if (option === false) {
    return new Logger("BunestApplication", { levels: [] });
  }
  if (Array.isArray(option)) {
    return new Logger("BunestApplication", { levels: option });
  }
  return new Logger("BunestApplication");
}

class ApplicationLoggerAdapter implements LoggerService {
  private target: LoggerService;
  private buffering: boolean;
  private readonly buffer: BufferedLogEntry[] = [];

  constructor(initialTarget: LoggerService, bufferLogs: boolean) {
    this.target = initialTarget;
    this.buffering = bufferLogs;
  }

  setTarget(logger: LoggerService, flushNow: boolean): void {
    this.target = logger;
    if (flushNow) {
      this.flush();
    }
  }

  flush(): void {
    if (!this.buffering) {
      return;
    }
    this.buffering = false;
    if (this.buffer.length === 0) {
      return;
    }
    const entries = this.buffer.splice(0, this.buffer.length);
    for (const entry of entries) {
      this.forward(entry.level, entry.message, entry.optionalParams);
    }
  }

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.dispatch("log", message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.dispatch("error", message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.dispatch("warn", message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.dispatch("debug", message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.dispatch("verbose", message, optionalParams);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.dispatch("fatal", message, optionalParams);
  }

  setLogLevels(levels: LogLevel[]): void {
    this.target.setLogLevels?.(levels);
  }

  private dispatch(
    level: LogLevel,
    message: unknown,
    optionalParams: unknown[],
  ): void {
    if (this.buffering) {
      this.buffer.push({ level, message, optionalParams });
      return;
    }
    this.forward(level, message, optionalParams);
  }

  private forward(
    level: LogLevel,
    message: unknown,
    optionalParams: unknown[],
  ): void {
    switch (level) {
      case "log":
        this.target.log(message, ...optionalParams);
        break;
      case "error":
        this.target.error(message, ...optionalParams);
        break;
      case "warn":
        this.target.warn(message, ...optionalParams);
        break;
      case "debug":
        this.target.debug?.(message, ...optionalParams);
        break;
      case "verbose":
        this.target.verbose?.(message, ...optionalParams);
        break;
      case "fatal":
        this.target.fatal?.(message, ...optionalParams);
        break;
    }
  }
}

/**
 * Standalone Bunest application context (DI + Modules + Lifecycle without HTTP server),
 * created via `BunestFactory.createApplicationContext(AppModule)`.
 */
export class BunestApplicationContext {
  protected readonly lifecycle: LifecycleManagerLike;
  protected readonly loggerAdapter: ApplicationLoggerAdapter;
  protected logger: LoggerService;
  protected isInitialized = false;
  protected isClosed = false;
  protected initPromise?: Promise<this>;
  protected scopeModuleId: string;
  protected readonly strictDefault: boolean;
  protected contextModule?: ModuleNode;
  protected readonly appOptions: BunestApplicationContextOptions;
  private didOverrideGlobalLogger = false;
  private previousGlobalLogger?: LoggerService;
  private readonly processErrorListeners: Array<{
    event: ProcessErrorOrigin;
    handler: (...args: any[]) => void;
  }> = [];
  private processErrorShutdownPromise?: Promise<void>;

  constructor(
    protected readonly container: DIContainer,
    protected readonly options: BunestApplicationContextOptions = {},
    scopeModuleId?: string,
    strictDefault = false,
  ) {
    this.appOptions = options;
    this.lifecycle = options.lifecycleManager ?? new LifecycleManager();
    this.scopeModuleId = scopeModuleId ?? this.container.getGraph().root.id;
    this.strictDefault = strictDefault;
    this.selectContextModule();

    this.container.setOnLazyModuleLoaded(async (groups) => {
      if (this.lifecycle.callModuleInitFor) {
        await this.lifecycle.callModuleInitFor(groups);
        return;
      }
      for (const group of groups) {
        for (const instance of group.instances) {
          const hook = (
            instance as { onModuleInit?: () => Promise<void> | void }
          ).onModuleInit;
          if (typeof hook === "function") {
            await hook.call(instance);
          }
        }
      }
    });

    if ((options as { forceConsole?: boolean }).forceConsole === true) {
      if (!this.didOverrideGlobalLogger) {
        this.didOverrideGlobalLogger = true;
        this.previousGlobalLogger = Logger.staticInstanceRef;
      }
      Logger.overrideLogger(new ConsoleLogger({ forceConsole: true }));
    }

    const initialLogger = resolveLoggerService(options.logger);
    this.loggerAdapter = new ApplicationLoggerAdapter(
      initialLogger,
      options.bufferLogs === true,
    );
    this.logger = this.loggerAdapter;

    if (options.bufferLogs === true) {
      if (!this.didOverrideGlobalLogger) {
        this.didOverrideGlobalLogger = true;
        this.previousGlobalLogger = Logger.staticInstanceRef;
      }
      Logger.overrideLogger(this.loggerAdapter);
      Logger.attachBuffer();
    }

    if (options.shutdownHooks) {
      this.enableShutdownHooks();
    }
  }

  async init(): Promise<this> {
    if (this.isInitialized && this.lifecycle.getIsInitialized()) {
      return this;
    }
    if (this.initPromise) {
      return this.initPromise;
    }
    const runInit = async (): Promise<this> => {
      try {
        const groups = this.container.getSingletonInstancesByModule();
        await this.lifecycle.callModuleInit(groups);
        await this.lifecycle.callApplicationBootstrap(groups);
        this.isInitialized = true;
        return this;
      } catch (err) {
        this.flushLogsIfAutoFlushEnabled();
        this.restoreGlobalLogger();
        throw err;
      } finally {
        this.flushLogsIfAutoFlushEnabled();
      }
    };
    this.initPromise = runInit();
    try {
      return await this.initPromise;
    } finally {
      this.initPromise = undefined;
    }
  }

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
    const resolvedOptions: ModuleRefGetOptions = {
      strict: options?.strict ?? this.strictDefault,
      each: options?.each,
    };
    try {
      return this.container.getSync<TResult>(
        token as InjectionToken<TResult>,
        this.scopeModuleId,
        resolvedOptions,
      );
    } catch (err) {
      if (this.options.abortOnError === true) {
        process.exit(1);
        return undefined as unknown as TResult;
      }
      throw err;
    }
  }

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
    const resolvedOptions: ModuleRefGetOptions = {
      strict: options?.strict ?? this.strictDefault,
      each: options?.each,
    };
    return this.container.resolveAsync<TResult>(
      token as InjectionToken<TResult>,
      this.scopeModuleId,
      contextIdOrContainer,
      resolvedOptions,
    );
  }

  /**
   * Registers a request object against a `ContextId` so `Scope.REQUEST` providers
   * injecting `@Inject(REQUEST)` can be resolved via `resolve(token, contextId)`
   * without spinning up an HTTP server.
   */
  registerRequestByContextId<T = unknown>(
    request: T,
    contextId: ContextId,
  ): void {
    this.container.registerRequestByContextId(request, contextId);
  }

  /**
   * Narrows provider lookups (`get`/`resolve`) to a specific module in the graph,
   * defaulting to `{ strict: true }`. Chainable and supports `DynamicModule` references.
   */
  select<T>(
    moduleType: Type<T> | DynamicModule,
    selectOptions?: { abortOnError?: boolean },
  ): BunestApplicationContext {
    const effectiveAbortOnError =
      selectOptions?.abortOnError ?? this.options.abortOnError;
    const targetNode = this.findModuleNode(moduleType);
    if (!targetNode) {
      if (effectiveAbortOnError === true) {
        process.exit(1);
        return this;
      }
      const label = isDynamicModule(moduleType)
        ? moduleType.module.name || "<DynamicModule>"
        : moduleType.name || "<anonymous>";
      throw new Error(
        `Module "${label}" is not part of this application module graph.`,
      );
    }

    return new BunestApplicationContext(
      this.container,
      {
        ...this.options,
        ...(selectOptions?.abortOnError !== undefined
          ? { abortOnError: selectOptions.abortOnError }
          : {}),
        shutdownHooks: false,
        lifecycleManager: this.lifecycle,
      },
      targetNode.id,
      true,
    );
  }

  useLogger(logger: LoggerService | LogLevel[] | false): this {
    const resolved = resolveLoggerService(logger);
    const shouldAutoFlush = this.options.autoFlushLogs !== false;
    this.loggerAdapter.setTarget(resolved, shouldAutoFlush);
    return this;
  }

  flushLogs(): void {
    this.loggerAdapter.flush();
    if (this.options.bufferLogs === true) {
      Logger.flush();
    }
  }

  flushLogsOnOverride(): void {
    this.flushLogsIfAutoFlushEnabled();
  }

  selectContextModule(): void {
    const graph = this.container.getGraph();
    this.contextModule = graph.modules.get(this.scopeModuleId) ?? graph.root;
    this.scopeModuleId = this.contextModule.id;
  }

  getLogger(): LoggerService {
    return this.logger;
  }

  /**
   * Destroys a cached durable DI sub-tree container (firing `onRequestDestroy` /
   * `Symbol.asyncDispose` / `Symbol.dispose` hooks on all durable instances).
   */
  async destroyDurableContext(
    contextIdOrId: ContextId | number | symbol,
  ): Promise<void> {
    await this.container.destroyDurableContext(contextIdOrId);
  }

  getLifecycleManager(): LifecycleManagerLike {
    return this.lifecycle;
  }

  getModuleContainer(): DIContainer {
    return this.container;
  }

  getModules(): ReadonlyMap<string, ModuleNode> {
    return this.container.getGraph().modules;
  }

  enableShutdownHooks(
    signals: readonly ShutdownSignalInput[] = [
      ShutdownSignal.SIGINT,
      ShutdownSignal.SIGTERM,
    ],
    options?: ShutdownHooksOptions,
  ): this {
    this.listenToShutdownSignals(signals, options);
    return this;
  }

  /**
   * Registers opt-in `unhandledRejection` and `uncaughtException` process listeners
   * with a re-entrancy-guarded, timeout-bounded graceful `shutdown()` helper.
   * Listeners are automatically removed on `close()`.
   */
  enableProcessErrorHandlers(
    options: ProcessErrorHandlersOptions = {},
  ): this {
    this.cleanupProcessErrorHandlers();

    const triggerShutdown = (
      origin: ProcessErrorOrigin,
      shutdownOptions?: ProcessErrorShutdownOptions,
    ): Promise<void> => {
      if (this.processErrorShutdownPromise) {
        return this.processErrorShutdownPromise;
      }

      const exitCode = shutdownOptions?.exitCode ?? 1;
      const timeoutMs = shutdownOptions?.timeout ?? 5000;

      this.processErrorShutdownPromise = (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const closePromise = this.close(origin).catch((closeErr) => {
            this.logger.error(
              `Error during graceful shutdown after ${origin}: ${
                closeErr instanceof Error ? closeErr.message : String(closeErr)
              }`,
            );
          });
          if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
            await Promise.race([
              closePromise,
              new Promise<void>((resolve) => {
                timer = setTimeout(resolve, timeoutMs);
                if (typeof timer.unref === "function") {
                  timer.unref();
                }
              }),
            ]);
          } else {
            await closePromise;
          }
        } finally {
          if (timer !== undefined) {
            clearTimeout(timer);
          }
        }
        process.exit(exitCode);
      })();

      return this.processErrorShutdownPromise;
    };

    const registerHandler = (
      origin: ProcessErrorOrigin,
      customHandler:
        | ProcessErrorHandlersOptions["unhandledRejection"]
        | ProcessErrorHandlersOptions["uncaughtException"],
    ): void => {
      if (customHandler === false) {
        return;
      }
      const handler = (error: unknown) => {
        const ctx = {
          origin,
          shutdown: (shutdownOptions?: ProcessErrorShutdownOptions) =>
            triggerShutdown(origin, shutdownOptions),
        };
        if (typeof customHandler === "function") {
          void Promise.resolve(customHandler(error, ctx)).catch((handlerErr) => {
            this.logger.error(
              `Error in ${origin} handler: ${
                handlerErr instanceof Error
                  ? handlerErr.message
                  : String(handlerErr)
              }`,
            );
          });
          return;
        }
        this.logger.error(
          `Unhandled ${origin}: ${
            error instanceof Error ? error.stack ?? error.message : String(error)
          }`,
        );
        void ctx.shutdown();
      };
      process.on(origin, handler);
      this.processErrorListeners.push({ event: origin, handler });
    };

    registerHandler("unhandledRejection", options.unhandledRejection);
    registerHandler("uncaughtException", options.uncaughtException);

    return this;
  }

  protected cleanupProcessErrorHandlers(): void {
    for (const { event, handler } of this.processErrorListeners) {
      process.removeListener(event, handler);
    }
    this.processErrorListeners.length = 0;
  }

  async close(signal?: string): Promise<void> {
    this.cleanupProcessErrorHandlers();
    if (this.initPromise) {
      await this.initPromise.catch(() => {});
    }
    if (this.isClosed && this.lifecycle.getIsClosed()) {
      this.lifecycle.cleanupShutdownHooks();
      return;
    }
    this.isClosed = true;
    const prep = this.prepareClose();
    if (prep) {
      await prep;
    }
    if (this.lifecycle.getIsClosed()) {
      try {
        await this.dispose();
      } finally {
        await this.container.destroyContextContainers();
        this.restoreGlobalLogger();
      }
      return;
    }
    const groups = this.container.getSingletonInstancesByModule();
    try {
      await this.lifecycle.callShutdown(groups, signal, () => {
        const disposed = this.dispose();
        if (disposed) {
          return disposed.then(() => this.container.destroyContextContainers());
        }
        return this.container.destroyContextContainers();
      });
    } finally {
      this.restoreGlobalLogger();
    }
  }

  protected restoreGlobalLogger(): void {
    if (this.didOverrideGlobalLogger) {
      this.didOverrideGlobalLogger = false;
      Logger.detachBuffer();
      Logger.overrideLogger(this.previousGlobalLogger ?? true);
      this.previousGlobalLogger = undefined;
    }
  }

  protected stopTransport(): Promise<void> | void {
    // Subclasses (e.g. BunestApplication) override to stop HTTP/WS servers before destroy hooks
  }

  protected dispose(): Promise<void> | void {
    return this.stopTransport();
  }

  protected flushLogsIfAutoFlushEnabled(): void {
    if (this.options.autoFlushLogs !== false) {
      this.flushLogs();
    }
  }

  protected assertNotInPreviewMode(methodName: string): void {
    if (this.options.preview) {
      throw new Error(
        `Calling "${methodName}" is not allowed when the application is running in preview mode.`,
      );
    }
  }

  protected async callInitHook(): Promise<void> {
    const groups = this.container.getSingletonInstancesByModule();
    await this.lifecycle.callModuleInit(groups);
  }

  protected async callBootstrapHook(): Promise<void> {
    const groups = this.container.getSingletonInstancesByModule();
    await this.lifecycle.callApplicationBootstrap(groups);
  }

  protected async callApplicationListenHook(): Promise<void> {
    const groups = this.container.getSingletonInstancesByModule();
    await this.lifecycle.callApplicationListen?.(groups);
  }

  protected async callDestroyHook(): Promise<void> {
    const groups = this.container.getSingletonInstancesByModule();
    await this.lifecycle.callShutdown(groups);
  }

  protected async callBeforeShutdownHook(signal?: string): Promise<void> {
    const groups = this.container.getSingletonInstancesByModule();
    await this.lifecycle.callShutdown(groups, signal);
  }

  protected async callShutdownHook(signal?: string): Promise<void> {
    await this.close(signal);
  }

  protected prepareClose(): Promise<void> | void {
    // Subclasses override to enter closing/draining state before shutdown hooks
  }

  protected async shutdown(signal?: string): Promise<void> {
    await this.close(signal);
  }

  protected listenToShutdownSignals(
    signals: readonly ShutdownSignalInput[],
    options?: ShutdownHooksOptions,
  ): void {
    this.lifecycle.enableShutdownHooks(
      signals,
      async (sig) => {
        await this.close(sig);
      },
      options,
    );
  }

  protected unsubscribeFromProcessSignals(): void {
    this.lifecycle.cleanupShutdownHooks();
  }

  protected find<TInput = any, TResult = TInput>(
    typeOrToken: InjectionToken<TInput>,
    options?: { moduleId?: string; each?: boolean },
  ): TResult | TResult[] {
    return this.container.getSync<TResult>(
      typeOrToken as InjectionToken<TResult>,
      options?.moduleId ?? this.scopeModuleId,
      {
        strict: options?.moduleId !== undefined ? true : this.strictDefault,
        each: options?.each,
      },
    );
  }

  protected resolvePerContext<TInput = any, TResult = TInput>(
    typeOrToken: InjectionToken<TInput>,
    contextModule: ModuleNode,
    contextId: ContextId,
    options?: ModuleRefGetOptions,
  ): Promise<TResult | TResult[]> {
    return this.container.resolveAsync<TResult>(
      typeOrToken as InjectionToken<TResult>,
      contextModule.id,
      contextId,
      options,
    );
  }

  protected findModuleNode<T>(
    moduleType: Type<T> | DynamicModule,
  ): ModuleNode | undefined {
    const graph = this.container.getGraph();

    // 1. Exact DynamicModule object match
    if (isDynamicModule(moduleType)) {
      const exact = graph.dynamicModuleMap?.get(moduleType);
      if (exact) {
        return exact;
      }
    }

    const targetClass = isDynamicModule(moduleType)
      ? moduleType.module
      : moduleType;
    const preferDynamic = isDynamicModule(moduleType);

    // 2. Prefer direct/reachable import from current selected module (disambiguates nested modules)
    const currentNode = graph.modules.get(this.scopeModuleId);
    if (currentNode) {
      const visited = new Set<ModuleNode>();
      const queue: ModuleNode[] = [...currentNode.imports];
      let fallbackInSubtree: ModuleNode | undefined;

      while (queue.length > 0) {
        const candidate = queue.shift()!;
        if (visited.has(candidate)) continue;
        visited.add(candidate);

        if (candidate.metatype === targetClass) {
          if (!preferDynamic || candidate.isDynamic) {
            return candidate;
          }
          fallbackInSubtree ??= candidate;
        }
        for (const imp of candidate.imports) {
          if (!visited.has(imp)) {
            queue.push(imp);
          }
        }
      }
      if (fallbackInSubtree) {
        return fallbackInSubtree;
      }
    }

    // 3. Fallback across entire module graph
    let fallback: ModuleNode | undefined;
    for (const mod of graph.modules.values()) {
      if (mod.metatype === targetClass) {
        if (!preferDynamic || mod.isDynamic) {
          return mod;
        }
        fallback ??= mod;
      }
    }
    return fallback;
  }
}
