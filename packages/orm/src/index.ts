
// Core types
export type {
  BaseEntityColumnOption,
  BaseEntityOptions,
  CascadeOption,
  CircularJsonStrategy,
  CloudflareD1DatabaseLike,
  DeepPartial,
  DeleteResult,
  EmbeddedStorageMode,
  EntityRef,
  EntityTarget,
  FindManyOptions,
  FindOneOptions,
  FindOperatorLike,
  FindOperatorType,
  FindOrderDirection,
  FindOptionsOrder,
  FindOptionsRelations,
  FindOptionsSelect,
  FindOptionsWhere,
  FindOptionsWhereProperty,
  InsertResult,
  InverseSideSelector,
  LifecycleEventKind,
  ObjectType,
  OrmColumnOptions,
  OrmColumnTransformer,
  OrmColumnType,
  OrmConnectionCredentials,
  OrmDataSourceOptions,
  OrmDatabaseType,
  OrmDialect,
  OrmDocumentDriverLike,
  OrmDriverLike,
  OrmEmbeddedOptions,
  OrmEntityOptions,
  OrmIndexOptions,
  OrmIsolationLevel,
  OrmJoinColumnOptions,
  OrmJoinTableOptions,
  OrmMigration,
  OrmMigrationRecord,
  OrmMigrationStatus,
  OrmMorphManyOptions,
  OrmMorphTargets,
  OrmMorphToOptions,
  OrmQueryExecutor,
  OrmQueryLogEvent,
  OrmQueryResult,
  OrmRelationOptions,
  OrmReplicationOptions,
  OrmSslOption,
  OrmTlsOptions,
  OrmTransactionOptions,
  OrmTransactionPropagation,
  OrmUniqueOptions,
  PrimaryGeneratedStrategy,
  ReferentialAction,
  RelationKind,
  RemoveOptions,
  SaveOptions,
  UpdateResult,
} from "./types";

// Errors
export {
  CircularEmbeddedError,
  DataSourceNotInitializedError,
  EntityMetadataNotFoundError,
  EntityNotFoundError,
  InvalidTenantIdentifierError,
  OptimisticLockError,
  OrmError,
  QueryFailedError,
  RelationMetadataError,
  TransactionPropagationError,
} from "./errors";

// Zero-overhead Diagnostics Channel Telemetry
export { runInRollbackTransaction } from "./testing-transaction";
export {
  OrmNPlusOneError,
  createNPlusOneDetector,
  normalizeSqlFingerprint,
  withNPlusOneDetection,
  type NPlusOneDetectionEvent,
  type NPlusOneDetectorHandle,
  type NPlusOneDetectorOptions,
} from "./n-plus-one-detector";
export {
  ORM_QUERY_CHANNEL,
  ORM_TRANSACTION_CHANNEL,
  emitOrmQueryDiagnostic,
  emitOrmTransactionDiagnostic,
  hasOrmQuerySubscribers,
  hasOrmTransactionSubscribers,
  type OrmQueryDiagnosticEvent,
  type OrmTransactionDiagnosticEvent,
} from "./diagnostics";

// Transaction Lifecycle Hooks & Helpers
export {
  hasActiveTransactionHookScope,
  isRetryableTransactionError,
  onTransactionCommit,
  onTransactionRollback,
  type TransactionLifecycleHook,
} from "./transaction-hooks";

// PostgreSQL RLS & Schema-per-Tenant Multi-Tenancy
export {
  runInTenantTransaction,
  validateRlsSettingName,
  validateTenantSchemaIdentifier,
  type TenantTransactionMode,
  type TenantTransactionOptions,
} from "./tenant-rls";

// Identifiers & EntityRef helpers
export {
  assertSafeSqlIdentifier,
  camelToSnake,
  escapeLikePattern,
  formatPlaceholder,
  formatTableRef,
  inferTableName,
  makeConstraintName,
  normalizeDialect,
  pluralizeWord,
  quoteIdentifier,
} from "./identifiers";
export {
  entityRef,
  extractInversePropertyName,
  isEntityRef,
} from "./entity-ref";

// Multi-Dialect SQL & Document Profile Registry (all 12 TypeORM dialects)
export {
  getDialectProfile,
  getSupportedDialects,
  type DialectColumnDescriptor,
  type ForeignKeySyncStrategy,
  type ReturningStyle,
  type SqlDialectProfile,
} from "./dialect/dialect-profile";

// Find Operators
export {
  And,
  Between,
  Equal,
  FindOperator,
  ILike,
  In,
  IsNull,
  LessThan,
  LessThanOrEqual,
  Like,
  MoreThan,
  MoreThanOrEqual,
  Not,
  Or,
  Raw,
  isFindOperator,
} from "./operators";

