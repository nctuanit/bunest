import type { Duration, ResiliencePolicy, RetryOptions } from '@bunest/resilience';

/** Which model answered. */
export interface AiModelInfo {
  /** Its name in `models` or `embeddingModels`; `undefined` for direct SDK model objects. */
  name?: string;
  provider: string;
  modelId: string;
}

/** Resilience settings shared by language-model and embedding calls. */
export interface AiResilienceSettings {
  /** The longest a model call may take to answer. Default `'60s'`; `false` for none. */
  timeout?: Duration | false;
  /** Retries of a failed model call. `false` for none. */
  retry?: RetryOptions | false;
  /** A policy of your own, in place of `retry` and `timeout`. */
  resilience?: ResiliencePolicy | string;
}

/** A model message in a conversation. */
export interface ModelMessage {
  role: string;
  content: unknown;
  [key: string]: unknown;
}

/** Language model object compatible with AI SDK v2/v3/v4/v5 `LanguageModel` or Bunest's built-in HTTP providers. */
export interface LanguageModelLike {
  readonly specificationVersion?: string;
  readonly provider: string;
  readonly modelId: string;
  readonly defaultObjectGenerationMode?: string;
  readonly supportedUrls?: Record<string, RegExp[]> | PromiseLike<Record<string, RegExp[]>>;
  doGenerate(options: any): Promise<any>;
  doStream?(options: any): Promise<any>;
}

/** Embedding model object compatible with AI SDK `EmbeddingModel` or Bunest's built-in HTTP providers. */
export interface EmbeddingModelLike {
  readonly specificationVersion?: string;
  readonly provider: string;
  readonly modelId: string;
  readonly maxEmbeddingsPerCall?: number | null | PromiseLike<number | undefined>;
  readonly supportsParallelCalls?: boolean | PromiseLike<boolean>;
  doEmbed(options: any): Promise<any>;
}

/** A language model: either a provider object or a gateway/provider string id (`openai/gpt-4o`, `anthropic/...`, `google/...`). */
export type LanguageModel = string | LanguageModelLike;

/** An embedding model: either a provider object or a gateway/provider string id (`openai/text-embedding-3-small`, `google/...`). */
export type EmbeddingModel = string | EmbeddingModelLike;
