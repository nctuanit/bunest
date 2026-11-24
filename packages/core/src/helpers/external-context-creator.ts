import {
  APP_FILTER,
  APP_GUARD,
  APP_INTERCEPTOR,
  APP_PIPE,
  DESIGN_METADATA_KEYS,
  DecoratorRegistry,
  ForbiddenException,
  Injectable,
  METADATA_KEYS,
  MetadataRegistry,
  type ArgumentMetadata,
  type ArgumentsHost,
  type BunestInterceptor,
  type CallHandler,
  type CanActivate,
  type ContextType,
  type ExceptionFilter,
  type ExceptionFilterLike,
  type ExecutionContext,
  type GuardLike,
  type HttpArgumentsHost,
  type InjectionToken,
  type InterceptorLike,
  type ParamData,
  type PipeLike,
  type PipeTransform,
  type RpcArgumentsHost,
  type Type,
  type WsArgumentsHost,
} from "../common/index";
import type { ModulesContainer } from "../di/modules-container";
import type { ContextId } from "../interfaces/core-types.interface";
import type { ModuleNode } from "../module/module-node";

export interface ParamsFactory {
  exchangeKeyForValue(
    type: number | string,
    data: ParamData,
    args: unknown[],
  ): unknown;
}

export interface ExternalContextOptions {
  guards?: boolean;
  interceptors?: boolean;
  filters?: boolean;
  pipes?: boolean;
  callback?: (result: unknown, ...args: unknown[]) => unknown;
}

export interface ParamProperties<
  T = unknown,
  IExtractor extends (...args: unknown[]) => unknown = (...args: unknown[]) => unknown,
> {
  index: number;
  type: T | string;
  data: ParamData;
  pipes: PipeTransform[];
  extractValue: IExtractor;
  metatype?: unknown;
}

export interface ExternalHandlerMetadata {
  argsLength: number;
  paramtypes: unknown[];
  getParamsMetadata: (
    moduleKey: string,
    contextId?: ContextId,
    inquirerId?: string,
  ) => (ParamProperties & { metatype?: unknown })[];
  fnHandleResponse?: (...args: any[]) => unknown;
}

export type ExternalEnhancerKind = "guard" | "pipe" | "interceptor" | "filter";

/**
 * Narrow structural interface for `DIContainer` / `NestContainer` so
 * `ExternalContextCreator.fromContainer(container)` keeps zero circular imports.
 */
export interface ExternalContextContainerLike {
  resolveEnhancer<T = unknown>(
    enhancer: Type<T> | T,
    requestContainer?: unknown,
    owningModule?: ModuleNode,
    kind?: ExternalEnhancerKind,
  ): Promise<T> | T;
  getModulesContainer?(): ModulesContainer;
  getModules?(): ModulesContainer;
  getModuleByKey?(moduleKey: string): ModuleNode | undefined;
  getOrCreateContextContainer?(contextId: ContextId): unknown;
  getMultiProviderEntries?(token: InjectionToken): ReadonlyArray<{
    module: ModuleNode;
    provider: { useClass?: Type<unknown> };
    instance?: unknown;
    syntheticToken?: Type<unknown>;
  }>;
  getApplicationConfig?(): {
    getGlobalGuards(): readonly GuardLike[];
    getGlobalPipes(): readonly PipeLike[];
    getGlobalInterceptors(): readonly InterceptorLike[];
    getGlobalFilters(): readonly ExceptionFilterLike[];
  };
  discoverProviders?(): ReadonlyArray<{
    instance?: unknown;
    moduleId: string;
  }>;
  discoverControllers?(): ReadonlyArray<{
    instance?: unknown;
    moduleId: string;
  }>;
  registerRequestByContextId?<T = unknown>(
    request: T,
    contextId: ContextId,
  ): void;
  registerRequestProvider?<T = unknown>(request: T, contextId: ContextId): void;
}

interface ScopedEnhancerSpec<T> {
  readonly spec: T;
  readonly owningModule?: ModuleNode;
}

class GenericExternalExecutionContext implements ExecutionContext {
  constructor(
    private readonly args: unknown[],
    private readonly constructorRef: Type<unknown>,
    private readonly handler: Function,
    private readonly contextType: string,
  ) {}

  getClass<T = unknown>(): Type<T> {
    return this.constructorRef as Type<T>;
  }

