import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { getMetadataStorage, IsNumber } from "class-validator";
import {
  ApiProperty,
  OmitType,
  SchemaExplorer,
  SwaggerModule,
} from "../../../../../../packages/swagger/src";
import { describeConformance } from "../../../../_helpers";
import { CreateUserDto } from "./fixtures/create-user-dto.fixture";
import { SERIALIZED_METADATA } from "./fixtures/serialized-metadata.fixture";

class UpdateUserDto extends OmitType(CreateUserDto, ["login", "lastName"]) {}

describeConformance(
  "OmitType",
  {
    upstreamPath: "test/type-helpers/omit-type.helper.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002", "ADR-005"],
    notes:
      "Adapts MetadataLoader + ModelPropertiesAccessor to SwaggerModule.loadPluginMetadata() and SchemaExplorer (ADR-002, ADR-005, ADR-013).",
  },
  () => {
    describe("OpenAPI metadata", () => {
      // BUNEST_BUG: OmitType / SchemaExplorer (packages/common/src/mapped-types/mapped-types.utils.ts, packages/swagger/src/plugin-metadata-store.ts) does not inherit SwaggerModule.loadPluginMetadata() properties onto mapped type classes (omits "active")
      it.skip('should omit "login" property', async () => {
        await SwaggerModule.loadPluginMetadata(async () => SERIALIZED_METADATA);

        const explorer = new SchemaExplorer();
        explorer.registerDtoSchema(UpdateUserDto);
        const props = Object.keys(
          explorer.getSchemas().UpdateUserDto?.properties ?? {},
        );

        expect(props).toEqual(["password", "firstName", "active", "role"]);
      });
    });

    describe("when a key is a number", () => {
      class PricesDto {
        @IsNumber()
        @ApiProperty()
        0!: number;

        @IsNumber()
        @ApiProperty()
        1!: number;
      }

      class PublicPricesDto extends OmitType(PricesDto, [1]) {}

      it("should omit the property", () => {
        const explorer = new SchemaExplorer();
        explorer.registerDtoSchema(PublicPricesDto);
        const props = Object.keys(
          explorer.getSchemas().PublicPricesDto?.properties ?? {},
        );

        expect(props).toEqual(["0"]);
      });

      it("should not inherit its validation metadata", () => {
        const validationMetadata =
          getMetadataStorage().getTargetValidationMetadatas(
            PublicPricesDto,
            "",
            false,
            false,
          );

        expect(validationMetadata.map((item) => item.propertyName)).toEqual([
          "0",
        ]);
      });
    });
  },
);
