import type {
  StandardSchemaV1,
  StandardSchemaV1Issue,
  StandardSchemaV1Options,
  StandardSchemaV1PathSegment,
  StandardSchemaV1Props,
  StandardSchemaV1Result,
} from "@bunest/core/common";

export type {
  StandardSchemaV1,
  StandardSchemaV1Issue,
  StandardSchemaV1Options,
  StandardSchemaV1PathSegment,
  StandardSchemaV1Props,
  StandardSchemaV1Result,
};

export type StandardJsonSchemaTarget =
  | "draft-2020-12"
  | "draft-07"
  | "openapi-3.0"
  | ({} & string);

export interface StandardJsonSchemaOptions {
  readonly target: StandardJsonSchemaTarget;
  readonly libraryOptions?: Record<string, unknown> | undefined;
}

export interface StandardJsonSchemaConverter {
  readonly input: (
    options: StandardJsonSchemaOptions,
  ) => Record<string, unknown>;
  readonly output: (
    options: StandardJsonSchemaOptions,
  ) => Record<string, unknown>;
}

export interface StandardJSONSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly jsonSchema: StandardJsonSchemaConverter;
    readonly types?:
      | {
          readonly input: Input;
          readonly output: Output;
        }
      | undefined;
  };
}

export interface BunestStandardProps<Input = unknown, Output = Input>
  extends StandardSchemaV1Props<Input, Output> {
  readonly version: 1;
  readonly vendor: "bunest";
  readonly jsonSchema: StandardJsonSchemaConverter;
}

/**
 * Combined Standard Schema v1 + Standard JSON Schema v1 contract implemented
 * by every `@bunest/validation/schema` builder.
 */
export interface BunestSchema<Input = unknown, Output = Input>
  extends StandardSchemaV1<Input, Output>, StandardJSONSchemaV1<Input, Output> {
  readonly "~standard": BunestStandardProps<Input, Output>;
}

/**
 * Extracts the raw input type accepted by any `StandardSchemaV1` schema.
 */
export type InferInput<T extends StandardSchemaV1> = NonNullable<
  T["~standard"]["types"]
>["input"];

/**
 * Extracts the validated/transformed output type produced by any `StandardSchemaV1` schema.
 */
export type InferOutput<T extends StandardSchemaV1> = NonNullable<
  T["~standard"]["types"]
>["output"];

export interface SchemaMeta {
  readonly id?: string;
  readonly title?: string;
  readonly description?: string;
  readonly format?: string;
  readonly example?: unknown;
  readonly examples?: readonly unknown[];
  readonly deprecated?: boolean;
  readonly readOnly?: boolean;
  readonly writeOnly?: boolean;
  readonly [key: string]: unknown;
}

export interface JsonSchemaContext {
  readonly target: "draft-2020-12" | "draft-07" | "openapi-3.0";
  readonly io: "input" | "output";
}

export type SafeParseSuccess<Output> = {
  readonly success: true;
  readonly data: Output;
};

export type SafeParseFailure = {
  readonly success: false;
  readonly issues: ReadonlyArray<StandardSchemaV1Issue>;
};

export type SafeParseResult<Output> =
  | SafeParseSuccess<Output>
  | SafeParseFailure;

export type RefineOptions =
  | string
  | {
      readonly message?: string;
      readonly path?: ReadonlyArray<PropertyKey>;
    };

export type Prettify<T> = { [K in keyof T]: T[K] } & {};
