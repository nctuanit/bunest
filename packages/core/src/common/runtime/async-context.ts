/**
 * Quarantined Async Context kernel adapter (1 of 2 allowed `node:*` adapter
 * files in the entire Bunest monorepo).
 *
 * Automatically uses TC39 `globalThis.AsyncContext.Variable` when available in
 * the JS runtime, and falls back to Bun's native `AsyncLocalStorage` kernel
 * primitive otherwise.
 */
import { AsyncLocalStorage } from "node:async_hooks";

interface Tc39AsyncContextVariable<T> {
  run<R>(value: T | undefined, callback: (...args: any[]) => R, ...args: any[]): R;
  get(): T | undefined;
}

interface Tc39AsyncContextNamespace {
  Variable?: new <T>(options?: {
    name?: string;
    defaultValue?: T;
  }) => Tc39AsyncContextVariable<T>;
}

export interface ContextStorageLike<T> {
  getStore(): T | undefined;
  run<R>(store: T, callback: () => R): R;
  enterWith?(store: T): void;
  exit?<R>(callback: () => R): R;
  disable?(): void;
}

export class ContextStorage<T> implements ContextStorageLike<T> {
  private readonly tc39Var?: Tc39AsyncContextVariable<T>;
  private readonly als?: AsyncLocalStorage<T>;

  constructor() {
    const asyncCtx = (
      globalThis as { AsyncContext?: Tc39AsyncContextNamespace }
    ).AsyncContext;
    if (asyncCtx && typeof asyncCtx.Variable === "function") {
      this.tc39Var = new asyncCtx.Variable<T>();
    } else {
      this.als = new AsyncLocalStorage<T>();
    }
  }

  getStore(): T | undefined {
    if (this.tc39Var) {
      return this.tc39Var.get();
    }
    return this.als!.getStore();
  }

  run<R>(store: T, callback: () => R): R {
    if (this.tc39Var) {
      return this.tc39Var.run(store, callback);
    }
    return this.als!.run(store, callback);
  }

  enterWith(store: T): void {
    if (this.als) {
      this.als.enterWith(store);
      return;
    }
    throw new Error(
      "ContextStorage.enterWith() is not supported when backed by TC39 AsyncContext.Variable; use run() instead.",
    );
  }

  exit<R>(callback: () => R): R {
    if (this.tc39Var) {
      return this.tc39Var.run(undefined, callback);
    }
    return this.als!.exit(callback);
  }

  disable(): void {
    this.als?.disable();
  }

  static snapshot(): <R, TArgs extends any[]>(
    fn: (...args: TArgs) => R,
    ...args: TArgs
  ) => R {
    return AsyncLocalStorage.snapshot();
  }

  static bind<Func extends (...args: any[]) => any>(fn: Func): Func {
    return AsyncLocalStorage.bind(fn);
  }
}
