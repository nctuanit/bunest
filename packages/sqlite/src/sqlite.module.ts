import {
  DecoratorRegistry,
  MetadataRegistry,
  Module,
  getEntitySchema,
  hasEntitySchema,
  type Abstract,
  type DynamicModule,
  type InjectionToken,
  type ModuleExport,
  type Provider,
  type Type,
} from "@bunest/common";
import { BaseSqliteRepository } from "./base-repository";
import {
  compileSqliteRepository,
  getSqliteRepositoryMetadata,
  isDeclarativeSqliteRepository,
} from "./declarative-repository";
import { DuplicateSqliteConnectionException } from "./exceptions";
import type {
  SqliteEntityMetadata,
  SqliteModuleAsyncOptions,
  SqliteModuleOptions,
  SqliteOptionsFactory,
  SqliteRepositoryMetadata,
  SqliteRepositoryTarget,
} from "./interfaces";
import { SqliteMigrationRunner } from "./migration-runner";
import { SqliteService } from "./sqlite.service";
import {
  DEFAULT_SQLITE_CONNECTION,
  SQLITE_ENTITY_METADATA,
  getSqliteConnectionToken,
  getSqliteMigrationRunnerToken,
  getSqliteOptionsToken,
  getSqliteRepositoryToken,
  getSqliteTransactionalAspectToken,
} from "./tokens";
import { SqliteTransactionalAspect } from "./transactional";

function assertMatchingAsyncConnectionName(
  expectedName: string,
  resolved: SqliteModuleOptions,
): SqliteModuleOptions {
  if (resolved.name !== undefined && resolved.name !== expectedName) {
    throw new Error(
      `SqliteModule.forRootAsync("${expectedName}") received conflicting connection name "${resolved.name}" from options factory. Pass matching "name: '${resolved.name}'" to forRootAsync().`,
    );
  }
  return { ...resolved, name: expectedName };
}

function mergeAsyncSqliteOptions(
  asyncOptions: SqliteModuleAsyncOptions,
  resolved: SqliteModuleOptions,
): SqliteModuleOptions {
  const mergedEntities =
    asyncOptions.entities || resolved.entities
      ? [...(asyncOptions.entities ?? []), ...(resolved.entities ?? [])]
      : undefined;
  return {
    ...resolved,
    ...(mergedEntities !== undefined ? { entities: mergedEntities } : {}),
    ...(resolved.autoSync !== undefined
      ? { autoSync: resolved.autoSync }
      : asyncOptions.autoSync !== undefined
        ? { autoSync: asyncOptions.autoSync }
        : {}),
    ...(resolved.autoRegisterRepositories !== undefined
      ? { autoRegisterRepositories: resolved.autoRegisterRepositories }
      : asyncOptions.autoRegisterRepositories !== undefined
        ? { autoRegisterRepositories: asyncOptions.autoRegisterRepositories }
        : {}),
  };
}

function collectAutoRegisteredSqliteRepositories(
  connectionName: string,
  connectionToken: string,
): { providers: Provider[]; exports: ModuleExport[] } {
  const entries =
    DecoratorRegistry.getByKind<SqliteRepositoryMetadata>("sqlite-repository");
  const providers: Provider[] = [];
  const exportsList: ModuleExport[] = [];
  const tokenProviderIndex = new Map<string, number>();

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const repoConn = entry.meta?.connectionName ?? DEFAULT_SQLITE_CONNECTION;
    if (repoConn !== connectionName) {
      continue;
    }

    const RepoClass = entry.target as Abstract<any>;
    const compiled = compileSqliteRepository(RepoClass);
    const repoToken = getSqliteRepositoryToken(RepoClass, connectionName);

    providers.push({
      provide: RepoClass,
      useFactory: (sqlite: SqliteService) => compiled.createInstance(sqlite),
      inject: [connectionToken],
    });
    exportsList.push(RepoClass);

    const existingIdx = tokenProviderIndex.get(repoToken);
    if (existingIdx !== undefined) {
      providers[existingIdx] = {
        provide: repoToken,
        useExisting: RepoClass,
      };
    } else {
      tokenProviderIndex.set(repoToken, providers.length);
      providers.push({
        provide: repoToken,
        useExisting: RepoClass,
      });
      exportsList.push(repoToken);
    }
  }

  return { providers, exports: exportsList };
}

