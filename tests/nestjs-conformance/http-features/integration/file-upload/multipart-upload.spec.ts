import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  BadRequestException,
  Body,
  Controller,
  FileTypeValidator,
  MaxFileSizeValidator,
  Module,
  ParseFilePipe,
  ParseIntPipe,
  Post,
  UploadedFile,
  UploadedFiles,
  type UploadedFileInfo,
} from "../../../../../packages/core/src/common";
import {
  join,
  mkdirSyncPath,
  readDirSyncNames,
  readTextSync,
  removePath,
  type BunestApplication,
  type DiskUploadedFileInfo,
} from "../../../../../packages/core/src";
import {
  Test,
  describeConformance,
  itAdapted,
  request,
} from "../../../_helpers";

// 1x1 transparent PNG so FileTypeValidator's magic-number check runs for real
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const txt = (filename: string) => ({
  filename,
  contentType: "text/plain",
});

const text = (value: string) => Buffer.from(value);

function describeFile(
  file: UploadedFileInfo | DiskUploadedFileInfo | undefined,
) {
  if (!file) {
    return file;
  }
  const disk = file as Partial<DiskUploadedFileInfo>;
  return {
    fieldname: file.fieldname,
    originalname: file.originalname,
    mimetype: file.mimetype,
    size: file.size,
    content:
      file.buffer && file.buffer.byteLength > 0
        ? Buffer.from(file.buffer).toString("latin1")
        : "",
    onDisk:
      disk.path !== undefined
        ? disk.path === join(disk.destination ?? "", disk.filename ?? "")
        : undefined,
    filename: disk.filename,
    path: disk.path,
  };
}

async function hashWebStream(
  stream: ReadableStream<Uint8Array>,
): Promise<{ hash: string; size: number }> {
  const hash = new Bun.CryptoHasher("sha256");
  let size = 0;
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        hash.update(value);
        size += value.byteLength;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return { hash: hash.digest("hex"), size };
}

async function waitForCondition(
  fn: () => void,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      fn();
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  throw lastErr ?? new Error("Condition timed out");
}

@Controller()
class MemoryUploadController {
  @Post("single")
  single(
    @UploadedFile("avatar") file: UploadedFileInfo | undefined,
    @Body() body: unknown,
    @UploadedFiles("avatar") files: UploadedFileInfo[],
  ) {
    return {
      file: describeFile(file),
      body,
      filesCount: files.length,
    };
  }

  @Post("single-strict")
  singleStrict(@UploadedFiles() allFiles: UploadedFileInfo[]) {
    for (const f of allFiles) {
      if (f.fieldname !== "avatar") {
        throw new BadRequestException(`Unexpected file field - ${f.fieldname}`);
      }
    }
    return { file: describeFile(allFiles[0]) };
  }

  @Post("validated")
  validated(
    @UploadedFile(
      "avatar",
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 100 }),
          new FileTypeValidator({ fileType: "image/png" }),
        ],
      }),
    )
    file: UploadedFileInfo,
  ) {
    return { file: describeFile(file) };
  }

  @Post("many")
  many(
    @UploadedFiles("docs") files: UploadedFileInfo[],
    @Body() body: unknown,
  ) {
    if (files.length > 2) {
      throw new BadRequestException("Unexpected file field - docs");
    }
    return { files: files.map(describeFile), body };
  }

  @Post("fields")
  fields(
    @UploadedFiles("avatar") avatar: UploadedFileInfo[],
    @UploadedFiles("background") background: UploadedFileInfo[],
  ) {
    return {
      files: {
        background: background.map(describeFile),
        avatar: avatar.map(describeFile),
      },
    };
  }

  @Post("any")
  any(@UploadedFiles() files: UploadedFileInfo[]) {
    return { files: files.map(describeFile) };
  }

  @Post("none")
  none(@Body() body: unknown, @UploadedFiles() files: UploadedFileInfo[]) {
    if (files.length > 0) {
      throw new BadRequestException(
        `Unexpected file field - ${files[0]!.fieldname}`,
      );
    }
    return { body, filesCount: files.length };
  }

  @Post("filtered")
  filtered(@UploadedFiles() files: UploadedFileInfo[]) {
    const kept: UploadedFileInfo[] = [];
    for (const file of files) {
      if (file.mimetype.startsWith("text/plain")) {
        kept.push(file);
      } else if (file.originalname === "evil.exe") {
        throw new BadRequestException("No executables");
      }
    }
    return { files: kept.map(describeFile) };
  }

  @Post("hash")
  async hash(
    @UploadedFile("upload") file: UploadedFileInfo | undefined,
    @UploadedFiles() allFiles: UploadedFileInfo[],
    @Body() body: unknown,
  ) {
    const unexpected = allFiles.find((f) => f.fieldname !== "upload");
    if (unexpected) {
      throw new BadRequestException(
        `Unexpected file field - ${unexpected.fieldname}`,
      );
    }
    if (!file) {
      throw new BadRequestException("File is required");
    }
    const { hash, size } = await hashWebStream(file.stream!());
    return { hash, size, originalname: file.originalname, body };
  }
}

