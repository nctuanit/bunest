import type { UploadedFileInfo } from "../interfaces/http.interface";

/**
 * Abstract base class for uploaded file validators used by `ParseFilePipe`.
 */
export abstract class FileValidator<
  TOptions extends object = Record<string, unknown>,
  TFile = UploadedFileInfo,
> {
  constructor(protected readonly validationOptions: TOptions) {}

  abstract isValid(file?: TFile): boolean | Promise<boolean>;

  abstract buildErrorMessage(file: TFile): string;
}

export interface FileValidatorContext<TConfig> {
  file?: UploadedFileInfo;
  config: TConfig;
}

export type MaxFileSizeValidatorContext = FileValidatorContext<
  Omit<MaxFileSizeValidatorOptions, "errorMessage" | "message">
>;

export interface MaxFileSizeValidatorOptions {
  /**
   * Maximum permitted file size in bytes (inclusive).
   */
  maxSize: number;
  /**
   * @deprecated Use `errorMessage` instead.
   */
  message?: string | ((maxSize: number, file?: UploadedFileInfo) => string);
  /**
   * Custom error message string or factory receiving `{ file, config }` (NestJS v12 parity).
   */
  errorMessage?: string | ((ctx: MaxFileSizeValidatorContext) => string);
}

/**
 * Validates that an uploaded file does not exceed `maxSize` bytes.
 */
export class MaxFileSizeValidator extends FileValidator<
  MaxFileSizeValidatorOptions,
  UploadedFileInfo
> {
  isValid(file?: UploadedFileInfo): boolean {
    if (!file || !Number.isFinite(this.validationOptions.maxSize)) {
      return false;
    }
    if (this.validationOptions.maxSize < 0) {
      return false;
    }
    const size =
      typeof file.size === "number"
        ? file.size
        : (file.buffer?.byteLength ?? 0);
    return size <= this.validationOptions.maxSize;
  }

  buildErrorMessage(file: UploadedFileInfo): string {
    const { maxSize, message, errorMessage, ...restConfig } =
      this.validationOptions;
    if (errorMessage !== undefined) {
      return typeof errorMessage === "function"
        ? errorMessage({ file, config: { maxSize, ...restConfig } })
        : errorMessage;
    }
    if (typeof message === "function") {
      return message(maxSize, file);
    }
    if (typeof message === "string") {
      return message;
    }
    const actualSize =
      typeof file?.size === "number"
        ? file.size
        : (file?.buffer?.byteLength ?? 0);
    return `Validation failed (current file size is ${actualSize}, expected size is less than or equal to ${maxSize})`;
  }
}

export type FileTypeValidatorContext = FileValidatorContext<
  Omit<FileTypeValidatorOptions, "errorMessage">
>;

export interface FileTypeValidatorOptions {
  /**
   * Expected MIME type string (exact or regex pattern) or `RegExp`.
   */
  fileType: string | RegExp;
  /**
   * Custom error message string or factory receiving `{ file, config }` (NestJS v12 parity).
   */
  errorMessage?: string | ((ctx: FileTypeValidatorContext) => string);
  /**
   * When `true`, skips magic-byte inspection and validates only `file.mimetype`.
   * Defaults to `false` (magic-byte verification enabled to defeat spoofed MIME types).
   */
  skipMagicNumbersValidation?: boolean;
  /**
   * When `true`, falls back to `file.mimetype` if magic bytes cannot identify a known format.
   * Defaults to `false`.
   */
  fallbackToMimetype?: boolean;
  /**
   * When `true`, replaces `file.mimetype` with the MIME type detected from magic bytes
   * (NestJS v12 parity).
   * @default false
   */
  overrideMimeType?: boolean;
}

const utf8FatalDecoder = new TextDecoder("utf-8", { fatal: true });

function isPrintableUtf8Text(bytes: Uint8Array): string | undefined {
  if (bytes.byteLength === 0) {
    return undefined;
  }
  const sampleLen = Math.min(bytes.byteLength, 4096);
  const sample = bytes.subarray(0, sampleLen);

  for (let i = 0; i < sampleLen; i++) {
    const b = sample[i]!;
    // Reject NUL bytes and non-whitespace ASCII control chars
    if (
      b === 0x00 ||
      (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0c && b !== 0x0d)
    ) {
      return undefined;
    }
  }

  try {
    return utf8FatalDecoder.decode(sample);
  } catch {
    return undefined;
  }
}

/**
 * Zero-dependency magic-byte MIME detector supporting PNG, JPEG, GIF, WEBP,
 * PDF, ZIP, GZIP, MP4, MP3, WAV, SVG, and plain UTF-8 text.
 */
