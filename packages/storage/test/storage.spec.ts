import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Module,
  NotFoundException,
  UnsupportedMediaTypeException,
} from "@bunest/common";
import { BunestFactory } from "@bunest/core";
import { HttpResponseContext } from "@bunest/http";
import {
  detectContentType,
  getDiskToken,
  InjectDisk,
  InMemoryDisk,
  LocalDisk,
  receiveSignedUpload,
  S3Disk,
  serveFile,
  serveSignedUrl,
  Storage,
  StorageBodyLengthError,
  StorageDisk,
  StorageFileNotFoundError,
  StorageInvalidKeyError,
  StorageKeyConflictError,
  StorageModule,
  StorageRangeNotSatisfiableError,
  StorageServiceError,
  StorageSignedUrlError,
  uploadToDisk,
} from "../src/index";

const SIGNING_KEY_1 = "a".repeat(40);
const SIGNING_KEY_2 = "b".repeat(40);

describe("@bunest/storage", () => {
  describe("InMemoryDisk", () => {
    it("performs full CRUD, metadata, ranges, listing, copy, move, and URL signing", async () => {
      const disk = new InMemoryDisk({
        publicUrl: "https://cdn.example.com/assets",
        signedUrls: {
          baseUrl: "https://api.example.com/files",
          keys: [SIGNING_KEY_1, SIGNING_KEY_2],
        },
      });

      const writeRes = await disk.put("docs/hello.txt", "Hello Bunest Storage!", {
        cacheControl: "public, max-age=60",
        metadata: { Author: "tester" },
      });
      expect(writeRes.key).toBe("docs/hello.txt");
      expect(writeRes.size).toBe(21);
      expect(writeRes.contentType).toBe("text/plain; charset=utf-8");
      expect(writeRes.etag).toBeDefined();

      expect(await disk.exists("docs/hello.txt")).toBe(true);
      expect(await disk.exists("docs/missing.txt")).toBe(false);
      expect(await disk.getText("docs/hello.txt")).toBe("Hello Bunest Storage!");

      const stat = await disk.stat("docs/hello.txt");
      expect(stat.metadata.author).toBe("tester");
      expect(stat.cacheControl).toBe("public, max-age=60");

      // Ranges
      const partial = await disk.get("docs/hello.txt", {
        range: { start: 6, end: 11 },
      });
      expect(partial.range).toEqual({ start: 6, end: 11 });
      const chunks: Buffer[] = [];
      for await (const c of partial.body) chunks.push(Buffer.from(c));
      expect(Buffer.concat(chunks).toString("utf8")).toBe("Bunest");

      const suffix = await disk.get("docs/hello.txt", {
        range: { suffix: 8 },
      });
      const sufChunks: Buffer[] = [];
      for await (const c of suffix.body) sufChunks.push(Buffer.from(c));
      expect(Buffer.concat(sufChunks).toString("utf8")).toBe("Storage!");

      await expect(
        disk.get("docs/hello.txt", { range: { start: 999 } }),
      ).rejects.toBeInstanceOf(StorageRangeNotSatisfiableError);

      // Copy & move
      await disk.copy("docs/hello.txt", "docs/copy.txt");
      expect(await disk.getText("docs/copy.txt")).toBe("Hello Bunest Storage!");
      await disk.move("docs/copy.txt", "docs/moved.txt");
      expect(await disk.exists("docs/copy.txt")).toBe(false);
      expect(await disk.exists("docs/moved.txt")).toBe(true);

      // Listing with pagination
      await disk.put("docs/a.txt", "a");
      const page1 = await disk.list({ prefix: "docs/", limit: 2 });
      expect(page1.entries.map((e) => e.key)).toEqual([
        "docs/a.txt",
        "docs/hello.txt",
      ]);
      expect(page1.cursor).toBeDefined();

      const allKeys: string[] = [];
      for await (const entry of disk.listAll({ prefix: "docs/", limit: 1 })) {
        allKeys.push(entry.key);
      }
      expect(allKeys).toEqual(["docs/a.txt", "docs/hello.txt", "docs/moved.txt"]);

      // Public URL & Signed URLs + key rotation
      expect(disk.url("docs/hello.txt")).toBe(
        "https://cdn.example.com/assets/docs/hello.txt",
      );
      const signedGet = await disk.signedUrl("docs/hello.txt", {
        expiresIn: "5m",
        filename: "download.txt",
      });
      const claims = disk.verifySignedUrl(signedGet, "GET");
      expect(claims.key).toBe("docs/hello.txt");
      expect(claims.method).toBe("GET");
      expect(claims.contentDisposition).toContain('filename="download.txt"');

      // Wrong method rejected
      expect(() => disk.verifySignedUrl(signedGet, "PUT")).toThrow(
        StorageSignedUrlError,
      );

      // Key rotation verification (signed by old key still verifies)
      const oldDisk = new InMemoryDisk({
        signedUrls: {
          baseUrl: "https://api.example.com/files",
          keys: [SIGNING_KEY_2],
        },
      });
      const oldUrl = await oldDisk.signedUrl("docs/hello.txt");
      expect(disk.verifySignedUrl(oldUrl, "GET").key).toBe("docs/hello.txt");

      // Tampered URL rejected
      expect(() =>
        disk.verifySignedUrl(signedGet.replace("hello.txt", "evil.txt"), "GET"),
      ).toThrow(StorageSignedUrlError);

      // Body length validation
      await expect(
        disk.put("docs/len.txt", "short", { contentLength: 100 }),
      ).rejects.toBeInstanceOf(StorageBodyLengthError);
      expect(await disk.exists("docs/len.txt")).toBe(false);

      // Key validation
      for (const bad of ["", "/abs", "a/../b", "a\\b", "a//b", "bad\x00key"]) {
        await expect(disk.put(bad, "x")).rejects.toBeInstanceOf(
          StorageInvalidKeyError,
        );
      }

      // Delete & clear
      await disk.delete(["docs/a.txt", "docs/missing.txt"]);
      expect(disk.keys()).toEqual(["docs/hello.txt", "docs/moved.txt"]);
      disk.clear();
      expect(disk.keys()).toEqual([]);
    });
  });

  describe("LocalDisk", () => {
    it("supports atomic writes, sidecar metadata, ranges, pruning, and security confinement", async () => {
      const dir = await mkdtemp(join(tmpdir(), "bunest-storage-test-"));
      try {
        const disk = new LocalDisk({ root: dir });
        await disk.put("nested/dir/report.bin", Buffer.from("0123456789"), {
          contentType: "application/x-custom",
          cacheControl: "no-store",
          metadata: { env: "test" },
        });

        const stat = await disk.stat("nested/dir/report.bin");
        expect(stat.size).toBe(10);
        expect(stat.contentType).toBe("application/x-custom");
        expect(stat.cacheControl).toBe("no-store");
        expect(stat.metadata.env).toBe("test");
        expect(disk.path("nested/dir/report.bin")).toContain("report.bin");

        const dl = await disk.get("nested/dir/report.bin", {
          range: { start: 2, end: 5 },
        });
        const chunks: Buffer[] = [];
        for await (const c of dl.body) chunks.push(Buffer.from(c));
        expect(Buffer.concat(chunks).toString("utf8")).toBe("2345");

        // Key conflict: cannot write file where non-empty directory exists or under file
        await expect(
          disk.put("nested/dir/report.bin/child", "x"),
        ).rejects.toBeInstanceOf(StorageKeyConflictError);

        // Reserved dir & NTFS ADS blocked
        await expect(
          disk.put(".nest-storage/secret", "x"),
        ).rejects.toBeInstanceOf(StorageInvalidKeyError);
        await expect(
          disk.put("file.txt:ads", "x"),
        ).rejects.toBeInstanceOf(StorageInvalidKeyError);

        // Copy, move, list, delete
        await disk.copy("nested/dir/report.bin", "copied/report.bin");
        expect(await disk.getText("copied/report.bin")).toBe("0123456789");
        await disk.move("copied/report.bin", "moved/report.bin");
        expect(await disk.exists("copied/report.bin")).toBe(false);

        const listed = await disk.list();
        expect(listed.entries.map((e) => e.key)).toEqual([
          "moved/report.bin",
          "nested/dir/report.bin",
        ]);

        await disk.delete(["moved/report.bin", "nested/dir/report.bin"]);
        expect((await disk.list()).entries).toEqual([]);
        await expect(disk.stat("moved/report.bin")).rejects.toBeInstanceOf(
          StorageFileNotFoundError,
        );

        // Symlink confinement test (skip gracefully if Windows lacks symlink privilege)
        const outsideFile = join(tmpdir(), `bunest-outside-${Date.now()}.txt`);
        await writeFile(outsideFile, "secret");
        try {
          await symlink(outsideFile, join(dir, "escape.txt"));
          await expect(disk.getText("escape.txt")).rejects.toBeInstanceOf(
            StorageInvalidKeyError,
          );
        } catch {
          // Windows without developer mode may throw EPERM creating symlinks
        } finally {
          await rm(outsideFile, { force: true });
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe("S3Disk (native SigV4 fetch)", () => {
    it("signs requests with AWS SigV4, handles CRUD/list/delete/presign and retries", async () => {
      const calls: Array<{ method: string; url: string; headers: Headers }> = [];
      let failOnce = true;

      const mockFetch: typeof globalThis.fetch = (async (
        input: string | URL | Request,
        init?: RequestInit,
      ) => {
        const urlStr = typeof input === "string" ? input : input.toString();
        const method = (init?.method ?? "GET").toUpperCase();
        const headers = new Headers(init?.headers);
        calls.push({ method, url: urlStr, headers });

        expect(headers.get("authorization")).toMatch(
          /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/\d{8}\/auto\/s3\/aws4_request/,
        );
        expect(headers.get("x-amz-date")).toMatch(/^\d{8}T\d{6}Z$/);
        expect(headers.get("x-amz-content-sha256")).toBeTruthy();

        if (method === "PUT" && failOnce) {
          failOnce = false;
          return new Response(
            "<Error><Code>SlowDown</Code><Message>Retry</Message></Error>",
            { status: 503 },
          );
        }
        if (method === "PUT") {
          return new Response(null, {
            status: 200,
            headers: { etag: '"abc123"' },
          });
        }
        if (method === "GET" && urlStr.includes("list-type=2")) {
          return new Response(
            `<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>app/hello.txt</Key><Size>5</Size><LastModified>2026-01-01T00:00:00.000Z</LastModified><ETag>"abc123"</ETag></Contents></ListBucketResult>`,
            { status: 200, headers: { "content-type": "application/xml" } },
          );
        }
        if (method === "GET") {
          return new Response("hello", {
            status: 200,
            headers: {
              "content-type": "text/plain",
              "content-length": "5",
              etag: '"abc123"',
              "x-amz-meta-owner": "bunest",
            },
          });
        }
        if (method === "HEAD") {
          return new Response(null, {
            status: 404,
          });
        }
        if (method === "POST" && urlStr.includes("delete=")) {
          return new Response("<DeleteResult></DeleteResult>", { status: 200 });
        }
        return new Response(null, { status: 204 });
      }) as typeof globalThis.fetch;

      const s3 = new S3Disk({
        bucket: "my-bucket",
        region: "auto",
        endpoint: "https://r2.example.com",
        forcePathStyle: true,
        prefix: "app/",
        credentials: {
          accessKeyId: "AKIAEXAMPLE",
          secretAccessKey: "secret-key-value",
        },
        retry: { attempts: 2, backoff: { delay: 1, jitter: "none" } },
        fetch: mockFetch,
      });

      const putRes = await s3.put("hello.txt", "hello");
      expect(putRes.etag).toBe('"abc123"');
      expect(calls.length).toBe(2); // 1 failed 503 + 1 retry

      expect(await s3.getText("hello.txt")).toBe("hello");
      const list = await s3.list();
      expect(list.entries.map((e) => e.key)).toEqual(["hello.txt"]);

      expect(await s3.exists("missing.txt")).toBe(false);
      await s3.delete(["a.txt", "b.txt"]);

      const signedGet = await s3.signedUrl("hello.txt", { expiresIn: "10m" });
      expect(signedGet).toContain("X-Amz-Algorithm=AWS4-HMAC-SHA256");
      expect(signedGet).toContain("X-Amz-Signature=");

      const signedPut = await s3.signedUpload("upload.png", {
        contentType: "image/png",
        contentLength: 1024,
      });
      expect(signedPut.method).toBe("PUT");
      expect(signedPut.url).toContain("X-Amz-Signature=");
      expect(signedPut.headers["Content-Type"]).toBe("image/png");

      // Non-retryable 403 maps to StorageServiceError
      const failingS3 = new S3Disk({
        bucket: "my-bucket",
        credentials: { accessKeyId: "AKIA", secretAccessKey: "SECRET" },
        retry: false,
        fetch: (async () =>
          new Response(
            "<Error><Code>AccessDenied</Code><Message>Denied</Message></Error>",
            { status: 403 },
          )) as unknown as typeof globalThis.fetch,
      });
      await expect(failingS3.put("x.txt", "x")).rejects.toBeInstanceOf(
        StorageServiceError,
      );
    });
  });

  describe("detectContentType & HTTP Helpers", () => {
    it("sniffs JPEG, PNG, GIF, WebP, PDF, AVIF, and HEIC magic bytes", () => {
      expect(detectContentType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(
        "image/jpeg",
      );
      expect(
        detectContentType(
          new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        ),
      ).toBe("image/png");
      expect(detectContentType(Buffer.from("GIF89a......"))).toBe("image/gif");
      expect(detectContentType(Buffer.from("RIFF1234WEBP...."))).toBe(
        "image/webp",
      );
      expect(detectContentType(Buffer.from("%PDF-1.7\n"))).toBe(
        "application/pdf",
      );
      expect(
        detectContentType(Buffer.from("\x00\x00\x00\x1cftypavif\x00\x00\x00\x00")),
      ).toBe("image/avif");
      expect(
        detectContentType(Buffer.from("\x00\x00\x00\x1cftypheic\x00\x00\x00\x00")),
      ).toBe("image/heic");
      expect(detectContentType(Buffer.from("<html><script>alert(1)</script>"))).toBeUndefined();
    });

    it("serves files with Range (206), ETag (304), signed URLs, signed uploads, and uploadToDisk", async () => {
      const disk = new InMemoryDisk({
        signedUrls: {
          baseUrl: "https://api.example.com/files",
          keys: [SIGNING_KEY_1],
        },
      });
      const written = await disk.put("page.html", "<h1>Hi</h1>");

      // Inline HTML forced to attachment for XSS safety
      const res1 = new HttpResponseContext();
      const sf1 = await serveFile(disk, "page.html", {
        res: res1,
        disposition: "inline",
      });
      expect(sf1).toBeDefined();
      expect(res1.getHeader("Content-Disposition")).toContain("attachment;");
      expect(res1.getHeader("X-Content-Type-Options")).toBe("nosniff");

      // If-None-Match -> 304
      const res304 = new HttpResponseContext();
      const sf304 = await serveFile(disk, "page.html", {
        req: new Request("https://api.example.com/page.html", {
          headers: { "if-none-match": written.etag! },
        }),
        res: res304,
      });
      expect(sf304).toBeUndefined();
      expect(res304.getStatus()).toBe(304);

      // Range -> 206
      const res206 = new HttpResponseContext();
      const sf206 = await serveFile(disk, "page.html", {
        req: new Request("https://api.example.com/page.html", {
          headers: { range: "bytes=0-3" },
        }),
        res: res206,
      });
      expect(sf206).toBeDefined();
      expect(res206.getStatus()).toBe(206);
      expect(res206.getHeader("Content-Range")).toBe("bytes 0-3/11");

      // Missing -> 404 NotFoundException
      await expect(
        serveFile(disk, "nope.txt", { res: new HttpResponseContext() }),
      ).rejects.toBeInstanceOf(NotFoundException);

      // Signed download
      const signedGetUrl = await disk.signedUrl("page.html");
      const resSigned = new HttpResponseContext();
      const sfSigned = await serveSignedUrl(disk, {
        req: new Request(signedGetUrl),
        res: resSigned,
      });
      expect(sfSigned).toBeDefined();

      // Signed upload
      const signedPut = await disk.signedUpload("incoming.txt", {
        contentType: "text/plain",
        contentLength: 5,
      });
      const uploadRes = new HttpResponseContext();
      const uploaded = await receiveSignedUpload(disk, {
        req: new Request(signedPut.url, {
          method: "PUT",
          headers: { "content-type": "text/plain", "content-length": "5" },
          body: "hello",
        }),
        res: uploadRes,
      });
      expect(uploaded.key).toBe("incoming.txt");
      expect(await disk.getText("incoming.txt")).toBe("hello");

      // Wrong content-type -> 403
      await expect(
        receiveSignedUpload(disk, {
          req: new Request(signedPut.url, {
            method: "PUT",
            headers: { "content-type": "text/html", "content-length": "5" },
            body: "hello",
          }),
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);

      // Wrong length -> 400
      await expect(
        receiveSignedUpload(disk, {
          req: new Request(signedPut.url, {
            method: "PUT",
            headers: { "content-type": "text/plain", "content-length": "3" },
            body: "abc",
          }),
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      // uploadToDisk engine with magic-byte enforcement
      const pngBytes = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0,
      ]);
      const engine = uploadToDisk({
        disk,
        contentTypes: ["image/png"],
        key: (info) => `uploads/avatar${info.extension}`,
      });

      const storedInfo = await new Promise<any>((resolve, reject) => {
        engine._handleFile(
          {},
          {
            fieldname: "avatar",
            originalname: "evil.html",
            mimetype: "text/html",
            stream: Readable.from([pngBytes]),
          },
          (err, info) => (err ? reject(err) : resolve(info)),
        );
      });
      expect(storedInfo.key).toBe("uploads/avatar.png");
      expect(storedInfo.contentType).toBe("image/png");
      expect(await disk.exists("uploads/avatar.png")).toBe(true);

      // Spoofed PNG carrying HTML is rejected with 415 before writing
      await expect(
        new Promise((resolve, reject) => {
          engine._handleFile(
            {},
            {
              fieldname: "avatar",
              originalname: "pic.png",
              mimetype: "image/png",
              stream: Readable.from([Buffer.from("<script>alert(1)</script>")]),
            },
            (err, info) => (err ? reject(err) : resolve(info)),
          );
        }),
      ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);

      // _removeFile cleans up stored key
      await new Promise<void>((resolve, reject) => {
        engine._removeFile({}, { key: storedInfo.key }, (err) =>
          err ? reject(err) : resolve(),
        );
      });
      expect(await disk.exists("uploads/avatar.png")).toBe(false);
    });
  });

  describe("StorageModule DI integration", () => {
    it("injects default StorageDisk, named @InjectDisk, Storage service, and closes on shutdown", async () => {
      let closedCount = 0;
      class TrackedDisk extends InMemoryDisk {
        override async close(): Promise<void> {
          closedCount++;
        }
      }

      const mainDisk = new TrackedDisk();
      const archiveDisk = new TrackedDisk();

      @Injectable()
      class FileConsumer {
        constructor(
          readonly storage: Storage,
          readonly defaultDisk: StorageDisk,
          @InjectDisk("archive") readonly archive: StorageDisk,
        ) {}
      }

      @Module({
        imports: [
          StorageModule.forRoot({
            default: "main",
            disks: { main: mainDisk, archive: archiveDisk },
          }),
        ],
        providers: [FileConsumer],
        exports: [FileConsumer],
      })
      class AppModule {}

      const app = await BunestFactory.createApplicationContext(AppModule, {
        logger: false,
      });
      const consumer = app.get(FileConsumer);
      expect(consumer.storage.defaultDisk).toBe("main");
      expect(consumer.storage.names()).toEqual(["main", "archive"]);
      expect(consumer.defaultDisk).toBe(mainDisk);
      expect(consumer.archive).toBe(archiveDisk);
      expect(app.get(getDiskToken("archive"))).toBe(archiveDisk);

      await consumer.archive.put("item.txt", "archived");
      expect(await archiveDisk.getText("item.txt")).toBe("archived");

      await app.close();
      expect(closedCount).toBe(2);
    });

    it("supports StorageModule.forRootAsync with useFactory", async () => {
      const mem = new InMemoryDisk();

      @Module({
        imports: [
          StorageModule.forRootAsync({
            useFactory: async () => ({
              disks: { memory: mem },
            }),
          }),
        ],
      })
      class AsyncAppModule {}

      const app = await BunestFactory.createApplicationContext(AsyncAppModule, {
        logger: false,
      });
      const storage = app.get(Storage);
      expect(storage.disk()).toBe(mem);
      expect(storage.disk("memory")).toBe(mem);
      await app.close();
    });
  });
});
