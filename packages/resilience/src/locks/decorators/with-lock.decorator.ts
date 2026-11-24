import {
  Inject,
  Injectable,
  Optional,
  createMethodAspectDecorator,
  type BeforeApplicationShutdown,
  type MethodAspectContext,
  type MethodAspectHandler,
} from "@bunest/core";
import { LocksEvents } from "../events/locks-events.service";
import type { Duration } from "../interfaces/duration.interface";
import type { LockStore } from "../interfaces/lock-store.interface";
import type { LocksModuleOptions } from "../interfaces/locks-module-options.interface";
import { LOCKS_MODULE_OPTIONS } from "../locks.module-definition";
import { Locks } from "../locks.service";
import { LocksStorage } from "../storage/locks.storage";

export type WithLockKey = string | ((...args: any[]) => string);

export interface WithLockOptions {
  /**
   * Lease TTL (milliseconds or Duration string like `"30s"`).
   * Defaults to the module's configured `ttl`.
   */
  ttl?: Duration;
  /**
   * How long to wait to acquire the lock before throwing `LockNotAcquiredError`
   * (milliseconds or Duration string). Defaults to `0` (try once, fail immediately if taken).
   */
  waitTimeout?: Duration;
  /**
   * Alias for `waitTimeout` matching `LockOptions.wait`.
   */
  wait?: Duration;
  /**
   * Optional named store (registered via `LocksStorage.registerNamedSource()`) or
   * key namespace prefix when no named store with that name is registered.
   */
  store?: string;
}

export interface WithLockAspectMetadataOptions {
  readonly key: WithLockKey;
  readonly options?: WithLockOptions;
}

/**
 * Core Method Aspect handler backing `@WithLock(key, options?)`.
 * Executes decorated methods inside `Locks.withLock(...)` with dynamic keys from
 * method arguments, automatic lock release on completion/error, `LocksContext`
 * propagation, and full support for `SINGLETON`, `TRANSIENT`, and `REQUEST` scopes.
 */
@Injectable()
export class WithLockAspectHandler
  implements
    MethodAspectHandler<WithLockAspectMetadataOptions>,
    BeforeApplicationShutdown
{
  private readonly namedStoreLocks = new WeakMap<LockStore, Locks>();
  private readonly createdNamedLocks = new Set<Locks>();

  constructor(
    private readonly locks: Locks,
    private readonly storage: LocksStorage,
    private readonly events: LocksEvents,
    @Optional()
    @Inject(LOCKS_MODULE_OPTIONS)
    private readonly moduleOptions?: LocksModuleOptions,
  ) {}

  async intercept(
    ctx: MethodAspectContext<WithLockAspectMetadataOptions>,
  ): Promise<unknown> {
    const { key, options } = ctx.options;
    const rawKey = typeof key === "function" ? key(...ctx.args) : key;

    if (typeof rawKey !== "string" || rawKey.length === 0) {
      throw new TypeError(
        `@WithLock() on ${ctx.targetClass.name || "Service"}.${String(ctx.methodName)}: resolved lock key must be a non-empty string, got ${JSON.stringify(rawKey)}`,
      );
    }

    const wait = options?.waitTimeout ?? options?.wait;
    const lockOpts = {
      ...(options?.ttl !== undefined ? { ttl: options.ttl } : {}),
      ...(wait !== undefined ? { wait } : {}),
    };

    if (options?.store) {
      const namedStore = this.storage.getNamedSource(options.store);
      if (namedStore) {
        const scopedLocks = this.getOrCreateNamedLocks(namedStore);
        return await scopedLocks.withLock(
          rawKey,
          () => ctx.proceed(),
          lockOpts,
        );
      }
      return await this.locks.withLock(
        `${options.store}:${rawKey}`,
        () => ctx.proceed(),
        lockOpts,
      );
    }

    return await this.locks.withLock(rawKey, () => ctx.proceed(), lockOpts);
  }

  async beforeApplicationShutdown(): Promise<void> {
    await Promise.all(
      [...this.createdNamedLocks].map((locks) =>
        locks.beforeApplicationShutdown(),
      ),
    );
  }

  private getOrCreateNamedLocks(store: LockStore): Locks {
    let instance = this.namedStoreLocks.get(store);
    if (!instance) {
      const storage = new LocksStorage(this.moduleOptions);
      storage.registerSource(store);
      instance = new Locks(storage, this.events, this.moduleOptions);
      this.namedStoreLocks.set(store, instance);
      this.createdNamedLocks.add(instance);
    }
    return instance;
  }
}

/**
 * Declarative distributed lock decorator backed by `Locks.withLock(...)` and
 * `@bunest/core`'s Core Method Aspect weaver.
 *
 * Supports static or dynamic argument-derived keys (e.g. `@WithLock((id) => `order:${id}`)`)
 * and works across `SINGLETON`, `TRANSIENT`, and `REQUEST` scopes.
 */
export function WithLock(
  key: WithLockKey,
  options?: WithLockOptions,
): ClassDecorator & MethodDecorator {
  if (
    typeof key !== "function" &&
    (typeof key !== "string" || key.length === 0)
  ) {
    throw new TypeError(
      `@WithLock(): key must be a non-empty string or key factory function, got ${JSON.stringify(key)}`,
    );
  }
  return createMethodAspectDecorator(WithLockAspectHandler, {
    key,
    options,
  });
}
