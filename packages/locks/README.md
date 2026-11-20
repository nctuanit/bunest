# @bunest/locks

Distributed locks for Bunest: leased locks with monotonic fencing tokens and `AbortSignal` loss signals, `@OnOneInstance()` and `@WithoutOverlapping()` for scheduled jobs, `@WithLock()` AOP locking, and `@LeaderElection()`, over a pluggable `LockStore` with zero external runtime dependencies.

## Features

- **Leased Locks & Fencing Tokens**: `Locks.acquire()` and `Locks.withLock()` provide monotonic `fencingToken` values, automatic lease renewal, and `lock.signal` (`AbortSignal`) notification if a lock is lost.
- **Scheduled Job & Service Decorators**: `@OnOneInstance()`, `@WithoutOverlapping()`, `@WithLock()`, and `LocksContext` (`AsyncLocalStorage`) for safe multi-instance execution.
- **Leader Election**: `@LeaderElection()` with `OnLeadershipAcquired` and `OnLeadershipLost` lifecycle hooks.
- **Pluggable Storage & Deterministic Testing**: `LocksStorage`, `InMemoryLockStore`, `ManualLockClock`, and the runner-agnostic `lockStoreContract` suite from `@bunest/locks/testing`.
- **Zero-RxJS Observability**: `LocksEvents.events$` and `jobSkips$` expose native `Subscribable<T> & AsyncIterable<T>` streams per ADR-008.

## Installation

```bash
bun add @bunest/locks
```

## Quick Start

```ts
import { Injectable, Module } from "@bunest/common";
import {
  LeaderElection,
  Locks,
  LocksContext,
  LocksModule,
  OnOneInstance,
  WithoutOverlapping,
  type Lock,
  type OnLeadershipAcquired,
  type OnLeadershipLost,
} from "@bunest/locks";

@Injectable()
export class BillingService {
  constructor(
    private readonly locks: Locks,
    private readonly locksContext: LocksContext,
  ) {}

  async runInvoiceExport() {
    return this.locks.withLock("invoices:export", async (lock) => {
      return { token: lock.fencingToken };
    });
  }

  @OnOneInstance({ key: "billing:reconcile" })
  @WithoutOverlapping()
  async reconcile() {
    const token = this.locksContext.fencingToken;
    const signal = this.locksContext.signal;
    return { token, aborted: signal?.aborted };
  }
}

@Injectable()
@LeaderElection("warehouse-feed")
export class WarehouseFeed implements OnLeadershipAcquired, OnLeadershipLost {
  onLeadershipAcquired(lock: Lock) {
    // Runs while this instance leads; stop when lock.signal aborts
  }

  onLeadershipLost(lock: Lock) {
    // Called when leadership is lost or stepped down
  }
}

@Module({
  imports: [LocksModule.forRoot({ ttl: "30s" })],
  providers: [BillingService, WarehouseFeed],
})
export class AppModule {}
```

## Key Exports

- **Module & Core**: `LocksModule` (`forRoot`, `forRootAsync`), `LOCKS_MODULE_OPTIONS`, `Locks`, `Lock`, `LocksContext`, `LocksStorage`, `LocksEvents`
- **Decorators**: `@OnOneInstance()`, `@WithoutOverlapping()`, `@LeaderElection()`, `@WithLock()`, `WithLockAspectHandler`
- **Stores & Clocks**: `InMemoryLockStore`, `ManualLockClock`
- **Errors**: `LocksError`, `LockNotAcquiredError`, `LockLostError`, `LockStoreTimeoutError`

## Subpath Exports

- **`@bunest/locks/testing`**: `lockStoreContract` (runner-agnostic compliance suite for custom `LockStore` implementations)

## Documentation

- [Bunest Documentation](../../README.md)
- [ADR Index](../../docs/adr/README.md)
