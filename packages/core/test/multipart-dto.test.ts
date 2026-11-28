import { describe, expect, it } from "bun:test";
import {
  Body,
  Controller,
  Module,
  Post,
  UploadedFile,
  UseInterceptors,
  type UploadedFileInfo,
} from "../src/common/index";
import {
  FileInterceptor,
  FilesInterceptor,
  UploadedFileStream,
  type UploadedFileStream as UploadedFileStreamType,
} from "../src/http/index";
import { BunestFactory } from "../src/index";

describe("Multipart + nested DTO fields in FileInterceptor", () => {
  @Controller("uploads")
  class UploadController {
    @Post("bracket")
    @UseInterceptors(FileInterceptor("avatar", { mode: "memory" }))
    uploadWithBrackets(
      @UploadedFile() file: UploadedFileInfo,
      @Body() body: Record<string, unknown>,
    ) {
      return {
        filename: file.originalname,
        size: file.size,
        body,
      };
    }

    @Post("json-auto")
    @UseInterceptors(
      FileInterceptor("avatar", { mode: "memory", parseJsonFields: true }),
    )
    uploadWithAutoJson(
      @UploadedFile() file: UploadedFileInfo,
      @Body() body: Record<string, unknown>,
    ) {
      return {
        filename: file.originalname,
        body,
      };
    }

    @Post("json-strict")
    @UseInterceptors(
      FileInterceptor("avatar", {
        mode: "memory",
        parseJsonFields: ["metadata"],
      }),
    )
    uploadWithStrictJson(
      @UploadedFile() file: UploadedFileInfo,
      @Body() body: Record<string, unknown>,
    ) {
      return {
        filename: file.originalname,
        body,
      };
    }

    @Post("files-stream")
    @UseInterceptors(
      FilesInterceptor("docs", 5, {
        mode: "stream",
        parseJsonFields: true,
      }),
    )
    async uploadFilesStream(
      @UploadedFileStream() files: AsyncIterable<UploadedFileStreamType>,
      @Body() body: Record<string, unknown>,
    ) {
      const names: string[] = [];
      for await (const f of files) {
        names.push(f.originalname);
        await f.stream.cancel();
      }
      return { names, body };
    }
  }

  @Module({ controllers: [UploadController] })
  class UploadModule {}

  it("parses nested bracket fields alongside @UploadedFile()", async () => {
    const app = await BunestFactory.create(UploadModule, { logger: false });
    await app.init();

    try {
      const form = new FormData();
      form.append("avatar", new File(["hello"], "pic.png", { type: "image/png" }));
      form.append("address[city]", "Hanoi");
      form.append("address[zip]", "10000");
      form.append("items[0][sku]", "SKU-1");
      form.append("items[1][sku]", "SKU-2");

      const res = await app.fetch(
        new Request("http://localhost/uploads/bracket", {
          method: "POST",
          body: form,
        }),
      );
      expect(res.status).toBe(201);
      const json = (await res.json()) as {
        filename: string;
        size: number;
        body: Record<string, unknown>;
      };
      expect(json.filename).toBe("pic.png");
      expect(json.size).toBe(5);
      expect(json.body).toEqual({
        address: { city: "Hanoi", zip: "10000" },
        items: [{ sku: "SKU-1" }, { sku: "SKU-2" }],
      });
    } finally {
      await app.close();
    }
  });

  it("parses JSON-encoded fields with parseJsonFields: true and strips prototype pollution keys", async () => {
    const app = await BunestFactory.create(UploadModule, { logger: false });
    await app.init();

    try {
      const form = new FormData();
      form.append("avatar", new File(["bin"], "doc.txt", { type: "text/plain" }));
      form.append(
        "metadata",
        '{"tags":["a","b"],"__proto__":{"polluted":true}}',
      );
      form.append("plain", "{not valid json");

      const res = await app.fetch(
        new Request("http://localhost/uploads/json-auto", {
          method: "POST",
          body: form,
        }),
      );
      expect(res.status).toBe(201);
      const json = (await res.json()) as {
        filename: string;
        body: Record<string, unknown>;
      };
      expect(json.body.metadata).toEqual({ tags: ["a", "b"] });
      expect(
        Object.prototype.hasOwnProperty.call(
          json.body.metadata as object,
          "__proto__",
        ),
      ).toBe(false);
      expect(json.body.plain).toBe("{not valid json");
    } finally {
      await app.close();
    }
  });

  it("rejects malformed JSON with HTTP 400 when field is listed in parseJsonFields: string[]", async () => {
    const app = await BunestFactory.create(UploadModule, { logger: false });
    await app.init();

    try {
      const form = new FormData();
      form.append("avatar", new File(["bin"], "doc.txt", { type: "text/plain" }));
      form.append("metadata", "{broken-json");

      const res = await app.fetch(
        new Request("http://localhost/uploads/json-strict", {
          method: "POST",
          body: form,
        }),
      );
      expect(res.status).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("prevents sparse-array DoS, handles duplicate indexed fields, and populates leading @Body() fields in FilesInterceptor stream mode", async () => {
    const app = await BunestFactory.create(UploadModule, { logger: false });
    await app.init();

    try {
      const dosForm = new FormData();
      dosForm.append("avatar", new File(["x"], "a.txt", { type: "text/plain" }));
      dosForm.append("items[99999999][sku]", "HUGE");
      dosForm.append("tags[0]", "first");
      dosForm.append("tags[0]", "second");

      const dosRes = await app.fetch(
        new Request("http://localhost/uploads/bracket", {
          method: "POST",
          body: dosForm,
        }),
      );
      expect(dosRes.status).toBe(201);
      const dosJson = (await dosRes.json()) as {
        body: Record<string, unknown>;
      };
      // Out-of-bounds index must be stored as plain object key, NOT a 100M sparse array
      expect(Array.isArray(dosJson.body.items)).toBe(false);
      expect(dosJson.body.items).toEqual({ "99999999": { sku: "HUGE" } });
      expect(dosJson.body.tags).toEqual([["first", "second"]]);

      // FilesInterceptor in stream mode must expose leading text/JSON fields to @Body()
      const streamForm = new FormData();
      streamForm.append("meta", '{"project":"bunest"}');
      streamForm.append("address[city]", "Hanoi");
      streamForm.append("docs", new File(["1"], "one.txt", { type: "text/plain" }));
      streamForm.append("docs", new File(["2"], "two.txt", { type: "text/plain" }));

      const streamRes = await app.fetch(
        new Request("http://localhost/uploads/files-stream", {
          method: "POST",
          body: streamForm,
        }),
      );
      expect(streamRes.status).toBe(201);
      expect(await streamRes.json()).toEqual({
        names: ["one.txt", "two.txt"],
        body: {
          meta: { project: "bunest" },
          address: { city: "Hanoi" },
        },
      });
    } finally {
      await app.close();
    }
  });
});
