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
import { MultiUserModule } from "./fixtures/route-conflict.fixtures";

async function buildApp(
  options: NestApplicationOptions,
): Promise<BunestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [MultiUserModule],
  }).compile();
  return moduleRef.createNestApplication({ ...options, logger: false });
}

describeConformance(
  "Route resolution strategy: specificity (BunHttpAdapter)",
  {
    upstreamPath: "integration/route-conflict/e2e/resolution-strategy.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-011"],
    notes:
      "Adapted to BunHttpAdapter + request(app). Wrong HTTP method on a matched path returns 405 Method Not Allowed + Allow header per ADR-011.",
  },
  () => {
    let app: BunestApplication | undefined;

    afterEach(async () => {
      if (app) {
        await app.close();
        app = undefined;
      }
    });

    describe("with the multi-user fixture", () => {
      beforeEach(async () => {
        app = await buildApp({ routeResolutionStrategy: "specificity" });
        await app.init();
      });

      it("routes `/users/me` to the static handler, not `:userId`", async () => {
        const response = await request(app!).get("/users/me");
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ handler: "me" });
      });

      it("routes `/users/images` to the images handler, not `:userId`", async () => {
        const response = await request(app!).get("/users/images");
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ handler: "images" });
      });

      it("routes `/users/images/42` to the imageById handler", async () => {
        const response = await request(app!).get("/users/images/42");
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ handler: "imageById", imageId: "42" });
      });

      it("routes `/users/abc` to the byId handler with the userId param", async () => {
        const response = await request(app!).get("/users/abc");
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ handler: "byId", userId: "abc" });
      });

      it("routes `/users/123` to the byId handler with the userId param", async () => {
        const response = await request(app!).get("/users/123");
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ handler: "byId", userId: "123" });
      });

      it("returns 404 for the controller root `/users` (no handler declared there)", async () => {
        const response = await request(app!).get("/users");
        expect(response.status).toBe(404);
      });

      it("returns 404 for paths deeper than any declared route", async () => {
        const response = await request(app!).get("/users/me/details");
        expect(response.status).toBe(404);
      });

      it("returns 404 for an unrelated path with the same prefix shape", async () => {
        const response = await request(app!).get("/admin/me");
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
          const response = await request(app!).post("/users/me");
          expect(response.status).toBe(405);
          expect(response.header("allow")).toBe("GET, HEAD");
        },
        "Bunest emits 405 + Allow on method mismatch per ADR-011 instead of Express 404",
      );
    });

    describe("combined with routeConflictPolicy", () => {
      it("boots without error when shadow=error and specificity ordering resolves all shadows", async () => {
        const built = await buildApp({
          routeResolutionStrategy: "specificity",
          routeConflictPolicy: { shadow: "error" },
        });
        app = built;
        await expect(built.init()).resolves.toBeDefined();
      });

      it("routes correctly when both options are active together", async () => {
        app = await buildApp({
          routeResolutionStrategy: "specificity",
          routeConflictPolicy: { shadow: "warn" },
        });
        await app.init();

        const meRes = await request(app).get("/users/me");
        expect(meRes.status).toBe(200);
        expect(meRes.body).toEqual({ handler: "me" });

        const idRes = await request(app).get("/users/42");
        expect(idRes.status).toBe(200);
        expect(idRes.body).toEqual({ handler: "byId", userId: "42" });
      });
    });
  },
);
