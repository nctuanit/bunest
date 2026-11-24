import { Module, type DynamicModule } from "@bunest/core";
import { DiscoveryModule } from "@bunest/core";
import {
  AI_EMBEDDING_MODEL_OVERRIDES,
  AI_MODEL_OVERRIDES,
} from "./ai.constants";
import {
  ConfigurableModuleClass,
  type AiModuleAsyncOptions,
  type AiModuleRootOptions,
} from "./ai.module-definition";
import { AiEmbeddingModels } from "./models/ai-embedding-models.service";
import { AiModels } from "./models/ai-models.service";
import { AiService } from "./services/ai.service";
import { AiTools } from "./tools/ai-tools.service";

/**
 * `AiModule.forRoot({ models: { default: ... } })`, or `forRootAsync({ imports, inject, useFactory })`:
 * the application's models by name, `AiService` for model calls, and the `@AgentFunction()` methods
 * of its providers, which its agents call as tools. Global with `isGlobal: true`.
 */
@Module({
  imports: [DiscoveryModule],
  providers: [
    AiModels,
    AiEmbeddingModels,
    AiTools,
    AiService,
    { provide: AI_MODEL_OVERRIDES, useValue: null },
    { provide: AI_EMBEDDING_MODEL_OVERRIDES, useValue: null },
  ],
  exports: [AiModels, AiEmbeddingModels, AiTools, AiService],
})
export class AiModule extends ConfigurableModuleClass {
  static override forRoot(options: AiModuleRootOptions): DynamicModule {
    const modelNames = Object.keys(options?.models ?? {});
    const embeddingModelNames = Object.keys(options?.embeddingModels ?? {});
    return super.forRoot({ ...options, modelNames, embeddingModelNames });
  }

  static override forRootAsync(options: AiModuleAsyncOptions): DynamicModule {
    return super.forRootAsync(options);
  }
}
