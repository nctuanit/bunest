import {
  Body,
  Controller,
  FileInterceptor,
  FilesInterceptor,
  Get,
  Param,
  ParseFilePipeBuilder,
  Post,
  Req,
  Res,
  UploadedFile,
  UploadedFiles,
  UseInterceptors,
  type ResponseContext,
  type UploadedFileInfo,
} from "@bunest/core";
import { serveFile } from "@bunest/storage";
import { FilesService, type StoredFileMeta } from "./files.service";

@Controller("files")
export class FilesController {
  constructor(private readonly filesService: FilesService) {}

  @Post("upload")
  @UseInterceptors(FileInterceptor("file", { mode: "memory" }))
  async uploadPng(
    @UploadedFile(
      new ParseFilePipeBuilder()
        .addMaxSizeValidator({ maxSize: 1024 * 1024 })
        .addFileTypeValidator({ fileType: "image/png" })
        .build(),
    )
    file: UploadedFileInfo,
    @Body() body: { label?: string },
  ): Promise<StoredFileMeta> {
    return this.filesService.save(file, body?.label);
  }

  @Post("uploads")
  @UseInterceptors(FilesInterceptor("files", 5, { mode: "memory" }))
  async uploadMultiple(
    @UploadedFiles() files: UploadedFileInfo[],
  ): Promise<{ count: number; files: StoredFileMeta[] }> {
    const saved: StoredFileMeta[] = [];
    for (const file of files) {
      saved.push(await this.filesService.save(file));
    }
    return { count: saved.length, files: saved };
  }

  @Get()
  async list(): Promise<{ keys: string[] }> {
    return { keys: await this.filesService.listKeys() };
  }

  @Get(":key")
  async download(
    @Param("key") key: string,
    @Req() req: Request,
    @Res() res: ResponseContext,
  ) {
    return serveFile(this.filesService.getDisk(), key, { req, res });
  }
}
