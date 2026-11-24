import { afterEach, describe, expect, it } from "bun:test";
import type {
  LoggerService,
  NestApplicationOptions,
} from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Test,
  describeConformance,
  itAdapted,
  request,
} from "../../../_helpers";
import { WildcardModule } from "./fixtures/route-conflict.fixtures";

interface CapturedLogger {
  warnings: string[];
  logger: LoggerService;
}

function createCaptureLogger(): CapturedLogger {
  const warnings: string[] = [];
  return {
    warnings,
    logger: {
      log: () => {},
      warn: (message: unknown) => {
        warnings.push(String(message));
      },
      error: () => {},
      debug: () => {},
      verbose: () => {},
      fatal: () => {},
    },
  };
}

async function buildApp(
  options: NestApplicationOptions,
  capture: CapturedLogger,
): Promise<BunestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [WildcardModule],
  }).compile();

  const app = moduleRef.createNestApplication({
    ...options,
    logger: capture.logger,
  });
  app.useLogger(capture.logger);
  return app;
}

// WildcardModule resolves to 3 routes declared in this order:
//   GET /files/*        (wildcard, ADR-011 native syntax)
//   GET /files/:fileId  (param)
//   GET /files/readme   (literal)
// Every unique pair overlaps, so the scanner reports 3 shadow pairs.
const WILDCARD_SHADOW_PAIRS = 3;

describeConformance(
  "Route conflict policy with wildcards (BunHttpAdapter, declaration strategy)",
  {
    upstreamPath:
      "integration/route-conflict/e2e/wildcard-conflict-policy.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-011"],
    notes:
      "Uses ADR-011 bare wildcard (`@Get('*')`) instead of Express 5 `@Get('*path')`. At runtime, Bunest's native router resolves static > :param > * by specificity even without routeResolutionStrategy.",
  },
  () => {
    let app: BunestApplication | undefined;

    afterEach(async () => {
      if (app) {
        await app.close();
        app = undefined;
      }
    });

    itAdapted(
      "ADR-011",
      "with no policy, Bunest native router resolves static and param routes ahead of the wildcard (specificity precedence)",
      async () => {
        const capture = createCaptureLogger();
        app = await buildApp({}, capture);
        await app.init();

        const readme = await request(app).get("/files/readme");
        expect(readme.status).toBe(200);
        expect(readme.body).toEqual({ handler: "readme" });

        const byId = await request(app).get("/files/42");
        expect(byId.status).toBe(200);
        expect(byId.body).toEqual({ handler: "byId", fileId: "42" });

        const nested = await request(app).get("/files/a/b/c");
        expect(nested.status).toBe(200);
        expect(nested.body).toEqual({ handler: "catchAll" });

        expect(capture.warnings).toHaveLength(0);
      },
      "Bun.serve({ routes }) always resolves static > :param > * natively per ADR-011",
    );

    it("with shadow=warn, emits one warning per overlapping pair", async () => {
      const capture = createCaptureLogger();
      app = await buildApp(
        { routeConflictPolicy: { shadow: "warn" } },
        capture,
      );
      await app.init();

      expect(capture.warnings).toHaveLength(WILDCARD_SHADOW_PAIRS);
    });

    it("with shadow=warn, the warnings name the wildcard, param and literal routes", async () => {
      const capture = createCaptureLogger();
      app = await buildApp(
        { routeConflictPolicy: { shadow: "warn" } },
        capture,
      );
      await app.init();

      const joined = capture.warnings.join("\n");
      expect(joined).toContain("/files/*");
      expect(joined).toContain("/files/:fileId");
      expect(joined).toContain("/files/readme");
    });

    it("with shadow=error, bootstrap is aborted", async () => {
      const capture = createCaptureLogger();
      const builtApp = await buildApp(
        { routeConflictPolicy: { shadow: "error" } },
        capture,
      );
      await expect(builtApp.init()).rejects.toThrow();
      await builtApp.close();
    });

    it("with duplicate=error alone, bootstrap succeeds (no duplicates exist)", async () => {
      const capture = createCaptureLogger();
      app = await buildApp(
        { routeConflictPolicy: { duplicate: "error" } },
        capture,
      );
      await app.init();
      expect(capture.warnings).toHaveLength(0);
    });
  },
);
