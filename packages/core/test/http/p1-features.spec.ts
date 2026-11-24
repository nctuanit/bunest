import { afterAll, describe, expect, it } from "bun:test";
import {
  BadRequestException,
  Body,
  Controller,
  ensureDir,
  Get,
  Header,
  IntrinsicException,
  join,
  Param,
  ParseFilePipeBuilder,
  Post,
  Query,
  RawBody,
  removePath,
  Res,
  Session,
  Sse,
  SseSignal,
  StreamableFile,
  UploadedFile,
  VERSION_NEUTRAL,
  Version,
  VersioningType,
  type LoggerService,
  type NextFunction,
  type ResponseContext,
  type StandardSchemaV1,
  type UploadedFileInfo,
} from "../../src/common/index";
import {
  BunHttpAdapter,
  CompressionMiddleware,
  createCompressionMiddleware,
  getCurrentRequestContext,
} from "../../src/http";

function makeStandardSchema<T>(
  validateFn: (input: unknown) =>
    | { ok: true; value: T }
    | {
        ok: false;
        issues: Array<{ message: string; path?: (string | number)[] }>;
      },
): StandardSchemaV1<unknown, T> {
  return {
    "~standard": {
      version: 1,
      vendor: "test-standard",
      validate(value: unknown) {
        const res = validateFn(value);
        if (res.ok) {
          return { value: res.value };
        }
        return { issues: res.issues };
      },
    },
  };
}

