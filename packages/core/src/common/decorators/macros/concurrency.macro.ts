const MUTEX_STATE_SYM = Symbol("bunest:macro:mutex");
const RWLOCK_STATE_SYM = Symbol("bunest:macro:rwlock");

class AsyncMutex {
  private locked = false;
  private readonly queue: Array<() => void> = [];

  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return () => this.release();
    }
    await new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
    return () => this.release();
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }
}

class AsyncReadWriteLock {
  private activeReaders = 0;
  private activeWriter = false;
  private readonly pending: Array<{
    readonly mode: "read" | "write";
    readonly resolve: () => void;
  }> = [];

  async acquireRead(): Promise<() => void> {
    if (!this.activeWriter && this.pending.length === 0) {
      this.activeReaders++;
      return () => this.releaseRead();
    }
    await new Promise<void>((resolve) => {
      this.pending.push({ mode: "read", resolve });
    });
    return () => this.releaseRead();
  }

  async acquireWrite(): Promise<() => void> {
    if (!this.activeWriter && this.activeReaders === 0) {
      this.activeWriter = true;
      return () => this.releaseWrite();
    }
    await new Promise<void>((resolve) => {
      this.pending.push({ mode: "write", resolve });
    });
    return () => this.releaseWrite();
  }

  private releaseRead(): void {
    this.activeReaders = Math.max(0, this.activeReaders - 1);
    if (this.activeReaders === 0) {
      this.drain();
    }
  }

  private releaseWrite(): void {
    this.activeWriter = false;
    this.drain();
  }

  private drain(): void {
    if (this.pending.length === 0 || this.activeWriter) return;
    const head = this.pending[0]!;
    if (head.mode === "write") {
      if (this.activeReaders === 0) {
        this.pending.shift();
        this.activeWriter = true;
        head.resolve();
      }
      return;
    }
    while (this.pending.length > 0 && this.pending[0]!.mode === "read") {
      const next = this.pending.shift()!;
      this.activeReaders++;
      next.resolve();
    }
  }
}

const NAMED_MUTEX_LOCKS = new Map<string | symbol, AsyncMutex>();
const NAMED_RW_LOCKS = new Map<string | symbol, AsyncReadWriteLock>();

function getMutexForTarget(
  instance: object,
  lockKey?: string | symbol,
): AsyncMutex {
  if (lockKey !== undefined) {
    let lock = NAMED_MUTEX_LOCKS.get(lockKey);
    if (!lock) {
      lock = new AsyncMutex();
      NAMED_MUTEX_LOCKS.set(lockKey, lock);
    }
    return lock;
  }
  const host = instance as Record<symbol, AsyncMutex | undefined>;
  let lock = host[MUTEX_STATE_SYM];
  if (!lock) {
    lock = new AsyncMutex();
    Object.defineProperty(instance, MUTEX_STATE_SYM, {
      value: lock,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  return lock;
}

function getRwLockForTarget(
  instance: object,
  lockKey?: string | symbol,
): AsyncReadWriteLock {
  if (lockKey !== undefined) {
    let lock = NAMED_RW_LOCKS.get(lockKey);
    if (!lock) {
      lock = new AsyncReadWriteLock();
      NAMED_RW_LOCKS.set(lockKey, lock);
    }
    return lock;
  }
  const host = instance as Record<symbol, AsyncReadWriteLock | undefined>;
  let lock = host[RWLOCK_STATE_SYM];
  if (!lock) {
    lock = new AsyncReadWriteLock();
    Object.defineProperty(instance, RWLOCK_STATE_SYM, {
      value: lock,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  return lock;
}

/**
 * Async Mutex decorator: serializes concurrent calls to the decorated method in strict FIFO order
 * (scoped per-instance by default, or globally by `lockKey`).
 */
export function Synchronized(lockKey?: string | symbol): MethodDecorator {
  return (
    _target: object,
    _propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ): PropertyDescriptor => {
    const orig = descriptor.value as (...args: unknown[]) => unknown;
    if (typeof orig !== "function") return descriptor;

    descriptor.value = async function (this: object, ...args: unknown[]) {
      const mutex = getMutexForTarget(this, lockKey);
      const release = await mutex.acquire();
      try {
        return await orig.apply(this, args);
      } finally {
        release();
      }
    };
    return descriptor;
  };
}

interface LockedDecorator {
  (lockKey?: string | symbol): MethodDecorator;
  Read: (lockKey?: string | symbol) => MethodDecorator;
  Write: (lockKey?: string | symbol) => MethodDecorator;
}

function createLockedDecorator(
  mode: "read" | "write",
  lockKey?: string | symbol,
): MethodDecorator {
  return (
    _target: object,
    _propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ): PropertyDescriptor => {
    const orig = descriptor.value as (...args: unknown[]) => unknown;
    if (typeof orig !== "function") return descriptor;

    descriptor.value = async function (this: object, ...args: unknown[]) {
      const rw = getRwLockForTarget(this, lockKey);
      const release =
        mode === "read" ? await rw.acquireRead() : await rw.acquireWrite();
      try {
        return await orig.apply(this, args);
      } finally {
        release();
      }
    };
    return descriptor;
  };
}

/**
 * Async Read/Write Lock decorator (`@Locked()` / `@Locked.Write()` = exclusive, `@Locked.Read()` = shared concurrent readers).
 */
export const Locked: LockedDecorator = Object.assign(
  function Locked(lockKey?: string | symbol): MethodDecorator {
    return createLockedDecorator("write", lockKey);
  },
  {
    Read(lockKey?: string | symbol): MethodDecorator {
      return createLockedDecorator("read", lockKey);
    },
    Write(lockKey?: string | symbol): MethodDecorator {
      return createLockedDecorator("write", lockKey);
    },
  },
);
