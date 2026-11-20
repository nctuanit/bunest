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
} from "./schema-generator";

export type {
  AppliedMigration,
  DatabaseAdapter,
  MigrationDefinition,
  MigrationRunner,
  MigrationStatus,
  QueryResult,
  TransactionContext,
} from "./contracts";

export {
  assertSafeSqlIdentifier,
  normalizeSqlDialect,
  quoteSqlIdentifier,
  type SqlDialect,
} from "./identifiers";

export {
  DEFAULT_DRIZZLE_CONNECTION,
  DEFAULT_PRISMA_CONNECTION,
  DEFAULT_SQL_CONNECTION,
  SQL_ENTITY_METADATA,
  SQL_MODIFYING_METADATA,
  SQL_PARAM_METADATA,
  SQL_QUERY_METADATA,
  SQL_REPOSITORY_METADATA,
  getDrizzleOptionsToken,
  getDrizzleServiceToken,
  getDrizzleToken,
  getDrizzleTransactionalAspectToken,
  getPrismaOptionsToken,
  getPrismaServiceToken,
  getPrismaToken,
  getPrismaTransactionalAspectToken,
  getSqlConnectionToken,
  getSqlMigrationRunnerToken,
  getSqlOptionsToken,
  getSqlRepositoryToken,
  getSqlTransactionalAspectToken,
} from "./tokens";

export {
  InjectDrizzle,
  InjectDrizzleService,
  InjectPrisma,
  InjectPrismaService,
  InjectSql,
  InjectSqlMigrations,
  InjectSqlRepository,
} from "./decorators";

export {
  DrizzleTransactionalAspect,
  PrismaTransactionalAspect,
  SqlTransactional,
  SqlTransactionalAspect,
  Transactional,
} from "./transactional";

export {
  DeclarativeSqlRepository,
  Modifying,
  Param,
  Query,
  SqlCrudRepository,
  SqlEntity,
  SqlParam,
  SqlQuery,
  SqlRepository,
  compileSqlRepository,
  getSqlRepositoryMetadata,
  isDeclarativeSqlRepository,
  type CompiledSqlRepositoryFactory,
} from "./declarative-repository";

export { SqlService, type SqlTagFunction } from "./sql.service";

export { SqlMigrationRunner } from "./sql-migration-runner";

export { SqlModule } from "./sql.module";

export type {
  SqlEntityMetadata,
  SqlMigrationExecutor,
  SqlMigrationRunnerOptions,
  SqlModifyingOptions,
  SqlModuleAsyncOptions,
  SqlModuleForRootInput,
  SqlModuleOptions,
  SqlOptionsFactory,
  SqlParamMetadataMap,
  SqlQueryEvent,
  SqlQueryMetadata,
  SqlQueryOptions,
  SqlQueryReturnMode,
  SqlRepositoryMetadata,
  SqlRepositoryOptions,
  SqlRepositoryTarget,
  SqlTransactionOptions,
  SqlTransactionalAdapter,
  SqlTransactionalOptions,
} from "./interfaces";

export {
  DrizzleModule,
  DrizzleService,
  type DrizzleClosableClient,
  type DrizzleDatabaseLike,
  type DrizzleModuleAsyncOptions,
  type DrizzleModuleOptions,
  type DrizzleOptionsFactory,
} from "./orm/drizzle.module";

export {
  PrismaModule,
  PrismaServiceBase,
  mapPrismaErrorToHttp,
  type PrismaClientLike,
  type PrismaModuleAsyncOptions,
  type PrismaModuleOptions,
  type PrismaOptionsFactory,
  type PrismaServiceOptions,
} from "./orm/prisma.module";
