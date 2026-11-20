import type { TestResponse } from "./test-client";

export interface SseEvent {
  readonly id?: string;
  readonly event?: string;
  readonly data: string;
  readonly retry?: number;
}

export interface ReadSseEventsOptions {
  /**
   * Maximum number of SSE events to read before cancelling the underlying stream.
   */
  readonly maxEvents?: number;
  /**
   * Optional AbortSignal that cancels reading and terminates the upstream SSE generator.
   */
  readonly signal?: AbortSignal;
  /**
   * Optional timeout in milliseconds after which reading stops and the reader is cancelled.
   */
  readonly timeoutMs?: number;
}

interface EventAccumulator {
  id?: string;
  event?: string;
  retry?: number;
  dataLines: string[];
  hasField: boolean;
}

function createAccumulator(): EventAccumulator {
  return {
    dataLines: [],
    hasField: false,
  };
}

function flushEvent(acc: EventAccumulator): SseEvent | undefined {
  if (!acc.hasField && acc.dataLines.length === 0) {
    return undefined;
  }
  const event: SseEvent = {
    ...(acc.id !== undefined ? { id: acc.id } : {}),
    ...(acc.event !== undefined ? { event: acc.event } : {}),
    ...(acc.retry !== undefined ? { retry: acc.retry } : {}),
    data: acc.dataLines.join("\n"),
  };
  return event;
}

function applyFieldLine(acc: EventAccumulator, line: string): void {
  // Comment line
  if (line.startsWith(":")) {
    return;
  }

  const colonIdx = line.indexOf(":");
  let field: string;
  let value: string;

  if (colonIdx === -1) {
    field = line;
    value = "";
  } else {
    field = line.slice(0, colonIdx);
    value = line.slice(colonIdx + 1);
    // Per W3C SSE spec, strip at most one leading U+0020 SPACE
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }
  }

  switch (field) {
    case "data":
      acc.dataLines.push(value);
      acc.hasField = true;
      break;
    case "event":
      acc.event = value;
      acc.hasField = true;
      break;
    case "id":
      if (!value.includes("\0")) {
        acc.id = value;
        acc.hasField = true;
      }
      break;
    case "retry":
      if (/^\d+$/.test(value)) {
        acc.retry = Number.parseInt(value, 10);
        acc.hasField = true;
      }
      break;
    default:
      break;
  }
}

/**
 * Reads Server-Sent Events (SSE) frames from a `TestResponse` or native `Response`,
 * parsing `id`, `event`, `data`, and `retry` fields per the W3C EventSource spec
 * and cleanly cancelling the stream reader once `maxEvents`, `signal`, or `timeoutMs` triggers.
 */
export async function readSseEvents(
  responseOrRaw: TestResponse | Response,
  options: ReadSseEventsOptions = {},
): Promise<SseEvent[]> {
  const rawResponse =
    responseOrRaw instanceof Response ? responseOrRaw : responseOrRaw.raw;

  if (!rawResponse.body) {
    return [];
  }

  const { maxEvents, signal, timeoutMs } = options;
  if (maxEvents !== undefined && maxEvents <= 0) {
    await rawResponse.body.cancel().catch(() => {});
    return [];
  }

  const reader = rawResponse.body.getReader();
  const decoder = new TextDecoder();
  const events: SseEvent[] = [];
  let buffer = "";
  let acc = createAccumulator();
  let stopped = false;

  const stopReader = () => {
    if (!stopped) {
      stopped = true;
      void reader.cancel().catch(() => {});
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  let signalListenerAttached = false;

  const processLines = (finalChunk: boolean): boolean => {
    // Normalize CRLF and stray CR into LF while keeping a potential trailing CR for next chunk
    if (!finalChunk && buffer.endsWith("\r")) {
      const safe = buffer.slice(0, -1).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      buffer = `${safe}\r`;
    } else {
      buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    }

    let nlIdx = buffer.indexOf("\n");
    while (nlIdx !== -1) {
      const line = buffer.slice(0, nlIdx);
      buffer = buffer.slice(nlIdx + 1);

      if (line === "") {
        const evt = flushEvent(acc);
        acc = createAccumulator();
        if (evt) {
          events.push(evt);
          if (maxEvents !== undefined && events.length >= maxEvents) {
            return true;
          }
        }
      } else {
        applyFieldLine(acc, line);
      }

      nlIdx = buffer.indexOf("\n");
    }

    return false;
  };

  try {
    if (signal?.aborted) {
      stopped = true;
      await reader.cancel().catch(() => {});
      return events;
    }

    if (signal) {
      signal.addEventListener("abort", stopReader, { once: true });
      signalListenerAttached = true;
    }

    if (timeoutMs !== undefined && timeoutMs >= 0) {
      timer = setTimeout(stopReader, timeoutMs);
    }

    while (!stopped) {
      const { value, done } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        processLines(true);
        break;
      }

      if (value) {
        buffer += decoder.decode(value, { stream: true });
        const reachedLimit = processLines(false);
        if (reachedLimit) {
          stopped = true;
          await reader.cancel().catch(() => {});
          break;
        }
      }
    }
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (signal && signalListenerAttached) {
      signal.removeEventListener("abort", stopReader);
    }
    try {
      reader.releaseLock();
    } catch {
      // Lock already released on cancel
    }
  }

  return events;
}

/**
 * Convenience helper to parse an `SseEvent`'s JSON `data` payload.
 */
export function parseSseJson<T = unknown>(event: SseEvent): T {
  return JSON.parse(event.data) as T;
}
