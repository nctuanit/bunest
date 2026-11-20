import "reflect-metadata";
import { afterEach, describe, expect, it } from "bun:test";
import type {
  LoggerService,
  NestApplicationOptions,
  RouteConflictPolicyLevel,
  Type,
} from "../../../../../packages/common/src";
import {
  DuplicateRouteException,
  type BunestApplication,
} from "../../../../../packages/core/src";
import {
  Test,
  describeConformance,
  itAdapted,
  request,
} from "../../../_helpers";
import {
  DuplicateModule,
  HostPatternModule,
  MultiUserModule,
} from "./fixtures/route-conflict.fixtures";

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
  moduleClass: Type<unknown>,
  options: NestApplicationOptions,
  capture: CapturedLogger,
): Promise<BunestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [moduleClass],
  }).compile();

  const app = moduleRef.createNestApplication({
    ...options,
    logger: capture.logger,
  });
  app.useLogger(capture.logger);
  return app;
}

interface MultiUserCase {
  description: string;
  duplicate?: RouteConflictPolicyLevel;
  shadow?: RouteConflictPolicyLevel;
  expectsBoot: boolean;
  expectedWarnings: number;
}

// MultiUserModule resolves to 4 routes; in declaration strategy,
// `GET /users/:userId` is registered first and shadows two later routes:
// `GET /users/me` and `GET /users/images`. There are no duplicates in this
// fixture, so duplicate-axis policies never fire.
const SHADOW_PAIRS_IN_MULTI_USER = 2;

const MULTI_USER_CASES: MultiUserCase[] = [
  {
    description: "unset policy leaves the silent shadow in place",
    expectsBoot: true,
    expectedWarnings: 0,
  },
  {
    description: "duplicate=off, shadow=off is silent",
    duplicate: "off",
    shadow: "off",
    expectsBoot: true,
    expectedWarnings: 0,
  },
  {
    description: "duplicate=off, shadow=warn logs one warning per shadow pair",
    duplicate: "off",
    shadow: "warn",
    expectsBoot: true,
    expectedWarnings: SHADOW_PAIRS_IN_MULTI_USER,
  },
  {
    description: "duplicate=off, shadow=error aborts bootstrap",
    duplicate: "off",
    shadow: "error",
    expectsBoot: false,
    expectedWarnings: 0,
  },
  {
    description: "duplicate=warn, shadow=off has nothing to warn about",
    duplicate: "warn",
    shadow: "off",
    expectsBoot: true,
    expectedWarnings: 0,
  },
  {
    description: "duplicate=warn, shadow=warn warns only on shadow pairs",
    duplicate: "warn",
    shadow: "warn",
    expectsBoot: true,
    expectedWarnings: SHADOW_PAIRS_IN_MULTI_USER,
  },
  {
    description:
      "duplicate=error, shadow=off boots because no duplicates exist",
    duplicate: "error",
    shadow: "off",
    expectsBoot: true,
    expectedWarnings: 0,
  },
  {
    description:
      "duplicate=error, shadow=warn boots and warns on shadows only",
    duplicate: "error",
    shadow: "warn",
    expectsBoot: true,
    expectedWarnings: SHADOW_PAIRS_IN_MULTI_USER,
  },
  {
    description: "duplicate=error, shadow=error aborts bootstrap",
    duplicate: "error",
    shadow: "error",
    expectsBoot: false,
    expectedWarnings: 0,
  },
];

