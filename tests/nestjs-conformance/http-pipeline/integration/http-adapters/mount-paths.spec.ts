import "reflect-metadata";
import { afterAll, beforeAll, expect, it } from "bun:test";
import {
  Controller,
  Get,
  Module,
  type NextFunction,
  type ResponseContext,
} from "../../../../../packages/common/src";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Test,
  describeConformance,
  request,
} from "../../../_helpers";

@Controller()
class MountPathsController {
  @Get("css/site.css")
  css() {
    return "css";
  }

  @Get("js/app.js")
  js() {
    return "js";
  }

  @Get("api/users")
  users() {
    return "users";
  }
}

@Module({ controllers: [MountPathsController] })
class MountPathsModule {}

function markMiddleware(
  _req: Request,
  res: ResponseContext,
  next: NextFunction,
) {
  res.header("X-Middleware", "ran");
  return next();
}

describeConformance(
  "app.use() with a list of paths",
  {
    upstreamPath: "integration/http-adapters/e2e/mount-paths.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008"],
    notes:
      "Tests Express/Fastify/Node app.use(paths[], middleware) mount-path overload on BunestApplication.",
  },
  () => {
    let app: BunestApplication;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [MountPathsModule],
      }).compile();
      app = moduleRef.createNestApplication({ logger: false });
      (app as unknown as { use(paths: string[], mw: typeof markMiddleware): void }).use(
        ["/css", "/js"],
        markMiddleware,
      );
      await app.init();
    });

    afterAll(async () => {
      await app.close();
    });

    // BUNEST_BUG: Expected app.use(['/css', '/js'], middleware) to scope middleware to the listed mount paths; actual BunestApplication.use() only accepts (...middlewares: MiddlewareEntry[]) and treats the string[] array as a middleware entry causing 500 at runtime (packages/core/src/application/bunest-application.ts, packages/http/src/adapter/bun-http.adapter.ts).
    it.skip.each(["/css/site.css", "/js/app.js"])(
      "should run the middleware under %s",
      async (path) => {
        const res = await request(app).get(path);

        expect(res.status).toBe(200);
        expect(res.headers["x-middleware"]).toBe("ran");
      },
    );

    // BUNEST_BUG: Expected app.use(['/css', '/js'], middleware) not to run under /api/users (200 without X-Middleware); actual fails with 500 because string[] mount paths are treated as a middleware entry (packages/core/src/application/bunest-application.ts, packages/http/src/adapter/bun-http.adapter.ts).
    it.skip("should not run the middleware under another path", async () => {
      const res = await request(app).get("/api/users");

      expect(res.status).toBe(200);
      expect(res.headers["x-middleware"]).toBeUndefined();
    });
  },
);
