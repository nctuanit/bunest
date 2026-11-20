export interface ValidationErrorDetail {
  field: string;
  constraints: Record<string, string>;
  messages: string[];
}

export interface ValidationErrorResponse {
  statusCode: number;
  error: string;
  message: string;
  details: ValidationErrorDetail[];
  timestamp?: string;
  path?: string;
}

export interface HttpExceptionResponse {
  statusCode: number;
  message: string | string[];
  error: string;
  errorCode?: string;
  details?: ValidationErrorDetail[] | unknown;
  timestamp?: string;
  path?: string;
  [key: string]: unknown;
}

export type HttpExceptionBodyMessage = string | string[];

export interface HttpExceptionBody {
  message: HttpExceptionBodyMessage;
  error?: string;
  statusCode: number;
  errorCode?: string;
}

export interface DescriptionAndOptions {
  description?: string;
  httpExceptionOptions?: HttpExceptionOptions;
}

export interface HttpExceptionOptions {
  cause?: unknown;
  description?: string;
  headers?: Record<string, string>;
  /**
   * Optional machine-readable application error code (NestJS v12 parity),
   * included in the JSON error envelope when specified.
   */
  errorCode?: string;
}

/**
 * Base exception for expected/intrinsic framework errors that default
 * exception filters treat as non-unexpected (suppressing noisy 500 stack logs),
 * matching NestJS v11+ `IntrinsicException`.
 */
export class IntrinsicException extends Error {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Base HTTP exception with a consistent JSON response payload shape.
 */
export class HttpException extends Error {
  private readonly response: string | Record<string, unknown>;
  private readonly status: number;
  public readonly options?: HttpExceptionOptions;
  public errorCode?: string;

  constructor(
    response: string | Record<string, unknown>,
    status: number,
    options?: HttpExceptionOptions,
  ) {
    const message = HttpException.extractMessage(response, new.target.name);
    super(
      message,
      options?.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.response = response;
    this.status = status;
    this.options = options;
    this.initMessage();
    this.initName();
    this.initCause();
    this.initErrorCode();
    Object.setPrototypeOf(this, new.target.prototype);
  }

  public initCause(): void {
    if (this.options?.cause !== undefined) {
      this.cause = this.options.cause;
    }
  }

  public initMessage(): void {
    if (typeof this.response === "string") {
      this.message = this.response;
    } else if (
      typeof this.response === "object" &&
      this.response !== null &&
      typeof this.response.message === "string"
    ) {
      this.message = this.response.message;
    } else if (
      typeof this.response === "object" &&
      this.response !== null &&
      Array.isArray(this.response.message) &&
      this.response.message.length > 0
    ) {
      this.message = this.response.message.join("; ");
    } else if (this.constructor) {
      this.message =
        this.constructor.name.match(/[A-Z][a-z]+|[0-9]+/g)?.join(" ") ??
        this.constructor.name;
    }
  }

  public initName(): void {
    this.name = this.constructor.name;
  }

  public initErrorCode(): void {
    if (this.options?.errorCode !== undefined) {
      this.errorCode = this.options.errorCode;
    } else if (
      typeof this.response === "object" &&
      this.response !== null &&
      typeof this.response.errorCode === "string"
    ) {
      this.errorCode = this.response.errorCode;
    }
  }

  getResponse(): string | Record<string, unknown> {
    return this.response;
  }

  getStatus(): number {
    return this.status;
  }

  getHeaders(): Record<string, string> | undefined {
    return this.options?.headers ? { ...this.options.headers } : undefined;
  }

  toJSON(): HttpExceptionResponse {
    const errorCode = this.errorCode ?? this.options?.errorCode;
    if (typeof this.response === "string") {
      return {
        statusCode: this.status,
        message: this.response,
        error: this.options?.description ?? this.name,
        ...(errorCode !== undefined ? { errorCode } : {}),
      };
    }

    const base = this.response;
    const message =
      typeof base.message === "string" || Array.isArray(base.message)
        ? (base.message as string | string[])
        : this.message;
    const error =
      typeof base.error === "string"
        ? base.error
        : (this.options?.description ?? this.name);

    return {
      ...base,
      statusCode:
        typeof base.statusCode === "number" ? base.statusCode : this.status,
      message,
      error,
      ...(errorCode !== undefined && base.errorCode === undefined
        ? { errorCode }
        : {}),
    };
  }

  static createBody(
    objectOrError: string | string[] | Record<string, unknown> | undefined,
    description: string,
    statusCode: number,
  ): HttpExceptionResponse {
    if (objectOrError === undefined || objectOrError === null) {
      return {
        statusCode,
        message: description,
        error: description,
      };
    }

    if (typeof objectOrError === "string" || Array.isArray(objectOrError)) {
      return {
        statusCode,
        message: objectOrError,
        error: description,
      };
    }

    return {
      statusCode,
      error: description,
      message: description,
      ...objectOrError,
    };
  }

  static getDescriptionFrom(
    descriptionOrOptions: string | HttpExceptionOptions,
  ): string {
    return typeof descriptionOrOptions === "string"
      ? descriptionOrOptions
      : (descriptionOrOptions?.description ?? "");
  }

  static getHttpExceptionOptionsFrom(
    descriptionOrOptions: string | HttpExceptionOptions,
  ): HttpExceptionOptions {
    return typeof descriptionOrOptions === "string"
      ? {}
      : (descriptionOrOptions ?? {});
  }

  static extractDescriptionAndOptionsFrom(
    descriptionOrOptions?: string | HttpExceptionOptions,
  ): DescriptionAndOptions {
    const description =
      typeof descriptionOrOptions === "string"
        ? descriptionOrOptions
        : descriptionOrOptions?.description;
    const httpExceptionOptions =
      typeof descriptionOrOptions === "string"
        ? {}
        : descriptionOrOptions;
    return {
      description,
      httpExceptionOptions,
    };
  }

  static extractDescriptionAndOptions(
    descriptionOrOptions?: string | HttpExceptionOptions,
    defaultDescription = "Http Exception",
  ): { description: string; options?: HttpExceptionOptions } {
    if (typeof descriptionOrOptions === "string") {
      return {
        description: descriptionOrOptions,
        options: { description: descriptionOrOptions },
      };
    }

    return {
      description: descriptionOrOptions?.description ?? defaultDescription,
      options: descriptionOrOptions,
    };
  }

  private static extractMessage(
    response: string | Record<string, unknown>,
    fallback: string,
  ): string {
    if (typeof response === "string") {
      return response;
    }
    if (typeof response.message === "string") {
      return response.message;
    }
    if (Array.isArray(response.message) && response.message.length > 0) {
      return response.message.join("; ");
    }
    if (typeof response.error === "string") {
      return response.error;
    }
    return fallback;
  }
}
