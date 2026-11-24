import type { Duration } from "@bunest/resilience";
import type { AiStep, AiTextResult } from "../interfaces/ai-result.interface";
import type { ModelMessage } from "../interfaces/ai-types.interface";
import type { AiUsage } from "../interfaces/ai-usage.interface";
import { withKeepAlive } from "../http/keep-alive.util";
import { toNodeResponse, writeWebResponse } from "../http/node-response.util";
import { toMilliseconds } from "../utils/duration.util";

const DEFAULT_KEEP_ALIVE_MS = 15_000;
const DEFAULT_ERROR_TEXT = "An error occurred.";

/** What the browser is told about a failure. */
export interface AiUIMessageStreamOptions {
  errorText?: (error: unknown) => string;
}

export interface AiStreamResponseOptions extends AiUIMessageStreamOptions {
  /** Default 200. */
  status?: number;
  headers?: Record<string, string>;
  /** Keep-alive interval. Default `'15s'`; `false` for none. */
  keepAlive?: Duration | false;
}

type StreamEntry = { chunk: Record<string, unknown> } | { error: unknown };

/**
 * A streamed answer: `streamText()`'s result. The call runs once, from the moment it is made, whatever reads it:
 * the UI message stream (`toUIMessageStream()`, `pipeUIMessageStreamToResponse()`), the text (`textStream`,
 * `pipeTextStreamToResponse()`), or the promises, which settle when the call ends.
 */
export class AiTextStream {
  private readonly controller: AbortController;
  /** Everything about the call, when it ends. */
  readonly result: Promise<AiTextResult>;
  private readonly entries: StreamEntry[] = [];
  private readonly waiting = new Set<() => void>();
  private ended = false;
  private readonly opened: Promise<void>;

  /** @internal */
  constructor(
    controller: AbortController,
    produce: (
      emit: (chunk: Record<string, unknown>) => void,
    ) => Promise<AiTextResult>,
  ) {
    this.controller = controller;
    let open!: () => void;
    let fail!: (error: unknown) => void;
    this.opened = new Promise<void>((resolve, reject) => {
      open = resolve;
      fail = reject;
    });

    const push = (entry: StreamEntry) => {
      this.entries.push(entry);
      for (const wake of this.waiting) {
        wake();
      }
      this.waiting.clear();
    };

    const emit = (chunk: Record<string, unknown>) => {
      if (!this.ended) {
        push({ chunk });
        open();
      }
    };

    this.result = Promise.resolve()
      .then(() => produce(emit))
      .then(
        (result) => {
          this.ended = true;
          open();
          this.wakeAll();
          return result;
        },
        (error) => {
          push({ error });
          this.ended = true;
          fail(error);
          this.wakeAll();
          throw error;
        },
      );

    // Rejections are the readers' to handle: an unread stream must not crash the process.
    this.result.catch(() => {});
    this.opened.catch(() => {});
  }

  get text(): Promise<string> {
    return this.result.then((r) => r.text);
  }

  get usage(): Promise<AiUsage> {
    return this.result.then((r) => r.usage);
  }

  get steps(): Promise<AiStep[]> {
    return this.result.then((r) => r.steps);
  }

  get finishReason(): Promise<string> {
    return this.result.then((r) => r.finishReason);
  }

  get responseMessages(): Promise<ModelMessage[]> {
    return this.result.then((r) => r.responseMessages);
  }

  /** The text as it is generated, over every step. Throws the call's error. */
  get textStream(): AsyncIterable<string> {
    const entries = this.read();
    return {
      [Symbol.asyncIterator]: async function* () {
        for await (const entry of entries) {
          if ("error" in entry) {
            throw entry.error;
          }
          if (entry.chunk["type"] === "text-delta") {
            const delta = entry.chunk["delta"] ?? entry.chunk["textDelta"];
            if (typeof delta === "string") {
              yield delta;
            }
          }
        }
      },
    };
  }

