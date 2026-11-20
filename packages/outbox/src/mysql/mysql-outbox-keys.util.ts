import { createHash } from "node:crypto";

/**
 * The length, in characters, of the columns that hold ids, topics, keys, consumer names and lease owners.
 */
export const KEY_LENGTH = 255;

/**
 * How many lock rows the message keys share.
 */
export const KEY_BUCKETS = 16_384;

/** The bucket of a message's key: the first 32 bits of its SHA-256, modulo `KEY_BUCKETS`. */
export function keyBucket(key: string): number {
  return (
    createHash("sha256").update(key, "utf8").digest().readUInt32BE(0) %
    KEY_BUCKETS
  );
}

const bucketLock = (bucket: number): string => `key-bucket:${bucket}`;

/** The lock keys of `keys`' buckets, each once: none for messages without a key. */
export function keyLocks(keys: Iterable<string | null>): string[] {
  const buckets = new Set<number>();
  for (const key of keys) {
    if (key !== null) {
      buckets.add(keyBucket(key));
    }
  }
  return [...buckets].map(bucketLock);
}

/** The lock keys of every bucket, whose rows the store creates at startup. */
export function bucketLocks(): string[] {
  return Array.from({ length: KEY_BUCKETS }, (_, bucket) => bucketLock(bucket));
}

/**
 * Throws a `RangeError` when `value` is longer than its column holds. Counts code points as MySQL does.
 */
export function checkLength(value: string, what: string, method: string): void {
  if (value.length <= KEY_LENGTH) {
    return;
  }
  const characters = [...value];
  if (characters.length > KEY_LENGTH) {
    throw new RangeError(
      `MySqlOutboxStore.${method}(): ${what} is at most ${KEY_LENGTH} characters on MySQL (its column's length), and "${characters.slice(0, 40).join("")}..." has ${characters.length}.`,
    );
  }
}
