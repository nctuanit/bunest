import {
  DecoratorRegistry,
  Global,
  Inject,
  Module,
  type Abstract,
  type DynamicModule,
  type InjectionToken,
  type ModuleExport,
  type ModuleMetadata,
  type OnApplicationShutdown,
  type Provider,
  type Type,
} from "@bunest/core";
import { ModuleRef } from "@bunest/core";
import { DataSource } from "../data-source";
import {
  compileOrmRepository,
  getOrmRepositoryMetadata,
  isDeclarativeOrmRepository,
  type OrmRepositoryMetadata,
} from "../declarative-repository";
import type { EntityTarget, OrmDataSourceOptions } from "../types";
import { OrmTransactionalAspect } from "./decorators";
import {
  DEFAULT_ORM_DATA_SOURCE,
  ORM_DATA_SOURCE_NAME,
  ORM_MODULE_OPTIONS,
  getOrmDataSourceToken,
  getOrmEntityManagerToken,
  getOrmMigrationRunnerToken,
  getOrmRepositoryToken,
  getOrmTransactionalAspectToken,
} from "./tokens";

export interface OrmOptionsFactory {
  createOrmOptions(
    dataSourceName?: string,
  ): Promise<OrmDataSourceOptions> | OrmDataSourceOptions;
}

export interface OrmModuleAsyncOptions extends Pick<ModuleMetadata, "imports"> {
  readonly name?: string;
  readonly global?: boolean;
  readonly entities?: readonly EntityTarget[];
  readonly synchronize?: boolean;
  readonly autoSync?: boolean;
  readonly migrationsRun?: boolean;
  readonly autoMigrate?: boolean;
  readonly autoRegisterRepositories?: boolean;
  readonly useFactory?: (
    ...args: never[]
  ) => Promise<OrmDataSourceOptions> | OrmDataSourceOptions;
  readonly inject?: InjectionToken[];
  readonly useClass?: Type<OrmOptionsFactory>;
  readonly useExisting?: Type<OrmOptionsFactory>;
}

const FEATURE_ENTITIES_BY_DS = new Map<string, Set<EntityTarget>>();

function registerFeatureEntities(
  dataSourceName: string,
  entities: readonly EntityTarget[],
): void {
  let set = FEATURE_ENTITIES_BY_DS.get(dataSourceName);
  if (!set) {
    set = new Set();
    FEATURE_ENTITIES_BY_DS.set(dataSourceName, set);
  }
  for (const e of entities) {
    set.add(e);
  }
}

function getRegisteredFeatureEntities(dataSourceName: string): EntityTarget[] {
  return [...(FEATURE_ENTITIES_BY_DS.get(dataSourceName) ?? [])];
}

export function clearOrmFeatureRegistry(dataSourceName?: string): void {
  if (dataSourceName !== undefined) {
    FEATURE_ENTITIES_BY_DS.delete(dataSourceName);
    return;
  }
  FEATURE_ENTITIES_BY_DS.clear();
}

