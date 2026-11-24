import { not } from "./predicate.util";
import { isInteger } from "./type-guards.util";

/**
 * Creates an `AsyncGenerator` yielding elements from a synchronous iterable.
 */
export async function* fromArrayAsync<T>(
  items: Iterable<T>,
): AsyncGenerator<T, void, undefined> {
  for (const item of items) {
    yield item;
  }
}

/**
 * Collects all items from an `AsyncIterable` into an array.
 */
export async function collectAsync<T>(
  iterable: AsyncIterable<T>,
): Promise<T[]> {
  const result: T[] = [];
  for await (const item of iterable) {
    result.push(item);
  }
  return result;
}

/**
 * Lazily transforms every element of an `AsyncIterable`.
 */
export async function* mapAsync<T, R>(
  iterable: AsyncIterable<T>,
  mapper: (item: T, index: number) => Promise<R> | R,
): AsyncGenerator<R, void, undefined> {
  let index = 0;
  for await (const item of iterable) {
    yield await mapper(item, index++);
  }
}

/**
 * Lazily filters elements of an `AsyncIterable`.
 */
export async function* filterAsync<T>(
  iterable: AsyncIterable<T>,
  predicate: (item: T, index: number) => Promise<boolean> | boolean,
): AsyncGenerator<T, void, undefined> {
  let index = 0;
  for await (const item of iterable) {
    if (await predicate(item, index++)) {
      yield item;
    }
  }
}

/**
 * Groups consecutive elements of an `AsyncIterable` into chunks of at most `size`.
 */
export async function* batchAsync<T>(
  iterable: AsyncIterable<T>,
  size: number,
): AsyncGenerator<T[], void, undefined> {
  if (not(isInteger(size)) || size < 1) {
    throw new RangeError(
      `batchAsync: size must be a positive integer (got ${size})`,
    );
  }
  let bucket: T[] = [];
  for await (const item of iterable) {
    bucket.push(item);
    if (bucket.length >= size) {
      yield bucket;
      bucket = [];
    }
  }
  if (bucket.length > 0) {
    yield bucket;
  }
}

/**
 * Yields at most `limit` elements from an `AsyncIterable` and cleanly closes the iterator.
 */
export async function* takeAsync<T>(
  iterable: AsyncIterable<T>,
  limit: number,
): AsyncGenerator<T, void, undefined> {
  if (not(isInteger(limit)) || limit < 0) {
    throw new RangeError(
      `takeAsync: limit must be a non-negative integer (got ${limit})`,
    );
  }
  if (limit === 0) {
    return;
  }
  let taken = 0;
  for await (const item of iterable) {
    yield item;
    taken += 1;
    if (taken >= limit) {
      break;
    }
  }
}

/**
 * Consumes a Web `ReadableStream` into a `Uint8Array` via Bun's native `Bun.readableStreamToBytes()`.
 */
export function streamToBytes(
  stream: ReadableStream,
): Promise<Uint8Array<ArrayBuffer>> {
  return Promise.resolve(Bun.readableStreamToBytes(stream));
}

/**
 * Consumes a Web `ReadableStream` into a UTF-8 string via Bun's native `Bun.readableStreamToText()`.
 */
export function streamToText(stream: ReadableStream): Promise<string> {
  return Promise.resolve(Bun.readableStreamToText(stream));
}

/**
 * Consumes and parses a JSON Web `ReadableStream` via Bun's native `Bun.readableStreamToJSON()`.
 */
export function streamToJson<T = unknown>(stream: ReadableStream): Promise<T> {
  return Promise.resolve(Bun.readableStreamToJSON(stream)) as Promise<T>;
}

/**
 * Concatenates multiple `Uint8Array` / `ArrayBuffer` chunks in a single native allocation
 * via `Bun.concatArrayBuffers()`.
 */
export function concatBytes(
  chunks: readonly (Uint8Array | ArrayBuffer)[],
): Uint8Array {
  if (chunks.length === 0) {
    return new Uint8Array(0);
  }
  return new Uint8Array(
    Bun.concatArrayBuffers(chunks as (Uint8Array | ArrayBuffer)[]),
  );
}

/**
 * Concurrently merges multiple `AsyncIterable` streams, yielding values in arrival order.
 */
export async function* mergeAsyncIterables<T>(
  ...iterables: readonly AsyncIterable<T>[]
): AsyncGenerator<T, void, undefined> {
  type TaggedNext = {
    readonly index: number;
    readonly result: IteratorResult<T>;
  };

  const iterators = iterables.map((it) => it[Symbol.asyncIterator]());
  const pending = new Map<number, Promise<TaggedNext>>();

  const enqueue = (index: number): void => {
    const iterator = iterators[index];
    if (!iterator) {
      return;
    }
    pending.set(
      index,
      iterator.next().then((result) => ({ index, result })),
    );
  };

  for (let i = 0; i < iterators.length; i++) {
    enqueue(i);
  }

  try {
    while (pending.size > 0) {
      const { index, result } = await Promise.race(pending.values());
      pending.delete(index);
      if (!result.done) {
        yield result.value;
        enqueue(index);
      }
    }
  } finally {
    await Promise.allSettled(
      iterators.map((it) => Promise.resolve(it.return?.())),
    );
  }
}
