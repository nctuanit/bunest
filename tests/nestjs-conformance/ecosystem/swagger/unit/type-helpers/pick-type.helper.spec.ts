import { describe, expect, it } from "bun:test";
import { Transform } from "../../../../../../packages/validation/src/transformer";
import { MinLength } from "../../../../../../packages/validation/src/validator";
import {
  ApiProperty,
  PickType,
  SchemaExplorer,
} from "../../../../../../packages/swagger/src";
import { describeConformance } from "../../../../_helpers";

const METADATA_FACTORY_NAME = "_OPENAPI_METADATA_FACTORY" as const;

describeConformance(
  "PickType",
  {
    upstreamPath: "test/type-helpers/pick-type.helper.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002", "ADR-005"],
    notes:
      "Adapts ModelPropertiesAccessor checks to Bunest SchemaExplorer (ADR-002, ADR-005, ADR-013).",
  },
  () => {
    class CreateUserDto {
      @Transform(({ value }) => `${String(value)}_transformed`)
      @MinLength(10)
      @ApiProperty({ required: true })
      login!: string;

      @MinLength(10)
      @ApiProperty({ minLength: 10 })
      password!: string;

      firstName!: string;

      static [METADATA_FACTORY_NAME]() {
        return {
          firstName: { required: true, type: () => String },
          lastName: { required: true, type: () => String },
        };
      }
    }

    class UpdateUserDto extends PickType(CreateUserDto, [
      "login",
      "firstName",
    ]) {}

    describe("OpenAPI metadata", () => {
      it('should pick "login" property', () => {
        const explorer = new SchemaExplorer();
        explorer.registerDtoSchema(UpdateUserDto);
        const props = Object.keys(
          explorer.getSchemas().UpdateUserDto?.properties ?? {},
        );

        expect(props).toEqual(["login", "firstName"]);
      });

      it("should pick a property whose key is a number", () => {
        class PricesDto {
          @ApiProperty()
          0!: number;

          @ApiProperty()
          1!: number;
        }

        class PublicPricesDto extends PickType(PricesDto, [0]) {}

        const explorer = new SchemaExplorer();
        explorer.registerDtoSchema(PublicPricesDto);
        const props = Object.keys(
          explorer.getSchemas().PublicPricesDto?.properties ?? {},
        );

        expect(props).toEqual(["0"]);
      });
    });
  },
);