function isBaseRepositorySubclass(
  value: unknown,
): value is Type<BaseSqliteRepository<any, any>> {
  return (
    typeof value === "function" &&
    value.prototype instanceof BaseSqliteRepository
  );
}

/**
 * Bunest dynamic module for configuring one or more `bun:sqlite` connections
 * with DI registration, feature repositories, migration runners, and automatic shutdown cleanup.
 */
@Module({})
export class SqliteModule {
  static forRoot(options: SqliteModuleOptions = {}): DynamicModule {
    const connectionName = options.name ?? DEFAULT_SQLITE_CONNECTION;
    const optionsToken = getSqliteOptionsToken(connectionName);
    const connectionToken = getSqliteConnectionToken(connectionName);
    const migrationToken = getSqliteMigrationRunnerToken(connectionName);
    const txAspectToken = getSqliteTransactionalAspectToken(connectionName);
    const normalizedOptions: SqliteModuleOptions = {
      ...options,
      name: connectionName,
    };

    const providers: Provider[] = [
      {
        provide: optionsToken,
        useValue: normalizedOptions,
      },
      {
        provide: connectionToken,
        useFactory: (resolvedOptions: SqliteModuleOptions) =>
          new SqliteService(resolvedOptions),
        inject: [optionsToken],
      },
      {
        provide: migrationToken,
        useFactory: (
          sqlite: SqliteService,
          resolvedOptions: SqliteModuleOptions,
        ) =>
          new SqliteMigrationRunner(
            sqlite,
            resolvedOptions.migrations ?? [],
            resolvedOptions.migrationsTable,
          ),
        inject: [connectionToken, optionsToken],
      },
      {
        provide: txAspectToken,
        useFactory: (sqlite: SqliteService) =>
          new SqliteTransactionalAspect(sqlite),
        inject: [connectionToken],
      },
    ];

    const exportsList: ModuleExport[] = [
      connectionToken,
      migrationToken,
      txAspectToken,
    ];

    if (connectionName === DEFAULT_SQLITE_CONNECTION) {
      providers.push(
        {
          provide: SqliteService,
          useExisting: connectionToken,
        },
        {
          provide: SqliteMigrationRunner,
          useExisting: migrationToken,
        },
        {
          provide: SqliteTransactionalAspect,
          useExisting: txAspectToken,
        },
      );
      exportsList.push(
        SqliteService,
        SqliteMigrationRunner,
        SqliteTransactionalAspect,
      );
    }

    if (options.autoRegisterRepositories) {
      const autoRegs = collectAutoRegisteredSqliteRepositories(
        connectionName,
        connectionToken,
      );
      providers.push(...autoRegs.providers);
      exportsList.push(...autoRegs.exports);
    }

    return {
      module: SqliteModule,
      global: options.global ?? true,
      providers,
      exports: exportsList,
    };
  }

  /**
   * Registers multiple named SQLite connections in one module while rejecting
   * duplicate connection names with `DuplicateSqliteConnectionException`.
   */
  static forRootMultiple(
    connections: readonly SqliteModuleOptions[],
    options: { readonly global?: boolean } = {},
  ): DynamicModule {
    const seen = new Set<string>();
    const imports: DynamicModule[] = [];

    for (const cfg of connections) {
      const name = cfg.name ?? DEFAULT_SQLITE_CONNECTION;
      if (seen.has(name)) {
        throw new DuplicateSqliteConnectionException(name);
      }
      seen.add(name);
      imports.push(
        SqliteModule.forRoot({
          ...cfg,
          global: cfg.global ?? options.global ?? true,
        }),
      );
    }

    return {
      module: SqliteModule,
      global: options.global ?? true,
      imports,
      exports: imports,
    };
  }

