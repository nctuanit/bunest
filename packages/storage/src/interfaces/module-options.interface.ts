import type {
  ConfigurableModuleAsyncOptions,
  ModuleMetadata,
  Type,
} from "@bunest/common";
import type { StorageDisk } from "../disks/storage.disk";
import type { UploadFileInfo } from "./storage-types";

/** What `forRoot()` sets besides the disks, and what a `forRootAsync()` factory returns. */
export interface StorageModuleOptions {
  /** The disk `StorageDisk` and `storage.disk()` resolve to. Optional when there is only one. */
  default?: string;
  /** Disk instances by name. From an async factory: instances only (classes go at the top level). */
  disks?: Record<string, StorageDisk>;
}

/**
 * The top level of both `forRoot()` and `forRootAsync()`.
 */
export interface StorageModuleStructure {
  /** Disks by name: `StorageDisk` classes (DI instantiates them) or instances. */
  disks?: Record<string, Type<StorageDisk> | StorageDisk>;
  /** Modules whose exports the disk classes inject. */
  imports?: ModuleMetadata["imports"];
  /** Default `true`. */
  isGlobal?: boolean;
}

/** What `forRoot()` takes. */
export type StorageModuleRootOptions = Omit<StorageModuleOptions, "disks"> &
  StorageModuleStructure;

/** What a class passed to `forRootAsync({ useClass })` implements. */
export interface StorageOptionsFactory {
  createStorageOptions(): StorageModuleOptions | Promise<StorageModuleOptions>;
}

/** What `forRootAsync()` takes. */
export type StorageModuleAsyncOptions = ConfigurableModuleAsyncOptions<
  StorageModuleOptions,
  "createStorageOptions"
> &
  StorageModuleStructure;

export interface UploadToDiskOptions {
  /** The disk's name in `StorageModule`, or a disk instance. Default: the default disk. */
  disk?: string | StorageDisk;
  /** The key to store the file at. Default: a random UUID plus the detected extension. */
  key?: (file: UploadFileInfo, req: any) => string | Promise<string>;
  /** Accept only these types, detected from the file's bytes. */
  contentTypes?: string[];
  /** Optional fallback detector for file types without a built-in signature. */
  detectContentType?: (
    bytes: Buffer,
    file: UploadFileInfo,
  ) => string | undefined | Promise<string | undefined>;
  /** Maximum prefix size passed to `detectContentType`. Default 4 KiB (1..65536). */
  contentTypeSampleBytes?: number;
  cacheControl?: string;
  metadata?: (file: UploadFileInfo, req: any) => Record<string, string>;
}
