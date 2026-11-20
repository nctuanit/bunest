import "reflect-metadata";

export { StorageModule } from "./storage.module";
export { STORAGE_MODULE_OPTIONS } from "./constants";
export { getDiskToken } from "./storage.module-definition";
export type {
  StorageModuleAsyncOptions,
  StorageModuleOptions,
  StorageModuleRootOptions,
  StorageOptionsFactory,
  UploadToDiskOptions,
} from "./interfaces/module-options.interface";
export { Storage } from "./storage.service";
export { InjectDisk } from "./decorators/inject-disk.decorator";
export { StorageDisk } from "./disks/storage.disk";
export { LocalDisk } from "./disks/local.disk";
export { InMemoryDisk } from "./disks/in-memory.disk";
export { S3Disk } from "./s3/s3.disk";
export type {
  Duration,
  InMemoryDiskOptions,
  LocalDiskOptions,
  ReceiveSignedUploadOptions,
  S3Credentials,
  S3DiskOptions,
  ServeFileOptions,
  ServeSignedUrlOptions,
  StorageBackoffOptions,
  StorageBody,
  StorageDiskOptions,
  StorageDownload,
  StorageFile,
  StorageGetOptions,
  StorageListEntry,
  StorageListOptions,
  StorageListPage,
  StorageObjectWrite,
  StoragePutOptions,
  StorageRange,
  StorageRetryOptions,
  StorageSignalOptions,
  StorageSignedUpload,
  StorageSignedUploadRequest,
  StorageSignedUrlClaims,
  StorageSignedUrlOptions,
  StorageSignedUrlRequest,
  StorageWriteResult,
  StoredUpload,
  UploadFileInfo,
  UploadStorageEngine,
} from "./interfaces/storage-types";
export { detectContentType } from "./utils/content-type.util";
export { uploadToDisk } from "./http/upload-to-disk.util";
export { serveFile, serveSignedUrl } from "./http/serve-file.util";
export { receiveSignedUpload } from "./http/receive-signed-upload.util";
export {
  StorageBodyLengthError,
  StorageError,
  StorageFileNotFoundError,
  StorageInvalidKeyError,
  StorageKeyConflictError,
  StorageRangeNotSatisfiableError,
  StorageServiceError,
  StorageSignedUrlError,
  type StorageSignedUrlFailure,
} from "./errors";