  /**
   * Registers feature repositories (table names, `@SqliteEntity()` classes,
   * `BaseSqliteRepository` subclasses, `@SqliteRepository()` declarative abstract
   * classes, or `{ table, idColumn?, entity?, token? }` configs) bound to
   * `connectionName` (defaults to `"default"`), mirroring `TypeOrmModule.forFeature()`.
   */
  static forFeature(
    repositories: readonly SqliteRepositoryTarget[],
    connectionName?: string,
  ): DynamicModule {
    const defaultConn = connectionName ?? DEFAULT_SQLITE_CONNECTION;
    const defaultConnToken = getSqliteConnectionToken(defaultConn);
    const providers: Provider[] = [];
    const exportsList: ModuleExport[] = [];
    const seenTokens = new Set<InjectionToken>();
    const featureEntitiesByConn = new Map<
      string,
      Array<Type<unknown> | Abstract<unknown>>
    >();
    const trackFeatureEntity = (
      conn: string,
      entity: Type<unknown> | Abstract<unknown> | undefined,
    ) => {
      if (!entity || !hasEntitySchema(entity)) {
        return;
      }
      let list = featureEntitiesByConn.get(conn);
      if (!list) {
        list = [];
        featureEntitiesByConn.set(conn, list);
      }
      if (!list.includes(entity)) {
        list.push(entity);
      }
    };

    const registerToken = (
      token: InjectionToken,
      provider: Provider,
      connLabel: string = defaultConn,
    ) => {
      if (seenTokens.has(token)) {
        throw new Error(
          `Duplicate SQLite feature repository token "${String(token)}" on connection "${connLabel}".`,
        );
      }
      seenTokens.add(token);
      providers.push(provider);
      exportsList.push(token);
    };

    for (const entry of repositories) {
      if (typeof entry === "string") {
        const token = getSqliteRepositoryToken(entry, defaultConn);
        registerToken(token, {
          provide: token,
          useFactory: (sqlite: SqliteService) =>
            new BaseSqliteRepository(sqlite, entry),
          inject: [defaultConnToken],
        });
      } else if (isBaseRepositorySubclass(entry)) {
        const RepoClass = entry;
        const token = getSqliteRepositoryToken(RepoClass, defaultConn);
        registerToken(token, {
          provide: token,
          useFactory: (sqlite: SqliteService) => new RepoClass(sqlite),
          inject: [defaultConnToken],
        });
        if (!seenTokens.has(RepoClass)) {
          seenTokens.add(RepoClass);
          providers.push({
            provide: RepoClass,
            useExisting: token,
          });
          exportsList.push(RepoClass);
        }
      } else if (isDeclarativeSqliteRepository(entry)) {
        const RepoClass = entry as Abstract<any>;
        const compiled = compileSqliteRepository(RepoClass);
        const repoMeta = getSqliteRepositoryMetadata(RepoClass);
        const effectiveConn =
          connectionName ?? repoMeta?.connectionName ?? DEFAULT_SQLITE_CONNECTION;
        const effectiveConnToken = getSqliteConnectionToken(effectiveConn);
        const token = getSqliteRepositoryToken(RepoClass, effectiveConn);
        trackFeatureEntity(effectiveConn, repoMeta?.entity);
        registerToken(
          token,
          {
            provide: token,
            useFactory: (sqlite: SqliteService) =>
              compiled.createInstance(sqlite),
            inject: [effectiveConnToken],
          },
          effectiveConn,
        );
        if (!seenTokens.has(RepoClass)) {
          seenTokens.add(RepoClass);
          providers.push({
            provide: RepoClass,
            useExisting: token,
          });
          exportsList.push(RepoClass);
        }
      } else if (typeof entry === "function") {
        const entityClass = entry;
        const entitySchema = getEntitySchema(entityClass);
        const meta = MetadataRegistry.get<SqliteEntityMetadata>(
          SQLITE_ENTITY_METADATA,
          entityClass,
        );
        const tableName =
          entitySchema?.tableName ??
          meta?.tableName ??
          entityClass.name.toLowerCase();
        const idColumn =
          entitySchema?.primaryKey?.name ?? meta?.idColumn ?? "id";
        trackFeatureEntity(defaultConn, entityClass);
        const token = getSqliteRepositoryToken(entityClass, defaultConn);
        registerToken(token, {
          provide: token,
          useFactory: (sqlite: SqliteService) =>
            new BaseSqliteRepository(sqlite, tableName, idColumn),
          inject: [defaultConnToken],
        });
      } else {
        trackFeatureEntity(defaultConn, entry.entity);
        const token =
          entry.token ??
          getSqliteRepositoryToken(entry.entity ?? entry.table, defaultConn);
        registerToken(token, {
          provide: token,
          useFactory: (sqlite: SqliteService) =>
            new BaseSqliteRepository(sqlite, entry.table, entry.idColumn),
          inject: [defaultConnToken],
        });
      }
    }

    for (const [connName, entities] of featureEntitiesByConn.entries()) {
      providers.push({
        provide: Symbol(`bunest:sqlite:feature_sync:${connName}`),
        useFactory: (sqlite: SqliteService) => ({
          onModuleInit: () => {
            if (sqlite.isAutoSyncEnabled) {
              sqlite.syncEntities(entities);
            }
          },
        }),
        inject: [getSqliteConnectionToken(connName)],
      });
    }

    return {
      module: SqliteModule,
      providers,
      exports: exportsList,
    };
  }

