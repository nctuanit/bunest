import {
  METADATA_KEYS,
  MetadataRegistry,
  Scope,
  getInjectableScope,
  type ControllerMetadata,
  type InjectionToken,
  type LogLevel,
  type LoggerService,
  type MockFactory,
  type Provider,
  type Type,
} from "@bunest/core";
import type {
  OverrideBy,
  OverrideFactoryOptions,
} from "./interfaces/testing.interface";
import {
  createAutoMocker,
  type AutoMockerOptions,
  type DeepMocked,
  type Mocked,
} from "./mocker/module-mocker";
import { TestingModule } from "./testing-module";
import { TestingModuleBuilder } from "./testing-module.builder";

export interface UnitTestOptions extends AutoMockerOptions {
  /**
   * Additional real providers to include alongside the target unit.
   */
  readonly providers?: Provider[];
  /**
   * Optional custom logger (defaults to silent `TestingLogger`).
   */
  readonly logger?: LoggerService | LogLevel[] | false;
  /**
   * Automatically run `testingModule.init()` (lifecycle hooks) before returning.
   * @default false
   */
  readonly init?: boolean;
}

/**
 * Typed reference handle for retrieving auto-mocked or overridden dependencies
 * injected into the unit under test.
 */
export interface UnitReference {
  /**
   * Retrieves an auto-mocked or overridden dependency typed as `Mocked<D>`.
   */
  get<D>(token: InjectionToken<D>): Mocked<D>;
  /**
   * Retrieves an auto-mocked or overridden dependency typed as `DeepMocked<D>`.
   */
  getDeep<D>(token: InjectionToken<D>): DeepMocked<D>;
  /**
   * Underlying compiled `TestingModule` for advanced assertions or lifecycle access.
   */
  readonly testingModule: TestingModule;
}

/**
 * Compiled solitary unit-test harness returned by `await Test.createUnit(Target)`.
 * Supports automatic cleanup via `await using harness = await Test.createUnit(Target)`.
 */
