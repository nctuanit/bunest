import {
  DecoratorRegistry,
  Module,
  hasEntitySchema,
  type Abstract,
  type DynamicModule,
  type InjectionToken,
  type ModuleExport,
  type Provider,
  type Type,
} from "@bunest/common";
import {
  compileSqlRepository,
  getSqlRepositoryMetadata,
} from "./declarative-repository";
import type {
  SqlModuleAsyncOptions,
  SqlModuleForRootInput,
  SqlModuleOptions,
  SqlOptionsFactory,
  SqlRepositoryMetadata,
  SqlRepositoryTarget,
} from "./interfaces";
import { SqlMigrationRunner } from "./sql-migration-runner";
import { SqlService } from "./sql.service";
import {
  DEFAULT_SQL_CONNECTION,
  getSqlConnectionToken,
  getSqlMigrationRunnerToken,
  getSqlOptionsToken,
  getSqlRepositoryToken,
  getSqlTransactionalAspectToken,
} from "./tokens";
import { SqlTransactionalAspect } from "./transactional";

function normalizeInput(input?: SqlModuleForRootInput): SqlModuleOptions {
  if (input === undefined) {
    return {};
  }
  if (typeof input === "string" || input instanceof URL) {
    return { url: input };
  }
  return input;
}

function mergeAsyncSqlOptions(
  asyncOptions: SqlModuleAsyncOptions,
  resolved: SqlModuleOptions,
): SqlModuleOptions {
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

function collectAutoRegisteredSqlRepositories(
  connectionName: string,
  connectionToken: string,
): { providers: Provider[]; exports: ModuleExport[] } {
  const entries =
    DecoratorRegistry.getByKind<SqlRepositoryMetadata>("sql-repository");
  const providers: Provider[] = [];
  const exportsList: ModuleExport[] = [];
  const tokenProviderIndex = new Map<string, number>();

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const repoConn = entry.meta?.connectionName ?? DEFAULT_SQL_CONNECTION;
    if (repoConn !== connectionName) {
      continue;
    }

    const RepoClass = entry.target as Abstract<any>;
    const compiled = compileSqlRepository(RepoClass);
    const repoToken = getSqlRepositoryToken(RepoClass, connectionName);

    providers.push({
      provide: RepoClass,
      useFactory: (sql: SqlService) => compiled.createInstance(sql),
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

/**
 * Bunest dynamic module registering one or more `SqlService` connections and
 * `SqlMigrationRunner` instances backed by Bun's native `Bun.SQL` driver
 * (PostgreSQL, MySQL/MariaDB, and SQLite).
 */
@Module({})
export class SqlModule {
  static forRoot(input: SqlModuleForRootInput = {}): DynamicModule {
    const normalized = normalizeInput(input);
    const connectionName = normalized.name ?? DEFAULT_SQL_CONNECTION;
    const optionsToken = getSqlOptionsToken(connectionName);
    const connectionToken = getSqlConnectionToken(connectionName);
    const migrationToken = getSqlMigrationRunnerToken(connectionName);
    const txAspectToken = getSqlTransactionalAspectToken(connectionName);

    const providers: Provider[] = [
      {
        provide: optionsToken,
        useValue: { ...normalized, name: connectionName },
      },
      {
        provide: connectionToken,
        useFactory: (resolvedOptions: SqlModuleOptions) =>
          new SqlService(resolvedOptions),
        inject: [optionsToken],
      },
      {
        provide: migrationToken,
        useFactory: (sql: SqlService, resolvedOptions: SqlModuleOptions) =>
          new SqlMigrationRunner(
            sql,
            resolvedOptions.migrations ?? [],
            resolvedOptions.migrationsTable,
            {
              advisoryLock: resolvedOptions.advisoryLock,
              advisoryLockId: resolvedOptions.advisoryLockId,
            },
          ),
        inject: [connectionToken, optionsToken],
      },
      {
        provide: txAspectToken,
        useFactory: (sql: SqlService) => new SqlTransactionalAspect(sql),
        inject: [connectionToken],
      },
    ];

    const exportsList: ModuleExport[] = [
      connectionToken,
      migrationToken,
      txAspectToken,
    ];

    if (connectionName === DEFAULT_SQL_CONNECTION) {
      providers.push(
        {
          provide: SqlService,
          useExisting: connectionToken,
        },
        {
          provide: SqlMigrationRunner,
          useExisting: migrationToken,
        },
        {
          provide: SqlTransactionalAspect,
          useExisting: txAspectToken,
        },
      );
      exportsList.push(
        SqlService,
        SqlMigrationRunner,
        SqlTransactionalAspect,
      );
    }

    if (normalized.autoRegisterRepositories) {
      const autoRegs = collectAutoRegisteredSqlRepositories(
        connectionName,
        connectionToken,
      );
      providers.push(...autoRegs.providers);
      exportsList.push(...autoRegs.exports);
    }

    return {
      module: SqlModule,
      global: normalized.global ?? true,
      providers,
      exports: exportsList,
    };
  }

  /**
   * Registers declarative `@SqlRepository(...)` abstract classes compiled once
   * into DI-injectable providers bound to `connectionName` (defaults to `"default"`).
   */
  static forFeature(
    repositories: readonly SqlRepositoryTarget[],
    connectionName?: string,
  ): DynamicModule {
    const providers: Provider[] = [];
    const exportsList: ModuleExport[] = [];
    const seenTokens = new Set<InjectionToken>();
    const featureEntitiesByConn = new Map<
      string,
      Array<Type<unknown> | Abstract<unknown>>
    >();

    for (const RepoClass of repositories) {
      const compiled = compileSqlRepository(RepoClass);
      const repoMeta = getSqlRepositoryMetadata(RepoClass);
      const effectiveConn =
        connectionName ?? repoMeta?.connectionName ?? DEFAULT_SQL_CONNECTION;
      const connToken = getSqlConnectionToken(effectiveConn);
      const repoToken = getSqlRepositoryToken(RepoClass, effectiveConn);

      if (repoMeta?.entity && hasEntitySchema(repoMeta.entity)) {
        let list = featureEntitiesByConn.get(effectiveConn);
        if (!list) {
          list = [];
          featureEntitiesByConn.set(effectiveConn, list);
        }
        if (!list.includes(repoMeta.entity)) {
          list.push(repoMeta.entity);
        }
      }

      if (seenTokens.has(repoToken)) {
        throw new Error(
          `Duplicate SQL feature repository token "${repoToken}" on connection "${effectiveConn}".`,
        );
      }
      seenTokens.add(repoToken);
      providers.push({
        provide: repoToken,
        useFactory: (sql: SqlService) => compiled.createInstance(sql),
        inject: [connToken],
      });
      exportsList.push(repoToken);

      if (!seenTokens.has(RepoClass)) {
        seenTokens.add(RepoClass);
        providers.push({
          provide: RepoClass,
          useExisting: repoToken,
        });
        exportsList.push(RepoClass);
      }
    }

    for (const [connName, entities] of featureEntitiesByConn.entries()) {
      providers.push({
        provide: Symbol(`bunest:sql:feature_sync:${connName}`),
        useFactory: (sql: SqlService) => ({
          onModuleInit: async () => {
            if (sql.isAutoSyncEnabled) {
              await sql.syncEntities(entities);
            }
          },
        }),
        inject: [getSqlConnectionToken(connName)],
      });
    }

    return {
      module: SqlModule,
      providers,
      exports: exportsList,
    };
  }

  static forRootAsync(options: SqlModuleAsyncOptions): DynamicModule {
    const connectionName = options.name ?? DEFAULT_SQL_CONNECTION;
    const optionsToken = getSqlOptionsToken(connectionName);
    const connectionToken = getSqlConnectionToken(connectionName);
    const migrationToken = getSqlMigrationRunnerToken(connectionName);
    const txAspectToken = getSqlTransactionalAspectToken(connectionName);

    const asyncOptionProviders = SqlModule.createAsyncOptionsProviders(
      options,
      optionsToken,
      connectionName,
    );

    const providers: Provider[] = [
      ...asyncOptionProviders,
      ...(options.extraProviders ?? []),
      {
        provide: connectionToken,
        useFactory: (resolvedOptions: SqlModuleOptions) =>
          new SqlService({ ...resolvedOptions, name: connectionName }),
        inject: [optionsToken],
      },
      {
        provide: migrationToken,
        useFactory: (sql: SqlService, resolvedOptions: SqlModuleOptions) =>
          new SqlMigrationRunner(
            sql,
            resolvedOptions.migrations ?? [],
            resolvedOptions.migrationsTable,
            {
              advisoryLock: resolvedOptions.advisoryLock,
              advisoryLockId: resolvedOptions.advisoryLockId,
            },
          ),
        inject: [connectionToken, optionsToken],
      },
      {
        provide: txAspectToken,
        useFactory: (sql: SqlService) => new SqlTransactionalAspect(sql),
        inject: [connectionToken],
      },
    ];

    const exportsList: ModuleExport[] = [
      connectionToken,
      migrationToken,
      txAspectToken,
    ];

    if (connectionName === DEFAULT_SQL_CONNECTION) {
      providers.push(
        {
          provide: SqlService,
          useExisting: connectionToken,
        },
        {
          provide: SqlMigrationRunner,
          useExisting: migrationToken,
        },
        {
          provide: SqlTransactionalAspect,
          useExisting: txAspectToken,
        },
      );
      exportsList.push(
        SqlService,
        SqlMigrationRunner,
        SqlTransactionalAspect,
      );
    }

    if (options.autoRegisterRepositories) {
      const autoRegs = collectAutoRegisteredSqlRepositories(
        connectionName,
        connectionToken,
      );
      providers.push(...autoRegs.providers);
      exportsList.push(...autoRegs.exports);
    }

    return {
      module: SqlModule,
      global: options.global ?? true,
      imports: options.imports ?? [],
      providers,
      exports: exportsList,
    };
  }

  private static createAsyncOptionsProviders(
    options: SqlModuleAsyncOptions,
    optionsToken: string,
    connectionName: string,
  ): Provider[] {
    if (options.useFactory) {
      return [
        {
          provide: optionsToken,
          useFactory: async (...args: unknown[]) => {
            const resolved = normalizeInput(await options.useFactory!(...args));
            return {
              ...mergeAsyncSqlOptions(options, resolved),
              name: connectionName,
            };
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
          useFactory: async (factory: SqlOptionsFactory) => {
            const resolved = normalizeInput(await factory.createSqlOptions());
            return {
              ...mergeAsyncSqlOptions(options, resolved),
              name: connectionName,
            };
          },
          inject: [factoryClass],
        },
      ];
    }

    if (options.useExisting) {
      return [
        {
          provide: optionsToken,
          useFactory: async (factory: SqlOptionsFactory) => {
            const resolved = normalizeInput(await factory.createSqlOptions());
            return {
              ...mergeAsyncSqlOptions(options, resolved),
              name: connectionName,
            };
          },
          inject: [options.useExisting],
        },
      ];
    }

    throw new Error(
      `SqlModule.forRootAsync("${connectionName}") requires one of "useFactory", "useClass", or "useExisting".`,
    );
  }
}