export function detectMagicMimeType(bytes: Uint8Array): string | undefined {
  const len = bytes.byteLength;
  if (len === 0) {
    return undefined;
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    len >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }

  // JPEG: FF D8 FF
  if (len >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }

  // GIF87a / GIF89a: 47 49 46 38 (37|39) 61
  if (
    len >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return "image/gif";
  }

  // RIFF container: WEBP / WAV
  if (
    len >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46
  ) {
    if (
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50
    ) {
      return "image/webp";
    }
    if (
      bytes[8] === 0x57 &&
      bytes[9] === 0x41 &&
      bytes[10] === 0x56 &&
      bytes[11] === 0x45
    ) {
      return "audio/wav";
    }
  }

  // PDF: %PDF-
  if (
    len >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  ) {
    return "application/pdf";
  }

  // ZIP: PK\x03\x04 | PK\x05\x06 | PK\x07\x08
  if (
    len >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    ((bytes[2] === 0x03 && bytes[3] === 0x04) ||
      (bytes[2] === 0x05 && bytes[3] === 0x06) ||
      (bytes[2] === 0x07 && bytes[3] === 0x08))
  ) {
    return "application/zip";
  }

  // GZIP: 1F 8B
  if (len >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return "application/gzip";
  }

  // MP4 / ISO BMFF: ....ftyp
  if (
    len >= 12 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  ) {
    return "video/mp4";
  }

  // MP3: ID3 tag or MPEG audio frame sync
  if (
    (len >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) ||
    (len >= 2 &&
      bytes[0] === 0xff &&
      (bytes[1] === 0xfb || bytes[1] === 0xf3 || bytes[1] === 0xf2))
  ) {
    return "audio/mpeg";
  }

  // SVG or UTF-8 text
  const text = isPrintableUtf8Text(bytes);
  if (text !== undefined) {
    const trimmed = text
      .replace(/^\uFEFF/, "")
      .trimStart()
      .toLowerCase();
    if (
      /^<svg(?:\s|>|\/)/.test(trimmed) ||
      (trimmed.startsWith("<?xml") && /<svg(?:\s|>|\/)/.test(trimmed))
    ) {
      return "image/svg+xml";
    }
    return "text/plain";
  }

  return undefined;
}

function isTextBasedMimeType(mimetype: string): boolean {
  const lower = mimetype.toLowerCase().split(";")[0]?.trim() ?? "";
  return (
    lower.startsWith("text/") ||
    lower === "application/json" ||
    lower === "application/xml" ||
    lower === "application/javascript" ||
    lower === "application/ecmascript" ||
    lower === "application/csv" ||
    lower.endsWith("+json") ||
    lower.endsWith("+xml")
  );
}

function matchesExpectedFileType(
  actualMime: string,
  expected: string | RegExp,
): boolean {
  const normalized = actualMime.split(";")[0]?.trim() ?? "";
  if (!normalized) {
    return false;
  }
  if (expected instanceof RegExp) {
    expected.lastIndex = 0;
    return expected.test(normalized);
  }
  if (normalized.toLowerCase() === expected.toLowerCase()) {
    return true;
  }
  try {
    return new RegExp(expected, "i").test(normalized);
  } catch {
    return false;
  }
}

/**
 * Validates an uploaded file's MIME type using zero-dep magic-byte sniffing
 * by default so spoofed `Content-Type` headers are rejected.
 */
export class FileTypeValidator extends FileValidator<
  FileTypeValidatorOptions,
  UploadedFileInfo
> {
  private readonly detectedTypes = new WeakMap<UploadedFileInfo, string>();

  async isValid(file?: UploadedFileInfo): Promise<boolean> {
    if (!file) {
      return false;
    }
    this.detectedTypes.delete(file);

    const {
      fileType,
      skipMagicNumbersValidation,
      fallbackToMimetype,
      overrideMimeType,
    } = this.validationOptions;

    if (skipMagicNumbersValidation) {
      if (file.mimetype) {
        this.detectedTypes.set(file, file.mimetype);
      }
      return Boolean(
        file.mimetype && matchesExpectedFileType(file.mimetype, fileType),
      );
    }

    let bytes = file.buffer;
    if ((!bytes || bytes.byteLength === 0) && file.file) {
      bytes = new Uint8Array(await file.file.arrayBuffer());
    }

    if (!bytes || bytes.byteLength === 0) {
      if (fallbackToMimetype && file.mimetype) {
        this.detectedTypes.set(file, file.mimetype);
        return matchesExpectedFileType(file.mimetype, fileType);
      }
      return false;
    }

    const originalMimetype = file.mimetype;
    const detected = detectMagicMimeType(bytes);
    if (detected === "text/plain") {
      this.detectedTypes.set(file, detected);
      if (
        originalMimetype &&
        isTextBasedMimeType(originalMimetype) &&
        matchesExpectedFileType(originalMimetype, fileType)
      ) {
        this.detectedTypes.set(file, originalMimetype);
        return true;
      }
      if (matchesExpectedFileType("text/plain", fileType)) {
        if (overrideMimeType) {
          (file as { mimetype: string }).mimetype = "text/plain";
        }
        return true;
      }
      return false;
    }

    if (detected !== undefined) {
      this.detectedTypes.set(file, detected);
      const matched = matchesExpectedFileType(detected, fileType);
      if (matched && overrideMimeType) {
        (file as { mimetype: string }).mimetype = detected;
      }
      return matched;
    }

    if (fallbackToMimetype && file.mimetype) {
      this.detectedTypes.set(file, file.mimetype);
      return matchesExpectedFileType(file.mimetype, fileType);
    }

    return false;
  }

  buildErrorMessage(file: UploadedFileInfo): string {
    const { errorMessage, ...config } = this.validationOptions;
    if (errorMessage !== undefined) {
      return typeof errorMessage === "function"
        ? errorMessage({ file, config })
        : errorMessage;
    }
    const actual =
      (file ? this.detectedTypes.get(file) : undefined) ??
      file?.mimetype ??
      "unknown";
    const expected =
      this.validationOptions.fileType instanceof RegExp
        ? this.validationOptions.fileType.toString()
        : this.validationOptions.fileType;
    return `Validation failed (current file type is ${actual}, expected type is ${expected})`;
  }
}
