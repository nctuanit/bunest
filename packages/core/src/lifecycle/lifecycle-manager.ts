import {
  ShutdownSignal,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
  type OnApplicationListen,
  type OnApplicationShutdown,
  type OnModuleDestroy,
  type OnModuleInit,
  type ShutdownHooksOptions,
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

function isOnApplicationListen(value: unknown): value is OnApplicationListen {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Partial<OnApplicationListen>).onApplicationListen ===
      "function"
  );
}

function getInstanceLabel(instance: object): string {
  const ctor = (instance as { constructor?: { name?: string } }).constructor;
  return ctor?.name && ctor.name !== "Object" ? ctor.name : "AnonymousProvider";
}

function describeThrownValue(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    value === null ||
    value === undefined
  ) {
    return String(value);
  }
  if (typeof value === "symbol") {
    return value.toString();
  }
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) {
      return json;
    }
  } catch {
    // Fallback for circular objects
  }
  return Object.prototype.toString.call(value);
}

function normalizeLifecycleError(
  err: unknown,
  hookName: string,
  instance: object,
  moduleName: string,
): Error {
  if (err instanceof Error) {
    return err;
  }
  const instanceName = getInstanceLabel(instance);
  return new Error(
    `Non-Error value thrown in ${hookName}() of ${instanceName} (module "${moduleName}"): ${describeThrownValue(err)}`,
    { cause: err },
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
  private listened = false;
  private closed = false;
  private useProcessExitOnSignal = false;
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
          try {
            await instance.onModuleInit();
          } catch (err) {
            throw normalizeLifecycleError(
              err,
              "onModuleInit",
              instance,
              group.module.name,
            );
          }
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
          try {
            await instance.onApplicationBootstrap();
          } catch (err) {
            throw normalizeLifecycleError(
              err,
              "onApplicationBootstrap",
              instance,
              group.module.name,
            );
          }
        }
      }
    }
  }

  async callApplicationListen(
    groups: readonly LifecycleModuleGroupLike[],
  ): Promise<void> {
    if (this.listened) {
      return;
    }
    this.listened = true;

    const seen = new Set<object>();
    for (const group of groups) {
      for (const instance of group.instances) {
        if (seen.has(instance)) continue;
        seen.add(instance);
        if (isOnApplicationListen(instance)) {
          try {
            await instance.onApplicationListen();
          } catch (err) {
            throw normalizeLifecycleError(
              err,
              "onApplicationListen",
              instance,
              group.module.name,
            );
          }
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
      hookName: string,
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
            errors.push(
              normalizeLifecycleError(
                err,
                hookName,
                instance,
                group.module.name,
              ),
            );
          }
        }
      }
    };

    await runPhase("onModuleDestroy", async (instance) => {
      if (isOnModuleDestroy(instance)) {
        await instance.onModuleDestroy();
      }
    });

    await runPhase("beforeApplicationShutdown", async (instance) => {
      if (isBeforeApplicationShutdown(instance)) {
        await instance.beforeApplicationShutdown(signal);
      }
    });

    await runPhase("onApplicationShutdown", async (instance) => {
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
    options?: ShutdownHooksOptions,
  ): void {
    if (options?.useProcessExit !== undefined) {
      this.useProcessExitOnSignal = options.useProcessExit;
    }

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
        void Promise.resolve(onSignal(normalized)).then(
          () => {
            if (this.useProcessExitOnSignal) {
              process.exit(0);
            }
          },
          () => {
            if (this.useProcessExitOnSignal) {
              process.exit(1);
            }
          },
        );
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
