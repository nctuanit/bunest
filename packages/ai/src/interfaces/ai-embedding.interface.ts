import type {
  AiModelInfo,
  AiResilienceSettings,
  EmbeddingModel,
} from './ai-types.interface';

/** Embedding settings, independent of language-model generation defaults. */
export interface AiEmbeddingSettings extends AiResilienceSettings {
  /** Provider-specific options. */
  providerOptions?: Record<string, Record<string, any>>;
  /** HTTP headers sent to the embedding provider. */
  headers?: Record<string, string>;
  /** Maximum concurrent batch requests within one `embedMany()` operation. Default 4. */
  maxParallelCalls?: number;
}

/** Price per million input tokens. */
export interface AiEmbeddingModelPricing {
  input: number;
}

/** A registered SDK embedding model with its own embedding settings. */
export interface AiEmbeddingModelDefinition extends AiEmbeddingSettings {
  model: EmbeddingModel;
  pricing?: AiEmbeddingModelPricing;
}

/** A registered embedding name, or an SDK embedding-model object passed directly to a call. */
export type AiEmbeddingModelReference = string | Exclude<EmbeddingModel, string>;

/** Options shared by single and batch embedding calls. */
export interface AiEmbeddingCallOptions extends AiEmbeddingSettings {
  /** Name in `embeddingModels` (default `'default'`), or a direct SDK model object. */
  model?: AiEmbeddingModelReference;
  /** Cancels in-flight provider requests and retry backoff. */
  abortSignal?: AbortSignal;
  /** Names this operation in usage and resilience events. */
  label?: string;
  /** Called after a successful operation. */
  onEmbeddingUsage?: (event: AiEmbeddingUsageEvent) => void | Promise<void>;
}

export interface AiEmbedOptions extends AiEmbeddingCallOptions {
  value: string;
}

export interface AiEmbedManyOptions extends AiEmbeddingCallOptions {
  values: string[];
}

/** Single-embedding result with the resolved model and attempt count. */
export interface AiEmbedResult {
  value: string;
  embedding: number[];
  usage: { tokens: number };
  warnings: any[];
  providerMetadata?: Record<string, Record<string, any>>;
  response?: {
    headers?: Record<string, string>;
    body?: unknown;
  };
  model: AiModelInfo;
  /** Provider requests made, retries included. */
  attempts: number;
  /** Cost of the reported usage; absent without model pricing. */
  cost?: number;
}

/** Batch embedding result. */
export interface AiEmbedManyResult {
  values: string[];
  embeddings: number[][];
  usage: { tokens: number };
  warnings: any[];
  providerMetadata?: Record<string, Record<string, any>>;
  responses?: Array<
    | {
        headers?: Record<string, string>;
        body?: unknown;
      }
    | undefined
  >;
  model: AiModelInfo;
  /** Provider requests made, retries included. */
  attempts: number;
  /** Cost of the reported usage; absent without model pricing. */
  cost?: number;
}

/** One successful embedding operation. */
export interface AiEmbeddingUsageEvent {
  operation: 'embed' | 'embedMany';
  label?: string;
  model: AiModelInfo;
  inputCount: number;
  usage: { tokens: number };
  /** Provider requests made, retries included. */
  attempts: number;
  /** Total duration of the operation. */
  durationMs: number;
  cost?: number;
}
