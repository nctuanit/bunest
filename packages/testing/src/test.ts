import type { ModuleMetadata, Type } from "@bunest/core";
import type { TestingModuleOptions } from "./interfaces/testing.interface";
import { TestingModuleBuilder } from "./testing-module.builder";
import { UnitTestBuilder, type UnitTestOptions } from "./unit-harness";

/**
 * Primary entrypoint for creating isolated Bunest testing modules and solitary unit tests.
 *
 * @example
 * ```ts
 * const moduleRef = await Test.createTestingModule({
 *   imports: [UsersModule],
 * })
 *   .overrideProvider(UsersRepository)
 *   .useValue(mockRepo)
 *   .compile();
 *
 * const app = moduleRef.createNestApplication();
 * await app.init();
 * ```
 */
export class Test {
  static createTestingModule(
    metadata: ModuleMetadata,
    options?: TestingModuleOptions,
  ): TestingModuleBuilder {
    return new TestingModuleBuilder(metadata, options);
  }

  /**
   * Creates a solitary unit-test harness for `target` that automatically mocks
   * all constructor and property dependencies via `createAutoMocker`.
   *
   * Can be awaited directly (`const { unit, unitRef } = await Test.createUnit(UsersService)`)
   * or configured fluently (`.mock(Dep).useValue(...)` / `.overrideProvider(...)`).
   */
  static createUnit<T extends object>(
    target: Type<T>,
    options?: UnitTestOptions,
  ): UnitTestBuilder<T> {
    return new UnitTestBuilder<T>(target, options);
  }
}
