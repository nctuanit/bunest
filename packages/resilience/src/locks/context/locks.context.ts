import { ContextStorage, Injectable } from "@bunest/core";
import type { Lock } from "../lock/lock";

interface LockScope {
  lock: Lock;
  /** The lock's signal, or one that also aborts with the job's ownership lease. */
  signal: AbortSignal;
}

const scopes = new ContextStorage<LockScope>();

/** @internal Runs `fn` inside a lock scope. */
export function runInLockScope<T>(scope: LockScope, fn: () => T): T {
  return scopes.run(scope, fn);
}

/**
 * The lock the calling code runs under: a `@OnOneInstance()` or `@WithoutOverlapping()`
 * job's, a `withLock()` callback's, or one set with `run()`. Backed by
 * `AsyncLocalStorage`, so it reaches every service the job calls. A scheduled job gets its
 * fencing token and signal here, because the scheduler calls it without arguments.
 */
@Injectable()
export class LocksContext {
  /** The lock. `undefined` outside a locked section. */
  get lock(): Lock | undefined {
    return scopes.getStore()?.lock;
  }

  /** The lock's fencing token. `undefined` outside a locked section. */
  get fencingToken(): number | undefined {
    return scopes.getStore()?.lock.fencingToken;
  }

  /**
   * Aborts when the section should stop: its lock was lost or released, or, for a
   * `@OnOneInstance()` job, this instance stopped owning the job. A job's run has a signal of
   * its own, which also aborts when the run ends. `undefined` outside a locked section.
   */
  get signal(): AbortSignal | undefined {
    return scopes.getStore()?.signal;
  }

  /** Runs `fn` under `lock` (code that acquired a lock itself, a test). */
  run<T>(lock: Lock, fn: () => T): T {
    return scopes.run({ lock, signal: lock.signal }, fn);
  }
}
