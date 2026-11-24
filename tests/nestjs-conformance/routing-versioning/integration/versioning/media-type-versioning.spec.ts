import { afterAll, beforeAll, describe, it } from "bun:test";
import { VersioningType } from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import { Test, describeConformance, request } from "../../../_helpers";
import { AppModule } from "./fixtures/app.module";

describeConformance(
  "Media Type Versioning",
  {
    upstreamPath: "integration/versioning/e2e/media-type-versioning.spec.ts",
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
          type: VersioningType.MEDIA_TYPE,
          key: "v=",
        });
        await app.init();
      });

      describe("GET /", () => {
        it("V1", async () => {
          await request(app)
            .get("/")
            .set({ Accept: "application/json;v=1" })
            .expect(200)
            .expect("Hello World V1!");
        });

        it("V2", async () => {
          await request(app)
            .get("/")
            .set({ Accept: "application/json;v=2" })
            .expect(200)
            .expect("Hello World V2!");
        });

        it.each([
          'application/json;v="2"',
          'application/json;note="a;v=1";v=2',
          'text/html;note="a,application/json;v=1", application/json;v=2',
          'application/json;note="a\\";v=1";v=2',
          'application/json;v=2;note="unterminated',
        ])("V2 with quoted parameters: %s", async (acceptHeader) => {
          await request(app)
            .get("/")
            .set({ Accept: acceptHeader })
            .expect(200)
            .expect("Hello World V2!");
        });

        it('V2 with quoted parameters: application/json;v="\\2"', async () => {
          await request(app)
            .get("/")
            .set({ Accept: 'application/json;v="\\2"' })
            .expect(200)
            .expect("Hello World V2!");
        });

        it.each([
          'application/json;note="a;v=2',
          'text/html;note="a,application/json;v=2',
        ])(
          "ignores a version after an unterminated quote: %s",
          async (acceptHeader) => {
            await request(app)
              .get("/")
              .set({ Accept: acceptHeader })
              .expect(404);
          },
        );

        it("V2 after other parameters", async () => {
          await request(app)
            .get("/")
            .set({ Accept: "application/json;q=0.9;v=2" })
            .expect(200)
            .expect("Hello World V2!");
        });

        it("V2 in a list of media types", async () => {
          await request(app)
            .get("/")
            .set({ Accept: "text/html, application/json;v=2, */*;q=0.1" })
            .expect(200)
            .expect("Hello World V2!");
        });

        it("V3", async () => {
          await request(app)
            .get("/")
            .set({ Accept: "application/json;v=3" })
            .expect(404);
        });

        it("No Version", async () => {
          await request(app)
            .get("/")
            .set({ Accept: "application/json" })
            .expect(404);
        });

        it("No Header", async () => {
          await request(app).get("/").expect(404);
        });
      });

      describe("GET /:param", () => {
        it("V1", async () => {
          await request(app)
            .get("/param/hello")
            .set({ Accept: "application/json;v=1" })
            .expect(200)
            .expect("Parameter V1!");
        });

        it("V2", async () => {
          await request(app)
            .get("/param/hello")
            .set({ Accept: "application/json;v=2" })
            .expect(200)
            .expect("Parameter V2!");
        });

        it("V3", async () => {
          await request(app)
            .get("/param/hello")
            .set({ Accept: "application/json;v=3" })
            .expect(404);
        });

        it("No Version", async () => {
          await request(app)
            .get("/param/hello")
            .set({ Accept: "" })
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
            .set({ Accept: "application/json;v=1" })
            .expect(200)
            .expect("Multiple Versions 1 or 2");
        });

        it("V2", async () => {
          await request(app)
            .get("/multiple")
            .set({ Accept: "application/json;v=2" })
            .expect(200)
            .expect("Multiple Versions 1 or 2");
        });

        it("V3", async () => {
          await request(app)
            .get("/multiple")
            .set({ Accept: "application/json;v=3" })
            .expect(404);
        });

        it("No Version", async () => {
          await request(app)
            .get("/multiple")
            .set({ Accept: "application/json" })
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
            .set({ Accept: "application/json;v=1" })
            .expect(200)
            .expect("Neutral");
        });

        it("V2", async () => {
          await request(app)
            .get("/neutral")
            .set({ Accept: "application/json;v=2" })
            .expect(200)
            .expect("Neutral");
        });

        it("No Version", async () => {
          await request(app)
            .get("/neutral")
            .set({ Accept: "application/json" })
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
            .set({ Accept: "application/json;v=1" })
            .expect(200)
            .expect("Override Version 1");
        });

        it("V2", async () => {
          await request(app)
            .get("/override")
            .set({ Accept: "application/json;v=2" })
            .expect(200)
            .expect("Override Version 2");
        });

        it("V3", async () => {
          await request(app)
            .get("/override")
            .set({ Accept: "application/json;v=3" })
            .expect(404);
        });

        it("No Version", async () => {
          await request(app)
            .get("/override")
            .set({ Accept: "application/json" })
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
            .set({ Accept: "application/json;v=1" })
            .expect(200)
            .expect("Override Partial Version 1");
        });

        it("V2", async () => {
          await request(app)
            .get("/override-partial")
            .set({ Accept: "application/json;v=2" })
            .expect(200)
            .expect("Override Partial Version 2");
        });

        it("V3", async () => {
          await request(app)
            .get("/override-partial")
            .set({ Accept: "application/json;v=3" })
            .expect(404);
        });

        it("No Version", async () => {
          await request(app)
            .get("/override-partial")
            .set({ Accept: "application/json" })
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
            .set({ Accept: "application/json;v=1" })
            .expect(200)
            .expect("Hello FooBar!");
        });

        it("V2", async () => {
          await request(app)
            .get("/foo/bar")
            .set({ Accept: "application/json;v=2" })
            .expect(200)
            .expect("Hello FooBar!");
        });

        it("V3", async () => {
          await request(app)
            .get("/foo/bar")
            .set({ Accept: "application/json;v=3" })
            .expect(200)
            .expect("Hello FooBar!");
        });

        it("No Version", async () => {
          await request(app)
            .get("/foo/bar")
            .set({ Accept: "application/json" })
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

      describe("GET /multiple-neutral", () => {
        it("V1", async () => {
          await request(app)
            .get("/multiple-neutral")
            .set({ Accept: "application/json;v=1" })
            .expect(404);
        });

        it("V2", async () => {
          await request(app)
            .get("/multiple-neutral")
            .set({ Accept: "application/json;v=2" })
            .expect(200)
            .expect("Multiple Versions Neutral or 2");
        });

        it("No Version", async () => {
          await request(app)
            .get("/multiple-neutral")
            .set({ Accept: "application/json" })
            .expect(200)
            .expect("Multiple Versions Neutral or 2");
        });

        it.each([
          'application/json;note="a;v=1"',
          'text/html;note="a,application/json;v=1"',
        ])("No Version with a quoted parameter: %s", async (acceptHeader) => {
          await request(app)
            .get("/multiple-neutral")
            .set({ Accept: acceptHeader })
            .expect(200)
            .expect("Multiple Versions Neutral or 2");
        });

        it.each([
          'application/json;note="a;v=2',
          'text/html;note="a,application/json;v=2',
        ])(
          "treats a version after an unterminated quote as unversioned: %s",
          async (acceptHeader) => {
            await request(app)
              .get("/multiple-neutral")
              .set({ Accept: acceptHeader })
              .expect(200)
              .expect("Multiple Versions Neutral or 2");
          },
        );

        it("No Version with other parameters", async () => {
          await request(app)
            .get("/multiple-neutral")
            .set({ Accept: "application/json;charset=utf-8" })
            .expect(200)
            .expect("Multiple Versions Neutral or 2");
        });

        it("No Header", async () => {
          await request(app)
            .get("/multiple-neutral")
            .expect(200)
            .expect("Multiple Versions Neutral or 2");
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
          type: VersioningType.MEDIA_TYPE,
          key: "v=",
          defaultVersion: "1",
        });
        await app.init();
      });

      describe("GET /", () => {
        it("V1", async () => {
          await request(app)
            .get("/")
            .set({ Accept: "application/json;v=1" })
            .expect(200)
            .expect("Hello World V1!");
        });

        it("V2", async () => {
          await request(app)
            .get("/")
            .set({ Accept: "application/json;v=2" })
            .expect(200)
            .expect("Hello World V2!");
        });

        it("V3", async () => {
          await request(app)
            .get("/")
            .set({ Accept: "application/json;v=3" })
            .expect(404);
        });

        it("No Version", async () => {
          await request(app)
            .get("/")
            .set({ Accept: "application/json" })
            .expect(404);
        });

        it("No Header", async () => {
          await request(app).get("/").expect(404);
        });
      });

      describe("GET /:param", () => {
        it("V1", async () => {
          await request(app)
            .get("/param/hello")
            .set({ Accept: "application/json;v=1" })
            .expect(200)
            .expect("Parameter V1!");
        });

        it("V2", async () => {
          await request(app)
            .get("/param/hello")
            .set({ Accept: "application/json;v=2" })
            .expect(200)
            .expect("Parameter V2!");
        });

        it("V3", async () => {
          await request(app)
            .get("/param/hello")
            .set({ Accept: "application/json;v=3" })
            .expect(404);
        });

        it("No Version", async () => {
          await request(app)
            .get("/param/hello")
            .set({ Accept: "" })
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
            .set({ Accept: "application/json;v=1" })
            .expect(200)
            .expect("Multiple Versions 1 or 2");
        });

        it("V2", async () => {
          await request(app)
            .get("/multiple")
            .set({ Accept: "application/json;v=2" })
            .expect(200)
            .expect("Multiple Versions 1 or 2");
        });

        it("V3", async () => {
          await request(app)
            .get("/multiple")
            .set({ Accept: "application/json;v=3" })
            .expect(404);
        });

        it("No Version", async () => {
          await request(app)
            .get("/multiple")
            .set({ Accept: "application/json" })
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
            .set({ Accept: "application/json;v=1" })
            .expect(200)
            .expect("Neutral");
        });

        it("V2", async () => {
          await request(app)
            .get("/neutral")
            .set({ Accept: "application/json;v=2" })
            .expect(200)
            .expect("Neutral");
        });

        it("No Version", async () => {
          await request(app)
            .get("/neutral")
            .set({ Accept: "application/json" })
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
            .set({ Accept: "application/json;v=1" })
            .expect(200)
            .expect("Override Version 1");
        });

        it("V2", async () => {
          await request(app)
            .get("/override")
            .set({ Accept: "application/json;v=2" })
            .expect(200)
            .expect("Override Version 2");
        });

        it("V3", async () => {
          await request(app)
            .get("/override")
            .set({ Accept: "application/json;v=3" })
            .expect(404);
        });

        it("No Version", async () => {
          await request(app)
            .get("/override")
            .set({ Accept: "application/json" })
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
            .set({ Accept: "application/json;v=1" })
            .expect(200)
            .expect("Override Partial Version 1");
        });

        it("V2", async () => {
          await request(app)
            .get("/override-partial")
            .set({ Accept: "application/json;v=2" })
            .expect(200)
            .expect("Override Partial Version 2");
        });

        it("V3", async () => {
          await request(app)
            .get("/override-partial")
            .set({ Accept: "application/json;v=3" })
            .expect(404);
        });

        it("No Version", async () => {
          await request(app)
            .get("/override-partial")
            .set({ Accept: "application/json" })
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
            .set({ Accept: "application/json;v=1" })
            .expect(200)
            .expect("Hello FooBar!");
        });

        it("V2", async () => {
          await request(app)
            .get("/foo/bar")
            .set({ Accept: "application/json;v=2" })
            .expect(404);
        });

        it("V3", async () => {
          await request(app)
            .get("/foo/bar")
            .set({ Accept: "application/json;v=3" })
            .expect(404);
        });

        it("No Version", async () => {
          await request(app)
            .get("/foo/bar")
            .set({ Accept: "application/json" })
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
