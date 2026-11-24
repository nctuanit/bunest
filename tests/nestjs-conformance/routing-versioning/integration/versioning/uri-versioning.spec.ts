import { afterAll, beforeAll, describe, it } from "bun:test";
import { VersioningType } from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Test,
  describeConformance,
  itAdapted,
  request,
} from "../../../_helpers";
import { AppModule } from "./fixtures/app.module";

describeConformance(
  "URI Versioning",
  {
    upstreamPath: "integration/versioning/e2e/uri-versioning.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-011"],
    notes:
      "Adapted to BunHttpAdapter + request(app). Per ADR-011, trailing slash matching is strict by default (/v1 matches, /v1/ requires ignoreTrailingSlash: true).",
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
          type: VersioningType.URI,
        });
        await app.init();
      });

      describe("GET /", () => {
        itAdapted(
          "ADR-011",
          "V1",
          async () => {
            await request(app).get("/v1").expect(200).expect("Hello World V1!");
            // Strict trailing slash by default in Bunest (ADR-011)
            await request(app).get("/v1/").expect(404);
          },
          "strict trailing slash by default; /v1 matches root route",
        );

        itAdapted(
          "ADR-011",
          "V2",
          async () => {
            await request(app).get("/v2").expect(200).expect("Hello World V2!");
            await request(app).get("/v2/").expect(404);
          },
          "strict trailing slash by default; /v2 matches root route",
        );

        it("V3", async () => {
          await request(app).get("/v3/").expect(404);
          await request(app).get("/v3").expect(404);
        });

        it("No Version", async () => {
          await request(app).get("/").expect(404);
        });
      });

      describe("GET /:param", () => {
        it("V1", async () => {
          await request(app)
            .get("/v1/param/hello")
            .expect(200)
            .expect("Parameter V1!");
        });

        it("V2", async () => {
          await request(app)
            .get("/v2/param/hello")
            .expect(200)
            .expect("Parameter V2!");
        });

        it("V3", async () => {
          await request(app).get("/v3/param/hello").expect(404);
        });

        it("No Version", async () => {
          await request(app).get("/param/hello").expect(404);
        });
      });

      describe("GET /multiple", () => {
        it("V1", async () => {
          await request(app)
            .get("/v1/multiple")
            .expect(200)
            .expect("Multiple Versions 1 or 2");
        });

        it("V2", async () => {
          await request(app)
            .get("/v2/multiple")
            .expect(200)
            .expect("Multiple Versions 1 or 2");
        });

        it("V3", async () => {
          await request(app).get("/v3/multiple").expect(404);
        });

        it("No Version", async () => {
          await request(app).get("/multiple").expect(404);
        });
      });

      describe("GET /neutral", () => {
        it("No Version", async () => {
          await request(app).get("/neutral").expect(200).expect("Neutral");
        });
      });

      describe("GET /override", () => {
        it("V1", async () => {
          await request(app)
            .get("/v1/override")
            .expect(200)
            .expect("Override Version 1");
        });

        it("V2", async () => {
          await request(app)
            .get("/v2/override")
            .expect(200)
            .expect("Override Version 2");
        });

        it("V3", async () => {
          await request(app).get("/v3/override").expect(404);
        });

        it("No Version", async () => {
          await request(app).get("/override").expect(404);
        });
      });

      describe("GET /override-partial", () => {
        it("V1", async () => {
          await request(app)
            .get("/v1/override-partial")
            .expect(200)
            .expect("Override Partial Version 1");
        });

        it("V2", async () => {
          await request(app)
            .get("/v2/override-partial")
            .expect(200)
            .expect("Override Partial Version 2");
        });

        it("V3", async () => {
          await request(app).get("/v3/override-partial").expect(404);
        });

        it("No Version", async () => {
          await request(app).get("/override-partial").expect(404);
        });
      });

      describe("GET /foo/bar", () => {
        it("V1", async () => {
          await request(app).get("/v1/foo/bar").expect(404);
        });

        it("V2", async () => {
          await request(app).get("/v2/foo/bar").expect(404);
        });

        it("V3", async () => {
          await request(app).get("/v3/foo/bar").expect(404);
        });

        it("No Version", async () => {
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
    describe("with ignoreTrailingSlash: true (ADR-011 opt-in trailing slash parity)", () => {
      beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({
          imports: [AppModule],
        }).compile();

        app = moduleRef.createNestApplication({
          logger: false,
          ignoreTrailingSlash: true,
        });
        app.enableVersioning({
          type: VersioningType.URI,
        });
        await app.init();
      });

      itAdapted(
        "ADR-011",
        "matches /v1/ and /v2/ with trailing slash when ignoreTrailingSlash is enabled",
        async () => {
          await request(app).get("/v1/").expect(200).expect("Hello World V1!");
          await request(app).get("/v2/").expect(200).expect("Hello World V2!");
          await request(app).get("/v3/").expect(404);
        },
      );

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
          type: VersioningType.URI,
          defaultVersion: "1",
        });
        await app.init();
      });

      describe("GET /", () => {
        it("V1", async () => {
          await request(app).get("/v1").expect(200).expect("Hello World V1!");
        });

        it("V2", async () => {
          await request(app).get("/v2").expect(200).expect("Hello World V2!");
        });

        it("V3", async () => {
          await request(app).get("/v3").expect(404);
        });

        it("No Version", async () => {
          await request(app).get("/").expect(404);
        });
      });

      describe("GET /:param", () => {
        it("V1", async () => {
          await request(app)
            .get("/v1/param/hello")
            .expect(200)
            .expect("Parameter V1!");
        });

        it("V2", async () => {
          await request(app)
            .get("/v2/param/hello")
            .expect(200)
            .expect("Parameter V2!");
        });

        it("V3", async () => {
          await request(app).get("/v3/param/hello").expect(404);
        });

        it("No Version", async () => {
          await request(app).get("/param/hello").expect(404);
        });
      });

      describe("GET /multiple", () => {
        it("V1", async () => {
          await request(app)
            .get("/v1/multiple")
            .expect(200)
            .expect("Multiple Versions 1 or 2");
        });

        it("V2", async () => {
          await request(app)
            .get("/v2/multiple")
            .expect(200)
            .expect("Multiple Versions 1 or 2");
        });

        it("V3", async () => {
          await request(app).get("/v3/multiple").expect(404);
        });

        it("No Version", async () => {
          await request(app).get("/multiple").expect(404);
        });
      });

      describe("GET /neutral", () => {
        it("No Version", async () => {
          await request(app).get("/neutral").expect(200).expect("Neutral");
        });
      });

      describe("GET /override", () => {
        it("V1", async () => {
          await request(app)
            .get("/v1/override")
            .expect(200)
            .expect("Override Version 1");
        });

        it("V2", async () => {
          await request(app)
            .get("/v2/override")
            .expect(200)
            .expect("Override Version 2");
        });

        it("V3", async () => {
          await request(app).get("/v3/override").expect(404);
        });

        it("No Version", async () => {
          await request(app).get("/override").expect(404);
        });
      });

      describe("GET /override-partial", () => {
        it("V1", async () => {
          await request(app)
            .get("/v1/override-partial")
            .expect(200)
            .expect("Override Partial Version 1");
        });

        it("V2", async () => {
          await request(app)
            .get("/v2/override-partial")
            .expect(200)
            .expect("Override Partial Version 2");
        });

        it("V3", async () => {
          await request(app).get("/v3/override-partial").expect(404);
        });

        it("No Version", async () => {
          await request(app).get("/override-partial").expect(404);
        });
      });

      describe("GET /foo/bar", () => {
        it("V1", async () => {
          await request(app)
            .get("/v1/foo/bar")
            .expect(200)
            .expect("Hello FooBar!");
        });

        it("V2", async () => {
          await request(app).get("/v2/foo/bar").expect(404);
        });

        it("V3", async () => {
          await request(app).get("/v3/foo/bar").expect(404);
        });

        it("No Version", async () => {
          await request(app).get("/foo/bar").expect(404);
        });
      });

      afterAll(async () => {
        await app.close();
      });
    });

    // ======================================================================== //
    describe("with the global prefix enabled and an excluded route", () => {
      beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({
          imports: [AppModule],
        }).compile();

        app = moduleRef.createNestApplication({ logger: false });
        app.setGlobalPrefix("api", { exclude: ["/foo/bar"] });
        app.enableVersioning({
          type: VersioningType.URI,
          defaultVersion: "1",
        });
        await app.init();
      });

      describe("GET /", () => {
        it("V1", async () => {
          await request(app)
            .get("/api/v1")
            .expect(200)
            .expect("Hello World V1!");
        });

        it("V2", async () => {
          await request(app)
            .get("/api/v2")
            .expect(200)
            .expect("Hello World V2!");
        });

        it("V3", async () => {
          await request(app).get("/api/v3").expect(404);
        });

        it("No Version", async () => {
          await request(app).get("/api").expect(404);
        });
      });

      describe("GET /foo/bar (excluded from the API prefix)", () => {
        it("V1", async () => {
          await request(app)
            .get("/v1/foo/bar")
            .expect(200)
            .expect("Hello FooBar!");
        });

        it("V2", async () => {
          await request(app).get("/v2/foo/bar").expect(404);
        });

        it("V3", async () => {
          await request(app).get("/v3/foo/bar").expect(404);
        });

        it("No Version", async () => {
          await request(app).get("/foo/bar").expect(404);
        });
      });

      afterAll(async () => {
        await app.close();
      });
    });

    // ======================================================================== //
    describe("with middleware applied", () => {
      beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({
          imports: [AppModule],
        }).compile();

        app = moduleRef.createNestApplication({ logger: false });
        app.enableVersioning({
          type: VersioningType.URI,
          defaultVersion: "1",
        });
        await app.init();
      });

      describe("GET /middleware", () => {
        it('should return "Hello from middleware function!"', async () => {
          await request(app)
            .get("/v1/middleware")
            .expect(200)
            .expect("Hello from middleware function!");
        });
      });

      describe("GET /middleware/override", () => {
        it('should return "Hello from middleware function!"', async () => {
          await request(app)
            .get("/v2/middleware/override")
            .expect(200)
            .expect("Hello from middleware function!");
        });
      });

      describe("GET /middleware/multiple", () => {
        it('should return "Hello from middleware function!" (v1)', async () => {
          await request(app)
            .get("/v1/middleware/multiple")
            .expect(200)
            .expect("Hello from middleware function!");
        });

        it('should return "Hello from middleware function!" (v2)', async () => {
          await request(app)
            .get("/v2/middleware/multiple")
            .expect(200)
            .expect("Hello from middleware function!");
        });
      });

      describe("GET /middleware/neutral", () => {
        it('should return "Hello from middleware function!"', async () => {
          await request(app)
            .get("/middleware/neutral")
            .expect(200)
            .expect("Hello from middleware function!");
        });
      });

      afterAll(async () => {
        await app.close();
      });
    });
  },
);