  getHandler(): Function {
    return this.handler;
  }

  getArgs<T extends Array<unknown> = unknown[]>(): T {
    return this.args as T;
  }

  getArgByIndex<T = unknown>(index: number): T {
    return this.args[index] as T;
  }

  switchToHttp(): HttpArgumentsHost {
    return {
      getRequest: <T = unknown>() => this.args[0] as T,
      getResponse: <T = unknown>() => this.args[1] as T,
      getNext: <T = unknown>() => this.args[2] as T,
    };
  }

  switchToRpc(): RpcArgumentsHost {
    return {
      getData: <T = unknown>() => this.args[0] as T,
      getContext: <T = unknown>() => this.args[1] as T,
    };
  }

  switchToWs(): WsArgumentsHost {
    return {
      getClient: <T = unknown>() => this.args[0] as T,
      getData: <T = unknown>() => this.args[1] as T,
      getPattern: () => String(this.args[2] ?? ""),
    };
  }

  getType<TContext extends string = ContextType>(): TContext {
    return this.contextType as TContext;
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as PromiseLike<unknown>).then === "function"
  );
}

function isSubscribableLike(value: unknown): value is {
  subscribe: (observer: {
    next?: (v: unknown) => void;
    error?: (e: unknown) => void;
    complete?: () => void;
  }) => { unsubscribe?: () => void } | void;
} {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { subscribe?: unknown }).subscribe === "function"
  );
}

/**
 * Reusable execution wrapper for external contexts (GraphQL, WebSockets,
 * Microservices, custom decorators) matching NestJS v12 `ExternalContextCreator`
 * (10/10 public members).
 */
@Injectable()
export class ExternalContextCreator {
  private readonly modulesContainer?: ModulesContainer;
  private readonly container?: ExternalContextContainerLike;

  constructor(
    private readonly resolveEnhancerFn?: <T = unknown>(
      enhancer: Type<T> | T,
    ) => Promise<T> | T,
    modulesContainer?: ModulesContainer,
    container?: ExternalContextContainerLike,
  ) {
    this.modulesContainer =
      modulesContainer ??
      container?.getModulesContainer?.() ??
      container?.getModules?.();
    this.container = container;
  }

  /**
   * Factory creating an `ExternalContextCreator` backed by a `DIContainer` / `NestContainer`
   * (matching NestJS `ExternalContextCreator.fromContainer(container)`).
   */
  static fromContainer(
    container: ExternalContextContainerLike,
  ): ExternalContextCreator {
    return new ExternalContextCreator(
      (enhancer) => container.resolveEnhancer(enhancer),
      container.getModulesContainer?.() ?? container.getModules?.(),
      container,
    );
  }

  private async resolve<T>(
    enhancer: Type<T> | T,
    requestContainer?: unknown,
    owningModule?: ModuleNode,
    kind?: ExternalEnhancerKind,
  ): Promise<T> {
    if (typeof enhancer !== "function") {
      return enhancer;
    }
    if (this.container) {
      return await this.container.resolveEnhancer<T>(
        enhancer,
        requestContainer,
        owningModule,
        kind,
      );
    }
    if (this.resolveEnhancerFn) {
      return await this.resolveEnhancerFn<T>(enhancer);
    }
    return new (enhancer as Type<T>)();
  }

  private resolveOwningModule(
    instance: object,
    ctor: Type<unknown>,
    inquirerId?: string,
  ): ModuleNode | undefined {
    if (inquirerId) {
      const byId =
        this.modulesContainer?.getById(inquirerId) ??
        this.container?.getModuleByKey?.(inquirerId);
      if (byId) {
        return byId;
      }
    }

    // Match exact singleton instance identity when multiple modules provide the same class.
    if (this.container?.discoverProviders) {
      for (const wrapper of this.container.discoverProviders()) {
        if (wrapper.instance === instance) {
          const mod =
            this.modulesContainer?.getById(wrapper.moduleId) ??
            this.container.getModuleByKey?.(wrapper.moduleId);
          if (mod) {
            return mod;
          }
        }
      }
    }
    if (this.container?.discoverControllers) {
      for (const wrapper of this.container.discoverControllers()) {
        if (wrapper.instance === instance) {
          const mod =
            this.modulesContainer?.getById(wrapper.moduleId) ??
            this.container.getModuleByKey?.(wrapper.moduleId);
          if (mod) {
            return mod;
          }
        }
      }
    }

    // Fallback: match by provider/controller metatype or useClass
    if (this.modulesContainer) {
      for (const mod of this.modulesContainer.values()) {
        if (mod.providers.has(ctor) || mod.controllers.includes(ctor)) {
          return mod;
        }
        for (const p of mod.providers.values()) {
          if (p.useClass === ctor) {
            return mod;
          }
        }
      }
    }
    return undefined;
  }