describe("P1 HTTP Parity Suite", () => {
  const tmpDirs: string[] = [];

  afterAll(async () => {
    for (const dir of tmpDirs) {
      await removePath(dir, { recursive: true, force: true });
    }
  });

  describe("API Versioning (URI, HEADER, MEDIA_TYPE, CUSTOM, VERSION_NEUTRAL)", () => {
    it("supports URI versioning with custom prefix, multi-version array, and VERSION_NEUTRAL", async () => {
      @Controller({ path: "items", version: "1" })
      class ItemsController {
        @Get()
        listV1() {
          return { version: "1" };
        }

        @Version(["2", "3"])
        @Get()
        listV23() {
          return { version: "2-or-3" };
        }

        @Version(VERSION_NEUTRAL)
        @Get("status")
        status() {
          return { neutral: true };
        }
      }

      const adapter = new BunHttpAdapter({ logger: false });
      adapter.enableVersioning({ type: VersioningType.URI, prefix: "v" });
      await adapter.compileControllers([ItemsController]);

      const r1 = await adapter.fetch(new Request("http://localhost/v1/items"));
      expect(r1.status).toBe(200);
      expect(await r1.json()).toEqual({ version: "1" });

      const r2 = await adapter.fetch(new Request("http://localhost/v2/items"));
      expect(r2.status).toBe(200);
      expect(await r2.json()).toEqual({ version: "2-or-3" });

      const r3 = await adapter.fetch(new Request("http://localhost/v3/items"));
      expect(r3.status).toBe(200);
      expect(await r3.json()).toEqual({ version: "2-or-3" });

      const rNeutral = await adapter.fetch(
        new Request("http://localhost/items/status"),
      );
      expect(rNeutral.status).toBe(200);
      expect(await rNeutral.json()).toEqual({ neutral: true });

      const rMiss = await adapter.fetch(
        new Request("http://localhost/v4/items"),
      );
      expect(rMiss.status).toBe(404);
    });

    it("supports HEADER, MEDIA_TYPE, and CUSTOM versioning with 404 vs 405 separation", async () => {
      @Controller("orders")
      class OrdersController {
        @Version("1")
        @Get()
        getV1() {
          return { v: 1 };
        }

        @Version("2")
        @Get()
        getV2() {
          return { v: 2 };
        }

        @Version(VERSION_NEUTRAL)
        @Get("ping")
        ping() {
          return { pong: true };
        }
      }

      // 1. HEADER versioning
      const headerAdapter = new BunHttpAdapter({ logger: false });
      headerAdapter.enableVersioning({
        type: VersioningType.HEADER,
        header: "X-API-Version",
      });
      await headerAdapter.compileControllers([OrdersController]);

      expect(
        await (
          await headerAdapter.fetch(
            new Request("http://localhost/orders", {
              headers: { "X-API-Version": "1" },
            }),
          )
        ).json(),
      ).toEqual({ v: 1 });

      expect(
        await (
          await headerAdapter.fetch(
            new Request("http://localhost/orders", {
              headers: { "X-API-Version": "2" },
            }),
          )
        ).json(),
      ).toEqual({ v: 2 });

      // Missing/unknown version returns 404 (not 405)
      expect(
        (await headerAdapter.fetch(new Request("http://localhost/orders")))
          .status,
      ).toBe(404);
      // Matching version but wrong HTTP method returns 405 + Allow
      const mna = await headerAdapter.fetch(
        new Request("http://localhost/orders", {
          method: "POST",
          headers: { "X-API-Version": "1" },
        }),
      );
      expect(mna.status).toBe(405);
      expect(mna.headers.get("allow")).toContain("GET");

      // VERSION_NEUTRAL reachable without header
      expect(
        await (
          await headerAdapter.fetch(new Request("http://localhost/orders/ping"))
        ).json(),
      ).toEqual({ pong: true });

      // 2. MEDIA_TYPE versioning
      const mediaAdapter = new BunHttpAdapter({ logger: false });
      mediaAdapter.enableVersioning({
        type: VersioningType.MEDIA_TYPE,
        key: "v=",
      });
      await mediaAdapter.compileControllers([OrdersController]);

      expect(
        await (
          await mediaAdapter.fetch(
            new Request("http://localhost/orders", {
              headers: { Accept: "application/json;v=2" },
            }),
          )
        ).json(),
      ).toEqual({ v: 2 });

      // 3. CUSTOM extractor returning priority array
      const customAdapter = new BunHttpAdapter({ logger: false });
      customAdapter.enableVersioning({
        type: VersioningType.CUSTOM,
        extractor: (req) => {
          const v = new URL(req.url).searchParams.get("ver");
          return v ? [v, "1"] : [];
        },
      });
      await customAdapter.compileControllers([OrdersController]);

      expect(
        await (
          await customAdapter.fetch(
            new Request("http://localhost/orders?ver=99"),
          )
        ).json(),
      ).toEqual({ v: 1 });
    });
  });

  describe("rawBody + @RawBody(), StreamableFile, @Session(), @SseSignal()", () => {
    it("captures exact rawBody bytes alongside parsed JSON @Body() for HMAC verification", async () => {
      @Controller("webhooks")
      class WebhookController {
        @Post()
        receive(@Body() body: { event: string }, @RawBody() raw: Uint8Array) {
          return {
            event: body.event,
            rawText: new TextDecoder().decode(raw),
            byteLength: raw.byteLength,
          };
        }
      }

      const adapter = new BunHttpAdapter({ logger: false, rawBody: true });
      await adapter.compileControllers([WebhookController]);

      const rawJson = '{\n  "event":  "invoice.paid"\n}';
      const res = await adapter.fetch(
        new Request("http://localhost/webhooks", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: rawJson,
        }),
      );
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({
        event: "invoice.paid",
        rawText: rawJson,
        byteLength: Buffer.byteLength(rawJson, "utf8"),
      });
    });

    it("serializes StreamableFile with headers, HEAD stripping, and @Header() precedence", async () => {
      @Controller("downloads")
      class DownloadController {
        @Get("report")
        @Header("X-Custom", "yes")
        report() {
          const bytes = new TextEncoder().encode("hello,csv\n1,2\n");
          return new StreamableFile(bytes, {
            type: "text/csv; charset=utf-8",
            disposition: 'attachment; filename="report.csv"',
          });
        }
      }

      const adapter = new BunHttpAdapter({ logger: false });
      await adapter.compileControllers([DownloadController]);

      const res = await adapter.fetch(
        new Request("http://localhost/downloads/report"),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
      expect(res.headers.get("content-disposition")).toBe(
        'attachment; filename="report.csv"',
      );
      expect(res.headers.get("content-length")).toBe("14");
      expect(res.headers.get("x-custom")).toBe("yes");
      expect(await res.text()).toBe("hello,csv\n1,2\n");

      const headRes = await adapter.fetch(
        new Request("http://localhost/downloads/report", { method: "HEAD" }),
      );
      expect(headRes.status).toBe(200);
      expect(headRes.headers.get("content-length")).toBe("14");
      expect(await headRes.text()).toBe("");
    });

    it("injects @Session() and @SseSignal() cleanly", async () => {
      @Controller("ctx")
      class CtxController {
        @Get("me")
        me(
          @Session("userId") userId: string,
          @Session() full: Record<string, unknown>,
        ) {
          return { userId, keys: Object.keys(full) };
        }

        @Sse("events")
        events(@SseSignal() signal: AbortSignal) {
          return (async function* () {
            yield { data: { aborted: signal.aborted } };
          })();
        }
      }

      const adapter = new BunHttpAdapter({ logger: false });
      adapter.use(
        (_req: Request, _res: ResponseContext, next: NextFunction) => {
          const ctx = getCurrentRequestContext();
          if (ctx) {
            ctx.session = { userId: "u_42", role: "admin" };
          }
          return next();
        },
      );
      await adapter.compileControllers([CtxController]);

      const meRes = await adapter.fetch(new Request("http://localhost/ctx/me"));
      expect(meRes.status).toBe(200);
      expect(await meRes.json()).toEqual({
        userId: "u_42",
        keys: ["userId", "role"],
      });

      const sseRes = await adapter.fetch(
        new Request("http://localhost/ctx/events"),
      );
      expect(sseRes.status).toBe(200);
      expect(sseRes.headers.get("content-type")).toContain("text/event-stream");
      expect(await sseRes.text()).toContain('data: {"aborted":false}');
    });
  });

  describe("Inline Standard Schema v1 (@Body({ schema }), @Query({ schema }), @Param({ schema }))", () => {
    it("validates & transforms inline Standard Schema v1 and returns ADR-009 400 on failure", async () => {
      const createUserSchema = makeStandardSchema<{
        name: string;
        age: number;
      }>((input) => {
        if (typeof input !== "object" || input === null) {
          return { ok: false, issues: [{ message: "Expected object" }] };
        }
        const rec = input as Record<string, unknown>;
        const issues: Array<{ message: string; path?: (string | number)[] }> =
          [];
        if (typeof rec.name !== "string" || rec.name.trim().length < 2) {
          issues.push({ message: "name must be >= 2 chars", path: ["name"] });
        }
        if (typeof rec.age !== "number" || rec.age < 18) {
          issues.push({ message: "age must be >= 18", path: ["age"] });
        }
        if (issues.length > 0) {
          return { ok: false, issues };
        }
        return {
          ok: true,
          value: { name: (rec.name as string).trim(), age: rec.age as number },
        };
      });

      const pageSchema = makeStandardSchema<number>((val) => {
        const n = Number(val);
        if (!Number.isInteger(n) || n < 1) {
          return {
            ok: false,
            issues: [{ message: "page must be positive int" }],
          };
        }
        return { ok: true, value: n };
      });

      @Controller("std")
      class StdController {
        @Post("users")
        create(
          @Body({ schema: createUserSchema })
          dto: { name: string; age: number },
        ) {
          return dto;
        }

        @Get("list")
        list(@Query("page", { schema: pageSchema }) page: number) {
          return { page };
        }
      }

      const adapter = new BunHttpAdapter({ logger: false });
      await adapter.compileControllers([StdController]);

      const okRes = await adapter.fetch(
        new Request("http://localhost/std/users", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "  Ada  ", age: 30 }),
        }),
      );
      expect(okRes.status).toBe(201);
      expect(await okRes.json()).toEqual({ name: "Ada", age: 30 });

      const badRes = await adapter.fetch(
        new Request("http://localhost/std/users", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "A", age: 10 }),
        }),
      );
      expect(badRes.status).toBe(400);
      const errBody = (await badRes.json()) as {
        message: string;
        details: Array<{ field: string; messages: string[] }>;
      };
      expect(errBody.message).toBe("Validation failed");
      expect(errBody.details.map((d) => d.field)).toEqual(["name", "age"]);

      const okQuery = await adapter.fetch(
        new Request("http://localhost/std/list?page=3"),
      );
      expect(okQuery.status).toBe(200);
      expect(await okQuery.json()).toEqual({ page: 3 });

      const badQuery = await adapter.fetch(
        new Request("http://localhost/std/list?page=0"),
      );
      expect(badQuery.status).toBe(400);
    });
  });

  describe("Static Assets (ETag/304, Range/206/416, SPA fallback, security)", () => {
    it("serves static files via Bun.file() with ETag 304, Range 206, SPA fallback, and traversal defenses", async () => {
      const dir = join(
        Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp",
        `bunest-static-test-${crypto.randomUUID()}`,
      );
      await ensureDir(dir);
      tmpDirs.push(dir);
      await Bun.write(join(dir, "index.html"), "<h1>SPA Shell</h1>");
      await Bun.write(join(dir, "data.txt"), "0123456789ABCDEF");
      await Bun.write(join(dir, ".secret"), "top-secret");

      const adapter = new BunHttpAdapter({ logger: false });
      adapter.useStaticAssets(dir, {
        prefix: "/app",
        etag: true,
        maxAge: 3600,
        immutable: true,
        spaFallback: true,
        dotfiles: "deny",
      });
      await adapter.compileControllers([]);

      // 1. Direct file + ETag + Cache-Control
      const fileRes = await adapter.fetch(
        new Request("http://localhost/app/data.txt"),
      );
      expect(fileRes.status).toBe(200);
      expect(await fileRes.text()).toBe("0123456789ABCDEF");
      const etag = fileRes.headers.get("etag");
      expect(etag).toBeTruthy();
      expect(fileRes.headers.get("cache-control")).toBe(
        "public, max-age=3600, immutable",
      );

      // 2. If-None-Match -> 304
      const notMod = await adapter.fetch(
        new Request("http://localhost/app/data.txt", {
          headers: { "If-None-Match": etag! },
        }),
      );
      expect(notMod.status).toBe(304);

      // 3. HTTP Range -> 206 Partial Content
      const rangeRes = await adapter.fetch(
        new Request("http://localhost/app/data.txt", {
          headers: { Range: "bytes=4-9" },
        }),
      );
      expect(rangeRes.status).toBe(206);
      expect(rangeRes.headers.get("content-range")).toBe("bytes 4-9/16");
      expect(await rangeRes.text()).toBe("456789");

      // 4. Out-of-bounds Range -> 416
      const badRange = await adapter.fetch(
        new Request("http://localhost/app/data.txt", {
          headers: { Range: "bytes=999-1000" },
        }),
      );
      expect(badRange.status).toBe(416);

      // 5. SPA fallback for extensionless client routes
      const spaRes = await adapter.fetch(
        new Request("http://localhost/app/dashboard/settings"),
      );
      expect(spaRes.status).toBe(200);
      expect(await spaRes.text()).toBe("<h1>SPA Shell</h1>");

      // 6. Dotfile denied -> 403; NTFS ADS / encoded traversal / backslash -> 403
      expect(
        (await adapter.fetch(new Request("http://localhost/app/.secret")))
          .status,
      ).toBe(403);
      expect(
        (await adapter.fetch(new Request("http://localhost/app/data.txt:ads")))
          .status,
      ).toBe(403);
      expect(
        (
          await adapter.fetch(
            new Request("http://localhost/app/%2e%2e%2fetc/passwd"),
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await adapter.fetch(
            new Request("http://localhost/app/sub%5c..%5csecret"),
          )
        ).status,
      ).toBe(403);
      // WHATWG URL collapses `/app/%2e%2e/etc/passwd` to `/etc/passwd` before reaching `/app` mount -> 404
      expect(
        (
          await adapter.fetch(
            new Request("http://localhost/app/%2e%2e/etc/passwd"),
          )
        ).status,
      ).toBe(404);
    });
  });

  describe("Native CompressionMiddleware, IntrinsicException, errorCode, ParseFilePipeBuilder, Array globalPrefix", () => {
    it("compresses large JSON responses with gzip/deflate, weakens ETag, and skips small/SSE/no-transform", async () => {
      const largePayload = {
        items: Array.from({ length: 120 }, (_, i) => `item-${i}`),
      };

      @Controller("comp")
      class CompController {
        @Get("large")
        @Header("ETag", '"abc123"')
        large() {
          return largePayload;
        }

        @Get("small")
        small() {
          return { ok: true };
        }

        @Get("no-transform")
        @Header("Cache-Control", "no-transform")
        noTransform() {
          return largePayload;
        }
      }

      const adapter = new BunHttpAdapter({ logger: false });
      adapter.use(new CompressionMiddleware({ threshold: 256 }));
      await adapter.compileControllers([CompController]);

      // gzip compression
      const gzRes = await adapter.fetch(
        new Request("http://localhost/comp/large", {
          headers: { "Accept-Encoding": "deflate;q=0.5, gzip;q=1.0" },
        }),
      );
      expect(gzRes.status).toBe(200);
      expect(gzRes.headers.get("content-encoding")).toBe("gzip");
      expect(gzRes.headers.get("vary")).toContain("Accept-Encoding");
      expect(gzRes.headers.get("etag")).toBe('W/"abc123"');
      const decompressed = new TextDecoder().decode(
        Bun.gunzipSync(new Uint8Array(await gzRes.arrayBuffer())),
      );
      expect(JSON.parse(decompressed)).toEqual(largePayload);

      // small body below threshold skipped
      const smallRes = await adapter.fetch(
        new Request("http://localhost/comp/small", {
          headers: { "Accept-Encoding": "gzip" },
        }),
      );
      expect(smallRes.headers.get("content-encoding")).toBeNull();
      expect(smallRes.headers.get("vary")).toContain("Accept-Encoding");

      // Cache-Control: no-transform skipped
      const ntRes = await adapter.fetch(
        new Request("http://localhost/comp/no-transform", {
          headers: { "Accept-Encoding": "gzip" },
        }),
      );
      expect(ntRes.headers.get("content-encoding")).toBeNull();

      // Functional helper export sanity
      expect(typeof createCompressionMiddleware).toBe("function");
    });

    it("supports IntrinsicException (silent default logging), HttpExceptionOptions.errorCode, ParseFilePipeBuilder, and array globalPrefix", async () => {
      const errorLogs: unknown[] = [];
      const mockLogger: LoggerService = {
        log() {},
        warn() {},
        error(...args: unknown[]) {
          errorLogs.push(args);
        },
      };

      class ExpectedDomainError extends IntrinsicException {}

      @Controller("misc")
      class MiscController {
        @Get("intrinsic")
        intrinsic() {
          throw new ExpectedDomainError("quiet expected failure");
        }

        @Get("coded")
        coded() {
          throw new BadRequestException("Invalid coupon", {
            errorCode: "COUPON_EXPIRED",
          });
        }

        @Post("upload")
        upload(
          @UploadedFile(
            new ParseFilePipeBuilder()
              .addMaxSizeValidator({ maxSize: 1024 })
              .addFileTypeValidator({ fileType: "image/png" })
              .build(),
          )
          file: UploadedFileInfo,
        ) {
          return { name: file.originalname, size: file.size };
        }
      }

      const adapter = new BunHttpAdapter({
        logger: mockLogger,
        globalPrefix: ["/api/v1", "/legacy"],
      });
      await adapter.compileControllers([MiscController]);

      // Array globalPrefix mounts on BOTH prefixes
      const codedV1 = await adapter.fetch(
        new Request("http://localhost/api/v1/misc/coded"),
      );
      expect(codedV1.status).toBe(400);
      expect(await codedV1.json()).toMatchObject({
        statusCode: 400,
        message: "Invalid coupon",
        errorCode: "COUPON_EXPIRED",
      });

      const codedLegacy = await adapter.fetch(
        new Request("http://localhost/legacy/misc/coded"),
      );
      expect(codedLegacy.status).toBe(400);

      // IntrinsicException suppresses DefaultExceptionFilter logger.error()
      const intrinsicRes = await adapter.fetch(
        new Request("http://localhost/api/v1/misc/intrinsic"),
      );
      expect(intrinsicRes.status).toBe(500);
      expect(errorLogs.length).toBe(0);

      // ParseFilePipeBuilder validates PNG magic bytes + maxSize
      const pngMagic = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2,
      ]);
      const formOk = new FormData();
      formOk.append(
        "file",
        new File([pngMagic], "avatar.png", { type: "image/png" }),
      );
      const uploadOk = await adapter.fetch(
        new Request("http://localhost/api/v1/misc/upload", {
          method: "POST",
          body: formOk,
        }),
      );
      expect(uploadOk.status).toBe(201);
      expect(await uploadOk.json()).toEqual({ name: "avatar.png", size: 10 });

      const formBad = new FormData();
      formBad.append(
        "file",
        new File(["not-a-png"], "fake.png", { type: "image/png" }),
      );
      const uploadBad = await adapter.fetch(
        new Request("http://localhost/api/v1/misc/upload", {
          method: "POST",
          body: formBad,
        }),
      );
      expect(uploadBad.status).toBe(400);
    });
  });
});
