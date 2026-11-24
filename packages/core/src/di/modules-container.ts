import type {
  Subscribable,
  SubscribableObserver,
  Unsubscribable,
} from "../interfaces/core-types.interface";
import type { ModuleNode } from "../module/module-node";

/**
 * Injectable map of all registered `ModuleNode`s in the application,
 * matching NestJS v12 `ModulesContainer` (including zero-RxJS RPC target registry).
 */
export class ModulesContainer extends Map<string, ModuleNode> {
  private readonly _applicationId = crypto.randomUUID();
  private readonly rpcTargets = new Set<unknown>();
  private readonly rpcTargetListeners = new Set<(target: unknown) => void>();

  get applicationId(): string {
    return this._applicationId;
  }

  getById(id: string): ModuleNode | undefined {
    const direct = this.get(id);
    if (direct && direct.id === id) {
      return direct;
    }
    for (const mod of this.values()) {
      if (mod.id === id) {
        return mod;
      }
    }
    return undefined;
  }

  /**
   * Registers an RPC target (microservice server/handler) and notifies all
   * subscribers of `getRpcTargetRegistry()`.
   */
  addRpcTarget<T>(target: T): void {
    this.rpcTargets.add(target);
    for (const listener of [...this.rpcTargetListeners]) {
      listener(target);
    }
  }

  /**
   * Returns a zero-RxJS replay subscribable (ADR-008) over all registered RPC targets,
   * replaying existing targets on subscribe and emitting future `addRpcTarget()` calls.
   */
  getRpcTargetRegistry<T = unknown>(): Subscribable<T> {
    return {
      subscribe: (
        observerOrNext?: SubscribableObserver<T> | ((value: T) => void),
      ): Unsubscribable => {
        const nextFn =
          typeof observerOrNext === "function"
            ? observerOrNext
            : observerOrNext?.next?.bind(observerOrNext);

        if (nextFn) {
          for (const existing of this.rpcTargets) {
            nextFn(existing as T);
          }
        }

        const listener = (target: unknown) => {
          nextFn?.(target as T);
        };
        this.rpcTargetListeners.add(listener);

        return {
          unsubscribe: () => {
            this.rpcTargetListeners.delete(listener);
          },
        };
      },
    };
  }
}
