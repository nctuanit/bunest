import { describe, expect, it } from "bun:test";
import {
  IsBoolean,
  IsNumber,
  validate,
} from "../../../../../../../packages/validation/src/validator";
import {
  ArgsType,
  Field,
  ObjectType,
  PickType,
  getFieldsAndDecoratorForType,
} from "../../../../../../../packages/graphql/src";
import { describeConformance } from "../../../../../_helpers/index";
import { CreateUserDto } from "./fixtures/create-user-dto.fixture";
import { getValidationMetadataByTarget } from "./type-helpers.test-utils";

@ObjectType()
class CreateUserWithActiveFieldDto extends CreateUserDto {
  // Adapted per ADR-002: explicit @Field() replaces SWC MetadataLoader serialized metadata
  @IsBoolean()
  @Field()
  declare active: boolean;
}

class UpdateUserDto extends PickType(CreateUserDto, ["login"]) {}

class UpdateUserWithIdDto extends PickType(CreateUserDto, ["_id"]) {}

class IsActiveUserDto extends PickType(CreateUserWithActiveFieldDto, [
  "active",
]) {}

describeConformance(
  "PickType",
  {
    upstreamPath:
      "packages/graphql/tests/plugin/type-helpers/pick-type.helper.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002", "ADR-005"],
    notes:
      "Adapts out SWC MetadataLoader in favor of explicit @Field() on active (ADR-002, ADR-005).",
  },
  () => {
    it('should inherit "login" field', () => {
      const prototype = Object.getPrototypeOf(UpdateUserDto);
      const { fields } = getFieldsAndDecoratorForType(prototype);

      expect(fields.length).toEqual(1);
      expect(fields[0]?.name).toEqual("login");
      expect(fields[0]?.directives?.length).toEqual(1);
      expect(fields[0]?.directives as unknown[]).toContainEqual({
        fieldName: "login",
        sdl: "@upper",
        target: prototype,
      });
    });

    it('should inherit "active" field', async () => {
      const prototype = Object.getPrototypeOf(IsActiveUserDto);
      const { fields } = getFieldsAndDecoratorForType(prototype);

      expect(fields.length).toEqual(1);
      expect(fields[0]?.name).toEqual("active");
    });

    it('should inherit renamed "_id" field', () => {
      const { fields } = getFieldsAndDecoratorForType(
        Object.getPrototypeOf(UpdateUserWithIdDto),
      );
      expect(fields.length).toEqual(1);
      expect(fields[0]?.name).toEqual("_id");
      expect(fields[0]?.extensions).toEqual({ extension: true });
    });

    describe("Validation metadata", () => {
      it('should inherit metadata with "password" property excluded', () => {
        const validationKeys = getValidationMetadataByTarget(UpdateUserDto).map(
          (item) => item.propertyName,
        );
        expect(validationKeys).toEqual(["login"]);
      });

      describe("when object does not fulfil validation rules", () => {
        it('"validate" should return validation errors', async () => {
          const updateDto = new UpdateUserDto();
          updateDto.login = "1234567";

          let validationErrors = await validate(updateDto);
          expect(validationErrors.length).toEqual(1);
          expect(validationErrors[0]?.constraints).toEqual({
            minLength: "login must be longer than or equal to 10 characters",
          });

          const isActiveDto = new IsActiveUserDto();
          isActiveDto.active = "1234567" as unknown as boolean;

          validationErrors = await validate(isActiveDto);
          expect(validationErrors.length).toEqual(1);
          expect(validationErrors[0]?.constraints).toEqual({
            isBoolean: "active must be a boolean value",
          });
        });
      });

      describe("otherwise", () => {
        it('"validate" should return an empty array', async () => {
          const updateDto = new UpdateUserDto();
          updateDto.login = "1234567891011";
          // @ts-expect-error password is not picked
          updateDto.password;

          const validationErrors = await validate(updateDto);
          expect(validationErrors.length).toEqual(0);
        });
      });
    });

    @ArgsType()
    class ArgsType1 {
      @Field() a!: string;
      @Field() b!: string;
      @Field() c!: string;
      @Field() d!: string;
      @Field() e!: string;
      @Field() f!: string;
      @Field() g!: string;
      @Field() h!: string;
    }

    @ObjectType()
    class PickArgsTest1 extends PickType(ArgsType1, ["a", "c", "f", "h"]) {}

    it("should inherit: a, c, f, h fields", () => {
      const { fields } = getFieldsAndDecoratorForType(
        Object.getPrototypeOf(PickArgsTest1),
      );
      expect(fields.length).toEqual(4);
      expect(fields[0]?.name).toEqual("a");
      expect(fields[1]?.name).toEqual("c");
      expect(fields[2]?.name).toEqual("f");
      expect(fields[3]?.name).toEqual("h");
    });

    it("should handle a field whose key is a number", () => {
      @ObjectType()
      class PricesDto {
        @IsNumber()
        @Field({ name: "basePrice" })
        0!: number;

        @IsNumber()
        @Field({ name: "costPrice" })
        1!: number;
      }
      class PublicPricesDto extends PickType(PricesDto, [0]) {}

      const { fields } = getFieldsAndDecoratorForType(
        Object.getPrototypeOf(PublicPricesDto),
      );
      expect(fields.map((field) => field.name)).toEqual(["0"]);
      expect(
        getValidationMetadataByTarget(PublicPricesDto).map(
          (item) => item.propertyName,
        ),
      ).toEqual(["0"]);
    });
  },
);
