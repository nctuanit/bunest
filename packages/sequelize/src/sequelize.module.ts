import { Module, type DynamicModule } from "@bunest/common";
import { EntitiesMetadataStorage } from "./entities-metadata.storage";
import type {
  SequelizeModuleAsyncOptions,
  SequelizeModuleOptions,
} from "./interfaces/sequelize-options.interface";
import type { SequelizeOptions } from "./runtime/sequelize-runtime";
import { SequelizeCoreModule } from "./sequelize-core.module";
import { DEFAULT_CONNECTION_NAME } from "./sequelize.constants";
import { createSequelizeProviders } from "./sequelize.providers";

@Module({})
export class SequelizeModule {
  static forRoot(options: SequelizeModuleOptions = {}): DynamicModule {
    return {
      module: SequelizeModule,
      imports: [SequelizeCoreModule.forRoot(options)],
    };
  }

  static forFeature(
    entities: Function[] = [],
    connection: SequelizeOptions | string = DEFAULT_CONNECTION_NAME,
  ): DynamicModule {
    const providers = createSequelizeProviders(entities, connection);
    EntitiesMetadataStorage.addEntitiesByConnection(connection, entities);
    return {
      module: SequelizeModule,
      providers,
      exports: providers,
    };
  }

  static forRootAsync(options: SequelizeModuleAsyncOptions): DynamicModule {
    return {
      module: SequelizeModule,
      imports: [SequelizeCoreModule.forRootAsync(options)],
    };
  }
}
