import "reflect-metadata";

export {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  PrimaryKey,
  Unique,
  UpdateDateColumn,
  getEntityColumns,
  getEntityIndexes,
  getEntitySchema,
  hasEntitySchema,
  type ColumnDataType,
  type ColumnGenerationStrategy,
  type ColumnOptions,
  type ColumnTransformer,
  type EntityColumnMetadata,
  type EntityColumnMetadata as ColumnMetadata,
  type EntityIndexMetadata,
  type EntitySchemaMetadata,
  type EntitySchemaOptions,
  type IndexOptions,
  type UniqueOptions,
} from "@bunest/common";

export {
  generateCreateTableSql,
  type GeneratedTableDdl,
  type SchemaSqlDialect,
} from "./schema-generator";

export {
  DEFAULT_SQLITE_CONNECTION,
  SQLITE_ENTITY_METADATA,
  SQLITE_MODIFYING_METADATA,
  SQLITE_PARAM_METADATA,
  SQLITE_QUERY_METADATA,
  SQLITE_REPOSITORY_METADATA,
  getSqliteConnectionToken,
  getSqliteMigrationRunnerToken,
  getSqliteOptionsToken,
  getSqliteRepositoryToken,
  getSqliteTransactionalAspectToken,
} from "./tokens";

export {
  assertSafeSqlIdentifier,
  quoteSqlIdentifier,
} from "./identifiers";

export {
  DuplicateSqliteConnectionException,
  SqliteEntityNotFoundException,
} from "./exceptions";

export {
  InjectSqlite,
  InjectSqliteMigrations,
  InjectSqliteRepository,
  SqliteEntity,
} from "./decorators";

export {
  SqliteTransactional,
  SqliteTransactionalAspect,
  Transactional,
} from "./transactional";

export {
  DeclarativeSqliteRepository,
  JpaRepository,
  Modifying,
  Param,
  Query,
  Repository,
  SqlParam,
  SqliteQuery,
  SqliteRepository,
  compileSqliteRepository,
  getSqliteRepositoryMetadata,
  isDeclarativeSqliteRepository,
  type CompiledSqliteRepositoryFactory,
} from "./declarative-repository";

export { SqliteService } from "./sqlite.service";

export { SqliteMigrationRunner } from "./migration-runner";

export {
  BaseSqliteRepository,
  type SqliteFindOptions,
  type SqliteOrderBySpec,
} from "./base-repository";

export { SqliteModule } from "./sqlite.module";

export type {
  SqliteDatabaseAdapter,
  SqliteEntityMetadata,
  SqliteFeatureRepositoryConfig,
  SqliteMigration,
  SqliteMigrationRecord,
  SqliteMigrationStatus,
  SqliteModifyingOptions,
  SqliteModuleAsyncOptions,
  SqliteModuleOptions,
  SqliteNamedParams,
  SqliteOptionsFactory,
  SqliteParamMetadataMap,
  SqliteParamValue,
  SqliteQueryEvent,
  SqliteQueryExecutor,
  SqliteQueryMetadata,
  SqliteQueryOptions,
  SqliteQueryParams,
  SqliteQueryReturnMode,
  SqliteRepositoryMetadata,
  SqliteRepositoryOptions,
  SqliteRepositoryTarget,
  SqliteRunResult,
  SqliteTransactionContext,
  SqliteTransactionMode,
  SqliteTransactionOptions,
  SqliteTransactionalOptions,
} from "./interfaces";
