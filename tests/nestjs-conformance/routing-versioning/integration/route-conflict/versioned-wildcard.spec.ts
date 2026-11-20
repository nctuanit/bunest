import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  VersioningType,
  type NestApplicationOptions,
} from "../../../../../packages/common/src";
import type { BunestApplication } from "../../../../../packages/core/src";
import { Test, describeConformance, request } from "../../../_helpers";
import { VersionedWildcardModule } from "./fixtures/route-conflict.fixtures";

async function buildVersionedApp(
  options: NestApplicationOptions,
): Promise<BunestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [VersionedWildcardModule],
  }).compile();
  const app = moduleRef.createNestApplication({ ...options, logger: false });
  app.enableVersioning({ type: VersioningType.URI });
  return app;
}

describeConformance(
  "Route conflict policy (BunHttpAdapter, URI versioning + wildcard)",
  {
    upstreamPath:
      "integration/route-conflict/e2e/versioned-wildcard-node.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-011"],
    notes:
      "Adapted from NodeAdapter to BunHttpAdapter. Matches ADR-011 trailing wildcard semantics: `/v1/users/*` matches `/v1/users/`, `/v1/users/anything`, and `/v1/users/a/b/c`, while bare `/v1/users` returns 404 and static `/v1/users/me` wins by specificity.",
  },
  () => {
    let app: BunestApplication | undefined;

    afterEach(async () => {
      if (app) {
        await app.close();
        app = undefined;
      }
    });

    it("boots with shadow=error because the literal route precedes the wildcard", async () => {
      app = await buildVersionedApp({
        routeConflictPolicy: { shadow: "error" },
      });
      await expect(app.init()).resolves.toBeDefined();
    });

    describe("runtime routing under URI versioning", () => {
      beforeEach(async () => {
        app = await buildVersionedApp({});
        await app.init();
      });

      it("routes GET /v1/users/me to the literal handler (UsersMeController)", async () => {
        await request(app!).get("/v1/users/me").expect(200, { handler: "me" });
      });

      it("routes GET /v1/users/anything to the versioned wildcard handler", async () => {
        await request(app!)
          .get("/v1/users/anything")
          .expect(200, { handler: "catchAll" });
      });

      it("routes GET /v1/users/a/b/c to the wildcard (absorbs multi-segment tail)", async () => {
        await request(app!)
          .get("/v1/users/a/b/c")
          .expect(200, { handler: "catchAll" });
      });

      it("routes GET /v1/users/ to the wildcard as well", async () => {
        await request(app!)
          .get("/v1/users/")
          .expect(200, { handler: "catchAll" });
      });

      it("does not route the bare GET /v1/users to the wildcard", async () => {
        await request(app!).get("/v1/users").expect(404);
      });

      it("routes the unversioned handler outside the /v1 prefix", async () => {
        await request(app!)
          .get("/users/profile")
          .expect(200, { handler: "profile" });
      });
    });

    it("still routes correctly when a conflict policy is set", async () => {
      app = await buildVersionedApp({
        routeConflictPolicy: { duplicate: "error" },
      });
      await app.init();

      await request(app).get("/v1/users/me").expect(200, { handler: "me" });
      await request(app)
        .get("/v1/users/anything")
        .expect(200, { handler: "catchAll" });
    });
  },
);
