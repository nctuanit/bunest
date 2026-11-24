import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  All,
  Controller,
  Delete,
  Get,
  Logger,
  Patch,
  Post,
  Put,
  RequestMethod,
  VERSION_NEUTRAL,
  Version,
  VersioningType,
  type LoggerService,
  type RouteConflictPolicy,
  type Type,
  type VersionValue,
  type VersioningOptions,
} from "../../../../../../packages/core/src/common";
import {
  DuplicateRouteException,
  canonicalizePath,
  normalizePath,
  scanControllers,
} from "../../../../../../packages/core/src/http";
import {
  createSandbox,
  describeConformance,
  itAdapted,
  type SinonLikeStub,
} from "../../../../_helpers";

interface TestRouteSpec {
  readonly path: string;
  readonly method?: RequestMethod;
  readonly host?: string | RegExp | Array<string | RegExp>;
  readonly version?: VersionValue;
  readonly methodName?: string;
  readonly controllerName?: string;
}

function applyMethodDecorator(
  method: RequestMethod,
  path: string,
): MethodDecorator {
  switch (method) {
    case RequestMethod.POST:
      return Post(path);
    case RequestMethod.PUT:
      return Put(path);
    case RequestMethod.DELETE:
      return Delete(path);
    case RequestMethod.PATCH:
      return Patch(path);
    case RequestMethod.ALL:
      return All(path);
    case RequestMethod.GET:
    default:
      return Get(path);
  }
}

function makeController(spec: TestRouteSpec): Type<unknown> {
  const methodName = spec.methodName ?? "findOne";
  const controllerName = spec.controllerName ?? "UsersController";
  const method = spec.method ?? RequestMethod.GET;

  @Controller({ path: "", host: spec.host })
  class DynamicController {}

  Object.defineProperty(DynamicController, "name", {
    value: controllerName,
    configurable: true,
  });

  Object.defineProperty(DynamicController.prototype, methodName, {
    value() {
      return undefined;
    },
    writable: true,
    enumerable: false,
    configurable: true,
  });

  const descriptor = Object.getOwnPropertyDescriptor(
    DynamicController.prototype,
    methodName,
  )!;
  applyMethodDecorator(method, spec.path)(
    DynamicController.prototype,
    methodName,
    descriptor,
  );
  if (spec.version !== undefined) {
    Version(spec.version)(DynamicController.prototype, methodName, descriptor);
  }

  return DynamicController;
}

interface DetectedConflictSummary {
  readonly kind: "duplicate" | "shadow";
  readonly message: string;
}

/**
 * Runs `@bunest/core/http`'s real `scanControllers()` with `{ duplicate: "warn", shadow: "warn" }`
 * and returns every duplicate and shadow conflict reported by Bunest's scanner.
 */
function detectConflictsViaScanner(
  specs: readonly TestRouteSpec[],
  versioning?: VersioningOptions,
  strategy: "declaration" | "specificity" = "declaration",
): DetectedConflictSummary[] {
  const controllers = specs.map(makeController);
  const detected: DetectedConflictSummary[] = [];
  const logger: LoggerService = {
    log: () => {},
    error: () => {},
    warn: (message: unknown) => {
      const text = String(message);
      if (text.startsWith("Duplicate route")) {
        detected.push({ kind: "duplicate", message: text });
      } else if (text.startsWith("Shadowed route")) {
        detected.push({ kind: "shadow", message: text });
      }
    },
  };

  scanControllers(controllers, {
    versioning,
    routeConflictPolicy: { duplicate: "warn", shadow: "warn" },
    routeResolutionStrategy: strategy,
    logger,
  });

  return detected;
}

/**
 * Probes whether Bunest's scanner considers two paths able to overlap
 * (either as duplicate or shadow in either declaration order).
 */