export interface UnitTestResult<T> {
  readonly unit: T;
  readonly unitRef: UnitReference;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

function resolveTargetScope(target: Type<unknown>): Scope {
  const ctrlMeta = MetadataRegistry.get<ControllerMetadata>(
    METADATA_KEYS.CONTROLLER,
    target,
  );
  if (ctrlMeta?.scope) {
    return ctrlMeta.scope;
  }
  return getInjectableScope(target);
}

/**
 * Solitary unit test builder returned by `Test.createUnit(Target, options?)`.
 *
 * Implements `PromiseLike<UnitTestResult<T>>`, so it can be awaited directly as
 * a one-liner or configured fluently with `.mock(Dep).useValue(...)` /
 * `.overrideProvider(Dep)...` before awaiting or calling `.compile()`.
 */
export class UnitTestBuilder<T extends object>
  implements PromiseLike<UnitTestResult<T>>
{
  private readonly overrides = new Map<InjectionToken, Provider>();
  private customMocker?: MockFactory;
  private loggerOption?: LoggerService | LogLevel[] | false;
  private compiledPromise?: Promise<UnitTestResult<T>>;

  constructor(
    private readonly target: Type<T>,
    private readonly options: UnitTestOptions = {},
  ) {
    if (options.logger !== undefined) {
      this.loggerOption = options.logger;
    }
    if (options.overrides) {
      const entries =
        options.overrides instanceof Map
          ? options.overrides.entries()
          : options.overrides;
      for (const [token, value] of entries) {
        this.overrides.set(token, {
          provide: token,
          useValue: value,
        });
      }
    }
  }

  /**
   * Fluent alias for `overrideProvider(token)` to customize a mocked dependency.
   */
  mock<D = unknown>(token: InjectionToken<D>): OverrideBy<UnitTestBuilder<T>> {
    return this.overrideProvider(token);
  }

  /**
   * Overrides a dependency of the target unit with a custom value, class, factory, or alias.
   */
  overrideProvider<D = unknown>(
    token: InjectionToken<D>,
  ): OverrideBy<UnitTestBuilder<T>> {
    return {
      useValue: (value: unknown): UnitTestBuilder<T> => {
        this.overrides.set(token, {
          provide: token,
          useValue: value,
        });
        return this;
      },
      useClass: (
        metatype: Type<unknown>,
        scope?: Scope,
      ): UnitTestBuilder<T> => {
        this.overrides.set(token, {
          provide: token,
          useClass: metatype,
          scope,
        });
        return this;
      },
      useFactory: <F = unknown>(
        factoryOptions: OverrideFactoryOptions<F>,
      ): UnitTestBuilder<T> => {
        this.overrides.set(token, {
          provide: token,
          useFactory: factoryOptions.factory,
          inject: factoryOptions.inject,
          scope: factoryOptions.scope,
        });
        return this;
      },
      useExisting: (existingToken: InjectionToken): UnitTestBuilder<T> => {
        this.overrides.set(token, {
          provide: token,
          useExisting: existingToken,
        });
        return this;
      },
    };
  }

  /**
   * Replaces the default `createAutoMocker(...)` strategy with a custom `MockFactory`.
   */
  useMocker(mocker: MockFactory): this {
    this.customMocker = mocker;
    return this;
  }

  setLogger(logger: LoggerService | LogLevel[] | false): this {
    this.loggerOption = logger;
    return this;
  }

  /**
   * Compiles the solitary testing module, resolves the target unit and auto-mocked
   * dependencies, and returns `{ unit, unitRef, close(), [Symbol.asyncDispose]() }`.
   */
  compile(): Promise<UnitTestResult<T>> {
    if (this.compiledPromise) {
      return this.compiledPromise;
    }

    this.compiledPromise = this.compileInternal();
    return this.compiledPromise;
  }

  then<TResult1 = UnitTestResult<T>, TResult2 = never>(
    onfulfilled?:
      | ((value: UnitTestResult<T>) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?:
      | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
      | null,
  ): Promise<TResult1 | TResult2> {
    return this.compile().then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?:
      | ((reason: unknown) => TResult | PromiseLike<TResult>)
      | null,
  ): Promise<UnitTestResult<T> | TResult> {
    return this.compile().catch(onrejected);
  }

  finally(onfinally?: (() => void) | null): Promise<UnitTestResult<T>> {
    return this.compile().finally(onfinally);
  }

  private async compileInternal(): Promise<UnitTestResult<T>> {
    const builder = new TestingModuleBuilder(
      {
        providers: [this.target, ...(this.options.providers ?? [])],
      },
      this.loggerOption !== undefined ? { logger: this.loggerOption } : {},
    );

    for (const [token, provider] of this.overrides.entries()) {
      if ("useValue" in provider) {
        builder.overrideProvider(token).useValue(provider.useValue);
      } else if ("useClass" in provider) {
        builder
          .overrideProvider(token)
          .useClass(provider.useClass, provider.scope);
      } else if ("useFactory" in provider) {
        builder.overrideProvider(token).useFactory({
          factory: provider.useFactory,
          inject: provider.inject,
          scope: provider.scope,
        });
      } else if ("useExisting" in provider) {
        builder.overrideProvider(token).useExisting(provider.useExisting);
      }
    }

    const mocker =
      this.customMocker ??
      createAutoMocker({
        customFactory: this.options.customFactory,
        spyFactory: this.options.spyFactory,
        mockUnregisteredTokens: this.options.mockUnregisteredTokens ?? true,
      });

    builder.useMocker(mocker);

    const testingModule = await builder.compile();

    if (this.options.init === true) {
      await testingModule.init();
    }

    const targetScope = resolveTargetScope(this.target);
    let unit: T;
    if (targetScope === Scope.REQUEST) {
      const reqContainer = testingModule.createRequestContainer();
      unit = await testingModule.resolve<T>(this.target, reqContainer);
    } else if (targetScope === Scope.TRANSIENT) {
      unit = await testingModule.resolve<T>(this.target);
    } else {
      unit = testingModule.get<T>(this.target);
    }

    const unitRef: UnitReference = {
      get<D>(token: InjectionToken<D>): Mocked<D> {
        return testingModule.get<D>(token) as unknown as Mocked<D>;
      },
      getDeep<D>(token: InjectionToken<D>): DeepMocked<D> {
        return testingModule.get<D>(token) as unknown as DeepMocked<D>;
      },
      testingModule,
    };

    const close = (): Promise<void> => testingModule.close();

    return {
      unit,
      unitRef,
      close,
      [Symbol.asyncDispose]: close,
    };
  }
}
