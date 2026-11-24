import {
  Inject,
  Module,
  Optional,
  type DynamicModule,
  type InjectionToken,
  type OnApplicationShutdown,
  type OnModuleInit,
  type Provider,
  type Type,
} from "@bunest/core";
import { HttpAdapterHost, ModulesContainer } from "@bunest/core";
import { STORAGE_DISKS, STORAGE_MODULE_OPTIONS } from "./constants";
import { StorageDisk } from "./disks/storage.disk";
import { registerServer, unregisterServer } from "./http/app-registry.util";
import type {
  StorageModuleAsyncOptions,
  StorageModuleOptions,
  StorageModuleRootOptions,
} from "./interfaces/module-options.interface";
import {
  ConfigurableModuleClass,
  getDiskToken,
  getRequestedDiskNames,
  missingDiskError,
  type ResolvedDisks,
} from "./storage.module-definition";
import { Storage } from "./storage.service";

const TOP_LEVEL_DISK_PREFIX = "STORAGE_TOP_LEVEL_DISK:";

function isDiskClass(
  value: Type<StorageDisk> | StorageDisk,
): value is Type<StorageDisk> {
  return typeof value === "function";
}

function buildDiskProviders(
  topLevelDisks: Record<string, Type<StorageDisk> | StorageDisk> | undefined,
): {
  providers: Provider[];
  exports: Array<string | symbol | Function>;
} {
  const providers: Provider[] = [];
  const exportsList: Array<string | symbol | Function> = [Storage, StorageDisk];
  const topEntries = Object.entries(topLevelDisks ?? {});
  const topTokens: Array<{ name: string; token: string }> = [];

  for (const [name, diskOrClass] of topEntries) {
    const internalToken = `${TOP_LEVEL_DISK_PREFIX}${name}`;
    topTokens.push({ name, token: internalToken });
    if (isDiskClass(diskOrClass)) {
      providers.push({
        provide: internalToken,
        useClass: diskOrClass,
      });
    } else {
      providers.push({
        provide: internalToken,
        useValue: diskOrClass,
      });
    }
  }

  providers.push({
    provide: STORAGE_DISKS,
    useFactory: (
      moduleOptions: StorageModuleOptions,
      ...resolvedTopDisks: StorageDisk[]
    ): ResolvedDisks => {
      const disks = new Map<string, StorageDisk>();
      topTokens.forEach((entry, idx) => {
        const inst = resolvedTopDisks[idx];
        if (inst) {
          disks.set(entry.name, inst);
        }
      });
      if (moduleOptions?.disks) {
        for (const [name, disk] of Object.entries(moduleOptions.disks)) {
          disks.set(name, disk);
        }
      }
      if (disks.size === 0) {
        throw new Error(
          "StorageModule requires at least one disk configured in `disks`",
        );
      }
      let defaultName = moduleOptions?.default;
      if (!defaultName) {
        if (disks.size === 1) {
          defaultName = [...disks.keys()][0]!;
        } else {
          throw new Error(
            `StorageModule requires \`default\` when more than one disk is configured (${[...disks.keys()].join(", ")})`,
          );
        }
      }
      if (!disks.has(defaultName)) {
        throw missingDiskError(
          defaultName,
          [...disks.keys()],
          "StorageModule.default",
        );
      }
      return { disks, defaultName };
    },
    inject: [STORAGE_MODULE_OPTIONS, ...topTokens.map((t) => t.token)],
  });

  providers.push({
    provide: Storage,
    useFactory: (resolved: ResolvedDisks) =>
      new Storage(resolved.disks, resolved.defaultName),
    inject: [STORAGE_DISKS],
  });

  providers.push({
    provide: StorageDisk as unknown as InjectionToken<StorageDisk>,
    useFactory: (storage: Storage) => storage.disk(),
    inject: [Storage],
  });

  const explicitNames = new Set<string>(topTokens.map((t) => t.name));
  const exposedNames = new Set<string>([
    ...explicitNames,
    ...getRequestedDiskNames(),
  ]);

  for (const name of exposedNames) {
    const token = getDiskToken(name);
    const isExplicit = explicitNames.has(name);
    providers.push({
      provide: token,
      useFactory: (resolved: ResolvedDisks) => {
        const disk = resolved.disks.get(name);
        if (!disk) {
          if (isExplicit) {
            throw missingDiskError(name, [...resolved.disks.keys()]);
          }
          return undefined;
        }
        return disk;
      },
      inject: [STORAGE_DISKS],
    });
    exportsList.push(token);
  }

  return { providers, exports: exportsList };
}

/**
 * `StorageModule.forRoot({ default, disks })`, or `forRootAsync({ disks, imports, inject,
 * useFactory })`. Global by default. Closes the disks on application shutdown.
 */
@Module({})
export class StorageModule
  extends ConfigurableModuleClass
  implements OnModuleInit, OnApplicationShutdown
{
  private readonly resolved: ResolvedDisks;
  private readonly storage: Storage;
  private readonly modules: ModulesContainer;
  private readonly adapterHost?: HttpAdapterHost | undefined;
  private readonly servers: object[] = [];

  constructor(
    @Inject(STORAGE_DISKS) resolved: ResolvedDisks,
    storage: Storage,
    @Optional() modules?: ModulesContainer,
    @Optional() adapterHost?: HttpAdapterHost,
  ) {
    super();
    this.resolved = resolved;
    this.storage = storage;
    this.modules = modules ?? new ModulesContainer();
    this.adapterHost = adapterHost;
  }

  static override forRoot(options: StorageModuleRootOptions): DynamicModule {
    const { disks: topDisks, imports, isGlobal, ...rest } = options;
    const base = super.forRoot({
      ...rest,
      isGlobal: isGlobal ?? true,
    });
    const built = buildDiskProviders(topDisks);
    return {
      ...base,
      module: StorageModule,
      global: isGlobal ?? true,
      imports: [...(base.imports ?? []), ...(imports ?? [])],
      providers: [...(base.providers ?? []), ...built.providers],
      exports: [...(base.exports ?? []), ...built.exports],
    };
  }

  static override forRootAsync(
    options: StorageModuleAsyncOptions,
  ): DynamicModule {
    const { disks: topDisks, isGlobal, ...rest } = options;
    const base = super.forRootAsync({
      ...rest,
      isGlobal: isGlobal ?? true,
    });
    const built = buildDiskProviders(topDisks);
    return {
      ...base,
      module: StorageModule,
      global: isGlobal ?? true,
      providers: [...(base.providers ?? []), ...built.providers],
      exports: [...(base.exports ?? []), ...built.exports],
    };
  }

  onModuleInit(): void {
    const adapter = this.adapterHost?.httpAdapter;
    if (adapter) {
      const inst = adapter.getInstance?.();
      if (inst && typeof inst === "object") {
        registerServer(inst, this.storage);
        this.servers.push(inst);
      }
      const httpServer = adapter.getHttpServer?.();
      if (httpServer && typeof httpServer === "object") {
        registerServer(httpServer, this.storage);
        this.servers.push(httpServer);
      }
    }
    this.checkInjectedDisks();
  }

  async onApplicationShutdown(): Promise<void> {
    for (const server of this.servers) {
      unregisterServer(server, this.storage);
    }
    this.servers.length = 0;

    const seen = new Set<StorageDisk>();
    for (const disk of this.resolved.disks.values()) {
      if (seen.has(disk)) continue;
      seen.add(disk);
      if (typeof disk.close === "function") {
        await disk.close();
      }
    }
  }

  private checkInjectedDisks(): void {
    // Validate modules container presence if needed
    void this.modules;
  }
}
