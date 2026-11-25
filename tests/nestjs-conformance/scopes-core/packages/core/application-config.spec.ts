import { beforeEach, describe, expect, it } from "bun:test";
import {
  Logger,
  RequestMethod,
  VersioningType,
} from "../../../../../packages/core/src/common";
import { ApplicationConfig } from "../../../../../packages/core/src";
import type { GlobalPrefixOptions } from "../../../../../packages/core/src/http";
import { describeConformance, spyOnMethod } from "../../../_helpers";

describeConformance(
  "ApplicationConfig",
  {
    upstreamPath: "packages/core/test/application-config.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008"],
    notes:
      "Tests @bunest/core ApplicationConfig public API parity against NestJS ApplicationConfig.",
  },
  () => {
    let appConfig: ApplicationConfig;

    beforeEach(() => {
      appConfig = new ApplicationConfig();
    });

    describe("globalPath", () => {
      it("should set global path", () => {
        const path = "test";
        appConfig.setGlobalPrefix(path);

        expect(appConfig.getGlobalPrefix()).toEqual(path);
      });

      it("should set global path options", () => {
        const options: GlobalPrefixOptions = {
          exclude: [
            {
              path: "/health",
              method: RequestMethod.GET,
            },
          ],
        };
        appConfig.setGlobalPrefixOptions(options);

        expect(appConfig.getGlobalPrefixOptions()).toEqual(options);
      });

      it("should have empty string as a global path by default", () => {
        expect(appConfig.getGlobalPrefix()).toEqual("");
      });

      it("should have empty object as a global path option by default", () => {
        expect(appConfig.getGlobalPrefixOptions()).toEqual({});
      });
    });

    describe("IOAdapter", () => {
      it("should set io adapter", () => {
        const ioAdapter = { test: 0 };
        appConfig.setIoAdapter(ioAdapter as any);

        expect(appConfig.getIoAdapter()).toEqual(ioAdapter as any);
      });
    });

    describe("Pipes", () => {
      it("should set global pipes", () => {
        const pipes = [{ transform: () => 1 }, { transform: () => 2 }];
        appConfig.useGlobalPipes(...pipes);

        expect(appConfig.getGlobalPipes()).toEqual(pipes);
      });

      it("should add pipe", () => {
        const pipe = "testOne";
        appConfig.addGlobalPipe(pipe as any);

        expect(appConfig.getGlobalPipes()).toContain(pipe as any);
      });

      it("should add global request pipe", () => {
        const pipe = "testOne";
        (appConfig as any).addGlobalRequestPipe(pipe);

        expect((appConfig as any).getGlobalRequestPipes()).toContain(pipe);
      });
    });

    describe("Filters", () => {
      it("should set global filters", () => {
        const filters = [{ catch: () => 1 }, { catch: () => 2 }];
        appConfig.useGlobalFilters(...filters);

        expect(appConfig.getGlobalFilters()).toEqual(filters);
      });

      it("should add filter", () => {
        const filter = "testOne";
        appConfig.addGlobalFilter(filter as any);

        expect(appConfig.getGlobalFilters()).toContain(filter as any);
      });

      it("should add request filter", () => {
        const filter = "testOne";
        (appConfig as any).addGlobalRequestFilter(filter);

        expect((appConfig as any).getGlobalRequestFilters()).toContain(filter);
      });
    });

    describe("Guards", () => {
      it("should set global guards", () => {
        const guards = [
          { canActivate: () => true },
          { canActivate: () => false },
        ];
        appConfig.useGlobalGuards(...guards);

        expect(appConfig.getGlobalGuards()).toEqual(guards);
      });

      it("should add guard", () => {
        const guard = "testOne";
        appConfig.addGlobalGuard(guard as any);

        expect(appConfig.getGlobalGuards()).toContain(guard as any);
      });

      it("should add request guard", () => {
        const guard = "testOne";
        (appConfig as any).addGlobalRequestGuard(guard);

        expect((appConfig as any).getGlobalRequestGuards()).toContain(guard);
      });
    });

    describe("when a global enhancer is not an instance", () => {
      class AuthGuard {
        canActivate() {
          return true;
        }
      }

      it("should throw when given a class", () => {
        expect(() => appConfig.useGlobalGuards(AuthGuard as any)).toThrow(
          /\(class AuthGuard\)/,
        );
        expect(appConfig.getGlobalGuards()).toEqual([]);
      });

      it("should throw when given a promise", () => {
        const promiseGuard = Promise.resolve(new AuthGuard());
        expect(() => appConfig.useGlobalGuards(promiseGuard as any)).toThrow(
          /\(a promise\)/,
        );
        expect(appConfig.getGlobalGuards()).toEqual([]);
      });

      it("should throw when given an array", () => {
        expect(() =>
          appConfig.useGlobalGuards([new AuthGuard()] as any),
        ).toThrow(/\(an array\)/);
        expect(appConfig.getGlobalGuards()).toEqual([]);
      });

      it("should throw for pipes and interceptors too", () => {
        class SomePipe {}
        expect(() => appConfig.useGlobalPipes(SomePipe as any)).toThrow(
          /The pipe \(class SomePipe\) doesn't provide the "transform" method/,
        );
        expect(() => appConfig.useGlobalInterceptors({} as any)).toThrow(
          /The interceptor \(an object\)/,
        );
      });

      it("should only warn for an exception filter", () => {
        const warn = spyOnMethod(Logger.prototype, "warn");
        class HttpExceptionFilter {
          catch() {}
        }
        try {
          appConfig.useGlobalFilters(HttpExceptionFilter as any);
          expect(warn.callCount).toBe(1);
          expect(String(warn.args[0]?.[0])).toContain(
            "The exception filter (class HttpExceptionFilter)",
          );
          expect(appConfig.getGlobalFilters()).toEqual([
            HttpExceptionFilter as any,
          ]);
        } finally {
          warn.restore();
        }
      });

      it("should accept a class that has the method as a static", () => {
        class StaticGuard {
          static canActivate() {
            return true;
          }
        }
        appConfig.useGlobalGuards(StaticGuard as any);
        expect(appConfig.getGlobalGuards()).toEqual([StaticGuard as any]);
      });
    });

    describe("PreRequestHooks", () => {
      it("should set global preRequest hooks", () => {
        const hooks = [() => {}, () => {}];
        (appConfig as any).registerPreRequestHook(...hooks);

        expect((appConfig as any).getGlobalPreRequestHooks()).toEqual(hooks);
      });

      it("should accumulate multiple registerPreRequestHook calls", () => {
        const hook1 = () => {};
        const hook2 = () => {};
        (appConfig as any).registerPreRequestHook(hook1);
        (appConfig as any).registerPreRequestHook(hook2);

        expect((appConfig as any).getGlobalPreRequestHooks()).toEqual([
          hook1,
          hook2,
        ]);
      });
    });

    describe("Interceptors", () => {
      it("should set global interceptors", () => {
        const interceptors = [
          { intercept: async () => 1 },
          { intercept: async () => 2 },
        ];
        appConfig.useGlobalInterceptors(...(interceptors as any));

        expect(appConfig.getGlobalInterceptors()).toEqual(interceptors as any);
      });

      it("should add interceptor", () => {
        const interceptor = "testOne";
        appConfig.addGlobalInterceptor(interceptor as any);

        expect(appConfig.getGlobalInterceptors()).toContain(interceptor as any);
      });

      it("should add request interceptor", () => {
        const interceptor = "testOne";
        (appConfig as any).addGlobalRequestInterceptor(interceptor);

        expect((appConfig as any).getGlobalRequestInterceptors()).toContain(
          interceptor,
        );
      });
    });

    describe("Versioning", () => {
      it("should set versioning", () => {
        const options = { type: VersioningType.URI as const };
        appConfig.enableVersioning(options);

        expect(appConfig.getVersioning()).toEqual(options);
      });

      it("should ignore duplicated versions on defaultVersion array", () => {
        const options = {
          type: VersioningType.URI as const,
          defaultVersion: ["1", "2", "2", "1"],
        };
        appConfig.enableVersioning(options);

        expect(appConfig.getVersioning()!.defaultVersion).toEqual(["1", "2"]);
      });

      it("should have undefined as the versioning by default", () => {
        expect(appConfig.getVersioning()).toEqual(undefined);
      });

      it("should keep scalar defaultVersion unchanged", () => {
        const options = {
          type: VersioningType.URI as const,
          defaultVersion: "1",
        };
        appConfig.enableVersioning(options);

        expect(appConfig.getVersioning()!.defaultVersion).toEqual("1");
      });
    });

    describe("constructor", () => {
      it("should accept an ioAdapter argument", () => {
        const ioAdapter = { test: true } as any;
        const config = new ApplicationConfig(ioAdapter);

        expect(config.getIoAdapter()).toBe(ioAdapter);
      });

      it("should default ioAdapter to null", () => {
        const config = new ApplicationConfig();

        expect(config.getIoAdapter()).toBeNull();
      });
    });

    describe("accumulation", () => {
      it("should accumulate global pipes via useGlobalPipes and addGlobalPipe", () => {
        const pipes = [1, 2, 3].map(() => ({ transform: () => null }));
        appConfig.useGlobalPipes(pipes[0]!, pipes[1]!);
        appConfig.addGlobalPipe(pipes[2]!);

        expect(appConfig.getGlobalPipes()).toEqual(pipes);
      });

      it("should accumulate global filters via useGlobalFilters and addGlobalFilter", () => {
        const filters = [1, 2].map(() => ({ catch: () => null }));
        appConfig.useGlobalFilters(filters[0]!);
        appConfig.addGlobalFilter(filters[1]!);

        expect(appConfig.getGlobalFilters()).toEqual(filters);
      });

      it("should accumulate global guards via useGlobalGuards and addGlobalGuard", () => {
        const guards = [1, 2].map(() => ({ canActivate: () => true }));
        appConfig.useGlobalGuards(guards[0]!);
        appConfig.addGlobalGuard(guards[1]!);

        expect(appConfig.getGlobalGuards()).toEqual(guards);
      });

      it("should accumulate global interceptors via useGlobalInterceptors and addGlobalInterceptor", () => {
        const interceptors = [1, 2].map(() => ({
          intercept: async () => null,
        }));
        appConfig.useGlobalInterceptors(...(interceptors as any[]).slice(0, 1));
        appConfig.addGlobalInterceptor(interceptors[1] as any);

        expect(appConfig.getGlobalInterceptors()).toEqual(interceptors as any);
      });
    });

    describe("Route conflict policy", () => {
      it("should default to undefined", () => {
        expect((appConfig as any).getRouteConflictPolicy()).toEqual(undefined);
      });

      it("should store the provided policy", () => {
        const policy = { duplicate: "error", shadow: "warn" } as const;
        (appConfig as any).setRouteConflictPolicy(policy);

        expect((appConfig as any).getRouteConflictPolicy()).toEqual(policy);
      });

      it("should reset to undefined when explicitly cleared", () => {
        (appConfig as any).setRouteConflictPolicy({ duplicate: "warn" });
        (appConfig as any).setRouteConflictPolicy(undefined);

        expect((appConfig as any).getRouteConflictPolicy()).toEqual(undefined);
      });
    });

    describe("Route resolution strategy", () => {
      it("should default to undefined", () => {
        expect((appConfig as any).getRouteResolutionStrategy()).toEqual(
          undefined,
        );
      });

      it("should store the provided strategy", () => {
        (appConfig as any).setRouteResolutionStrategy("specificity");

        expect((appConfig as any).getRouteResolutionStrategy()).toEqual(
          "specificity",
        );
      });

      it("should reset to undefined when explicitly cleared", () => {
        (appConfig as any).setRouteResolutionStrategy("specificity");
        (appConfig as any).setRouteResolutionStrategy(undefined);

        expect((appConfig as any).getRouteResolutionStrategy()).toEqual(
          undefined,
        );
      });
    });
  },
);