  private collectGlobalEnhancers<T>(
    token: InjectionToken,
    imperative: readonly T[],
  ): ScopedEnhancerSpec<T>[] {
    const out: ScopedEnhancerSpec<T>[] = [];
    const entries = this.container?.getMultiProviderEntries?.(token) ?? [];
    for (const entry of entries) {
      if (entry.syntheticToken) {
        out.push({
          spec: entry.syntheticToken as unknown as T,
          owningModule: entry.module,
        });
      } else if (entry.instance !== undefined) {
        out.push({
          spec: entry.instance as T,
          owningModule: entry.module,
        });
      } else if (entry.provider.useClass) {
        out.push({
          spec: entry.provider.useClass as unknown as T,
          owningModule: entry.module,
        });
      }
    }
    for (const item of imperative) {
      out.push({ spec: item });
    }
    return out;
  }

  getContextModuleKey(moduleCtor: Function | undefined): string {
    if (!moduleCtor || !this.modulesContainer) {
      return "";
    }
    for (const [key, mod] of this.modulesContainer.entries()) {
      if (mod.metatype === moduleCtor) {
        return key;
      }
    }
    return "";
  }

  registerRequestProvider<T = unknown>(request: T, contextId: ContextId): void {
    if (this.container?.registerRequestByContextId) {
      this.container.registerRequestByContextId(request, contextId);
    } else if (this.container?.registerRequestProvider) {
      this.container.registerRequestProvider(request, contextId);
    }
  }

  async transformToResult(resultOrDeferred: unknown): Promise<unknown> {
    if (isThenable(resultOrDeferred)) {
      return await resultOrDeferred;
    }
    if (isSubscribableLike(resultOrDeferred)) {
      return await new Promise<unknown>((resolve, reject) => {
        let lastValue: unknown;
        let hasValue = false;
        resultOrDeferred.subscribe({
          next: (val) => {
            lastValue = val;
            hasValue = true;
          },
          error: (err) => reject(err),
          complete: () => resolve(hasValue ? lastValue : undefined),
        });
      });
    }
    return resultOrDeferred;
  }

  async getParamValue<T>(
    value: T,
    metadata: ArgumentMetadata,
    pipes: ReadonlyArray<PipeTransform | Type<PipeTransform>>,
  ): Promise<unknown> {
    let current: unknown = value;
    for (let i = 0; i < pipes.length; i++) {
      const rawPipe = pipes[i];
      if (rawPipe) {
        const pipe =
          typeof rawPipe === "function"
            ? await this.resolve<PipeTransform>(rawPipe)
            : rawPipe;
        current = await pipe.transform(current, metadata);
      }
    }
    return current;
  }

