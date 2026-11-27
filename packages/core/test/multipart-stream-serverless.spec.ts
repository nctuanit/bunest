import { afterEach, describe, expect, it } from "bun:test";
import {
  Body,
  BunestFactory,
  Controller,
  FileInterceptor,
  FilesInterceptor,
  Get,
  Injectable,
  Module,
  PayloadTooLargeException,
  Post,
  UnsupportedMediaTypeException,
  UploadedFile,
  UploadedFileStream,
  UploadedFiles,
  UseInterceptors,
  createBunestServer,
  createFetchHandler,
  ensureDir,
  join,
  parseMultipartStream,
  removePath,
  type DiskUploadedFileInfo,
  type OnModuleDestroy,
  type OnModuleInit,
  type StoredUploadedFile,
  type UploadStorageEngineLike,
  type UploadedFileInfo,
} from "../src/index";

function buildMultipartBytes(
  boundary: string,
  parts: Array<
    | { readonly name: string; readonly value: string }
    | {
        readonly name: string;
        readonly filename: string;
        readonly contentType?: string;
        readonly data: Uint8Array | string;
      }
  >,
): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];

  for (const part of parts) {
    chunks.push(enc.encode(`--${boundary}\r\n`));
    if ("filename" in part) {
      chunks.push(
        enc.encode(
          `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n`,
        ),
      );
      if (part.contentType) {
        chunks.push(enc.encode(`Content-Type: ${part.contentType}\r\n`));
      }
      chunks.push(enc.encode("\r\n"));
      chunks.push(
        typeof part.data === "string" ? enc.encode(part.data) : part.data,
      );
      chunks.push(enc.encode("\r\n"));
    } else {
      chunks.push(
        enc.encode(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n`),
      );
      chunks.push(enc.encode(`${part.value}\r\n`));
    }
  }
  chunks.push(enc.encode(`--${boundary}--\r\n`));

  const total = chunks.reduce((acc, c) => acc + c.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

function streamFromChunks(
  bytes: Uint8Array,
  chunkSize: number,
  onPull?: (chunkIndex: number) => void,
): ReadableStream<Uint8Array> {
  let offset = 0;
  let chunkIndex = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(bytes.byteLength, offset + chunkSize);
      const slice = bytes.slice(offset, end);
      offset = end;
      onPull?.(chunkIndex++);
      controller.enqueue(slice);
    },
  });
}

async function readAllBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

describe("Zero-Buffer Streaming Multipart, FileInterceptor & Serverless Single-Flight", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await removePath(dir, { recursive: true, force: true });
    }
  });

  it("parseMultipartStream handles 1-byte chunks, empty files, skipped files, and true pull-based backpressure", async () => {
    const boundary = "----BunestTestBoundary123";
    const payload = buildMultipartBytes(boundary, [
      { name: "title", value: "hello world" },
      {
        name: "empty",
        filename: "empty.txt",
        contentType: "text/plain",
        data: "",
      },
      {
        name: "skipme",
        filename: "skip.bin",
        contentType: "application/octet-stream",
        data: "this-should-be-drained-automatically",
      },
      {
        name: "doc",
        filename: "report.txt",
        contentType: "text/plain",
        data: "Streaming body content across boundaries!",
      },
    ]);

    // 1-byte chunks stress-test boundary splitting across every byte
    const req1 = new Request("http://localhost/upload", {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body: streamFromChunks(payload, 1),
    });

    const parsed: Array<Record<string, unknown>> = [];
    for await (const part of parseMultipartStream(req1)) {
      if (part.kind === "field") {
        parsed.push({ kind: "field", fieldname: part.fieldname, value: part.value });
      } else if (part.fieldname === "skipme") {
        // Deliberately skip reading `part.stream` to verify automatic constant-RAM drain
        parsed.push({ kind: "skipped", fieldname: part.fieldname });
      } else {
        const bytes = await readAllBytes(part.stream);
        parsed.push({
          kind: "file",
          fieldname: part.fieldname,
          originalname: part.originalname,
          size: part.bytesRead,
          text: new TextDecoder().decode(bytes),
        });
      }
    }

    expect(parsed).toEqual([
      { kind: "field", fieldname: "title", value: "hello world" },
      { kind: "file", fieldname: "empty", originalname: "empty.txt", size: 0, text: "" },
      { kind: "skipped", fieldname: "skipme" },
      {
        kind: "file",
        fieldname: "doc",
        originalname: "report.txt",
        size: 41,
        text: "Streaming body content across boundaries!",
      },
    ]);

    // Live backpressure test: 1 MiB file in 16 KiB chunks — source pull only advances as consumer reads!
    const largeData = new Uint8Array(1024 * 1024);
    for (let i = 0; i < largeData.length; i++) {
      largeData[i] = i & 0xff;
    }
    const largePayload = buildMultipartBytes(boundary, [
      {
        name: "big",
        filename: "big.bin",
        contentType: "application/octet-stream",
        data: largeData,
      },
    ]);

    let sourcePulls = 0;
    const reqBackpressure = new Request("http://localhost/upload", {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body: streamFromChunks(largePayload, 16 * 1024, () => {
        sourcePulls++;
      }),
    });

    for await (const part of parseMultipartStream(reqBackpressure)) {
      expect(part.kind).toBe("file");
      if (part.kind === "file") {
        // Before reading from `part.stream`, only the first header chunk was pulled!
        expect(sourcePulls).toBeLessThanOrEqual(2);
        const reader = part.stream.getReader();
        const first = await reader.read();
        expect(first.done).toBe(false);
        // Still nowhere near the 64+ chunks of the 1 MiB stream!
        expect(sourcePulls).toBeLessThan(6);

        let total = first.value!.byteLength;
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          total += next.value!.byteLength;
        }
        reader.releaseLock();
        expect(total).toBe(1024 * 1024);
        expect(part.bytesRead).toBe(1024 * 1024);
      }
    }
  });

  it("parseMultipartStream enforces maxFileSize, maxFiles, maxFields, and allowedMimeTypes", async () => {
    const boundary = "----LimitBoundary";

    // maxFileSize
    const oversizePayload = buildMultipartBytes(boundary, [
      { name: "f", filename: "big.txt", contentType: "text/plain", data: "0123456789ABCDEF" },
    ]);
    const oversizeReq = new Request("http://localhost/u", {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body: streamFromChunks(oversizePayload, 4),
    });
    let truncatedFlag = false;
    await expect(
      (async () => {
        for await (const part of parseMultipartStream(oversizeReq, { maxFileSize: 8 })) {
          if (part.kind === "file") {
            try {
              await readAllBytes(part.stream);
            } catch (err) {
              truncatedFlag = part.truncated;
              throw err;
            }
          }
        }
      })(),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
    expect(truncatedFlag).toBe(true);

    // maxFiles
    const twoFilesPayload = buildMultipartBytes(boundary, [
      { name: "a", filename: "a.txt", contentType: "text/plain", data: "a" },
      { name: "b", filename: "b.txt", contentType: "text/plain", data: "b" },
    ]);
    const maxFilesReq = new Request("http://localhost/u", {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body: twoFilesPayload,
    });
    await expect(
      (async () => {
        for await (const _ of parseMultipartStream(maxFilesReq, { maxFiles: 1 })) {
          // iterate
        }
      })(),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);

    // maxFields
    const twoFieldsPayload = buildMultipartBytes(boundary, [
      { name: "k1", value: "v1" },
      { name: "k2", value: "v2" },
    ]);
    const maxFieldsReq = new Request("http://localhost/u", {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body: twoFieldsPayload,
    });
    await expect(
      (async () => {
        for await (const _ of parseMultipartStream(maxFieldsReq, { maxFields: 1 })) {
          // iterate
        }
      })(),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);

    // allowedMimeTypes (wildcard & exact)
    const badMimePayload = buildMultipartBytes(boundary, [
      { name: "a", filename: "script.js", contentType: "application/javascript", data: "alert(1)" },
    ]);
    const badMimeReq = new Request("http://localhost/u", {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body: badMimePayload,
    });
    await expect(
      (async () => {
        for await (const _ of parseMultipartStream(badMimeReq, {
          allowedMimeTypes: ["image/*", "text/plain"],
        })) {
          // iterate
        }
      })(),
    ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
  });

  it("FileInterceptor & FilesInterceptor support stream, memory, disk, and callback/async UploadStorageEngine modes", async () => {
    const tmpBase = Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp";
    const diskDir = join(tmpBase, `bunest-disk-upload-${crypto.randomUUID()}`);
    tempDirs.push(diskDir);
    await ensureDir(diskDir);

    const removedKeys: string[] = [];
    const callbackStorage: UploadStorageEngineLike = {
      _handleFile(_req, file, cb) {
        void (async () => {
          try {
            const f = file as { originalname: string; stream: ReadableStream<Uint8Array> };
            const bytes = await readAllBytes(f.stream);
            cb(null, {
              key: `stored/${f.originalname}`,
              size: bytes.byteLength,
              contentType: "text/plain",
            });
          } catch (err) {
            cb(err);
          }
        })();
      },
      _removeFile(_req, file, cb) {
        const key = (file as { key?: string }).key;
        if (key) removedKeys.push(key);
        cb(null);
      },
    };

    const asyncStorage: UploadStorageEngineLike = {
      async handleFile(_req, file) {
        const bytes = await readAllBytes(file.stream);
        return {
          key: `async/${file.originalname}`,
          size: bytes.byteLength,
          sha: new TextDecoder().decode(bytes),
        };
      },
    };

    @Controller("uploads")
    class UploadController {
      @Post("stream")
      @UseInterceptors(FileInterceptor("avatar", { mode: "stream" }))
      async uploadStream(
        @UploadedFileStream() file: { originalname: string; stream: ReadableStream<Uint8Array>; bytesRead: number },
        @Body() fields: Record<string, string>,
      ) {
        const bytes = await readAllBytes(file.stream);
        return {
          name: file.originalname,
          size: bytes.byteLength,
          bytesRead: file.bytesRead,
          text: new TextDecoder().decode(bytes),
          note: fields.note,
        };
      }

      @Post("memory")
      @UseInterceptors(FileInterceptor("doc", { mode: "memory", maxFileSize: 1024 }))
      uploadMemory(@UploadedFile() file: UploadedFileInfo, @Body() body: Record<string, string>) {
        return {
          name: file.originalname,
          size: file.size,
          text: new TextDecoder().decode(file.buffer),
          tag: body.tag,
        };
      }

      @Post("disk")
      @UseInterceptors(FileInterceptor("archive", { mode: "disk", dest: diskDir }))
      async uploadDisk(@UploadedFile() file: DiskUploadedFileInfo) {
        const filePath = file.path ?? "";
        const onDisk = await Bun.file(filePath).text();
        return { path: filePath, size: file.size, content: onDisk };
      }

      @Post("storage-cb")
      @UseInterceptors(FileInterceptor("asset", { storage: callbackStorage }))
      uploadStorageCb(@UploadedFile() file: StoredUploadedFile) {
        return { key: file.key, size: file.size };
      }

      @Post("storage-cb-fail")
      @UseInterceptors(FileInterceptor("asset", { storage: callbackStorage }))
      uploadStorageCbFail() {
        throw new Error("downstream handler failure");
      }

      @Post("storage-async")
      @UseInterceptors(FileInterceptor("asset", { storage: asyncStorage }))
      uploadStorageAsync(@UploadedFileStream() file: StoredUploadedFile) {
        return { key: file.key, size: file.size, sha: file.sha };
      }

      @Post("multi-stream")
      @UseInterceptors(FilesInterceptor("photos", 2, { mode: "stream" }))
      async uploadMultiStream(
        @UploadedFileStream() files: AsyncIterable<{ originalname: string; stream: ReadableStream<Uint8Array> }>,
      ) {
        const results: Array<{ name: string; content: string }> = [];
        for await (const f of files) {
          const bytes = await readAllBytes(f.stream);
          results.push({ name: f.originalname, content: new TextDecoder().decode(bytes) });
        }
        return { count: results.length, files: results };
      }

      @Post("multi-memory")
      @UseInterceptors(FilesInterceptor("photos", 2, { mode: "memory" }))
      uploadMultiMemory(@UploadedFiles() files: UploadedFileInfo[]) {
        return { count: files.length, names: files.map((f) => f.originalname) };
      }
    }

    @Module({ controllers: [UploadController] })
    class UploadModule {}

    const app = await BunestFactory.create(UploadModule, { logger: false });
    await app.init();

    try {
      const boundary = "----InterceptorBoundary";
      const makeReq = (path: string, parts: Parameters<typeof buildMultipartBytes>[1]) =>
        new Request(`http://localhost/uploads/${path}`, {
          method: "POST",
          headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
          body: streamFromChunks(buildMultipartBytes(boundary, parts), 12),
        });

      // mode: "stream"
      const rStream = await app.fetch(
        makeReq("stream", [
          { name: "note", value: "profile-pic" },
          { name: "avatar", filename: "me.txt", contentType: "text/plain", data: "live-stream-bytes" },
        ]),
      );
      expect(rStream.status).toBe(201);
      expect(await rStream.json()).toEqual({
        name: "me.txt",
        size: 17,
        bytesRead: 17,
        text: "live-stream-bytes",
        note: "profile-pic",
      });

      // mode: "memory"
      const rMem = await app.fetch(
        makeReq("memory", [
          { name: "tag", value: "v1" },
          { name: "doc", filename: "readme.md", contentType: "text/markdown", data: "# hello" },
        ]),
      );
      expect(rMem.status).toBe(201);
      expect(await rMem.json()).toEqual({
        name: "readme.md",
        size: 7,
        text: "# hello",
        tag: "v1",
      });

      // mode: "disk"
      const rDisk = await app.fetch(
        makeReq("disk", [
          { name: "archive", filename: "data.txt", contentType: "text/plain", data: "written-to-disk" },
        ]),
      );
      expect(rDisk.status).toBe(201);
      const diskBody = (await rDisk.json()) as { path: string; size: number; content: string };
      expect(diskBody.size).toBe(15);
      expect(diskBody.content).toBe("written-to-disk");
      expect(diskBody.path.startsWith(diskDir)).toBe(true);

      // callback storage engine (`@bunest/storage` `uploadToDisk()` contract)
      const rCb = await app.fetch(
        makeReq("storage-cb", [
          { name: "asset", filename: "logo.txt", contentType: "text/plain", data: "logo-data" },
        ]),
      );
      expect(rCb.status).toBe(201);
      expect(await rCb.json()).toEqual({ key: "stored/logo.txt", size: 9 });

      // callback storage rollback on downstream error
      const rCbFail = await app.fetch(
        makeReq("storage-cb-fail", [
          { name: "asset", filename: "orphan.txt", contentType: "text/plain", data: "rollback-me" },
        ]),
      );
      expect(rCbFail.status).toBe(500);
      expect(removedKeys).toContain("stored/orphan.txt");

      // async handleFile storage engine
      const rAsync = await app.fetch(
        makeReq("storage-async", [
          { name: "asset", filename: "async.txt", contentType: "text/plain", data: "async-ok" },
        ]),
      );
      expect(rAsync.status).toBe(201);
      expect(await rAsync.json()).toEqual({
        key: "async/async.txt",
        size: 8,
        sha: "async-ok",
      });

      // FilesInterceptor stream mode (2 files)
      const rMultiStream = await app.fetch(
        makeReq("multi-stream", [
          { name: "photos", filename: "1.txt", contentType: "text/plain", data: "one" },
          { name: "photos", filename: "2.txt", contentType: "text/plain", data: "two" },
        ]),
      );
      expect(rMultiStream.status).toBe(201);
      expect(await rMultiStream.json()).toEqual({
        count: 2,
        files: [
          { name: "1.txt", content: "one" },
          { name: "2.txt", content: "two" },
        ],
      });

      // FilesInterceptor maxCount exceeded -> 413
      const rTooMany = await app.fetch(
        makeReq("multi-memory", [
          { name: "photos", filename: "1.txt", contentType: "text/plain", data: "1" },
          { name: "photos", filename: "2.txt", contentType: "text/plain", data: "2" },
          { name: "photos", filename: "3.txt", contentType: "text/plain", data: "3" },
        ]),
      );
      expect(rTooMany.status).toBe(413);
    } finally {
      await app.close();
    }
  });

  it("BunestApplication.fetch(), createFetchHandler(), and createBunestServer() share a single-flight init across concurrent cold-start requests", async () => {
    let initCount = 0;
    let destroyCount = 0;

    @Injectable()
    class SlowInitService implements OnModuleInit, OnModuleDestroy {
      async onModuleInit() {
        initCount++;
        await Bun.sleep(25);
      }
      onModuleDestroy() {
        destroyCount++;
      }
    }

    @Controller("ping")
    class PingController {
      constructor(private readonly _svc: SlowInitService) {}

      @Get()
      ping() {
        return { pong: true, inits: initCount };
      }
    }

    @Module({
      controllers: [PingController],
      providers: [SlowInitService],
    })
    class ColdStartModule {}

    // 1. Direct BunestApplication.fetch() concurrent cold-start single-flight
    const app = await BunestFactory.create(ColdStartModule, { logger: false });
    try {
      const responses = await Promise.all(
        Array.from({ length: 15 }, () =>
          app.fetch(new Request("http://localhost/ping")),
        ),
      );
      expect(initCount).toBe(1);
      for (const res of responses) {
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ pong: true, inits: 1 });
      }
    } finally {
      await app.close();
    }
    expect(destroyCount).toBe(1);

    // 2. WinterTC createFetchHandler() single-flight + retry after failed init
    initCount = 0;
    destroyCount = 0;
    let configureCalls = 0;
    let failFirstConfigure = true;

    const handler = createFetchHandler(ColdStartModule, {
      logger: false,
      configure: async () => {
        configureCalls++;
        if (failFirstConfigure) {
          failFirstConfigure = false;
          throw new Error("transient bootstrap failure");
        }
      },
    });

    await expect(
      handler.fetch(new Request("http://localhost/ping")),
    ).rejects.toThrow("transient bootstrap failure");
    expect(configureCalls).toBe(1);
    expect(destroyCount).toBe(1); // failed bootstrap cleans up created app resources

    const concurrent = await Promise.all(
      Array.from({ length: 12 }, () =>
        handler.fetch(new Request("http://localhost/ping")),
      ),
    );
    expect(configureCalls).toBe(2);
    expect(initCount).toBe(1);
    for (const res of concurrent) {
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ pong: true, inits: 1 });
    }
    await handler.close();
    expect(destroyCount).toBe(2);

    // 3. createBunestServer() exposes WinterTC + Bun default export fields
    initCount = 0;
    const server = createBunestServer(ColdStartModule, {
      port: 4321,
      hostname: "127.0.0.1",
      logger: false,
    });
    expect(server.port).toBe(4321);
    expect(server.hostname).toBe("127.0.0.1");

    const srvResponses = await Promise.all(
      Array.from({ length: 8 }, () =>
        server.fetch(new Request("http://localhost/ping")),
      ),
    );
    expect(initCount).toBe(1);
    expect(srvResponses.every((r) => r.status === 200)).toBe(true);
    await server[Symbol.asyncDispose]();
  });
});
