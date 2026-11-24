import type {
  Duration,
  ResiliencePolicy,
  RetryOptions,
} from "@bunest/resilience";

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

/** Token usage breakdown returned by language models. */
export interface LanguageModelTokenUsage {
  inputTokens: {
    total: number;
    noCache: number;
    cacheRead: number;
    cacheWrite?: number;
  };
  outputTokens: {
    total: number;
    text: number;
    reasoning: number;
  };
}

/** Content part produced by a language model response. */
export type LanguageModelContentPart =
  | { type: "text"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: string }
  | { type: string; [key: string]: unknown };

/** Stream chunk emitted by a streaming language model. */
export type LanguageModelStreamPart =
  | { type: "stream-start"; warnings: unknown[] }
  | {
      type: "response-metadata";
      id?: string;
      modelId?: string;
      timestamp?: Date;
    }
  | { type: "text-start"; id: string }
  | { type: "text-delta"; id: string; delta: string; textDelta?: string }
  | { type: "text-end"; id: string }
  | {
      type: "tool-call";
      toolCallId?: string;
      id?: string;
      toolName?: string;
      name?: string;
      input?: unknown;
      args?: unknown;
    }
  | {
      type: "finish";
      finishReason: { unified: string; raw: string } | string;
      usage: LanguageModelTokenUsage;
    }
  | { type: "error"; error?: unknown; errorText?: string }
  | { type: "abort" }
  | { type: string; [key: string]: unknown };

export interface LanguageModelToolCallInput {
  toolCallId?: string;
  id?: string;
  toolName?: string;
  name?: string;
  input?: unknown;
  args?: unknown;
}

export interface LanguageModelToolResultPart {
  type: "tool-result";
  toolCallId?: string;
  toolName?: string;
  output?: { type?: string; value?: unknown } | unknown;
  result?: unknown;
}

export interface LanguageModelPromptMessage {
  role: string;
  content: unknown;
  toolCalls?: LanguageModelToolCallInput[];
  toolCallId?: string;
  [key: string]: unknown;
}

export interface LanguageModelToolSpec {
  name: string;
  description?: string;
  inputSchema?: unknown;
  parameters?: unknown;
}

export interface LanguageModelProviderEndpointOptions {
  baseURL?: string;
  apiKey?: string;
  [key: string]: unknown;
}

export interface LanguageModelCallOptions {
  prompt?: LanguageModelPromptMessage[];
  tools?: LanguageModelToolSpec[];
  toolChoice?: string | { type?: string; toolName?: string };
  responseFormat?: {
    type?: string;
    schema?: unknown;
    name?: string;
    description?: string;
  };
  mode?: {
    type?: string;
    tools?: LanguageModelToolSpec[];
    toolChoice?: string | { type?: string; toolName?: string };
    schema?: unknown;
    name?: string;
    description?: string;
  };
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  seed?: number;
  stopSequences?: string[];
  presencePenalty?: number;
  frequencyPenalty?: number;
  providerOptions?: Record<string, LanguageModelProviderEndpointOptions | undefined>;
  headers?: Record<string, string | undefined>;
  abortSignal?: AbortSignal;
  [key: string]: unknown;
}

export interface LanguageModelGenerateResult {
  text?: string;
  content?: LanguageModelContentPart[];
  toolCalls?: LanguageModelToolCallInput[];
  finishReason?: { unified: string; raw?: string } | string;
  usage?: LanguageModelTokenUsage;
  warnings?: unknown[];
  response?: {
    id?: string;
    modelId?: string;
    timestamp?: Date;
    headers?: Record<string, string>;
  };
  [key: string]: unknown;
}

export interface LanguageModelStreamResult {
  stream:
    | ReadableStream<LanguageModelStreamPart>
    | AsyncIterable<LanguageModelStreamPart>;
  [key: string]: unknown;
}

export interface EmbeddingModelCallOptions {
  values: string[];
  providerOptions?: Record<string, LanguageModelProviderEndpointOptions | undefined>;
  headers?: Record<string, string | undefined>;
  abortSignal?: AbortSignal;
  [key: string]: unknown;
}

export interface EmbeddingModelResult {
  embeddings: number[][];
  usage?: { tokens: number };
  warnings?: unknown[];
  response?: { headers?: Record<string, string>; body?: unknown };
  providerMetadata?: Record<string, Record<string, unknown>>;
  [key: string]: unknown;
}

/** Language model object compatible with AI SDK v2/v3/v4/v5 `LanguageModel` or Bunest's built-in HTTP providers. */
export interface LanguageModelLike {
  readonly specificationVersion?: string;
  readonly provider: string;
  readonly modelId: string;
  readonly defaultObjectGenerationMode?: string;
  readonly supportedUrls?:
    Record<string, RegExp[]> | PromiseLike<Record<string, RegExp[]>>;
  doGenerate(options: any): Promise<any>;
  doStream?(options: any): Promise<any>;
}

/** Embedding model object compatible with AI SDK `EmbeddingModel` or Bunest's built-in HTTP providers. */
export interface EmbeddingModelLike {
  readonly specificationVersion?: string;
  readonly provider: string;
  readonly modelId: string;
  readonly maxEmbeddingsPerCall?:
    number | null | PromiseLike<number | undefined>;
  readonly supportsParallelCalls?: boolean | PromiseLike<boolean>;
  doEmbed(options: any): Promise<any>;
}

/** A language model: either a provider object or a gateway/provider string id (`openai/gpt-4o`, `anthropic/...`, `google/...`). */
export type LanguageModel = string | LanguageModelLike;

/** An embedding model: either a provider object or a gateway/provider string id (`openai/text-embedding-3-small`, `google/...`). */
export type EmbeddingModel = string | EmbeddingModelLike;
