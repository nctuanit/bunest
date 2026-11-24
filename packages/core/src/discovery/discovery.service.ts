import {
  DecoratorRegistry,
  Injectable,
  MetadataRegistry,
  SetMetadata,
  type CustomDecorator,
  type FactoryDependency,
  type InjectionToken,
  type MetadataKey,
  type Scope,
  type Type,
} from "../common/index";
import type { ModuleRef } from "../di/module-ref";
import type { ModuleNode } from "../module/module-node";

export interface InstanceWrapper<T = unknown> {
  readonly token: InjectionToken<T>;
  readonly instance: T | undefined;
  readonly metatype: Type<T> | Function | undefined;
  readonly moduleRef: ModuleRef;
  readonly moduleId: string;
  readonly scope: Scope;
  readonly isDependencyTreeStatic: boolean;
  readonly isAlias?: boolean;
  readonly isTransient?: boolean;
  readonly inject?: readonly FactoryDependency[];
}

export interface FilterByInclude {
  /**
   * Optional list of module classes or `ModuleNode`s to restrict discovery to.
   */
  include?: readonly (Type<unknown> | ModuleNode)[];
}

export interface FilterByMetadataKey {
  /**
   * Filter providers/controllers carrying this metadata key (NestJS v10.4+/v12 parity).
   */
  metadataKey?: MetadataKey;
}

export type DiscoveryOptions = FilterByInclude & FilterByMetadataKey;
export type DiscoveryFilterOptions = DiscoveryOptions;

export type DiscoverableDecorator<T> = ((
  opts?: T,
) => CustomDecorator<string>) & {
  KEY: string;
};

let discoverableDecoratorSeq = 0;

/**
 * Narrow internal contract implemented by `DIContainer` and consumed by
 * `DiscoveryService` (keeps discovery strictly acyclic with `di-container.ts`).
 */
export interface DiscoveryHost {
  discoverProviders(options?: DiscoveryFilterOptions): InstanceWrapper[];
  discoverControllers(options?: DiscoveryFilterOptions): InstanceWrapper[];
  discoverModules(): readonly ModuleNode[];
  discoverProviderByToken<T = unknown>(
    token: InjectionToken<T>,
  ): InstanceWrapper<T> | undefined;
  resolveEnhancer?<T = unknown>(enhancer: Type<T> | T): Promise<T>;
}

/**
 * Public, injectable introspection service exposing registered providers,
 * controllers, and modules across the Bunest DI container without reaching into
 * private container internals.
 */
@Injectable()
export class DiscoveryService {
  constructor(private readonly host: DiscoveryHost) {}

  /**
   * Creates a typed discoverable decorator matching NestJS `DiscoveryService.createDecorator<T>()`.
   */
  static createDecorator<T = unknown>(): DiscoverableDecorator<T> {
    const metadataKey = `bunest:discoverable:${++discoverableDecoratorSeq}`;
    const decoratorFn = ((opts?: T) =>
      SetMetadata(metadataKey, opts as T)) as DiscoverableDecorator<T>;
    decoratorFn.KEY = metadataKey;
    return decoratorFn;
  }

  getProviders(options?: DiscoveryOptions): InstanceWrapper[] {
    const all = this.host.discoverProviders(options);
    if (options?.metadataKey === undefined) {
      return all;
    }
    return all.filter((w) =>
      this.wrapperHasMetadataKey(w, options.metadataKey!),
    );
  }

  getControllers(options?: DiscoveryOptions): InstanceWrapper[] {
    const all = this.host.discoverControllers(options);
    if (options?.metadataKey === undefined) {
      return all;
    }
    return all.filter((w) =>
      this.wrapperHasMetadataKey(w, options.metadataKey!),
    );
  }

  /**
   * Retrieves metadata attached via a `DiscoveryService.createDecorator()` decorator
   * on either the wrapper's class or a specific method (`methodKey`).
   */
  getMetadataByDecorator<T extends DiscoverableDecorator<any>>(
    decorator: T,
    instanceWrapper: InstanceWrapper,
    methodKey?: string | symbol,
  ): T extends DiscoverableDecorator<infer R> ? R | undefined : unknown {
    type Result =
      T extends DiscoverableDecorator<infer R> ? R | undefined : unknown;
    const target =
      instanceWrapper.metatype ??
      (instanceWrapper.instance && typeof instanceWrapper.instance === "object"
        ? instanceWrapper.instance.constructor
        : undefined);
    if (typeof target !== "function") {
      return undefined as Result;
    }
    if (methodKey !== undefined) {
      const proto = target.prototype as
        Record<string | symbol, unknown> | undefined;
      const fn = proto?.[methodKey];
      if (typeof fn === "function") {
        return MetadataRegistry.get<Result>(decorator.KEY, fn) as Result;
      }
      return MetadataRegistry.get<Result>(
        decorator.KEY,
        target.prototype,
        methodKey,
      ) as Result;
    }
    return MetadataRegistry.get<Result>(decorator.KEY, target) as Result;
  }

