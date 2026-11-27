import "../transformer/index";
import "../validator/index";

import {
  BaseSchema,
  DefaultSchema,
  NullableSchema,
  OptionalSchema,
  RefinedSchema,
  SchemaValidationError,
  TransformedSchema,
} from "./base";
import {
  ArraySchema,
  DiscriminatedUnionSchema,
  ObjectSchema,
  RecordSchema,
  TupleSchema,
  UnionSchema,
  type DiscriminatedUnionOption,
  type ObjectShape,
  type TupleItems,
  type UnionOptions,
} from "./collections";
import {
  BooleanSchema,
  DateSchema,
  EnumSchema,
  LiteralSchema,
  NumberSchema,
  StringSchema,
  extractEnumValues,
  type EnumLikeObject,
  type LiteralPrimitive,
} from "./primitives";
import type { InferOutput } from "./types";

function enumBuilder<const T extends readonly [string, ...string[]]>(
  values: T,
): EnumSchema<T[number]>;
function enumBuilder<const T extends readonly [number, ...number[]]>(
  values: T,
): EnumSchema<T[number]>;
function enumBuilder<
  const T extends readonly [string | number, ...(string | number)[]],
>(values: T): EnumSchema<T[number]>;
function enumBuilder<TEnum extends EnumLikeObject>(
  enumObj: TEnum,
): EnumSchema<TEnum[keyof TEnum]>;
function enumBuilder(
  valuesOrEnum: readonly (string | number)[] | EnumLikeObject,
): EnumSchema<string | number> {
  return new EnumSchema(extractEnumValues(valuesOrEnum));
}

function recordBuilder<TValue extends BaseSchema<any, any>>(
  valueSchema: TValue,
): RecordSchema<StringSchema, TValue>;
function recordBuilder<
  TKey extends BaseSchema<string, string>,
  TValue extends BaseSchema<any, any>,
>(keySchema: TKey, valueSchema: TValue): RecordSchema<TKey, TValue>;
function recordBuilder(
  first: BaseSchema<any, any>,
  second?: BaseSchema<any, any>,
): RecordSchema<any, any> {
  if (second !== undefined) {
    return new RecordSchema(second, first as BaseSchema<string, string>);
  }
  return new RecordSchema(first);
}

/**
 * Zero-dependency Bunest fluent Schema DSL implementing BOTH
 * `StandardSchemaV1` and `StandardJSONSchemaV1` (`draft-2020-12`, `draft-07`, `openapi-3.0`).
 */
export const s = {
  string(): StringSchema {
    return new StringSchema();
  },

  number(): NumberSchema {
    return new NumberSchema();
  },

  int(): NumberSchema {
    return new NumberSchema().int();
  },

  boolean(): BooleanSchema {
    return new BooleanSchema();
  },

  date(): DateSchema {
    return new DateSchema();
  },

  literal<const T extends LiteralPrimitive>(value: T): LiteralSchema<T> {
    return new LiteralSchema(value);
  },

  enum: enumBuilder,

  array<TItem extends BaseSchema<any, any>>(item: TItem): ArraySchema<TItem> {
    return new ArraySchema(item);
  },

  tuple<
    TItems extends TupleItems,
    TRest extends BaseSchema<any, any> | undefined = undefined,
  >(items: TItems, rest?: TRest): TupleSchema<TItems, TRest> {
    return new TupleSchema(items, rest);
  },

  record: recordBuilder,

  object<TShape extends ObjectShape>(shape: TShape): ObjectSchema<TShape> {
    return new ObjectSchema(shape);
  },

  union<TOptions extends UnionOptions>(options: TOptions): UnionSchema<TOptions> {
    return new UnionSchema(options);
  },

  discriminatedUnion<
    TDiscriminator extends string,
    TOptions extends readonly [
      DiscriminatedUnionOption<TDiscriminator>,
      ...DiscriminatedUnionOption<TDiscriminator>[],
    ],
  >(
    discriminator: TDiscriminator,
    options: TOptions,
  ): DiscriminatedUnionSchema<TDiscriminator, TOptions> {
    return new DiscriminatedUnionSchema(discriminator, options);
  },

  optional<TSchema extends BaseSchema<any, any>>(
    schema: TSchema,
  ): OptionalSchema<TSchema> {
    return new OptionalSchema(schema);
  },

  nullable<TSchema extends BaseSchema<any, any>>(
    schema: TSchema,
  ): NullableSchema<TSchema> {
    return new NullableSchema(schema);
  },

  default<TSchema extends BaseSchema<any, any>>(
    schema: TSchema,
    defaultValue: InferOutput<TSchema> | (() => InferOutput<TSchema>),
  ): DefaultSchema<TSchema, InferOutput<TSchema>> {
    return new DefaultSchema(schema, defaultValue);
  },

  coerce: {
    string(): StringSchema {
      return new StringSchema([], true);
    },
    number(): NumberSchema {
      return new NumberSchema([], true);
    },
    boolean(): BooleanSchema {
      return new BooleanSchema(true);
    },
    date(): DateSchema {
      return new DateSchema([], true);
    },
  },
} as const;

export {
  BaseSchema,
  DefaultSchema,
  NullableSchema,
  OptionalSchema,
  RefinedSchema,
  SchemaValidationError,
  TransformedSchema,
} from "./base";
export {
  ArraySchema,
  DiscriminatedUnionSchema,
  ObjectSchema,
  RecordSchema,
  TupleSchema,
  UnionSchema,
  type DiscriminatedUnionOption,
  type ObjectShape,
  type ObjectShapeInput,
  type ObjectShapeOutput,
  type TupleItems,
  type UnionOptions,
  type UnknownKeysPolicy,
} from "./collections";
export {
  BooleanSchema,
  DateSchema,
  EnumSchema,
  LiteralSchema,
  NumberSchema,
  StringSchema,
  type EnumLikeObject,
  type LiteralPrimitive,
} from "./primitives";
export {
  createSchemaDto,
  type SchemaDtoConstructor,
} from "./dto";
export {
  SCHEMA_DTO_RAW_INPUT_KEY,
  STANDARD_SCHEMA_DTO_KEY,
  STANDARD_SCHEMA_DTO_METADATA_KEY,
  getStandardSchemaFromDto,
  isStandardSchemaDto,
  standardSchemaIssuesToValidationErrors,
} from "./dto-bridge";
export type {
  BunestSchema,
  BunestStandardProps,
  InferInput,
  InferOutput,
  JsonSchemaContext,
  RefineOptions,
  SafeParseFailure,
  SafeParseResult,
  SafeParseSuccess,
  SchemaMeta,
  StandardJSONSchemaV1,
  StandardJsonSchemaConverter,
  StandardJsonSchemaOptions,
  StandardJsonSchemaTarget,
  StandardSchemaV1,
  StandardSchemaV1Issue,
  StandardSchemaV1Options,
  StandardSchemaV1PathSegment,
  StandardSchemaV1Props,
  StandardSchemaV1Result,
} from "./types";
