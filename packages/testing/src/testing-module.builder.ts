import {
  Module,
  type DynamicModule,
  type InjectionToken,
  type LogLevel,
  type LoggerService,
  type ModuleMetadata,
  type Provider,
  type Scope,
  type Type,
} from "@bunest/common";
import {
  DIContainer,
  ENHANCER_OVERRIDE_MARKER,
  ModuleScanner,
  type ContainerOverrides,
  type EnhancerOverrideEntry,
  type EnhancerOverrideValue,
  type MockFactory,
} from "@bunest/core";
import type {
  OverrideBy,
  OverrideByEnhancer,
  OverrideFactoryOptions,
  OverrideModule,
  TestingModuleCompileOptions,
  TestingModuleOptions,
} from "./interfaces/testing.interface";
import { TestingLogger } from "./loggers/testing-logger";
import { TestingModule } from "./testing-module";

type EnhancerOverrideKind = "guards" | "pipes" | "interceptors" | "filters";

/**
 * Fluent builder created by `Test.createTestingModule(metadata, options?)` for
 * configuring provider, guard, pipe, interceptor, exception filter, and module overrides,
 * auto-mocking via `useMocker()`, and custom loggers before compiling a `TestingModule`.
 */
export class TestingModuleBuilder {
  private readonly providerOverrides = new Map<InjectionToken, Provider>();
  private readonly guardOverrides = new Map<
    Type<unknown>,
    EnhancerOverrideValue
  >();
  private readonly pipeOverrides = new Map<
    Type<unknown>,
    EnhancerOverrideValue
  >();
  private readonly interceptorOverrides = new Map<
    Type<unknown>,
    EnhancerOverrideValue
  >();
  private readonly filterOverrides = new Map<
    Type<unknown>,
    EnhancerOverrideValue
  >();
  private readonly moduleOverrides = new Map<
    Type<unknown> | DynamicModule,
    Type<unknown> | DynamicModule
  >();
  private mocker?: MockFactory;
  private loggerOption?: LoggerService | LogLevel[] | false;

  constructor(
    private readonly metadata: ModuleMetadata,
    private readonly testingOptions: TestingModuleOptions = {},
  ) {
    if (testingOptions.logger !== undefined) {
      this.loggerOption = testingOptions.logger;
    }
  }

  overrideProvider(token: InjectionToken): OverrideBy<TestingModuleBuilder> {
    return {
      useValue: (value: unknown): TestingModuleBuilder => {
        this.providerOverrides.set(token, {
          provide: token,
          useValue: value,
        });
        return this;
      },
      useClass: (
        metatype: Type<unknown>,
        scope?: Scope,
      ): TestingModuleBuilder => {
        this.providerOverrides.set(token, {
          provide: token,
          useClass: metatype,
          scope,
        });
        return this;
      },
      useFactory: <T = unknown>(
        options: OverrideFactoryOptions<T>,
      ): TestingModuleBuilder => {
        this.providerOverrides.set(token, {
          provide: token,
          useFactory: options.factory,
          inject: options.inject,
          scope: options.scope,
        });
        return this;
      },
      useExisting: (existingToken: InjectionToken): TestingModuleBuilder => {
        this.providerOverrides.set(token, {
          provide: token,
          useExisting: existingToken,
        });
        return this;
      },
    };
  }

  overrideGuard(
    token: Type<unknown>,
  ): OverrideByEnhancer<TestingModuleBuilder> {
    return this.createEnhancerOverride("guards", token);
  }

  overridePipe(
    token: Type<unknown>,
  ): OverrideByEnhancer<TestingModuleBuilder> {
    return this.createEnhancerOverride("pipes", token);
  }

  overrideInterceptor(
    token: Type<unknown>,
  ): OverrideByEnhancer<TestingModuleBuilder> {
    return this.createEnhancerOverride("interceptors", token);
  }

  overrideFilter(
    token: Type<unknown>,
  ): OverrideByEnhancer<TestingModuleBuilder> {
    return this.createEnhancerOverride("filters", token);
  }

  overrideModule(
    moduleToOverride: Type<unknown> | DynamicModule,
  ): OverrideModule<TestingModuleBuilder> {
    return {
      useModule: (
        newModule: Type<unknown> | DynamicModule,
      ): TestingModuleBuilder => {
        this.moduleOverrides.set(moduleToOverride, newModule);
        return this;
      },
    };
  }

  useMocker(mocker: MockFactory): this {
    this.mocker = mocker;
    return this;
  }

  setLogger(logger: LoggerService | LogLevel[] | false): this {
    this.loggerOption = logger;
    return this;
  }

