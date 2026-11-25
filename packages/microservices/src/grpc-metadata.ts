import { MultiMap } from "@bunest/core";

export const RESERVED_HTTP_HEADERS = new Set([
  "content-type",
  "content-length",
  "grpc-status",
  "grpc-message",
  "grpc-timeout",
  "grpc-encoding",
  "grpc-accept-encoding",
  "te",
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "user-agent",
  "accept",
  "accept-encoding",
  "date",
  "server",
]);

export function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n\0]+/g, " ");
}

export function sanitizeHeaderKey(key: string): string {
  return key
    .trim()
    .toLowerCase()
    .replace(/[\r\n\0:]+/g, "");
}

export function sanitizeMetadataHeaders(
  metadata?: GrpcMetadata,
): Record<string, string> {
  if (!metadata) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [rawKey, rawVal] of Object.entries(metadata.toHeaders())) {
    const key = sanitizeHeaderKey(rawKey);
    if (!key || RESERVED_HTTP_HEADERS.has(key)) {
      continue;
    }
    out[key] = sanitizeHeaderValue(rawVal);
  }
  return out;
}

/**
 * Case-insensitive gRPC request/response metadata container supporting ASCII and
 * base64-encoded binary (`-bin`) header values.
 */
export class GrpcMetadata {
  private readonly entries = new MultiMap<string, string>();

  constructor(initial?: Readonly<Record<string, string | Uint8Array>>) {
    if (initial) {
      for (const [key, value] of Object.entries(initial)) {
        this.set(key, value);
      }
    }
  }

  private normalizeKey(key: string): string {
    return sanitizeHeaderKey(key);
  }

  private encodeValue(key: string, value: string | Uint8Array): string {
    if (typeof value === "string") {
      return sanitizeHeaderValue(value);
    }
    if (!key.endsWith("-bin")) {
      return sanitizeHeaderValue(Buffer.from(value).toString("utf8"));
    }
    return Buffer.from(value).toString("base64");
  }

  set(key: string, value: string | Uint8Array): this {
    const k = this.normalizeKey(key);
    this.entries.deleteKey(k);
    this.entries.add(k, this.encodeValue(k, value));
    return this;
  }

  add(key: string, value: string | Uint8Array): this {
    const k = this.normalizeKey(key);
    this.entries.add(k, this.encodeValue(k, value));
    return this;
  }

  get(key: string): string | undefined {
    return this.entries.get(this.normalizeKey(key))[0];
  }

  getAll(key: string): readonly string[] {
    return [...this.entries.get(this.normalizeKey(key))];
  }

  getBuffer(key: string): Uint8Array | undefined {
    const k = this.normalizeKey(key);
    const val = this.get(k);
    if (val === undefined) {
      return undefined;
    }
    if (k.endsWith("-bin")) {
      return new Uint8Array(Buffer.from(val, "base64"));
    }
    return new Uint8Array(Buffer.from(val, "utf8"));
  }

  has(key: string): boolean {
    return this.entries.has(this.normalizeKey(key));
  }

  delete(key: string): boolean {
    return this.entries.deleteKey(this.normalizeKey(key));
  }

  keys(): string[] {
    return [...this.entries.keys()];
  }

  toHeaders(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, values] of this.entries.entries()) {
      if (values.length > 0) {
        out[key] = values.join(", ");
      }
    }
    return out;
  }

  toRecord(): Record<string, string> {
    return this.toHeaders();
  }

  clone(): GrpcMetadata {
    const copy = new GrpcMetadata();
    for (const [key, values] of this.entries.entries()) {
      for (const value of values) {
        copy.entries.add(key, value);
      }
    }
    return copy;
  }

  static fromHeaders(
    headers: Headers | Readonly<Record<string, string>>,
  ): GrpcMetadata {
    const md = new GrpcMetadata();
    if (headers instanceof Headers) {
      headers.forEach((value, key) => {
        const lower = key.toLowerCase();
        if (!RESERVED_HTTP_HEADERS.has(lower)) {
          md.set(lower, value);
        }
      });
    } else {
      for (const [key, value] of Object.entries(headers)) {
        const lower = key.toLowerCase();
        if (!RESERVED_HTTP_HEADERS.has(lower)) {
          md.set(lower, value);
        }
      }
    }
    return md;
  }
}
