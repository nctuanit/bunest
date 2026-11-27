# Lưu trữ & Tệp tĩnh (Storage & Static Files)

Bunest cung cấp giải pháp lưu trữ tệp, lưu trữ đối tượng (object storage) và phục vụ tài nguyên tĩnh không phụ thuộc ngoài:

- **`@bunest/storage`** — API lưu trữ đối tượng đa ổ đĩa thống nhất trên ổ đĩa NTFS/POSIX cục bộ (`LocalDisk`), ổ đĩa trong bộ nhớ cho kiểm thử (`InMemoryDisk`) và các dịch vụ tương thích S3 (`S3Disk` cho AWS S3, Cloudflare R2, MinIO) sử dụng ký WebCrypto SigV4 gốc trên `fetch()`, tải lên theo luồng (streamed uploads) và URL có chữ ký tạm thời (presigned URLs).
- **`ServeStaticModule`** — Phục vụ tài nguyên tĩnh gốc (`BunStaticLoader` trên `Bun.file()` zero-copy, ETag/`304`, `Range`/`206` và SPA fallback) được tích hợp sẵn trong `@bunest/core`.

## Cài đặt

```bash
bun add @bunest/storage
```

## Lưu trữ đối tượng đa ổ đĩa (`@bunest/storage`)

Đăng ký các ổ đĩa định danh trong `StorageModule.forRoot()` và inject `Storage` hoặc từng ổ đĩa cụ thể bằng `@InjectDisk()`:

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
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
          },
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
import { InjectDisk, type StorageDisk } from "@bunest/storage";

@Injectable()
export class FilesService {
  constructor(
    @InjectDisk("archive") private readonly archive: StorageDisk,
  ) {}

  async saveAvatar(userId: string, bytes: Uint8Array) {
    await this.archive.put(`avatars/${userId}.png`, bytes, {
      contentType: "image/png",
    });
    return this.archive.signedUrl?.(`avatars/${userId}.png`, {
      expiresIn: "5m",
    });
  }
}
```

## Phục vụ tài nguyên tĩnh (`ServeStaticModule`)

Phục vụ ứng dụng SPA, gói tài liệu hoặc thư mục public bằng `ServeStaticModule` từ `@bunest/core/http` (hoặc `@bunest/core`):

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
