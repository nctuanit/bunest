# Storage & Static Files

Bunest provides zero-dependency file, object storage, and static asset serving:

- **`@bunest/storage`** — Unified multi-disk object storage API across local NTFS/POSIX disks (`LocalDisk`), in-memory testing disks (`InMemoryDisk`), and S3-compatible services (`S3Disk` for AWS S3, Cloudflare R2, MinIO) using native WebCrypto SigV4 signing over `fetch()`, streamed uploads, and presigned URLs.
- **`@bunest/core/http` (`ServeStaticModule`)** — Native static asset serving (`BunStaticLoader` over zero-copy `Bun.file()`, ETag/`304`, `Range`/`206`, and SPA fallback) built directly into `@bunest/core/http` (also re-exported from `@bunest/core`).

## Installation

```bash
bun add @bunest/storage
```

## Multi-Disk Object Storage (`@bunest/storage`)

Register named disks in `StorageModule.forRoot()` and inject `Storage` or specific disks with `@InjectDisk()`:

@@filename(app.module.ts)

```ts
import { Module } from "@bunest/core";
import { LocalDisk, S3Disk, StorageModule } from "@bunest/storage";

@Module({
  imports: [
    StorageModule.forRoot({
      default: "uploads",
      disks: {
        uploads: new LocalDisk({ root: "./storage/uploads" }),
        archive: new S3Disk({
          bucket: process.env.S3_BUCKET!,
          region: "us-east-1",
          accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
        }),
      },
    }),
  ],
})
export class AppModule {}
```

@@filename(files.service.ts)

```ts
import { Injectable } from "@bunest/core";
import { InjectDisk, Storage, type StorageDisk } from "@bunest/storage";

@Injectable()
export class FilesService {
  constructor(
    private readonly storage: Storage,
    @InjectDisk("archive") private readonly archive: StorageDisk,
  ) {}

  async saveAvatar(userId: string, bytes: Uint8Array) {
    await this.storage.put(`avatars/${userId}.png`, bytes, {
      contentType: "image/png",
    });
    return this.archive.signedUrl?.(`avatars/${userId}.png`, {
      expiresInSeconds: 300,
    });
  }
}
```

## Static Asset Serving (`ServeStaticModule`)

Serve SPAs, documentation bundles, or public directories using `ServeStaticModule` from `@bunest/core/http` (or `@bunest/core`):

@@filename(app.module.ts)

```ts
import { join, Module, ServeStaticModule } from "@bunest/core";

@Module({
  imports: [
    ServeStaticModule.forRoot({
      rootPath: join(import.meta.dir, "..", "public"),
      serveRoot: "/static",
    }),
  ],
})
export class AppModule {}
```
