import type { Provider } from "@bunest/common";
import { getConnectionToken, getModelToken } from "./common/mongoose.utils";
import type { AsyncModelFactory } from "./interfaces/async-model-factory.interface";
import type { ModelDefinition } from "./interfaces/model-definition.interface";
import type { ConnectionLike } from "./interfaces/mongoose-options.interface";

export function createMongooseProviders(
  connectionName?: string,
  options: ModelDefinition[] = [],
): Provider[] {
  return options.reduce<Provider[]>(
    (providers, option) => [
      ...providers,
      ...(option.discriminators ?? []).map((d) => ({
        provide: getModelToken(d.name, connectionName),
        useFactory: (model: any) =>
          model.discriminator(d.name, d.schema, d.value),
        inject: [getModelToken(option.name, connectionName)],
      })),
      {
        provide: getModelToken(option.name, connectionName),
        useFactory: (connection: ConnectionLike) => {
          const model = connection.models[option.name]
            ? connection.models[option.name]
            : connection.model(option.name, option.schema, option.collection);
          return model;
        },
        inject: [getConnectionToken(connectionName)],
      },
    ],
    [],
  );
}

export function createMongooseAsyncProviders(
  connectionName?: string,
  modelFactories: AsyncModelFactory[] = [],
): Provider[] {
  return modelFactories.reduce<Provider[]>(
    (providers, option) => [
      ...providers,
      {
        provide: getModelToken(option.name, connectionName),
        useFactory: async (connection: ConnectionLike, ...args: any[]) => {
          const schema = await option.useFactory(...args);
          const model = connection.model(
            option.name,
            schema,
            option.collection,
          );
          return model;
        },
        inject: [getConnectionToken(connectionName), ...(option.inject ?? [])],
      },
      ...(option.discriminators ?? []).map((d) => ({
        provide: getModelToken(d.name, connectionName),
        useFactory: (model: any) =>
          model.discriminator(d.name, d.schema, d.value),
        inject: [getModelToken(option.name, connectionName)],
      })),
    ],
    [],
  );
}
