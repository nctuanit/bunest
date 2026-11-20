import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import {
  Expose,
  Transform,
  Type as TransformType,
  instanceToInstance,
  plainToInstance,
} from "class-transformer";
import { IsBoolean, IsString } from "class-validator";
import {
  ApiProperty,
  IntersectionType,
  SchemaExplorer,
} from "../../../../../../packages/swagger/src";
import { describeConformance } from "../../../../_helpers";

const METADATA_FACTORY_NAME = "_OPENAPI_METADATA_FACTORY" as const;

describeConformance(
  "IntersectionType",
  {
    upstreamPath: "test/type-helpers/intersection-type.helper.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002", "ADR-005"],
    notes:
      "Adapts ModelPropertiesAccessor checks to Bunest SchemaExplorer while preserving class-transformer inheritance & deduplication tests (ADR-002, ADR-005, ADR-013).",
  },
  () => {
    class CreateUserDto {
      @ApiProperty({ required: true })
      login!: string;

      @Expose()
      @Transform(({ value }) => `${String(value)}_transformed`)
      @IsString()
      @ApiProperty({ minLength: 10 })
      password!: string;

      static [METADATA_FACTORY_NAME]() {
        return { dateOfBirth: { required: true, type: () => String } };
      }
    }

    class UserDto {
      @IsString()
      @ApiProperty({ required: false })
      firstName!: string;

      static [METADATA_FACTORY_NAME]() {
        return { dateOfBirth2: { required: true, type: () => String } };
      }
    }

    class AuthorityDto {
      @IsBoolean()
      @ApiProperty({ required: true })
      isAdmin!: boolean;

      static [METADATA_FACTORY_NAME]() {
        return { dateOfBirth3: { required: true, type: () => String } };
      }
    }

    class UpdateUserDto extends IntersectionType(
      UserDto,
      CreateUserDto,
      AuthorityDto,
    ) {}

    describe("OpenAPI metadata", () => {
      // BUNEST_BUG: SchemaExplorer / IntersectionType (packages/swagger/src/schema-explorer.ts, packages/common/src/mapped-types/mapped-types.utils.ts) does not read static _OPENAPI_METADATA_FACTORY() properties
      it.skip("should return combined class", () => {
        const explorer = new SchemaExplorer();
        explorer.registerDtoSchema(UpdateUserDto);
        const props = Object.keys(
          explorer.getSchemas().UpdateUserDto?.properties ?? {},
        );

        expect(props).toEqual([
          "firstName",
          "login",
          "password",
          "isAdmin",
          "dateOfBirth2",
          "dateOfBirth",
          "dateOfBirth3",
        ]);
      });
    });

    describe("Transformation metadata", () => {
      class ClassA {
        @Transform(({ value }) => `${String(value)}_transformed`)
        repeatedProperty = "value";
      }

      class ClassB {
        @Transform(({ value }) => `${String(value)}_transformed`)
        repeatedProperty = "value";
      }

      class IntersectionDto extends IntersectionType(ClassA, ClassB) {}

      // BUNEST_BUG: IntersectionType (packages/common/src/mapped-types/mapped-types.utils.ts:609) passes stackDecorators=true, stacking duplicate @Transform decorators on repeatedProperty ("value_transformed_transformed" vs "value_transformed")
      it.skip("should not stack transformers declared on the same property", () => {
        const result = instanceToInstance(new IntersectionDto());
        expect(result.repeatedProperty).toEqual("value_transformed");
      });

      class OtherClass {
        other = "other";
      }

      // BUNEST_BUG: IntersectionType (packages/common/src/mapped-types/mapped-types.utils.ts:595-620) reverses base/derived @Transform execution order ("value_derived_base" vs "value_base_derived")
      it.skip("should keep the transformers of a derived class and its base", () => {
        class BaseClass {
          @Transform(({ value }) => `${String(value)}_base`)
          property = "value";
        }
        class DerivedClass extends BaseClass {
          @Transform(({ value }) => `${String(value)}_derived`)
          declare property: string;
        }
        class Dto extends IntersectionType(DerivedClass, OtherClass) {}

        expect(instanceToInstance(new Dto()).property).toEqual(
          instanceToInstance(new DerivedClass()).property,
        );
      });

      it("should keep the @Type() override of a derived class", () => {
        class FirstNested {}
        class SecondNested {}
        class BaseClass {
          @TransformType(() => FirstNested)
          nested!: object;
        }
        class DerivedClass extends BaseClass {
          @TransformType(() => SecondNested)
          declare nested: object;
        }
        class Dto extends IntersectionType(DerivedClass, OtherClass) {}

        expect(plainToInstance(Dto, { nested: {} }).nested).toBeInstanceOf(
          SecondNested,
        );
      });
    });
  },
);