  /** The UI message stream: `start`, each step's chunks, `finish`; or an `error` chunk when the call fails. */
  toUIMessageStream({
    errorText = () => DEFAULT_ERROR_TEXT,
  }: AiUIMessageStreamOptions = {}): ReadableStream<Record<string, unknown>> {
    const entries = this.read()[Symbol.asyncIterator]();
    return new ReadableStream<Record<string, unknown>>({
      pull: async (controller) => {
        const next = await entries.next();
        if (next.done) {
          controller.close();
        } else if ("error" in next.value) {
          controller.enqueue({
            type: "error",
            errorText: safely(errorText, next.value.error),
          });
        } else {
          controller.enqueue(next.value.chunk);
        }
      },
      cancel: () => this.abort(),
    });
  }

  /** The UI message stream as a web-standard `Response` (server-sent events). */
  toUIMessageStreamResponse({
    status,
    headers,
    keepAlive,
    ...options
  }: AiStreamResponseOptions = {}): Response {
    const encoder = new TextEncoder();
    const uiStream = this.toUIMessageStream(options);
    const reader = uiStream.getReader();

    let sseBody: ReadableStream<Uint8Array> = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await reader.read();
        if (next.done) {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
          return;
        }
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(next.value)}\n\n`),
        );
      },
      cancel: (reason) => reader.cancel(reason),
    });

    const interval =
      keepAlive === false
        ? undefined
        : toMilliseconds(keepAlive ?? DEFAULT_KEEP_ALIVE_MS, "keepAlive");
    if (interval && interval > 0) {
      sseBody = withKeepAlive(sseBody, interval);
    }

    return new Response(sseBody, {
      status: status ?? 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-vercel-ai-ui-message-stream": "v1",
        ...headers,
      },
    });
  }

  /**
   * Sends the UI message stream to the browser as SSE on a Node `ServerResponse` or Fastify reply.
   * Rejects before writing headers if the call fails before its first chunk.
   */
  async pipeUIMessageStreamToResponse(
    response: unknown,
    options: AiStreamResponseOptions = {},
  ): Promise<void> {
    await this.send(response, () => this.toUIMessageStreamResponse(options));
  }

  /** Sends the text alone, as `text/plain` chunks. */
  async pipeTextStreamToResponse(
    response: unknown,
    {
      status,
      headers,
    }: Omit<AiStreamResponseOptions, "errorText" | "keepAlive"> = {},
  ): Promise<void> {
    const encoder = new TextEncoder();
    const text = this.textStream[Symbol.asyncIterator]();
    await this.send(
      response,
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull: async (controller) => {
              const next = await text.next();
              if (next.done) {
                controller.close();
              } else {
                controller.enqueue(encoder.encode(next.value));
              }
            },
            cancel: () => this.abort(),
          }),
          {
            status: status ?? 200,
            headers: {
              "content-type": "text/plain; charset=utf-8",
              ...headers,
            },
          },
        ),
    );
  }

  /** Aborts the call: the model call in flight and the tools running. */
  abort(reason?: unknown): void {
    this.controller.abort(
      reason ?? new DOMException("The stream was cancelled", "AbortError"),
    );
  }

  private async send(
    platformResponse: unknown,
    create: () => Response,
  ): Promise<void> {
    const node = toNodeResponse(platformResponse);
    const gone = () => {
      if (!node.res.writableFinished) {
        this.abort();
      }
    };
    node.res.once("close", gone);
    try {
      await this.opened;
    } catch (error) {
      node.res.off("close", gone);
      throw error;
    }
    node.open();
    await writeWebResponse(create(), node.res);
  }

  /** Every entry from the first, then the new ones as they come, until the call ends. */
  private read(): AsyncIterable<StreamEntry> {
    const self = this;
    return {
      [Symbol.asyncIterator]: async function* () {
        let position = 0;
        for (;;) {
          if (position < self.entries.length) {
            yield self.entries[position++]!;
            continue;
          }
          if (self.ended) {
            return;
          }
          await new Promise<void>((resolve) => {
            self.waiting.add(resolve);
          });
        }
      },
    };
  }

  private wakeAll(): void {
    for (const wake of this.waiting) {
      wake();
    }
    this.waiting.clear();
  }
}

function safely(errorText: (error: unknown) => string, error: unknown): string {
  try {
    return errorText(error);
  } catch {
    return DEFAULT_ERROR_TEXT;
  }
}
