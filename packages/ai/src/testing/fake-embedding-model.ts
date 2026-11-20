/** One provider response of a fake embedding model. */
export interface FakeEmbeddingTurn {
  embeddings: number[][];
  usage?: { tokens: number };
  delay?: number;
  warnings?: any[];
  providerMetadata?: Record<string, Record<string, any>>;
  response?: {
    headers?: Record<string, string>;
    body?: unknown;
  };
}

/** A provider call the fake received. */
export interface FakeEmbeddingModelCall {
  values: string[];
  options: any;
}

/** An embedding response, provider error, or function. */
export type FakeEmbeddingAnswer =
  | FakeEmbeddingTurn
  | Error
  | ((
      call: FakeEmbeddingModelCall,
    ) => FakeEmbeddingAnswer | Promise<FakeEmbeddingAnswer>);

/** Provider capabilities. */
export interface FakeEmbeddingModelOptions {
  provider?: string;
  modelId?: string;
  maxEmbeddingsPerCall?: number;
  supportsParallelCalls?: boolean;
}

/**
 * An embedding model for offline tests. Answers provider calls in order, records them, and supports
 * batching. A function answers every call; `reply()` appends scripted responses.
 */
export class FakeEmbeddingModel {
  readonly specificationVersion = 'v4';
  readonly provider: string;
  readonly modelId: string;
  readonly maxEmbeddingsPerCall: number | null;
  readonly supportsParallelCalls: boolean;
  readonly calls: FakeEmbeddingModelCall[] = [];
  readonly doEmbedCalls: any[] = [];
  private readonly answers: FakeEmbeddingAnswer[];
  private readonly answerAll?: (
    call: FakeEmbeddingModelCall,
  ) => FakeEmbeddingAnswer | Promise<FakeEmbeddingAnswer>;

  constructor(
    answers:
      | FakeEmbeddingAnswer[]
      | ((
          call: FakeEmbeddingModelCall,
        ) => FakeEmbeddingAnswer | Promise<FakeEmbeddingAnswer>) = [],
    {
      provider = 'fake',
      modelId = 'fake-embedding-model',
      maxEmbeddingsPerCall,
      supportsParallelCalls = true,
    }: FakeEmbeddingModelOptions = {},
  ) {
    this.provider = provider;
    this.modelId = modelId;
    this.maxEmbeddingsPerCall = maxEmbeddingsPerCall ?? null;
    this.supportsParallelCalls = supportsParallelCalls;
    this.answers = Array.isArray(answers) ? [...answers] : [];
    this.answerAll = typeof answers === 'function' ? answers : undefined;
  }

  /** Adds responses after the unused scripted responses. */
  reply(...answers: FakeEmbeddingAnswer[]): this {
    this.answers.push(...answers);
    return this;
  }

  /** The last provider call, or `undefined`. */
  get lastCall(): FakeEmbeddingModelCall | undefined {
    return this.calls[this.calls.length - 1];
  }

  async doEmbed(options: any): Promise<any> {
    this.doEmbedCalls.push(options);
    const call: FakeEmbeddingModelCall = {
      values: [...(options.values ?? [])],
      options,
    };
    this.calls.push(call);
    options.abortSignal?.throwIfAborted();

    let answer: FakeEmbeddingAnswer | undefined =
      this.answerAll ?? this.answers.shift();
    if (answer === undefined) {
      throw new Error(
        `FakeEmbeddingModel: no answer left for call ${this.calls.length}. Give it more answers.`,
      );
    }
    while (typeof answer === 'function') {
      answer = await answer(call);
    }
    if (answer instanceof Error) {
      throw answer;
    }
    if (answer.delay) {
      await sleep(answer.delay, options.abortSignal);
    }
    options.abortSignal?.throwIfAborted();
    return {
      embeddings: answer.embeddings,
      usage: answer.usage ?? { tokens: call.values.length * 10 },
      warnings: answer.warnings ?? [],
      ...(answer.providerMetadata !== undefined && {
        providerMetadata: answer.providerMetadata,
      }),
      ...(answer.response !== undefined && { response: answer.response }),
    };
  }
}

/** `new FakeEmbeddingModel(answers)`. */
export function fakeEmbeddingModel(
  ...answers: FakeEmbeddingAnswer[]
): FakeEmbeddingModel {
  return new FakeEmbeddingModel(answers);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