  exchangeKeysForValues<
    TMetadata extends Record<string, unknown> = Record<string, unknown>,
  >(
    keys: string[],
    metadata: TMetadata,
    _moduleContext: string,
    paramsFactory: ParamsFactory,
    _contextId?: ContextId,
    _inquirerId?: string,
    contextFactory: (args: unknown[]) => ExecutionContext = (args) =>
      new GenericExternalExecutionContext(
        args,
        Object as unknown as Type<unknown>,
        () => undefined,
        "http",
      ),
  ): ParamProperties[] {
    return keys.map((key) => {
      const entry = (metadata[key] ?? {}) as {
        type?: number | string;
        source?: number | string;
        data?: ParamData;
        pipes?: PipeLike[];
        factory?: (data: ParamData, ctx: ExecutionContext) => unknown;
        index?: number;
      };
      const rawType =
        entry.type !== undefined
          ? entry.type
          : entry.source !== undefined
            ? entry.source
            : (key.split(":")[0] ?? key);
      let resolvedType: number | string = rawType;
      if (typeof rawType === "string") {
        const numericType = Number(rawType);
        resolvedType =
          rawType !== "" && !Number.isNaN(numericType) ? numericType : rawType;
      }
      const data = entry.data as ParamData;
      const pipes: PipeTransform[] = Array.isArray(entry.pipes)
        ? entry.pipes.map((p: PipeLike): PipeTransform => {
            if (typeof p !== "function") {
              return p;
            }
            return {
              transform: async (value: unknown, meta: ArgumentMetadata) => {
                const resolvedPipe = await this.resolve<PipeTransform>(p);
                return resolvedPipe.transform(value, meta);
              },
            };
          })
        : [];
      const customFactory =
        typeof entry.factory === "function" ? entry.factory : undefined;

      const extractValue = (...args: unknown[]) => {
        if (customFactory) {
          return customFactory(data, contextFactory(args));
        }
        return paramsFactory.exchangeKeyForValue(resolvedType, data, args);
      };

      return {
        index: typeof entry.index === "number" ? entry.index : 0,
        type: resolvedType,
        data,
        pipes,
        extractValue,
      };
    });
  }

  getMetadata<
    TMetadata extends Record<string, unknown> = Record<string, unknown>,
    TContext extends string = ContextType,
  >(
    instance: object,
    methodName: string | symbol,
    metadataKey?: string | symbol,
    paramsFactory?: ParamsFactory,
    contextType: TContext = "http" as TContext,
  ): ExternalHandlerMetadata {
    const ctor = instance.constructor as Type<unknown>;
    const proto = Object.getPrototypeOf(instance) as object | null;
    const paramtypes: unknown[] =
      (proto
        ? MetadataRegistry.get<unknown[]>(
            DESIGN_METADATA_KEYS.PARAMTYPES,
            proto,
            methodName,
          )
        : undefined) ?? [];

    const rawMetadata = metadataKey
      ? ((proto
          ? MetadataRegistry.get<TMetadata>(metadataKey, proto, methodName)
          : undefined) ??
        MetadataRegistry.get<TMetadata>(metadataKey, ctor, methodName))
      : undefined;

    const keys = rawMetadata ? Object.keys(rawMetadata) : [];
    const callback = (instance as Record<string | symbol, unknown>)[methodName];
    let argsLength = paramtypes.length;
    if (rawMetadata) {
      for (const k of keys) {
        const idx = (rawMetadata[k] as { index?: number } | undefined)?.index;
        if (typeof idx === "number" && idx + 1 > argsLength) {
          argsLength = idx + 1;
        }
      }
    }

    return {
      argsLength,
      paramtypes,
      getParamsMetadata: (
        moduleKey: string,
        contextId?: ContextId,
        inquirerId?: string,
      ) => {
        if (!rawMetadata || !paramsFactory) {
          return [];
        }
        const exchanged = this.exchangeKeysForValues(
          keys,
          rawMetadata,
          moduleKey,
          paramsFactory,
          contextId,
          inquirerId,
          (args) =>
            new GenericExternalExecutionContext(
              args,
              ctor,
              typeof callback === "function" ? callback : () => undefined,
              contextType,
            ),
        );
        return exchanged.map((item) => ({
          ...item,
          metatype: paramtypes[item.index],
        }));
      },
    };
  }

  createGuardsFn<TContext extends string = ContextType>(
    guards: readonly GuardLike[],
    instance: object,
    callback: (...args: any[]) => unknown,
    contextType: TContext = "http" as TContext,
  ): ((args: unknown[]) => Promise<void>) | null {
    if (!guards || guards.length === 0) {
      return null;
    }
    const ctor = instance.constructor as Type<unknown>;
    return async (args: unknown[]) => {
      const ctx = new GenericExternalExecutionContext(
        args,
        ctor,
        callback,
        contextType,
      );
      for (let i = 0; i < guards.length; i++) {
        const guard = await this.resolve<CanActivate>(guards[i]!);
        const allowed = await guard.canActivate(ctx);
        if (!allowed) {
          throw new ForbiddenException("Forbidden resource");
        }
      }
    };
  }

