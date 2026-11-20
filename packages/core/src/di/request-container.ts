import type { ContextId, InjectionToken, OnRequestDestroy } from "@bunest/common";
import type { RequestScopeContainer } from "../interfaces/core-types.interface";

type RequestResolverFn = (
  token: InjectionToken,
  container: RequestContainer,
) => Promise<unknown> | unknown;

function hasOnRequestDestroy(value: unknown): value is OnRequestDestroy {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Partial<OnRequestDestroy>).onRequestDestroy === "function"
  );
}

function hasAsyncDispose(value: unknown): value is AsyncDisposable {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<symbol, unknown>)[Symbol.asyncDispose] ===
      "function"
  );
}

function hasSyncDispose(value: unknown): value is Disposable {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<symbol, unknown>)[Symbol.dispose] === "function"
  );
}

/**
 * Isolated per-request DI container implementing `RequestScopeContainer` (ADR-012).
 * Caches `Scope.REQUEST` instances for a single HTTP request lifetime and invokes
 * cleanup hooks (`onRequestDestroy` / `Symbol.asyncDispose` / `Symbol.dispose`)
 * in reverse instantiation order on request completion or abort.
 */
export class RequestContainer implements RequestScopeContainer {
  private readonly requestValues = new Map<InjectionToken, unknown>();
  private readonly scopedInstances = new Map<string, unknown>();
  private readonly inFlightInstances = new Map<string, Promise<unknown>>();
  private readonly instantiationOrder: unknown[] = [];
  private contextId?: ContextId;
  private readonly durable: boolean;
  private destroyed = false;

  constructor(
    private readonly resolver: RequestResolverFn,
    options?: { contextId?: ContextId; durable?: boolean },
  ) {
    this.contextId = options?.contextId;
    this.durable = options?.durable === true;
  }

  getContextId(): ContextId | undefined {
    return this.contextId;
  }

  setContextId(contextId: ContextId): void {
    this.contextId = contextId;
  }

  isDurable(): boolean {
    return this.durable;
  }

  registerRequestValue<T = unknown>(token: InjectionToken<T>, value: T): void {
    this.requestValues.set(token, value);
  }

  hasRequestValue(token: InjectionToken): boolean {
    return this.requestValues.has(token);
  }

  getRequestValue<T = unknown>(token: InjectionToken<T>): T | undefined {
    return this.requestValues.get(token) as T | undefined;
  }

  hasScopedInstance(key: string): boolean {
    return this.scopedInstances.has(key);
  }

  getScopedInstance<T = unknown>(key: string): T | undefined {
    return this.scopedInstances.get(key) as T | undefined;
  }

  setScopedInstance(key: string, instance: unknown): void {
    if (!this.scopedInstances.has(key)) {
      this.scopedInstances.set(key, instance);
      this.trackInstance(instance);
    }
  }

  /**
   * Single-flight scoped instantiation: concurrent async resolutions for the same
   * `key` share a single in-flight Promise and return the single tracked instance,
   * preventing duplicate factory calls and orphaned resources on durable sub-trees.
   */
  async getOrCreateScopedInstance<T = unknown>(
    key: string,
    factory: () => Promise<T> | T,
  ): Promise<T> {
    if (this.scopedInstances.has(key)) {
      return this.scopedInstances.get(key) as T;
    }

    const inFlight = this.inFlightInstances.get(key);
    if (inFlight) {
      return (await inFlight) as T;
    }

    const promise = (async () => {
      try {
        const instance = await factory();
        if (this.destroyed) {
          // Container was destroyed while factory was still resolving; clean up immediately.
          await this.destroySingleInstance(instance).catch(() => {});
          return instance;
        }
        this.setScopedInstance(key, instance);
        return instance;
      } finally {
        this.inFlightInstances.delete(key);
      }
    })();

    this.inFlightInstances.set(key, promise);
    return (await promise) as T;
  }

  private async destroySingleInstance(instance: unknown): Promise<void> {
    if (hasOnRequestDestroy(instance)) {
      await instance.onRequestDestroy();
    } else if (hasAsyncDispose(instance)) {
      await instance[Symbol.asyncDispose]();
    } else if (hasSyncDispose(instance)) {
      instance[Symbol.dispose]();
    }
  }

  trackInstance(instance: unknown): void {
    if (
      typeof instance === "object" &&
      instance !== null &&
      !this.instantiationOrder.includes(instance)
    ) {
      this.instantiationOrder.push(instance);
    }
  }

  async resolve<T = unknown>(token: InjectionToken<T>): Promise<T> {
    if (this.requestValues.has(token)) {
      return this.requestValues.get(token) as T;
    }
    return (await this.resolver(token, this)) as T;
  }

  async destroy(): Promise<void> {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;

    const toDestroy = [...this.instantiationOrder].reverse();
    const errors: unknown[] = [];

    try {
      for (const instance of toDestroy) {
        try {
          if (hasOnRequestDestroy(instance)) {
            await instance.onRequestDestroy();
          } else if (hasAsyncDispose(instance)) {
            await instance[Symbol.asyncDispose]();
          } else if (hasSyncDispose(instance)) {
            instance[Symbol.dispose]();
          }
        } catch (err) {
          errors.push(err);
        }
      }
    } finally {
      this.scopedInstances.clear();
      this.inFlightInstances.clear();
      this.requestValues.clear();
      this.instantiationOrder.length = 0;
    }

    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        "Multiple errors occurred while destroying request-scoped providers",
      );
    }
  }
}
