import { beforeEach, describe, expect, it } from "bun:test";
import {
  FileTypeValidator,
  FileValidator,
  MaxFileSizeValidator,
  ParseFilePipeBuilder,
} from "../../../../../../../packages/core/src/common";
import { describeConformance } from "../../../../../_helpers";

describeConformance(
  "ParseFilePipeBuilder",
  {
    upstreamPath:
      "packages/common/test/pipes/file/parse-file-pipe.builder.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    let parseFilePipeBuilder: ParseFilePipeBuilder;

    beforeEach(() => {
      parseFilePipeBuilder = new ParseFilePipeBuilder();
    });

    describe("build", () => {
      describe("when no validator was passed", () => {
        it("should return a ParseFilePipe with no validators", () => {
          const parseFilePipe = parseFilePipeBuilder.build();
          expect(parseFilePipe.getValidators()).toHaveLength(0);
        });
      });

      describe("when addMaxSizeValidator was chained", () => {
        it("should return a ParseFilePipe with MaxSizeValidator and given options", () => {
          const options = {
            maxSize: 1000,
          };
          const parseFilePipe = parseFilePipeBuilder
            .addMaxSizeValidator(options)
            .build();

          expect(parseFilePipe.getValidators()).toMatchObject([
            new MaxFileSizeValidator(options),
          ]);
        });
      });

      describe("when addFileTypeValidator was chained", () => {
        it("should return a ParseFilePipe with FileTypeValidator and given options", () => {
          const options = {
            fileType: "image/jpeg",
          };
          const parseFilePipe = parseFilePipeBuilder
            .addFileTypeValidator(options)
            .build();

          expect(parseFilePipe.getValidators()).toMatchObject([
            new FileTypeValidator(options),
          ]);
        });
      });

      describe("when custom validator was chained", () => {
        it("should return a ParseFilePipe with TestFileValidator and given options", () => {
          class TestFileValidator extends FileValidator<{ name: string }> {
            override buildErrorMessage(_file: unknown): string {
              return "TestFileValidator failed";
            }

            override isValid(_file: unknown): boolean | Promise<boolean> {
              return true;
            }
          }

          const options = {
            name: "test",
          };

          const parseFilePipe = parseFilePipeBuilder
            .addValidator(new TestFileValidator(options))
            .build();

          expect(parseFilePipe.getValidators()).toMatchObject([
            new TestFileValidator(options),
          ]);
        });
      });

      describe("when it is called twice with different validators", () => {
        it("should not reuse validators", () => {
          const maxSizeValidatorOptions = {
            maxSize: 1000,
          };

          const pipeWithMaxSizeValidator = parseFilePipeBuilder
            .addMaxSizeValidator(maxSizeValidatorOptions)
            .build();

          const fileTypeValidatorOptions = {
            fileType: "image/jpeg",
          };

          const pipeWithFileTypeValidator = parseFilePipeBuilder
            .addFileTypeValidator(fileTypeValidatorOptions)
            .build();

          expect(pipeWithFileTypeValidator.getValidators()).not.toEqual(
            pipeWithMaxSizeValidator.getValidators(),
          );
        });
      });
    });
  },
);
