import { beforeEach, describe, expect, it } from "bun:test";
import {
  ParseBoolPipe,
  type ArgumentMetadata,
} from "../../../../../../packages/core/src/common";
import { describeConformance } from "../../../../_helpers";

describeConformance(
  "ParseBoolPipe",
  {
    upstreamPath: "packages/common/test/pipes/parse-bool.pipe.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    let target: ParseBoolPipe;

    beforeEach(() => {
      target = new ParseBoolPipe();
    });

    describe("transform", () => {
      describe("when validation passes", () => {
        it("should return boolean", async () => {
          expect(await target.transform("true", {} as ArgumentMetadata)).toBe(
            true,
          );
          expect(await target.transform(true, {} as ArgumentMetadata)).toBe(
            true,
          );
          expect(await target.transform("false", {} as ArgumentMetadata)).toBe(
            false,
          );
          expect(await target.transform(false, {} as ArgumentMetadata)).toBe(
            false,
          );
        });

        it("should not throw an error if the value is undefined/null and optional is true", async () => {
          const optionalTarget = new ParseBoolPipe({ optional: true });
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
            target.transform("123abc", {} as ArgumentMetadata),
          ).rejects.toBeDefined();
        });
      });
    });
  },
);
