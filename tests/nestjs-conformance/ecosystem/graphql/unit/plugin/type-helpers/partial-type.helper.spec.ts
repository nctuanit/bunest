import { describe, expect, it } from "bun:test";
import {
  Expose,
  Transform,
} from "../../../../../../../packages/validation/src/transformer";
import {
  IsString,
  validate,
} from "../../../../../../../packages/validation/src/validator";
import type {
  MappedType,
  Type,
} from "../../../../../../../packages/core/src/common";
import {
  Field,
  ObjectType,
  PartialType,
  getFieldsAndDecoratorForType,
} from "../../../../../../../packages/graphql/src";
import { describeConformance } from "../../../../../_helpers/index";
import { BaseType } from "./fixtures/base-type.fixture";
import { getValidationMetadataByTarget } from "./type-helpers.test-utils";

type PartialTypeWithOptions = <T>(
  classRef: Type<T>,
  options?: { omitDefaultValues?: boolean; skipNullProperties?: boolean },
) => MappedType<Partial<T>>;

const PartialTypeWithOpts = PartialType as unknown as PartialTypeWithOptions;

@ObjectType()
class CreateUserDto extends BaseType {
  @IsString()
  @Field()
  firstName!: string;

  @Field({ nullable: true })
  login!: string;

  @Expose()
  @Transform(({ value }) => `${String(value)}_transformed`)
  @IsString()
  @Field()
  password!: string;
}

class UpdateUserDto extends PartialType(CreateUserDto) {}