  private wrapperHasMetadataKey(
    wrapper: InstanceWrapper,
    key: MetadataKey,
  ): boolean {
    const target =
      wrapper.metatype ??
      (wrapper.instance && typeof wrapper.instance === "object"
        ? wrapper.instance.constructor
        : undefined);
    return typeof target === "function" && MetadataRegistry.has(key, target);
  }

  getModules(): readonly ModuleNode[] {
    return this.host.discoverModules();
  }

  getProviderByToken<T = unknown>(
    token: InjectionToken<T>,
  ): InstanceWrapper<T> | undefined {
    return this.host.discoverProviderByToken<T>(token);
  }

  /**
   * Returns deduplicated singleton provider & controller instances across
   * discovered modules (useful for decorator explorers).
   */
  getAllSingletonInstances(options?: DiscoveryFilterOptions): object[] {
    const seen = new Set<object>();
    const instances: object[] = [];
    for (const wrapper of [
      ...this.getProviders(options),
      ...this.getControllers(options),
    ]) {
      const instance = wrapper.instance;
      if (instance && typeof instance === "object" && !seen.has(instance)) {
        seen.add(instance);
        instances.push(instance);
      }
    }
    return instances;
  }

  /**
   * Returns all provider wrappers whose metatype carries metadata at `metadataKey`.
   */
  getProvidersWithMetaAtKey<T = unknown>(
    metadataKey: MetadataKey,
    options?: DiscoveryFilterOptions,
  ): Array<{ readonly wrapper: InstanceWrapper; readonly metadata: T }> {
    const results: Array<{
      readonly wrapper: InstanceWrapper;
      readonly metadata: T;
    }> = [];
    for (const wrapper of this.getProviders(options)) {
      const target =
        wrapper.metatype ??
        (wrapper.instance && typeof wrapper.instance === "object"
          ? wrapper.instance.constructor
          : undefined);
      if (typeof target !== "function") continue;
      if (MetadataRegistry.has(metadataKey, target)) {
        const metadata = MetadataRegistry.get<T>(metadataKey, target);
        if (metadata !== undefined) {
          results.push({ wrapper, metadata });
        }
      }
    }
    return results;
  }

  /**
   * Returns all controller wrappers whose metatype carries metadata at `metadataKey`.
   */
  getControllersWithMetaAtKey<T = unknown>(
    metadataKey: MetadataKey,
    options?: DiscoveryFilterOptions,
  ): Array<{ readonly wrapper: InstanceWrapper; readonly metadata: T }> {
    const results: Array<{
      readonly wrapper: InstanceWrapper;
      readonly metadata: T;
    }> = [];
    for (const wrapper of this.getControllers(options)) {
      const target =
        wrapper.metatype ??
        (wrapper.instance && typeof wrapper.instance === "object"
          ? wrapper.instance.constructor
          : undefined);
      if (typeof target !== "function") continue;
      if (MetadataRegistry.has(metadataKey, target)) {
        const metadata = MetadataRegistry.get<T>(metadataKey, target);
        if (metadata !== undefined) {
          results.push({ wrapper, metadata });
        }
      }
    }
    return results;
  }

  /**
   * Resolves a guard, pipe, interceptor, or filter class/instance through the DI
   * container without reaching into private container fields.
   */
  async resolveEnhancer<T = unknown>(enhancer: Type<T> | T): Promise<T> {
    if (typeof enhancer !== "function") {
      return enhancer;
    }
    if (typeof this.host.resolveEnhancer === "function") {
      return this.host.resolveEnhancer<T>(enhancer);
    }
    const existing = this.getProviderByToken<T>(enhancer as Type<T>);
    if (existing?.instance !== undefined) {
      return existing.instance;
    }
    return new (enhancer as Type<T>)();
  }
}

DecoratorRegistry.markInternal(DiscoveryService);
