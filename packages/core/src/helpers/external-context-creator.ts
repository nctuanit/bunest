import {
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
  type InterceptorLike,
  type ParamData,
  type PipeLike,
  type PipeTransform,
  type Type,
} from "@bunest/common";
import type { ModulesContainer } from "../di/modules-container";
import type { ContextId } from "../interfaces/core-types.interface";

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

export interface ParamProperties<T = any, IExtractor extends Function = any> {
  index: number;
  type: T | string;
  data: ParamData;
  pipes: PipeTransform[];
  extractValue: IExtractor;
  metatype?: unknown;
}

export interface ExternalHandlerMetadata {
  argsLength: number;
  paramtypes: any[];
  getParamsMetadata: (
    moduleKey: string,
    contextId?: ContextId,
    inquirerId?: string,
  ) => (ParamProperties & { metatype?: any })[];
  fnHandleResponse?: (...args: any[]) => any;
}

/**
 * Narrow structural interface for `DIContainer` / `NestContainer` so
 * `ExternalContextCreator.fromContainer(container)` keeps zero circular imports.
 */
export interface ExternalContextContainerLike {
  resolveEnhancer<T = unknown>(enhancer: Type<T> | T): Promise<T> | T;
  getModulesContainer?(): ModulesContainer;
  getModules?(): ModulesContainer;
  registerRequestByContextId?<T = unknown>(
    request: T,
    contextId: ContextId,
  ): void;
  registerRequestProvider?<T = unknown>(
    request: T,
    contextId: ContextId,
  ): void;
}

class GenericExternalExecutionContext implements ExecutionContext {
  constructor(
    private readonly args: unknown[],
    private readonly constructorRef: Type<any>,
    private readonly handler: Function,
    private readonly contextType: string,
  ) {}

  getClass<T = any>(): Type<T> {
    return this.constructorRef;
  }

  getHandler(): Function {
    return this.handler;
  }

  getArgs<T extends Array<any> = any[]>(): T {
    return this.args as T;
  }

  getArgByIndex<T = any>(index: number): T {
    return this.args[index] as T;
  }

  switchToHttp(): any {
    return {
      getRequest: () => this.args[0],
      getResponse: () => this.args[1],
      getNext: () => this.args[2],
    };
  }

  switchToRpc(): any {
    return {
      getData: () => this.args[0],
      getContext: () => this.args[1],
    };
  }

