export interface JsonlChunkResult<T = unknown> {
  readonly values: T[];
  readonly read: number;
  readonly done: boolean;
  readonly error: SyntaxError | null;
}

export interface ByteSinkLike {
  start(options?: {
    asUint8Array?: boolean;
    highWaterMark?: number;
    stream?: boolean;
  }): void;
  write(chunk: string | ArrayBufferView | ArrayBuffer): number;
  flush(): Uint8Array | ArrayBuffer | number;
  end(): Uint8Array | ArrayBuffer;
}

interface BunNativeExtras {
  nanoseconds(): number;
  deepMatch(subset: unknown, target: unknown): boolean;
  semver: {
    satisfies(version: string, range: string): boolean;
    order(a: string, b: string): -1 | 0 | 1;
  };
  JSONL: {
    parse(input: string | Uint8Array): unknown[];
    parseChunk(
      input: string | Uint8Array,
      start?: number,
      end?: number,
    ): JsonlChunkResult;
  };
  indexOfLine(bytes: Uint8Array, offset?: number): number;
  ArrayBufferSink: new () => ByteSinkLike;
}

function bunExtras(): BunNativeExtras {
  return Bun as unknown as BunNativeExtras;
}

const WALL_CLOCK_DRIFT_THRESHOLD_NS = 1_000_000_000n;
let cachedEpochOriginNs: bigint | undefined;

export interface MonotonicAndUnixNano {
  readonly monotonicNs: number;
  readonly unixNano: bigint;
}

/**
 * Samples `Bun.nanoseconds()` once and returns both the monotonic nanosecond
 * counter and the corresponding Unix epoch timestamp in nanoseconds (`bigint`).
 * Re-anchors automatically if wall-clock drift exceeds 1 second (e.g. OS sleep or NTP step).
 */
export function nowMonotonicAndUnixNano(): MonotonicAndUnixNano {
  const monotonicNs = bunExtras().nanoseconds();
  const monoBig = BigInt(Math.trunc(monotonicNs));
  const wallNs = BigInt(Date.now()) * 1_000_000n;
  if (cachedEpochOriginNs === undefined) {
    cachedEpochOriginNs = wallNs - monoBig;
  } else {
    const estimatedWallNs = cachedEpochOriginNs + monoBig;
    const drift =
      wallNs >= estimatedWallNs
        ? wallNs - estimatedWallNs
        : estimatedWallNs - wallNs;
    if (drift > WALL_CLOCK_DRIFT_THRESHOLD_NS) {
      cachedEpochOriginNs = wallNs - monoBig;
    }
  }
  return {
    monotonicNs,
    unixNano: cachedEpochOriginNs + monoBig,
  };
}

/**
 * Returns a monotonic high-resolution timestamp in nanoseconds since process start
 * via Bun's native `Bun.nanoseconds()`.
 */
export function nanoseconds(): number {
  return bunExtras().nanoseconds();
}

/**
 * Returns the current Unix epoch timestamp in nanoseconds as a `bigint`, anchored
 * to `Date.now()` and advanced monotonically via `Bun.nanoseconds()` for true
 * sub-microsecond precision (re-anchoring automatically on >1s wall-clock jumps).
 */
export function nowUnixNanoBigInt(): bigint {
  return nowMonotonicAndUnixNano().unixNano;
}

/**
 * Returns `true` when every property in `subset` recursively matches `target`
 * via Bun's native `Bun.deepMatch(subset, target)`.
 *
 * Note: `subset` is the first argument and `target` (superset) is the second,
 * matching `Bun.deepMatch(subset, target)`. See `matchesShape(target, subset)`
 * for `actual`-first ergonomics.
 */
export function isDeepMatch(subset: unknown, target: unknown): boolean {
  return bunExtras().deepMatch(subset, target);
}

/**
 * Returns `true` when `target` structurally matches all properties specified
 * in `subset` (convenience wrapper over `Bun.deepMatch(subset, target)` with
 * `target`-first argument order).
 */
export function matchesShape(target: unknown, subset: unknown): boolean {
  return bunExtras().deepMatch(subset, target);
}

/**
 * Checks whether a semver `version` satisfies a semver `range` via Bun's Zig-native
 * `Bun.semver.satisfies()`.
 */
export function semverSatisfies(version: string, range: string): boolean {
  return bunExtras().semver.satisfies(version, range);
}

/**
 * Compares two semver version strings (`-1`, `0`, or `1`) via Bun's Zig-native
 * `Bun.semver.order()`.
 */
export function semverOrder(a: string, b: string): -1 | 0 | 1 {
  return bunExtras().semver.order(a, b);
}

/**
 * Parses a complete JSONL / NDJSON string or byte buffer into an array of parsed
 * values using Bun's Zig-native `Bun.JSONL.parse()`.
 */
export function parseJsonl<T = unknown>(input: string | Uint8Array): T[] {
  return bunExtras().JSONL.parse(input) as T[];
}

/**
 * Incrementally parses a JSONL / NDJSON chunk, returning parsed values along with
 * bytes/chars consumed (`read`), `done`, and any syntax `error` via `Bun.JSONL.parseChunk()`.
 */
export function parseJsonlChunk<T = unknown>(
  input: string | Uint8Array,
  start?: number,
  end?: number,
): JsonlChunkResult<T> {
  const jsonl = bunExtras().JSONL;
  if (end !== undefined) {
    return jsonl.parseChunk(input, start ?? 0, end) as JsonlChunkResult<T>;
  }
  if (start !== undefined) {
    return jsonl.parseChunk(input, start) as JsonlChunkResult<T>;
  }
  return jsonl.parseChunk(input) as JsonlChunkResult<T>;
}

/**
 * Finds the byte index of the next `\n` (`0x0A`) in `bytes` starting at `offset`
 * (or `-1` if none) using Bun's SIMD-accelerated `Bun.indexOfLine()`.
 */
export function indexOfLine(bytes: Uint8Array, offset = 0): number {
  return offset > 0
    ? bunExtras().indexOfLine(bytes, offset)
    : bunExtras().indexOfLine(bytes);
}

/**
 * Creates and starts a native `Bun.ArrayBufferSink` configured to emit `Uint8Array`
 * chunks for fast streaming byte accumulation without O(n^2) reallocations.
 */
export function createByteSink(options?: {
  readonly highWaterMark?: number;
  readonly stream?: boolean;
}): ByteSinkLike {
  const sink = new (bunExtras().ArrayBufferSink)();
  sink.start({
    asUint8Array: true,
    highWaterMark: options?.highWaterMark,
    stream: options?.stream ?? false,
  });
  return sink;
}
