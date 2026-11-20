import {
  Module,
  type DynamicModule,
  type FactoryDependency,
  type ModuleMetadata,
} from "@bunest/common";
import { LocalStorageAdapter } from "./local-storage.adapter";
import { MemoryStorageAdapter } from "./memory-storage.adapter";
import {
  S3StorageAdapter,
  type S3ClientLike,
} from "./s3-storage.adapter";
import {
  STORAGE_ADAPTER,
  STORAGE_OPTIONS,
  type StorageAdapter,
} from "./storage.interface";

export type StorageModuleOptions =
  | { driver: "local"; rootDir: string; global?: boolean }
  | { driver: "memory"; global?: boolean }
  | {
      driver: "s3";
      client: S3ClientLike;
      prefix?: string;
      global?: boolean;
    }
  | { adapter: StorageAdapter; global?: boolean };

export interface StorageModuleAsyncOptions {
  imports?: ModuleMetadata["imports"];
  inject?: FactoryDependency[];
  useFactory: (
    ...args: any[]
  ) => StorageModuleOptions | Promise<StorageModuleOptions>;
  global?: boolean;
}

export function createStorageAdapter(
  options: StorageModuleOptions,
): StorageAdapter {
  if ("adapter" in options) {
    return options.adapter;
  }
  switch (options.driver) {
    case "local":
      return new LocalStorageAdapter({ rootDir: options.rootDir });
    case "memory":
      return new MemoryStorageAdapter();
    case "s3":
      return new S3StorageAdapter({
        client: options.client,
        prefix: options.prefix,
      });
  }
}

@Module({})
export class StorageModule {
  static forRoot(options: StorageModuleOptions): DynamicModule {
    const adapter = createStorageAdapter(options);
    return {
      module: StorageModule,
      global: options.global,
      providers: [
        { provide: STORAGE_OPTIONS, useValue: options },
        { provide: STORAGE_ADAPTER, useValue: adapter },
      ],
      exports: [STORAGE_ADAPTER, STORAGE_OPTIONS],
    };
  }

  static forRootAsync(options: StorageModuleAsyncOptions): DynamicModule {
    return {
      module: StorageModule,
      global: options.global,
      imports: options.imports,
      providers: [
        {
          provide: STORAGE_OPTIONS,
          useFactory: options.useFactory,
          inject: options.inject,
        },
        {
          provide: STORAGE_ADAPTER,
          inject: [STORAGE_OPTIONS],
          useFactory: (opts: StorageModuleOptions) =>
            createStorageAdapter(opts),
        },
      ],
      exports: [STORAGE_ADAPTER, STORAGE_OPTIONS],
    };
  }
}
