export interface SchemaValidationIssue {
  /**
   * Field path segments (e.g. `["address", "zipCode"]`, `["items", 0, "sku"]`)
   * or a pre-formatted dot/bracket path string.
   */
  readonly path?: ReadonlyArray<string | number> | string;
  /**
   * Human-readable description of the validation failure.
   */
  readonly message: string;
  /**
   * Optional machine-readable constraint/error code (e.g. `"invalid_type"`).
   */
  readonly code?: string;
}

export interface SchemaValidationErrorLike {
  readonly issues?: readonly SchemaValidationIssue[];
  readonly errors?: readonly SchemaValidationIssue[];
  readonly message?: string;
}

export interface SchemaSafeParseSuccess<T> {
  readonly success: true;
  readonly data: T;
}

export interface SchemaSafeParseFailure {
  readonly success: false;
  readonly error: SchemaValidationErrorLike | unknown;
}

export type SchemaSafeParseResult<T> =
  SchemaSafeParseSuccess<T> | SchemaSafeParseFailure;

/**
 * Extensible schema validation contract for integrating Zod, Valibot,
 * TypeBox, or custom schema validators with `SchemaValidationPipe`.
 *
 * Implementations may provide `safeParse`, `parse`, `safeParseAsync`,
 * `parseAsync`, or any subset thereof.
 */
export interface SchemaValidator<T = unknown> {
  parse?(input: unknown): T | Promise<T>;
  safeParse?(
    input: unknown,
  ): SchemaSafeParseResult<T> | Promise<SchemaSafeParseResult<T>>;
  parseAsync?(input: unknown): Promise<T>;
  safeParseAsync?(input: unknown): Promise<SchemaSafeParseResult<T>>;
}
