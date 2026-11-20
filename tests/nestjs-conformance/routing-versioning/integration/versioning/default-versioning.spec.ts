import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { VersioningType } from "../../../../../packages/common/src";
import type { BunestApplication } from "../../../../../packages/core/src";
import { Test, describeConformance, request } from "../../../_helpers";
import { AppModule } from "./fixtures/app.module";

/**
 * `.enableVersioning()` uses `VersioningType.URI` type by default
 * Regression test for #13496
 */
describeConformance(
  "Default Versioning behavior",
  {
    upstreamPath: "integration/versioning/e2e/default-versioning.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-011"],
    notes:
      "Replaces Express/Fastify/Node adapter matrix with BunHttpAdapter across zero-socket request(app), app.inject(), and live Bun.serve({ port: 0 }).",
  },
  () => {
    describe("BunHttpAdapter (zero-socket request(app))", () => {
      let app: BunestApplication;

      beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({
          imports: [AppModule],
        }).compile();

        app = moduleRef.createNestApplication({ logger: false });
        app.enableVersioning();
        await app.init();
      });

      describe("GET /", () => {
        it("V1", async () => {
          expect(app.getVersioningOptions()?.type).toBe(VersioningType.URI);
          await request(app).get("/v1").expect(200).expect("Hello World V1!");
        });

        it("No Version", async () => {
          await request(app).get("/").expect(404);
        });
      });

      describe("GET /neutral", () => {
        it("No Version", async () => {
          await request(app).get("/neutral").expect(200).expect("Neutral");
        });
      });

      afterAll(async () => {
        await app.close();
      });
    });

    describe("BunHttpAdapter (app.inject())", () => {
      let app: BunestApplication;

      beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({
          imports: [AppModule],
        }).compile();

        app = moduleRef.createNestApplication({ logger: false });
        app.enableVersioning();
        await app.init();
      });

      describe("GET /", () => {
        it("V1", async () => {
          const res = await app.inject({ method: "GET", url: "/v1" });
          expect(res.statusCode).toBe(200);
          expect(res.body).toBe("Hello World V1!");
        });

        it("No Version", async () => {
          const res = await app.inject({ method: "GET", url: "/" });
          expect(res.statusCode).toBe(404);
        });
      });

      describe("GET /neutral", () => {
        it("No Version", async () => {
          const res = await app.inject({ method: "GET", url: "/neutral" });
          expect(res.statusCode).toBe(200);
          expect(res.body).toBe("Neutral");
        });
      });

      afterAll(async () => {
        await app.close();
      });
    });

    describe("BunHttpAdapter (live Bun.serve ephemeral port)", () => {
      let app: BunestApplication;

      beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({
          imports: [AppModule],
        }).compile();

        app = moduleRef.createNestApplication({ logger: false });
        app.enableVersioning();
        await app.listen(0, "127.0.0.1");
      });

      describe("GET /", () => {
        it("V1", async () => {
          await request(app.getHttpServer()!)
            .get("/v1")
            .expect(200)
            .expect("Hello World V1!");
        });

        it("No Version", async () => {
          await request(app.getHttpServer()!).get("/").expect(404);
        });
      });

      describe("GET /neutral", () => {
        it("No Version", async () => {
          await request(app.getHttpServer()!)
            .get("/neutral")
            .expect(200)
            .expect("Neutral");
        });
      });

      afterAll(async () => {
        await app.close();
      });
    });
  },
);
