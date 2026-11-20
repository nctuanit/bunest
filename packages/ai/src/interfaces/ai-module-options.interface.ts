import type {
  AiResilienceSettings,
  EmbeddingModel,
  EmbeddingModelLike,
  LanguageModel,
  LanguageModelLike,
} from './ai-types.interface';
import type { AiUsageEvent } from './ai-usage.interface';
import type {
  AiEmbeddingModelDefinition,
  AiEmbeddingSettings,
  AiEmbeddingUsageEvent,
} from './ai-embedding.interface';

export type {
  AiResilienceSettings,
  EmbeddingModel,
  EmbeddingModelLike,
  LanguageModel,
  LanguageModelLike,
};

/** Prices per million tokens. */
export interface AiModelPricing {
  input: number;
  output: number;
  /** Input tokens read from the prompt cache. Default: `input`. */
  cachedInput?: number;
}

/** Limits on one call. */
export interface AiBudget {
  /** Total tokens, input and output. */
  maxTokens?: number;
  /** In the unit of the models' `pricing`. */
  maxCost?: number;
}

/** Settings a language model, the module's `defaults` and each call can set. */
export interface AiCallSettings extends AiResilienceSettings {
  /** Generation settings passed to the model. */
  maxOutputTokens?: number;
  temperature?: number;
  /** Provider-specific options. */
  providerOptions?: Record<string, Record<string, any>>;
  /** HTTP headers sent to the provider. */
  headers?: Record<string, string | undefined>;
}

export interface AiModelDefinition extends AiCallSettings {
  model: LanguageModel;
  pricing?: AiModelPricing;
  /** The models tried, in order, when this one fails. */
  fallback?: string | string[];
}

/** Defaults for language-model calls. */
export interface AiCallDefaults extends AiCallSettings {
  /** Model calls one call may make while the model asks for tools. Default 10. */
  maxSteps?: number;
  budget?: AiBudget;
}

/** `forRoot()`'s options. */
export interface AiModuleOptions {
  /** The models, by name. */
  models?: Record<string, LanguageModel | AiModelDefinition>;
  defaults?: AiCallDefaults;
  /** Named embedding models. */
  embeddingModels?: Record<string, EmbeddingModel | AiEmbeddingModelDefinition>;
  /** Embedding-only defaults. */
  embeddingDefaults?: AiEmbeddingSettings;
  /** Called after every model call that answered. */
  onUsage?: (event: AiUsageEvent) => void | Promise<void>;
  /** Called once after a successful embedding operation. */
  onEmbeddingUsage?: (event: AiEmbeddingUsageEvent) => void | Promise<void>;
  /** The modules whose providers are searched for agent functions. */
  include?: Function[];
}

/** What only the top level of `forRoot()` and `forRootAsync()` takes. */
export interface AiModuleStructure {
  /** Model names `@InjectModel()` may inject, beyond those it was seen asking for. */
  modelNames?: string[];
  /** Embedding-model counterpart of `modelNames`. */
  embeddingModelNames?: string[];
}

/** What a class passed to `forRootAsync({ useClass })` implements. */
export interface AiOptionsFactory {
  createAiOptions(): AiModuleOptions | Promise<AiModuleOptions>;
}
