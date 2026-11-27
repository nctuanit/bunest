// Module and options
export { IdempotencyModule } from "./idempotency.module";
export { IDEMPOTENCY_MODULE_OPTIONS } from "./idempotency.module-definition";
export type { Duration } from "./utils/index";
export type {
  IdempotencyModuleAsyncOptions,
  IdempotencyModuleOptions,
  IdempotencyOptionsFactory,
  IdempotentOptions,
} from "./interfaces/index";

// Marking handlers
export { Idempotent } from "./decorators/index";

// Store contract, registry and default in-memory store
export type {
  IdempotencyAcquireResult,
  IdempotencySealedResponse,
  IdempotencyStorageRegisterOptions,
  IdempotencyStore,
  IdempotencyStoredPayload,
  IdempotencyStoredResponse,
} from "./interfaces/index";
export { IdempotencyStorage } from "./storage/index";
export {
  InMemoryIdempotencyStore,
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
} from "./stores/index";

// Errors & error codes
export { IdempotencyStoreTimeoutError } from "./errors/index";
export type { IdempotencyErrorCode } from "./interfaces/index";

// Events: zero-RxJS `IdempotencyEvents.events$` + `nestjs:idempotency:*` diagnostics channels
export {
  IdempotencyEvents,
  type IdempotencyEvent,
  type IdempotencyLockLostEvent,
  type IdempotencyRejectedEvent,
  type IdempotencyReplayedEvent,
} from "./events/index";
