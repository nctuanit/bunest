import "reflect-metadata";
import { afterEach, describe, expect, it } from "bun:test";
import type {
  NestApplicationOptions,
  Type,
} from "../../../../../packages/common/src";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Test,
  describeConformance,
  itAdapted,
  request,
} from "../../../_helpers";
import {
  BunestOptionalParamController,
  FileNameController,
  MixedSegmentController,
  OptionalGroupController,
} from "./fixtures/route-conflict.fixtures";

async function startApp(
  controller: Type<unknown>,
  options: NestApplicationOptions,
  warnings: string[] = [],
): Promise<BunestApplication> {
  const logger = {
    log: () => {},
    warn: (message: unknown) => {
      warnings.push(String(message));
    },
    error: () => {},
  };
  const moduleRef = await Test.createTestingModule({
    controllers: [controller],
  }).compile();
  const app = moduleRef.createNestApplication({ ...options, logger });
  app.useLogger(logger);
  await app.init();
  return app;
}

describeConformance(
  "Route conflicts in path-to-regexp syntax (BunHttpAdapter)",
  {
    upstreamPath: "integration/route-conflict/e2e/path-syntax.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-011"],
    notes:
      "Tests path-to-regexp v8 optional groups (`users{/:userId}`) and mixed segments (`v:version`, `:name.:ext`) alongside Bunest ADR-011 `:param?` optional parameter syntax.",
  },
  () => {
    let app: BunestApplication | undefined;

    afterEach(async () => {
      if (app) {
        await app.close();
        app = undefined;
      }
    });

    describe("a route with an optional group declared first", () => {
      // BUNEST_BUG: Expected `GET /users/5` to match `users{/:userId}` (`{ handler: "find", userId: "5" }`), but got `{ handler: "byId", userId: "5" }`. packages/http/src/router/fallback-radix-router.ts:147-207 does not support path-to-regexp v8 `{/:param}` optional group syntax (only `:param?`).
      it.skip("serves the requests of the route after it", async () => {
        app = await startApp(OptionalGroupController, {});

        const response = await request(app).get("/users/5");
        expect(response.body).toEqual({ handler: "find", userId: "5" });
      });

      // BUNEST_BUG: Expected `shadow: "warn"` to emit 1 warning for `users{/:userId}` shadowing `users/:userId`, but got 0 warnings. packages/http/src/scanner/controller-scanner.ts:113-138 (`canEarlierPatternShadowLater`) does not expand or tokenize `{/:param}` optional groups.
      it.skip("is reported as shadowing that route", async () => {
        const warnings: string[] = [];
        app = await startApp(
          OptionalGroupController,
          { routeConflictPolicy: { shadow: "warn" } },
          warnings,
        );

        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("/users/:userId");
        expect(warnings[0]).toContain("/users{/:userId}");
      });

      itAdapted(
        "ADR-011",
        "reports shadowing for Bunest's native `:userId?` optional param syntax declared before `:userId`",
        async () => {
          const warnings: string[] = [];
          app = await startApp(
            BunestOptionalParamController,
            { routeConflictPolicy: { shadow: "warn" } },
            warnings,
          );

          expect(warnings).toHaveLength(1);
          expect(warnings[0]).toContain("/users/:userId?");
          expect(warnings[0]).toContain("/users/:userId");

          const optionalEmpty = await request(app).get("/users");
          expect(optionalEmpty.status).toBe(200);
          expect(optionalEmpty.body).toEqual({ handler: "find" });
        },
        "FallbackRadixRouter supports `:param?` optional segments per ADR-011",
      );
    });

    describe("a segment mixing text and a param declared first", () => {
      // BUNEST_BUG: Expected `GET /releases/v1` to match `v:version` (`{ handler: "byVersion", version: "1" }`), but got `{ handler: "v1" }`. packages/http/src/router/fallback-radix-router.ts:147-207 treats `v:version` as a static literal rather than a mixed text+param segment.
      it.skip("serves the requests of a literal route after it", async () => {
        app = await startApp(MixedSegmentController, {});

        const response = await request(app).get("/releases/v1");
        expect(response.body).toEqual({ handler: "byVersion", version: "1" });
      });

      // BUNEST_BUG: Expected `shadow: "warn"` to emit 1 warning for `/releases/v:version` shadowing `/releases/v1`, but got 0 warnings. packages/http/src/scanner/controller-scanner.ts:113-138 (`canEarlierPatternShadowLater`) only treats segments starting with `:` as parameters.
      it.skip("is reported as shadowing that route", async () => {
        const warnings: string[] = [];
        app = await startApp(
          MixedSegmentController,
          { routeConflictPolicy: { shadow: "warn" } },
          warnings,
        );

        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("/releases/v1");
        expect(warnings[0]).toContain("/releases/v:version");
      });

      // BUNEST_BUG: Expected `GET /releases/v2` to match `/releases/v:version` (`{ handler: "byVersion", version: "2" }`), but got 404. packages/http/src/router/fallback-radix-router.ts:147-207 does not support mixed literal+param segments like `v:version`.
      it.skip("is registered after that route with the specificity strategy", async () => {
        app = await startApp(MixedSegmentController, {
          routeResolutionStrategy: "specificity",
        });

        const literal = await request(app).get("/releases/v1");
        expect(literal.body).toEqual({ handler: "v1" });

        const mixed = await request(app).get("/releases/v2");
        expect(mixed.body).toEqual({ handler: "byVersion", version: "2" });
      });
    });

    describe("a segment mixing params that a literal route cannot match", () => {
      // BUNEST_BUG: Expected FileNameController (`:name.:ext` + `readme`) to boot under `shadow: "error"` and route `/files/notes.txt` -> `{ handler: "byName", name: "notes", ext: "txt" }`, but threw false-positive DuplicateRouteException (`:name.:ext` shadows `readme`) in packages/http/src/scanner/controller-scanner.ts:127 (`es.startsWith(":")`) AND packages/http/src/router/fallback-radix-router.ts does not parse `:name.:ext`.
      it.skip("lets the application start with shadow=error", async () => {
        app = await startApp(FileNameController, {
          routeConflictPolicy: { shadow: "error" },
        });

        const literal = await request(app).get("/files/readme");
        expect(literal.body).toEqual({ handler: "readme" });

        const mixed = await request(app).get("/files/notes.txt");
        expect(mixed.body).toEqual({
          handler: "byName",
          name: "notes",
          ext: "txt",
        });
      });
    });
  },
);
