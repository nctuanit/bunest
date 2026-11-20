/**
 * Zero-dependency TypeScript types and runtime guard implementing
 * Standard Schema v1 (`@standard-schema/spec` v1) — interoperable with
 * Zod v3.24+/v4, Valibot, ArkType, Typia, and custom schema validators.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": StandardSchemaV1Props<Input, Output>;
}

export interface StandardSchemaV1Props<Input = unknown, Output = Input> {
  readonly version: 1;
  readonly vendor: string;
  readonly validate: (
    value: unknown,
    options?: StandardSchemaV1Options,
  ) =>
    | StandardSchemaV1Result<Output>
    | Promise<StandardSchemaV1Result<Output>>;
  readonly types?: StandardSchemaV1Types<Input, Output> | undefined;
}

export interface StandardSchemaV1Options {
  readonly libraryOptions?: Record<string, unknown> | undefined;
}

export type StandardSchemaV1Result<Output> =
  | StandardSchemaV1SuccessResult<Output>
  | StandardSchemaV1FailureResult;

export interface StandardSchemaV1SuccessResult<Output> {
  readonly value: Output;
  readonly issues?: undefined;
}

export interface StandardSchemaV1FailureResult {
  readonly issues: ReadonlyArray<StandardSchemaV1Issue>;
}

export interface StandardSchemaV1Issue {
  readonly message: string;
  readonly path?:
    | ReadonlyArray<PropertyKey | StandardSchemaV1PathSegment>
    | undefined;
}

export interface StandardSchemaV1PathSegment {
  readonly key: PropertyKey;
}

export interface StandardSchemaV1Types<Input = unknown, Output = Input> {
  readonly input: Input;
  readonly output: Output;
}

export type StandardSchemaV1InferInput<Schema extends StandardSchemaV1> =
  NonNullable<Schema["~standard"]["types"]>["input"];

export type StandardSchemaV1InferOutput<Schema extends StandardSchemaV1> =
  NonNullable<Schema["~standard"]["types"]>["output"];

/**
 * Runtime type guard verifying whether a value conforms to Standard Schema v1.
 */
export function isStandardSchema<Input = unknown, Output = Input>(
  value: unknown,
): value is StandardSchemaV1<Input, Output> {
  if (
    (typeof value !== "object" && typeof value !== "function") ||
    value === null
  ) {
    return false;
  }
  const standard = (value as Record<string, unknown>)["~standard"];
  if (typeof standard !== "object" || standard === null) {
    return false;
  }
  const props = standard as Record<string, unknown>;
  return (
    props.version === 1 &&
    typeof props.vendor === "string" &&
    typeof props.validate === "function"
  );
}
