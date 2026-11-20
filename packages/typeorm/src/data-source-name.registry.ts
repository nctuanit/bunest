import { Logger } from "@bunest/common";
import { DuplicateDataSourceException } from "./exceptions/duplicate-data-source.exception";

/**
 * Tracks active data source names at runtime in order to detect multiple
 * data sources registered under the same name.
 */
export class DataSourceNameRegistry {
  private static readonly logger = new Logger(DataSourceNameRegistry.name);
  private static readonly registeredNames = new Set<string>();
  private static strictMode = false;

  static setStrict(strict: boolean): void {
    this.strictMode = strict;
  }

  static register(dataSourceName: string, strict?: boolean): void {
    if (this.registeredNames.has(dataSourceName)) {
      if (strict ?? this.strictMode) {
        throw new DuplicateDataSourceException(dataSourceName);
      }
      this.logger.warn(
        `A data source with the ${dataSourceName} name is already registered. ` +
          `Multiple data sources must be registered with unique names; otherwise, ` +
          `they will override each other. Please assign a unique "name" property ` +
          `to each TypeOrmModule.forRoot()/forRootAsync() registration.`,
      );
    }
    this.registeredNames.add(dataSourceName);
  }

  static unregister(dataSourceName: string): void {
    this.registeredNames.delete(dataSourceName);
  }

  static has(dataSourceName: string): boolean {
    return this.registeredNames.has(dataSourceName);
  }

  static clear(): void {
    this.registeredNames.clear();
  }
}
