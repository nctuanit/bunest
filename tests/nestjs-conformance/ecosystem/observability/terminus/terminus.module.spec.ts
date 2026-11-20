import "reflect-metadata";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import {
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  type LoggerService,
} from "../../../../../packages/common/src";
import {
  HealthCheckException,
  HealthCheckService,
  HealthIndicatorService,
  TERMINUS_LOGGER,
  TERMINUS_MODULE_OPTIONS,
  TerminusModule,
  type TerminusAsyncModuleOptions,
  type TerminusModuleOptions,
  type TerminusOptionsFactory,
} from "../../../../../packages/observability/src";
import {
  Test,
  type TestingModule,
  describeConformance,
  itAdapted,
} from "../../../_helpers/index";

@Injectable()
class TerminusConfigService implements TerminusOptionsFactory {
  createTerminusOptions(): TerminusAsyncModuleOptions {
    return {
      errorLogStyle: "pretty",
      gracefulShutdownTimeoutMs: 0,
    };
  }
}

@Module({
  providers: [TerminusConfigService],
  exports: [TerminusConfigService],
})
class TerminusConfigModule {}

describeConformance(
  "TerminusModule",
  {
    upstreamPath: "terminus/lib/terminus.module.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001"],
    notes:
      "Adapts internal ERROR_LOGGER, NOOP_LOGGER, and HealthCheckExecutor checks to Bunest's TERMINUS_MODULE_OPTIONS, TERMINUS_LOGGER, and HealthCheckService.",
  },
  () => {
    const modules: TestingModule[] = [];

    const compile = async (
      metadata: Parameters<typeof Test.createTestingModule>[0],
    ) => {
      const mod = await Test.createTestingModule(metadata).compile({
        logger: false,
      });
      modules.push(mod);
      return mod;
    };

    afterEach(async () => {
      const logSpy = spyOn(Logger.prototype, "log").mockImplementation(
        () => {},
      );
      try {
        // Pass "SIGINT" so HealthCheckService.beforeApplicationShutdown() does
        // not block teardown for gracefulShutdownTimeoutMs (3000ms/5000ms).
        await Promise.all(modules.splice(0).map((m) => m.close("SIGINT")));
      } finally {
        logSpy.mockRestore();
      }
    });

    describe("forRoot", () => {
      it("should compile the module with default options", async () => {
        const module = await compile({
          imports: [TerminusModule.forRoot()],
        });

        const healthCheckService = module.get(HealthCheckService);
        expect(healthCheckService).toBeDefined();

        const healthIndicatorService = module.get(HealthIndicatorService);
        expect(healthIndicatorService).toBeDefined();
      });

      it("should compile the module with custom options", async () => {
        const module = await compile({
          imports: [
            TerminusModule.forRoot({
              errorLogStyle: "pretty",
              logger: true,
              gracefulShutdownTimeoutMs: 0,
            }),
          ],
        });

        const healthCheckService = module.get(HealthCheckService);
        expect(healthCheckService).toBeDefined();
      });
    });

    describe("forRootAsync", () => {
      it("should compile the module with useFactory", async () => {
        const module = await compile({
          imports: [
            TerminusModule.forRootAsync({
              useFactory: () => ({
                errorLogStyle: "pretty",
                gracefulShutdownTimeoutMs: 0,
              }),
            }),
          ],
        });

        const healthCheckService = module.get(HealthCheckService);
        expect(healthCheckService).toBeDefined();

        const options = module.get(TERMINUS_MODULE_OPTIONS);
        expect(options).toEqual({
          errorLogStyle: "pretty",
          gracefulShutdownTimeoutMs: 0,
        });
      });

      it("should compile the module with async useFactory", async () => {
        const module = await compile({
          imports: [
            TerminusModule.forRootAsync({
              useFactory: async () => ({
                errorLogStyle: "json",
                gracefulShutdownTimeoutMs: 5000,
              }),
            }),
          ],
        });

        const options = module.get(TERMINUS_MODULE_OPTIONS);
        expect(options).toEqual({
          errorLogStyle: "json",
          gracefulShutdownTimeoutMs: 5000,
        });
      });

      it("should compile the module with useFactory and inject", async () => {
        const CONFIG_VALUE = "CONFIG_VALUE";

        @Module({
          providers: [{ provide: CONFIG_VALUE, useValue: "pretty" }],
          exports: [CONFIG_VALUE],
        })
        class ConfigModule {}

        const module = await compile({
          imports: [
            TerminusModule.forRootAsync({
              imports: [ConfigModule],
              useFactory: (configValue: string) => ({
                errorLogStyle: configValue as "pretty" | "json",
              }),
              inject: [CONFIG_VALUE],
            }),
          ],
        });

        const options = module.get(TERMINUS_MODULE_OPTIONS);
        expect(options).toEqual({
          errorLogStyle: "pretty",
        });
      });

      it("should compile the module with useClass", async () => {
        const module = await compile({
          imports: [
            TerminusModule.forRootAsync({
              useClass: TerminusConfigService,
            }),
          ],
        });

        const healthCheckService = module.get(HealthCheckService);
        expect(healthCheckService).toBeDefined();

        const options = module.get(TERMINUS_MODULE_OPTIONS);
        expect(options).toEqual({
          errorLogStyle: "pretty",
          gracefulShutdownTimeoutMs: 0,
        });
      });

      it("should compile the module with useExisting", async () => {
        const module = await compile({
          imports: [
            TerminusConfigModule,
            TerminusModule.forRootAsync({
              useExisting: TerminusConfigService,
              imports: [TerminusConfigModule],
            }),
          ],
        });

        const healthCheckService = module.get(HealthCheckService);
        expect(healthCheckService).toBeDefined();

        const options = module.get(TERMINUS_MODULE_OPTIONS);
        expect(options).toEqual({
          errorLogStyle: "pretty",
          gracefulShutdownTimeoutMs: 0,
        });
      });

      it("should include imports from async options", async () => {
        const module = await compile({
          imports: [
            TerminusModule.forRootAsync({
              imports: [TerminusConfigModule],
              useExisting: TerminusConfigService,
            }),
          ],
        });

        const healthCheckService = module.get(HealthCheckService);
        expect(healthCheckService).toBeDefined();
      });

      it("should return the dynamic module metadata", () => {
        const dynamicModule = TerminusModule.forRootAsync({
          useFactory: () => ({}),
        });

        expect(dynamicModule.module).toBe(TerminusModule);
        expect(dynamicModule.providers).toBeDefined();
        expect(dynamicModule.providers!.length).toBeGreaterThan(0);
      });

      it("should return the dynamic module metadata with imports", () => {
        const dynamicModule = TerminusModule.forRootAsync({
          imports: [TerminusConfigModule],
          useFactory: () => ({}),
        });

        expect(dynamicModule.imports).toEqual([TerminusConfigModule]);
      });

      it("should default imports to empty array when not provided", () => {
        const dynamicModule = TerminusModule.forRootAsync({
          useFactory: () => ({}),
        });

        expect(dynamicModule.imports).toEqual([]);
      });
    });

    describe("forRoot - provider resolution", () => {
      itAdapted(
        ["ADR-001"],
        "should default errorLogStyle to json formatting",
        async () => {
          const errorSpy = spyOn(Logger.prototype, "error").mockImplementation(
            () => {},
          );
          try {
            const module = await compile({
              imports: [TerminusModule.forRoot()],
            });

            const options = module.get<TerminusModuleOptions>(
              TERMINUS_MODULE_OPTIONS,
            );
            expect(options.errorLogStyle).toBeUndefined();

            const service = module.get(HealthCheckService);
            await expect(
              service.check([() => ({ db: { status: "down" } })]),
            ).rejects.toBeInstanceOf(HealthCheckException);

            expect(errorSpy).toHaveBeenCalledWith(
              'Health Check has failed! {"db":{"status":"down"}}',
            );
          } finally {
            errorSpy.mockRestore();
          }
        },
        "Replaces ERROR_LOGGER/JsonErrorLogger token check with TERMINUS_MODULE_OPTIONS + JSON log behavior",
      );

      itAdapted(
        ["ADR-001"],
        'should use pretty error log formatting when errorLogStyle is "pretty"',
        async () => {
          const errorSpy = spyOn(Logger.prototype, "error").mockImplementation(
            () => {},
          );
          try {
            const module = await compile({
              imports: [TerminusModule.forRoot({ errorLogStyle: "pretty" })],
            });

            const options = module.get<TerminusModuleOptions>(
              TERMINUS_MODULE_OPTIONS,
            );
            expect(options.errorLogStyle).toBe("pretty");

            const service = module.get(HealthCheckService);
            await expect(
              service.check([() => ({ db: { status: "down" } })]),
            ).rejects.toBeInstanceOf(HealthCheckException);

            expect(errorSpy).toHaveBeenCalledWith(
              'Health Check has failed!\n  - db: {"status":"down"}',
            );
          } finally {
            errorSpy.mockRestore();
          }
        },
        "Replaces ERROR_LOGGER/PrettyErrorLogger token check with TERMINUS_MODULE_OPTIONS + pretty log behavior",
      );

      itAdapted(
        ["ADR-001"],
        "should resolve TERMINUS_LOGGER as a no-op logger when logger is false",
        async () => {
          const errorSpy = spyOn(Logger.prototype, "error").mockImplementation(
            () => {},
          );
          try {
            const module = await compile({
              imports: [TerminusModule.forRoot({ logger: false })],
            });

            const logger = module.get<LoggerService>(TERMINUS_LOGGER);
            expect(logger).toBeDefined();
            expect(logger).not.toBeInstanceOf(Logger);
            expect(typeof logger.log).toBe("function");
            expect(typeof logger.error).toBe("function");
            expect(typeof logger.warn).toBe("function");

            logger.error("ignored");
            expect(errorSpy).not.toHaveBeenCalled();
          } finally {
            errorSpy.mockRestore();
          }
        },
        "NOOP_LOGGER is not exported; verifies resolved TERMINUS_LOGGER is a silent LoggerService",
      );

      it("should resolve TERMINUS_LOGGER as a Logger instance when logger is true", async () => {
        const module = await compile({
          imports: [TerminusModule.forRoot({ logger: true })],
        });

        const logger = module.get<LoggerService>(TERMINUS_LOGGER);
        expect(logger).toBeDefined();
        expect(logger).toBeInstanceOf(Logger);
        expect(logger.log).toBeDefined();
      });

      it("should resolve TERMINUS_MODULE_OPTIONS with provided values", async () => {
        const opts: TerminusModuleOptions = {
          errorLogStyle: "pretty",
          gracefulShutdownTimeoutMs: 3000,
        };
        const module = await compile({
          imports: [TerminusModule.forRoot(opts)],
        });

        const options = module.get(TERMINUS_MODULE_OPTIONS);
        expect(options).toEqual(opts);
      });

      itAdapted(
        ["ADR-001"],
        "should resolve HealthCheckService (executor folded into HealthCheckService)",
        async () => {
          const module = await compile({
            imports: [TerminusModule.forRoot()],
          });

          const service = module.get(HealthCheckService);
          expect(service).toBeInstanceOf(HealthCheckService);
          expect(typeof service.check).toBe("function");
          expect(typeof service.beforeApplicationShutdown).toBe("function");
        },
        "Bunest folds HealthCheckExecutor into HealthCheckService",
      );

      it("should resolve custom logger class with injected dependencies", async () => {
        const LOGGER_DEPENDENCY = "LOGGER_DEPENDENCY";
        const dependencyValue = { context: "test" };

        @Injectable()
        class CustomLoggerWithDeps implements LoggerService {
          constructor(
            @Inject(LOGGER_DEPENDENCY)
            public readonly dep: typeof dependencyValue,
          ) {}
          log() {}
          error() {}
          warn() {}
        }

        @Global()
        @Module({
          providers: [
            { provide: LOGGER_DEPENDENCY, useValue: dependencyValue },
            CustomLoggerWithDeps,
          ],
          exports: [LOGGER_DEPENDENCY, CustomLoggerWithDeps],
        })
        class LoggerDepsModule {}

        const module = await compile({
          imports: [
            LoggerDepsModule,
            TerminusModule.forRoot({ logger: CustomLoggerWithDeps }),
          ],
        });

        const logger = module.get<CustomLoggerWithDeps>(TERMINUS_LOGGER);
        expect(logger).toBeInstanceOf(CustomLoggerWithDeps);
        expect(logger.dep).toBe(dependencyValue);
      });
    });

    describe("forRootAsync - provider resolution", () => {
      itAdapted(
        ["ADR-001"],
        "should resolve pretty errorLogStyle via async useFactory",
        async () => {
          const errorSpy = spyOn(Logger.prototype, "error").mockImplementation(
            () => {},
          );
          try {
            const module = await compile({
              imports: [
                TerminusModule.forRootAsync({
                  useFactory: () => ({ errorLogStyle: "pretty" as const }),
                }),
              ],
            });

            expect(module.get(TERMINUS_MODULE_OPTIONS)).toEqual({
              errorLogStyle: "pretty",
            });
            const service = module.get(HealthCheckService);
            await expect(
              service.check([() => ({ db: { status: "down" } })]),
            ).rejects.toBeInstanceOf(HealthCheckException);

            expect(errorSpy).toHaveBeenCalledWith(
              'Health Check has failed!\n  - db: {"status":"down"}',
            );
          } finally {
            errorSpy.mockRestore();
          }
        },
        "Replaces ERROR_LOGGER token check with TERMINUS_MODULE_OPTIONS + pretty error log behavior",
      );

      itAdapted(
        ["ADR-001"],
        "should resolve TERMINUS_LOGGER via async useFactory with logger false",
        async () => {
          const errorSpy = spyOn(Logger.prototype, "error").mockImplementation(
            () => {},
          );
          try {
            const module = await compile({
              imports: [
                TerminusModule.forRootAsync({
                  useFactory: () => ({ logger: false }),
                }),
              ],
            });

            const logger = module.get<LoggerService>(TERMINUS_LOGGER);
            expect(logger).toBeDefined();
            expect(logger).not.toBeInstanceOf(Logger);
            logger.error("ignored");
            expect(errorSpy).not.toHaveBeenCalled();
          } finally {
            errorSpy.mockRestore();
          }
        },
        "NOOP_LOGGER is internal; verifies resolved TERMINUS_LOGGER is a silent LoggerService",
      );

      it("should resolve custom logger class via async useFactory", async () => {
        @Injectable()
        class CustomLogger implements LoggerService {
          log() {}
          error() {}
          warn() {}
        }

        @Module({
          providers: [CustomLogger],
          exports: [CustomLogger],
        })
        class CustomLoggerModule {}

        const module = await compile({
          imports: [
            TerminusModule.forRootAsync({
              imports: [CustomLoggerModule],
              useFactory: (logger: CustomLogger) => ({ logger }),
              inject: [CustomLogger],
            }),
          ],
        });

        const logger = module.get(TERMINUS_LOGGER);
        expect(logger).toBeInstanceOf(CustomLogger);
      });

      itAdapted(
        ["ADR-001"],
        "should resolve options via useClass",
        async () => {
          const module = await compile({
            imports: [
              TerminusModule.forRootAsync({
                useClass: TerminusConfigService,
              }),
            ],
          });

          const options = module.get<TerminusAsyncModuleOptions>(
            TERMINUS_MODULE_OPTIONS,
          );
          expect(options).toEqual({
            errorLogStyle: "pretty",
            gracefulShutdownTimeoutMs: 0,
          });
        },
        "Replaces ERROR_LOGGER token check with resolved TERMINUS_MODULE_OPTIONS",
      );

      it("should resolve custom logger class with injected dependencies via async useFactory", async () => {
        const LOGGER_DEPENDENCY = "LOGGER_DEPENDENCY";
        const dependencyValue = { context: "test" };

        @Injectable()
        class CustomLoggerWithDeps implements LoggerService {
          constructor(
            @Inject(LOGGER_DEPENDENCY)
            public readonly dep: typeof dependencyValue,
          ) {}
          log() {}
          error() {}
          warn() {}
        }

        @Module({
          providers: [
            { provide: LOGGER_DEPENDENCY, useValue: dependencyValue },
            CustomLoggerWithDeps,
          ],
          exports: [CustomLoggerWithDeps],
        })
        class LoggerDepsModule {}

        const module = await compile({
          imports: [
            LoggerDepsModule,
            TerminusModule.forRootAsync({
              imports: [LoggerDepsModule],
              useFactory: (logger: CustomLoggerWithDeps) => ({ logger }),
              inject: [CustomLoggerWithDeps],
            }),
          ],
        });

        const logger = module.get<CustomLoggerWithDeps>(TERMINUS_LOGGER);
        expect(logger).toBeInstanceOf(CustomLoggerWithDeps);
        expect(logger.dep).toBe(dependencyValue);
      });

      itAdapted(
        ["ADR-001"],
        "should resolve HealthCheckService with async options",
        async () => {
          const module = await compile({
            imports: [
              TerminusModule.forRootAsync({
                useFactory: () => ({ gracefulShutdownTimeoutMs: 5000 }),
              }),
            ],
          });

          const service = module.get(HealthCheckService);
          expect(service).toBeInstanceOf(HealthCheckService);
          expect(module.get(TERMINUS_MODULE_OPTIONS)).toEqual({
            gracefulShutdownTimeoutMs: 5000,
          });
        },
        "Bunest folds HealthCheckExecutor into HealthCheckService",
      );
    });
  },
);
