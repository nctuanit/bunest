import {
  ConfigurableModuleBuilder,
  INQUIRER,
  Scope,
  type ConfigurableModuleAsyncOptions,
} from "@bunest/core";
import type {
  AiModuleOptions,
  AiModuleStructure,
  AiOptionsFactory,
} from "./interfaces/ai-module-options.interface";
import {
  AI_MODULE_OPTIONS,
  getEmbeddingModelToken,
  getModelToken,
} from "./ai.constants";
import { AiEmbeddingModels } from "./models/ai-embedding-models.service";
import { AiModels } from "./models/ai-models.service";
import {
  requestedEmbeddingModelNames,
  requestedModelNames,
} from "./models/model-requests";

export { AI_MODULE_OPTIONS };
export type { AiOptionsFactory };

/** `forRoot()`'s options: the module options, and `isGlobal` (default false). */
export type AiModuleRootOptions = AiModuleOptions & {
  isGlobal?: boolean;
};

/** What `forRootAsync()` takes. */
export type AiModuleAsyncOptions = ConfigurableModuleAsyncOptions<
  AiModuleOptions,
  "createAiOptions"
> &
  AiModuleStructure & {
    isGlobal?: boolean;
  };

export const { ConfigurableModuleClass, OPTIONS_TYPE, ASYNC_OPTIONS_TYPE } =
  new ConfigurableModuleBuilder<AiModuleOptions>({
    moduleName: "Ai",
    optionsInjectionToken: AI_MODULE_OPTIONS,
  })
    .setClassMethodName("forRoot")
    .setFactoryMethodName("createAiOptions")
    .setExtras<{
      isGlobal?: boolean;
      modelNames?: string[];
      embeddingModelNames?: string[];
    }>(
      {
        isGlobal: false,
        modelNames: undefined,
        embeddingModelNames: undefined,
      },
      (definition, { isGlobal, modelNames, embeddingModelNames }) => {
        const names = new Set([
          ...(modelNames ?? []),
          ...requestedModelNames(),
        ]);
        const tokens = [...names].map((name) => ({
          provide: getModelToken(name),
          scope: Scope.TRANSIENT,
          inject: [AiModels, INQUIRER],
          useFactory: (models: AiModels, inquirer: unknown) =>
            models.injected(name, inquirer),
        }));

        const embeddingNames = new Set([
          ...(embeddingModelNames ?? []),
          ...requestedEmbeddingModelNames(),
        ]);
        const embeddingTokens = [...embeddingNames].map((name) => ({
          provide: getEmbeddingModelToken(name),
          scope: Scope.TRANSIENT,
          inject: [AiEmbeddingModels, INQUIRER],
          useFactory: (models: AiEmbeddingModels, inquirer: unknown) =>
            models.injected(name, inquirer),
        }));

        const allTokens = [...tokens, ...embeddingTokens];
        return {
          ...definition,
          global: isGlobal,
          providers: [...(definition.providers ?? []), ...allTokens],
          exports: [
            ...(definition.exports ?? []),
            ...allTokens.map((provider) => provider.provide),
          ],
        };
      },
    )
    .build();
