import { describe, expect, it } from "bun:test";
import {
  Controller,
  Get,
  type Type,
} from "../../../../../../packages/core/src/common";
import {
  scanControllers,
  type ScannedRoute,
} from "../../../../../../packages/core/src/http";
import { describeConformance } from "../../../../_helpers";

interface RouteSpec {
  readonly path: string;
  readonly methodName?: string;
}

function makeControllerForRoute(spec: RouteSpec): Type<unknown> {
  const methodName = spec.methodName ?? "handler";

  @Controller()
  class DynamicController {}

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
  Get(spec.path)(DynamicController.prototype, methodName, descriptor);

  return DynamicController;
}

function sortBySpecificity(specs: readonly RouteSpec[]): ScannedRoute[] {
  const controllers = specs.map(makeControllerForRoute);
  return scanControllers(controllers, {
    routeResolutionStrategy: "specificity",
    routeConflictPolicy: "allow",
  });
}

const pathsOf = (routes: readonly ScannedRoute[]): string[] =>
  routes.map((route) => route.fullPath);

describeConformance(
  "RouteSpecificitySorter (via @bunest/http scanControllers specificity strategy)",
  {
    upstreamPath: "packages/core/test/router/route-specificity-sorter.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-011"],
    notes:
      "Adapted from NestJS internal RouteSpecificitySorter to @bunest/http scanControllers(..., { routeResolutionStrategy: 'specificity' }).",
  },
  () => {
    describe("sort", () => {
      it("should put a static route before a parametric route at the same length", () => {
        const sorted = sortBySpecificity([
          { path: "/users/:userId" },
          { path: "/users/me" },
        ]);

        expect(pathsOf(sorted)).toEqual(["/users/me", "/users/:userId"]);
      });

      it("should put a parametric route before a wildcard route at the same length", () => {
        const sorted = sortBySpecificity([
          { path: "/users/*rest" },
          { path: "/users/:userId" },
        ]);

        expect(pathsOf(sorted)).toEqual(["/users/:userId", "/users/*rest"]);
      });

      it("should treat adapter-normalized wildcard groups as wildcard routes", () => {
        const sorted = sortBySpecificity([
          { path: "/users/{*rest}" },
          { path: "/users/:userId" },
        ]);

        expect(pathsOf(sorted)).toEqual(["/users/:userId", "/users/{*rest}"]);
      });

      it("should fully order literal < param < wildcard across a triple", () => {
        const sorted = sortBySpecificity([
          { path: "/users/*rest" },
          { path: "/users/me" },
          { path: "/users/:userId" },
        ]);

        expect(pathsOf(sorted)).toEqual([
          "/users/me",
          "/users/:userId",
          "/users/*rest",
        ]);
      });

      it("should keep declaration order when specificities tie", () => {
        const sorted = sortBySpecificity([
          { path: "/users/me", methodName: "first" },
          { path: "/orders/list", methodName: "second" },
          { path: "/items/all", methodName: "third" },
        ]);

        expect(sorted.map((route) => route.handlerKey)).toEqual([
          "first",
          "second",
          "third",
        ]);
      });

      it("should prefer the path that is more specific at the earliest differing segment", () => {
        const sorted = sortBySpecificity([
          { path: "/users/:userId/orders" },
          { path: "/users/me/:resource" },
        ]);

        expect(pathsOf(sorted)).toEqual([
          "/users/me/:resource",
          "/users/:userId/orders",
        ]);
      });

      it("should treat a shorter path as less specific than a longer one when the missing segment slot decides it", () => {
        const sorted = sortBySpecificity([
          { path: "/users" },
          { path: "/users/me" },
        ]);

        expect(pathsOf(sorted)).toEqual(["/users/me", "/users"]);
      });

      it.each([
        ["/", "/{*path}"],
        ["/api", "/api{/*path}"],
        ["/users", "/users{/:userId}"],
        ["/files", "/files/{*path}"],
        ["/report", "/report{.:format}"],
      ])(
        "should put `%s` before `%s`, whose optional group also matches it",
        (exactPath, optionalGroupPath) => {
          const sorted = sortBySpecificity([
            { path: optionalGroupPath },
            { path: exactPath },
          ]);

          expect(pathsOf(sorted)).toEqual([exactPath, optionalGroupPath]);
        },
      );

      it("should put a literal before a segment that mixes text and params", () => {
        const sorted = sortBySpecificity([
          { path: "/v:version/items" },
          { path: "/v1/items" },
        ]);

        expect(pathsOf(sorted)).toEqual(["/v1/items", "/v:version/items"]);
      });

      it("should put a segment that mixes text and params before a param", () => {
        const sorted = sortBySpecificity([
          { path: "/files/:fileId" },
          { path: "/files/:name.:ext" },
        ]);

        expect(pathsOf(sorted)).toEqual([
          "/files/:name.:ext",
          "/files/:fileId",
        ]);
      });

      it("should keep declaration order between a param and the same param with an optional suffix", () => {
        expect(
          pathsOf(
            sortBySpecificity([
              { path: "/users/:id" },
              { path: "/users/:id{.:format}" },
            ]),
          ),
        ).toEqual(["/users/:id", "/users/:id{.:format}"]);
        expect(
          pathsOf(
            sortBySpecificity([
              { path: "/users/:id{.:format}" },
              { path: "/users/:id" },
            ]),
          ),
        ).toEqual(["/users/:id{.:format}", "/users/:id"]);
      });

      it("should put the exact route before a catch-all declared ahead of it", () => {
        const sorted = sortBySpecificity([
          { path: "/users/{*path}" },
          { path: "/users/:userId" },
          { path: "/users/me" },
          { path: "/users" },
        ]);

        expect(pathsOf(sorted)).toEqual([
          "/users/me",
          "/users",
          "/users/:userId",
          "/users/{*path}",
        ]);
      });

      it("should keep a shorter path with a wildcard after the longer paths it can absorb", () => {
        const sorted = sortBySpecificity([
          { path: "/files/*rest" },
          { path: "/files/*rest/:action" },
        ]);

        expect(pathsOf(sorted)).toEqual([
          "/files/*rest/:action",
          "/files/*rest",
        ]);
      });

      it("should not mutate the input array", () => {
        const c1 = makeControllerForRoute({ path: "/users/:userId" });
        const c2 = makeControllerForRoute({ path: "/users/me" });
        const input = [c1, c2];

        scanControllers(input, {
          routeResolutionStrategy: "specificity",
          routeConflictPolicy: "allow",
        });

        expect(input).toEqual([c1, c2]);
      });

      it("should return references to the same controller and handler (no defensive copy)", () => {
        const c1 = makeControllerForRoute({
          path: "/users/:userId",
          methodName: "byId",
        });
        const c2 = makeControllerForRoute({
          path: "/users/me",
          methodName: "me",
        });

        const sorted = scanControllers([c1, c2], {
          routeResolutionStrategy: "specificity",
          routeConflictPolicy: "allow",
        });

        expect(sorted[0]?.controller).toBe(c2);
        expect(sorted[1]?.controller).toBe(c1);
      });

      it("should handle an empty input", () => {
        expect(
          scanControllers([], {
            routeResolutionStrategy: "specificity",
            routeConflictPolicy: "allow",
          }),
        ).toEqual([]);
      });

      it("should handle a single-element input by returning it unchanged", () => {
        const sorted = sortBySpecificity([{ path: "/users/me" }]);
        expect(pathsOf(sorted)).toEqual(["/users/me"]);
      });
    });
  },
);
