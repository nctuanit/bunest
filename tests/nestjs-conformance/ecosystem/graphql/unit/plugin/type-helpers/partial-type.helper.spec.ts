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
import { describeConformance, itAdapted } from "../../../../../_helpers/index";
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
    it('should inherit all fields and set "nullable" to true', async () => {
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
      itAdapted(
        ["ADR-002", "ADR-005"],
        "should inherit metadata",
        () => {
          const validationKeys = new Set(
            getValidationMetadataByTarget(UpdateUserDto).map(
              (item) => item.propertyName,
            ),
          );
          expect(Array.from(validationKeys)).toEqual(["firstName", "password"]);
        },
        "ADR-002/005: PartialType inherits validation metadata for validated properties without SWC plugin synthesis",
      );

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
      it("should skip default values of inherited class", async () => {
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
      it("should apply @IsOptional to properties reflected by the plugin if option `skipNullProperties` is true", async () => {
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

      it("should apply @IsOptional to properties reflected by the plugin if option `skipNullProperties` is undefined", async () => {
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

      it("should apply @ValidateIf to properties reflected by the plugin if option `skipNullProperties` is false", async () => {
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

      it("should keep nullable items and make the list itself nullable", () => {
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
