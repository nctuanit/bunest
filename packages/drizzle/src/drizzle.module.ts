import { Module, type DynamicModule } from "@bunest/common";
import { DrizzleCoreModule } from "./drizzle-core.module";
import type {
  DrizzleFunction,
  DrizzleModuleAsyncOptions,
  DrizzleModuleOptions,
} from "./interfaces/drizzle-options.interface";

/**
 * Registers a Drizzle database and makes it injectable across the application
 * with the `@InjectDrizzle()` decorator.
 *
 * @publicApi
 */
@Module({})
export class DrizzleModule {
  /**
   * Registers a database from static options.
   *
   * With `drizzle` and `connection`, the module creates the database by
   * calling the given `drizzle()` function once for each application.
   *
   * With `db`, it registers an instance that you created directly.
   */
  static forRoot<TDrizzle = DrizzleFunction>(
    options: DrizzleModuleOptions<any, TDrizzle>,
  ): DynamicModule {
    return {
      module: DrizzleModule,
      imports: [DrizzleCoreModule.forRoot(options)],
    };
  }

  /**
   * Registers a database whose options are created by a factory
   * (`useFactory`) or by an options factory class (`useClass`, `useExisting`).
   */
  static forRootAsync<TDrizzle = DrizzleFunction>(
    options: DrizzleModuleAsyncOptions<any, TDrizzle>,
  ): DynamicModule {
    return {
      module: DrizzleModule,
      imports: [DrizzleCoreModule.forRootAsync(options)],
    };
  }
}
