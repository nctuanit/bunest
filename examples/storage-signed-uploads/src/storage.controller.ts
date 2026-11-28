import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Req,
  Res,
  type ResponseContext,
} from "@bunest/core";
import {
  Storage,
  inspectImage,
  receiveSignedUpload,
  serveFile,
  serveSignedUrl,
} from "@bunest/storage";

@Controller("storage")
export class StorageController {
  constructor(private readonly storage: Storage) {}

  @Post("presign-upload")
  async createSignedUpload(
    @Body()
    body: {
      key: string;
      contentType: string;
      contentLength: number;
    },
  ) {
    const disk = this.storage.disk();
    const signed = await disk.signedUpload(body.key, {
      contentType: body.contentType,
      contentLength: body.contentLength,
      expiresIn: "5m",
    });
    return {
      key: body.key,
      uploadUrl: signed.url,
      headers: signed.headers,
      expiresAt: signed.expiresAt.toISOString(),
    };
  }

  @Put("signed")
  async handleSignedUpload(
    @Req() req: Request,
    @Res() res: ResponseContext,
  ) {
    const disk = this.storage.disk();
    const result = await receiveSignedUpload(disk, { req, res });
    const bytes = await disk.getBuffer(result.key);
    const imageInfo = result.contentType.startsWith("image/")
      ? await inspectImage(bytes)
      : undefined;
    return {
      key: result.key,
      size: result.size,
      contentType: result.contentType,
      etag: result.etag,
      ...(imageInfo ? { image: imageInfo } : {}),
    };
  }

  @Post("presign-download")
  async createSignedDownload(@Body() body: { key: string }) {
    const url = await this.storage.disk().signedUrl(body.key, {
      expiresIn: "5m",
    });
    return { key: body.key, downloadUrl: url };
  }

  @Get("signed")
  async handleSignedDownload(
    @Req() req: Request,
    @Res() res: ResponseContext,
  ) {
    return serveSignedUrl(this.storage.disk(), { req, res });
  }

  @Get("files/:key")
  async getDirect(
    @Param("key") key: string,
    @Req() req: Request,
    @Res() res: ResponseContext,
  ) {
    return serveFile(this.storage.disk(), key, { req, res });
  }
}
