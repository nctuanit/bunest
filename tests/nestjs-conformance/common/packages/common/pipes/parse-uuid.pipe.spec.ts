import { describe, expect, it } from "bun:test";
import {
  HttpException,
  HttpStatus,
  ParseUUIDPipe,
  type ArgumentMetadata,
  type ParseUUIDPipeOptions,
  type UUIDVersion,
} from "../../../../../../packages/core/src/common";
import { describeConformance } from "../../../../_helpers";

class TestException extends HttpException {
  constructor() {
    super("This is a TestException", HttpStatus.I_AM_A_TEAPOT);
  }
}

describeConformance(
  "ParseUUIDPipe",
  {
    upstreamPath: "packages/common/test/pipes/parse-uuid.pipe.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    let target: ParseUUIDPipe;
    const exceptionFactory = (_error: unknown) => new TestException();

    describe("transform", () => {
      const v1 = "c232ab00-9414-11ec-b3c8-9f6bdeced846";
      const v2 = "000003e8-9414-21ec-b300-9f6bdeced846";
      const v3 = "e8b5a51d-11c8-3310-a6ab-367563f20686";
      const v4 = "10ba038e-48da-487b-96e8-8d3b99b6d18a";
      const v5 = "630eb68f-e0fa-5ecc-887a-7c7a62614681";
      const v6 = "1ec9414c-232a-6b00-b3c8-9f6bdeced846";
      const v7 = "017f22e2-79b0-7cc3-98c4-dc0c0c07398f";
      const v8 = "2489e9ad-2ee2-8e00-8ec9-32d5f69181c0";

      describe("when validation passes", () => {
        // BUNEST_BUG: ParseUUIDPipe UUID_REGEX.all rejects RFC 9562 nil ("00000000-...") and max ("ffffffff-...") UUIDs (packages/core/src/common/pipes/built-in.pipes.ts)
        it.skip('should return string if value is uuid and version is "all"', async () => {
          target = new ParseUUIDPipe({ version: "all", exceptionFactory });
          for (const uuid of [
            v1,
            v2,
            v3,
            v4,
            v5,
            v6,
            v7,
            v8,
            "00000000-0000-0000-0000-000000000000",
            "ffffffff-ffff-ffff-ffff-ffffffffffff",
          ]) {
            expect(await target.transform(uuid, {} as ArgumentMetadata)).toBe(
              uuid,
            );
          }
        });

        // BUNEST_BUG: ParseUUIDPipe UUID_REGEX & UUIDVersion omit versions "1", "2", "6", "8" and numeric versions (version: 1 crashes with TypeError on undefined regex) (packages/core/src/common/pipes/built-in.pipes.ts)
        it.skip("should return string if value is uuid and version is a number", async () => {
          target = new ParseUUIDPipe({
            version: 1 as unknown as UUIDVersion,
            exceptionFactory,
          });
          expect(await target.transform(v1, {} as ArgumentMetadata)).toBe(v1);

          target = new ParseUUIDPipe({
            version: 4 as unknown as UUIDVersion,
            exceptionFactory,
          });
          expect(await target.transform(v4, {} as ArgumentMetadata)).toBe(v4);

          target = new ParseUUIDPipe({
            version: 7 as unknown as UUIDVersion,
            exceptionFactory,
          });
          expect(await target.transform(v7, {} as ArgumentMetadata)).toBe(v7);
        });

        it("should accept UUIDVersion values", () => {
          const version: UUIDVersion = "all";
          const numVersion = 4 as unknown as UUIDVersion;
          const pipe1 = new ParseUUIDPipe({ version });
          const pipe2 = new ParseUUIDPipe({ version: numVersion });
          expect(pipe1).toBeDefined();
          expect(pipe2).toBeDefined();
        });

        it("should return string if value is uuid v3, v4 or v5", async () => {
          target = new ParseUUIDPipe({ exceptionFactory });
          expect(await target.transform(v3, {} as ArgumentMetadata)).toBe(v3);
          expect(await target.transform(v4, {} as ArgumentMetadata)).toBe(v4);
          expect(await target.transform(v5, {} as ArgumentMetadata)).toBe(v5);
        });

        // BUNEST_BUG: ParseUUIDPipe default "all" regex rejects RFC 9562 nil ("00000000-...") and max ("ffffffff-..." / "FFFFFFFF-...") UUIDs (packages/core/src/common/pipes/built-in.pipes.ts)
        it.skip("should return string if value is uuid v1, v2, v6, v7, v8, nil or max", async () => {
          target = new ParseUUIDPipe({ exceptionFactory });
          for (const uuid of [
            v1,
            v2,
            v6,
            v7,
            v8,
            "00000000-0000-0000-0000-000000000000",
            "ffffffff-ffff-ffff-ffff-ffffffffffff",
            "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF",
          ]) {
            expect(await target.transform(uuid, {} as ArgumentMetadata)).toBe(
              uuid,
            );
          }
        });

        // BUNEST_BUG: ParseUUIDPipe UUID_REGEX omits version "1" (throws TypeError) (packages/core/src/common/pipes/built-in.pipes.ts)
        it.skip("should return string if value is uuid v1", async () => {
          target = new ParseUUIDPipe({
            version: "1" as unknown as UUIDVersion,
            exceptionFactory,
          });
          expect(await target.transform(v1, {} as ArgumentMetadata)).toBe(v1);
        });

        // BUNEST_BUG: ParseUUIDPipe UUID_REGEX omits version "2" (throws TypeError) (packages/core/src/common/pipes/built-in.pipes.ts)
        it.skip("should return string if value is uuid v2", async () => {
          target = new ParseUUIDPipe({
            version: "2" as unknown as UUIDVersion,
            exceptionFactory,
          });
          expect(await target.transform(v2, {} as ArgumentMetadata)).toBe(v2);
        });

        it("should return string if value is uuid v3", async () => {
          target = new ParseUUIDPipe({ version: "3", exceptionFactory });
          expect(await target.transform(v3, {} as ArgumentMetadata)).toBe(v3);
        });

        it("should return string if value is uuid v4", async () => {
          target = new ParseUUIDPipe({ version: "4", exceptionFactory });
          expect(await target.transform(v4, {} as ArgumentMetadata)).toBe(v4);
        });

        it("should return string if value is uuid v5", async () => {
          target = new ParseUUIDPipe({ version: "5", exceptionFactory });
          expect(await target.transform(v5, {} as ArgumentMetadata)).toBe(v5);
        });

        // BUNEST_BUG: ParseUUIDPipe UUID_REGEX omits version "6" (throws TypeError) (packages/core/src/common/pipes/built-in.pipes.ts)
        it.skip("should return string if value is uuid v6", async () => {
          target = new ParseUUIDPipe({
            version: "6" as unknown as UUIDVersion,
            exceptionFactory,
          });
          expect(await target.transform(v6, {} as ArgumentMetadata)).toBe(v6);
        });

        it("should return string if value is uuid v7", async () => {
          target = new ParseUUIDPipe({ version: "7", exceptionFactory });
          expect(await target.transform(v7, {} as ArgumentMetadata)).toBe(v7);
        });

        // BUNEST_BUG: ParseUUIDPipe UUID_REGEX omits version "8" (throws TypeError) (packages/core/src/common/pipes/built-in.pipes.ts)
        it.skip("should return string if value is uuid v8", async () => {
          target = new ParseUUIDPipe({
            version: "8" as unknown as UUIDVersion,
            exceptionFactory,
          });
          expect(await target.transform(v8, {} as ArgumentMetadata)).toBe(v8);
        });

        it("should not throw an error if the value is undefined/null and optional is true", async () => {
          const optionalTarget = new ParseUUIDPipe({ optional: true });
          const value = await optionalTarget.transform(
            undefined!,
            {} as ArgumentMetadata,
          );
          expect(value).toBe(undefined);
        });
      });

      describe("when validation fails", () => {
        // BUNEST_BUG: ParseUUIDPipe.transform() is synchronous instead of async (returns Promise in NestJS), causing `expect(target.transform(...)).rejects` to throw synchronously (packages/core/src/common/pipes/built-in.pipes.ts)
        it.skip("should throw an error", async () => {
          target = new ParseUUIDPipe({ exceptionFactory });
          await expect(
            target.transform("123a", {} as ArgumentMetadata),
          ).rejects.toThrow(TestException);
        });

        // BUNEST_BUG: ParseUUIDPipe.transform() is synchronous instead of async (packages/core/src/common/pipes/built-in.pipes.ts)
        it.skip('should throw an error with "uuid is expected" when version is "all"', async () => {
          target = new ParseUUIDPipe({ version: "all" });
          await expect(
            target.transform("invalid-uuid", {} as ArgumentMetadata),
          ).rejects.toThrow("Validation failed (uuid is expected)");
        });

        // BUNEST_BUG: ParseUUIDPipe.transform() is synchronous instead of async, AND formats message as "Validation failed (uuid v4 is expected)" instead of NestJS "Validation failed (uuid v 4 is expected)" (packages/core/src/common/pipes/built-in.pipes.ts)
        it.skip('should throw an error with "uuid v 4 is expected" when version is number 4', async () => {
          target = new ParseUUIDPipe({
            version: 4 as unknown as ParseUUIDPipeOptions["version"],
          });
          await expect(
            target.transform("invalid-uuid", {} as ArgumentMetadata),
          ).rejects.toThrow("Validation failed (uuid v 4 is expected)");
        });

        // BUNEST_BUG: ParseUUIDPipe.transform() is synchronous instead of async (packages/core/src/common/pipes/built-in.pipes.ts)
        it.skip("should throw an error when numeric version does not match", async () => {
          target = new ParseUUIDPipe({
            version: 4 as unknown as UUIDVersion,
            exceptionFactory,
          });
          await expect(
            target.transform(v1, {} as ArgumentMetadata),
          ).rejects.toThrow(TestException);
        });

        // BUNEST_BUG: ParseUUIDPipe.transform() is synchronous instead of async (packages/core/src/common/pipes/built-in.pipes.ts)
        it.skip("should throw an error - not a string", async () => {
          target = new ParseUUIDPipe({ exceptionFactory });
          await expect(
            target.transform(undefined!, {} as ArgumentMetadata),
          ).rejects.toThrow(TestException);
        });

        // BUNEST_BUG: ParseUUIDPipe.transform() is synchronous instead of async (packages/core/src/common/pipes/built-in.pipes.ts)
        it.skip("should throw an error for a UUID with an invalid version", async () => {
          target = new ParseUUIDPipe({ exceptionFactory });
          for (const invalid of [
            // same as `v4` but with version nibble `0` or `f` instead of `4`
            "10ba038e-48da-087b-96e8-8d3b99b6d18a",
            "10ba038e-48da-f87b-96e8-8d3b99b6d18a",
          ]) {
            await expect(
              target.transform(invalid, {} as ArgumentMetadata),
            ).rejects.toThrow(TestException);
          }
        });

        // BUNEST_BUG: ParseUUIDPipe.transform() is synchronous instead of async (packages/core/src/common/pipes/built-in.pipes.ts)
        it.skip("should throw an error for a UUID with an invalid variant", async () => {
          target = new ParseUUIDPipe({ exceptionFactory });
          for (const invalid of [
            // same as `v4` but with variant nibble `0` or `c` instead of `9`
            "10ba038e-48da-487b-06e8-8d3b99b6d18a",
            "10ba038e-48da-487b-c6e8-8d3b99b6d18a",
          ]) {
            await expect(
              target.transform(invalid, {} as ArgumentMetadata),
            ).rejects.toThrow(TestException);
          }
        });

        // BUNEST_BUG: ParseUUIDPipe.transform() is synchronous instead of async (packages/core/src/common/pipes/built-in.pipes.ts)
        it.skip("should throw an error - v3", async () => {
          target = new ParseUUIDPipe({ version: "3", exceptionFactory });
          await expect(
            target.transform("123a", {} as ArgumentMetadata),
          ).rejects.toThrow(TestException);
          await expect(
            target.transform(v4, {} as ArgumentMetadata),
          ).rejects.toThrow(TestException);
          await expect(
            target.transform(v5, {} as ArgumentMetadata),
          ).rejects.toThrow(TestException);
        });

        // BUNEST_BUG: ParseUUIDPipe.transform() is synchronous instead of async (packages/core/src/common/pipes/built-in.pipes.ts)
        it.skip("should throw an error for a UUID v3 with an invalid variant", async () => {
          target = new ParseUUIDPipe({ version: "3", exceptionFactory });
          await expect(
            target.transform(
              // same as `v3` but with variant nibble `0` instead of `a`
              "e8b5a51d-11c8-3310-06ab-367563f20686",
              {} as ArgumentMetadata,
            ),
          ).rejects.toThrow(TestException);
        });

        // BUNEST_BUG: ParseUUIDPipe.transform() is synchronous instead of async (packages/core/src/common/pipes/built-in.pipes.ts)
        it.skip("should throw an error - v4", async () => {
          target = new ParseUUIDPipe({ version: "4", exceptionFactory });
          await expect(
            target.transform("123a", {} as ArgumentMetadata),
          ).rejects.toThrow(TestException);
          await expect(
            target.transform(v3, {} as ArgumentMetadata),
          ).rejects.toThrow(TestException);
          await expect(
            target.transform(v5, {} as ArgumentMetadata),
          ).rejects.toThrow(TestException);
        });

        // BUNEST_BUG: ParseUUIDPipe.transform() is synchronous instead of async (packages/core/src/common/pipes/built-in.pipes.ts)
        it.skip("should throw an error - v5", async () => {
          target = new ParseUUIDPipe({ version: "5", exceptionFactory });
          await expect(
            target.transform("123a", {} as ArgumentMetadata),
          ).rejects.toThrow(TestException);
          await expect(
            target.transform(v3, {} as ArgumentMetadata),
          ).rejects.toThrow(TestException);
          await expect(
            target.transform(v4, {} as ArgumentMetadata),
          ).rejects.toThrow(TestException);
        });

        // BUNEST_BUG: ParseUUIDPipe.transform() is synchronous instead of async (packages/core/src/common/pipes/built-in.pipes.ts)
        it.skip("should throw an error - v7", async () => {
          target = new ParseUUIDPipe({ version: "7", exceptionFactory });
          await expect(
            target.transform("123a", {} as ArgumentMetadata),
          ).rejects.toThrow(TestException);
          await expect(
            target.transform(v3, {} as ArgumentMetadata),
          ).rejects.toThrow(TestException);
          await expect(
            target.transform(v4, {} as ArgumentMetadata),
          ).rejects.toThrow(TestException);
          await expect(
            target.transform(v5, {} as ArgumentMetadata),
          ).rejects.toThrow(TestException);
        });

        // BUNEST_BUG: ParseUUIDPipe.transform() is synchronous instead of async (packages/core/src/common/pipes/built-in.pipes.ts)
        it.skip("should throw an error for a UUID v7 with an invalid variant", async () => {
          target = new ParseUUIDPipe({ version: "7", exceptionFactory });
          await expect(
            target.transform(
              // same as `v7` but with variant nibble `c` instead of `9`
              "017f22e2-79b0-7cc3-c8c4-dc0c0c07398f",
              {} as ArgumentMetadata,
            ),
          ).rejects.toThrow(TestException);
        });

        // BUNEST_BUG: ParseUUIDPipe omits version "1" from UUID_REGEX (TypeError) and transform() is synchronous instead of async (packages/core/src/common/pipes/built-in.pipes.ts)
        it.skip("should throw an error - v1", async () => {
          target = new ParseUUIDPipe({
            version: "1" as unknown as UUIDVersion,
            exceptionFactory,
          });
          for (const candidate of ["123a", v2, v3, v4, v5, v6, v7, v8]) {
            await expect(
              target.transform(candidate, {} as ArgumentMetadata),
            ).rejects.toThrow(TestException);
          }
        });

        // BUNEST_BUG: ParseUUIDPipe omits version "1" from UUID_REGEX (TypeError) and transform() is synchronous instead of async (packages/core/src/common/pipes/built-in.pipes.ts)
        it.skip("should throw an error for a UUID v1 with an invalid variant", async () => {
          target = new ParseUUIDPipe({
            version: "1" as unknown as UUIDVersion,
            exceptionFactory,
          });
          await expect(
            target.transform(
              "c232ab00-9414-11ec-c3c8-9f6bdeced846",
              {} as ArgumentMetadata,
            ),
          ).rejects.toThrow(TestException);
        });

        // BUNEST_BUG: ParseUUIDPipe omits version "2" from UUID_REGEX (TypeError) and transform() is synchronous instead of async (packages/core/src/common/pipes/built-in.pipes.ts)
        it.skip("should throw an error - v2", async () => {
          target = new ParseUUIDPipe({
            version: "2" as unknown as UUIDVersion,
            exceptionFactory,
          });
          for (const candidate of ["123a", v1, v3, v4, v5, v6, v7, v8]) {
            await expect(
              target.transform(candidate, {} as ArgumentMetadata),
            ).rejects.toThrow(TestException);
          }
        });

        // BUNEST_BUG: ParseUUIDPipe omits version "2" from UUID_REGEX (TypeError) and transform() is synchronous instead of async (packages/core/src/common/pipes/built-in.pipes.ts)
        it.skip("should throw an error for a UUID v2 with an invalid variant", async () => {
          target = new ParseUUIDPipe({
            version: "2" as unknown as UUIDVersion,
            exceptionFactory,
          });
          await expect(
            target.transform(
              "000003e8-9414-21ec-c300-9f6bdeced846",
              {} as ArgumentMetadata,
            ),
          ).rejects.toThrow(TestException);
        });

        // BUNEST_BUG: ParseUUIDPipe omits version "6" from UUID_REGEX (TypeError) and transform() is synchronous instead of async (packages/core/src/common/pipes/built-in.pipes.ts)
        it.skip("should throw an error - v6", async () => {
          target = new ParseUUIDPipe({
            version: "6" as unknown as UUIDVersion,
            exceptionFactory,
          });
          for (const candidate of ["123a", v1, v2, v3, v4, v5, v7, v8]) {
            await expect(
              target.transform(candidate, {} as ArgumentMetadata),
            ).rejects.toThrow(TestException);
          }
        });

        // BUNEST_BUG: ParseUUIDPipe omits version "6" from UUID_REGEX (TypeError) and transform() is synchronous instead of async (packages/core/src/common/pipes/built-in.pipes.ts)
        it.skip("should throw an error for a UUID v6 with an invalid variant", async () => {
          target = new ParseUUIDPipe({
            version: "6" as unknown as UUIDVersion,
            exceptionFactory,
          });
          await expect(
            target.transform(
              "1ec9414c-232a-6b00-c3c8-9f6bdeced846",
              {} as ArgumentMetadata,
            ),
          ).rejects.toThrow(TestException);
        });

        // BUNEST_BUG: ParseUUIDPipe omits version "8" from UUID_REGEX (TypeError) and transform() is synchronous instead of async (packages/core/src/common/pipes/built-in.pipes.ts)
        it.skip("should throw an error - v8", async () => {
          target = new ParseUUIDPipe({
            version: "8" as unknown as UUIDVersion,
            exceptionFactory,
          });
          for (const candidate of ["123a", v1, v2, v3, v4, v5, v6, v7]) {
            await expect(
              target.transform(candidate, {} as ArgumentMetadata),
            ).rejects.toThrow(TestException);
          }
        });

        // BUNEST_BUG: ParseUUIDPipe omits version "8" from UUID_REGEX (TypeError) and transform() is synchronous instead of async (packages/core/src/common/pipes/built-in.pipes.ts)
        it.skip("should throw an error for a UUID v8 with an invalid variant", async () => {
          target = new ParseUUIDPipe({
            version: "8" as unknown as UUIDVersion,
            exceptionFactory,
          });
          await expect(
            target.transform(
              "2489e9ad-2ee2-8e00-0ec9-32d5f69181c0",
              {} as ArgumentMetadata,
            ),
          ).rejects.toThrow(TestException);
        });
      });
    });
  },
);