  static forRootAsync(options: SqliteModuleAsyncOptions): DynamicModule {
    const connectionName = options.name ?? DEFAULT_SQLITE_CONNECTION;
    const optionsToken = getSqliteOptionsToken(connectionName);
    const connectionToken = getSqliteConnectionToken(connectionName);
    const migrationToken = getSqliteMigrationRunnerToken(connectionName);
    const txAspectToken = getSqliteTransactionalAspectToken(connectionName);

    const asyncOptionProviders = SqliteModule.createAsyncOptionsProviders(
      options,
      optionsToken,
      connectionName,
    );

    const providers: Provider[] = [
      ...asyncOptionProviders,
      ...(options.extraProviders ?? []),
      {
        provide: connectionToken,
        useFactory: (resolvedOptions: SqliteModuleOptions) =>
          new SqliteService(
            assertMatchingAsyncConnectionName(connectionName, resolvedOptions),
          ),
        inject: [optionsToken],
      },
      {
        provide: migrationToken,
        useFactory: (
          sqlite: SqliteService,
          resolvedOptions: SqliteModuleOptions,
        ) =>
          new SqliteMigrationRunner(
            sqlite,
            resolvedOptions.migrations ?? [],
            resolvedOptions.migrationsTable,
          ),
        inject: [connectionToken, optionsToken],
      },
      {
        provide: txAspectToken,
        useFactory: (sqlite: SqliteService) =>
          new SqliteTransactionalAspect(sqlite),
        inject: [connectionToken],
      },
    ];

    const exportsList: ModuleExport[] = [
      connectionToken,
      migrationToken,
      txAspectToken,
    ];

    if (connectionName === DEFAULT_SQLITE_CONNECTION) {
      providers.push(
        {
          provide: SqliteService,
          useExisting: connectionToken,
        },
        {
          provide: SqliteMigrationRunner,
          useExisting: migrationToken,
        },
        {
          provide: SqliteTransactionalAspect,
          useExisting: txAspectToken,
        },
      );
      exportsList.push(
        SqliteService,
        SqliteMigrationRunner,
        SqliteTransactionalAspect,
      );
    }

    if (options.autoRegisterRepositories) {
      const autoRegs = collectAutoRegisteredSqliteRepositories(
        connectionName,
        connectionToken,
      );
      providers.push(...autoRegs.providers);
      exportsList.push(...autoRegs.exports);
    }

    return {
      module: SqliteModule,
      global: options.global ?? true,
      imports: options.imports ?? [],
      providers,
      exports: exportsList,
    };
  }

  private static createAsyncOptionsProviders(
    options: SqliteModuleAsyncOptions,
    optionsToken: string,
    connectionName: string,
  ): Provider[] {
    if (options.useFactory) {
      return [
        {
          provide: optionsToken,
          useFactory: async (...args: unknown[]) => {
            const resolved = await options.useFactory!(...args);
            return assertMatchingAsyncConnectionName(
              connectionName,
              mergeAsyncSqliteOptions(options, resolved),
            );
          },
          inject: options.inject ?? [],
        },
      ];
    }

    if (options.useClass) {
      const factoryClass = options.useClass;
      return [
        {
          provide: factoryClass,
          useClass: factoryClass,
        },
        {
          provide: optionsToken,
          useFactory: async (factory: SqliteOptionsFactory) => {
            const resolved = await factory.createSqliteOptions();
            return assertMatchingAsyncConnectionName(
              connectionName,
              mergeAsyncSqliteOptions(options, resolved),
            );
          },
          inject: [factoryClass],
        },
      ];
    }

    if (options.useExisting) {
      return [
        {
          provide: optionsToken,
          useFactory: async (factory: SqliteOptionsFactory) => {
            const resolved = await factory.createSqliteOptions();
            return assertMatchingAsyncConnectionName(
              connectionName,
              mergeAsyncSqliteOptions(options, resolved),
            );
          },
          inject: [options.useExisting],
        },
      ];
    }

    throw new Error(
      `SqliteModule.forRootAsync("${connectionName}") requires one of "useFactory", "useClass", or "useExisting".`,
    );
  }
}
