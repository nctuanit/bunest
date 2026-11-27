import { MetadataRegistry, type StandardSchemaV1 } from "@bunest/core/common";
import {
  STANDARD_SCHEMA_DTO_KEY,
  STANDARD_SCHEMA_DTO_METADATA_KEY,
} from "./dto-bridge";
import type { InferOutput } from "./types";

export interface SchemaDtoConstructor<
  TSchema extends StandardSchemaV1<any, any>,
> {
  new (data?: Partial<InferOutput<TSchema>>): InferOutput<TSchema>;
  readonly [STANDARD_SCHEMA_DTO_KEY]: TSchema;
  readonly schema: TSchema;
}

/**
 * Turns any Standard Schema v1 (including `@bunest/validation/schema` `s.*`,
 * Zod v4, Valibot, ArkType, etc.) into a DTO class constructor compatible with:
 * - TypeScript `emitDecoratorMetadata` (`@Body() dto: CreateUserDto`)
 * - `ValidationPipe` (automatic runtime validation & transformation)
 * - `@bunest/swagger` `SwaggerModule` (automatic OpenAPI 3.1 schema generation)
 *
 * @example
 * ```ts
 * const CreateUserSchema = s.object({
 *   email: s.string().email(),
 *   age: s.coerce.number().int().min(18),
 * });
 *
 * export class CreateUserDto extends createSchemaDto(CreateUserSchema) {}
 * ```
 */
export function createSchemaDto<TSchema extends StandardSchemaV1<any, any>>(
  schema: TSchema,
  name?: string,
): SchemaDtoConstructor<TSchema> {
  if (
    (typeof schema !== "object" && typeof schema !== "function") ||
    schema === null ||
    typeof (schema as Record<string, unknown>)["~standard"] !== "object" ||
    (schema as Record<string, unknown>)["~standard"] === null ||
    typeof (
      (schema as Record<string, unknown>)["~standard"] as Record<
        string,
        unknown
      >
    ).validate !== "function"
  ) {
    throw new TypeError(
      "createSchemaDto() requires a valid Standard Schema v1 object (`~standard.validate`).",
    );
  }

  class SchemaDto {
    constructor(data?: Record<string, unknown>) {
      if (data && typeof data === "object") {
        for (const key of Object.keys(data)) {
          if (
            key === "__proto__" ||
            key === "constructor" ||
            key === "prototype"
          ) {
            continue;
          }
          (this as Record<string, unknown>)[key] = data[key];
        }
      }
    }
  }

  if (typeof name === "string" && name.length > 0) {
    Object.defineProperty(SchemaDto, "name", {
      value: name,
      configurable: true,
    });
  }

  Object.defineProperty(SchemaDto, STANDARD_SCHEMA_DTO_KEY, {
    value: schema,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  Object.defineProperty(SchemaDto, "schema", {
    value: schema,
    enumerable: false,
    configurable: false,
    writable: false,
  });

  // Also define Reflect metadata so cross-package discovery works via Reflect.getMetadata
  MetadataRegistry.define(STANDARD_SCHEMA_DTO_METADATA_KEY, schema, SchemaDto);

  return SchemaDto as unknown as SchemaDtoConstructor<TSchema>;
}
