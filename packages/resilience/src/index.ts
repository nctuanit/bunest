// Nest/Bunest integration: the module, entrypoint decorators, and what services inject.
export { ResilienceModule } from "./resilience.module";
export { RESILIENCE_METHOD_ASPECT } from "./resilience.constants";
export { ResilienceMethodAspectHandler } from "./aspects/resilience-aspect.handler";
export {
  RESILIENCE_MODULE_OPTIONS,
  type ResilienceModuleAsyncOptions,
  type ResilienceOptionsFactory,
} from "./resilience.module-definition";
export * from "./decorators/index";
export { ResilienceService } from "./resilience.service";
export { ResilienceContext } from "./context/index";

// Policy objects: the building blocks, usable anywhere (services, scripts, other packages).
export {
  BulkheadPolicy,
  CircuitBreakerPolicy,
  FallbackPolicy,
  isClientError,
  OutboundRateLimitPolicy,
  ResiliencePolicy,
  RetryPolicy,
  TimeoutPolicy,
} from "./policies/index";

// Option types
export type {
  AttemptContext,
  BackoffOptions,
  BulkheadOptions,
  CircuitBreakerOptions,
  Duration,
  ExecuteOptions,
  FallbackOptions,
  OutboundRateLimitOptions,
  ResilienceDefaults,
  ResilienceModuleOptions,
  ResiliencePreset,
  RetryOptions,
  TimeoutOptions,
} from "./interfaces/index";

// Errors: what policies throw, and what entrypoints turn into 504s and 503s.
export {
  BulkheadFullError,
  CircuitOpenError,
  OutboundRateLimitError,
  ResilienceError,
  ResilienceTimeoutError,
} from "./errors/index";

// Events: ResilienceEvents.events$, or the `nestjs:resilience:<type>` diagnostics channels.
export {
  ResilienceEvents,
  type CircuitState,
  type ResilienceBulkheadRejectedEvent,
  type ResilienceCircuitClosedEvent,
  type ResilienceCircuitHalfOpenEvent,
  type ResilienceCircuitOpenEvent,
  type ResilienceCircuitRejectedEvent,
  type ResilienceEvent,
  type ResilienceFallbackEvent,
  type ResilienceRateLimitedEvent,
  type ResilienceRetryEvent,
  type ResilienceTimeoutEvent,
} from "./events/index";

// Distributed lock stores & migration helpers (also exported from `@bunest/resilience/locks`)
export {
  LUA_REDIS_LOCK_ACQUIRE,
  LUA_REDIS_LOCK_RELEASE,
  LUA_REDIS_LOCK_RENEW,
  RedisLockStore,
  SqlLockStore,
  createBunSqliteLockExecutor,
  getLocksMigrationSql,
  getLocksMigrationStatements,
  type BunSqlLockClientLike,
  type BunSqliteLockDatabaseLike,
  type LocksMigrationOptions,
  type RedisLockClientLike,
  type RedisLockStoreOptions,
  type SqlLockDialect,
  type SqlLockExecutorLike,
  type SqlLockQueryExecutor,
  type SqlLockQueryResult,
  type SqlLockStoreOptions,
} from "./locks/index";

// Distributed idempotency stores & migration helpers (also exported from `@bunest/resilience/idempotency`)
export {
  LUA_REDIS_IDEMPOTENCY_ACQUIRE,
  LUA_REDIS_IDEMPOTENCY_COMPLETE,
  LUA_REDIS_IDEMPOTENCY_EXTEND,
  LUA_REDIS_IDEMPOTENCY_RELEASE,
  RedisIdempotencyStore,
  SqlIdempotencyStore,
  createBunSqliteIdempotencyExecutor,
  getIdempotencyMigrationSql,
  getIdempotencyMigrationStatements,
  type BunSqlIdempotencyClientLike,
  type BunSqliteIdempotencyDatabaseLike,
  type IdempotencyMigrationOptions,
  type RedisIdempotencyClientLike,
  type RedisIdempotencyStoreOptions,
  type SqlIdempotencyDialect,
  type SqlIdempotencyExecutorLike,
  type SqlIdempotencyQueryExecutor,
  type SqlIdempotencyQueryResult,
  type SqlIdempotencyStoreOptions,
} from "./idempotency/index";
