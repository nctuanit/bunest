import {
  ShutdownSignal,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  type OnModuleDestroy,
  type OnModuleInit,
} from "../common/index";
import type {
  LifecycleManagerLike,
  LifecycleModuleGroupLike,
  ShutdownSignalInput,
} from "../interfaces/core-types.interface";
import type { ModuleNode } from "../module/module-node";

function isOnModuleInit(value: unknown): value is OnModuleInit {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Partial<OnModuleInit>).onModuleInit === "function"
  );
}

function isOnApplicationBootstrap(
  value: unknown,
): value is OnApplicationBootstrap {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Partial<OnApplicationBootstrap>).onApplicationBootstrap ===
      "function"
  );
}

function isOnModuleDestroy(value: unknown): value is OnModuleDestroy {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Partial<OnModuleDestroy>).onModuleDestroy === "function"
  );
}

function isBeforeApplicationShutdown(
  value: unknown,
): value is BeforeApplicationShutdown {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Partial<BeforeApplicationShutdown>)
      .beforeApplicationShutdown === "function"
  );
}

function isOnApplicationShutdown(
  value: unknown,
): value is OnApplicationShutdown {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Partial<OnApplicationShutdown>).onApplicationShutdown ===
      "function"
  );
}

export interface ModuleInstanceGroup extends LifecycleModuleGroupLike {
  readonly module: ModuleNode;
  readonly instances: readonly object[];
}

export { ShutdownSignal };

/**
 * Orchestrates deterministic bottom-up bootstrap hooks and reverse-topological
 * graceful shutdown hooks (ADR-007 §7), with leak-free process signal cleanup.
 */
export class LifecycleManager implements LifecycleManagerLike {
  private initialized = false;
  private bootstrapped = false;
  private closed = false;
  private readonly moduleInitCalled = new WeakSet<object>();
  private readonly signalListeners: Array<{
    signal: NodeJS.Signals;
    handler: () => void;
  }> = [];

  async callModuleInit(
    groups: readonly LifecycleModuleGroupLike[],
  ): Promise<void> {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    await this.callModuleInitFor(groups);
  }

  /**
   * Invokes `onModuleInit()` on newly loaded instances (e.g. from `LazyModuleLoader`)
   * without re-running hooks on instances that were already initialized.
   */
  async callModuleInitFor(
    groups: readonly LifecycleModuleGroupLike[],
  ): Promise<void> {
    for (const group of groups) {
      for (const instance of group.instances) {
        if (this.moduleInitCalled.has(instance)) continue;
        this.moduleInitCalled.add(instance);
        if (isOnModuleInit(instance)) {
          await instance.onModuleInit();
        }
      }
    }
  }

  async callApplicationBootstrap(
    groups: readonly LifecycleModuleGroupLike[],
  ): Promise<void> {
    if (this.bootstrapped) {
      return;
    }
    this.bootstrapped = true;

    const seen = new Set<object>();
    for (const group of groups) {
      for (const instance of group.instances) {
        if (seen.has(instance)) continue;
        seen.add(instance);
        if (isOnApplicationBootstrap(instance)) {
          await instance.onApplicationBootstrap();
        }
      }
    }
  }

  /**
   * Runs graceful shutdown in exact ADR-007 §7 order:
   * 1. Stop accepting new traffic (`stopServer`)
   * 2. Reverse topological order: `onModuleDestroy()`
   * 3. Reverse topological order: `beforeApplicationShutdown(signal)`
   * 4. Reverse topological order: `onApplicationShutdown(signal)`
   * Idempotent and always unregisters any process signal listeners.
   */
  async callShutdown(
    groups: readonly LifecycleModuleGroupLike[],
    signal?: ShutdownSignalInput,
    stopServer?: () => Promise<void> | void,
  ): Promise<void> {
    this.cleanupShutdownHooks();

    if (this.closed) {
      return;
    }
    this.closed = true;

    const errors: unknown[] = [];

    if (stopServer) {
      try {
        const stopRes = stopServer();
        if (stopRes) {
          await stopRes;
        }
      } catch (err) {
        errors.push(err);
      }
    }

    const reversedGroups = [...groups].reverse();

    const runPhase = async (
      invoke: (instance: object) => Promise<void> | void,
    ) => {
      const seen = new Set<object>();
      for (const group of reversedGroups) {
        const reversedInstances = [...group.instances].reverse();
        for (const instance of reversedInstances) {
          if (seen.has(instance)) continue;
          seen.add(instance);
          try {
            await invoke(instance);
          } catch (err) {
            errors.push(err);
          }
        }
      }
    };

    await runPhase(async (instance) => {
      if (isOnModuleDestroy(instance)) {
        await instance.onModuleDestroy();
      }
    });

    await runPhase(async (instance) => {
      if (isBeforeApplicationShutdown(instance)) {
        await instance.beforeApplicationShutdown(signal);
      }
    });

    await runPhase(async (instance) => {
      if (isOnApplicationShutdown(instance)) {
        await instance.onApplicationShutdown(signal);
      }
    });

    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        "Multiple errors occurred during application shutdown",
      );
    }
  }

  enableShutdownHooks(
    signals: readonly ShutdownSignalInput[] = [
      ShutdownSignal.SIGINT,
      ShutdownSignal.SIGTERM,
    ],
    onSignal: (signal: NodeJS.Signals) => Promise<void> | void,
  ): void {
    const registered = new Set<NodeJS.Signals>(
      this.signalListeners.map((entry) => entry.signal),
    );

    for (const rawSignal of signals) {
      const normalized = String(rawSignal)
        .trim()
        .toUpperCase() as NodeJS.Signals;
      if (!normalized || registered.has(normalized)) {
        continue;
      }
      registered.add(normalized);
      const handler = () => {
        void Promise.resolve(onSignal(normalized));
      };
      process.once(normalized, handler);
      this.signalListeners.push({ signal: normalized, handler });
    }
  }

  cleanupShutdownHooks(): void {
    for (const { signal, handler } of this.signalListeners) {
      process.removeListener(signal, handler);
    }
    this.signalListeners.length = 0;
  }

  getActiveHookCount(): number {
    return this.signalListeners.length;
  }

  getIsInitialized(): boolean {
    return this.initialized && this.bootstrapped;
  }

  getIsClosed(): boolean {
    return this.closed;
  }
}