// Metadata Storage & Registry (Phase 1)
export {
  OrmMetadataStorage,
  getInheritanceChain,
  resolveConstructor,
  type ClassOrmMetadataBucket,
  type OrmRegistrySnapshot,
  type StoredOrmColumnMetadata,
  type StoredOrmEmbeddedMetadata,
  type StoredOrmEntityMetadata,
  type StoredOrmIndexMetadata,
  type StoredOrmJoinColumnMetadata,
  type StoredOrmJoinTableMetadata,
  type StoredOrmListenerMetadata,
  type StoredOrmRelationMetadata,
} from "./metadata-storage";

// Decorators (Property-level + Zero-TDZ Class-level + Lifecycle + MongoDB @ObjectIdColumn)
export {
  AfterInsert,
  AfterLoad,
  AfterRemove,
  AfterUpdate,
  BaseEntity,
  BeforeInsert,
  BeforeRemove,
  BeforeUpdate,
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Embeddable,
  Embedded,
  Entity,
  Index,
  JoinColumn,
  JoinTable,
  ManyToMany,
  ManyToOne,
  MorphMany,
  MorphTo,
  ObjectIdColumn,
  OneToMany,
  OneToOne,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
  VersionColumn,
} from "./decorators";
export {
  getEntityColumns,
  getEntityIndexes,
  getEntitySchema,
  hasEntitySchema,
} from "@bunest/core";

// Programmatic zero-decorator schema builder
export {
  defineEmbeddable,
  defineEntity,
  type DefineEmbeddedConfig,
  type DefineEntitySchemaConfig,
  type DefineRelationConfig,
} from "./define-entity";

// Two-Phase Lazy Metadata Graph Compiler (Phase 2)
export {
  compileMetadataGraph,
  resolveEntityTargetClass,
  type CompiledColumnMetadata,
  type CompiledEmbeddedMetadata,
  type CompiledEntityMetadata,
  type CompiledIndexMetadata,
  type CompiledJoinTableMetadata,
  type CompiledMetadataGraph,
  type CompiledMorphTargetEntry,
  type CompiledRelationMetadata,
} from "./metadata-graph";

// Bun-Native Multi-Database Drivers & BSON Codec
export {
  OrmDriverRegistry,
  isDocumentDriver,
  type OrmDocumentDriver,
  type OrmDriver,
  type OrmDriverFactory,
} from "./driver/driver.interface";
export {
  SqliteOrmDriver,
  type SqliteOrmDriverOptions,
} from "./driver/sqlite.driver";
export {
  BunSqlOrmDriver,
  buildBunSqlConfig,
  type BunSqlOrmDriverOptions,
} from "./driver/bun-sql.driver";
export {
  LibSqlOrmDriver,
  type LibSqlOrmDriverOptions,
} from "./driver/libsql.driver";
export {
  D1OrmDriver,
  type D1OrmDriverOptions,
} from "./driver/d1.driver";
export {
  MONGO_OP_MSG,
  ObjectId,
  decodeBson,
  decodeOpMsg,
  encodeBson,
  encodeOpMsg,
  generateObjectId,
  type DecodedOpMsg,
} from "./driver/bson";
export {
  MongoOrmDriver,
  matchesMongoFilter,
  type MongoOrmDriverOptions,
} from "./driver/mongodb.driver";
export { ReplicatedOrmDriver } from "./driver/replicated.driver";
export { createDriverFromOptions } from "./driver/driver-factory";

// DDL, Hydration, Serialization
export {
  SchemaBuilder,
  generateSchemaPlan,
  type GeneratedSchemaPlan,
} from "./schema-builder";
export {
  ORM_ENTITY_META,
  attachSafeToJson,
  serializeEntity,
  type SerializeEntityOptions,
} from "./serializer";
export {
  IdentityMap,
  ORM_SHADOW_FKS,
  safeInstantiate,
} from "./hydrator";

// Query Builders, Repository, MongoRepository, EntityManager, DataSource
export {
  DeleteQueryBuilder,
  InsertQueryBuilder,
  SelectQueryBuilder,
  UpdateQueryBuilder,
} from "./query-builder";
export { OrmRepository } from "./repository";
export {
  MongoRepository,
  type MongoFindOptions,
} from "./mongo-repository";
export { EntityManager } from "./entity-manager";
export { DataSource } from "./data-source";

// Declarative Compiled-Once Repository Engine
export {
  CrudRepository,
  ORM_REPOSITORY_METADATA,
  Repository,
  compileOrmRepository,
  getOrmRepositoryMetadata,
  isDeclarativeOrmRepository,
  type CompiledOrmRepositoryFactory,
  type OrmDeclarativeHost,
  type OrmRepositoryMetadata,
  type OrmRepositoryOptions,
  type OrmSqlParams,
} from "./declarative-repository";

