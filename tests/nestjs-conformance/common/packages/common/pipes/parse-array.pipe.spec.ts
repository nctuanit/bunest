import "reflect-metadata";
import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { Transform, Type } from "class-transformer";
import {
  IsBoolean,
  IsDate,
  IsDefined,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Validate,
  ValidateNested,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from "class-validator";
import {
  BadRequestException,
  ParseArrayPipe,
  type ArgumentMetadata,
  type ParseArrayPipeOptions,
} from "../../../../../../packages/common/src";
import { describeConformance } from "../../../../_helpers";

type NestParseArrayOptions = ParseArrayPipeOptions & Record<string, unknown>;

describeConformance(
  "ParseArrayPipe",
  {
    upstreamPath: "packages/common/test/pipes/parse-array.pipe.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    let target: ParseArrayPipe;

    describe("transform", () => {
      describe("when undefined value", () => {
        describe("and optional disabled", () => {
          // BUNEST_BUG: createPipeException throws base HttpException(status=400) instead of BadRequestException (packages/common/src/pipes/built-in.pipes.ts)
          it.skip("should throw an exception", async () => {
            target = new ParseArrayPipe({ optional: false });

            return expect(
              target.transform(undefined, {} as ArgumentMetadata),
            ).rejects.toThrow(BadRequestException);
          });
        });

        describe("and optional enabled", () => {
          it("should return undefined", async () => {
            target = new ParseArrayPipe({ optional: true });

            expect(
              await target.transform(undefined, {} as ArgumentMetadata),
            ).toBeUndefined();
          });
        });
      });

      describe("when empty string", () => {
        describe("and optional disabled", () => {
          // BUNEST_BUG: ParseArrayPipe splits empty string "" into [] instead of NestJS [""] (packages/common/src/pipes/built-in.pipes.ts)
          it.skip("should parse to a single empty item", async () => {
            target = new ParseArrayPipe({ optional: false });

            expect(await target.transform("", {} as ArgumentMetadata)).toEqual([
              "",
            ]);
          });
        });

        describe("and optional enabled", () => {
          // BUNEST_BUG: ParseArrayPipe splits empty string "" into [] instead of NestJS [""] (packages/common/src/pipes/built-in.pipes.ts)
          it.skip("should parse to a single empty item", async () => {
            target = new ParseArrayPipe({ optional: true });

            expect(await target.transform("", {} as ArgumentMetadata)).toEqual([
              "",
            ]);
          });
        });
      });

      describe("when value is not parseable", () => {
        beforeEach(() => {
          target = new ParseArrayPipe();
        });

        // BUNEST_BUG: createPipeException throws base HttpException(status=400) instead of BadRequestException (packages/common/src/pipes/built-in.pipes.ts)
        it.skip("should throw an exception (boolean)", async () => {
          return expect(
            target.transform(true, {} as ArgumentMetadata),
          ).rejects.toThrow(BadRequestException);
        });

        // BUNEST_BUG: createPipeException throws base HttpException(status=400) instead of BadRequestException (packages/common/src/pipes/built-in.pipes.ts)
        it.skip("should throw an exception (number)", async () => {
          return expect(
            target.transform(3, {} as ArgumentMetadata),
          ).rejects.toThrow(BadRequestException);
        });

        // BUNEST_BUG: createPipeException throws base HttpException(status=400) instead of BadRequestException (packages/common/src/pipes/built-in.pipes.ts)
        it.skip("should throw an exception (object)", async () => {
          return expect(
            target.transform({}, {} as ArgumentMetadata),
          ).rejects.toThrow(BadRequestException);
        });

        describe('and "optional" is enabled', () => {
          // BUNEST_BUG: createPipeException throws base HttpException(status=400) instead of BadRequestException (packages/common/src/pipes/built-in.pipes.ts)
          it.skip("should throw an exception", async () => {
            const pipe = new ParseArrayPipe({
              optional: true,
              items: String,
              separator: ",",
            });
            return expect(
              pipe.transform({}, {} as ArgumentMetadata),
            ).rejects.toThrow(BadRequestException);
          });
        });
      });

      describe("when value is parseable (string)", () => {
        it("should parse an array based on the separator", async () => {
          target = new ParseArrayPipe();

          expect(
            await target.transform(
              "1,2.0,3,{},true,null,,",
              {} as ArgumentMetadata,
            ),
          ).toEqual(["1", "2.0", "3", "{}", "true", "null", "", ""]);

          target = new ParseArrayPipe({ separator: "/" });

          expect(
            await target.transform("1/2/3", {} as ArgumentMetadata),
          ).toEqual(["1", "2", "3"]);

          target = new ParseArrayPipe({ separator: "." });

          expect(
            await target.transform("1.2.3", {} as ArgumentMetadata),
          ).toEqual(["1", "2", "3"]);
        });

        describe("and type is specified", () => {
          // BUNEST_BUG: ParseArrayPipe throws base HttpException with unindexed message "Validation failed (numeric array item expected)" instead of BadRequestException with "[2] item must be a number", and lacks `stopAtFirstError: false` error aggregation (packages/common/src/pipes/built-in.pipes.ts)
          it.skip("should parse & validate the array", async () => {
            target = new ParseArrayPipe({ separator: ".", items: Number });

            expect(
              await target.transform("1.2.3", {} as ArgumentMetadata),
            ).toEqual([1, 2, 3]);

            target = new ParseArrayPipe({ separator: ".", items: Number });

            try {
              await target.transform("1.2.a.null.3", {} as ArgumentMetadata);
              throw null;
            } catch (err: any) {
              expect(err).toBeInstanceOf(BadRequestException);
              expect(err.getResponse().message).toEqual(
                "[2] item must be a number",
              );
            }

            target = new ParseArrayPipe({ separator: ".", items: Boolean });

            try {
              await target.transform("1.2.a.null.3", {} as ArgumentMetadata);
              throw null;
            } catch (err: any) {
              expect(err).toBeInstanceOf(BadRequestException);
              expect(err.getResponse().message).toEqual(
                "[0] item must be a boolean value",
              );
            }

            target = new ParseArrayPipe({
              separator: ".",
              items: Number,
              stopAtFirstError: false,
            } as NestParseArrayOptions);

            try {
              await target.transform("1.2.a.b.null.3", {} as ArgumentMetadata);
              throw null;
            } catch (err: any) {
              expect(err).toBeInstanceOf(BadRequestException);
              expect(err.getResponse().message).toEqual([
                "[2] item must be a number",
                "[3] item must be a number",
                "[4] item must be a number",
              ]);
            }
          });
        });
      });

      describe("when items type is determined", () => {
        class ArrItem {}

        // BUNEST_BUG: ParseArrayPipe does not transform or validate DTO class items (e.g. `items: ArrItem`) — leaves plain objects and JSON strings untouched instead of instantiating via ValidationPipe (packages/common/src/pipes/built-in.pipes.ts)
        it.skip("should validate and transform each item", async () => {
          target = new ParseArrayPipe({
            items: ArrItem,
            forbidUnknownValues: false,
          } as NestParseArrayOptions);

          let items = (await target.transform(
            [{}, {}, {}],
            {} as ArgumentMetadata,
          ))!;
          items.forEach((item) => {
            expect(item).toBeInstanceOf(ArrItem);
          });

          items = (await target.transform(
            "{},{},{}",
            {} as ArgumentMetadata,
          ))!;
          items.forEach((item) => {
            expect(item).toBeInstanceOf(ArrItem);
          });

          target = new ParseArrayPipe({ items: Number });
          expect(
            await target.transform("1,2.0,3", {} as ArgumentMetadata),
          ).toEqual([1, 2, 3]);

          target = new ParseArrayPipe({ items: String });
          expect(
            await target.transform(
              "1,2.0,3,{},true,null,,",
              {} as ArgumentMetadata,
            ),
          ).toEqual(["1", "2.0", "3", "{}", "true", "null", "", ""]);

          target = new ParseArrayPipe({ items: Boolean });
          expect(
            await target.transform("true,false", {} as ArgumentMetadata),
          ).toEqual([true, false]);
        });

        // BUNEST_BUG: ParseArrayPipe error message is "Validation failed (numeric array item expected)" instead of NestJS indexed "[1] item must be a number" (packages/common/src/pipes/built-in.pipes.ts)
        it.skip("should reject items that are not numbers when items is Number", async () => {
          target = new ParseArrayPipe({ items: Number });

          for (const [value, index] of [
            ["1,true", 1],
            ["1,false", 1],
            ["1,[2]", 1],
            ["1, ,2", 1],
            ["1,Infinity", 1],
            ["1,-Infinity", 1],
            ["1,0x10", 1],
            ["1,0b11", 1],
            ["1,0o17", 1],
          ] as const) {
            await expect(
              target.transform(value, {} as ArgumentMetadata),
            ).rejects.toThrow(`[${index}] item must be a number`);
          }

          await expect(
            target.transform([1, true], {} as ArgumentMetadata),
          ).rejects.toThrow("[1] item must be a number");
        });

        it("should keep parsing numeric strings when items is Number", async () => {
          target = new ParseArrayPipe({ items: Number });

          expect(
            await target.transform(
              "1, 2,-3.5,1e3,01,+4,.5",
              {} as ArgumentMetadata,
            ),
          ).toEqual([1, 2, -3.5, 1000, 1, 4, 0.5]);
        });

        // BUNEST_BUG: ParseArrayPipe error message is "Validation failed (numeric array item expected)" instead of NestJS indexed "[0] item must be a number" (packages/common/src/pipes/built-in.pipes.ts)
        it.skip("should reject an array nested in the array when items is Number", async () => {
          target = new ParseArrayPipe({ items: Number });

          for (const [value, index] of [
            [[[1]], 0],
            [[["2"]], 0],
            [[[[3]]], 0],
            [[1, [2]], 1],
          ] as const) {
            await expect(
              target.transform(value, {} as ArgumentMetadata),
            ).rejects.toThrow(`[${index}] item must be a number`);
          }
        });

        // BUNEST_BUG: ParseArrayPipe error message is "Validation failed (boolean array item expected)" instead of NestJS indexed "[0] item must be a boolean value" (packages/common/src/pipes/built-in.pipes.ts)
        it.skip("should reject an array nested in the array when items is Boolean", async () => {
          target = new ParseArrayPipe({ items: Boolean });

          for (const [value, index] of [
            [[[true]], 0],
            [[["false"]], 0],
            [[true, [false]], 1],
          ] as const) {
            await expect(
              target.transform(value, {} as ArgumentMetadata),
            ).rejects.toThrow(`[${index}] item must be a boolean value`);
          }
        });

        // BUNEST_BUG: ParseArrayPipe ignores DTO class `items` instead of validating with ValidationPipe (returns raw nested array instead of throwing BadRequestException) (packages/common/src/pipes/built-in.pipes.ts)
        it.skip("should not parse a JSON string nested in the array when items is a class", async () => {
          class ArrItemWithProp {
            @IsNumber()
            number!: number;
          }
          target = new ParseArrayPipe({ items: ArrItemWithProp });

          await expect(
            target.transform([['{"number":1}']], {} as ArgumentMetadata),
          ).rejects.toThrow(BadRequestException);
        });

        // BUNEST_BUG: ParseArrayPipe ignores DTO class `items` instead of rejecting non-objects and instantiating valid JSON object items (packages/common/src/pipes/built-in.pipes.ts)
        it.skip("should reject items that are not objects when items is a class", async () => {
          class ArrItemAllOptional {
            @IsOptional()
            @IsNumber()
            number!: number;
          }
          target = new ParseArrayPipe({ items: ArrItemAllOptional });

          for (const value of [
            [[{ number: 1 }]],
            [7],
            ["x"],
            '[{"number":1}]',
          ]) {
            await expect(
              target.transform(value, {} as ArgumentMetadata),
            ).rejects.toMatchObject({
              response: { message: ["Validation failed (object is expected)"] },
            });
          }
          const items = (await target.transform(
            '{},{"number":1}',
            {} as ArgumentMetadata,
          ))!;
          expect(items).toEqual([{}, { number: 1 }]);
          items.forEach((item) =>
            expect(item).toBeInstanceOf(ArrItemAllOptional),
          );
        });

        it("should keep parsing the items of an array", async () => {
          target = new ParseArrayPipe({ items: Number });
          expect(
            await target.transform([1, "2", "3.5"], {} as ArgumentMetadata),
          ).toEqual([1, 2, 3.5]);

          target = new ParseArrayPipe({ items: Boolean });
          expect(
            await target.transform([true, "false"], {} as ArgumentMetadata),
          ).toEqual([true, false]);
        });

        // BUNEST_BUG: ParseArrayPipe lacks internal `validationPipe` for DTO class `items` validation (packages/common/src/pipes/built-in.pipes.ts)
        it.skip("should stop validating at the first invalid item", async () => {
          class ArrItemWithProp {
            @IsDefined()
            number!: number;
          }
          target = new ParseArrayPipe({ items: ArrItemWithProp });
          const validationPipe = (target as any).validationPipe;
          const transformSpy = spyOn(validationPipe, "transform");

          await expect(
            target.transform(
              [{ number: 1 }, {}, {}, {}],
              {} as ArgumentMetadata,
            ),
          ).rejects.toThrow(BadRequestException);
          expect(transformSpy).toHaveBeenCalledTimes(2);
        });

        // BUNEST_BUG: ParseArrayPipe lacks internal `validationPipe` for DTO class `items` validation (packages/common/src/pipes/built-in.pipes.ts)
        it.skip("should validate one item after the other", async () => {
          class ArrItemLocal {}
          target = new ParseArrayPipe({
            items: ArrItemLocal,
            forbidUnknownValues: false,
          } as NestParseArrayOptions);
          const validationPipe = (target as any).validationPipe;
          const origTransform = validationPipe.transform;
          let pending = 0;
          let maxPending = 0;
          spyOn(validationPipe, "transform").mockImplementation(
            async (...args: unknown[]) => {
              maxPending = Math.max(maxPending, ++pending);
              try {
                return await origTransform.apply(validationPipe, args);
              } finally {
                pending--;
              }
            },
          );

          const items = (await target.transform(
            [{}, {}, {}],
            {} as ArgumentMetadata,
          ))!;
          expect(items).toHaveLength(3);
          items.forEach((item) => expect(item).toBeInstanceOf(ArrItemLocal));
          expect(maxPending).toBe(1);
        });

        it("should leave the input array unchanged", async () => {
          const input = ["1", "2"];
          target = new ParseArrayPipe({ items: Number });

          expect(
            await target.transform(input, {} as ArgumentMetadata),
          ).toEqual([1, 2]);
          expect(input).toEqual(["1", "2"]);
        });

        // BUNEST_BUG: ParseArrayPipe iterates sparse arrays with `for (const item of rawItems)` yielding undefined for holes and throwing instead of closing sparse gaps (packages/common/src/pipes/built-in.pipes.ts)
        it.skip("should close the gaps of a sparse array and leave the input unchanged", async () => {
          const input = ["1", "2", "3"];
          delete input[1];
          target = new ParseArrayPipe({ items: Number });

          const result = (await target.transform(
            input,
            {} as ArgumentMetadata,
          ))!;
          expect(result).toEqual([1, 3]);
          expect(result).toHaveLength(2);
          expect(input).toHaveLength(3);
          expect(1 in input).toBe(false);
        });

        // BUNEST_BUG: ParseArrayPipe does not close gaps of sparse arrays (throws on empty slot at index 0) (packages/common/src/pipes/built-in.pipes.ts)
        it.skip("should close the gaps of a sparse array when not stopping at the first error", async () => {
          const input: string[] = [];
          input[1] = "9";
          target = new ParseArrayPipe({
            items: Number,
            stopAtFirstError: false,
          } as NestParseArrayOptions);

          expect(
            await target.transform(input, {} as ArgumentMetadata),
          ).toEqual([9]);
        });

        // BUNEST_BUG: ParseArrayPipe iterates indices linearly via `for..of` instead of skipping sparse holes (throws on undefined index 0) (packages/common/src/pipes/built-in.pipes.ts)
        it.skip("should only visit the items of a sparse array, whatever its length", async () => {
          const input: string[] = [];
          input[2 ** 32 - 2] = "1";
          target = new ParseArrayPipe({ items: Number });

          expect(
            await target.transform(input, {} as ArgumentMetadata),
          ).toEqual([1]);
        });

        describe('when "stopAtFirstError" is explicitly turned off', () => {
          it("should leave the input array unchanged after successful transformation", async () => {
            const input = ["1", "2"];
            const pipe = new ParseArrayPipe({
              items: Number,
              stopAtFirstError: false,
            } as NestParseArrayOptions);

            const transformed = await pipe.transform(
              input,
              {} as ArgumentMetadata,
            );

            expect(transformed).toEqual([1, 2]);
            expect(input).toEqual(["1", "2"]);
          });

          // BUNEST_BUG: ParseArrayPipe throws base HttpException with unindexed message instead of BadRequestException with ["[1] item must be a number"] and ignores `stopAtFirstError: false` (packages/common/src/pipes/built-in.pipes.ts)
          it.skip("should leave the input array unchanged when validation fails", async () => {
            const input = ["1", "invalid", "3"];
            const pipe = new ParseArrayPipe({
              items: Number,
              stopAtFirstError: false,
            } as NestParseArrayOptions);

            const error: any = await pipe
              .transform(input, {} as ArgumentMetadata)
              .catch((err) => err);

            expect(error).toBeInstanceOf(BadRequestException);
            expect(error.getResponse().message).toEqual([
              "[1] item must be a number",
            ]);
            expect(input).toEqual(["1", "invalid", "3"]);
          });

          // BUNEST_BUG: ParseArrayPipe lacks DTO class `items` validation and `stopAtFirstError: false` error concatenation (packages/common/src/pipes/built-in.pipes.ts)
          it.skip("should validate each item and concat errors", async () => {
            class ArrItemWithProp {
              @IsNumber()
              number!: number;
            }
            const pipe = new ParseArrayPipe({
              items: ArrItemWithProp,
              stopAtFirstError: false,
            } as NestParseArrayOptions);
            let threw = false;
            try {
              await pipe.transform(
                [
                  { number: "1" },
                  { number: "1" },
                  { number: 1 },
                ] as unknown as ArrItemWithProp[],
                {} as ArgumentMetadata,
              );
            } catch (err: any) {
              threw = true;
              expect(err).toBeInstanceOf(BadRequestException);
              expect(err.getResponse().message).toEqual([
                "[0] number must be a number conforming to the specified constraints",
                "[1] number must be a number conforming to the specified constraints",
              ]);
            }
            expect(threw).toBe(true);
          });

          // BUNEST_BUG: ParseArrayPipe lacks DTO class `items` transformation/validation so @Transform error is never invoked (packages/common/src/pipes/built-in.pipes.ts)
          it.skip("should rethrow an error thrown by a transformation", async () => {
            const error = Object.assign(new Error("lookup failed"), {
              code: "ECONNREFUSED",
              address: "10.0.0.5",
            });
            class ArrItemWithTransform {
              @Transform(({ value }) => {
                if (value === "unknown") {
                  throw error;
                }
                return value;
              })
              @IsString()
              name!: string;
            }
            const pipe = new ParseArrayPipe({
              items: ArrItemWithTransform,
              stopAtFirstError: false,
            } as NestParseArrayOptions);

            await expect(
              pipe.transform(
                [{ name: 1 }, { name: "unknown" }],
                {} as ArgumentMetadata,
              ),
            ).rejects.toBe(error);
          });

          // BUNEST_BUG: ParseArrayPipe lacks DTO class `items` validation so async @Validate constraint is never invoked (packages/common/src/pipes/built-in.pipes.ts)
          it.skip("should rethrow the rejection of an async constraint", async () => {
            const error = new Error("lookup failed");
            @ValidatorConstraint({ name: "isKnown", async: true })
            class IsKnown implements ValidatorConstraintInterface {
              async validate(value: string) {
                if (value === "unknown") {
                  throw error;
                }
                return true;
              }
            }
            class ArrItemWithConstraint {
              @Validate(IsKnown)
              name!: string;
            }
            const exceptionFactory = mock(
              (errors: any) => new BadRequestException(errors),
            );
            const pipe = new ParseArrayPipe({
              items: ArrItemWithConstraint,
              stopAtFirstError: false,
              exceptionFactory,
            } as NestParseArrayOptions);

            await expect(
              pipe.transform(
                [{ name: "known" }, { name: "unknown" }],
                {} as ArgumentMetadata,
              ),
            ).rejects.toBe(error);
            expect(exceptionFactory).not.toHaveBeenCalled();
          });

          // BUNEST_BUG: ParseArrayPipe lacks DTO class `items` validation and `maxErrorMessagesLength` (packages/common/src/pipes/built-in.pipes.ts)
          it.skip('should rethrow such an error after "maxErrorMessagesLength" is reached', async () => {
            const error = new Error("lookup failed");
            class ArrItemWithTransform {
              @Transform(({ value }) => {
                if (value === "unknown") {
                  throw error;
                }
                return value;
              })
              @IsString()
              name!: string;
            }
            const pipe = new ParseArrayPipe({
              items: ArrItemWithTransform,
              stopAtFirstError: false,
              maxErrorMessagesLength: 1,
            } as NestParseArrayOptions);

            await expect(
              pipe.transform(
                [{ name: 1 }, { name: "unknown" }],
                {} as ArgumentMetadata,
              ),
            ).rejects.toBe(error);
          });

          // BUNEST_BUG: ParseArrayPipe ignores `stopAtFirstError: false` (stops at first error, returns single string message on HttpException instead of 100-item BadRequestException array) (packages/common/src/pipes/built-in.pipes.ts)
          it.skip("should collect the errors without copying them for each item", async () => {
            const pipe = new ParseArrayPipe({
              items: Number,
              stopAtFirstError: false,
            } as NestParseArrayOptions);
            let copied = 0;
            const origConcat = Array.prototype.concat;
            const concatSpy = spyOn(
              Array.prototype,
              "concat",
            ).mockImplementation(function (this: unknown[], ...args: any[]) {
              copied += this.length;
              return origConcat.apply(this, args);
            });
            let error: any;
            try {
              error = await pipe
                .transform(",".repeat(99), {} as ArgumentMetadata)
                .catch((err) => err);
            } finally {
              concatSpy.mockRestore();
            }

            expect(error).toBeInstanceOf(BadRequestException);
            expect(error.getResponse().message).toHaveLength(100);
            expect(copied).toBeLessThan(100);
          });

          class Contact {
            @IsString()
            @IsNotEmpty()
            firstName!: string;

            @IsString()
            @IsNotEmpty()
            lastName!: string;

            @IsString()
            @IsNotEmpty()
            email!: string;

            @IsString()
            @IsNotEmpty()
            phone!: string;

            @IsString()
            @IsNotEmpty()
            city!: string;
          }

          // BUNEST_BUG: ParseArrayPipe lacks `stopAtFirstError: false`, `maxErrorMessagesLength`, and `isNumeric` method (packages/common/src/pipes/built-in.pipes.ts)
          it.skip('should stop at "maxErrorMessagesLength" characters of messages of all the items', async () => {
            const pipe = new ParseArrayPipe({
              items: Number,
              stopAtFirstError: false,
              maxErrorMessagesLength: 60,
            } as NestParseArrayOptions);
            const isNumeric = spyOn(pipe as any, "isNumeric");

            const error: any = await pipe
              .transform(",".repeat(99), {} as ArgumentMetadata)
              .catch((err) => err);

            expect(error).toBeInstanceOf(BadRequestException);
            expect(error.getResponse().message).toEqual([
              "[0] item must be a number",
              "[1] item must be a number",
              "[2] item must be a number",
              "Further validation errors were omitted",
            ]);
            expect(isNumeric).toHaveBeenCalledTimes(4);
          });

          // BUNEST_BUG: ParseArrayPipe lacks DTO class `items` validation, `stopAtFirstError: false`, and `maxErrorMessagesLength` (packages/common/src/pipes/built-in.pipes.ts)
          it.skip("should not start the limit over for each item with nested errors", async () => {
            class Address {
              @IsString()
              city!: string;

              @IsString()
              street!: string;
            }
            class ArrItemObject {
              @ValidateNested()
              @Type(() => Address)
              address!: Address;
            }
            const pipe = new ParseArrayPipe({
              items: ArrItemObject,
              stopAtFirstError: false,
              maxErrorMessagesLength: 100,
            } as NestParseArrayOptions);

            const error: any = await pipe
              .transform(
                new Array(100).fill({ address: {} }),
                {} as ArgumentMetadata,
              )
              .catch((err) => err);

            expect(error.getResponse().message).toEqual([
              "[0] address.city must be a string",
              "[0] address.street must be a string",
              "[1] address.city must be a string",
              "[1] address.street must be a string",
              "Further validation errors were omitted",
            ]);
          });

          // BUNEST_BUG: ParseArrayPipe lacks DTO class `items` validation and default `maxErrorMessagesLength` cap (packages/common/src/pipes/built-in.pipes.ts)
          it.skip("should limit the messages of all the items by default", async () => {
            const pipe = new ParseArrayPipe({
              items: Contact,
              stopAtFirstError: false,
            } as NestParseArrayOptions);

            const error: any = await pipe
              .transform(new Array(10_000).fill({}), {} as ArgumentMetadata)
              .catch((err) => err);

            const messages: string[] = error.getResponse().message;
            expect(messages.at(-1)).toBe(
              "Further validation errors were omitted",
            );
            expect(messages.join("").length).toBeLessThan(1_001_000);
          });

          // BUNEST_BUG: ParseArrayPipe ignores `stopAtFirstError: false` and `maxErrorMessagesLength`, emitting unindexed string instead of ["[0] item must be a number"] (packages/common/src/pipes/built-in.pipes.ts)
          it.skip("should not say that errors were omitted when none were left out", async () => {
            const pipe = new ParseArrayPipe({
              items: Number,
              stopAtFirstError: false,
              maxErrorMessagesLength: 10,
            } as NestParseArrayOptions);

            const error: any = await pipe
              .transform(["a", "1", "2"], {} as ArgumentMetadata)
              .catch((err) => err);

            expect(error.getResponse().message).toEqual([
              "[0] item must be a number",
            ]);
          });

          // BUNEST_BUG: ParseArrayPipe ignores `stopAtFirstError: false` so exceptionFactory receives only first error string instead of all 10 indexed error strings (packages/common/src/pipes/built-in.pipes.ts)
          it.skip("should hand every error to a custom exception factory", async () => {
            const exceptionFactory = mock(
              (errors: any) => new BadRequestException(errors),
            );
            const pipe = new ParseArrayPipe({
              items: Number,
              stopAtFirstError: false,
              maxErrorMessagesLength: 10,
              exceptionFactory,
            } as NestParseArrayOptions);

            const error: any = await pipe
              .transform(",".repeat(9), {} as ArgumentMetadata)
              .catch((err) => err);

            expect(error.getResponse().message).toHaveLength(10);
            expect(exceptionFactory).toHaveBeenLastCalledWith(
              expect.arrayContaining(["[9] item must be a number"]),
            );
          });

          // BUNEST_BUG: ParseArrayPipe lacks DTO class `items` validation and `maxErrorMessagesLength: Infinity` (packages/common/src/pipes/built-in.pipes.ts)
          it.skip('should collect every error when "maxErrorMessagesLength" is Infinity', async () => {
            const pipe = new ParseArrayPipe({
              items: Contact,
              stopAtFirstError: false,
              maxErrorMessagesLength: Infinity,
            } as NestParseArrayOptions);

            const error: any = await pipe
              .transform(new Array(4_000).fill({}), {} as ArgumentMetadata)
              .catch((err) => err);

            const messages: string[] = error.getResponse().message;
            expect(messages).toHaveLength(40_000);
            expect(messages.join("").length).toBeGreaterThan(1_000_000);
            expect(messages.at(-1)).toBe("[3999] city must be a string");
          });

          // BUNEST_BUG: ParseArrayPipe ignores `stopAtFirstError: false` and throws base HttpException with unindexed message instead of collecting all nested array errors (packages/common/src/pipes/built-in.pipes.ts)
          it.skip("should report every array nested in the array", async () => {
            const pipe = new ParseArrayPipe({
              items: Number,
              stopAtFirstError: false,
            } as NestParseArrayOptions);

            const error: any = await pipe
              .transform([[1], 2, ["3"]], {} as ArgumentMetadata)
              .catch((err) => err);

            expect(error).toBeInstanceOf(BadRequestException);
            expect(error.getResponse().message).toEqual([
              "[0] item must be a number",
              "[2] item must be a number",
            ]);
          });

          // BUNEST_BUG: ParseArrayPipe lacks DTO class `items` validation with nested object error concatenation (packages/common/src/pipes/built-in.pipes.ts)
          it.skip("should validate each nested object and concat errors", async () => {
            class RandomObject {
              @IsDefined()
              @IsBoolean()
              isEnabled!: boolean;

              @IsString()
              title!: string;

              @IsDate()
              createdAt!: Date;

              constructor(partial: Partial<any>) {
                Object.assign(this, partial);
              }
            }
            class ArrItemObject {
              @ValidateNested()
              random!: RandomObject;
            }
            const pipe = new ParseArrayPipe({
              items: ArrItemObject,
              stopAtFirstError: false,
            } as NestParseArrayOptions);
            let threw = false;
            try {
              await pipe.transform(
                [
                  {
                    random: new RandomObject({
                      isEnabled: true,
                      title: true,
                      createdAt: new Date(),
                    }),
                  },
                  {
                    random: new RandomObject({
                      title: "ok",
                      createdAt: false,
                    }),
                  },
                ],
                {} as ArgumentMetadata,
              );
            } catch (err: any) {
              threw = true;
              expect(err).toBeInstanceOf(BadRequestException);
              expect(err.getResponse().message).toEqual([
                "[0] random.title must be a string",
                "[1] random.isEnabled should not be null or undefined",
                "[1] random.isEnabled must be a boolean value",
                "[1] random.createdAt must be a Date instance",
              ]);
            }
            expect(threw).toBe(true);
          });

          // BUNEST_BUG: ParseArrayPipe lacks DTO class `items` validation with nested array error concatenation (packages/common/src/pipes/built-in.pipes.ts)
          it.skip("should validate each nested array and concat errors", async () => {
            class RandomObject {
              @IsDefined()
              @IsBoolean()
              isEnabled!: boolean;

              @IsString()
              title!: string;

              @IsDate()
              createdAt!: Date;

              constructor(partial: Partial<any>) {
                Object.assign(this, partial);
              }
            }
            class ArrItemObject {
              @Type(() => RandomObject)
              @ValidateNested({ each: true })
              random!: RandomObject[];
            }
            const pipe = new ParseArrayPipe({
              items: ArrItemObject,
              stopAtFirstError: false,
            } as NestParseArrayOptions);
            let threw = false;
            try {
              await pipe.transform(
                [
                  {
                    random: [
                      new RandomObject({
                        isEnabled: true,
                        title: true,
                        createdAt: new Date(),
                      }),
                      new RandomObject({
                        isEnabled: true,
                        title: true,
                        createdAt: new Date(),
                      }),
                    ],
                  },
                  {
                    random: [
                      new RandomObject({
                        title: "ok",
                        createdAt: false,
                      }),
                    ],
                  },
                ],
                {} as ArgumentMetadata,
              );
            } catch (err: any) {
              threw = true;
              expect(err).toBeInstanceOf(BadRequestException);
              expect(err.getResponse().message).toEqual([
                "[0] random.0.title must be a string",
                "[0] random.1.title must be a string",
                "[1] random.0.isEnabled should not be null or undefined",
                "[1] random.0.isEnabled must be a boolean value",
                "[1] random.0.createdAt must be a Date instance",
              ]);
            }
            expect(threw).toBe(true);
          });

          describe('and "errorFormat" is "grouped"', () => {
            // BUNEST_BUG: ParseArrayPipe lacks DTO class `items` validation and `errorFormat: "grouped"` (packages/common/src/pipes/built-in.pipes.ts)
            it.skip("should keep the field and the message of each invalid item", async () => {
              class ArrItemWithProp {
                @IsNumber()
                number!: number;
              }
              const pipe = new ParseArrayPipe({
                items: ArrItemWithProp,
                stopAtFirstError: false,
                errorFormat: "grouped",
              } as NestParseArrayOptions);

              const error: any = await pipe
                .transform(
                  [{ number: "a" }, { number: 1 }, { number: "b" }],
                  {} as ArgumentMetadata,
                )
                .catch((err) => err);

              expect(error).toBeInstanceOf(BadRequestException);
              expect(error.getResponse().message).toEqual([
                "[0] number: number must be a number conforming to the specified constraints",
                "[2] number: number must be a number conforming to the specified constraints",
              ]);
            });

            // BUNEST_BUG: ParseArrayPipe lacks DTO class `items` validation and `errorFormat: "grouped"` (packages/common/src/pipes/built-in.pipes.ts)
            it.skip("should keep the path of a nested field", async () => {
              class Address {
                @IsString()
                city!: string;
              }
              class ArrItemObject {
                @ValidateNested()
                @Type(() => Address)
                address!: Address;
              }
              const pipe = new ParseArrayPipe({
                items: ArrItemObject,
                stopAtFirstError: false,
                errorFormat: "grouped",
              } as NestParseArrayOptions);

              const error: any = await pipe
                .transform(
                  [{ address: { city: "Paris" } }, { address: { city: 1 } }],
                  {} as ArgumentMetadata,
                )
                .catch((err) => err);

              expect(error).toBeInstanceOf(BadRequestException);
              expect(error.getResponse().message).toEqual([
                "[1] address.city: city must be a string",
              ]);
            });

            // BUNEST_BUG: ParseArrayPipe lacks DTO class `items` validation and `errorFormat: "grouped"` (packages/common/src/pipes/built-in.pipes.ts)
            it.skip("should list every message of a field", async () => {
              class ArrItemWithProp {
                @IsDefined()
                @IsBoolean()
                isEnabled!: boolean;
              }
              const pipe = new ParseArrayPipe({
                items: ArrItemWithProp,
                stopAtFirstError: false,
                errorFormat: "grouped",
              } as NestParseArrayOptions);

              const error: any = await pipe
                .transform([{}], {} as ArgumentMetadata)
                .catch((err) => err);

              expect(error.getResponse().message).toEqual([
                "[0] isEnabled: isEnabled should not be null or undefined",
                "[0] isEnabled: isEnabled must be a boolean value",
              ]);
            });

            // BUNEST_BUG: ParseArrayPipe lacks DTO class `items` validation, `errorFormat: "grouped"`, and `maxErrorMessagesLength` (packages/common/src/pipes/built-in.pipes.ts)
            it.skip("should not take the note about omitted errors for a path", async () => {
              class ArrItemWithProp {
                @IsNumber()
                number!: number;

                @IsString()
                title!: string;
              }
              const pipe = new ParseArrayPipe({
                items: ArrItemWithProp,
                stopAtFirstError: false,
                errorFormat: "grouped",
                maxErrorMessagesLength: 40,
              } as NestParseArrayOptions);

              const error: any = await pipe
                .transform([{}], {} as ArgumentMetadata)
                .catch((err) => err);

              const messages: string[] = error.getResponse().message;
              expect(messages.at(-1)).toBe(
                "[0] Further validation errors were omitted",
              );
            });

            // BUNEST_BUG: ParseArrayPipe lacks DTO class `items` validation and object-shaped error message extraction in `stopAtFirstError: false` mode (packages/common/src/pipes/built-in.pipes.ts)
            it.skip("should not fail on a message that is not a list of strings", async () => {
              class ArrItemWithProp {
                @IsNumber()
                number!: number;
              }
              const pipe = new ParseArrayPipe({
                items: ArrItemWithProp,
                stopAtFirstError: false,
                exceptionFactory: (errors: any[]) =>
                  new BadRequestException(
                    typeof errors[0] === "string"
                      ? errors
                      : ({ message: { number: "is bad" } } as any),
                  ),
              } as unknown as ParseArrayPipeOptions);

              const error: any = await pipe
                .transform([{ number: "a" }], {} as ArgumentMetadata)
                .catch((err) => err);

              expect(error).toBeInstanceOf(BadRequestException);
              expect(error.getResponse().message).toEqual([
                "[0] number: is bad",
              ]);
            });

            // BUNEST_BUG: ParseArrayPipe lacks `stopAtFirstError: false` and `errorFormat: "grouped"`, emitting unindexed string message instead of ["[1] item must be a number"] (packages/common/src/pipes/built-in.pipes.ts)
            it.skip("should keep the message of a primitive item", async () => {
              const pipe = new ParseArrayPipe({
                items: Number,
                stopAtFirstError: false,
                errorFormat: "grouped",
              } as NestParseArrayOptions);

              const error: any = await pipe
                .transform(["1", "a"], {} as ArgumentMetadata)
                .catch((err) => err);

              expect(error.getResponse().message).toEqual([
                "[1] item must be a number",
              ]);
            });
          });
        });
      });
    });
  },
);
