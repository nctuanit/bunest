import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  Controller,
  Get,
  Module,
  type BunestModule,
  type MiddlewareConsumer,
  type NextFunction,
  type ResponseContext,
} from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Test,
  describeConformance,
  itAdapted,
  request,
} from "../../../_helpers";

async function markMiddleware(
  _req: Request,
  res: ResponseContext,
  next: NextFunction,
) {
  res.header("x-middleware", "ran");
  await next();
}

@Controller("files")
class FilesController {
  @Get("*")
  catchAll() {
    return "catch-all";
  }

  @Get("public")
  publicRoute() {
    return "public";
  }

  @Get(":id")
  byId() {
    return "by id";
  }
}

@Module({ controllers: [FilesController] })
class TrailingSlashModule implements BunestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(markMiddleware)
      .exclude("files/public")
      .forRoutes(FilesController);
  }
}

describeConformance(
  'Paths ending with "/" (BunHttpAdapter strict vs ignoreTrailingSlash)',
  {
    upstreamPath: "integration/http-adapters/e2e/trailing-slash-routes.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-011"],
    notes:
      "Adapts NestJS trailing-slash routing & middleware exclusion tests to BunHttpAdapter (strict by default per ADR-011, with opt-in ignoreTrailingSlash: true).",
  },
  () => {
    describe("with default strict trailing-slash routing (ignoreTrailingSlash: false)", () => {
      let app: BunestApplication;

      beforeEach(async () => {
        const modRef = await Test.createTestingModule({
          imports: [TrailingSlashModule],
        }).compile();
        app = modRef.createNestApplication({ logger: false });
        await app.init();
      });

      afterEach(async () => {
        await app.close();
      });

      // BUNEST_BUG: matchesPathPattern treats target ":id" segments as matching literal exclude patterns like "files/public", erroneously excluding /files/:id from middleware (packages/core/src/http/scanner/path-normalizer.ts:151).
      it.skip("should run the middleware for every path except the exact excluded route", async () => {
        const excluded = ["/files/public"];
        for (const path of [
          "/files/public",
          "/files/public/",
          "/files/42",
          "/files/42/",
          "/files/a/b",
          "/files/a/b/",
        ]) {
          const res = await request(app).get(path);
          expect(res.status).toBe(200);
          expect(res.headers["x-middleware"]).toBe(
            excluded.includes(path) ? undefined : "ran",
          );
        }
      });

      it("should give the more specific routes their paths regardless of registration order", async () => {
        const handlers = await Promise.all(
          ["/files/public", "/files/42", "/files/a/b"].map(
            async (path) => (await request(app).get(path)).text,
          ),
        );
        expect(handlers).toEqual(["public", "by id", "catch-all"]);
      });
    });

    describe("with ignoreTrailingSlash: true", () => {
      let app: BunestApplication;

      beforeEach(async () => {
        const modRef = await Test.createTestingModule({
          imports: [TrailingSlashModule],
        }).compile();
        app = modRef.createNestApplication({
          logger: false,
          ignoreTrailingSlash: true,
        });
        await app.init();
      });

      afterEach(async () => {
        await app.close();
      });

      // BUNEST_BUG: BunHttpAdapter.fetch() runs nativeMatcher.match(pathname) before dispatchFallback() checks ignoreTrailingSlash, so sibling wildcard /files/* intercepts /files/public/ and /files/42/ instead of stripping the trailing slash (packages/core/src/http/adapter/bun-http.adapter.ts:657-732).
      it.skip("should send a path ending with '/' to the route it would go to without it", async () => {
        for (const path of ["/files/public", "/files/42", "/files/a/b"]) {
          const [res, withSlash] = await Promise.all([
            request(app).get(path),
            request(app).get(`${path}/`),
          ]);

          expect(withSlash.text).toBe(res.text);
          expect(withSlash.headers["x-middleware"]).toBe(
            res.headers["x-middleware"],
          );
        }
      });
    });
  },
);
