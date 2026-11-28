import { Module } from "@bunest/core";
import { FilesController } from "./files.controller";
import { FilesService } from "./files.service";

@Module({
  controllers: [FilesController],
  providers: [FilesService],
})
export class FilesModule {}
