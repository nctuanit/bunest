import { Logger } from "../logger/logger";

export interface StreamableFileOptions {
  /**
   * MIME type for the `Content-Type` header (defaults to `Blob.type` or `"application/octet-stream"`).
   */
  type?: string;
  /**
   * `Content-Disposition` header value (e.g. `'attachment; filename="report.pdf"'`).
   */
  disposition?: string;
  /**
   * Byte length for the `Content-Length` header (auto-detected for `Uint8Array` and `Blob`/`BunFile`).
   */
  length?: number;
}

export interface StreamableFileHeaders {
  readonly type: string;
  readonly disposition?: string;
  readonly length?: number;
}

export interface StreamableHandlerResponse {
  destroyed?: boolean;
  closed?: boolean;
  headersSent?: boolean;
  statusCode?: number;
  statusMessage?: string;
  destroy?: () => unknown;
  end?: (chunk?: unknown) => unknown;
  send?: (body?: unknown) => unknown;
  [key: string]: unknown;
}

export type StreamableFileSource =
  Uint8Array | ReadableStream<Uint8Array> | Blob;

/**
 * Wraps binary buffers (`Uint8Array`), Web `ReadableStream<Uint8Array>`, or `Blob`
 * (including `Bun.file(...)` `BunFile` instances) for ergonomic streaming HTTP
 * file downloads with automatic `Content-Type`, `Content-Disposition`, and `Content-Length` headers.
 */
export class StreamableFile {
  private readonly source: StreamableFileSource;
  public readonly options: StreamableFileOptions;
  protected logger: Logger = new Logger(StreamableFile.name);
  protected handleError: (
    err: Error,
    response?: StreamableHandlerResponse,
  ) => void = (err: Error, res?: StreamableHandlerResponse) => {
    if (!res || res.destroyed) {
      return;
    }
    this.logError(err);
    if (res.headersSent) {
      const streamEnded =
        (this.source as { readableEnded?: boolean }).readableEnded === true ||
        (this.source instanceof ReadableStream &&
          !this.source.locked &&
          typeof Bun !== "undefined" &&
          typeof Bun.inspect === "function" &&
          Bun.inspect(this.source).includes("state: 'closed'"));
      if (!streamEnded && typeof res.destroy === "function") {
        res.destroy();
      } else {
        res.end?.();
      }
      return;
    }
    res.statusCode = 400;
    if (typeof res.send === "function") {
      res.send("Bad Request");
    } else if (typeof res.end === "function") {
      res.end("Bad Request");
    }
  };
  protected logError: (err: Error) => void = (err: Error) => {
    this.logger.error(err);
  };

  constructor(
    source: StreamableFileSource,
    options: StreamableFileOptions = {},
  ) {
    if (
      !(source instanceof Uint8Array) &&
      !(source instanceof ReadableStream) &&
      !(source instanceof Blob)
    ) {
      throw new TypeError(
        "StreamableFile expects a Uint8Array, ReadableStream<Uint8Array>, or Blob (including BunFile).",
      );
    }
    this.source = source;
    this.options = { ...options };
  }

  /**
   * Returns a Web `ReadableStream<Uint8Array>` (NestJS `stream` getter parity).
   */
  get stream(): ReadableStream<Uint8Array> {
    return this.getStream();
  }

  get errorLogger(): (err: Error) => void {
    return this.logError;
  }

  setErrorLogger(handler: (err: Error) => void): this {
    this.logError = handler;
    return this;
  }

  get errorHandler(): (err: Error, res?: StreamableHandlerResponse) => void {
    return this.handleError;
  }

  setErrorHandler(
    handler: (err: Error, res?: StreamableHandlerResponse) => void,
  ): this {
    this.handleError = handler;
    return this;
  }

  /**
   * Returns the underlying source (`Uint8Array`, `ReadableStream<Uint8Array>`, or `Blob`/`BunFile`).
   */
  getSource(): StreamableFileSource {
    return this.source;
  }

  /**
   * Returns a Web `ReadableStream<Uint8Array>` for streaming the file contents.
   */
  getStream(): ReadableStream<Uint8Array> {
    if (this.source instanceof ReadableStream) {
      return this.source;
    }
    if (this.source instanceof Blob) {
      return this.source.stream();
    }
    const bytes = this.source;
    return new ReadableStream<Uint8Array>({
      start(controller) {
        if (bytes.byteLength > 0) {
          controller.enqueue(bytes);
        }
        controller.close();
      },
    });
  }

  /**
   * Returns resolved file header metadata (`type`, optional `disposition`, optional `length`).
   */
  getHeaders(): StreamableFileHeaders {
    const inferredType =
      this.source instanceof Blob && this.source.type.length > 0
        ? this.source.type
        : "application/octet-stream";

    const inferredLength =
      this.source instanceof Uint8Array
        ? this.source.byteLength
        : this.source instanceof Blob
          ? this.source.size
          : undefined;

    return {
      type: this.options.type ?? inferredType,
      ...(this.options.disposition !== undefined
        ? { disposition: this.options.disposition }
        : {}),
      ...(this.options.length !== undefined
        ? { length: this.options.length }
        : inferredLength !== undefined
          ? { length: inferredLength }
          : {}),
    };
  }
}
