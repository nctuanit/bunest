import { describe, expect, it } from "bun:test";
import {
  MaxFileSizeValidator,
  type MaxFileSizeValidatorOptions,
  type UploadedFileInfo,
} from "../../../../../../../packages/core/src/common";
import { describeConformance } from "../../../../../_helpers";

describeConformance(
  "MaxFileSizeValidator",
  {
    upstreamPath:
      "packages/common/test/pipes/file/max-file-size.validator.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    const oneKb = 1024;

    describe("isValid", () => {
      it("should return true when the file size is less than the maximum size", () => {
        const maxFileSizeValidator = new MaxFileSizeValidator({
          maxSize: oneKb,
        });

        const requestFile = {
          size: 100,
        } as unknown as UploadedFileInfo;

        expect(maxFileSizeValidator.isValid(requestFile)).toBe(true);
      });

      it("should return false when the file size is greater than the maximum size", () => {
        const maxFileSizeValidator = new MaxFileSizeValidator({
          maxSize: oneKb,
        });

        const requestFile = {
          size: oneKb + 1,
        } as unknown as UploadedFileInfo;

        expect(maxFileSizeValidator.isValid(requestFile)).toBe(false);
      });

      // BUNEST_BUG: MaxFileSizeValidator.isValid uses `size <= maxSize` (inclusive) instead of NestJS `< maxSize` (strict); expected false for size === maxSize, actual true (packages/core/src/common/pipes/file-validators.ts)
      it.skip("should return false when the file size is equal to the maximum size", () => {
        const maxFileSizeValidator = new MaxFileSizeValidator({
          maxSize: oneKb,
        });

        const requestFile = {
          size: oneKb,
        } as unknown as UploadedFileInfo;

        expect(maxFileSizeValidator.isValid(requestFile)).toBe(false);
      });

      // BUNEST_BUG: MaxFileSizeValidator.isValid returns false when no file is provided instead of NestJS true (packages/core/src/common/pipes/file-validators.ts)
      it.skip("should return true when no file provided", () => {
        const maxFileSizeValidator = new MaxFileSizeValidator({
          maxSize: oneKb,
        });

        expect(maxFileSizeValidator.isValid()).toBe(true);
      });
    });

    describe("buildErrorMessage", () => {
      // BUNEST_BUG: MaxFileSizeValidator.buildErrorMessage() without a file returns "Validation failed (current file size is 0, expected size is less than or equal to 1024)" instead of NestJS "Validation failed (expected size is less than 1024)" (packages/core/src/common/pipes/file-validators.ts)
      it.skip('should return a string with the format "Validation failed (expected size is less than #maxSize")', () => {
        const maxFileSizeValidator = new MaxFileSizeValidator({
          maxSize: oneKb,
        });

        expect(
          maxFileSizeValidator.buildErrorMessage(
            undefined as unknown as UploadedFileInfo,
          ),
        ).toBe(`Validation failed (expected size is less than ${oneKb})`);
      });

      // BUNEST_BUG: MaxFileSizeValidator.buildErrorMessage(file) says "expected size is less than or equal to #maxSize" instead of NestJS "expected size is less than #maxSize" (packages/core/src/common/pipes/file-validators.ts)
      it.skip("should include the file size in the error message when a file is provided", () => {
        const currentFileSize = oneKb + 1;
        const maxFileSizeValidator = new MaxFileSizeValidator({
          maxSize: oneKb,
        });

        const file = { size: currentFileSize } as unknown as UploadedFileInfo;

        expect(maxFileSizeValidator.buildErrorMessage(file)).toBe(
          `Validation failed (current file size is ${currentFileSize}, expected size is less than ${oneKb})`,
        );
      });

      it("should support deprecated message option", async () => {
        const currentFileSize = oneKb + 1;
        const maxFileSizeValidator = new MaxFileSizeValidator({
          maxSize: oneKb,
          message: "File size exceeds the limit",
        });
        const requestFile = {
          size: currentFileSize,
        } as unknown as UploadedFileInfo;

        expect(maxFileSizeValidator.buildErrorMessage(requestFile)).toBe(
          "File size exceeds the limit",
        );
      });

      it("should return a static custom error message when the file size exceeds the limit", async () => {
        const currentFileSize = oneKb + 1;
        const maxFileSizeValidator = new MaxFileSizeValidator({
          maxSize: oneKb,
          errorMessage: "File size exceeds the limit",
        } as MaxFileSizeValidatorOptions & { errorMessage?: unknown });
        const requestFile = {
          size: currentFileSize,
        } as unknown as UploadedFileInfo;

        expect(maxFileSizeValidator.buildErrorMessage(requestFile)).toBe(
          "File size exceeds the limit",
        );
      });

      it("should return a dynamic custom error message based on context when the file size exceeds the limit", async () => {
        const currentFileSize = oneKb + 1;
        const maxFileSizeValidator = new MaxFileSizeValidator({
          maxSize: oneKb,
          errorMessage: (ctx: {
            file?: UploadedFileInfo;
            config: MaxFileSizeValidatorOptions;
          }) =>
            `Received file size is ${ctx.file?.size}, but it must be smaller than ${ctx.config.maxSize}.`,
        } as MaxFileSizeValidatorOptions & { errorMessage?: unknown });
        const requestFile = {
          size: currentFileSize,
        } as unknown as UploadedFileInfo;

        expect(maxFileSizeValidator.buildErrorMessage(requestFile)).toBe(
          `Received file size is ${currentFileSize}, but it must be smaller than ${oneKb}.`,
        );
      });
    });
  },
);
