import "reflect-metadata";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  Controller,
  Get,
  Header,
  Inject,
  Injectable,
  Module,
  NotFoundException,
  Param,
  REQUEST_CONTEXT,
  Redirect,
  Scope,
} from "../../../../../packages/common/src";
import type {
  BunestApplication,
  RequestContext,
} from "../../../../../packages/core/src";
import {
  Test,
  describeConformance,
  itAdapted,
  request,
} from "../../../_helpers";

@Controller()
class ResponsesController {
  @Get("redirect")
  @Redirect("/target?from=a%20b", 302)
  redirect() {}

  @Get("redirect-dynamic")
  @Redirect("/default")
  redirectDynamic() {
    return { url: "/dynamic", statusCode: 301 };
  }

  @Get("send-number")
  sendNumber() {
    return 42;
  }

  @Get("send-boolean")
  sendBoolean() {
    return true;
  }

  @Get("html-header")
  @Header("Content-Type", "text/html")
  htmlHeader() {
    return "<p>zażółć</p>";
  }

  @Get("typed-array")
  typedArray() {
    return new Uint16Array(new Uint8Array([1, 2, 3, 4]).buffer);
  }

  @Get("data-view")
  dataView() {
    return new DataView(new Uint8Array([9, 1, 2, 3, 9]).buffer, 1, 3);
  }

  @Get("buffer")
  buffer() {
    return Buffer.from([1, 2, 3]);
  }

  @Get("files-or-gone/:name")
  async sendFileOrGone(@Param("name") name: string) {
    const file = Bun.file(join(staticRootDir, name));
    if (!(await file.exists())) {
      return new Response("gone", { status: 410 });
    }
    return file;
  }

  @Get("missing-explicit")
  missingExplicit(): never {
    throw new NotFoundException("File not found");
  }
}

@Injectable({ scope: Scope.REQUEST })
class RequestScopedService {
  constructor(
    @Inject(REQUEST_CONTEXT) private readonly reqCtx: RequestContext,
  ) {}

  setHeader(name: string, value: string) {
    this.reqCtx.responseContext.header(name, value);
  }
}

@Controller({ path: "request-scoped", scope: Scope.REQUEST })
class RequestScopedController {
  constructor(private readonly service: RequestScopedService) {}

  @Get()
  get() {
    this.service.setHeader("x-from-provider", "yes");
    return "ok";
  }
}

@Module({
  controllers: [ResponsesController, RequestScopedController],
  providers: [RequestScopedService],
})
class ResponsesModule {}

let staticRootDir: string;