function pathsCanOverlapViaScanner(pathA: string, pathB: string): boolean {
  const forward = detectConflictsViaScanner([
    { path: pathA, methodName: "a" },
    { path: pathB, methodName: "b" },
  ]);
  if (forward.length > 0) return true;
  const reverse = detectConflictsViaScanner([
    { path: pathB, methodName: "b" },
    { path: pathA, methodName: "a" },
  ]);
  return reverse.length > 0;
}

describeConformance(
  "RouteConflictDetector (via @bunest/http scanControllers & canonicalizePath)",
  {
    upstreamPath: "packages/core/test/router/route-conflict-detector.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-011"],
    notes:
      "Adapted from NestJS internal RouteConflictDetector to @bunest/http scanControllers(), canonicalizePath(), and DuplicateRouteException.",
  },
  () => {
    describe("tokenizePath", () => {
      it("should classify literal segments", () => {
        expect(normalizePath("/users/me")).toBe("/users/me");
      });

      it("should classify named param segments", () => {
        expect(canonicalizePath("/users/:userId")).toBe("/users/:_");
      });

      it("should classify named wildcard segments", () => {
        expect(normalizePath("/files/*path")).toBe("/files/*path");
      });

      it("should classify adapter-normalized wildcard group segments", () => {
        expect(normalizePath("/files/{*path}")).toBe("/files/{*path}");
      });

      it("should ignore leading and trailing slashes and empty segments", () => {
        expect(normalizePath("//users//me/")).toBe("/users/me");
      });

      it("should classify segments that mix text and params", () => {
        expect(normalizePath("/v:version/items")).toBe("/v:version/items");
      });

      it("should classify a wildcard after text in the same segment as mixed", () => {
        expect(normalizePath("/static*path")).toBe("/static*path");
      });

      it("should read optional groups as present", () => {
        expect(normalizePath("/users{/:userId}")).toBe("/users{/:userId}");
      });

      it("should keep a param with an optional suffix a param, as it matches the same segments", () => {
        expect(normalizePath("/users/:id{.:format}")).toBe(
          "/users/:id{.:format}",
        );
      });

      it("should split paths path-to-regexp cannot parse on '/'", () => {
        expect(normalizePath("/files/*")).toBe("/files/*");
      });

      it("should split paths path-to-regexp parses but cannot match on '/'", () => {
        expect(normalizePath("/files/:name:ext")).toBe("/files/:name:ext");
      });
    });

    describe("pathsCanOverlap", () => {
      it("should return true for identical static paths", () => {
        expect(pathsCanOverlapViaScanner("/users/me", "/users/me")).toBe(true);
      });

      it("should return false for different static paths of equal length", () => {
        expect(pathsCanOverlapViaScanner("/users/me", "/users/admin")).toBe(
          false,
        );
      });

      it("should return true when a param can match a literal", () => {
        expect(pathsCanOverlapViaScanner("/users/:userId", "/users/me")).toBe(
          true,
        );
      });

      it("should return true for two parametric paths of the same shape", () => {
        expect(
          pathsCanOverlapViaScanner("/users/:userId", "/users/:slug"),
        ).toBe(true);
      });

      it("should return false when segment counts differ and no wildcard absorbs", () => {
        expect(
          pathsCanOverlapViaScanner(
            "/users/:userId",
            "/users/:userId/images/:imageId",
          ),
        ).toBe(false);
      });

      it("should return true when a trailing wildcard absorbs extra segments", () => {
        expect(
          pathsCanOverlapViaScanner("/files/*path", "/files/images/avatar.png"),
        ).toBe(true);
      });

      it("should return true when an adapter-normalized trailing wildcard absorbs extra segments", () => {
        expect(
          pathsCanOverlapViaScanner(
            "/files/{*path}",
            "/files/images/avatar.png",
          ),
        ).toBe(true);
      });

      it("should return false when the wildcard is on the longer side (named wildcard requires >=1 segment)", () => {
        expect(pathsCanOverlapViaScanner("/files/*path", "/files")).toBe(false);
        expect(pathsCanOverlapViaScanner("/files", "/files/*path")).toBe(false);
      });

      it("should return false for URI-versioned paths because the version is in the path", () => {
        expect(
          pathsCanOverlapViaScanner("/api/users/me", "/api/v1/users/me"),
        ).toBe(false);
      });

      it("should compare every variant of a path with optional groups", () => {
        expect(
          pathsCanOverlapViaScanner("/users{/:userId}", "/users/:id"),
        ).toBe(true);
        expect(pathsCanOverlapViaScanner("/users{/:userId}", "/users")).toBe(
          true,
        );
        expect(pathsCanOverlapViaScanner("/files/{*path}", "/files")).toBe(
          true,
        );
        expect(pathsCanOverlapViaScanner("/{*path}", "/")).toBe(true);
        expect(
          pathsCanOverlapViaScanner("/users{/:userId}", "/users/:id/images"),
        ).toBe(false);
      });

      it("should match a literal against a segment that mixes text and params", () => {
        expect(pathsCanOverlapViaScanner("/v:version/items", "/v1/items")).toBe(
          true,
        );
        expect(
          pathsCanOverlapViaScanner("/v:version/items", "/api/items"),
        ).toBe(false);
        expect(
          pathsCanOverlapViaScanner("/files/:name.:ext", "/files/readme.md"),
        ).toBe(true);
        expect(
          pathsCanOverlapViaScanner("/files/:name.:ext", "/files/readme"),
        ).toBe(false);
      });

      it("should let a param or another mixed segment overlap a mixed segment", () => {
        expect(
          pathsCanOverlapViaScanner("/files/:name.:ext", "/files/:id"),
        ).toBe(true);
        expect(
          pathsCanOverlapViaScanner("/files/:name.:ext", "/files/v:version"),
        ).toBe(true);
      });

      it("should not overlap mixed segments whose leading or trailing text differ", () => {
        expect(
          pathsCanOverlapViaScanner("/orders/ord_:id", "/orders/inv_:id"),
        ).toBe(false);
        expect(
          pathsCanOverlapViaScanner("/files/:name.json", "/files/:name.xml"),
        ).toBe(false);
        expect(
          pathsCanOverlapViaScanner("/orders/ord_:id", "/orders/ord_:id.json"),
        ).toBe(true);
      });

      it("should keep the text before a wildcard in the same segment", () => {
        expect(pathsCanOverlapViaScanner("/static*path", "/users/:id")).toBe(
          false,
        );
        expect(pathsCanOverlapViaScanner("/files{*path}", "/users/:id")).toBe(
          false,
        );
        expect(pathsCanOverlapViaScanner("/static*path", "/staticfiles")).toBe(
          true,
        );
      });

      it("should compare paths with more optional groups than it expands segment by segment", () => {
        const manyGroups = "/a{/b}{/c}{/d}{/e}{/f}{/g}{/h}";
        expect(pathsCanOverlapViaScanner(manyGroups, "/x")).toBe(false);
        expect(pathsCanOverlapViaScanner(manyGroups, manyGroups)).toBe(true);
      });

      it("should compare paths that path-to-regexp parses but cannot match segment by segment", () => {
        expect(
          pathsCanOverlapViaScanner("/files/:name:ext", "/files/:name:ext"),
        ).toBe(true);
        expect(pathsCanOverlapViaScanner("/files/:name:ext", "/users/me")).toBe(
          false,
        );
      });
    });

    describe("pathsHaveSameShape (via canonicalizePath)", () => {
      it("should be true for param paths that differ by parameter names only", () => {
        expect(canonicalizePath("/users/:id")).toBe(
          canonicalizePath("/users/:name"),
        );
      });

      it("should be true for named wildcard paths that differ by wildcard names only", () => {
        expect(canonicalizePath("/files/*path")).toBe(
          canonicalizePath("/files/*rest"),
        );
      });

      it("should be false for paths of a different shape", () => {
        expect(canonicalizePath("/files/:id")).not.toBe(
          canonicalizePath("/files/:name.:ext"),
        );
        expect(canonicalizePath("/users/me")).not.toBe(
          canonicalizePath("/users/:id"),
        );
        expect(canonicalizePath("/users/:id")).not.toBe(
          canonicalizePath("/users/:id{.:ext}"),
        );
      });
    });

    describe("detect", () => {
      it("should flag two identical routes as a duplicate", () => {
        const conflicts = detectConflictsViaScanner([
          { path: "/users/me", methodName: "findOne" },
          { path: "/users/me", methodName: "somethingElse" },
        ]);

        expect(conflicts).toHaveLength(1);
        expect(conflicts[0]?.kind).toBe("duplicate");
      });

      it("should flag overlapping but non-identical routes as a shadow", () => {
        const conflicts = detectConflictsViaScanner([
          { path: "/users/:userId", methodName: "findOne" },
          { path: "/users/me", methodName: "findMe" },
        ]);

        expect(conflicts).toHaveLength(1);
        expect(conflicts[0]?.kind).toBe("shadow");
      });

      it("should not flag routes on different HTTP methods", () => {
        const conflicts = detectConflictsViaScanner([
          { path: "/users/:userId", method: RequestMethod.GET },
          { path: "/users/me", method: RequestMethod.POST },
        ]);

        expect(conflicts).toHaveLength(0);
      });

      it("should not flag routes on different hosts", () => {
        const conflicts = detectConflictsViaScanner([
          { path: "/users/:userId", host: "api.example.com" },
          { path: "/users/me", host: "admin.example.com" },
        ]);

        expect(conflicts).toHaveLength(0);
      });

      it("should not flag routes on different versions when versioning is header-based", () => {
        const versioningOptions: VersioningOptions = {
          type: VersioningType.HEADER,
          header: "Accept-Version",
        };
        const conflicts = detectConflictsViaScanner(
          [
            { path: "/users/me", version: "1" },
            { path: "/users/me", version: "2" },
          ],
          versioningOptions,
        );

        expect(conflicts).toHaveLength(0);
      });

      it("should flag overlap as a shadow (not duplicate) when one of the two header-versioned routes is version-neutral", () => {
        const versioningOptions: VersioningOptions = {
          type: VersioningType.HEADER,
          header: "Accept-Version",
        };
        const conflicts = detectConflictsViaScanner(
          [
            { path: "/users/me", version: VERSION_NEUTRAL },
            { path: "/users/me", version: "1" },
          ],
          versioningOptions,
        );

        expect(conflicts).toHaveLength(1);
        expect(conflicts[0]?.kind).toBe("shadow");
      });

      it("should flag overlap as a shadow when a hostless route faces a host-specific route on the same path", () => {
        const conflicts = detectConflictsViaScanner([
          { path: "/users/me" },
          { path: "/users/me", host: "api.example.com", methodName: "meOnApi" },
        ]);

        expect(conflicts).toHaveLength(1);
        expect(conflicts[0]?.kind).toBe("shadow");
      });

      it("should detect host-array overlap when arrays share a value (set membership, not stringified equality)", () => {
        const conflicts = detectConflictsViaScanner([
          { path: "/users/me", host: ["api.example.com", "admin.example.com"] },
          {
            path: "/users/me",
            host: ["admin.example.com"],
            methodName: "meOnAdmin",
          },
        ]);

        expect(conflicts).toHaveLength(1);
        expect(conflicts[0]?.kind).toBe("shadow");
      });

      it("should not flag host arrays with no shared value as overlapping", () => {
        const conflicts = detectConflictsViaScanner([
          { path: "/users/me", host: ["api.example.com"] },
          { path: "/users/me", host: ["admin.example.com"] },
        ]);

        expect(conflicts).toHaveLength(0);
      });

      it("should detect host overlap between a RegExp host and a string host the RegExp matches", () => {
        const conflicts = detectConflictsViaScanner([
          { path: "/users/me", host: /\.example\.com$/ },
          { path: "/users/me", host: "api.example.com", methodName: "meOnApi" },
        ]);

        expect(conflicts).toHaveLength(1);
        expect(conflicts[0]?.kind).toBe("shadow");
      });

      it("should detect host overlap consistently when the RegExp host has the g flag (stateful lastIndex)", () => {
        const globalRegExp = /\.example\.com$/g;
        const conflicts = detectConflictsViaScanner([
          { path: "/users/me", host: globalRegExp, methodName: "regex" },
          { path: "/users/me", host: "api.example.com", methodName: "meOnApi" },
          {
            path: "/users/me",
            host: "admin.example.com",
            methodName: "meOnAdmin",
          },
        ]);

        expect(conflicts).toHaveLength(2);
      });

      it.each<[string | RegExp, string | RegExp]>([
        [":tenant.example.com", "admin.example.com"],
        ["admin.example.com", ":tenant.example.com"],
        ["{www.}example.com", "www.example.com"],
        [":tenant.example.com", "ADMIN.example.com"],
        ["{www.}example.com", ":tenant.example.com"],
        ["Admin.example.com", "admin.example.com"],
        [/^www\./, "{www.}example.com"],
      ])(
        "should detect host overlap between %s and %s, which match a host in common",
        (earlierHost, laterHost) => {
          const conflicts = detectConflictsViaScanner([
            { path: "/users", host: earlierHost },
            { path: "/users", host: laterHost, methodName: "findAll" },
          ]);

          expect(conflicts).toHaveLength(1);
          expect(conflicts[0]?.kind).toBe("shadow");
        },
      );

      it.each<[string | RegExp, string | RegExp]>([
        [":tenant.example.com", "example.com"],
        [":tenant.example.com", "admin.example.org"],
        [":tenant.example.com", ":tenant.example.org"],
        ["api.:region.example.com", "admin.:region.example.com"],
        ["{www.}example.com", "api-:id.example.com"],
        ["{www.}example.com", "api.:region.example.com"],
        [/^api\./, "{www.}example.com"],
        [/^admin\.example\.com$/, ":tenant.example.org"],
        [":tenant.app.example.com", /^(www\.)?example\.com$/],
      ])(
        "should not flag the hosts %s and %s, which match no host in common",
        (earlierHost, laterHost) => {
          const conflicts = detectConflictsViaScanner([
            { path: "/users", host: earlierHost },
            { path: "/users", host: laterHost },
          ]);

          expect(conflicts).toHaveLength(0);
        },
      );

      it("should take the parameterized hosts :tenant.example.com and :account.example.com to overlap", () => {
        const conflicts = detectConflictsViaScanner([
          { path: "/users", host: ":tenant.example.com" },
          { path: "/users", host: ":account.example.com" },
        ]);

        expect(conflicts).toHaveLength(1);
      });

      it.each<[string | RegExp, string | RegExp]>([
        [":tenant.example.com", /\.example\.com$/],
        [/\.example\.com$/, ":tenant.example.com"],
        ["Admin.example.com", /^Admin\./],
      ])(
        "should take the hosts %s and %s to overlap",
        (earlierHost, laterHost) => {
          const conflicts = detectConflictsViaScanner([
            { path: "/users", host: earlierHost },
            { path: "/users", host: laterHost },
          ]);

          expect(conflicts).toHaveLength(1);
        },
      );

      it("should read each distinct host once per run", () => {
        const routes: TestRouteSpec[] = [
          ...Array.from({ length: 5 }, (_, index) => ({
            path: `/users/${index}`,
            host: ":tenant.example.com",
          })),
          { path: "/users/0", host: "admin.example.com" },
        ];
        expect(detectConflictsViaScanner(routes)).toHaveLength(1);
      });

      it("should classify identical host arrays declared in different order as a duplicate", () => {
        const conflicts = detectConflictsViaScanner([
          { path: "/users/me", host: ["api.example.com", "admin.example.com"] },
          {
            path: "/users/me",
            host: ["admin.example.com", "api.example.com"],
            methodName: "meAgain",
          },
        ]);

        expect(conflicts).toHaveLength(1);
        expect(conflicts[0]?.kind).toBe("duplicate");
      });

      it.each<[string[], string[]]>([
        [
          ["api.example.com", "api.example.com"],
          ["api.example.com", "admin.example.com"],
        ],
        [
          ["api.example.com", "admin.example.com"],
          ["api.example.com", "api.example.com"],
        ],
      ])(
        "should classify host arrays %j and %j as a shadow, not a duplicate",
        (earlierHosts, laterHosts) => {
          const conflicts = detectConflictsViaScanner([
            { path: "/users/me", host: earlierHosts },
            { path: "/users/me", host: laterHosts, methodName: "meAgain" },
          ]);

          expect(conflicts).toHaveLength(1);
          expect(conflicts[0]?.kind).toBe("shadow");
        },
      );

      it("should classify a host array with a repeated value as a duplicate of the same hosts listed once", () => {
        const conflicts = detectConflictsViaScanner([
          { path: "/users/me", host: ["api.example.com", "api.example.com"] },
          {
            path: "/users/me",
            host: ["api.example.com"],
            methodName: "meAgain",
          },
        ]);

        expect(conflicts).toHaveLength(1);
        expect(conflicts[0]?.kind).toBe("duplicate");
      });

      it("should compare across multiple routes only once per unique pair", () => {
        const conflicts = detectConflictsViaScanner([
          { path: "/users/me", methodName: "first" },
          { path: "/users/me", methodName: "second" },
          { path: "/users/me", methodName: "third" },
        ]);

        // pairs: (1,2), (1,3), (2,3) — three conflicts, not six.
        expect(conflicts).toHaveLength(3);
      });
    });

    describe("handle", () => {
      const sandbox = createSandbox();
      let logger: Logger;
      let warnSpy: SinonLikeStub;

      beforeEach(() => {
        logger = new Logger("test");
        warnSpy = sandbox.stub(logger, "warn").returns(undefined);
      });

      afterEach(() => {
        sandbox.restore();
      });

      it("should do nothing when there are no conflicts", () => {
        scanControllers([makeController({ path: "/users/me" })], {
          routeConflictPolicy: { duplicate: "error", shadow: "error" },
          logger,
        });
        expect(warnSpy.callCount).toBe(0);
      });

      itAdapted(
        "ADR-011",
        "should remain silent on shadows when policy is undefined (default fails fast on duplicates only)",
        () => {
          scanControllers(
            [
              makeController({ path: "/users/:userId" }),
              makeController({ path: "/users/me" }),
            ],
            { routeConflictPolicy: undefined, logger },
          );
          expect(warnSpy.callCount).toBe(0);
        },
        "default Bunest policy is { duplicate: 'error', shadow: 'off' } per ADR-011",
      );

      it("should warn once per shadow conflict when shadow policy is 'warn'", () => {
        const policy: RouteConflictPolicy = { shadow: "warn" };
        scanControllers(
          [
            makeController({ path: "/users/:userId" }),
            makeController({ path: "/users/me" }),
          ],
          { routeConflictPolicy: policy, logger },
        );

        expect(warnSpy.callCount).toBe(1);
        const loggedMessage = String(warnSpy.firstCall?.args[0] ?? "");
        expect(loggedMessage.toLowerCase()).toContain("shadow");
        expect(loggedMessage).toContain("/users/me");
        expect(loggedMessage).toContain("/users/:userId");
      });

      it("should remain silent when the matching kind is set to 'off'", () => {
        const policy: RouteConflictPolicy = {
          duplicate: "warn",
          shadow: "off",
        };
        scanControllers(
          [
            makeController({ path: "/users/:userId" }),
            makeController({ path: "/users/me" }),
          ],
          { routeConflictPolicy: policy, logger },
        );

        expect(warnSpy.callCount).toBe(0);
      });

      it("should throw a DuplicateRouteException when policy is 'error'", () => {
        const policy: RouteConflictPolicy = { duplicate: "error" };
        let capturedError: DuplicateRouteException | undefined;
        try {
          scanControllers(
            [
              makeController({ path: "/users/me" }),
              makeController({ path: "/users/me", methodName: "findMeAlias" }),
            ],
            { routeConflictPolicy: policy, logger },
          );
        } catch (error) {
          capturedError = error as DuplicateRouteException;
        }
        expect(capturedError).toBeInstanceOf(DuplicateRouteException);
        expect(capturedError?.message).toMatch(/Duplicate route/);
      });

      it("should aggregate every error-policy conflict into one exception", () => {
        const policy: RouteConflictPolicy = {
          duplicate: "error",
          shadow: "error",
        };
        let capturedError: Error | undefined;
        try {
          scanControllers(
            [
              makeController({ path: "/users/me" }),
              makeController({ path: "/users/me", methodName: "findMeAlias" }),
              makeController({ path: "/users/:userId" }),
              makeController({ path: "/users/admin" }),
            ],
            { routeConflictPolicy: policy, logger },
          );
        } catch (error) {
          capturedError = error as Error;
        }

        expect(capturedError).toBeInstanceOf(DuplicateRouteException);
        expect(capturedError?.message).toContain("Duplicate route");
        expect(capturedError?.message.toLowerCase()).toContain("shadow");
      });

      it("should mix warn and error policies when the kinds differ", () => {
        const policy: RouteConflictPolicy = {
          duplicate: "error",
          shadow: "warn",
        };
        let capturedError: Error | undefined;
        try {
          scanControllers(
            [
              makeController({ path: "/users/:userId" }),
              makeController({ path: "/users/me" }),
              makeController({ path: "/orders/:id" }),
              makeController({ path: "/orders/:id", methodName: "sameAgain" }),
            ],
            { routeConflictPolicy: policy, logger },
          );
        } catch (error) {
          capturedError = error as Error;
        }
        expect(capturedError).toBeInstanceOf(DuplicateRouteException);
        expect(capturedError?.message).toMatch(/Duplicate route/);
        expect(warnSpy.callCount).toBe(1);
      });
    });

    describe("filterSortResolvedShadows (via specificity strategy)", () => {
      it("should drop a shadow whose winner was promoted by the sort", () => {
        const conflicts = detectConflictsViaScanner(
          [{ path: "/users/:userId" }, { path: "/users/me" }],
          undefined,
          "specificity",
        );
        expect(conflicts).toHaveLength(0);
      });

      it("should keep a genuine conflict between two same-shape param routes", () => {
        const conflicts = detectConflictsViaScanner(
          [
            { path: "/users/:userId", methodName: "findById" },
            { path: "/users/:slug", methodName: "findBySlug" },
          ],
          undefined,
          "specificity",
        );
        expect(conflicts).toHaveLength(1);
      });

      it("should always keep duplicate conflicts regardless of declaration order", () => {
        const conflicts = detectConflictsViaScanner(
          [
            { path: "/users/me", methodName: "a" },
            { path: "/users/me", methodName: "b" },
          ],
          undefined,
          "specificity",
        );
        expect(conflicts).toHaveLength(1);
        expect(conflicts[0]?.kind).toBe("duplicate");
      });

      it("should keep genuine conflicts and drop sort-resolved shadows in the same list", () => {
        const conflicts = detectConflictsViaScanner(
          [
            { path: "/users/:userId", methodName: "byId" },
            { path: "/users/me", methodName: "me" },
            { path: "/accounts/:accountId", methodName: "a" },
            { path: "/accounts/:slug", methodName: "b" },
            { path: "/orders/:id", methodName: "c" },
            { path: "/orders/:id", methodName: "d" },
          ],
          undefined,
          "specificity",
        );
        expect(conflicts).toHaveLength(2);
      });

      it("should return an empty list when given an empty routes array", () => {
        const conflicts = detectConflictsViaScanner(
          [],
          undefined,
          "specificity",
        );
        expect(conflicts).toHaveLength(0);
      });
    });
  },
);