function collectAutoRegisteredOrmRepositories(
  dataSourceName: string,
  dsToken: InjectionToken,
): {
  providers: Provider[];
  exports: ModuleExport[];
  entities: EntityTarget[];
} {
  const entries =
    DecoratorRegistry.getByKind<OrmRepositoryMetadata>("orm-repository");
  const providers: Provider[] = [];
  const exportsList: ModuleExport[] = [];
  const entities: EntityTarget[] = [];
  const seenRepos = new Set<Function>();
  const tokenProviderIndex = new Map<string, number>();

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const repoDs = entry.meta?.dataSource ?? DEFAULT_ORM_DATA_SOURCE;
    if (repoDs !== dataSourceName) {
      continue;
    }

    const RepoClass = entry.target as Abstract<object>;
    if (seenRepos.has(RepoClass)) {
      continue;
    }
    seenRepos.add(RepoClass);

    const compiled = compileOrmRepository(RepoClass);
    const repoToken = getOrmRepositoryToken(
      RepoClass as unknown as EntityTarget,
      dataSourceName,
    );

    if (compiled.metadata.entity && !entities.includes(compiled.metadata.entity)) {
      entities.push(compiled.metadata.entity);
    }

    providers.push({
      provide: RepoClass,
      useFactory: (ds: DataSource) => compiled.createInstance(ds),
      inject: [dsToken],
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

  return { providers, exports: exportsList, entities };
}

function mergeAsyncOrmOptions(
  asyncOptions: OrmModuleAsyncOptions,
  resolved: OrmDataSourceOptions,
): OrmDataSourceOptions {
  const mergedEntities =
    asyncOptions.entities || resolved.entities
      ? [...(asyncOptions.entities ?? []), ...(resolved.entities ?? [])]
      : undefined;
  return {
    ...resolved,
    ...(mergedEntities !== undefined ? { entities: mergedEntities } : {}),
    ...(resolved.synchronize !== undefined
      ? { synchronize: resolved.synchronize }
      : asyncOptions.synchronize !== undefined
        ? { synchronize: asyncOptions.synchronize }
        : {}),
    ...(resolved.autoSync !== undefined
      ? { autoSync: resolved.autoSync }
      : asyncOptions.autoSync !== undefined
        ? { autoSync: asyncOptions.autoSync }
        : {}),
    ...(resolved.migrationsRun !== undefined
      ? { migrationsRun: resolved.migrationsRun }
      : asyncOptions.migrationsRun !== undefined
        ? { migrationsRun: asyncOptions.migrationsRun }
        : {}),
    ...(resolved.autoMigrate !== undefined
      ? { autoMigrate: resolved.autoMigrate }
      : asyncOptions.autoMigrate !== undefined
        ? { autoMigrate: asyncOptions.autoMigrate }
        : {}),
    ...(resolved.autoRegisterRepositories !== undefined
      ? { autoRegisterRepositories: resolved.autoRegisterRepositories }
      : asyncOptions.autoRegisterRepositories !== undefined
        ? { autoRegisterRepositories: asyncOptions.autoRegisterRepositories }
        : {}),
  };
}

@Global()
@Module({})
export class OrmCoreModule implements OnApplicationShutdown {
  constructor(
    @Inject(ORM_DATA_SOURCE_NAME)
    private readonly dataSourceName: string,
    private readonly moduleRef: ModuleRef,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    try {
      const ds = this.moduleRef.get<DataSource>(
        getOrmDataSourceToken(this.dataSourceName) as InjectionToken,
      );
      if (ds && ds.isInitialized) {
        await ds.destroy();
      }
    } finally {
      clearOrmFeatureRegistry(this.dataSourceName);
    }
  }

  static forRoot(options: OrmDataSourceOptions = {}): DynamicModule {
    const dsName = options.name ?? DEFAULT_ORM_DATA_SOURCE;
    const dsToken = getOrmDataSourceToken(dsName) as InjectionToken;
    const emToken = getOrmEntityManagerToken(dsName) as InjectionToken;
    const migToken = getOrmMigrationRunnerToken(dsName) as InjectionToken;
    const txAspectToken = getOrmTransactionalAspectToken(
      dsName,
    ) as InjectionToken;

    const autoRegs = options.autoRegisterRepositories
      ? collectAutoRegisteredOrmRepositories(dsName, dsToken)
      : { providers: [] as Provider[], exports: [] as ModuleExport[], entities: [] as EntityTarget[] };

    const dataSourceProvider: Provider = {
      provide: dsToken,
      useFactory: async () => {
        const featureEntities = getRegisteredFeatureEntities(dsName);
        const mergedEntities: EntityTarget[] = [
          ...(options.entities ?? []),
          ...autoRegs.entities,
          ...featureEntities,
        ];
        const ds = new DataSource({
          ...options,
          name: dsName,
          entities: mergedEntities,
        });
        await ds.initialize();
        return ds;
      },
    };

    const entityManagerProvider: Provider = {
      provide: emToken,
      useFactory: (ds: DataSource) => ds.manager,
      inject: [dsToken],
    };

    const migrationRunnerProvider: Provider = {
      provide: migToken,
      useFactory: (ds: DataSource) => ds.migrationRunner,
      inject: [dsToken],
    };

    const txAspectProvider: Provider = {
      provide: txAspectToken,
      useFactory: (ds: DataSource) => new OrmTransactionalAspect(ds),
      inject: [dsToken],
    };

    return {
      module: OrmCoreModule,
      global: options.global ?? true,
      providers: [
        { provide: ORM_DATA_SOURCE_NAME, useValue: dsName },
        { provide: ORM_MODULE_OPTIONS, useValue: options },
        dataSourceProvider,
        entityManagerProvider,
        migrationRunnerProvider,
        txAspectProvider,
        ...autoRegs.providers,
      ],
      exports: [
        dataSourceProvider,
        entityManagerProvider,
        migrationRunnerProvider,
        txAspectProvider,
        ...autoRegs.exports,
      ],
    };
  }

  static forRootAsync(options: OrmModuleAsyncOptions): DynamicModule {
    const dsName = options.name ?? DEFAULT_ORM_DATA_SOURCE;
    const dsToken = getOrmDataSourceToken(dsName) as InjectionToken;
    const emToken = getOrmEntityManagerToken(dsName) as InjectionToken;
    const migToken = getOrmMigrationRunnerToken(dsName) as InjectionToken;
    const txAspectToken = getOrmTransactionalAspectToken(
      dsName,
    ) as InjectionToken;

    const autoRegs = options.autoRegisterRepositories
      ? collectAutoRegisteredOrmRepositories(dsName, dsToken)
      : { providers: [] as Provider[], exports: [] as ModuleExport[], entities: [] as EntityTarget[] };

    const asyncProviders: Provider[] = [];
    if (options.useFactory) {
      asyncProviders.push({
        provide: ORM_MODULE_OPTIONS,
        useFactory: async (...args: unknown[]) => {
          const resolved = await (
            options.useFactory as (
              ...a: unknown[]
            ) => Promise<OrmDataSourceOptions> | OrmDataSourceOptions
          )(...args);
          return mergeAsyncOrmOptions(options, resolved);
        },
        inject: options.inject ?? [],
      });
    } else if (options.useClass) {
      asyncProviders.push(
        { provide: options.useClass, useClass: options.useClass },
        {
          provide: ORM_MODULE_OPTIONS,
          useFactory: async (factory: OrmOptionsFactory) =>
            mergeAsyncOrmOptions(
              options,
              await factory.createOrmOptions(dsName),
            ),
          inject: [options.useClass],
        },
      );
    } else if (options.useExisting) {
      asyncProviders.push({
        provide: ORM_MODULE_OPTIONS,
        useFactory: async (factory: OrmOptionsFactory) =>
          mergeAsyncOrmOptions(options, await factory.createOrmOptions(dsName)),
        inject: [options.useExisting],
      });
    } else {
      throw new Error(
        'OrmModule.forRootAsync() requires one of "useFactory", "useClass", or "useExisting".',
      );
    }

    const dataSourceProvider: Provider = {
      provide: dsToken,
      useFactory: async (resolvedOpts: OrmDataSourceOptions) => {
        const featureEntities = getRegisteredFeatureEntities(dsName);
        const mergedEntities: EntityTarget[] = [
          ...(resolvedOpts.entities ?? []),
          ...autoRegs.entities,
          ...featureEntities,
        ];
        const ds = new DataSource({
          ...resolvedOpts,
          name: dsName,
          entities: mergedEntities,
        });
        await ds.initialize();
        return ds;
      },
      inject: [ORM_MODULE_OPTIONS],
    };

    const entityManagerProvider: Provider = {
      provide: emToken,
      useFactory: (ds: DataSource) => ds.manager,
      inject: [dsToken],
    };

    const migrationRunnerProvider: Provider = {
      provide: migToken,
      useFactory: (ds: DataSource) => ds.migrationRunner,
      inject: [dsToken],
    };

    const txAspectProvider: Provider = {
      provide: txAspectToken,
      useFactory: (ds: DataSource) => new OrmTransactionalAspect(ds),
      inject: [dsToken],
    };

    return {
      module: OrmCoreModule,
      global: options.global ?? true,
      imports: options.imports ?? [],
      providers: [
        { provide: ORM_DATA_SOURCE_NAME, useValue: dsName },
        ...asyncProviders,
        dataSourceProvider,
        entityManagerProvider,
        migrationRunnerProvider,
        txAspectProvider,
        ...autoRegs.providers,
      ],
      exports: [
        dataSourceProvider,
        entityManagerProvider,
        migrationRunnerProvider,
        txAspectProvider,
        ...autoRegs.exports,
      ],
    };
  }
}

/**
 * First-class Bunest DI module for `@bunest/orm`.
 *
 * ```ts
 * @Module({
 *   imports: [
 *     OrmModule.forRoot({ type: "sqlite", database: ":memory:", synchronize: true }),
 *     OrmModule.forFeature([User, UserRepository]),
 *   ],
 *   providers: [UsersService],
 * })
 * export class AppModule {}
 * ```
 */
@Module({})
export class OrmModule {
  static forRoot(options: OrmDataSourceOptions = {}): DynamicModule {
    return {
      module: OrmModule,
      imports: [OrmCoreModule.forRoot(options)],
    };
  }

  static forRootAsync(options: OrmModuleAsyncOptions): DynamicModule {
    return {
      module: OrmModule,
      imports: [OrmCoreModule.forRootAsync(options)],
    };
  }

  /**
   * Registers BOTH standard entity classes/targets (`User`, `"User"`, `entityRef(...)`, `() => User`)
   * AND compiled `@OrmRepository(...)` declarative abstract classes (`UserRepository`),
   * automatically syncing any associated entity schema on the DataSource and exposing
   * declarative repositories directly by class token in DI!
   */
  static forFeature(
    targets: readonly EntityTarget[] = [],
    dataSourceName?: string,
  ): DynamicModule {
    const defaultDs = dataSourceName ?? DEFAULT_ORM_DATA_SOURCE;
    const providers: Provider[] = [];
    const exportsList: ModuleExport[] = [];
    const seenTokens = new Set<InjectionToken>();

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i]!;

      if (isDeclarativeOrmRepository(target)) {
        const RepoClass = target as Abstract<object>;
        const compiled = compileOrmRepository(RepoClass);
        const repoMeta = getOrmRepositoryMetadata(RepoClass);
        const effectiveDs =
          dataSourceName ?? repoMeta?.dataSource ?? DEFAULT_ORM_DATA_SOURCE;
        const effectiveDsToken = getOrmDataSourceToken(
          effectiveDs,
        ) as InjectionToken;
        const repoToken = getOrmRepositoryToken(
          RepoClass as unknown as EntityTarget,
          effectiveDs,
        ) as InjectionToken;

        const linkedEntity = repoMeta?.entity;
        if (linkedEntity) {
          registerFeatureEntities(effectiveDs, [linkedEntity]);
        }

        if (!seenTokens.has(repoToken)) {
          seenTokens.add(repoToken);
          providers.push({
            provide: repoToken,
            useFactory: async (ds: DataSource) => {
              if (linkedEntity) {
                await ds.ensureEntities([linkedEntity]);
              }
              return compiled.createInstance(ds);
            },
            inject: [effectiveDsToken],
          });
          exportsList.push(repoToken);
        }

        if (!seenTokens.has(RepoClass)) {
          seenTokens.add(RepoClass);
          providers.push({
            provide: RepoClass,
            useExisting: repoToken,
          });
          exportsList.push(RepoClass);
        }
        continue;
      }

      const effectiveDsToken = getOrmDataSourceToken(
        defaultDs,
      ) as InjectionToken;
      registerFeatureEntities(defaultDs, [target]);
      const repoToken = getOrmRepositoryToken(
        target,
        defaultDs,
      ) as InjectionToken;

      if (!seenTokens.has(repoToken)) {
        seenTokens.add(repoToken);
        providers.push({
          provide: repoToken,
          useFactory: async (ds: DataSource) => {
            await ds.ensureEntities([target]);
            return ds.dialect === "mongodb"
              ? ds.getMongoRepository(target as EntityTarget<object>)
              : ds.getRepository(target as EntityTarget<object>);
          },
          inject: [effectiveDsToken],
        });
        exportsList.push(repoToken);
      }
    }

    return {
      module: OrmModule,
      providers,
      exports: exportsList,
    };
  }
}
