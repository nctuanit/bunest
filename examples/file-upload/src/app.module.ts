import { Module } from "@bunest/core";
import { InMemoryDisk, StorageModule } from "@bunest/storage";
import { FilesModule } from "./files/files.module";

export function createFileUploadModule() {
  @Module({
    imports: [
      StorageModule.forRoot({
        default: "uploads",
        disks: {
          uploads: new InMemoryDisk(),
        },
      }),
      FilesModule,
    ],
  })
  class FileUploadAppModule {}

  return FileUploadAppModule;
}

export const AppModule = createFileUploadModule();
