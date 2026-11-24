import { afterAll, beforeAll, expect, it } from "bun:test";
import {
  Controller,
  Get,
  Module,
  type NextFunction,
  type ResponseContext,
} from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import { Test, describeConformance, request } from "../../../_helpers";

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
      (
        app as unknown as {
          use(paths: string[], mw: typeof markMiddleware): void;
        }
      ).use(["/css", "/js"], markMiddleware);
      await app.init();
    });

    afterAll(async () => {
      await app.close();
    });

    it.each(["/css/site.css", "/js/app.js"])(
      "should run the middleware under %s",
      async (path) => {
        const res = await request(app).get(path);

        expect(res.status).toBe(200);
        expect(res.headers["x-middleware"]).toBe("ran");
      },
    );

    it("should not run the middleware under another path", async () => {
      const res = await request(app).get("/api/users");

      expect(res.status).toBe(200);
      expect(res.headers["x-middleware"]).toBeUndefined();
    });
  },
);
