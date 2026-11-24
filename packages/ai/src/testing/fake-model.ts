import type {
  LanguageModelCallOptions,
  LanguageModelContentPart,
  LanguageModelGenerateResult,
  LanguageModelPromptMessage,
  LanguageModelStreamPart,
  LanguageModelStreamResult,
  LanguageModelToolResultPart,
  LanguageModelToolSpec,
} from "../interfaces/ai-types.interface";
import type { AiUsage } from "../interfaces/ai-usage.interface";
import {
  createProviderApiError,
  type ProviderApiCallError,
} from "../providers/http-provider";

/** A tool call the fake model makes. */
export interface FakeToolCall {
  /** The tool's name. */
  name: string;
  /** Its arguments. Default `{}`. */
  input?: unknown;
  /** Default `call-<n>`. */
  id?: string;
}

/** One answer of the fake model. */
export interface FakeTurn {
  text?: string;
  /** Answered as JSON text: what `generateObject()` reads. */
  object?: unknown;
  toolCalls?: FakeToolCall[];
  /** Default: 10 input and 10 output tokens. */
  usage?: Partial<
    Pick<
      AiUsage,
      "inputTokens" | "outputTokens" | "cachedInputTokens" | "reasoningTokens"
    >
  >;
  /** Default `tool-calls` with tool calls, else `stop`. */
  finishReason?: string;
  /** Milliseconds before the model answers. */
  delay?: number;
  /** Milliseconds between a stream's chunks. */
  chunkDelay?: number;
  /** A stream fails with this error after its text. */
  streamError?: unknown;
}

/** What the fake model answers a call with. */
export type FakeAnswer =
  | string
  | FakeTurn
  | Error
  | ((call: FakeModelCall) => FakeAnswer | Promise<FakeAnswer>);

/** A call the fake model received. */
export interface FakeModelCall {
  stream: boolean;
  instructions?: string;
  lastUserMessage?: string;
  toolResults: Array<{
    toolName: string;
    toolCallId: string;
    output: unknown;
  }>;
  tools: string[];
  options: LanguageModelCallOptions;
}

/**
 * A language model for tests, with no network: it answers each call with the next of its `answers`
 * (text, tool calls, objects, errors, delays), and records the calls.
 */
export class FakeModel {
  readonly specificationVersion = "v4";
  readonly provider: string;
  readonly modelId: string;
  readonly supportedUrls:
    Record<string, RegExp[]> | PromiseLike<Record<string, RegExp[]>> = {};
  readonly calls: FakeModelCall[] = [];
  readonly doGenerateCalls: LanguageModelCallOptions[] = [];
  readonly doStreamCalls: LanguageModelCallOptions[] = [];
  private readonly answers: FakeAnswer[];
  private readonly answerAll?: (
    call: FakeModelCall,
  ) => FakeAnswer | Promise<FakeAnswer>;
  private toolCallCount = 0;

  constructor(
    answers:
      | FakeAnswer[]
      | ((call: FakeModelCall) => FakeAnswer | Promise<FakeAnswer>) = [],
    {
      provider = "fake",
      modelId = "fake-model",
    }: { modelId?: string; provider?: string } = {},
  ) {
    this.provider = provider;
    this.modelId = modelId;
    this.answers = Array.isArray(answers) ? [...answers] : [];
    this.answerAll = typeof answers === "function" ? answers : undefined;
  }

  /** Adds answers, after the ones not used yet. */
  reply(...answers: FakeAnswer[]): this {
    this.answers.push(...answers);
    return this;
  }

  /** The last call, or `undefined`. */
  get lastCall(): FakeModelCall | undefined {
    return this.calls[this.calls.length - 1];
  }

  async doGenerate(
    options: LanguageModelCallOptions,
  ): Promise<LanguageModelGenerateResult> {
    this.doGenerateCalls.push(options);
    const turn = await this.answer(options, false);
    return this.generate(turn, options);
  }

  async doStream(
    options: LanguageModelCallOptions,
  ): Promise<LanguageModelStreamResult> {
    this.doStreamCalls.push(options);
    const turn = await this.answer(options, true);
    return this.stream(turn, options);
  }

  private async answer(
    options: LanguageModelCallOptions,
    stream: boolean,
  ): Promise<FakeTurn> {
    const call = describeCall(options, stream);
    this.calls.push(call);
    let answer: FakeAnswer | undefined = this.answerAll ?? this.answers.shift();
    if (answer === undefined) {
      throw new Error(
        `FakeModel: no answer left for call ${this.calls.length}. Give it more answers.`,
      );
    }
    while (typeof answer === "function") {
      answer = await answer(call);
    }
    if (answer instanceof Error) {
      throw answer;
    }
    const turn: FakeTurn =
      typeof answer === "string" ? { text: answer } : answer;
    if (turn.delay) {
      await sleep(turn.delay, options.abortSignal);
    }
    return turn;
  }

  private generate(
    turn: FakeTurn,
    options: LanguageModelCallOptions,
  ): LanguageModelGenerateResult {
    options.abortSignal?.throwIfAborted();
    const text = textOf(turn);
    const toolCalls = this.makeToolCalls(turn);
    return {
      content: [
        ...(text ? [{ type: "text" as const, text }] : []),
        ...toolCalls,
      ],
      finishReason: finishOf(turn, toolCalls.length),
      usage: usageOf(turn),
      warnings: [],
      response: {
        id: `response-${this.calls.length}`,
        modelId: this.modelId,
        timestamp: new Date(0),
      },
    };
  }

