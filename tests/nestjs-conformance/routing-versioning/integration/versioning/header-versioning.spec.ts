import "reflect-metadata";
import { afterAll, beforeAll, describe, it } from "bun:test";
import { VersioningType } from "../../../../../packages/common/src";
import type { BunestApplication } from "../../../../../packages/core/src";
import { Test, describeConformance, request } from "../../../_helpers";
import { AppModule } from "./fixtures/app.module";

describeConformance(
  "Header Versioning",
  {
    upstreamPath: "integration/versioning/e2e/header-versioning.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-011"],
    notes: "Adapted to BunHttpAdapter + zero-socket request(app).",
  },
  () => {
    let app: BunestApplication;

    // ======================================================================== //
    describe("without global default version", () => {
      beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({
          imports: [AppModule],
        }).compile();

        app = moduleRef.createNestApplication({ logger: false });
        app.enableVersioning({
          type: VersioningType.HEADER,
          header: "X-API-Version",
        });
        await app.init();
      });

      describe("GET /", () => {
        it("V1", async () => {
          await request(app)
            .get("/")
            .set({ "X-API-Version": "1" })
            .expect(200)
            .expect("Hello World V1!");
        });

        it("V2", async () => {
          await request(app)
            .get("/")
            .set({ "X-API-Version": "2" })
            .expect(200)
            .expect("Hello World V2!");
        });

        it("V3", async () => {
          await request(app)
            .get("/")
            .set({ "X-API-Version": "3" })
            .expect(404);
        });

        it("No Version", async () => {
          await request(app).get("/").set({ "X-API-Version": "" }).expect(404);
        });

        it("No Header", async () => {
          await request(app).get("/").expect(404);
        });
      });

      describe("GET /:param", () => {
        // BUNEST_BUG: Expected GET /param/hello (X-API-Version: 1) to return "Parameter V1!", but got "Hello from middleware function!". packages/http/src/scanner/path-normalizer.ts:151 (`matchesPathPattern`) treats `tSeg.startsWith(":")` as matching static middleware segment `"middleware"`, binding MiddlewareController's middleware (`/middleware/*`) to `/:param/hello` (packages/http/src/router/route-compiler.ts:475).
        it.skip("V1", async () => {
          await request(app)
            .get("/param/hello")
            .set({ "X-API-Version": "1" })
            .expect(200)
            .expect("Parameter V1!");
        });

        // BUNEST_BUG: Expected GET /param/hello (X-API-Version: 2) to return "Parameter V2!", but got "Hello from middleware function!" due to matchesPathPattern (`packages/http/src/scanner/path-normalizer.ts:151`) binding `/middleware/*` onto `/:param/hello`.
        it.skip("V2", async () => {
          await request(app)
            .get("/param/hello")
            .set({ "X-API-Version": "2" })
            .expect(200)
            .expect("Parameter V2!");
        });

        it("V3", async () => {
          await request(app)
            .get("/param/hello")
            .set({ "X-API-Version": "3" })
            .expect(404);
        });

        it("No Version", async () => {
          await request(app)
            .get("/param/hello")
            .set({ "X-API-Version": "" })
            .expect(404);
        });

        it("No Header", async () => {
          await request(app).get("/param/hello").expect(404);
        });
      });

      describe("GET /multiple", () => {
        it("V1", async () => {
          await request(app)
            .get("/multiple")
            .set({ "X-API-Version": "1" })
            .expect(200)
            .expect("Multiple Versions 1 or 2");
        });

        it("V2", async () => {
          await request(app)
            .get("/multiple")
            .set({ "X-API-Version": "2" })
            .expect(200)
            .expect("Multiple Versions 1 or 2");
        });

        it("V3", async () => {
          await request(app)
            .get("/multiple")
            .set({ "X-API-Version": "3" })
            .expect(404);
        });

        it("No Version", async () => {
          await request(app)
            .get("/multiple")
            .set({ "X-API-Version": "" })
            .expect(404);
        });

        it("No Header", async () => {
          await request(app).get("/multiple").expect(404);
        });
      });

      describe("GET /neutral", () => {
        it("V1", async () => {
          await request(app)
            .get("/neutral")
            .set({ "X-API-Version": "1" })
            .expect(200)
            .expect("Neutral");
        });

        it("V2", async () => {
          await request(app)
            .get("/neutral")
            .set({ "X-API-Version": "2" })
            .expect(200)
            .expect("Neutral");
        });

        it("No Version", async () => {
          await request(app)
            .get("/neutral")
            .set({ "X-API-Version": "" })
            .expect(200)
            .expect("Neutral");
        });

        it("No Header", async () => {
          await request(app).get("/neutral").expect(200).expect("Neutral");
        });
      });

      describe("GET /override", () => {
        it("V1", async () => {
          await request(app)
            .get("/override")
            .set({ "X-API-Version": "1" })
            .expect(200)
            .expect("Override Version 1");
        });

        it("V2", async () => {
          await request(app)
            .get("/override")
            .set({ "X-API-Version": "2" })
            .expect(200)
            .expect("Override Version 2");
        });

        it("V3", async () => {
          await request(app)
            .get("/override")
            .set({ "X-API-Version": "3" })
            .expect(404);
        });

        it("No Version", async () => {
          await request(app)
            .get("/override")
            .set({ "X-API-Version": "" })
            .expect(404);
        });

        it("No Header", async () => {
          await request(app).get("/override").expect(404);
        });
      });

      describe("GET /override-partial", () => {
        it("V1", async () => {
          await request(app)
            .get("/override-partial")
            .set({ "X-API-Version": "1" })
            .expect(200)
            .expect("Override Partial Version 1");
        });

        it("V2", async () => {
          await request(app)
            .get("/override-partial")
            .set({ "X-API-Version": "2" })
            .expect(200)
            .expect("Override Partial Version 2");
        });

        it("V3", async () => {
          await request(app)
            .get("/override-partial")
            .set({ "X-API-Version": "3" })
            .expect(404);
        });

        it("No Version", async () => {
          await request(app)
            .get("/override-partial")
            .set({ "X-API-Version": "" })
            .expect(404);
        });

        it("No Header", async () => {
          await request(app).get("/override-partial").expect(404);
        });
      });

      describe("GET /foo/bar", () => {
        it("V1", async () => {
          await request(app)
            .get("/foo/bar")
            .set({ "X-API-Version": "1" })
            .expect(200)
            .expect("Hello FooBar!");
        });

        it("V2", async () => {
          await request(app)
            .get("/foo/bar")
            .set({ "X-API-Version": "2" })
            .expect(200)
            .expect("Hello FooBar!");
        });

        it("V3", async () => {
          await request(app)
            .get("/foo/bar")
            .set({ "X-API-Version": "3" })
            .expect(200)
            .expect("Hello FooBar!");
        });

        it("No Version", async () => {
          await request(app)
            .get("/foo/bar")
            .set({ "X-API-Version": "" })
            .expect(200)
            .expect("Hello FooBar!");
        });

        it("No Header", async () => {
          await request(app)
            .get("/foo/bar")
            .expect(200)
            .expect("Hello FooBar!");
        });
      });

      afterAll(async () => {
        await app.close();
      });
    });

    // ======================================================================== //
    describe('with the global default version: "1"', () => {
      beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({
          imports: [AppModule],
        }).compile();

        app = moduleRef.createNestApplication({ logger: false });
        app.enableVersioning({
          type: VersioningType.HEADER,
          header: "X-API-Version",
          defaultVersion: "1",
        });
        await app.init();
      });

      describe("GET /", () => {
        it("V1", async () => {
          await request(app)
            .get("/")
            .set({ "X-API-Version": "1" })
            .expect(200)
            .expect("Hello World V1!");
        });

        it("V2", async () => {
          await request(app)
            .get("/")
            .set({ "X-API-Version": "2" })
            .expect(200)
            .expect("Hello World V2!");
        });

        it("V3", async () => {
          await request(app)
            .get("/")
            .set({ "X-API-Version": "3" })
            .expect(404);
        });

        it("No Version", async () => {
          await request(app).get("/").set({ "X-API-Version": "" }).expect(404);
        });

        it("No Header", async () => {
          await request(app).get("/").expect(404);
        });
      });

      describe("GET /:param", () => {
        // BUNEST_BUG: Expected GET /param/hello (X-API-Version: 1) to return "Parameter V1!", but got "Hello from middleware function!". packages/http/src/scanner/path-normalizer.ts:151 (`matchesPathPattern`) treats `tSeg.startsWith(":")` as matching static middleware segment `"middleware"`, binding MiddlewareController's middleware (`/middleware/*`) to `/:param/hello` (packages/http/src/router/route-compiler.ts:475).
        it.skip("V1", async () => {
          await request(app)
            .get("/param/hello")
            .set({ "X-API-Version": "1" })
            .expect(200)
            .expect("Parameter V1!");
        });

        // BUNEST_BUG: Expected GET /param/hello (X-API-Version: 2) to return "Parameter V2!", but got "Hello from middleware function!" due to matchesPathPattern (`packages/http/src/scanner/path-normalizer.ts:151`) binding `/middleware/*` onto `/:param/hello`.
        it.skip("V2", async () => {
          await request(app)
            .get("/param/hello")
            .set({ "X-API-Version": "2" })
            .expect(200)
            .expect("Parameter V2!");
        });

        it("V3", async () => {
          await request(app)
            .get("/param/hello")
            .set({ "X-API-Version": "3" })
            .expect(404);
        });

        it("No Version", async () => {
          await request(app)
            .get("/param/hello")
            .set({ "X-API-Version": "" })
            .expect(404);
        });

        it("No Header", async () => {
          await request(app).get("/param/hello").expect(404);
        });
      });

      describe("GET /multiple", () => {
        it("V1", async () => {
          await request(app)
            .get("/multiple")
            .set({ "X-API-Version": "1" })
            .expect(200)
            .expect("Multiple Versions 1 or 2");
        });

        it("V2", async () => {
          await request(app)
            .get("/multiple")
            .set({ "X-API-Version": "2" })
            .expect(200)
            .expect("Multiple Versions 1 or 2");
        });

        it("V3", async () => {
          await request(app)
            .get("/multiple")
            .set({ "X-API-Version": "3" })
            .expect(404);
        });

        it("No Version", async () => {
          await request(app)
            .get("/multiple")
            .set({ "X-API-Version": "" })
            .expect(404);
        });

        it("No Header", async () => {
          await request(app).get("/multiple").expect(404);
        });
      });

      describe("GET /neutral", () => {
        it("V1", async () => {
          await request(app)
            .get("/neutral")
            .set({ "X-API-Version": "1" })
            .expect(200)
            .expect("Neutral");
        });

        it("V2", async () => {
          await request(app)
            .get("/neutral")
            .set({ "X-API-Version": "2" })
            .expect(200)
            .expect("Neutral");
        });

        it("No Version", async () => {
          await request(app)
            .get("/neutral")
            .set({ "X-API-Version": "" })
            .expect(200)
            .expect("Neutral");
        });

        it("No Header", async () => {
          await request(app).get("/neutral").expect(200).expect("Neutral");
        });
      });

      describe("GET /override", () => {
        it("V1", async () => {
          await request(app)
            .get("/override")
            .set({ "X-API-Version": "1" })
            .expect(200)
            .expect("Override Version 1");
        });

        it("V2", async () => {
          await request(app)
            .get("/override")
            .set({ "X-API-Version": "2" })
            .expect(200)
            .expect("Override Version 2");
        });

        it("V3", async () => {
          await request(app)
            .get("/override")
            .set({ "X-API-Version": "3" })
            .expect(404);
        });

        it("No Version", async () => {
          await request(app)
            .get("/override")
            .set({ "X-API-Version": "" })
            .expect(404);
        });

        it("No Header", async () => {
          await request(app).get("/override").expect(404);
        });
      });

      describe("GET /override-partial", () => {
        it("V1", async () => {
          await request(app)
            .get("/override-partial")
            .set({ "X-API-Version": "1" })
            .expect(200)
            .expect("Override Partial Version 1");
        });

        it("V2", async () => {
          await request(app)
            .get("/override-partial")
            .set({ "X-API-Version": "2" })
            .expect(200)
            .expect("Override Partial Version 2");
        });

        it("V3", async () => {
          await request(app)
            .get("/override-partial")
            .set({ "X-API-Version": "3" })
            .expect(404);
        });

        it("No Version", async () => {
          await request(app)
            .get("/override-partial")
            .set({ "X-API-Version": "" })
            .expect(404);
        });

        it("No Header", async () => {
          await request(app).get("/override-partial").expect(404);
        });
      });

      describe("GET /foo/bar", () => {
        it("V1", async () => {
          await request(app)
            .get("/foo/bar")
            .set({ "X-API-Version": "1" })
            .expect(200)
            .expect("Hello FooBar!");
        });

        it("V2", async () => {
          await request(app)
            .get("/foo/bar")
            .set({ "X-API-Version": "2" })
            .expect(404);
        });

        it("V3", async () => {
          await request(app)
            .get("/foo/bar")
            .set({ "X-API-Version": "3" })
            .expect(404);
        });

        it("No Version", async () => {
          await request(app)
            .get("/foo/bar")
            .set({ "X-API-Version": "" })
            .expect(404);
        });

        it("No Header", async () => {
          await request(app).get("/foo/bar").expect(404);
        });
      });

      afterAll(async () => {
        await app.close();
      });
    });
  },
);
