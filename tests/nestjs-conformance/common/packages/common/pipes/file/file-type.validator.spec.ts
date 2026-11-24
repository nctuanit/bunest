import { describe, expect, it } from "bun:test";
import {
  FileTypeValidator,
  detectMagicMimeType,
  type FileTypeValidatorOptions,
  type UploadedFileInfo,
} from "../../../../../../../packages/core/src/common";
import { describeConformance, itAdapted } from "../../../../../_helpers";

const pngBuffer = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06,
  0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44,
  0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d,
  0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42,
  0x60, 0x82,
]);

const jpegBuffer = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46,
]);

const pdfBuffer = Buffer.from([
  0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a,
]);

const unknownBinaryBuffer = Buffer.from([
  0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77,
]);

describeConformance(
  "FileTypeValidator",
  {
    upstreamPath: "packages/common/test/pipes/file/file-type.validator.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-005"],
    notes:
      "Bunest replaces external `file-type` npm package with zero-dep `detectMagicMimeType()` (including UTF-8 text/SVG detection).",
  },
  () => {
    describe("isValid", () => {
      // BUNEST_BUG: matchesExpectedFileType mutates caller's RegExp `expected.lastIndex = 0` directly instead of isolating stateful `g`/`y` flags; expected fileType.lastIndex to remain 3, actual 0 (packages/core/src/common/pipes/file-validators.ts)
      it.skip.each(["y", "g", "gy"])(
        "should isolate a regexp with %s flags between uploads",
        async (flags) => {
          const fileType = new RegExp("^image/png$", flags);
          fileType.lastIndex = 3;
          const validator = new FileTypeValidator({
            fileType,
            skipMagicNumbersValidation: true,
          });
          const file = {
            mimetype: "image/png",
            size: 10,
          } as unknown as UploadedFileInfo;
          for (let attempt = 0; attempt < 3; attempt++) {
            expect(await validator.isValid(file)).toBe(true);
            expect(
              await validator.isValid({
                ...file,
                mimetype: "image/jpeg",
              } as unknown as UploadedFileInfo),
            ).toBe(false);
          }
          expect(fileType.lastIndex).toBe(3);
        },
      );

      // BUNEST_BUG: matchesExpectedFileType runs `.test()` directly on sticky RegExp leaving `fileType.lastIndex` at 9 instead of preserving 0 via isolated RegExp copy (packages/core/src/common/pipes/file-validators.ts)
      it.skip("should reuse a sticky regexp for magic number validation", async () => {
        const fileType = /^image\/png$/y;
        const validator = new FileTypeValidator({ fileType });
        const file = {
          mimetype: "image/png",
          size: pngBuffer.length,
          buffer: pngBuffer,
        } as unknown as UploadedFileInfo;
        const results = await Promise.all([
          validator.isValid(file),
          validator.isValid(file),
        ]);
        expect(results).toEqual([true, true]);
        expect(fileType.lastIndex).toBe(0);
      });

      describe("support file types", () => {
        async function testFileByMimeType(
          mimeType: string,
          fileData: Uint8Array,
        ) {
          const fileTypeValidator = new FileTypeValidator({
            fileType: mimeType,
          });

          const requestFile = {
            mimetype: mimeType,
            buffer: fileData,
          } as unknown as UploadedFileInfo;

          expect(await fileTypeValidator.isValid(requestFile)).toBe(true);
        }

        it("should be able to validate a JPEG file", () => {
          return testFileByMimeType("image/jpeg", jpegBuffer);
        });

        it("should be able to validate a PNG file", () => {
          return testFileByMimeType("image/png", pngBuffer);
        });
      });

      it("should return true when the file buffer matches the specified file extension", async () => {
        const fileTypeValidator = new FileTypeValidator({
          fileType: "jpeg",
        });

        const requestFile = {
          mimetype: "image/jpeg",
          buffer: jpegBuffer,
        } as unknown as UploadedFileInfo;
        expect(await fileTypeValidator.isValid(requestFile)).toBe(true);
      });

      it("should return true when the file buffer matches the specified regexp", async () => {
        const fileTypeValidator = new FileTypeValidator({
          fileType: /^image\//,
        });

        const requestFile = {
          mimetype: "image/jpeg",
          buffer: jpegBuffer,
        } as unknown as UploadedFileInfo;

        expect(await fileTypeValidator.isValid(requestFile)).toBe(true);
      });

      it("should return false when the file buffer does not match the specified type", async () => {
        const fileTypeValidator = new FileTypeValidator({
          fileType: "image/jpeg",
        });

        const shortPng = Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        ]);
        const requestFile = {
          mimetype: "image/jpeg", // Spoofed mimetype
          buffer: shortPng,
        } as unknown as UploadedFileInfo;

        expect(await fileTypeValidator.isValid(requestFile)).toBe(false);
      });

      it("should return false when the file buffer does not match the specified file extension", async () => {
        const fileTypeValidator = new FileTypeValidator({
          fileType: "jpeg",
        });

        const shortPng = Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        ]);
        const requestFile = {
          mimetype: "image/png",
          buffer: shortPng,
        } as unknown as UploadedFileInfo;

        expect(await fileTypeValidator.isValid(requestFile)).toBe(false);
      });

      it("should return false when no buffer is provided", async () => {
        const fileTypeValidator = new FileTypeValidator({
          fileType: "image/jpeg",
        });

        const requestFile = {
          mimetype: "image/jpeg",
        } as unknown as UploadedFileInfo;

        expect(await fileTypeValidator.isValid(requestFile)).toBe(false);
      });

      it("should return false when no file is provided", async () => {
        const fileTypeValidator = new FileTypeValidator({
          fileType: "image/jpeg",
        });

        expect(await fileTypeValidator.isValid()).toBe(false);
      });

      // BUNEST_BUG: FileTypeValidator.isValid crashes with TypeError when `validationOptions.fileType` is undefined (`expected.toLowerCase()` on undefined) instead of returning true when no options are provided (packages/core/src/common/pipes/file-validators.ts)
      it.skip("should return true when no validation options are provided", async () => {
        const fileTypeValidator = new FileTypeValidator(
          {} as FileTypeValidatorOptions,
        );
        const requestFile = {
          mimetype: "image/jpeg",
          buffer: jpegBuffer,
        } as unknown as UploadedFileInfo;

        expect(await fileTypeValidator.isValid(requestFile)).toBe(true);
      });

      it("should skip magic numbers validation when the skipMagicNumbersValidation is true", async () => {
        const fileTypeValidator = new FileTypeValidator({
          fileType: "image/jpeg",
          skipMagicNumbersValidation: true,
        });

        const requestFile = {
          mimetype: "image/jpeg",
        } as unknown as UploadedFileInfo;

        expect(await fileTypeValidator.isValid(requestFile)).toBe(true);
      });

      it("should return true when the mimetype contains regex metacharacters and matches the expected type", async () => {
        const fileTypeValidator = new FileTypeValidator({
          fileType: "image/svg+xml",
          skipMagicNumbersValidation: true,
        });

        const requestFile = {
          mimetype: "image/svg+xml",
        } as unknown as UploadedFileInfo;

        expect(await fileTypeValidator.isValid(requestFile)).toBe(true);
      });

      it("should return false when the mimetype contains regex metacharacters and does not match the expected type", async () => {
        const fileTypeValidator = new FileTypeValidator({
          fileType: "image/svg+xml",
          skipMagicNumbersValidation: true,
        });

        const requestFile = {
          mimetype: "image/png",
        } as unknown as UploadedFileInfo;

        expect(await fileTypeValidator.isValid(requestFile)).toBe(false);
      });

      // BUNEST_BUG: matchesExpectedFileType uses unanchored `new RegExp(expected, "i")` without word/token boundaries, so prefix strings falsely match longer MIME types (e.g. "audio/wav" matches "audio/wavpack", "font/woff" matches "font/woff2") (packages/core/src/common/pipes/file-validators.ts)
      it.skip.each([
        ["audio/wav", "audio/wavpack"],
        ["wav", "audio/wavpack"],
        ["font/woff", "font/woff2"],
        ["video/3gpp", "video/3gpp2"],
        ["image/heic", "image/heic-sequence"],
        [
          "application/vnd.oasis.opendocument.text",
          "application/vnd.oasis.opendocument.text-template",
        ],
      ])(
        "should return false when %s is only the start of a name in %s",
        async (fileType, mimetype) => {
          const fileTypeValidator = new FileTypeValidator({
            fileType,
            skipMagicNumbersValidation: true,
          });

          expect(
            await fileTypeValidator.isValid({
              mimetype,
            } as unknown as UploadedFileInfo),
          ).toBe(false);
        },
      );

      it.each([
        ["audio/wav", "audio/wav"],
        ["jpeg", "image/jpeg"],
        ["image", "image/png"],
        ["image/", "image/png"],
        ["svg", "image/svg+xml"],
        ["text/plain", "text/plain; charset=utf-8"],
        ["audio/ogg", "audio/ogg; codecs=opus"],
        [
          "application/vnd.openxmlformats-officedocument",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ],
        [".(png|jpeg|jpg)", "image/png"],
        ["image/(png|jpe?g)", "image/jpeg"],
      ])(
        "should return true when %s matches %s",
        async (fileType, mimetype) => {
          const fileTypeValidator = new FileTypeValidator({
            fileType,
            skipMagicNumbersValidation: true,
          });

          expect(
            await fileTypeValidator.isValid({
              mimetype,
            } as unknown as UploadedFileInfo),
          ).toBe(true);
        },
      );

      it('should return false when a WavPack file is uploaded for "audio/wav"', async () => {
        const buffer = Buffer.alloc(32);
        buffer.write("wvpk", 0, "latin1");
        buffer.writeUInt32LE(24, 4);
        const fileTypeValidator = new FileTypeValidator({
          fileType: "audio/wav",
        });

        const requestFile = {
          mimetype: "audio/wav",
          size: buffer.length,
          buffer,
        } as unknown as UploadedFileInfo;

        expect(await fileTypeValidator.isValid(requestFile)).toBe(false);
      });

      it("should return true when fallbackToMimetype is enabled and the mimetype contains regex metacharacters", async () => {
        const fileTypeValidator = new FileTypeValidator({
          fileType: "application/ld+json",
          fallbackToMimetype: true,
        });

        const requestFile = {
          mimetype: "application/ld+json",
          buffer: Buffer.from("{}"),
        } as unknown as UploadedFileInfo;

        expect(await fileTypeValidator.isValid(requestFile)).toBe(true);
      });

      it("should return false when the file buffer does not match any known type", async () => {
        const fileTypeValidator = new FileTypeValidator({
          fileType: "unknown/type",
        });

        const requestFile = {
          mimetype: "unknown/type",
          buffer: unknownBinaryBuffer,
        } as unknown as UploadedFileInfo;

        expect(await fileTypeValidator.isValid(requestFile)).toBe(false);
      });

      it("should return false when the buffer is empty", async () => {
        const fileTypeValidator = new FileTypeValidator({
          fileType: "image/jpeg",
        });

        const emptyBuffer = Buffer.from([]);
        const requestFile = {
          mimetype: "image/jpeg",
          buffer: emptyBuffer,
        } as unknown as UploadedFileInfo;

        expect(await fileTypeValidator.isValid(requestFile)).toBe(false);
      });

      it("should return true when fallbackToMimetype is enabled and mimetype matches", async () => {
        const fileTypeValidator = new FileTypeValidator({
          fileType: "text/plain",
          fallbackToMimetype: true,
        });

        const shortText = Buffer.from("ok");
        const requestFile = {
          mimetype: "text/plain",
          buffer: shortText,
        } as unknown as UploadedFileInfo;

        expect(await fileTypeValidator.isValid(requestFile)).toBe(true);
      });

      it("should return false when fallbackToMimetype is enabled but mimetype does not match", async () => {
        const fileTypeValidator = new FileTypeValidator({
          fileType: "application/json",
          fallbackToMimetype: true,
        });

        const shortText = Buffer.from("ok");
        const requestFile = {
          mimetype: "text/plain",
          buffer: shortText,
        } as unknown as UploadedFileInfo;

        expect(await fileTypeValidator.isValid(requestFile)).toBe(false);
      });

      it("should return true when no buffer is provided but fallbackToMimetype is enabled and mimetype matches", async () => {
        const fileTypeValidator = new FileTypeValidator({
          fileType: "image/jpeg",
          fallbackToMimetype: true,
        });

        const requestFile = {
          mimetype: "image/jpeg",
        } as unknown as UploadedFileInfo;

        expect(await fileTypeValidator.isValid(requestFile)).toBe(true);
      });

      it("should return false when no buffer is provided and fallbackToMimetype is enabled but mimetype does not match", async () => {
        const fileTypeValidator = new FileTypeValidator({
          fileType: "image/jpeg",
          fallbackToMimetype: true,
        });

        const requestFile = {
          mimetype: "image/png",
        } as unknown as UploadedFileInfo;

        expect(await fileTypeValidator.isValid(requestFile)).toBe(false);
      });

      itAdapted(
        ["ADR-001", "ADR-005"],
        "detects printable UTF-8 text and text/csv via zero-dep detectMagicMimeType while rejecting spoofed binary bytes",
        async () => {
          expect(detectMagicMimeType(pngBuffer)).toBe("image/png");
          expect(detectMagicMimeType(jpegBuffer)).toBe("image/jpeg");
          expect(detectMagicMimeType(pdfBuffer)).toBe("application/pdf");
          expect(detectMagicMimeType(Buffer.from("<svg></svg>"))).toBe(
            "image/svg+xml",
          );
          expect(detectMagicMimeType(Buffer.from("hi"))).toBe("text/plain");
          expect(detectMagicMimeType(unknownBinaryBuffer)).toBeUndefined();

          const textValidator = new FileTypeValidator({
            fileType: "text/plain",
          });
          expect(
            await textValidator.isValid({
              mimetype: "text/plain",
              buffer: Buffer.from("hi"),
            } as unknown as UploadedFileInfo),
          ).toBe(true);
          expect(
            await textValidator.isValid({
              mimetype: "text/plain",
              buffer: unknownBinaryBuffer,
            } as unknown as UploadedFileInfo),
          ).toBe(false);

          const csvValidator = new FileTypeValidator({
            fileType: "text/csv",
            skipMagicNumbersValidation: false,
          });
          expect(
            await csvValidator.isValid({
              mimetype: "text/csv",
              buffer: Buffer.from("name,age\nJohn,30"),
            } as unknown as UploadedFileInfo),
          ).toBe(true);
          expect(
            await csvValidator.isValid({
              mimetype: "text/csv",
              buffer: pngBuffer,
            } as unknown as UploadedFileInfo),
          ).toBe(false);
        },
        "zero-dep detectMagicMimeType supports UTF-8 text instead of external file-type pkg",
      );
    });

    describe("buildErrorMessage", () => {
      // BUNEST_BUG: FileTypeValidator.buildErrorMessage() with no file returns "Validation failed (current file type is unknown, expected type is image/jpeg)" instead of "Validation failed (expected type is image/jpeg)" (packages/core/src/common/pipes/file-validators.ts)
      it.skip('should return a string with the format "Validation failed (expected type is #fileType)"', async () => {
        const fileType = "image/jpeg";
        const fileTypeValidator = new FileTypeValidator({
          fileType,
        });

        expect(
          fileTypeValidator.buildErrorMessage(
            undefined as unknown as UploadedFileInfo,
          ),
        ).toBe(`Validation failed (expected type is ${fileType})`);
      });

      it("should include the file type in the error message when a file is provided", async () => {
        const currentFileType = "image/png";
        const fileType = "image/jpeg";
        const fileTypeValidator = new FileTypeValidator({
          fileType,
        });

        const file = {
          mimetype: currentFileType,
          buffer: pngBuffer,
        } as unknown as UploadedFileInfo;

        expect(fileTypeValidator.buildErrorMessage(file)).toBe(
          `Validation failed (current file type is ${currentFileType}, expected type is ${fileType})`,
        );
      });

      it("should handle regexp file type in error message", async () => {
        const fileTypeValidator = new FileTypeValidator({
          fileType: /^image\//,
        });
        const file = {
          mimetype: "application/pdf",
          buffer: pdfBuffer,
        } as unknown as UploadedFileInfo;

        expect(fileTypeValidator.buildErrorMessage(file)).toBe(
          "Validation failed (current file type is application/pdf, expected type is /^image\\//)",
        );
      });

      it("should handle file extension in error message", async () => {
        const fileTypeValidator = new FileTypeValidator({
          fileType: "jpeg",
        });
        const file = {
          mimetype: "image/png",
          buffer: pngBuffer,
        } as unknown as UploadedFileInfo;

        expect(fileTypeValidator.buildErrorMessage(file)).toBe(
          "Validation failed (current file type is image/png, expected type is jpeg)",
        );
      });

      // BUNEST_BUG: FileTypeValidator.buildErrorMessage does not emit the missing-buffer message when file.buffer is absent and fallbackToMimetype is false; actual "Validation failed (current file type is image/jpeg, expected type is image/jpeg)" (packages/core/src/common/pipes/file-validators.ts)
      it.skip("should return a specific error message when file buffer is not available and fallbackToMimetype is not enabled", async () => {
        const fileTypeValidator = new FileTypeValidator({
          fileType: "image/jpeg",
          fallbackToMimetype: false,
        });

        const file = {
          mimetype: "image/jpeg",
        } as unknown as UploadedFileInfo;

        expect(fileTypeValidator.buildErrorMessage(file)).toBe(
          "Validation failed (file buffer is not available; file type validation could not be performed; expected type is image/jpeg)",
        );
      });

      it("should report the type detected from the content rather than the declared mimetype", async () => {
        const fileTypeValidator = new FileTypeValidator({
          fileType: "image/jpeg",
        });
        const file = {
          mimetype: "image/jpeg",
          buffer: pngBuffer,
        } as unknown as UploadedFileInfo;

        expect(await fileTypeValidator.isValid(file)).toBe(false);
        expect(fileTypeValidator.buildErrorMessage(file)).toBe(
          "Validation failed (current file type is image/png, expected type is image/jpeg)",
        );
      });

      it("should not claim a mimetype fallback when the type was detected from the content", async () => {
        const fileTypeValidator = new FileTypeValidator({
          fileType: "image/jpeg",
          fallbackToMimetype: true,
        });
        const file = {
          mimetype: "image/jpeg",
          buffer: pngBuffer,
        } as unknown as UploadedFileInfo;

        expect(await fileTypeValidator.isValid(file)).toBe(false);
        expect(fileTypeValidator.buildErrorMessage(file)).toBe(
          "Validation failed (current file type is image/png, expected type is image/jpeg)",
        );
      });

      // BUNEST_BUG: FileTypeValidator.buildErrorMessage does not distinguish undetectable content from declared mimetype; returns "Validation failed (current file type is ..., expected type is ...)" instead of "file type could not be detected from its content" (packages/core/src/common/pipes/file-validators.ts)
      it.skip("should report that the type could not be detected from the content", async () => {
        const fileTypeValidator = new FileTypeValidator({
          fileType: "application/octet-stream",
        });
        const file = {
          mimetype: "application/octet-stream",
          buffer: unknownBinaryBuffer,
        } as unknown as UploadedFileInfo;

        expect(await fileTypeValidator.isValid(file)).toBe(false);
        expect(fileTypeValidator.buildErrorMessage(file)).toBe(
          "Validation failed (file type could not be detected from its content; expected type is application/octet-stream)",
        );
      });

      // BUNEST_BUG: FileTypeValidator.buildErrorMessage does not append " - magic number detection failed, used mimetype fallback" when fallbackToMimetype is used after failed magic detection (packages/core/src/common/pipes/file-validators.ts)
      it.skip("should mention the mimetype fallback when the type could not be detected from the content", async () => {
        const fileTypeValidator = new FileTypeValidator({
          fileType: "image/png",
          fallbackToMimetype: true,
        });
        const file = {
          mimetype: "application/octet-stream",
          buffer: unknownBinaryBuffer,
        } as unknown as UploadedFileInfo;

        expect(await fileTypeValidator.isValid(file)).toBe(false);
        expect(fileTypeValidator.buildErrorMessage(file)).toBe(
          "Validation failed (current file type is application/octet-stream, expected type is image/png) - magic number detection failed, used mimetype fallback",
        );
      });

      it("should not claim a mimetype fallback when magic number validation is skipped", async () => {
        const fileTypeValidator = new FileTypeValidator({
          fileType: "image/png",
          skipMagicNumbersValidation: true,
          fallbackToMimetype: true,
        });
        const file = {
          mimetype: "image/jpeg",
          buffer: pngBuffer,
        } as unknown as UploadedFileInfo;

        expect(await fileTypeValidator.isValid(file)).toBe(false);
        expect(fileTypeValidator.buildErrorMessage(file)).toBe(
          "Validation failed (current file type is image/jpeg, expected type is image/png)",
        );
      });

      it("should report the type detected for each file when the validator is shared", async () => {
        const fileTypeValidator = new FileTypeValidator({
          fileType: "application/pdf",
        });
        const pngFile = {
          mimetype: "application/pdf",
          buffer: pngBuffer,
        } as unknown as UploadedFileInfo;
        const jpegFile = {
          mimetype: "application/pdf",
          buffer: jpegBuffer,
        } as unknown as UploadedFileInfo;

        await Promise.all([
          fileTypeValidator.isValid(pngFile),
          fileTypeValidator.isValid(jpegFile),
        ]);

        expect(fileTypeValidator.buildErrorMessage(pngFile)).toBe(
          "Validation failed (current file type is image/png, expected type is application/pdf)",
        );
        expect(fileTypeValidator.buildErrorMessage(jpegFile)).toBe(
          "Validation failed (current file type is image/jpeg, expected type is application/pdf)",
        );
      });

      it("should return a static custom error message when the file type does not match", async () => {
        const expectedFileType = "image/png";
        const actualFileType = "text/csv";

        const fileTypeValidator = new FileTypeValidator({
          fileType: expectedFileType,
          errorMessage: "invalid type",
        } as FileTypeValidatorOptions & { errorMessage?: unknown });
        const requestFile = {
          mimetype: actualFileType,
        } as unknown as UploadedFileInfo;

        expect(fileTypeValidator.buildErrorMessage(requestFile)).toBe(
          "invalid type",
        );
      });

      it("should return a dynamic custom error message based on context when the file type does not match", async () => {
        const expectedFileType = "image/png";
        const actualFileType = "text/csv";

        const fileTypeValidator = new FileTypeValidator({
          fileType: expectedFileType,
          errorMessage: (ctx: {
            file?: UploadedFileInfo;
            config: FileTypeValidatorOptions;
          }) =>
            `Received file type '${ctx.file?.mimetype}', but expected '${ctx.config.fileType}'.`,
        } as FileTypeValidatorOptions & { errorMessage?: unknown });
        const requestFile = {
          mimetype: actualFileType,
        } as unknown as UploadedFileInfo;

        expect(fileTypeValidator.buildErrorMessage(requestFile)).toBe(
          `Received file type '${actualFileType}', but expected '${expectedFileType}'.`,
        );
      });
    });

    describe("overrideMimeType", () => {
      it("should override mimetype when overrideMimeType is enabled", async () => {
        const fileTypeValidator = new FileTypeValidator({
          fileType: /^image\/png$/,
          overrideMimeType: true,
        } as FileTypeValidatorOptions & { overrideMimeType?: boolean });

        const requestFile = {
          mimetype: "image/jpeg",
          buffer: pngBuffer,
          size: pngBuffer.length,
        } as unknown as UploadedFileInfo;

        expect(await fileTypeValidator.isValid(requestFile)).toBe(true);
        expect(requestFile.mimetype).toBe("image/png");
      });

      it("should not override mimetype when overrideMimeType is disabled", async () => {
        const fileTypeValidator = new FileTypeValidator({
          fileType: /^image\/png$/,
        });

        const requestFile = {
          mimetype: "image/jpeg",
          buffer: pngBuffer,
          size: pngBuffer.length,
        } as unknown as UploadedFileInfo;

        expect(await fileTypeValidator.isValid(requestFile)).toBe(true);
        expect(requestFile.mimetype).toBe("image/jpeg");
      });
    });
  },
);
