export class MongooseError extends Error {
  readonly code?: number | string;
  readonly errors?: Record<string, Error>;

  constructor(
    message: string,
    options?: {
      code?: number | string;
      errors?: Record<string, Error>;
      cause?: unknown;
    },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "MongooseError";
    if (options?.code !== undefined) {
      this.code = options.code;
    }
    if (options?.errors !== undefined) {
      this.errors = options.errors;
    }
  }
}