describeConformance(
  "Responses, Redirects, Static File Delivery & Binary Bodies (BunHttpAdapter)",
  {
    upstreamPath: "integration/http-adapters/e2e/responses.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-010", "ADR-012"],
    notes:
      "Adapts NestJS responses/redirects/sendFile/binary-body E2E tests to Bunest native Response serialization (ADR-010), useStaticAssets() (zero-copy Bun.file() with ETag/Range/304), and explicit Scope.REQUEST (ADR-012).",
  },
  () => {
    let app: BunestApplication;

    beforeAll(async () => {
      staticRootDir = mkdtempSync(join(tmpdir(), "bunest-responses-files-"));
      writeFileSync(join(staticRootDir, "hello.txt"), "hello from a file");
      mkdirSync(join(staticRootDir, "folder"));

      const modRef = await Test.createTestingModule({
        imports: [ResponsesModule],
      }).compile();
      app = modRef.createNestApplication({ logger: false });
      app.useStaticAssets(staticRootDir, { prefix: "/files", index: false });
      app.useStaticAssets(staticRootDir, { prefix: "/rooted", index: false });
      await app.init();
    });

    afterAll(async () => {
      await app.close();
      rmSync(staticRootDir, { recursive: true, force: true });
    });

    describe("Redirects and primitive serialization", () => {
      itAdapted(
        ["ADR-010", "ADR-012"],
        "should let a request-scoped provider set response headers via REQUEST_CONTEXT",
        async () => {
          const res = await request(app).get("/request-scoped");
          expect(res.status).toBe(200);
          expect(res.headers["x-from-provider"]).toBe("yes");
        },
        "Explicit Scope.REQUEST controller + REQUEST_CONTEXT.responseContext",
      );

      itAdapted(
        "ADR-010",
        "should send @Redirect() with Location header and 302 status",
        async () => {
          const res = await request(app).get("/redirect");
          expect(res.status).toBe(302);
          expect(res.headers.location).toBe("/target?from=a%20b");
        },
        "Bunest @Redirect() returns empty-body Web Response with Location header",
      );

      it("should take the URL and status a @Redirect() handler returns", async () => {
        const res = await request(app).get("/redirect-dynamic");
        expect(res.status).toBe(301);
        expect(res.headers.location).toBe("/dynamic");
      });

      it("should send no body in answer to HEAD", async () => {
        const res = await request(app).head("/redirect");
        expect(res.status).toBe(302);
        expect(res.headers.location).toBe("/target?from=a%20b");
        expect(res.text).toBe("");
      });

      it("should preserve explicit @Header('Content-Type', 'text/html') and UTF-8 text body", async () => {
        const res = await request(app).get("/html-header");
        expect(res.headers["content-type"]).toContain("text/html");
        expect(res.text).toBe("<p>zażółć</p>");
      });

      it.each([
        ["/send-number", "42"],
        ["/send-boolean", "true"],
      ])("should send %s as JSON", async (path, text) => {
        const res = await request(app).get(path);
        expect(res.headers["content-type"]).toContain("application/json");
        expect(res.text).toBe(text);
      });
    });

    describe("Static file serving (useStaticAssets / Bun.file)", () => {
      it("should stream the file with its type, length, Last-Modified, Accept-Ranges and ETag", async () => {
        const res = await request(app).get("/files/hello.txt");

        expect(res.status).toBe(200);
        expect(res.headers["content-type"]).toContain("text/plain");
        expect(res.headers["content-length"]).toBe("17");
        expect(res.headers["accept-ranges"]).toBe("bytes");
        expect(res.headers["last-modified"]).toBeDefined();
        expect(res.headers.etag).toBeDefined();
        expect(res.text).toBe("hello from a file");
      });

      it("should resolve a relative path against the static root", async () => {
        expect((await request(app).get("/rooted/hello.txt")).text).toBe(
          "hello from a file",
        );
      });

      it("should answer byte ranges (206) and conditional If-None-Match (304) requests", async () => {
        const range = await request(app)
          .get("/files/hello.txt")
          .set("range", "bytes=0-4");
        const initial = await request(app).get("/files/hello.txt");
        const etag = String(initial.headers.etag);
        const fresh = await request(app)
          .get("/files/hello.txt")
          .set("if-none-match", etag);

        expect(range.status).toBe(206);
        expect(range.text).toBe("hello");
        expect(fresh.status).toBe(304);
      });

      it("should hand a missing file to Nest as a 404", async () => {
        const res = await request(app).get("/files/missing.txt");
        expect(res.status).toBe(404);
        expect(res.body.statusCode).toBe(404);
      });

      it("should answer a directory like an unmatched route (404)", async () => {
        const res = await request(app).get("/files/folder");
        expect(res.status).toBe(404);
        expect(res.body).toMatchObject({
          message: "Cannot GET /files/folder",
          error: "Not Found",
          statusCode: 404,
        });
      });

      it("should allow custom handler fallback (410 Gone) when file is missing", async () => {
        const res = await request(app).get("/files-or-gone/missing.txt");
        expect(res.status).toBe(410);
        expect(res.text).toBe("gone");
      });
    });

    describe("Binary bodies (ADR-010)", () => {
      it.each([
        ["/typed-array", [1, 2, 3, 4]],
        ["/data-view", [1, 2, 3]],
        ["/buffer", [1, 2, 3]],
      ])(
        "should send %s as application/octet-stream bytes",
        async (path, bytes) => {
          const res = await request(app).get(path);
          expect(res.headers["content-type"]).toBe("application/octet-stream");
          expect([...res.bytes]).toEqual(bytes);
        },
      );
    });
  },
);
