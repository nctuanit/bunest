import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { NestApplicationOptions } from "../../../../../packages/common/src";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Test,
  describeConformance,
  itAdapted,
  request,
} from "../../../_helpers";
import { WildcardModule } from "./fixtures/route-conflict.fixtures";

async function buildApp(
  options: NestApplicationOptions,
): Promise<BunestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [WildcardModule],
  }).compile();
  return moduleRef.createNestApplication({ ...options, logger: false });
}

describeConformance(
  "Route resolution strategy with wildcards: specificity (BunHttpAdapter)",
  {
    upstreamPath:
      "integration/route-conflict/e2e/wildcard-resolution-strategy.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-011"],
    notes:
      "Uses ADR-011 bare wildcard (`@Get('*')`). Wrong HTTP method on a matched path returns 405 Method Not Allowed + Allow header per ADR-011.",
  },
  () => {
    let app: BunestApplication | undefined;

    beforeEach(async () => {
      app = await buildApp({ routeResolutionStrategy: "specificity" });
      await app.init();
    });

    afterEach(async () => {
      if (app) {
        await app.close();
        app = undefined;
      }
    });

    it("routes `/files/readme` to the literal handler (literal beats param and wildcard)", async () => {
      const response = await request(app!).get("/files/readme");
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ handler: "readme" });
    });

    it("routes `/files/42` to the param handler (param beats wildcard)", async () => {
      const response = await request(app!).get("/files/42");
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ handler: "byId", fileId: "42" });
    });

    it("routes `/files/some/nested/path` to the wildcard handler (only wildcard matches multi-segment)", async () => {
      const response = await request(app!).get("/files/some/nested/path");
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ handler: "catchAll" });
    });

    it("routes unknown single-segment paths to the param handler, not the wildcard", async () => {
      const response = await request(app!).get("/files/anything-here");
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        handler: "byId",
        fileId: "anything-here",
      });
    });

    it("returns 404 for the controller root `/files` (wildcard requires at least one extra segment)", async () => {
      const response = await request(app!).get("/files");
      expect(response.status).toBe(404);
    });

    it("returns 404 for paths outside the controller prefix", async () => {
      const response = await request(app!).get("/other/path");
      expect(response.status).toBe(404);
    });

    it("returns 404 for the root path", async () => {
      const response = await request(app!).get("/");
      expect(response.status).toBe(404);
    });

    itAdapted(
      "ADR-011",
      "returns 405 Method Not Allowed + Allow header for a known path on the wrong HTTP method",
      async () => {
        const response = await request(app!).post("/files/readme");
        expect(response.status).toBe(405);
        expect(response.header("allow")).toBe("GET, HEAD");
      },
      "Bunest emits 405 + Allow on method mismatch per ADR-011 instead of Express 404",
    );
  },
);
