import { StorageBodyLengthError } from "../errors";
import type { StorageBody } from "../interfaces/storage-types";

/** The byte length of a body that is already in memory, else `undefined`. */
export function knownLength(body: StorageBody): number | undefined {
  if (typeof body === "string") {
    return Buffer.byteLength(body, "utf8");
  }
  if (Buffer.isBuffer(body)) {
    return body.byteLength;
  }
  if (body instanceof Uint8Array) {
    return body.byteLength;
  }
  return undefined;
}

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  if (typeof chunk === "string") {
    return Buffer.from(chunk, "utf8");
  }
  throw new TypeError(
    "Storage body chunk must be a Uint8Array, Buffer, or string",
  );
}

/** Any accepted body as an async iterable of Buffers. Throws a `TypeError` for anything else. */
export function toChunks(body: StorageBody): AsyncIterable<Buffer> {
  if (typeof body === "string") {
    const buf = Buffer.from(body, "utf8");
    return {
      async *[Symbol.asyncIterator]() {
        if (buf.byteLength > 0) {
          yield buf;
        }
      },
    };
  }
  if (Buffer.isBuffer(body)) {
    return {
      async *[Symbol.asyncIterator]() {
        if (body.byteLength > 0) {
          yield body;
        }
      },
    };
  }
  if (body instanceof Uint8Array) {
    const buf = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
    return {
      async *[Symbol.asyncIterator]() {
        if (buf.byteLength > 0) {
          yield buf;
        }
      },
    };
  }
  if (body instanceof ReadableStream) {
    return {
      async *[Symbol.asyncIterator]() {
        const reader = body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value && value.byteLength > 0) {
              yield toBuffer(value);
            }
          }
        } finally {
          reader.releaseLock();
        }
      },
    };
  }
  if (
    body !== null &&
    typeof body === "object" &&
    Symbol.asyncIterator in body &&
    typeof (body as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function"
  ) {
    const iterable = body as AsyncIterable<Uint8Array>;
    return {
      async *[Symbol.asyncIterator]() {
        for await (const chunk of iterable) {
          const buf = toBuffer(chunk);
          if (buf.byteLength > 0) {
            yield buf;
          }
        }
      },
    };
  }
  throw new TypeError(
    "Storage body must be a Buffer, Uint8Array, string, Readable, ReadableStream, or AsyncIterable<Uint8Array>",
  );
}

/**
 * Passes chunks through, and fails with `StorageBodyLengthError` as soon as the body runs
 * past `expected`, or when it ends short of it.
 */
export function checkLength(
  source: AsyncIterable<Buffer>,
  expected: number | undefined,
): AsyncIterable<Buffer> {
  if (expected === undefined) {
    return source;
  }
  return {
    async *[Symbol.asyncIterator]() {
      let total = 0;
      for await (const chunk of source) {
        total += chunk.byteLength;
        if (total > expected) {
          throw new StorageBodyLengthError(expected, total);
        }
        yield chunk;
      }
      if (total !== expected) {
        throw new StorageBodyLengthError(expected, total);
      }
    },
  };
}

export async function readAll(
  stream: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  if (stream instanceof ReadableStream) {
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          chunks.push(toBuffer(value));
        }
      }
    } catch (err) {
      await reader.cancel(err).catch(() => {});
      throw err;
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks);
  }
  for await (const chunk of stream) {
    chunks.push(toBuffer(chunk));
  }
  return Buffer.concat(chunks);
}

/** Wraps an in-memory byte slice (or empty body) as a Web `ReadableStream<Uint8Array>`. */
export function bytesToReadableStream(
  data?: Uint8Array,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (data && data.byteLength > 0) {
        controller.enqueue(data);
      }
      controller.close();
    },
  });
}

/** Ensures a `ReadableStream<Uint8Array>` or `AsyncIterable<Uint8Array>` is a Web `ReadableStream<Uint8Array>`. */
export function toReadableStream(
  source: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
): ReadableStream<Uint8Array> {
  if (source instanceof ReadableStream) {
    return source;
  }
  let iterator: AsyncIterator<Uint8Array> | undefined;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!iterator) {
        iterator = source[Symbol.asyncIterator]();
      }
      const next = await iterator.next();
      if (next.done) {
        controller.close();
        return;
      }
      const value = next.value;
      if (value instanceof Uint8Array) {
        controller.enqueue(value);
      } else {
        controller.enqueue(toBuffer(value));
      }
    },
    async cancel() {
      await iterator?.return?.().catch(() => {});
    },
  });
}

/**
 * Throws the signal's reason as soon as it aborts: between chunks, and also while the source
 * is still producing the next one.
 */
export function abortable(
  source: AsyncIterable<Buffer>,
  signal: AbortSignal | undefined,
): AsyncIterable<Buffer> {
  if (!signal) {
    return source;
  }
  return {
    async *[Symbol.asyncIterator]() {
      if (signal.aborted) {
        throw signal.reason ?? new DOMException("Aborted", "AbortError");
      }
      const iterator = source[Symbol.asyncIterator]();
      try {
        while (true) {
          if (signal.aborted) {
            throw signal.reason ?? new DOMException("Aborted", "AbortError");
          }
          let onAbort: (() => void) | undefined;
          const abortPromise = new Promise<never>((_resolve, reject) => {
            onAbort = () =>
              reject(
                signal.reason ?? new DOMException("Aborted", "AbortError"),
              );
            signal.addEventListener("abort", onAbort, { once: true });
          });
          try {
            const next = await Promise.race([iterator.next(), abortPromise]);
            if (next.done) {
              break;
            }
            yield next.value;
          } finally {
            if (onAbort) {
              signal.removeEventListener("abort", onAbort);
            }
          }
        }
      } catch (err) {
        void iterator.return?.().catch(() => {});
        throw err;
      }
    },
  };
}