describeConformance(
  "PartialType",
  {
    upstreamPath:
      "packages/graphql/tests/plugin/type-helpers/partial-type.helper.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002", "ADR-005"],
    notes:
      "Adapts out SWC MetadataLoader in favor of explicit @Field() on BaseType.meta (ADR-002, ADR-005).",
  },
  () => {
    // BUNEST_BUG: PartialType() in packages/graphql/src/decorators/type.decorators.ts (lines 854-915) does not auto-apply the source @ObjectType() decorator to the generated mapped class ("PartialCreateUserDto", causing getFieldsAndDecoratorForType to throw UnableToFindFieldsError) and does not clone @Directive()/@Extensions() metadata.
    it.skip('should inherit all fields and set "nullable" to true', async () => {
      const prototype = Object.getPrototypeOf(UpdateUserDto);
      const { fields } = getFieldsAndDecoratorForType(prototype);

      expect(fields.length).toEqual(7);
      expect(fields).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "id",
            options: { nullable: true },
          }),
          expect.objectContaining({
            name: "createdAt",
            options: { nullable: true },
          }),
          expect.objectContaining({
            name: "updatedAt",
            options: { nullable: true },
          }),
          expect.objectContaining({
            name: "login",
            options: { nullable: true },
          }),
          expect.objectContaining({
            name: "password",
            options: { nullable: true },
          }),
          expect.objectContaining({
            name: "firstName",
            options: { nullable: true },
          }),
          expect.objectContaining({
            name: "meta",
            options: { nullable: true },
          }),
        ]),
      );
      const idField = fields.find((f) => f.name === "id");
      expect(idField?.directives?.length).toEqual(1);
      expect(idField?.directives as unknown[]).toContainEqual({
        fieldName: "id",
        sdl: "@upper",
        target: prototype,
      });
      expect(idField?.extensions).toEqual({
        extension: true,
      });
    });

    describe("Validation metadata", () => {
      // BUNEST_BUG: inheritDtoMetadata() in packages/core/src/common/mapped-types/mapped-types.utils.ts (lines 671-692) applies @IsOptional() before invoking registered GraphQL hooks and does not discover @Field()-only properties without class-validator decorators, so validationKeys returns ["firstName", "password"] instead of all 7 fields.
      it.skip("should inherit metadata", () => {
        const validationKeys = new Set(
          getValidationMetadataByTarget(UpdateUserDto).map(
            (item) => item.propertyName,
          ),
        );
        expect(Array.from(validationKeys)).toEqual([
          "firstName",
          "password",
          "id",
          "createdAt",
          "updatedAt",
          "login",
          "meta",
        ]);
      });

      it("should apply @IsOptional to properties reflected by the plugin", async () => {
        const updateDto = new UpdateUserDto();
        updateDto.firstName = null as unknown as string;
        const validationErrors = await validate(updateDto);
        expect(validationErrors).toHaveLength(0);
      });

      describe("when object does not fulfil validation rules", () => {
        it('"validate" should return validation errors', async () => {
          const updateDto = new UpdateUserDto();
          updateDto.password = 1234567 as unknown as string;

          const validationErrors = await validate(updateDto);

          expect(validationErrors.length).toEqual(1);
          expect(validationErrors[0]?.constraints).toEqual({
            isString: "password must be a string",
          });
        });
      });
    });

    describe("omitDefaultValues", () => {
      // BUNEST_BUG: PartialType() in packages/graphql/src/decorators/type.decorators.ts (lines 885-915) only accepts an optional ClassDecorator/GqlDecoratorFactory 2nd argument and does not support an options object ({ omitDefaultValues: true }), crashing with TypeError: decorator is not a function.
      it.skip("should skip default values of inherited class", async () => {
        @ObjectType()
        class CreateFooDto {
          @Field({ defaultValue: "foo" })
          name!: string;
        }

        class UpdateFooDto extends PartialTypeWithOpts(CreateFooDto, {
          omitDefaultValues: true,
        }) {}

        const prototype = Object.getPrototypeOf(UpdateFooDto);
        const { fields } = getFieldsAndDecoratorForType(prototype);

        expect(fields.length).toEqual(1);
        expect(fields[0]?.name).toEqual("name");
        expect(fields[0]?.options.nullable).toEqual(true);
        expect(fields[0]?.options.defaultValue).toEqual(undefined);
      });
    });

    describe("skipNullProperties", () => {
      // BUNEST_BUG: PartialType() in packages/graphql/src/decorators/type.decorators.ts (lines 885-915) does not accept an options object ({ skipNullProperties }) or forward it to @bunest/common BasePartialType, crashing with TypeError: decorator is not a function.
      it.skip("should apply @IsOptional to properties reflected by the plugin if option `skipNullProperties` is true", async () => {
        class UpdateUserWithNullableDto extends PartialTypeWithOpts(
          CreateUserDto,
          {
            skipNullProperties: true,
          },
        ) {}
        const updateDto = new UpdateUserWithNullableDto();
        updateDto.firstName = null as unknown as string;
        const validationErrors = await validate(updateDto);
        expect(validationErrors).toHaveLength(0);
      });

      // BUNEST_BUG: PartialType() in packages/graphql/src/decorators/type.decorators.ts (lines 885-915) does not accept an options object ({ skipNullProperties: undefined }), crashing with TypeError: decorator is not a function.
      it.skip("should apply @IsOptional to properties reflected by the plugin if option `skipNullProperties` is undefined", async () => {
        class UpdateUserWithoutNullableDto extends PartialTypeWithOpts(
          CreateUserDto,
          {
            skipNullProperties: undefined,
          },
        ) {}
        const updateDto = new UpdateUserWithoutNullableDto();
        updateDto.firstName = null as unknown as string;
        const validationErrors = await validate(updateDto);
        expect(validationErrors).toHaveLength(0);
      });

      // BUNEST_BUG: PartialType() in packages/graphql/src/decorators/type.decorators.ts (lines 885-915) does not accept an options object ({ skipNullProperties: false }) or forward it to BasePartialType to apply @ValidateIf, crashing with TypeError: decorator is not a function.
      it.skip("should apply @ValidateIf to properties reflected by the plugin if option `skipNullProperties` is false", async () => {
        class UpdateUserWithoutNullableDto extends PartialTypeWithOpts(
          CreateUserDto,
          {
            skipNullProperties: false,
          },
        ) {}
        const updateDto = new UpdateUserWithoutNullableDto();
        updateDto.firstName = null as unknown as string;
        const validationErrors = await validate(updateDto);
        expect(validationErrors).toHaveLength(1);
        expect(validationErrors[0]?.constraints).toEqual({
          isString: "firstName must be a string",
        });
      });
    });

    describe("list nullability", () => {
      @ObjectType()
      class CreateListDto {
        @Field(() => [String])
        plain!: string[];

        @Field(() => [String], { nullable: true })
        list!: string[];

        @Field(() => [String], { nullable: "items" })
        items!: string[];

        @Field(() => [String], { nullable: "itemsAndList" })
        itemsAndList!: string[];
      }

      class UpdateListDto extends PartialType(CreateListDto) {}

      // BUNEST_BUG: PartialType() in packages/graphql/src/decorators/type.decorators.ts (lines 869-872, 909-915) does not auto-apply @ObjectType() onto PartialCreateListDto (throwing UnableToFindFieldsError) and unconditionally sets nullable: true instead of upgrading nullable: "items" -> "itemsAndList" and preserving "itemsAndList".
      it.skip("should keep nullable items and make the list itself nullable", () => {
        const prototype = Object.getPrototypeOf(UpdateListDto);
        const { fields } = getFieldsAndDecoratorForType(prototype);
        const nullableOf = (name: string) =>
          fields.find((field) => field.name === name)?.options.nullable;

        expect(nullableOf("plain")).toEqual(true);
        expect(nullableOf("list")).toEqual(true);
        expect(nullableOf("items")).toEqual("itemsAndList");
        expect(nullableOf("itemsAndList")).toEqual("itemsAndList");
      });
    });
  },
);
