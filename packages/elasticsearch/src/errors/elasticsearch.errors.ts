import { isObject, isString } from "@bunest/core/common";

export interface ElasticsearchErrorMeta {
  body?: unknown;
  statusCode?: number | null;
  headers?: Record<string, string>;
  warnings?: string[];
  meta?: {
    context?: Record<string, unknown> | null;
    name?: string | symbol;
    request?: {
      params: object;
      options: object;
      id?: string | number;
    };
    connection?: {
      url: string;
      id: string;
    };
    attempts?: number;
    aborted?: boolean;
  };
}

export class ElasticsearchError extends Error {
  readonly meta?: ElasticsearchErrorMeta;

  constructor(message: string, meta?: ElasticsearchErrorMeta, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "ElasticsearchError";
    this.meta = meta;
  }
}

export class ElasticsearchResponseError extends ElasticsearchError {
  readonly statusCode: number;
  readonly body: unknown;

  constructor(
    meta: ElasticsearchErrorMeta & { statusCode: number; body: unknown },
  ) {
    const bodyObj = isObject(meta.body) ? meta.body : undefined;
    const errorField = bodyObj?.error;
    const errorObj = isObject(errorField) ? errorField : undefined;
    const reason =
      [errorObj?.reason, errorObj?.type, errorField].find(isString) ??
      `HTTP ${meta.statusCode}`;
    super(`Response Error (${meta.statusCode}): ${reason}`, meta);
    this.name = "ResponseError";
    this.statusCode = meta.statusCode;
    this.body = meta.body;
  }
}

export class ElasticsearchConnectionError extends ElasticsearchError {
  constructor(message: string, meta?: ElasticsearchErrorMeta, cause?: unknown) {
    super(message, meta, cause);
    this.name = "ConnectionError";
  }
}

export class ElasticsearchTimeoutError extends ElasticsearchError {
  constructor(
    message = "Request timed out",
    meta?: ElasticsearchErrorMeta,
    cause?: unknown,
  ) {
    super(message, meta, cause);
    this.name = "TimeoutError";
  }
}

export class ElasticsearchAbortError extends ElasticsearchError {
  constructor(
    message = "Request aborted",
    meta?: ElasticsearchErrorMeta,
    cause?: unknown,
  ) {
    super(message, meta, cause);
    this.name = "AbortError";
  }
}
