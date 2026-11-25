import { describe, expect, it } from "bun:test";
import {
  Expose,
  Transform,
  instanceToInstance,
  plainToInstance,
} from "../../../../packages/validation/src/transformer";
import {
  IsNumber,
  MinLength,
  getMetadataStorage,
  validate,
} from "../../../../packages/validation/src/validator";
import { PickType } from "../../../../packages/validation/src";
import { describeConformance } from "../../_helpers/index";

function getValidationMetadataByTarget(target: Function) {
  return getMetadataStorage().getTargetValidationMetadatas(
    target,
    null as unknown as string,
    false,
    false,
  );
}

describeConformance(
  "PickType",
  {
    upstreamPath: "mapped-types/tests/pick-type.helper.spec.ts",
    category: "DIRECT_PORT",
    adrs: ["ADR-002", "ADR-005"],
  },
  () => {
    class CreateUserDto {
      @Transform(({ value }) => value + "_transformed")
      @MinLength(10)
      login = "defaultLogin";

      @MinLength(10)
      password!: string;
    }

    class UpdateUserDto extends PickType(CreateUserDto, ["login"]) {}

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

          const validationErrors = await validate(updateDto);

          expect(validationErrors.length).toEqual(1);
          expect(validationErrors[0]!.constraints).toEqual({
            minLength: "login must be longer than or equal to 10 characters",
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

    describe("Transformer metadata", () => {
      it("should inherit transformer metadata", () => {
        const login = "1234567891011";
        const updateDto = new UpdateUserDto();
        updateDto.login = login;

        const transformedDto = instanceToInstance(updateDto);
        expect(transformedDto.login).toEqual(login + "_transformed");
      });

      it("should inherit grandparent transformer metadata", () => {
        const transformExecuteSequenceList: string[] = [];
        class Grandparent {
          @Expose()
          @Transform(function grandparentTransform() {
            transformExecuteSequenceList.push(Grandparent.name);
            return 0;
          })
          value!: number;
        }
        class Parent extends Grandparent {
          @Transform(function parentTransform() {
            transformExecuteSequenceList.push(Parent.name);
            return 1;
          })
          declare value: number;
        }
        class Children extends PickType(Parent, ["value"]) {
          @Transform(function childrenTransform(params) {
            transformExecuteSequenceList.push(Children.name);
            return params.value;
          })
          declare value: number;
        }

        const childrenInstance = plainToInstance(Children, {});
        expect(transformExecuteSequenceList[0]).toEqual(Grandparent.name);
        expect(transformExecuteSequenceList[1]).toEqual(Parent.name);
        expect(transformExecuteSequenceList[2]).toEqual(Children.name);
        expect(childrenInstance.value).toEqual(1);
      });
    });

    describe("Property initializers", () => {
      it("should inherit property initializers", () => {
        const updateUserDto = new UpdateUserDto();
        expect((updateUserDto as any)["password"]).toBeUndefined();
        expect(updateUserDto.login).toEqual("defaultLogin");
      });
    });

    describe("when a key is a number", () => {
      class PricesDto {
        @IsNumber()
        0!: number;

        @IsNumber()
        1!: number;
      }

      class PublicPricesDto extends PickType(PricesDto, [0]) {}

      it("should inherit the validation metadata of the picked property", () => {
        const validationKeys = getValidationMetadataByTarget(
          PublicPricesDto,
        ).map((item) => item.propertyName);
        expect(validationKeys).toEqual(["0"]);
      });
    });
  },
);