@Controller()
class DiskUploadController {
  @Post("disk")
  disk(@UploadedFiles("docs") files: DiskUploadedFileInfo[]) {
    return { files: files.map(describeFile) };
  }

  @Post("disk-validated")
  diskValidated(
    @UploadedFiles("docs") files: DiskUploadedFileInfo[],
    @Body("count", ParseIntPipe) count: number,
  ) {
    return { files: files.map(describeFile), count };
  }

  @Post("disk-single")
  diskSingle(@UploadedFile("doc") file: DiskUploadedFileInfo | undefined) {
    return { file: describeFile(file) };
  }
}

@Module({ controllers: [MemoryUploadController] })
class MemoryUploadModule {}

@Module({ controllers: [DiskUploadController] })
class DiskUploadModule {}

describeConformance(
  "File upload / Native Multipart Conformance (BunHttpAdapter)",
  {
    upstreamPath: "integration/file-upload/e2e/parity.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-004"],
    notes:
      "Adapts NestJS Multer/Fastify/Node multipart upload parity scenarios (memory & streaming disk storage, malformed bodies, ParseFilePipe magic-number validation, limits, field extraction, streaming SHA-256) to Bunest native multipart (@UploadedFile/@UploadedFiles + BunestApplicationOptions.multipart).",
  },
  () => {
    let memApp: BunestApplication;
    let limitedApp: BunestApplication;
    let hashLimitedApp: BunestApplication;
    let hashSmallApp: BunestApplication;
    let diskApp: BunestApplication;
    let diskDir: string;

    beforeAll(async () => {
      diskDir = join(
        Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp",
        `bunest-upload-disk-${crypto.randomUUID()}`,
      );
      mkdirSyncPath(diskDir, { recursive: true });

      const memMod = await Test.createTestingModule({
        imports: [MemoryUploadModule],
      }).compile();
      memApp = memMod.createNestApplication({ logger: false });
      await memApp.init();

      const limMod = await Test.createTestingModule({
        imports: [MemoryUploadModule],
      }).compile();
      limitedApp = limMod.createNestApplication({ logger: false });
      limitedApp.getHttpAdapter().setMultipartOptions({
        maxFileSize: 4,
        maxFiles: 2,
      });
      await limitedApp.init();

      const hashMod = await Test.createTestingModule({
        imports: [MemoryUploadModule],
      }).compile();
      hashLimitedApp = hashMod.createNestApplication({ logger: false });
      hashLimitedApp.getHttpAdapter().setMultipartOptions({
        maxFileSize: 64 * 1024,
      });
      await hashLimitedApp.init();

      const hashSmallMod = await Test.createTestingModule({
        imports: [MemoryUploadModule],
      }).compile();
      hashSmallApp = hashSmallMod.createNestApplication({ logger: false });
      hashSmallApp.getHttpAdapter().setMultipartOptions({
        maxFileSize: 4,
      });
      await hashSmallApp.init();

      const diskMod = await Test.createTestingModule({
        imports: [DiskUploadModule],
      }).compile();
      diskApp = diskMod.createNestApplication({ logger: false });
      diskApp.getHttpAdapter().setMultipartOptions({
        diskStorageDir: diskDir,
        maxFileSize: 10,
        maxFiles: 5,
      });
      await diskApp.listen(0, "127.0.0.1");
    });

    afterAll(async () => {
      await memApp?.close();
      await limitedApp?.close();
      await hashLimitedApp?.close();
      await hashSmallApp?.close();
      await diskApp?.close();
      await removePath(diskDir, { recursive: true, force: true });
    });

    describe("memory storage", () => {
      itAdapted(
        ["ADR-001", "ADR-004"],
        "should populate @UploadedFile and @Body with Bunest UploadedFileInfo shape",
        async () => {
          const res = await request(memApp)
            .post("/single")
            .field("name", "Ada")
            .attach("avatar", text("hello"), txt("a.txt"))
            .expect(201);

          expect(res.body.file).toMatchObject({
            fieldname: "avatar",
            originalname: "a.txt",
            size: 5,
            content: "hello",
          });
          expect(res.body.file.mimetype).toContain("text/plain");
          expect(res.body.body).toEqual({ name: "Ada" });
        },
        "Bunest uses UploadedFileInfo { fieldname, originalname, mimetype, size, buffer, file, stream }",
      );

      it("should isolate files by field name across @UploadedFile and @UploadedFiles", async () => {
        const single = await request(memApp)
          .post("/single")
          .attach("avatar", text("x"), txt("a.txt"))
          .expect(201);
        expect(single.body.file.fieldname).toBe("avatar");
        expect(single.body.filesCount).toBe(1);

        const many = await request(memApp)
          .post("/many")
          .attach("docs", text("x"), txt("a.txt"))
          .expect(201);
        expect(many.body.files).toHaveLength(1);
      });

      it("should group repeated text fields into arrays", async () => {
        const res = await request(memApp)
          .post("/single")
          .field("color", "red")
          .field("color", "blue")
          .expect(201);
        expect(res.body.body).toEqual({
          color: ["red", "blue"],
        });
      });

      it("should parse text fields with bracket notation into nested objects/arrays", async () => {
        const res = await request(memApp)
          .post("/single")
          .field("user[name]", "Ada")
          .field("user[roles][]", "admin")
          .field("user[roles][]", "dev")
          .field("tags[0]", "a")
          .field("tags[1]", "b")
          .field("color", "red")
          .field("color", "blue")
          .expect(201);
        expect(res.body.body).toEqual({
          user: { name: "Ada", roles: ["admin", "dev"] },
          tags: ["a", "b"],
          color: ["red", "blue"],
        });
      });

      it("should pass non-multipart JSON requests through", async () => {
        const res = await request(memApp)
          .post("/single")
          .send({ json: true })
          .expect(201);
        expect(res.body.body).toEqual({ json: true });
        expect(res.body.file).toBeUndefined();
      });

      it("should ignore an empty file input (no filename)", async () => {
        const boundary = "----bunestempty";
        const rawBody =
          `--${boundary}\r\n` +
          'Content-Disposition: form-data; name="avatar"; filename=""\r\n' +
          "Content-Type: application/octet-stream\r\n\r\n\r\n" +
          `--${boundary}--\r\n`;
        const res = await request(memApp)
          .post("/single")
          .set("Content-Type", `multipart/form-data; boundary=${boundary}`)
          .send(rawBody)
          .expect(201);
        expect(res.body.file).toBeUndefined();
      });
    });

    describe("malformed bodies", () => {
      const boundary = "----nestboundary";
      const head =
        `--${boundary}\r\n` +
        'Content-Disposition: form-data; name="avatar"; filename="a.txt"\r\n' +
        "Content-Type: text/plain\r\n\r\n";

      it("should reject a body without a boundary", async () => {
        const res = await request(memApp)
          .post("/single")
          .set("Content-Type", "multipart/form-data")
          .send("whatever")
          .expect(400);
        expect(res.body.statusCode).toBe(400);
        expect(res.body.error).toBe("Bad Request");
      });

      it("should reject a body that ends in the middle of a file (memory)", async () => {
        const res = await request(memApp)
          .post("/single")
          .set("Content-Type", `multipart/form-data; boundary=${boundary}`)
          .send(head + "partial content")
          .expect(400);
        expect(res.body.statusCode).toBe(400);
      });

      it("should reject a body that ends in the middle of a file on disk and clean up partial files", async () => {
        const res = await request(diskApp)
          .post("/disk-single")
          .set("Content-Type", `multipart/form-data; boundary=${boundary}`)
          .send(head.replace('"avatar"', '"doc"') + "partial content")
          .expect(400);
        expect(res.body.statusCode).toBe(400);
        expect(readDirSyncNames(diskDir)).toEqual([]);
      });

      it("should reject a body that ends between parts", async () => {
        const res = await request(memApp)
          .post("/single")
          .set("Content-Type", `multipart/form-data; boundary=${boundary}`)
          .send(
            `--${boundary}\r\n` +
              'Content-Disposition: form-data; name="a"\r\n\r\n1\r\n',
          )
          .expect(400);
        expect(res.body.statusCode).toBe(400);
      });
    });

    describe("field names", () => {
      it("should handle escaped characters in field names", async () => {
        const boundary = "----bunestescaped";
        const res = await request(memApp)
          .post("/none")
          .set("Content-Type", `multipart/form-data; boundary=${boundary}`)
          .send(
            `--${boundary}\r\n` +
              'Content-Disposition: form-data; name="a%22b%0Ac"\r\n\r\n1\r\n' +
              `--${boundary}--\r\n`,
          )
          .expect(201);
        expect(res.body.body).toEqual({ 'a"b\nc': "1" });
      });

      it("should decode escaped characters in file names", async () => {
        const boundary = "----nestboundary";
        const res = await request(memApp)
          .post("/single")
          .set("Content-Type", `multipart/form-data; boundary=${boundary}`)
          .send(
            `--${boundary}\r\n` +
              'Content-Disposition: form-data; name="avatar"; filename="a%22b%0Ac.txt"\r\n' +
              "Content-Type: text/plain\r\n\r\nhello\r\n" +
              `--${boundary}--\r\n`,
          )
          .expect(201);
        expect(res.body.file.originalname).toBe('a"b\nc.txt');
      });
    });

    describe("ParseFilePipe", () => {
      it("should accept a valid PNG file", async () => {
        const res = await request(memApp)
          .post("/validated")
          .attach("avatar", PNG, {
            filename: "dot.png",
            contentType: "image/png",
          })
          .expect(201);
        expect(res.body.file.size).toBe(PNG.length);
      });

      it("should reject a file over maxSize", async () => {
        const big = Buffer.concat([PNG, Buffer.alloc(100)]);
        const res = await request(memApp)
          .post("/validated")
          .attach("avatar", big, {
            filename: "big.png",
            contentType: "image/png",
          })
          .expect(400);
        expect(res.body.message).toMatch(/100|size/i);
      });

      it("should reject a file whose magic bytes are not the declared type", async () => {
        const res = await request(memApp)
          .post("/validated")
          .attach("avatar", text("not a png"), {
            filename: "x.png",
            contentType: "image/png",
          })
          .expect(400);
        expect(res.body.message).toMatch(/image\/png|type/i);
      });

      it("should reject a missing file", async () => {
        const res = await request(memApp)
          .post("/validated")
          .field("x", "y")
          .expect(400);
        expect(res.body).toMatchObject({
          statusCode: 400,
          message: "File is required",
        });
      });
    });

    describe("field extraction & multi-file handling", () => {
      it("should populate @UploadedFiles('docs') with an array", async () => {
        const res = await request(memApp)
          .post("/many")
          .attach("docs", text("one"), txt("1.txt"))
          .attach("docs", text("two"), txt("2.txt"))
          .expect(201);
        expect(res.body.files.map((f: any) => f.content)).toEqual([
          "one",
          "two",
        ]);
      });

      it("should reject files over maxCount when enforced", async () => {
        const res = await request(memApp)
          .post("/many")
          .attach("docs", text("1"), txt("1.txt"))
          .attach("docs", text("2"), txt("2.txt"))
          .attach("docs", text("3"), txt("3.txt"))
          .expect(400);
        expect(res.body).toMatchObject({
          statusCode: 400,
          error: "Bad Request",
          message: "Unexpected file field - docs",
        });
      });

      it("should group files by field name across multiple @UploadedFiles(field) params", async () => {
        const res = await request(memApp)
          .post("/fields")
          .attach("background", text("b1"), txt("b1.txt"))
          .attach("avatar", text("a"), txt("a.txt"))
          .attach("background", text("b2"), txt("b2.txt"))
          .expect(201);
        expect(Object.keys(res.body.files)).toEqual(["background", "avatar"]);
        expect(res.body.files.background).toHaveLength(2);
        expect(res.body.files.avatar).toHaveLength(1);
      });

      it("should accept files in any field via @UploadedFiles()", async () => {
        const res = await request(memApp)
          .post("/any")
          .attach("x", text("1"), txt("1.txt"))
          .attach("y", text("2"), txt("2.txt"))
          .expect(201);
        expect(res.body.files.map((f: any) => f.fieldname)).toEqual(["x", "y"]);
      });

      it("should accept text fields with no files", async () => {
        const res = await request(memApp)
          .post("/none")
          .field("a", "1")
          .field("b", "2")
          .expect(201);
        expect(res.body).toEqual({
          body: { a: "1", b: "2" },
          filesCount: 0,
        });
      });

      it("should reject a file on a no-files route", async () => {
        const res = await request(memApp)
          .post("/none")
          .field("a", "1")
          .attach("avatar", text("x"), txt("x.txt"))
          .expect(400);
        expect(res.body).toMatchObject({
          statusCode: 400,
          error: "Bad Request",
          message: "Unexpected file field - avatar",
        });
      });

      it("should reject a file in an unexpected field", async () => {
        const res = await request(memApp)
          .post("/single-strict")
          .attach("other", text("x"), txt("x.txt"))
          .expect(400);
        expect(res.body).toMatchObject({
          statusCode: 400,
          error: "Bad Request",
          message: "Unexpected file field - other",
        });
      });
    });

    describe("limits (multipart.maxFileSize & multipart.maxFiles)", () => {
      it("should accept a file of exactly maxFileSize bytes", async () => {
        const res = await request(limitedApp)
          .post("/any")
          .attach("f", text("1234"), txt("ok.txt"))
          .expect(201);
        expect(res.body.files[0].size).toBe(4);
      });

      it("should reject (not truncate) a file over maxFileSize with 413", async () => {
        const res = await request(limitedApp)
          .post("/any")
          .attach("f", text("12345"), txt("big.txt"))
          .expect(413);
        expect(res.body.statusCode).toBe(413);
      });

      itAdapted(
        "ADR-004",
        "should reject too many files over maxFiles with 413",
        async () => {
          const res = await request(limitedApp)
            .post("/any")
            .attach("f", text("1"), txt("1.txt"))
            .attach("f", text("2"), txt("2.txt"))
            .attach("f", text("3"), txt("3.txt"))
            .expect(413);
          expect(res.body.statusCode).toBe(413);
        },
        "Bunest throws PayloadTooLargeException (413) when exceeding multipart.maxFiles",
      );
    });

    describe("file filtering", () => {
      it("should skip rejected files and propagate filter errors", async () => {
        const res = await request(memApp)
          .post("/filtered")
          .attach("f", text("keep"), txt("keep.txt"))
          .attach("f", text("{}"), {
            filename: "skip.json",
            contentType: "application/json",
          })
          .expect(201);
        expect(res.body.files.map((f: any) => f.originalname)).toEqual([
          "keep.txt",
        ]);

        const err = await request(memApp)
          .post("/filtered")
          .attach("f", text("MZ"), {
            filename: "evil.exe",
            contentType: "application/octet-stream",
          })
          .expect(400);
        expect(err.body).toMatchObject({
          statusCode: 400,
          error: "Bad Request",
          message: "No executables",
        });
      });
    });

    describe("streaming disk storage (multipart.diskStorageDir)", () => {
      itAdapted(
        ["ADR-001", "ADR-004"],
        "should stream files directly to diskStorageDir without RAM buffering",
        async () => {
          const res = await request(diskApp)
            .post("/disk")
            .attach("docs", text("on disk"), txt("d.txt"))
            .expect(201);

          expect(res.body.files).toHaveLength(1);
          expect(res.body.files[0]).toMatchObject({
            fieldname: "docs",
            originalname: "d.txt",
            size: 7,
            onDisk: true,
          });
          const savedName: string = res.body.files[0].filename;
          expect(savedName).toMatch(/\.txt$/);
          expect(readTextSync(join(diskDir, savedName))).toBe("on disk");
          await removePath(join(diskDir, savedName));
        },
        "Bunest streaming disk storage uses UUID + safe extension via Bun.file().writer()",
      );

      it("should remove already written files when a later file exceeds maxFileSize", async () => {
        const res = await request(diskApp)
          .post("/disk")
          .attach("docs", text("fine"), txt("1.txt"))
          .attach("docs", text("fine too"), txt("2.txt"))
          .attach("docs", text("way past ten bytes"), txt("3.txt"))
          .expect(413);
        expect(res.body.statusCode).toBe(413);
        expect(readDirSyncNames(diskDir)).toEqual([]);
      });

      it("should remove the stored files when a downstream pipe rejects the request", async () => {
        const res = await request(diskApp)
          .post("/disk-validated")
          .field("count", "not a number")
          .attach("docs", text("fine"), txt("1.txt"))
          .attach("docs", text("fine too"), txt("2.txt"))
          .expect(400);
        expect(res.body.statusCode).toBe(400);
        await waitForCondition(() => {
          expect(readDirSyncNames(diskDir)).toEqual([]);
        });
      });

      it("should remove partial files when the client disconnects mid-upload", async () => {
        const port = Number(new URL(diskApp.getUrl()!).port);
        const socket = await Bun.connect({
          hostname: "127.0.0.1",
          port,
          socket: {
            data() {},
            error() {},
          },
        });
        const boundary = "----nestboundary";
        socket.write(
          `POST /disk HTTP/1.1\r\nHost: 127.0.0.1\r\n` +
            `Content-Type: multipart/form-data; boundary=${boundary}\r\n` +
            "Content-Length: 1000000\r\n\r\n" +
            `--${boundary}\r\n` +
            'Content-Disposition: form-data; name="docs"; filename="a.bin"\r\n' +
            "Content-Type: application/octet-stream\r\n\r\npart",
        );
        try {
          await waitForCondition(() =>
            expect(readDirSyncNames(diskDir)).toHaveLength(1),
          );
        } finally {
          socket.terminate();
        }
        await waitForCondition(() =>
          expect(readDirSyncNames(diskDir)).toEqual([]),
        );
      });
    });

    describe("streaming upload hashing (file.stream())", () => {
      const payload = Buffer.alloc(48 * 1024, "nest");
      const expectedHash = new Bun.CryptoHasher("sha256")
        .update(payload)
        .digest("hex");

      it("should produce the exact SHA-256 hash when streaming uploaded file bytes", async () => {
        const res = await request(hashLimitedApp)
          .post("/hash")
          .field("purpose", "backup")
          .attach("upload", payload, {
            filename: "blob.bin",
            contentType: "application/octet-stream",
          })
          .expect(201);
        expect(res.body).toEqual({
          hash: expectedHash,
          size: payload.length,
          originalname: "blob.bin",
          body: { purpose: "backup" },
        });
      });

      it("should reject a file over maxFileSize (64KB)", async () => {
        const big = Buffer.alloc(64 * 1024 + 1);
        const res = await request(hashLimitedApp)
          .post("/hash")
          .attach("upload", big, {
            filename: "big.bin",
            contentType: "application/octet-stream",
          })
          .expect(413);
        expect(res.body.statusCode).toBe(413);
      });

      it("should reject a file over maxFileSize within the first chunk", async () => {
        const res = await request(hashSmallApp)
          .post("/hash")
          .attach("upload", text("0123456789"), {
            filename: "small.bin",
            contentType: "application/octet-stream",
          })
          .expect(413);
        expect(res.body.statusCode).toBe(413);
      });

      it("should reject a file in another field", async () => {
        const res = await request(hashLimitedApp)
          .post("/hash")
          .attach("nope", text("x"), txt("x.txt"))
          .expect(400);
        expect(res.body.message).toBe("Unexpected file field - nope");
      });
    });
  },
);
