import { Module } from "@bunest/core";
import { InMemoryDisk, StorageModule } from "@bunest/storage";
import { StorageController } from "./storage.controller";

export const DEMO_SIGNING_KEY =
  Bun.env.STORAGE_SIGNING_KEY ?? "bunest-storage-signing-key-min-32-bytes!!";

export function createStorageSignedUploadsModule(
  baseUrl = "http://localhost/storage",
) {
  const uploadsDisk = new InMemoryDisk({
    signedUrls: {
      baseUrl: `${baseUrl}/signed`,
      keys: [DEMO_SIGNING_KEY],
    },
  });

  @Module({
    imports: [
      StorageModule.forRoot({
        default: "uploads",
        disks: {
          uploads: uploadsDisk,
          // Swap to S3Disk in production for AWS S3 / Cloudflare R2 / MinIO:
          // uploads: new S3Disk({ bucket: Bun.env.S3_BUCKET!, region: "auto", endpoint: Bun.env.S3_ENDPOINT, credentials: ... })
        },
      }),
    ],
    controllers: [StorageController],
  })
  class StorageSignedUploadsAppModule {}

  return StorageSignedUploadsAppModule;
}

export const AppModule = createStorageSignedUploadsModule();
