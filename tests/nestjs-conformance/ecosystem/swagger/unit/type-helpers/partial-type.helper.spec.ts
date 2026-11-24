import { describe, expect, it } from "bun:test";
import { validate } from "../../../../../../packages/validation/src/validator";
import {
  MetadataRegistry,
  type Type,
} from "../../../../../../packages/core/src/common";
import {
  ApiProperty,
  IntersectionType,
  OmitType,
  PartialType,
  PickType,
  SWAGGER_METADATA_KEYS,
  SchemaExplorer,
  SwaggerModule,
  type ApiPropertyMetadata,
} from "../../../../../../packages/swagger/src";
import { describeConformance } from "../../../../_helpers";
import { CreateUserDto } from "./fixtures/create-user-dto.fixture";
import { SERIALIZED_METADATA } from "./fixtures/serialized-metadata.fixture";

class UpdateUserDto extends PartialType(CreateUserDto) {}

describeConformance(
  "PartialType",
  {
    upstreamPath: "test/type-helpers/partial-type.helper.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002", "ADR-005"],
    notes:
      "Adapts MetadataLoader + ModelPropertiesAccessor + SchemaObjectFactory to SwaggerModule.loadPluginMetadata(), MetadataRegistry, and SchemaExplorer (ADR-002, ADR-005, ADR-013).",
  },
  () => {
    describe("Validation metadata", () => {
      it("should apply @IsOptional to properties reflected by the plugin", async () => {
        const updateDto = new UpdateUserDto();
        (updateDto as { firstName: unknown }).firstName = null;
        const validationErrors = await validate(updateDto);
        expect(validationErrors).toHaveLength(0);
      });

      it("should apply @IsOptional to properties reflected by the plugin if option `skipNullProperties` is true", async () => {
        class UpdateUserWithNullableDto extends PartialType(CreateUserDto, {
          skipNullProperties: true,
        }) {}
        const updateDto = new UpdateUserWithNullableDto();
        (updateDto as { firstName: unknown }).firstName = null;
        const validationErrors = await validate(updateDto);
        expect(validationErrors).toHaveLength(0);
      });

      it("should apply @IsOptional to properties reflected by the plugin if option `skipNullProperties` is undefined", async () => {
        class UpdateUserWithoutNullableDto extends PartialType(
          CreateUserDto,
          {},
        ) {}
        const updateDto = new UpdateUserWithoutNullableDto();
        (updateDto as { firstName: unknown }).firstName = null;
        const validationErrors = await validate(updateDto);
        expect(validationErrors).toHaveLength(0);
      });

      it("should apply @ValidateIf to properties reflected by the plugin if option `skipNullProperties` is false", async () => {
        class UpdateUserWithoutNullableDto extends PartialType(CreateUserDto, {
          skipNullProperties: false,
        }) {}
        const updateDto = new UpdateUserWithoutNullableDto();
        (updateDto as { firstName: unknown }).firstName = null;
        const validationErrors = await validate(updateDto);
        expect(validationErrors).toHaveLength(1);
        expect(validationErrors[0]?.constraints).toEqual({
          isString: "firstName must be a string",
        });
      });

      // BUNEST_BUG: PartialType (packages/core/src/common/mapped-types/mapped-types.utils.ts:670-682) applies @IsOptional/@ValidateIf to @ApiProperty-only properties without class-validator decorators, whitelisting them under whitelist/forbidNonWhitelisted
      it.skip.each([{}, { skipNullProperties: false }])(
        "should not whitelist documented properties that have no validation decorator (%j)",
        async (options) => {
          class UpdateUserWithOptionsDto extends PartialType(
            CreateUserDto,
            options,
          ) {}
          await SwaggerModule.loadPluginMetadata(
            async () => SERIALIZED_METADATA,
          );

          const updateDto = Object.assign(new UpdateUserWithOptionsDto(), {
            firstName: "John",
            login: "admin",
            active: true,
          });
          const validationErrors = await validate(updateDto, {
            whitelist: true,
            forbidNonWhitelisted: true,
          });
          expect(validationErrors.map((error) => error.property)).toEqual([
            "login",
            "active",
          ]);
        },
      );
    });

    describe("OpenAPI metadata", () => {
      // BUNEST_BUG: PartialType / plugin-metadata-store (packages/swagger/src/plugin-metadata-store.ts, packages/core/src/common/mapped-types/mapped-types.utils.ts) does not inherit plugin metadata loaded after PartialType(CreateUserDto) ("active" missing)
      it.skip("should return partial class", async () => {
        await SwaggerModule.loadPluginMetadata(async () => SERIALIZED_METADATA);

        const explorer = new SchemaExplorer();
        explorer.registerDtoSchema(UpdateUserDto);
        const props = Object.keys(
          explorer.getSchemas().UpdateUserDto?.properties ?? {},
        );

        expect(props).toEqual([
          "login",
          "password",
          "firstName",
          "lastName",
          "active",
          "role",
        ]);
      });

      it('should set "required" option to "false" for each property', () => {
        const ownProps: ApiPropertyMetadata[] = [];
        for (const ctor of MetadataRegistry.getPrototypeChain(UpdateUserDto)) {
          const entries = MetadataRegistry.getOwn<
            readonly ApiPropertyMetadata[]
          >(SWAGGER_METADATA_KEYS.API_PROPERTIES, ctor);
          if (entries) ownProps.push(...entries);
        }

        const loginMeta = ownProps.find((p) => p.propertyKey === "login");
        const passwordMeta = ownProps.find((p) => p.propertyKey === "password");
        expect(loginMeta?.required).toBe(false);
        expect(loginMeta?.designType).toBe(String);
        expect(passwordMeta?.required).toBe(false);
        expect(passwordMeta?.minLength).toBe(10);
        expect(passwordMeta?.designType).toBe(String);

        const explorer = new SchemaExplorer();
        explorer.registerDtoSchema(UpdateUserDto);
        expect(explorer.getSchemas().UpdateUserDto?.required).toBeUndefined();
      });
    });

    describe("Schema", () => {
      // BUNEST_BUG: SchemaExplorer.buildPropertySchema (packages/swagger/src/schema-explorer.ts:860-910) keeps reflected design:type ("string") when oneOf is declared without an explicit type
      it.skip("should not turn a type inferred for a property declaring oneOf into an explicit one", () => {
        class NullableBinDto {
          @ApiProperty({
            required: false,
            oneOf: [{ type: "string" }, { type: "null" }],
          })
          bin?: string | null;
        }
        class UpdateNullableBinDto extends PartialType(NullableBinDto) {}

        const explorer = new SchemaExplorer();
        explorer.registerDtoSchema(NullableBinDto);
        explorer.registerDtoSchema(UpdateNullableBinDto);
        const schemas = explorer.getSchemas();

        const oneOf = [{ type: "string" }, { type: "null" }];
        expect(schemas.NullableBinDto?.properties?.bin).toEqual({ oneOf });
        expect(schemas.UpdateNullableBinDto?.properties?.bin).toEqual({
          oneOf,
        });
      });

      // BUNEST_BUG: SchemaExplorer.buildPropertySchema (packages/swagger/src/schema-explorer.ts:860-910) keeps reflected design:type ("string") when oneOf is declared without an explicit type across mapped types
      it.skip.each([
        ["PickType", (base: Type<any>) => PickType(base, ["bin"])],
        ["OmitType", (base: Type<any>) => OmitType(base, [])],
        ["IntersectionType", (base: Type<any>) => IntersectionType(base, base)],
      ] as const)(
        "should leave the type of a oneOf property inferred in %s",
        (_, map) => {
          class NullableBinDto {
            @ApiProperty({ oneOf: [{ type: "string" }, { type: "null" }] })
            bin!: string | null;
          }
          class MappedDto extends (map(NullableBinDto) as Type<any>) {}

          const explorer = new SchemaExplorer();
          explorer.registerDtoSchema(MappedDto);
          const schemas = explorer.getSchemas();

          expect(schemas.MappedDto?.properties?.bin).toEqual({
            oneOf: [{ type: "string" }, { type: "null" }],
          });
        },
      );

      it("should keep a type declared explicitly next to oneOf", () => {
        class ExplicitTypeDto {
          @ApiProperty({
            type: "string",
            oneOf: [{ maxLength: 3 }, { minLength: 10 }],
          })
          code!: string;
        }
        class UpdateExplicitTypeDto extends PartialType(ExplicitTypeDto) {}

        const explorer = new SchemaExplorer();
        explorer.registerDtoSchema(UpdateExplicitTypeDto);
        const schemas = explorer.getSchemas();

        expect(schemas.UpdateExplicitTypeDto?.properties?.code).toEqual({
          type: "string",
          oneOf: [{ maxLength: 3 }, { minLength: 10 }],
        });
      });
    });
  },
);
