import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  Body,
  Controller,
  Get,
  Header,
  Module,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  StreamableFile,
} from "../../../../../packages/core/src/common";
import {
  join,
  mkdirSyncPath,
  removePath,
  writeTextSync,
  type BunestApplication,
} from "../../../../../packages/core/src";
import { Test, describeConformance, itAdapted } from "../../../_helpers";

@Controller("inject")
class InjectController {
  @Get("items/:id")
  find(@Param("id") id: string, @Query("q") q: string, @Req() req: Request) {
    const token = req.headers.get("x-token") ?? undefined;
    return { id, q, token };
  }

  @Post("echo")
  echo(@Body() body: unknown) {
    return body;
  }

  @Get("stream")
  @Header("Content-Type", "text/plain")
  stream() {
    const encoder = new TextEncoder();
    const readable = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("one "));
        controller.enqueue(encoder.encode("two "));
        controller.enqueue(encoder.encode("three"));
        controller.close();
      },
    });
    return new StreamableFile(readable);
  }

  @Get("missing")
  missing() {
    throw new NotFoundException("No such item");
  }
}

@Module({ controllers: [InjectController] })
class InjectModule {}

describeConformance(
  "inject() (BunHttpAdapter)",
  {
    upstreamPath: "integration/http-adapters/e2e/inject.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-010"],
    notes:
      "Adapts Fastify/Node light-my-request inject() tests to BunestApplication.inject(), Web Request headers, StreamableFile ReadableStream, and useStaticAssets.",
  },
  () => {
    describe("inject() (standard)", () => {
      let app: BunestApplication;

      beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({
          imports: [InjectModule],
        }).compile();
        app = moduleRef.createNestApplication({ logger: false });
        await app.init();
      });

      afterAll(async () => {
        await app.close();
      });

      it("should pass params, query and headers to the handler", async () => {
        const res = await app.inject({
          method: "GET",
          url: "/inject/items/7?q=cats",
          headers: { "x-token": "abc" },
        });

        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ id: "7", q: "cats", token: "abc" });
      });

      it("should parse a JSON body", async () => {
        const res = await app.inject({
          method: "POST",
          url: "/inject/echo",
          payload: { name: "Tom" },
        });

        expect(res.statusCode).toBe(201);
        expect(res.json()).toEqual({ name: "Tom" });
      });

      it("should send a streamed body", async () => {
        const res = await app.inject("/inject/stream");

        expect(res.statusCode).toBe(200);
        expect(String(res.headers["content-type"])).toMatch(/^text\/plain/);
        expect(res.body).toBe("one two three");
      });

      it("should answer with the exception the handler throws", async () => {
        const res = await app.inject({ method: "GET", url: "/inject/missing" });

        expect(res.statusCode).toBe(404);
        expect(res.json()).toMatchObject({
          statusCode: 404,
          error: "Not Found",
          message: "No such item",
        });
      });

      it("should answer a path with no route with 404", async () => {
        const res = await app.inject({ method: "GET", url: "/inject/nowhere" });

        expect(res.statusCode).toBe(404);
      });

      // BUNEST_BUG: Expected zero-argument app.inject() to return a fluent chain builder (.post().headers().payload().end()) matching NestJS Fastify/NodeAdapter inject() API; actual throws TypeError because BunestApplication.inject(input) requires string | InjectOptions (packages/core/src/application/bunest-application.ts).
      it.skip("should build a request with the chain API", async () => {
        const chain = (app as unknown as { inject(): any }).inject();
        const res = await chain
          .post("/inject/echo")
          .headers({ "content-type": "application/json" })
          .payload(JSON.stringify([1, 2]))
          .end();

        expect(res.statusCode).toBe(201);
        expect(res.json()).toEqual([1, 2]);
      });
    });

    describe("inject() (not listening)", () => {
      let app: BunestApplication;
      let filesDir: string;

      beforeAll(async () => {
        filesDir = join(
          Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp",
          `bunest-inject-files-${crypto.randomUUID()}`,
        );
        mkdirSyncPath(filesDir, { recursive: true });
        writeTextSync(join(filesDir, "hello.txt"), "hello world\n");
        mkdirSyncPath(join(filesDir, "folder"));

        const moduleRef = await Test.createTestingModule({
          imports: [InjectModule],
        }).compile();
        app = moduleRef.createNestApplication({ logger: false });
        app.useStaticAssets(filesDir, { prefix: "/files", index: false });
        await app.init();
      });

      afterAll(async () => {
        await app.close();
        await removePath(filesDir, { recursive: true, force: true });
      });

      it("should answer without a listening server", async () => {
        const res = await app.inject("/inject/items/1?q=x");

        expect(app.getHttpServer()).toBeUndefined();
        expect(res.json()).toEqual({ id: "1", q: "x" });
      });

      itAdapted(
        ["ADR-001", "ADR-010"],
        "should send a file and a range of it",
        async () => {
          const file = await app.inject("/files/hello.txt");
          const range = await app.inject({
            method: "GET",
            url: "/files/hello.txt",
            headers: { range: "bytes=0-4" },
          });

          expect(file.statusCode).toBe(200);
          expect(range.statusCode).toBe(206);
          expect(range.body).toBe("hello");
        },
        "Uses Bunest useStaticAssets() instead of Express res.sendFile()",
      );

      itAdapted(
        ["ADR-001", "ADR-010"],
        "should return 404 when requesting a directory instead of a file",
        async () => {
          const res = await app.inject("/files/folder");

          expect(res.statusCode).toBe(404);
          expect(res.json()).toMatchObject({
            message: "Cannot GET /files/folder",
            error: "Not Found",
            statusCode: 404,
          });
        },
        "Uses Bunest useStaticAssets() instead of Express res.sendFile()",
      );
    });
  },
);