  createPipesFn(
    pipes: PipeTransform[],
    paramsOptions: (ParamProperties & { metatype?: unknown })[],
  ): ((args: unknown[], ...params: unknown[]) => Promise<void>) | null {
    if (!paramsOptions || paramsOptions.length === 0) {
      return null;
    }
    return async (args: unknown[], ...params: unknown[]) => {
      for (let i = 0; i < paramsOptions.length; i++) {
        const param = paramsOptions[i];
        if (!param) continue;
        const rawValue = await param.extractValue(...params);
        const combinedPipes = [...pipes, ...(param.pipes ?? [])];
        const metadata: ArgumentMetadata = {
          type: "custom",
          metatype: param.metatype as Type<unknown> | Function | undefined,
          data: typeof param.data === "string" ? param.data : undefined,
        };
        args[param.index] = await this.getParamValue(
          rawValue,
          metadata,
          combinedPipes,
        );
      }
    };
  }

  create<
    TParamsMetadata extends Record<string, unknown> = Record<string, unknown>,
    TContext extends string = ContextType,
  >(
    instance: object,
    callback: (...args: unknown[]) => unknown,
    methodName: string | symbol,
    metadataKey?: string | symbol,
    paramsFactory?: ParamsFactory,
    contextId?: ContextId,
    inquirerId?: string,
    options: ExternalContextOptions = {
      guards: true,
      interceptors: true,
      filters: true,
      pipes: true,
    },
    contextType: TContext = "http" as TContext,
  ): (...args: unknown[]) => Promise<unknown> {
    const ctor = instance.constructor as Type<unknown>;
    const owningModule = this.resolveOwningModule(instance, ctor, inquirerId);
    const appConfig = this.container?.getApplicationConfig?.();

    const guardSpecs: ScopedEnhancerSpec<GuardLike>[] =
      options.guards !== false
        ? [
            ...this.collectGlobalEnhancers<GuardLike>(
              APP_GUARD,
              appConfig?.getGlobalGuards() ?? [],
            ),
            ...MetadataRegistry.getMergedClassArray<GuardLike>(
              METADATA_KEYS.GUARDS,
              ctor,
            ).map((spec) => ({ spec, owningModule })),
            ...(
              MetadataRegistry.get<readonly GuardLike[]>(
                METADATA_KEYS.GUARDS,
                callback,
              ) ?? []
            ).map((spec) => ({ spec, owningModule })),
          ]
        : [];
    const interceptorSpecs: ScopedEnhancerSpec<InterceptorLike>[] =
      options.interceptors !== false
        ? [
            ...this.collectGlobalEnhancers<InterceptorLike>(
              APP_INTERCEPTOR,
              appConfig?.getGlobalInterceptors() ?? [],
            ),
            ...MetadataRegistry.getMergedClassArray<InterceptorLike>(
              METADATA_KEYS.INTERCEPTORS,
              ctor,
            ).map((spec) => ({ spec, owningModule })),
            ...(
              MetadataRegistry.get<readonly InterceptorLike[]>(
                METADATA_KEYS.INTERCEPTORS,
                callback,
              ) ?? []
            ).map((spec) => ({ spec, owningModule })),
          ]
        : [];
    const pipeSpecs: ScopedEnhancerSpec<PipeLike>[] =
      options.pipes !== false
        ? [
            ...this.collectGlobalEnhancers<PipeLike>(
              APP_PIPE,
              appConfig?.getGlobalPipes() ?? [],
            ),
            ...MetadataRegistry.getMergedClassArray<PipeLike>(
              METADATA_KEYS.PIPES,
              ctor,
            ).map((spec) => ({ spec, owningModule })),
            ...(
              MetadataRegistry.get<readonly PipeLike[]>(
                METADATA_KEYS.PIPES,
                callback,
              ) ?? []
            ).map((spec) => ({ spec, owningModule })),
          ]
        : [];
    const filterSpecs: ScopedEnhancerSpec<ExceptionFilterLike>[] =
      options.filters !== false
        ? [
            ...(
              MetadataRegistry.get<readonly ExceptionFilterLike[]>(
                METADATA_KEYS.EXCEPTION_FILTERS,
                callback,
              ) ?? []
            ).map((spec) => ({ spec, owningModule })),
            ...MetadataRegistry.getMergedClassArray<ExceptionFilterLike>(
              METADATA_KEYS.EXCEPTION_FILTERS,
              ctor,
            ).map((spec) => ({ spec, owningModule })),
            ...this.collectGlobalEnhancers<ExceptionFilterLike>(
              APP_FILTER,
              appConfig?.getGlobalFilters() ?? [],
            ),
          ]
        : [];

    const handlerMetadata =
      metadataKey && paramsFactory
        ? this.getMetadata<TParamsMetadata, TContext>(
            instance,
            methodName,
            metadataKey,
            paramsFactory,
            contextType,
          )
        : undefined;
    const moduleKey = owningModule?.id ?? this.getContextModuleKey(ctor);

    return async (...args: unknown[]): Promise<unknown> => {
      const ctx = new GenericExternalExecutionContext(
        args,
        ctor,
        callback,
        contextType,
      );
      const reqContainer = contextId
        ? this.container?.getOrCreateContextContainer?.(contextId)
        : undefined;

      try {
        for (let i = 0; i < guardSpecs.length; i++) {
          const entry = guardSpecs[i]!;
          const guard = await this.resolve<CanActivate>(
            entry.spec,
            reqContainer,
            entry.owningModule,
            "guard",
          );
          const allowed = await guard.canActivate(ctx);
          if (!allowed) {
            throw new ForbiddenException("Forbidden resource");
          }
        }

        const pipes: PipeTransform[] = [];
        for (const entry of pipeSpecs) {
          pipes.push(
            await this.resolve<PipeTransform>(
              entry.spec,
              reqContainer,
              entry.owningModule,
              "pipe",
            ),
          );
        }

        const invokeTarget = async (): Promise<unknown> => {
          let finalArgs = [...args];
          let resolvedWithParams = false;
          if (handlerMetadata) {
            const paramsOptions = handlerMetadata.getParamsMetadata(
              moduleKey,
              contextId,
              inquirerId,
            );
            if (paramsOptions.length > 0) {
              resolvedWithParams = true;
              finalArgs = new Array<unknown>(handlerMetadata.argsLength);
              const pipesFn = this.createPipesFn(pipes, paramsOptions);
              if (pipesFn) {
                await pipesFn(finalArgs, ...args);
              }
            }
          }
          if (!resolvedWithParams && pipes.length > 0) {
            for (let i = 0; i < finalArgs.length; i++) {
              finalArgs[i] = await this.getParamValue(
                finalArgs[i],
                {
                  type: "custom",
                  metatype: handlerMetadata?.paramtypes[i] as
                    | Function
                    | Type<unknown>
                    | undefined,
                },
                pipes,
              );
            }
          }
          const rawResult = callback.apply(instance, finalArgs);
          const result = await this.transformToResult(rawResult);
          return options.callback ? options.callback(result, ...args) : result;
        };

        if (interceptorSpecs.length === 0) {
          return await invokeTarget();
        }

        const interceptors: BunestInterceptor[] = [];
        for (const entry of interceptorSpecs) {
          interceptors.push(
            await this.resolve<BunestInterceptor>(
              entry.spec,
              reqContainer,
              entry.owningModule,
              "interceptor",
            ),
          );
        }

        let nextHandler: CallHandler = { handle: invokeTarget };
        for (let i = interceptors.length - 1; i >= 0; i--) {
          const ic = interceptors[i]!;
          const currNext = nextHandler;
          nextHandler = {
            handle: () => this.transformToResult(ic.intercept(ctx, currNext)),
          };
        }
        return await nextHandler.handle();
      } catch (err) {
        for (const entry of filterSpecs) {
          const filter = await this.resolve<ExceptionFilter>(
            entry.spec,
            reqContainer,
            entry.owningModule,
            "filter",
          );
          const ctorRef =
            typeof entry.spec === "function"
              ? entry.spec
              : (filter as object).constructor;
          const catchTypes =
            (typeof ctorRef === "function"
              ? MetadataRegistry.get<readonly Type<unknown>[]>(
                  METADATA_KEYS.CATCH_EXCEPTIONS,
                  ctorRef,
                )
              : undefined) ?? [];
          if (
            catchTypes.length === 0 ||
            catchTypes.some((t) => typeof t === "function" && err instanceof t)
          ) {
            return await filter.catch(err, ctx as ArgumentsHost);
          }
        }
        throw err;
      }
    };
  }
}

DecoratorRegistry.markInternal(ExternalContextCreator);