  switchToWs(): any {
    return {
      getClient: () => this.args[0],
      getData: () => this.args[1],
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

function isSubscribableLike(
  value: unknown,
): value is {
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

  private async resolve<T>(enhancer: Type<T> | T): Promise<T> {
    if (typeof enhancer !== "function") {
      return enhancer;
    }
    if (this.resolveEnhancerFn) {
      return await this.resolveEnhancerFn<T>(enhancer);
    }
    return new (enhancer as Type<T>)();
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

  registerRequestProvider<T = any>(request: T, contextId: ContextId): void {
    if (this.container?.registerRequestByContextId) {
      this.container.registerRequestByContextId(request, contextId);
    } else if (this.container?.registerRequestProvider) {
      this.container.registerRequestProvider(request, contextId);
    }
  }

  async transformToResult(resultOrDeferred: any): Promise<any> {
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
  ): Promise<any> {
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

  exchangeKeysForValues<TMetadata extends Record<string, any> = Record<string, any>>(
    keys: string[],
    metadata: TMetadata,
    _moduleContext: string,
    paramsFactory: ParamsFactory,
    _contextId?: ContextId,
    _inquirerId?: string,
    contextFactory: (args: unknown[]) => ExecutionContext = (args) =>
      new GenericExternalExecutionContext(
        args,
        Object as unknown as Type<any>,
        () => undefined,
        "http",
      ),
  ): ParamProperties[] {
    return keys.map((key) => {
      const entry = metadata[key] ?? {};
      const rawType =
        entry.type !== undefined
          ? entry.type
          : entry.source !== undefined
            ? entry.source
            : (key.split(":")[0] ?? key);
      let resolvedType: any = rawType;
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
    TMetadata extends Record<string, any> = Record<string, any>,
    TContext extends string = ContextType,
  >(
    instance: object,
    methodName: string | symbol,
    metadataKey?: string | symbol,
    paramsFactory?: ParamsFactory,
    contextType: TContext = "http" as TContext,
  ): ExternalHandlerMetadata {
    const ctor = instance.constructor as Type<any>;
    const proto = Object.getPrototypeOf(instance) as object | null;
    const paramtypes: any[] =
      (proto
        ? MetadataRegistry.get<any[]>(
            DESIGN_METADATA_KEYS.PARAMTYPES,
            proto,
            methodName,
          )
        : undefined) ?? [];

    const rawMetadata = metadataKey
      ? (proto
          ? MetadataRegistry.get<TMetadata>(metadataKey, proto, methodName)
          : undefined) ??
        MetadataRegistry.get<TMetadata>(metadataKey, ctor, methodName)
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
    guards: any[],
    instance: object,
    callback: (...args: any[]) => any,
    contextType: TContext = "http" as TContext,
  ): ((args: any[]) => Promise<void>) | null {
    if (!guards || guards.length === 0) {
      return null;
    }
    const ctor = instance.constructor as Type<any>;
    return async (args: any[]) => {
      const ctx = new GenericExternalExecutionContext(
        args,
        ctor,
        callback,
        contextType,
      );
      for (let i = 0; i < guards.length; i++) {
        const guard = await this.resolve<CanActivate>(guards[i]);
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
          metatype: param.metatype as Type<any> | Function | undefined,
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
    TParamsMetadata extends Record<string, any> = Record<string, any>,
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
    const ctor = instance.constructor as Type<any>;
    const guardSpecs =
      options.guards !== false
        ? [
            ...MetadataRegistry.getMergedClassArray<GuardLike>(
              METADATA_KEYS.GUARDS,
              ctor,
            ),
            ...(MetadataRegistry.get<readonly GuardLike[]>(
              METADATA_KEYS.GUARDS,
              callback,
            ) ?? []),
          ]
        : [];
    const interceptorSpecs =
      options.interceptors !== false
        ? [
            ...MetadataRegistry.getMergedClassArray<InterceptorLike>(
              METADATA_KEYS.INTERCEPTORS,
              ctor,
            ),
            ...(MetadataRegistry.get<readonly InterceptorLike[]>(
              METADATA_KEYS.INTERCEPTORS,
              callback,
            ) ?? []),
          ]
        : [];
    const pipeSpecs =
      options.pipes !== false
        ? [
            ...MetadataRegistry.getMergedClassArray<PipeLike>(
              METADATA_KEYS.PIPES,
              ctor,
            ),
            ...(MetadataRegistry.get<readonly PipeLike[]>(
              METADATA_KEYS.PIPES,
              callback,
            ) ?? []),
          ]
        : [];
    const filterSpecs =
      options.filters !== false
        ? [
            ...(MetadataRegistry.get<readonly ExceptionFilterLike[]>(
              METADATA_KEYS.EXCEPTION_FILTERS,
              callback,
            ) ?? []),
            ...MetadataRegistry.getMergedClassArray<ExceptionFilterLike>(
              METADATA_KEYS.EXCEPTION_FILTERS,
              ctor,
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
    const moduleKey = this.getContextModuleKey(ctor);

    return async (...args: unknown[]): Promise<unknown> => {
      const ctx = new GenericExternalExecutionContext(
        args,
        ctor,
        callback,
        contextType,
      );

      try {
        const guardsFn = this.createGuardsFn(
          guardSpecs,
          instance,
          callback,
          contextType,
        );
        if (guardsFn) {
          await guardsFn(args);
        }

        const pipes: PipeTransform[] = [];
        for (const spec of pipeSpecs) {
          pipes.push(await this.resolve<PipeTransform>(spec));
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
                  metatype: handlerMetadata?.paramtypes[i],
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
        for (const spec of interceptorSpecs) {
          interceptors.push(await this.resolve<BunestInterceptor>(spec));
        }

        let nextHandler: CallHandler = { handle: invokeTarget };
        for (let i = interceptors.length - 1; i >= 0; i--) {
          const ic = interceptors[i]!;
          const currNext = nextHandler;
          nextHandler = {
            handle: () =>
              this.transformToResult(ic.intercept(ctx, currNext)),
          };
        }
        return await nextHandler.handle();
      } catch (err) {
        for (const spec of filterSpecs) {
          const filter = await this.resolve<ExceptionFilter>(spec);
          const ctorRef =
            typeof spec === "function" ? spec : (filter as object).constructor;
          const catchTypes =
            (typeof ctorRef === "function"
              ? MetadataRegistry.get<readonly Type<any>[]>(
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
