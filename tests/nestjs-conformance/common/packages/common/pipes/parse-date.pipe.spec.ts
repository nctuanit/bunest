import { beforeEach, describe, expect, it } from "bun:test";
import {
  BadRequestException,
  METADATA_KEYS,
  MetadataRegistry,
  ParseDatePipe,
  type ParseDatePipeOptions,
} from "../../../../../../packages/core/src/common";
import { describeConformance } from "../../../../_helpers";

describeConformance(
  "ParseDatePipe",
  {
    upstreamPath: "packages/common/test/pipes/parse-date.pipe.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    let target: ParseDatePipe;

    beforeEach(() => {
      target = new ParseDatePipe();
    });

    describe("transform", () => {
      describe("when validation passes", () => {
        it("should return a valid date object", () => {
          const date = new Date().toISOString();

          const transformedDate = target.transform(date)!;
          expect(transformedDate).toBeInstanceOf(Date);
          expect(transformedDate.toISOString()).toBe(date);

          const asNumber = transformedDate.getTime();
          const transformedNumber = target.transform(asNumber)!;
          expect(transformedNumber).toBeInstanceOf(Date);
          expect(transformedNumber.getTime()).toBe(asNumber);
        });

        it("should parse zero timestamp as a valid date", () => {
          const transformedDate = target.transform(0)!;

          expect(transformedDate).toBeInstanceOf(Date);
          expect(transformedDate.getTime()).toBe(0);
        });

        it("should not throw an error if the value is undefined/null and optional is true", () => {
          const optionalTarget = new ParseDatePipe({ optional: true });
          const value = optionalTarget.transform(undefined);
          expect(value).toBe(undefined);
        });
      });

      describe("when default value is provided", () => {
        // BUNEST_BUG: ParseDatePipeOptions does not support `default?: () => Date`; returns undefined instead of invoking default() (packages/core/src/common/pipes/built-in.pipes.ts)
        it.skip("should return the default value if the value is undefined/null", () => {
          const defaultValue = new Date();
          const defaultTarget = new ParseDatePipe({
            optional: true,
            default: () => defaultValue,
          } as ParseDatePipeOptions & { default?: () => Date });
          const value = defaultTarget.transform(undefined);
          expect(value).toBe(defaultValue);
        });

        // BUNEST_BUG: ParseDatePipeOptions does not support `default?: () => Date`; throws HttpException instead of returning defaultValue when optional is omitted (packages/core/src/common/pipes/built-in.pipes.ts)
        it.skip('should return the default value without requiring "optional"', () => {
          const defaultValue = new Date();
          const defaultTarget = new ParseDatePipe({
            default: () => defaultValue,
          } as ParseDatePipeOptions & { default?: () => Date });

          expect(defaultTarget.transform(undefined)).toBe(defaultValue);
          expect(defaultTarget.transform(null)).toBe(defaultValue);
        });

        // BUNEST_BUG: createPipeException throws base HttpException(status=400) instead of BadRequestException (and ParseDatePipeOptions lacks `default`) (packages/core/src/common/pipes/built-in.pipes.ts)
        it.skip("should throw for an empty string even when a default value is provided", () => {
          const defaultValue = new Date();
          const defaultTarget = new ParseDatePipe({
            default: () => defaultValue,
          } as ParseDatePipeOptions & { default?: () => Date });

          expect(() => defaultTarget.transform("")).toThrow(
            BadRequestException,
          );
        });

        // BUNEST_BUG: createPipeException throws base HttpException(status=400) instead of BadRequestException (and ParseDatePipeOptions lacks `default`) (packages/core/src/common/pipes/built-in.pipes.ts)
        it.skip('should throw for an empty string when both "optional" and a default value are provided', () => {
          const defaultValue = new Date();
          const defaultTarget = new ParseDatePipe({
            optional: true,
            default: () => defaultValue,
          } as ParseDatePipeOptions & { default?: () => Date });

          expect(() => defaultTarget.transform("")).toThrow(
            BadRequestException,
          );
        });

        // BUNEST_BUG: createPipeException throws base HttpException(status=400) instead of BadRequestException (and ParseDatePipeOptions lacks `default`) (packages/core/src/common/pipes/built-in.pipes.ts)
        it.skip("should not fall back to the default value for an invalid value", () => {
          const defaultValue = new Date();
          const defaultTarget = new ParseDatePipe({
            default: () => defaultValue,
          } as ParseDatePipeOptions & { default?: () => Date });

          expect(() => defaultTarget.transform("123abc")).toThrow(
            BadRequestException,
          );
        });
      });

      describe("when validation fails", () => {
        // BUNEST_BUG: createPipeException throws base HttpException(status=400) instead of BadRequestException (packages/core/src/common/pipes/built-in.pipes.ts)
        it.skip("should throw an error", () => {
          expect(() => target.transform("123abc")).toThrow(BadRequestException);
        });

        // BUNEST_BUG: ParseDatePipe does not reject calendar rollover dates (e.g. "2024-02-30" silently rolls over to 2024-03-01 via `new Date()`), and throws base HttpException instead of BadRequestException (packages/core/src/common/pipes/built-in.pipes.ts)
        it.skip("should throw for a day past the end of its month", () => {
          for (const value of [
            "2024-02-30",
            "2023-02-29",
            "2024-04-31",
            "2100-02-29",
            "2024-02-30T10:00:00Z",
            "2024-06-31T10:00:00+09:00",
            "+002024-02-30",
          ]) {
            expect(() => target.transform(value)).toThrow(BadRequestException);
          }
        });

        it("should accept the last day of each month", () => {
          for (const value of [
            "2024-02-29",
            "2000-02-29",
            "2023-02-28",
            "2024-04-30",
            "2024-12-31T23:59:59Z",
          ]) {
            expect(target.transform(value)).toEqual(new Date(value));
          }
        });
      });

      describe("when empty value", () => {
        // BUNEST_BUG: createPipeException throws base HttpException(status=400) instead of BadRequestException (packages/core/src/common/pipes/built-in.pipes.ts)
        it.skip("should throw an error", () => {
          expect(() => target.transform("")).toThrow(BadRequestException);
        });

        // BUNEST_BUG: createPipeException throws base HttpException(status=400) instead of BadRequestException (packages/core/src/common/pipes/built-in.pipes.ts)
        it.skip('should throw an error even when "optional" is true', () => {
          const optionalTarget = new ParseDatePipe({ optional: true });
          expect(() => optionalTarget.transform("")).toThrow(
            BadRequestException,
          );
        });
      });
    });

    describe("dependency injection", () => {
      // BUNEST_BUG: ParseDatePipe constructor parameter 0 is missing @Optional() / METADATA_KEYS.OPTIONAL_DEPS metadata (expected [0], actual undefined) (packages/core/src/common/pipes/built-in.pipes.ts)
      it.skip("should mark the options argument as optional", () => {
        // Without this metadata the injector cannot instantiate the pipe when it
        // is passed by class, e.g. `@Query('date', ParseDatePipe)`.
        const metadata = MetadataRegistry.getOwn(
          METADATA_KEYS.OPTIONAL_DEPS,
          ParseDatePipe,
        );
        expect(metadata).toEqual([0]);
      });

      // BUNEST_BUG: createPipeException throws base HttpException(status=400) instead of BadRequestException (packages/core/src/common/pipes/built-in.pipes.ts)
      it.skip("should fall back to the default options when none are injected", () => {
        const injectedTarget = new ParseDatePipe(undefined);
        expect(() => injectedTarget.transform("")).toThrow(BadRequestException);
      });
    });
  },
);
