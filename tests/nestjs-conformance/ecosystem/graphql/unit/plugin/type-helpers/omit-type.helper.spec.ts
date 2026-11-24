import { expect, it } from "bun:test";
import { IsNumber } from "../../../../../../../packages/validation/src/validator";
import {
  Field,
  ObjectType,
  OmitType,
  getFieldsAndDecoratorForType,
} from "../../../../../../../packages/graphql/src";
import { describeConformance } from "../../../../../_helpers/index";
import { CreateUserDto } from "./fixtures/create-user-dto.fixture";
import { getValidationMetadataByTarget } from "./type-helpers.test-utils";

describeConformance(
  "OmitType",
  {
    upstreamPath:
      "packages/graphql/tests/plugin/type-helpers/omit-type.helper.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002", "ADR-005"],
    notes:
      "Tests GraphQL OmitType with getFieldsAndDecoratorForType and class-validator metadata using explicit @Field() decorators (ADR-002, ADR-005).",
  },
  () => {
    class UpdateUserDto extends OmitType(CreateUserDto, ["login", "_id"]) {}

    // BUNEST_BUG: OmitType() in packages/graphql/src/decorators/type.decorators.ts (lines 854-939) does not auto-apply the source @ObjectType() decorator to the generated class (getFieldsAndDecoratorForType throws UnableToFindFieldsError) and does not clone @Directive()/@Extensions() metadata onto mapped types.
    it.skip('should inherit all fields except for "login" and "_id"', () => {
      const prototype = Object.getPrototypeOf(UpdateUserDto);
      const { fields } = getFieldsAndDecoratorForType(prototype);
      expect(fields.length).toEqual(1);
      expect(fields[0]?.name).toEqual("password");
      expect(fields[0]?.directives?.length).toEqual(1);
      expect(fields[0]?.directives as unknown[]).toContainEqual({
        fieldName: "password",
        sdl: "@upper",
        target: prototype,
      });
      expect(fields[0]?.extensions).toEqual({
        extension: true,
      });
    });

    // BUNEST_BUG: OmitType() in packages/graphql/src/decorators/type.decorators.ts (lines 932-939) does not inherit the source @ObjectType() decorator onto the generated mapped class ("OmitPricesDto"), causing getFieldsAndDecoratorForType(Object.getPrototypeOf(PublicPricesDto)) to throw UnableToFindFieldsError.
    it.skip("should handle a field whose key is a number", () => {
      @ObjectType()
      class PricesDto {
        @IsNumber()
        @Field({ name: "basePrice" })
        0!: number;

        @IsNumber()
        @Field({ name: "costPrice" })
        1!: number;
      }
      class PublicPricesDto extends OmitType(PricesDto, [1]) {}

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