// Declarative Repository Extensions (Custom Operators, Scopes, Pagination, Composable Fragments)
export {
  CURSOR_PAGEABLE_BRAND,
  ORM_CUSTOM_QUERY_OPERATORS_SYMBOL,
  ORM_REPOSITORY_FRAGMENTS_METADATA,
  ORM_REPOSITORY_SCOPES_METADATA,
  ORM_SOFT_DELETE_CONFIG_METADATA,
  PAGEABLE_BRAND,
  RepositoryScope,
  SoftDelete,
  TenantScoped,
  clearRegisteredQueryOperators,
  composeRepository,
  createCursorPageable,
  createPageable,
  createSoftDeleteMethods,
  createSoftDeleteScope,
  defineRepositoryFragment,
  getAmbientIgnoredScopes,
  getRegisteredQueryOperator,
  getRepositoryFragments,
  getRepositoryScopes,
  getSoftDeleteConfig,
  isCursorPageable,
  isPageable,
  isScopeIgnored,
  listRegisteredQueryOperators,
  registerQueryOperator,
  runWithIgnoredScopes,
  unregisterQueryOperator,
  withCursorPagination,
  withSoftDelete,
  type ComposedRepositoryClass,
  type CursorPage,
  type CursorPageable,
  type CursorPaginationFragmentMethods,
  type CursorPaginationFragmentOptions,
  type CustomQueryOperator,
  type CustomQueryOperatorSqlContext,
  type IgnoreScopeSpec,
  type Page,
  type PageSortSpec,
  type Pageable,
  type RepositoryFragment,
  type RepositoryFragmentRuntimeContext,
  type RepositoryScopeContext,
  type RepositoryScopeDefinition,
  type RepositoryScopeOperation,
  type RepositoryScopeWhereResult,
  type ResolvedSoftDeleteConfig,
  type SoftDeleteFragmentMethods,
  type SoftDeleteOptions,
  type TenantScopedOptions,
} from "./repository-extensions";

// Multi-Dialect Migration Runner
export {
  DEFAULT_ORM_MIGRATIONS_TABLE,
  OrmMigrationRunner,
  splitSqlStatements,
  type OrmMigrationHost,
} from "./migration-runner";

// Bunest DI Integration
export {
  DEFAULT_ORM_DATA_SOURCE,
  ORM_DATA_SOURCE_NAME,
  ORM_MODULE_OPTIONS,
  getOrmDataSourceToken,
  getOrmEntityManagerToken,
  getOrmMigrationRunnerToken,
  getOrmRepositoryToken,
  getOrmTransactionalAspectToken,
} from "./di/tokens";
export {
  InjectDataSource,
  InjectEntityManager,
  InjectOrmMigrations,
  InjectRepository,
  OrmTransactionalAspect,
  Transactional,
  type OrmTransactionalOptions,
} from "./di/decorators";
export {
  OrmCoreModule,
  OrmModule,
  clearOrmFeatureRegistry,
  type OrmModuleAsyncOptions,
  type OrmOptionsFactory,
} from "./di/orm.module";

// Zero-Dep Drizzle & Prisma First-Class Integrations
export {
  DEFAULT_DRIZZLE_TOKEN,
  DrizzleModule,
  DrizzleTransactionHost,
  DrizzleTransactional,
  DrizzleTransactionalAspect,
  InjectDrizzle,
  InjectDrizzleTransactionHost,
  getDrizzleToken,
  getDrizzleTransactionHostToken,
  getDrizzleTransactionalAspectToken,
  type DrizzleDatabaseLike,
  type DrizzleIsolationLevel,
  type DrizzleModuleAsyncOptions,
  type DrizzleModuleOptions,
  type DrizzleOptionsFactory,
  type DrizzleTransactionConfig,
  type DrizzleTransactionOptions,
  type DrizzleTransactionalOptions,
} from "./integrations/drizzle.module";
export {
  DEFAULT_PRISMA_TOKEN,
  InjectPrisma,
  InjectPrismaTransactionHost,
  PrismaModule,
  PrismaTransactionHost,
  PrismaTransactional,
  PrismaTransactionalAspect,
  getPrismaToken,
  getPrismaTransactionHostToken,
  getPrismaTransactionalAspectToken,
  type PrismaClientLike,
  type PrismaInteractiveTransactionOptions,
  type PrismaIsolationLevel,
  type PrismaModuleAsyncOptions,
  type PrismaModuleOptions,
  type PrismaOptionsFactory,
  type PrismaTransactionOptions,
  type PrismaTransactionalOptions,
} from "./integrations/prisma.module";

// Bun Circular-Safe Plugin helpers
export {
  createOrmCircularSafePlugin,
  registerOrmCircularSafePlugin,
  transformCircularMetadataJs,
  transformCircularMetadataSource,
  type OrmCircularSafePluginOptions,
} from "./plugin/circular-safe.plugin";
