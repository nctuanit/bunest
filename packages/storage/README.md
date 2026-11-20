# @bunest/storage

Zero-dependency, Bun-native file storage for **Bunest** with full `@nestjs/storage` API parity. Provides a unified multi-disk API for local disks, in-memory storage, and S3/R2/MinIO with native AWS Signature Version 4 `fetch()`, streamed uploads, and signed URLs.

## Features

- **Multi-Disk DI**: Register default and named disks via `StorageModule.forRoot()` / `forRootAsync()` and inject them with `Storage` or `@InjectDisk(name)`.
- **Three Built-In Drivers**:
  - `InMemoryDisk` — fast ephemeral storage for tests and prototyping.
  - `LocalDisk` — atomic writes, symlink/path-traversal/NTFS-ADS confinement, and per-version JSON metadata sidecars.
  - `S3Disk` — native `fetch()` + AWS Signature Version 4 signing + multipart uploads compatible with AWS S3, Cloudflare R2, and MinIO.
- **Content Detection & Signed URLs**: Magic-byte MIME sniffing (`detectContentType()`) and HMAC-SHA256 app-served signed download/upload URLs.
- **HTTP Helpers**: Stream files, serve signed downloads, receive signed uploads, and handle multipart uploads with `serveFile()`, `serveSignedUrl()`, `receiveSignedUpload()`, and `uploadToDisk()`.

## Installation

```bash
bun add @bunest/storage
```

## Quick Start

```ts
import { Injectable, Module } from "@bunest/common";
import {
  InjectDisk,
  LocalDisk,
  Storage,
  StorageDisk,
  StorageModule,
} from "@bunest/storage";

@Injectable()
export class AvatarsService {
  constructor(
    private readonly storage: Storage,
    @InjectDisk("uploads") private readonly uploads: StorageDisk,
  ) {}

  async saveAvatar(userId: string, data: Uint8Array) {
    return this.uploads.put(`avatars/${userId}.png`, data, {
      contentType: "image/png",
    });
  }

  async getAvatarUrl(userId: string) {
    return this.storage.disk("uploads").signedUrl(`avatars/${userId}.png`, {
      expiresIn: "15m",
    });
  }
}

@Module({
  imports: [
    StorageModule.forRoot({
      default: "uploads",
      disks: {
        uploads: new LocalDisk({ root: "./storage/uploads" }),
      },
    }),
  ],
  providers: [AvatarsService],
})
export class AppModule {}
```

## Key Exports

- **Module & DI**: `StorageModule`, `Storage`, `InjectDisk`, `getDiskToken`, `STORAGE_MODULE_OPTIONS`
- **Disk Drivers**: `StorageDisk`, `LocalDisk`, `InMemoryDisk`, `S3Disk`
- **HTTP & Utility Helpers**: `detectContentType`, `uploadToDisk`, `serveFile`, `serveSignedUrl`, `receiveSignedUpload`
- **Errors**: `StorageError`, `StorageFileNotFoundError`, `StorageInvalidKeyError`, `StorageKeyConflictError`, `StorageBodyLengthError`, `StorageRangeNotSatisfiableError`, `StorageServiceError`, `StorageSignedUrlError`

## Documentation

- [Bunest Documentation](../../README.md)
- [ADR Index](../../docs/adr/README.md)
