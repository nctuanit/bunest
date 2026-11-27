// Module and options
export { LocksModule } from "./locks.module";
export { LOCKS_MODULE_OPTIONS } from "./locks.module-definition";
export type { Duration } from "./interfaces/duration.interface";
export type {
  LocksModuleAsyncOptions,
  LocksModuleOptions,
  LocksOptionsFactory,
} from "./interfaces/locks-module-options.interface";

// Locks in your code: acquire(), withLock(), the lock they hand you, and the lock a job runs under
export { Locks } from "./locks.service";
export type { LockOptions } from "./interfaces/lock-options.interface";
export { Lock } from "./lock/lock";
export { LocksContext } from "./context/locks.context";

// Decorators: scheduled jobs on one instance and without overlap, leader election, and general @WithLock()
export { LeaderElection } from "./decorators/leader-election.decorator";
export { OnOneInstance } from "./decorators/on-one-instance.decorator";
export { WithoutOverlapping } from "./decorators/without-overlapping.decorator";
export {
  WithLock,
  WithLockAspectHandler,
  type WithLockAspectMetadataOptions,
  type WithLockKey,
  type WithLockOptions,
} from "./decorators/with-lock.decorator";
export type {
  LeaderElectionOptions,
  OnLeadershipAcquired,
  OnLeadershipLost,
} from "./interfaces/leader-election.interface";
export type {
  OnOneInstanceOptions,
  WithoutOverlappingOptions,
} from "./interfaces/job-options.interface";

// Errors
export { LockLostError } from "./errors/lock-lost.error";
export { LockNotAcquiredError } from "./errors/lock-not-acquired.error";
export { LockStoreTimeoutError } from "./errors/lock-store-timeout.error";
export { LocksError } from "./errors/locks.error";

// Events: `LocksEvents.events$` and `jobSkips$`, and `nestjs:locks:*` diagnostics channels
export type {
  LocksEvent,
  LocksJobSkippedEvent,
  LocksJobSkipReason,
  LocksLeadershipAcquiredEvent,
  LocksLeadershipLostEvent,
  LocksLockLostEvent,
} from "./events/locks-events.interface";
export { LocksEvents } from "./events/locks-events.service";

// Storage and stores
export type {
  InMemoryLock,
  InMemoryLockStoreOptions,
} from "./interfaces/in-memory-lock-store.interface";
export type {
  LockAcquireResult,
  LockStore,
} from "./interfaces/lock-store.interface";
export type { LocksStorageRegisterOptions } from "./interfaces/locks-storage-register-options.interface";
export { LocksStorage } from "./storage/locks.storage";
export { InMemoryLockStore } from "./stores/in-memory-lock.store";
export {
  LUA_REDIS_LOCK_ACQUIRE,
  LUA_REDIS_LOCK_RELEASE,
  LUA_REDIS_LOCK_RENEW,
  RedisLockStore,
  type RedisLockClientLike,
  type RedisLockStoreOptions,
} from "./stores/redis-lock.store";
export {
  SqlLockStore,
  createBunSqliteLockExecutor,
  getLocksMigrationSql,
  getLocksMigrationStatements,
  type BunSqlLockClientLike,
  type BunSqliteLockDatabaseLike,
  type LocksMigrationOptions,
  type SqlLockDialect,
  type SqlLockExecutorLike,
  type SqlLockQueryExecutor,
  type SqlLockQueryResult,
  type SqlLockStoreOptions,
} from "./stores/sql-lock.store";

// Clock & test double
export type {
  LockClock,
  LockTimerOptions,
} from "./interfaces/lock-clock.interface";
export { ManualLockClock } from "./testing/manual-lock-clock";