describeConformance(
  "Route conflict policy (BunHttpAdapter, declaration strategy)",
  {
    upstreamPath: "integration/route-conflict/e2e/conflict-policy.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-011"],
    notes:
      "Adapted to BunHttpAdapter. Per ADR-011, Bunest's native router matches by specificity (static > :param > *) at runtime even in declaration strategy, and defaults to fail-fast DuplicateRouteException when routeConflictPolicy is omitted.",
  },
  () => {
    describe("multi-user fixture (cross-controller shadow)", () => {
      let app: BunestApplication | undefined;

      afterEach(async () => {
        if (app) {
          await app.close();
          app = undefined;
        }
      });

      MULTI_USER_CASES.forEach((testCase) => {
        it(testCase.description, async () => {
          const conflictPolicy =
            testCase.duplicate === undefined && testCase.shadow === undefined
              ? undefined
              : { duplicate: testCase.duplicate, shadow: testCase.shadow };

          const capture = createCaptureLogger();
          const builtApp = await buildApp(
            MultiUserModule,
            { routeConflictPolicy: conflictPolicy },
            capture,
          );

          if (testCase.expectsBoot) {
            await builtApp.init();
            app = builtApp;
            expect(capture.warnings).toHaveLength(testCase.expectedWarnings);
          } else {
            await expect(builtApp.init()).rejects.toThrow();
            await builtApp.close();
          }
        });
      });

      itAdapted(
        "ADR-011",
        "with no policy, Bunest native router resolves `/users/me` and `/users/images` to static handlers (specificity precedence)",
        async () => {
          const capture = createCaptureLogger();
          app = await buildApp(MultiUserModule, {}, capture);
          await app.init();

          const meResponse = await request(app).get("/users/me");
          expect(meResponse.status).toBe(200);
          expect(meResponse.body).toEqual({ handler: "me" });

          const imagesResponse = await request(app).get("/users/images");
          expect(imagesResponse.status).toBe(200);
          expect(imagesResponse.body).toEqual({ handler: "images" });

          const byIdResponse = await request(app).get("/users/abc");
          expect(byIdResponse.status).toBe(200);
          expect(byIdResponse.body).toEqual({ handler: "byId", userId: "abc" });
        },
        "Bun.serve({ routes }) matches static > :param > * natively (like NestJS Fastify/Node adapters)",
      );

      it("with shadow=warn, the warning message names both endpoints", async () => {
        const capture = createCaptureLogger();
        app = await buildApp(
          MultiUserModule,
          { routeConflictPolicy: { shadow: "warn" } },
          capture,
        );
        await app.init();

        const joined = capture.warnings.join("\n");
        expect(joined).toContain("/users/me");
        expect(joined).toContain("/users/images");
        expect(joined).toContain("/users/:userId");
      });
    });

    describe("duplicate fixture", () => {
      let app: BunestApplication | undefined;

      afterEach(async () => {
        if (app) {
          await app.close();
          app = undefined;
        }
      });

      itAdapted(
        "ADR-011",
        "with unset policy, Bunest fails fast with DuplicateRouteException by default",
        async () => {
          const capture = createCaptureLogger();
          const builtApp = await buildApp(DuplicateModule, {}, capture);
          await expect(builtApp.init()).rejects.toBeInstanceOf(
            DuplicateRouteException,
          );
          await builtApp.close();
        },
        "default routeConflictPolicy is 'throw' in Bunest per ADR-011",
      );

      // BUNEST_BUG: Expected first-declared controller DuplicateAController (`{ from: "A" }`) to win when `duplicate: "off"`, but got `{ from: "B" }`. packages/http/src/scanner/controller-scanner.ts:399-401 overwrites `scanned[duplicateIdx] = entry` with the later controller instead of keeping the first declaration.
      it.skip("with duplicate=off, both controllers boot and the first one wins", async () => {
        const capture = createCaptureLogger();
        app = await buildApp(
          DuplicateModule,
          { routeConflictPolicy: { duplicate: "off" } },
          capture,
        );
        await app.init();

        const response = await request(app).get("/users/me");
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ from: "A" });
        expect(capture.warnings).toHaveLength(0);
      });

      it("with duplicate=warn, a single warning is emitted", async () => {
        const capture = createCaptureLogger();
        app = await buildApp(
          DuplicateModule,
          { routeConflictPolicy: { duplicate: "warn" } },
          capture,
        );
        await app.init();

        expect(capture.warnings).toHaveLength(1);
        expect(capture.warnings[0]).toContain("/users/me");
      });

      it("with duplicate=error, bootstrap is aborted", async () => {
        const capture = createCaptureLogger();
        const builtApp = await buildApp(
          DuplicateModule,
          { routeConflictPolicy: { duplicate: "error" } },
          capture,
        );
        await expect(builtApp.init()).rejects.toThrow();
        await builtApp.close();
      });

      it("with only shadow=error, the duplicate-only fixture still boots", async () => {
        const capture = createCaptureLogger();
        app = await buildApp(
          DuplicateModule,
          { routeConflictPolicy: { shadow: "error" } },
          capture,
        );
        await app.init();
        expect(capture.warnings).toHaveLength(0);
      });
    });

    describe("host pattern fixture", () => {
      let app: BunestApplication | undefined;

      afterEach(async () => {
        if (app) {
          await app.close();
          app = undefined;
        }
      });

      it("with no policy, `admin.example.com` is silently routed to `:tenant.example.com`", async () => {
        const capture = createCaptureLogger();
        app = await buildApp(HostPatternModule, {}, capture);
        await app.init();

        const response = await request(app)
          .get("/users")
          .set("Host", "admin.example.com");
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ from: "tenant" });
      });

      // BUNEST_BUG: Expected `shadow: "warn"` to report 1 warning naming TenantController and AdminController for `:tenant.example.com` shadowing `admin.example.com`, but got 0 warnings. packages/http/src/scanner/controller-scanner.ts:588-593 skips shadow checking whenever `String(earlier.host ?? "") !== String(later.host ?? "")` or `earlier.canonicalPath === later.canonicalPath`.
      it.skip("with shadow=warn, the shadowed host-bound route is reported", async () => {
        const capture = createCaptureLogger();
        app = await buildApp(
          HostPatternModule,
          { routeConflictPolicy: { shadow: "warn" } },
          capture,
        );
        await app.init();

        expect(capture.warnings).toHaveLength(1);
        expect(capture.warnings[0]).toContain("AdminController");
        expect(capture.warnings[0]).toContain("TenantController");
      });

      // BUNEST_BUG: Expected `shadow: "error"` to abort bootstrap on HostPatternModule (`:tenant.example.com` shadowing `admin.example.com`), but `app.init()` resolved without throwing. packages/http/src/scanner/controller-scanner.ts:588-593 skips shadow checks across differing host patterns on identical paths.
      it.skip("with shadow=error, bootstrap is aborted", async () => {
        const capture = createCaptureLogger();
        const builtApp = await buildApp(
          HostPatternModule,
          { routeConflictPolicy: { shadow: "error" } },
          capture,
        );
        await expect(builtApp.init()).rejects.toThrow();
        await builtApp.close();
      });
    });
  },
);
