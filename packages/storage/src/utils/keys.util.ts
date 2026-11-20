import { StorageInvalidKeyError } from "../errors";

const MAX_KEY_BYTES = 1024;
// C0 controls, DEL, and C1 controls.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
// Unpaired UTF-16 surrogates.
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * One rule for every disk: a relative, `/`-separated path without `.`/`..`/empty segments,
 * backslashes or control characters, at most 1024 UTF-8 bytes.
 */
export function assertValidKey(key: unknown): asserts key is string {
  if (typeof key !== "string") {
    throw new StorageInvalidKeyError("a key must be a string");
  }
  if (key.length === 0) {
    throw new StorageInvalidKeyError("a key cannot be empty");
  }
  if (Buffer.byteLength(key, "utf8") > MAX_KEY_BYTES) {
    throw new StorageInvalidKeyError(
      `a key cannot be longer than ${MAX_KEY_BYTES} bytes`,
    );
  }
  if (CONTROL.test(key)) {
    throw new StorageInvalidKeyError("a key cannot contain control characters");
  }
  if (key.includes("\\")) {
    throw new StorageInvalidKeyError("a key cannot contain a backslash");
  }
  if (key.startsWith("/")) {
    throw new StorageInvalidKeyError('a key cannot start with "/"');
  }
  if (key.endsWith("/")) {
    throw new StorageInvalidKeyError('a key cannot end with "/"');
  }
  for (const segment of key.split("/")) {
    if (segment === "") {
      throw new StorageInvalidKeyError(
        'a key cannot contain an empty segment ("//")',
      );
    }
    if (segment === "." || segment === "..") {
      throw new StorageInvalidKeyError(
        'a key cannot contain "." or ".." segments',
      );
    }
  }
  if (LONE_SURROGATE.test(key)) {
    throw new StorageInvalidKeyError("a key must be valid Unicode");
  }
}

/** A prefix is a key, or the start of one: it may end with `/`, and may be empty. */
export function assertValidPrefix(prefix: unknown): asserts prefix is string {
  if (typeof prefix !== "string") {
    throw new StorageInvalidKeyError("a prefix must be a string");
  }
  if (prefix === "") {
    return;
  }
  assertValidKey(prefix.endsWith("/") ? prefix.slice(0, -1) : prefix);
}

/** RFC 3986 unreserved characters stay; everything else is percent-encoded as UTF-8. */
export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** A key as a URL path: each segment encoded, the slashes kept. */
export function encodeKeyPath(key: string): string {
  return key.split("/").map(encodeRfc3986).join("/");
}

export function basename(key: string): string {
  return key.slice(key.lastIndexOf("/") + 1);
}
