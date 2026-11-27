# Streaming & File upload

Vì Bunest vận hành trực tiếp trên Web Standards và các hàm I/O gốc của Bun, việc truyền phát (streaming) file, trả về dữ liệu nhị phân thô và phân tích các yêu cầu tải lên `multipart/form-data` không hề cần tới `multer` của Express hay lớp bọc `StreamableFile`.

## Phản hồi File Zero-Copy (`Bun.file()`)

Trả về trực tiếp một `BunFile` (kế thừa từ `Blob`) từ bất kỳ controller handler nào. Bộ Response Serializer của Bunest sẽ truyền thẳng nó vào `new Response(blob,...)` — giữ nguyên luồng xử lý nhanh zero-copy `sendfile` ở cấp hệ điều hành của Bun:

@@filename(files.controller.ts)

```ts
import {
  Controller,
  Get,
  Header,
  NotFoundException,
  Param,
} from "@bunest/core";

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

## Truyền phát với `ReadableStream` & Buffer nhị phân

Bạn cũng có thể trả về một Web `ReadableStream` gốc (truyền phát từng chunk không đệm) hoặc `Uint8Array` / `ArrayBuffer`:

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

## Tải lên File Multipart (`@UploadedFile` & `@UploadedFiles`)

Sử dụng `@UploadedFile(fieldName?)` và `@UploadedFiles(fieldName?)` để trích xuất các file tải lên được phân tích từ `multipart/form-data` cùng với các trường `@Body()` thông thường:

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

    const bytes = file.buffer;
    await Bun.write(`./uploads/${crypto.randomUUID()}`, bytes);

    return {
      field: file.fieldname,
      filename: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
      caption: caption ?? null,
    };
  }

  @Post("gallery")
  uploadMany(@UploadedFiles("photos") files: UploadedFileInfo[]) {
    return {
      uploaded: files.map((f) => ({ name: f.originalname, size: f.size })),
    };
  }
}
```

> warning **Giới hạn kích thước Body** Luôn cấu hình `bodyLimit` trong `BunestApplicationOptions` cho các endpoint tải lên công khai. Các payload vượt quá `bodyLimit` sẽ bị từ chối sớm ở Giai đoạn 3 với ngoại lệ **`PayloadTooLargeException` (413)** trước khi nạp toàn bộ request body vào bộ nhớ đệm.
