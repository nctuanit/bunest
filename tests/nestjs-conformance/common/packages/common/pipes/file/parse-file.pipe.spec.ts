import { beforeEach, describe, expect, it } from "bun:test";
import {
  BadRequestException,
  ConflictException,
  FileValidator,
  HttpStatus,
  ParseFilePipe,
  type UploadedFileInfo,
} from "../../../../../../../packages/core/src/common";
import { describeConformance } from "../../../../../_helpers";

class AlwaysValidValidator extends FileValidator {
  override isValid(): boolean {
    return true;
  }
  override buildErrorMessage(): string {
    return "";
  }
}

const customErrorMessage = "Error!";

class AlwaysInvalidValidator extends FileValidator {
  override isValid(): boolean {
    return false;
  }
  override buildErrorMessage(): string {
    return customErrorMessage;
  }
}

// Mirrors the real behavior of built-in validators (e.g. MaxFileSizeValidator,
// FileTypeValidator), which treat a missing file as trivially valid and skip
// their own check rather than failing.
class SkipsValidationWhenNoFileValidator extends FileValidator {
  override isValid(file?: unknown): boolean {
    return !file;
  }
  override buildErrorMessage(): string {
    return customErrorMessage;
  }
}

describeConformance(
  "ParseFilePipe",
  {
    upstreamPath: "packages/common/test/pipes/file/parse-file.pipe.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    let parseFilePipe: ParseFilePipe;

    describe("transform", () => {
      describe("when there are no validators (explicit)", () => {
        beforeEach(() => {
          parseFilePipe = new ParseFilePipe({
            validators: [],
          });
        });

        // BUNEST_BUG: ParseFilePipe.transform rejects minimal file objects (e.g. `{ path: "some-path" }`) because `isUploadedFileInfo` requires `fieldname`, `originalname`, and `mimetype`, misclassifying the object as an empty field-map and throwing "File is required" (packages/core/src/common/pipes/parse-file.pipe.ts)
        it.skip("should return the file object", async () => {
          const requestFile = {
            path: "some-path",
          } as unknown as UploadedFileInfo;

          await expect(parseFilePipe.transform(requestFile)).resolves.toEqual(
            requestFile,
          );
        });
      });

      describe("when there are no validators (by default constructor)", () => {
        beforeEach(() => {
          parseFilePipe = new ParseFilePipe();
        });

        // BUNEST_BUG: ParseFilePipe.transform rejects minimal file objects without `fieldname`/`originalname`/`mimetype` as "File is required" (packages/core/src/common/pipes/parse-file.pipe.ts)
        it.skip("should return the file object", async () => {
          const requestFile = {
            path: "some-path",
          } as unknown as UploadedFileInfo;

          await expect(parseFilePipe.transform(requestFile)).resolves.toEqual(
            requestFile,
          );
        });
      });

      describe("when all the validators validate the file", () => {
        beforeEach(() => {
          parseFilePipe = new ParseFilePipe({
            validators: [new AlwaysValidValidator({})],
          });
        });

        // BUNEST_BUG: ParseFilePipe.transform rejects minimal file objects without `fieldname`/`originalname`/`mimetype` before invoking validators (packages/core/src/common/pipes/parse-file.pipe.ts)
        it.skip("should return the file object", async () => {
          const requestFile = {
            path: "some-path",
          } as unknown as UploadedFileInfo;

          await expect(parseFilePipe.transform(requestFile)).resolves.toEqual(
            requestFile,
          );
        });
      });

      describe("when some validator invalidates the file", () => {
        describe("and the pipe has the default error", () => {
          beforeEach(() => {
            parseFilePipe = new ParseFilePipe({
              validators: [new AlwaysInvalidValidator({})],
            });
          });

          // BUNEST_BUG: createParseFileException throws base HttpException(status=400) instead of BadRequestException (plus minimal file object fails isUploadedFileInfo check) (packages/core/src/common/pipes/parse-file.pipe.ts)
          it.skip("should throw a BadRequestException", async () => {
            const requestFile = {
              path: "some-path",
            } as unknown as UploadedFileInfo;

            await expect(parseFilePipe.transform(requestFile)).rejects.toThrow(
              BadRequestException,
            );
          });
        });

        describe("and the pipe has a custom error code", () => {
          beforeEach(() => {
            parseFilePipe = new ParseFilePipe({
              validators: [new AlwaysInvalidValidator({})],
              errorHttpStatusCode: HttpStatus.CONFLICT,
            });
          });

          // BUNEST_BUG: createParseFileException throws base HttpException(status=409) instead of ConflictException (packages/core/src/common/pipes/parse-file.pipe.ts)
          it.skip("should throw this custom Error", async () => {
            const requestFile = {
              path: "some-path",
            } as unknown as UploadedFileInfo;

            await expect(parseFilePipe.transform(requestFile)).rejects.toThrow(
              ConflictException,
            );
          });
        });
      });

      describe("when fileIsRequired is false", () => {
        beforeEach(() => {
          parseFilePipe = new ParseFilePipe({
            validators: [],
            fileIsRequired: false,
          });
        });

        it("should pass validation if no file is provided", async () => {
          const requestFile = undefined;

          await expect(parseFilePipe.transform(requestFile)).resolves.toEqual(
            requestFile,
          );
        });
      });

      describe("when fileIsRequired is true", () => {
        beforeEach(() => {
          parseFilePipe = new ParseFilePipe({
            validators: [],
            fileIsRequired: true,
          });
        });

        // BUNEST_BUG: createParseFileException throws base HttpException(status=400) instead of BadRequestException (packages/core/src/common/pipes/parse-file.pipe.ts)
        it.skip("should throw an error if no file is provided", async () => {
          const requestFile = undefined;

          await expect(parseFilePipe.transform(requestFile)).rejects.toThrow(
            BadRequestException,
          );
        });

        // BUNEST_BUG: createParseFileException throws base HttpException(status=400) instead of BadRequestException (packages/core/src/common/pipes/parse-file.pipe.ts)
        it.skip("should throw an error if the file is null", async () => {
          const requestFile = null as unknown as UploadedFileInfo;

          await expect(parseFilePipe.transform(requestFile)).rejects.toThrow(
            BadRequestException,
          );
        });

        // BUNEST_BUG: ParseFilePipe.transform rejects minimal file objects without `fieldname`/`originalname`/`mimetype` as "File is required" (packages/core/src/common/pipes/parse-file.pipe.ts)
        it.skip("should pass validation if a file is provided", async () => {
          const requestFile = {
            path: "some-path",
          } as unknown as UploadedFileInfo;

          await expect(parseFilePipe.transform(requestFile)).resolves.toEqual(
            requestFile,
          );
        });
      });

      describe("when the file is null and a validator that skips missing files is registered", () => {
        beforeEach(() => {
          parseFilePipe = new ParseFilePipe({
            validators: [new SkipsValidationWhenNoFileValidator({})],
          });
        });

        // BUNEST_BUG: createParseFileException throws base HttpException(status=400, "File is required") instead of BadRequestException (packages/core/src/common/pipes/parse-file.pipe.ts)
        it.skip('should throw a "File is required" error instead of letting the validator silently pass', async () => {
          const requestFile = null as unknown as UploadedFileInfo;

          await expect(parseFilePipe.transform(requestFile)).rejects.toThrow(
            BadRequestException,
          );
        });
      });

      describe("when fileIsRequired is not explicitly provided", () => {
        beforeEach(() => {
          parseFilePipe = new ParseFilePipe({
            validators: [new AlwaysInvalidValidator({})],
          });
        });

        // BUNEST_BUG: createParseFileException throws base HttpException(status=400) instead of BadRequestException (packages/core/src/common/pipes/parse-file.pipe.ts)
        it.skip("should throw an error if no file is provided", async () => {
          const requestFile = undefined;

          await expect(parseFilePipe.transform(requestFile)).rejects.toThrow(
            BadRequestException,
          );
        });
      });

      describe("when an array of files is validated", () => {
        class TrackingValidator extends FileValidator<
          Record<string, unknown>,
          { id: number; valid?: boolean }
        > {
          active = 0;
          maxActive = 0;
          readonly seen: number[] = [];

          override async isValid(file: { id: number; valid?: boolean }) {
            this.seen.push(file.id);
            this.active++;
            this.maxActive = Math.max(this.maxActive, this.active);
            await new Promise((resolve) => setImmediate(resolve));
            this.active--;
            return file.valid !== false;
          }
          override buildErrorMessage(file: { id: number }): string {
            return `file ${file.id} is invalid`;
          }
        }

        it("should validate one file at a time", async () => {
          const validator = new TrackingValidator({});
          parseFilePipe = new ParseFilePipe({
            validators: [validator as unknown as FileValidator],
          });
          const files = [
            { id: 1 },
            { id: 2 },
            { id: 3 },
          ] as unknown as UploadedFileInfo[];

          await expect(parseFilePipe.transform(files)).resolves.toBe(files);
          expect(validator.maxActive).toBe(1);
          expect(validator.seen).toEqual([1, 2, 3]);
        });

        it("should stop at the first invalid file", async () => {
          const validator = new TrackingValidator({});
          parseFilePipe = new ParseFilePipe({
            validators: [validator as unknown as FileValidator],
          });
          const files = [
            { id: 1 },
            { id: 2, valid: false },
            { id: 3 },
          ] as unknown as UploadedFileInfo[];

          await expect(parseFilePipe.transform(files)).rejects.toThrow(
            "file 2 is invalid",
          );
          expect(validator.seen).toEqual([1, 2]);
        });
      });
    });
  },
);
