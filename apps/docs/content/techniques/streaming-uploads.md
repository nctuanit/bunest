# Streaming & File upload

Because Bunest operates directly on Web Standards and Bun's native I/O primitives, streaming files, returning raw binary data, and parsing `multipart/form-data` uploads require zero Express `multer` or `StreamableFile` wrappers.

## Zero-Copy File Responses (`Bun.file()`)

Return a `BunFile` (which extends `Blob`) directly from any controller handler. Bunest's Response Serializer passes it untouched to `new Response(blob, ...)`—preserving Bun's OS-level zero-copy `sendfile` fast path ([ADR-010](/architecture/response-serialization)):

@@filename(files.controller.ts)
```ts
import { Controller, Get, Header, NotFoundException, Param } from "@bunest/core";

@Controller("files")
export class FilesController {
  @Get(":name")
  @Header("Cache-Control", "public, max-age=3600")
  async download(@Param("name") name: string) {
    // Sanitize filename to prevent path traversal
    const safeName = name.replace(/[^a-zA-Z0-9._-]/g, "");
    const file = Bun.file(`./uploads/${safeName}`);

    if (!(await file.exists())) {
      throw new NotFoundException(`File "${safeName}" not found`);
    }

    return file; // Zero-copy native streaming with automatic Content-Type!
  }
}
```

## Streaming with `ReadableStream` & Binary Buffers

You can also return a native Web `ReadableStream` (zero-buffering chunk streaming) or `Uint8Array` / `ArrayBuffer`:

@@filename(export.controller.ts)
```ts
import { Controller, Get, Header } from "@bunest/core";

@Controller("export")
export class ExportController {
  @Get("csv")
  @Header("Content-Type", "text/csv; charset=utf-8")
  @Header("Content-Disposition", 'attachment; filename="report.csv"')
  streamCsv(): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("id,status\n"));
        controller.enqueue(encoder.encode("1,ok\n"));
        controller.enqueue(encoder.encode("2,ok\n"));
        controller.close();
      },
    });
  }
}
```

## Multipart File Uploads (`@UploadedFile` & `@UploadedFiles`)

Use `@UploadedFile(fieldName?)` and `@UploadedFiles(fieldName?)` to extract uploaded files parsed from `multipart/form-data` alongside regular `@Body()` fields:

@@filename(uploads.controller.ts)
```ts
import {
  BadRequestException,
  Body,
  Controller,
  Post,
  UploadedFile,
  UploadedFiles,
  type UploadedFileInfo,
} from "@bunest/core";

@Controller("uploads")
export class UploadsController {
  @Post("avatar")
  async uploadAvatar(
    @UploadedFile("avatar") file: UploadedFileInfo | undefined,
    @Body("caption") caption?: string,
  ) {
    if (!file) {
      throw new BadRequestException("Missing avatar file");
    }

    const bytes = await file.arrayBuffer();
    await Bun.write(`./uploads/${file.filename}`, bytes);

    return {
      field: file.fieldName,
      filename: file.filename,
      mimeType: file.mimeType,
      size: file.size,
      caption: caption ?? null,
    };
  }

  @Post("gallery")
  uploadMany(@UploadedFiles("photos") files: UploadedFileInfo[]) {
    return {
      uploaded: files.map((f) => ({ name: f.filename, size: f.size })),
    };
  }
}
```

> warning **Body Size Limits** Always configure `bodyLimit` in `BunestApplicationOptions` for public upload endpoints. Payloads exceeding `bodyLimit` fail early at Stage 3 with **`PayloadTooLargeException` (413)** before buffering the full request body.