  /**
   * Scans the synthetic testing root module (applying `overrideModule` replacements),
   * applies all provider/enhancer overrides and optional `useMocker` factory,
   * validates and initializes the DI container, and returns a `TestingModule`.
   */
  async compile(
    options: TestingModuleCompileOptions = {},
  ): Promise<TestingModule> {
    const effectiveLogger =
      options.logger !== undefined
        ? options.logger
        : this.loggerOption !== undefined
          ? this.loggerOption
          : new TestingLogger();

    const abortOnError =
      options.abortOnError ?? this.testingOptions.abortOnError ?? false;

    try {
      class TestingRootModule {}
      Module(this.metadata)(TestingRootModule);

      const moduleIdGeneratorAlgorithm =
        options.moduleIdGeneratorAlgorithm ??
        this.testingOptions.moduleIdGeneratorAlgorithm;
      const preview = options.preview ?? this.testingOptions.preview;
      const snapshot = options.snapshot ?? this.testingOptions.snapshot;
      const instrument = options.instrument ?? this.testingOptions.instrument;

      const scanner = new ModuleScanner();
      const graph = await scanner.scan(TestingRootModule, {
        ...(this.moduleOverrides.size > 0
          ? { moduleOverrides: new Map(this.moduleOverrides) }
          : {}),
        ...(moduleIdGeneratorAlgorithm !== undefined
          ? { moduleIdGeneratorAlgorithm }
          : {}),
      });
      const container = new DIContainer(graph, {
        ...(preview !== undefined ? { preview } : {}),
        ...(snapshot !== undefined ? { snapshot } : {}),
        ...(instrument !== undefined ? { instrument } : {}),
      });

      const overrides: ContainerOverrides = {
        providers: new Map(this.providerOverrides),
        guards: new Map(this.guardOverrides),
        pipes: new Map(this.pipeOverrides),
        interceptors: new Map(this.interceptorOverrides),
        filters: new Map(this.filterOverrides),
        ...(this.moduleOverrides.size > 0
          ? { modules: new Map(this.moduleOverrides) }
          : {}),
        ...(this.mocker ? { mocker: this.mocker } : {}),
      };
      container.applyOverrides(overrides);

      await container.initialize();

      const mergedOptions: TestingModuleCompileOptions = {
        ...options,
        logger: effectiveLogger,
        bufferLogs: options.bufferLogs ?? this.testingOptions.bufferLogs,
        autoFlushLogs:
          options.autoFlushLogs ?? this.testingOptions.autoFlushLogs,
        abortOnError,
      };

      return new TestingModule(container, mergedOptions);
    } catch (err) {
      if (
        abortOnError === false &&
        effectiveLogger &&
        typeof effectiveLogger === "object" &&
        !Array.isArray(effectiveLogger)
      ) {
        if (err instanceof Error) {
          effectiveLogger.error(err.message, err.stack);
        } else {
          effectiveLogger.error(String(err));
        }
      }
      throw err;
    }
  }

  private createEnhancerOverride(
    kind: EnhancerOverrideKind,
    token: Type<unknown>,
  ): OverrideByEnhancer<TestingModuleBuilder> {
    const targetMap = this.getEnhancerMap(kind);

    return {
      useValue: (value: unknown): TestingModuleBuilder => {
        const entry: EnhancerOverrideEntry = {
          [ENHANCER_OVERRIDE_MARKER]: true,
          kind: "value",
          value,
        };
        targetMap.set(token, entry);
        return this;
      },
      useClass: (
        metatype: Type<unknown>,
        scope?: Scope,
      ): TestingModuleBuilder => {
        const entry: EnhancerOverrideEntry = {
          [ENHANCER_OVERRIDE_MARKER]: true,
          kind: "class",
          useClass: metatype,
          ...(scope !== undefined ? { scope } : {}),
        };
        targetMap.set(token, entry);
        return this;
      },
      useFactory: <T = unknown>(
        options: OverrideFactoryOptions<T>,
      ): TestingModuleBuilder => {
        const entry: EnhancerOverrideEntry = {
          [ENHANCER_OVERRIDE_MARKER]: true,
          kind: "factory",
          factory: options.factory,
          inject: options.inject,
          ...(options.scope !== undefined ? { scope: options.scope } : {}),
        };
        targetMap.set(token, entry);
        return this;
      },
      useExisting: (existingToken: InjectionToken): TestingModuleBuilder => {
        const entry: EnhancerOverrideEntry = {
          [ENHANCER_OVERRIDE_MARKER]: true,
          kind: "existing",
          useExisting: existingToken,
        };
        targetMap.set(token, entry);
        return this;
      },
    };
  }

  private getEnhancerMap(
    kind: EnhancerOverrideKind,
  ): Map<Type<unknown>, EnhancerOverrideValue> {
    switch (kind) {
      case "guards":
        return this.guardOverrides;
      case "pipes":
        return this.pipeOverrides;
      case "interceptors":
        return this.interceptorOverrides;
      case "filters":
        return this.filterOverrides;
    }
  }
}
