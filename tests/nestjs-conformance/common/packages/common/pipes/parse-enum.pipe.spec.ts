import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
  BadRequestException,
  HttpException,
  ParseEnumPipe,
  type ArgumentMetadata,
} from "../../../../../../packages/core/src/common";
import { describeConformance } from "../../../../_helpers";

class CustomTestError extends HttpException {
  constructor() {
    super("This is a TestException", 418);
  }
}

describeConformance(
  "ParseEnumPipe",
  {
    upstreamPath: "packages/common/test/pipes/parse-enum.pipe.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    enum Direction {
      Up = "UP",
    }
    let target: ParseEnumPipe<typeof Direction>;

    beforeEach(() => {
      target = new ParseEnumPipe(Direction, {
        exceptionFactory: (_error: unknown) => new CustomTestError(),
      });
    });

    describe("transform", () => {
      describe("when validation passes", () => {
        it("should return enum value", async () => {
          expect(await target.transform("UP", {} as ArgumentMetadata)).toBe(
            Direction.Up,
          );
        });

        it("should not throw an error if enumType is undefined/null and optional is true", async () => {
          const optionalTarget = new ParseEnumPipe(
            "DOWN" as unknown as Record<string, string | number>,
            { optional: true },
          );
          const value = await optionalTarget.transform(
            undefined!,
            {} as ArgumentMetadata,
          );
          expect(value).toBe(undefined);
        });
      });

      describe("when validation fails", () => {
        it("should throw an error", async () => {
          return expect(
            target.transform("DOWN", {} as ArgumentMetadata),
          ).rejects.toThrow(CustomTestError);
        });

        it("should throw an error if enumType is wrong and optional is true", async () => {
          target = new ParseEnumPipe(Direction, {
            exceptionFactory: (_error: unknown) => new CustomTestError(),
            optional: true,
          });
          return expect(
            target.transform("DOWN", {} as ArgumentMetadata),
          ).rejects.toThrow(CustomTestError);
        });
      });
    });

    describe("constructor", () => {
      it('should throw an error if "enumType" is undefined/null', () => {
        let caught: unknown;
        try {
          new ParseEnumPipe(null as unknown as Record<string, string | number>);
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(Error);
        expect((caught as Error).message).toBe(
          `"ParseEnumPipe" requires "enumType" argument specified (to validate input values).`,
        );
      });
    });

    describe("when enum is numeric", () => {
      enum Status {
        Active = 0,
        Inactive = 1,
      }
      let numericTarget: ParseEnumPipe<typeof Status>;

      beforeEach(() => {
        numericTarget = new ParseEnumPipe(Status);
      });

      it("should return numeric enum value when the numeric value is passed", async () => {
        expect(
          await numericTarget.transform(
            Status.Active as unknown,
            {} as ArgumentMetadata,
          ),
        ).toBe(Status.Active);
        expect(
          await numericTarget.transform(
            Status.Inactive as unknown,
            {} as ArgumentMetadata,
          ),
        ).toBe(Status.Inactive);
      });

      it("should return numeric enum value when the numeric value is passed as a string", async () => {
        expect(
          await numericTarget.transform("0" as unknown, {} as ArgumentMetadata),
        ).toBe(Status.Active);
        expect(
          await numericTarget.transform("1" as unknown, {} as ArgumentMetadata),
        ).toBe(Status.Inactive);
      });

      it("should throw when an invalid numeric string is passed", async () => {
        await expect(
          numericTarget.transform("2" as unknown, {} as ArgumentMetadata),
        ).rejects.toThrow(BadRequestException);
      });

      it("should throw when an empty or whitespace string is passed", async () => {
        await expect(
          numericTarget.transform("" as unknown, {} as ArgumentMetadata),
        ).rejects.toThrow(BadRequestException);
        await expect(
          numericTarget.transform("   " as unknown, {} as ArgumentMetadata),
        ).rejects.toThrow(BadRequestException);
      });

      it("should throw when a looser numeric representation is passed", async () => {
        const invalidValues = [
          "01",
          "00",
          "1.0",
          "0.0",
          "-0",
          "+1",
          " 1",
          "1e0",
        ];
        for (const val of invalidValues) {
          await expect(
            numericTarget.transform(val as unknown, {} as ArgumentMetadata),
          ).rejects.toThrow(BadRequestException);
        }
      });

      it("should throw when a reverse-mapped key name is passed instead of the value", async () => {
        let threw = false;
        try {
          await numericTarget.transform(
            "Active" as unknown,
            {} as ArgumentMetadata,
          );
        } catch (err) {
          threw = true;
          expect(err).toBeInstanceOf(BadRequestException);
          expect((err as Error).message).toBe(
            "Validation failed (enum string is expected)",
          );
        }
        expect(threw).toBe(true);
      });
    });

    describe("memoization", () => {
      enum Status {
        Active = 0,
        Inactive = 1,
      }

      it("should compute the enum values only once across transforms", async () => {
        const memoTarget = new ParseEnumPipe(Status);
        const computeSpy = spyOn(memoTarget as any, "computeEnumValues");

        await memoTarget.transform("0" as unknown, {} as ArgumentMetadata);
        await memoTarget.transform("1" as unknown, {} as ArgumentMetadata);
        await memoTarget.transform(Status.Active, {} as ArgumentMetadata);

        expect(computeSpy).toHaveBeenCalledTimes(1);
      });
    });

    describe("when enum is numeric with negative values", () => {
      enum Temperature {
        Freezing = -5,
        Zero = 0,
        Boiling = 100,
      }
      let tempTarget: ParseEnumPipe<typeof Temperature>;

      beforeEach(() => {
        tempTarget = new ParseEnumPipe(Temperature);
      });

      it("should parse negative numeric string and return number", async () => {
        expect(
          await tempTarget.transform("-5" as unknown, {} as ArgumentMetadata),
        ).toBe(Temperature.Freezing);
        expect(
          await tempTarget.transform("0" as unknown, {} as ArgumentMetadata),
        ).toBe(Temperature.Zero);
        expect(
          await tempTarget.transform("100" as unknown, {} as ArgumentMetadata),
        ).toBe(Temperature.Boiling);
      });
    });

    describe("when enum has float values", () => {
      enum Ratio {
        Half = 0.5,
        OneAndHalf = 1.5,
      }
      let floatTarget: ParseEnumPipe<typeof Ratio>;

      beforeEach(() => {
        floatTarget = new ParseEnumPipe(Ratio);
      });

      it("should parse float numeric string and return number", async () => {
        expect(
          await floatTarget.transform("0.5" as unknown, {} as ArgumentMetadata),
        ).toBe(Ratio.Half);
        expect(
          await floatTarget.transform("1.5" as unknown, {} as ArgumentMetadata),
        ).toBe(Ratio.OneAndHalf);
      });

      it("should throw for looser float representations", async () => {
        await expect(
          floatTarget.transform("0.50" as unknown, {} as ArgumentMetadata),
        ).rejects.toThrow(BadRequestException);
      });
    });

    describe("when enum has mixed string and numeric values", () => {
      enum Mixed {
        A = "a",
        One = 1,
        Alias = "One",
        Two = 2,
      }
      let mixedTarget: ParseEnumPipe<typeof Mixed>;

      beforeEach(() => {
        mixedTarget = new ParseEnumPipe(Mixed);
      });

      it("should parse both string member and numeric member passed as string or number", async () => {
        expect(await mixedTarget.transform("a", {} as ArgumentMetadata)).toBe(
          Mixed.A,
        );
        expect(await mixedTarget.transform("1", {} as ArgumentMetadata)).toBe(
          Mixed.One,
        );
        expect(await mixedTarget.transform(1, {} as ArgumentMetadata)).toBe(
          Mixed.One,
        );
      });

      it("should accept a string value that is also a numeric member name", async () => {
        expect(await mixedTarget.transform("One", {} as ArgumentMetadata)).toBe(
          Mixed.Alias,
        );
      });

      it("should still reject a reverse-mapped name that is not a declared value", async () => {
        await expect(
          mixedTarget.transform("Two" as unknown, {} as ArgumentMetadata),
        ).rejects.toThrow(BadRequestException);
      });

      it("should throw when invalid value is passed", async () => {
        await expect(
          mixedTarget.transform("b" as unknown, {} as ArgumentMetadata),
        ).rejects.toThrow(BadRequestException);
        await expect(
          mixedTarget.transform("01" as unknown, {} as ArgumentMetadata),
        ).rejects.toThrow(BadRequestException);
      });
    });

    describe("when enum has string values with digit characters", () => {
      enum DigitString {
        Zero = "0",
        One = "1",
      }
      let digitTarget: ParseEnumPipe<typeof DigitString>;

      beforeEach(() => {
        digitTarget = new ParseEnumPipe(DigitString);
      });

      it("should preserve string type and not coerce to number", async () => {
        const result = await digitTarget.transform("0", {} as ArgumentMetadata);
        expect(result).toBe(DigitString.Zero);
        expect<unknown>(result).toBe("0");
        expect(typeof result).toBe("string");
      });
    });
  },
);
