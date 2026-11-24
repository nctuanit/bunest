import {
  DecoratorRegistry,
  Injectable,
  type DynamicModule,
  type Type,
} from "../common/index";
import type { ModuleRef } from "../di/module-ref";

export interface LazyModuleLoaderOptions {
  logger?: boolean;
}

/**
 * Narrow internal contract implemented by `DIContainer` and consumed by
 * `LazyModuleLoader` (keeps module loading strictly acyclic with `di-container.ts`).
 */
export interface LazyModuleHost {
  loadLazyModule(
    loaderFn: () =>
      Promise<Type<unknown> | DynamicModule> | Type<unknown> | DynamicModule,
    options?: LazyModuleLoaderOptions,
  ): Promise<ModuleRef>;
}

/**
 * Injectable service for on-demand dynamic loading of modules after startup.
 * Dynamically scans and registers providers, runs `onModuleInit()` hooks,
 * deduplicates repeated loads, and participates in `app.close()` teardown.
 */
@Injectable()
export class LazyModuleLoader {
  constructor(private readonly host: LazyModuleHost) {}

  async load(
    loaderFn: () =>
      Promise<Type<unknown> | DynamicModule> | Type<unknown> | DynamicModule,
    loadOpts?: LazyModuleLoaderOptions,
  ): Promise<ModuleRef> {
    return this.host.loadLazyModule(loaderFn, loadOpts);
  }
}

DecoratorRegistry.markInternal(LazyModuleLoader);