  private stream(
    turn: FakeTurn,
    options: LanguageModelCallOptions,
  ): LanguageModelStreamResult {
    const text = textOf(turn);
    const toolCalls = this.makeToolCalls(turn);
    const parts: LanguageModelStreamPart[] = [
      { type: "stream-start", warnings: [] },
      {
        type: "response-metadata",
        id: `response-${this.calls.length}`,
        modelId: this.modelId,
        timestamp: new Date(0),
      },
    ];
    if (text) {
      parts.push({ type: "text-start", id: "text-0" });
      for (const delta of text.match(/\S+\s*|\s+/g) ?? []) {
        parts.push({ type: "text-delta", id: "text-0", delta });
      }
      parts.push({ type: "text-end", id: "text-0" });
    }
    parts.push(...toolCalls);
    if (turn.streamError !== undefined) {
      parts.push({ type: "error", error: turn.streamError });
    } else {
      parts.push({
        type: "finish",
        finishReason: finishOf(turn, toolCalls.length),
        usage: usageOf(turn),
      });
    }

    const signal: AbortSignal | undefined = options.abortSignal;
    let index = 0;
    return {
      stream: new ReadableStream<LanguageModelStreamPart>({
        pull: async (controller) => {
          if (index > 0 && turn.chunkDelay) {
            try {
              await sleep(turn.chunkDelay, signal);
            } catch (error) {
              controller.error(error);
              return;
            }
          }
          if (signal?.aborted) {
            controller.error(signal.reason);
            return;
          }
          const part = parts[index++];
          if (part === undefined) {
            controller.close();
          } else {
            controller.enqueue(part);
            if (part.type === "error") {
              controller.close();
            }
          }
        },
      }),
    };
  }

  private makeToolCalls(
    turn: FakeTurn,
  ): Array<Extract<LanguageModelContentPart, { type: "tool-call" }>> {
    return (turn.toolCalls ?? []).map((call) => ({
      type: "tool-call" as const,
      toolCallId: call.id ?? `call-${++this.toolCallCount}`,
      toolName: call.name,
      input: JSON.stringify(call.input ?? {}),
    }));
  }
}

/** `new FakeModel(answers)`. */
export function fakeModel(...answers: FakeAnswer[]): FakeModel {
  return new FakeModel(answers);
}

/**
 * A provider's HTTP error: retryable for 408, 409, 429 and 5xx. `retryAfter` (in seconds)
 * is sent as a `retry-after` header.
 */
export function providerError(
  status: number,
  { message, retryAfter }: { message?: string; retryAfter?: number } = {},
): ProviderApiCallError {
  return createProviderApiError({
    message: message ?? `The provider answered ${status}`,
    url: "https://fake-provider.test/v1/messages",
    requestBodyValues: {},
    statusCode: status,
    ...(retryAfter !== undefined && {
      responseHeaders: { "retry-after": String(retryAfter) },
    }),
  });
}

function textOf(turn: FakeTurn): string {
  return turn.object !== undefined
    ? JSON.stringify(turn.object)
    : (turn.text ?? "");
}

function finishOf(turn: FakeTurn, toolCalls: number) {
  const unified = turn.finishReason ?? (toolCalls > 0 ? "tool-calls" : "stop");
  return { unified, raw: unified };
}

function usageOf(turn: FakeTurn) {
  const input = turn.usage?.inputTokens ?? 10;
  const output = turn.usage?.outputTokens ?? 10;
  const cached = turn.usage?.cachedInputTokens ?? 0;
  const reasoning = turn.usage?.reasoningTokens ?? 0;
  return {
    inputTokens: {
      total: input,
      noCache: input - cached,
      cacheRead: cached,
      cacheWrite: undefined,
    },
    outputTokens: { total: output, text: output - reasoning, reasoning },
  };
}

function isTextContentPart(part: unknown): part is { type: "text"; text: string } {
  return (
    typeof part === "object" &&
    part !== null &&
    (part as { type?: unknown }).type === "text" &&
    typeof (part as { text?: unknown }).text === "string"
  );
}

function isToolResultPart(part: unknown): part is LanguageModelToolResultPart {
  return (
    typeof part === "object" &&
    part !== null &&
    (part as { type?: unknown }).type === "tool-result"
  );
}

function describeCall(
  options: LanguageModelCallOptions,
  stream: boolean,
): FakeModelCall {
  const prompt: LanguageModelPromptMessage[] = options.prompt ?? [];
  const system = prompt
    .filter((message) => message.role === "system")
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .filter(isTextContentPart)
              .map((p) => p.text)
              .join("")
          : "",
    );
  const lastUser = [...prompt]
    .reverse()
    .find((message) => message.role === "user");
  const trailingTools: LanguageModelPromptMessage[] = [];
  for (let i = prompt.length - 1; i >= 0 && prompt[i]?.role === "tool"; i--) {
    trailingTools.unshift(prompt[i]!);
  }
  const toolsList: LanguageModelToolSpec[] =
    options.tools ?? options.mode?.tools ?? [];
  return {
    stream,
    ...(system.length > 0 && { instructions: system.join("\n") }),
    ...(lastUser && {
      lastUserMessage:
        typeof lastUser.content === "string"
          ? lastUser.content
          : Array.isArray(lastUser.content)
            ? lastUser.content
                .filter(isTextContentPart)
                .map((part) => part.text)
                .join("")
            : "",
    }),
    toolResults: trailingTools.flatMap((message) =>
      Array.isArray(message.content)
        ? message.content.filter(isToolResultPart).map((part) => {
            const outputObj =
              typeof part.output === "object" &&
              part.output !== null &&
              "value" in part.output
                ? (part.output as { value?: unknown }).value
                : part.output;
            return {
              toolName: part.toolName ?? "",
              toolCallId: part.toolCallId ?? "",
              output: outputObj,
            };
          })
        : [],
    ),
    tools: toolsList.map((tool) => tool.name),
    options,
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
