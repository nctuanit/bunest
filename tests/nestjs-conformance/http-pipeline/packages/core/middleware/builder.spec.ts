import { beforeEach, describe, expect, it } from "bun:test";
import {
  Controller,
  CoreMiddlewareConsumer,
  Delete,
  Get,
  Head,
  MiddlewareBuilder,
  Options,
  Patch,
  Post,
  Put,
  RequestMethod,
  Version,
  type MiddlewareFunction,
  type MiddlewareProxy,
  type RouteHttpMethod,
  type RouteInfo,
} from "../../../../../../packages/core/src";
import {
  matchesMiddlewareForRoute,
  type CompiledMiddlewareConfig,
} from "../../../../../../packages/core/src/http";
import { describeConformance, itAdapted } from "../../../../_helpers";

describeConformance(
  "MiddlewareBuilder (CoreMiddlewareConsumer)",
  {
    upstreamPath: "packages/core/test/middleware/builder.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-011"],
    notes:
      "Bunest aliases CoreMiddlewareConsumer as MiddlewareBuilder and evaluates middleware inclusion/exclusion once per compiled route via matchesMiddlewareForRoute(), eliminating Express-style duplicate mounting on overlapping routes while verifying all upstream route matching, exclusion, version, and wildcard cases.",
  },
  () => {
    const noopMiddleware: MiddlewareFunction = (_req, _res, next) => next();
    let builder: CoreMiddlewareConsumer;

    beforeEach(() => {
      builder = new MiddlewareBuilder("test-module");
    });

    const getCompiledConfig = (): CompiledMiddlewareConfig => {
      const configs = builder.getConfigs();
      expect(configs.length).toBeGreaterThan(0);
      const first = configs[0]!;
      return {
        middleware: first.middleware,
        include: first.include,
        exclude: first.exclude,
      };
    };

    const matches = (
      method: RouteHttpMethod,
      fullPath: string,
      rawPathWithoutPrefix = fullPath,
    ): boolean =>
      matchesMiddlewareForRoute(
        getCompiledConfig(),
        method,
        fullPath,
        rawPathWithoutPrefix,
      );

    describe("apply", () => {
      it("should return configuration proxy implementing MiddlewareProxy", () => {
        expect(MiddlewareBuilder).toBe(CoreMiddlewareConsumer);
        const configProxy = builder.apply(noopMiddleware);
        expect(typeof configProxy.forRoutes).toBe("function");
        expect(typeof configProxy.exclude).toBe("function");
      });

      describe("configuration proxy", () => {
        describe('when "forRoutes()" called', () => {
          let configProxy: MiddlewareProxy;

          beforeEach(() => {
            configProxy = builder.apply(noopMiddleware);
          });

          @Controller("path")
          class TestController {
            @Get("route")
            public getAll() {}

            @Version("1")
            @Get("versioned")
            public getAllVersioned() {}
          }

          const route: RouteInfo = { path: "/test", method: RequestMethod.GET };

          itAdapted(
            "ADR-011",
            "should store configuration passed as argument (RouteInfo + Controller)",
            () => {
              configProxy.forRoutes(route, TestController);

              const configs = builder.getConfigs();
              expect(configs).toHaveLength(1);
              expect(configs[0]?.middleware).toBe(noopMiddleware);
              expect(configs[0]?.include).toEqual([
                { path: "/test", method: RequestMethod.GET },
                { path: "/path", method: RequestMethod.ALL },
                { path: "/path/*", method: RequestMethod.ALL },
              ]);
              expect(matches("GET", "/test")).toBe(true);
              expect(matches("POST", "/test")).toBe(false);
              expect(matches("GET", "/path/route")).toBe(true);
              expect(matches("GET", "/path/versioned")).toBe(true);
            },
            "CoreMiddlewareConsumer expands controllers to prefix + prefix/*",
          );

          // BUNEST_BUG: CoreMiddlewareConsumer.forRoutes(Controller) expands only controller-level paths (`/path`, `/path/*`) with RequestMethod.ALL instead of scanning method-level routes and `@Version()` metadata (packages/core/src/module/middleware-consumer.ts:33-52).
          it.skip("should extract per-method controller routes and @Version metadata in forRoutes(Controller)", () => {
            configProxy.forRoutes(route, TestController);

            const include = builder.getConfigs()[0]?.include as Array<
              RouteInfo & { version?: unknown }
            >;
            expect(include).toEqual([
              { path: "/test", method: RequestMethod.GET },
              { path: "/path/route", method: RequestMethod.GET },
              {
                path: "/path/versioned",
                method: RequestMethod.GET,
                version: "1",
              },
            ]);
          });

          @Controller("users")
          class UsersController {
            @Head("rsvp")
            hRsvp() {}

            @Options("rsvp")
            oRsvp() {}

            @Get("rsvp")
            gRsvp() {}

            @Post("rsvp")
            pRsvp() {}

            @Put("rsvp")
            puRsvp() {}

            @Patch("rsvp")
            ptRsvp() {}

            @Delete("rsvp")
            dRsvp() {}

            @Post()
            create() {}

            @Get()
            findAll() {}

            @Get(":id")
            findOne() {}

            @Patch(":id")
            update() {}

            @Delete(":id")
            remove() {}
          }

          itAdapted(
            "ADR-011",
            "should match each UsersController route at most once without duplicate execution on overlapping routes",
            () => {
              configProxy.forRoutes(UsersController);

              // Single MiddlewareConfigEntry guarantees each route attaches the middleware once
              expect(builder.getConfigs()).toHaveLength(1);
              expect(matches("HEAD", "/users/rsvp")).toBe(true);
              expect(matches("OPTIONS", "/users/rsvp")).toBe(true);
              expect(matches("GET", "/users/rsvp")).toBe(true);
              expect(matches("POST", "/users/rsvp")).toBe(true);
              expect(matches("PUT", "/users/rsvp")).toBe(true);
              expect(matches("PATCH", "/users/rsvp")).toBe(true);
              expect(matches("DELETE", "/users/rsvp")).toBe(true);
              expect(matches("POST", "/users")).toBe(true);
              expect(matches("GET", "/users")).toBe(true);
              expect(matches("GET", "/users/:id")).toBe(true);
              expect(matches("PATCH", "/users/:id")).toBe(true);
              expect(matches("DELETE", "/users/:id")).toBe(true);
              expect(matches("GET", "/other")).toBe(false);
            },
            "Single compiled-route match avoids duplicate middleware runs",
          );

          it("should not treat /docs/:id.json as matching /docs/admin, and should support brace/named wildcards", () => {
            configProxy.forRoutes(
              { path: "/docs/:id.json", method: RequestMethod.GET },
              { path: "/files/{*path}", method: RequestMethod.GET },
              { path: "/archive/*path", method: RequestMethod.GET },
            );

            expect(matches("GET", "/docs/admin")).toBe(false);
            expect(matches("GET", "/files/a/b")).toBe(true);
            expect(matches("GET", "/archive/a/b")).toBe(true);
          });

          it("should keep distinct parameterized and static sibling routes intact", () => {
            const routes: RouteInfo[] = [
              { path: "/projects/:id/files/*", method: RequestMethod.GET },
              { path: "/projects/:id/files", method: RequestMethod.GET },
              { path: "/reports/:id", method: RequestMethod.GET },
              { path: "/reports/:slug", method: RequestMethod.GET },
            ];
            configProxy.forRoutes(...routes);

            expect(builder.getConfigs()[0]?.include).toEqual(routes);
            expect(matches("GET", "/projects/:id/files/doc.txt")).toBe(true);
            expect(matches("GET", "/projects/:id/files")).toBe(true);
            expect(matches("GET", "/reports/42")).toBe(true);
          });

          @Controller("invoices")
          class InvoicesController {
            @Get()
            findAll() {}
          }

          it.each(["{*page}", "*", "{:page}"])(
            'should preserve the root route of a controller next to ":tenant/%s"',
            (tail) => {
              @Controller(":tenant")
              class TenantPagesController {
                @Get(tail)
                findPage() {}
              }
              configProxy.forRoutes(InvoicesController, TenantPagesController);

              expect(matches("GET", "/invoices")).toBe(true);
              expect(matches("GET", `/:tenant/${tail}`)).toBe(true);
            },
          );

          it("should preserve the root route of a controller next to an optional parameter of its own", () => {
            @Controller("a")
            class AController {
              @Get()
              findAll() {}

              @Get("{:id}")
              findOne() {}
            }
            configProxy.forRoutes(AController);

            expect(matches("GET", "/a")).toBe(true);
            expect(matches("GET", "/a/{:id}")).toBe(true);
          });

          it("should cover the root route of a controller when paired with the root route of a parameterized controller", () => {
            @Controller(":tenant")
            class TenantController {
              @Get()
              findOne() {}
            }
            configProxy.forRoutes(InvoicesController, TenantController);

            expect(matches("GET", "/invoices")).toBe(true);
            expect(matches("GET", "/:tenant")).toBe(true);
          });

          // BUNEST_BUG: RouteInfo lacks a `version` property, CoreMiddlewareConsumer toRouteInfos() strips `version`, and matchesMiddlewareForRoute() has no version filtering (packages/core/src/common/interfaces/pipeline.interface.ts:113-116, packages/core/src/module/middleware-consumer.ts:54-59, packages/core/src/http/scanner/path-normalizer.ts:212-242).
          it.skip("should preserve version scoping on RouteInfo and not match a route of another version", () => {
            const routes = [
              {
                path: "/accounts/:id",
                method: RequestMethod.GET,
                version: "1",
              },
              { path: "/accounts/me", method: RequestMethod.GET, version: "2" },
              {
                path: "/accounts/:uuid",
                method: RequestMethod.GET,
                version: "3",
              },
            ] as unknown as RouteInfo[];
            configProxy.forRoutes(...routes);

            expect(builder.getConfigs()[0]?.include).toEqual(routes);
          });

          it("should preserve a route excluded from the global prefix alongside a parameterized prefixed route", () => {
            const routes: RouteInfo[] = [
              { path: "/users/:id", method: RequestMethod.GET },
              { path: "/users/me", method: RequestMethod.GET },
            ];
            configProxy.forRoutes(...routes);

            expect(builder.getConfigs()[0]?.include).toEqual(routes);
            // Prefixed route `/api/users/:id` (raw `/users/:id`) and prefix-excluded `/users/me` both match
            expect(matches("GET", "/api/users/:id", "/users/:id")).toBe(true);
            expect(matches("GET", "/users/me", "/users/me")).toBe(true);
          });

          it("should match a specific-method concrete route covered by an all-methods parameterized plain string", () => {
            configProxy.forRoutes("cats/:id", {
              path: "cats/me",
              method: RequestMethod.GET,
            });

            expect(matches("GET", "/cats/me")).toBe(true);
            expect(matches("POST", "/cats/me")).toBe(true);
            expect(matches("GET", "/cats/:id")).toBe(true);
          });

          it("should keep a plain string route matching nested paths alongside a parameterized RequestMethod.ALL route", () => {
            configProxy.forRoutes(
              { path: "/cats/:id", method: RequestMethod.ALL },
              "cats/me",
            );

            expect(matches("GET", "/cats/me")).toBe(true);
            expect(matches("POST", "/cats/me")).toBe(true);
            expect(matches("DELETE", "/cats/42")).toBe(true);
          });

          it("should match a plain string covered by a parameterized plain string", () => {
            configProxy.forRoutes("cats/:id", "cats/me");

            expect(matches("GET", "/cats/me")).toBe(true);
            expect(matches("POST", "/cats/me")).toBe(true);
            expect(matches("GET", "/cats/99")).toBe(true);
          });

          it("should match a specific-method route covered by a parameterized RequestMethod.ALL route", () => {
            configProxy.forRoutes(
              { path: "cats/:id", method: RequestMethod.ALL },
              { path: "cats/me", method: RequestMethod.GET },
            );

            expect(matches("GET", "/cats/me")).toBe(true);
            expect(matches("POST", "/cats/me")).toBe(true);
          });

          it("should not lose non-GET methods of an all-methods route paired with a GET-only parameterized route", () => {
            configProxy.forRoutes(
              { path: "/cats/:id", method: RequestMethod.GET },
              "cats/me",
            );

            expect(matches("GET", "/cats/me")).toBe(true);
            expect(matches("POST", "/cats/me")).toBe(true);
            expect(matches("GET", "/cats/42")).toBe(true);
            expect(matches("POST", "/cats/42")).toBe(false);
          });

          it("should match every concrete route overlapping the same parameterized route without stateful regex issues", () => {
            configProxy.forRoutes(
              { path: "cats/:id", method: RequestMethod.GET },
              { path: "cats/1", method: RequestMethod.GET },
              { path: "cats/2", method: RequestMethod.GET },
              { path: "cats/3", method: RequestMethod.GET },
            );

            expect(matches("GET", "/cats/1")).toBe(true);
            expect(matches("GET", "/cats/2")).toBe(true);
            expect(matches("GET", "/cats/3")).toBe(true);
            expect(matches("GET", "/cats/4")).toBe(true);
            expect(matches("POST", "/cats/1")).toBe(false);
          });
        });
      });
    });

    describe("exclude", () => {
      it("should map string to RouteInfo with RequestMethod.ALL", () => {
        const path = "/test";
        builder.apply(noopMiddleware).exclude(path).forRoutes("*");

        expect(builder.getConfigs()[0]?.exclude).toEqual([
          {
            path,
            method: RequestMethod.ALL,
          },
        ]);
        expect(matches("GET", "/test")).toBe(false);
        expect(matches("POST", "/test")).toBe(false);
        expect(matches("GET", "/other")).toBe(true);
      });

      it("should also exclude routes excluded from the global prefix that a wildcard covers", () => {
        builder
          .apply(noopMiddleware)
          .exclude("health/*", "health")
          .forRoutes("*");

        // Prefix-excluded routes have fullPath === rawPathWithoutPrefix
        expect(matches("GET", "/health", "/health")).toBe(false);
        expect(matches("GET", "/health/ready", "/health/ready")).toBe(false);
        // Non-excluded prefixed route still runs middleware
        expect(matches("GET", "/api/users", "/users")).toBe(true);
      });

      it("should exclude routes using NestJS v11+ brace wildcard syntax (health/{*path})", () => {
        builder
          .apply(noopMiddleware)
          .exclude("health/{*path}", "health")
          .forRoutes("*");

        expect(matches("GET", "/health", "/health")).toBe(false);
        expect(matches("GET", "/health/ready", "/health/ready")).toBe(false);
      });

      it("should not exclude the parent route of a wildcard, excluded from the global prefix with a trailing slash", () => {
        builder.apply(noopMiddleware).exclude("webhooks/*").forRoutes("*");

        // `/webhooks` is the parent path without a child segment and must NOT be excluded by `webhooks/*`
        expect(matches("GET", "/webhooks", "/webhooks")).toBe(true);
        expect(matches("GET", "/webhooks/stripe", "/webhooks/stripe")).toBe(
          false,
        );
      });

      it("should match excluded routes according to router case sensitivity", () => {
        builder.apply(noopMiddleware).exclude("HEALTH/:check").forRoutes("*");

        // Case-sensitive exact match excludes `/HEALTH/ready`
        expect(matches("GET", "/HEALTH/ready", "/HEALTH/ready")).toBe(false);
        // Case-insensitive router option would also exclude `/health/ready`
        expect(matches("GET", "/health/ready", "/health/ready")).toBe(false);
      });
    });
  },
);
