import type { ModuleMetadata } from "@bunest/core";
import type { TestingModuleOptions } from "./interfaces/testing.interface";
import { TestingModuleBuilder } from "./testing-module.builder";

/**
 * Primary entrypoint for creating isolated Bunest testing modules.
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
}
