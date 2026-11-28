import type { UploadedFileInfo } from "../interfaces/http.interface";
import { escapeRegExp } from "../utils/string.util";
import { isFunction, isNumber, isRegExp, isString } from "../utils/type-guards.util";

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
    if (!this.validationOptions || !file) {
      return true;
    }
    if (
      !Number.isFinite(this.validationOptions.maxSize) ||
      this.validationOptions.maxSize < 0
    ) {
      return false;
    }
    const size = isNumber(file.size)
      ? file.size
      : (file.buffer?.byteLength ?? 0);
    return size < this.validationOptions.maxSize;
  }

  buildErrorMessage(file?: UploadedFileInfo): string {
    const { maxSize, message, errorMessage, ...restConfig } =
      this.validationOptions;
    if (errorMessage !== undefined) {
      return isFunction(errorMessage)
        ? errorMessage({ file, config: { maxSize, ...restConfig } })
        : errorMessage;
    }
    if (isFunction(message)) {
      return message(maxSize, file);
    }
    if (isString(message)) {
      return message;
    }
    if (file && (isNumber(file.size) || file.buffer !== undefined)) {
      const actualSize = isNumber(file.size) ? file.size : file.buffer!.byteLength;
      return `Validation failed (current file size is ${actualSize}, expected size is less than ${maxSize})`;
    }
    return `Validation failed (expected size is less than ${maxSize})`;
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

  // BMP: 42 4D ("BM"), >= 14-byte BITMAPFILEHEADER with reserved bytes [6..9] == 0x00,
  // and (when DIB header is present) a standard DIB header size in {12, 40, 52, 56, 64, 108, 124}.
  if (
    len >= 14 &&
    bytes[0] === 0x42 &&
    bytes[1] === 0x4d &&
    bytes[6] === 0x00 &&
    bytes[7] === 0x00 &&
    bytes[8] === 0x00 &&
    bytes[9] === 0x00
  ) {
    if (len < 18) {
      return "image/bmp";
    }
    const dibSize =
      bytes[14]! |
      (bytes[15]! << 8) |
      (bytes[16]! << 16) |
      ((bytes[17]! << 24) >>> 0);
    if (
      dibSize === 12 ||
      dibSize === 40 ||
      dibSize === 52 ||
      dibSize === 56 ||
      dibSize === 64 ||
      dibSize === 108 ||
      dibSize === 124
    ) {
      return "image/bmp";
    }
  }

  // TIFF: 49 49 2A 00 (little-endian) or 4D 4D 00 2A (big-endian)
  if (
    len >= 4 &&
    ((bytes[0] === 0x49 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x2a &&
      bytes[3] === 0x00) ||
      (bytes[0] === 0x4d &&
        bytes[1] === 0x4d &&
        bytes[2] === 0x00 &&
        bytes[3] === 0x2a))
  ) {
    return "image/tiff";
  }

  // ISO BMFF container: ....ftyp (AVIF / HEIC / MP4)
  if (
    len >= 12 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  ) {
    const brand = String.fromCharCode(
      bytes[8]!,
      bytes[9]!,
      bytes[10]!,
      bytes[11]!,
    );
    if (brand === "avif" || brand === "avis") {
      return "image/avif";
    }
    if (
      brand === "heic" ||
      brand === "heix" ||
      brand === "hevc" ||
      brand === "hevx" ||
      brand === "mif1" ||
      brand === "msf1"
    ) {
      return "image/heic";
    }
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
  if (isRegExp(expected)) {
    return new RegExp(expected.source, expected.flags).test(normalized);
  }
  if (normalized.toLowerCase() === expected.toLowerCase()) {
    return true;
  }
  try {
    if (!/[()|[\]*?^$\\]/.test(expected)) {
      const prefix = expected.startsWith("/") ? "" : "(?:^|[/.+])";
      const suffix = expected.endsWith("/") ? "" : "(?:$|[/.+])";
      return new RegExp(
        `${prefix}${escapeRegExp(expected)}${suffix}`,
        "i",
      ).test(normalized);
    }
    return new RegExp(expected, "i").test(normalized);
  } catch {
    return false;
  }
}

interface FileTypeDetectionState {
  detected?: string;
  undetectable?: boolean;
  usedFallback?: boolean;
  missingBuffer?: boolean;
}

/**
 * Validates an uploaded file's MIME type using zero-dep magic-byte sniffing
 * by default so spoofed `Content-Type` headers are rejected.
 */
export class FileTypeValidator extends FileValidator<
  FileTypeValidatorOptions,
  UploadedFileInfo
> {
  private readonly detectionState = new WeakMap<
    UploadedFileInfo,
    FileTypeDetectionState
  >();

  async isValid(file?: UploadedFileInfo): Promise<boolean> {
    if (!this.validationOptions || this.validationOptions.fileType === undefined) {
      return true;
    }
    if (!file) {
      return false;
    }
    this.detectionState.delete(file);

    const {
      fileType,
      skipMagicNumbersValidation,
      fallbackToMimetype,
      overrideMimeType,
    } = this.validationOptions;

    if (skipMagicNumbersValidation) {
      if (file.mimetype) {
        this.detectionState.set(file, { detected: file.mimetype });
      }
      return Boolean(
        file.mimetype && matchesExpectedFileType(file.mimetype, fileType),
      );
    }

    let bytes = file.buffer;
    if ((!bytes || bytes.byteLength === 0) && file.file) {
      bytes =
        typeof file.file.bytes === "function"
          ? await file.file.bytes()
          : new Uint8Array(await file.file.arrayBuffer());
    }

    if (!bytes || bytes.byteLength === 0) {
      if (fallbackToMimetype && file.mimetype) {
        this.detectionState.set(file, {
          detected: file.mimetype,
          usedFallback: true,
        });
        return matchesExpectedFileType(file.mimetype, fileType);
      }
      this.detectionState.set(file, { missingBuffer: true });
      return false;
    }

    const originalMimetype = file.mimetype;
    const detected = detectMagicMimeType(bytes);
    if (detected === "text/plain") {
      this.detectionState.set(file, { detected });
      if (
        originalMimetype &&
        isTextBasedMimeType(originalMimetype) &&
        matchesExpectedFileType(originalMimetype, fileType)
      ) {
        this.detectionState.set(file, { detected: originalMimetype });
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
      this.detectionState.set(file, { detected });
      const matched = matchesExpectedFileType(detected, fileType);
      if (matched && overrideMimeType) {
        (file as { mimetype: string }).mimetype = detected;
      }
      return matched;
    }

    if (fallbackToMimetype && file.mimetype) {
      this.detectionState.set(file, {
        detected: file.mimetype,
        usedFallback: true,
      });
      return matchesExpectedFileType(file.mimetype, fileType);
    }

    this.detectionState.set(file, { undetectable: true });
    return false;
  }

  buildErrorMessage(file: UploadedFileInfo): string {
    const { errorMessage, ...config } = this.validationOptions;
    if (errorMessage !== undefined) {
      return isFunction(errorMessage)
        ? errorMessage({ file, config })
        : errorMessage;
    }
    const expected = isRegExp(this.validationOptions.fileType)
      ? this.validationOptions.fileType.toString()
      : this.validationOptions.fileType;

    if (!file) {
      return `Validation failed (expected type is ${expected})`;
    }

    const state = this.detectionState.get(file);

    if (
      state?.missingBuffer ||
      (!state &&
        !this.validationOptions.skipMagicNumbersValidation &&
        !this.validationOptions.fallbackToMimetype &&
        (!file.buffer || file.buffer.byteLength === 0) &&
        !file.file)
    ) {
      return `Validation failed (file buffer is not available; file type validation could not be performed; expected type is ${expected})`;
    }

    if (state?.undetectable) {
      return `Validation failed (file type could not be detected from its content; expected type is ${expected})`;
    }

    const actual = state?.detected ?? file.mimetype ?? "unknown";
    const base = `Validation failed (current file type is ${actual}, expected type is ${expected})`;
    if (state?.usedFallback) {
      return `${base} - magic number detection failed, used mimetype fallback`;
    }
    return base;
  }
}

export type SupportedBunImageFormat =
  | "jpeg"
  | "png"
  | "webp"
  | "gif"
  | "bmp"
  | "tiff"
  | "heic"
  | "avif";

export interface ImageDimensionsValidatorOptions {
  /** Minimum image width in pixels (inclusive). */
  readonly minWidth?: number;
  /** Maximum image width in pixels (inclusive). */
  readonly maxWidth?: number;
  /** Minimum image height in pixels (inclusive). */
  readonly minHeight?: number;
  /** Maximum image height in pixels (inclusive). */
  readonly maxHeight?: number;
  /** Allowed decoded image formats (e.g. `["png", "jpeg", "webp", "avif"]`). */
  readonly formats?: readonly SupportedBunImageFormat[];
  /**
   * Required aspect ratio (`width / height`). A number enforces exact ratio
   * within `tolerance` (default `0.01`); an object constrains `[min, max]`.
   */
  readonly aspectRatio?:
    | number
    | {
        readonly min?: number;
        readonly max?: number;
        readonly tolerance?: number;
      };
  /** Custom error message or factory receiving `{ file, config }`. */
  readonly errorMessage?:
    | string
    | ((ctx: FileValidatorContext<ImageDimensionsValidatorOptions>) => string);
}

interface BunImageLike {
  metadata(): Promise<{
    readonly width: number;
    readonly height: number;
    readonly format: string;
  }>;
}

type BunImageCtor = new (
  input: Uint8Array | ArrayBuffer | Blob,
) => BunImageLike;

/**
 * Validates uploaded image dimensions, aspect ratio, and decoded format natively
 * using Bun 1.4.5's built-in `Bun.Image` (zero external dependencies).
 */
export class ImageDimensionsValidator extends FileValidator<
  ImageDimensionsValidatorOptions,
  UploadedFileInfo
> {
  private readonly failureReasons = new WeakMap<UploadedFileInfo, string>();

  async isValid(file?: UploadedFileInfo): Promise<boolean> {
    if (!this.validationOptions) {
      return true;
    }
    if (!file) {
      return false;
    }
    this.failureReasons.delete(file);

    let bytes = file.buffer;
    if ((!bytes || bytes.byteLength === 0) && file.file) {
      bytes =
        typeof file.file.bytes === "function"
          ? await file.file.bytes()
          : new Uint8Array(await file.file.arrayBuffer());
    }
    if (!bytes || bytes.byteLength === 0) {
      this.failureReasons.set(file, "image buffer is empty or unavailable");
      return false;
    }

    const ImageCtor =
      typeof Bun !== "undefined"
        ? (Bun as unknown as { Image?: BunImageCtor }).Image
        : undefined;
    if (typeof ImageCtor !== "function") {
      this.failureReasons.set(
        file,
        "Bun.Image is unavailable in the current runtime",
      );
      return false;
    }

    let meta: { readonly width: number; readonly height: number; readonly format: string };
    try {
      meta = await new ImageCtor(bytes).metadata();
    } catch {
      this.failureReasons.set(file, "file is not a valid supported image");
      return false;
    }

    const { width, height, format } = meta;
    const normalizedFormat = format.toLowerCase();
    const { minWidth, maxWidth, minHeight, maxHeight, formats, aspectRatio } =
      this.validationOptions;

    if (
      formats &&
      formats.length > 0 &&
      !formats.some((f) => f.toLowerCase() === normalizedFormat)
    ) {
      this.failureReasons.set(
        file,
        `image format "${normalizedFormat}" is not in allowed formats [${formats.join(", ")}]`,
      );
      return false;
    }
    if (minWidth !== undefined && width < minWidth) {
      this.failureReasons.set(
        file,
        `image width ${width}px is less than minimum ${minWidth}px`,
      );
      return false;
    }
    if (maxWidth !== undefined && width > maxWidth) {
      this.failureReasons.set(
        file,
        `image width ${width}px exceeds maximum ${maxWidth}px`,
      );
      return false;
    }
    if (minHeight !== undefined && height < minHeight) {
      this.failureReasons.set(
        file,
        `image height ${height}px is less than minimum ${minHeight}px`,
      );
      return false;
    }
    if (maxHeight !== undefined && height > maxHeight) {
      this.failureReasons.set(
        file,
        `image height ${height}px exceeds maximum ${maxHeight}px`,
      );
      return false;
    }
    if (aspectRatio !== undefined && height > 0) {
      const actualRatio = width / height;
      if (typeof aspectRatio === "number") {
        if (Math.abs(actualRatio - aspectRatio) > 0.01) {
          this.failureReasons.set(
            file,
            `image aspect ratio ${actualRatio.toFixed(3)} does not match expected ${aspectRatio}`,
          );
          return false;
        }
      } else {
        const tol = aspectRatio.tolerance ?? 0;
        if (
          aspectRatio.min !== undefined &&
          actualRatio < aspectRatio.min - tol
        ) {
          this.failureReasons.set(
            file,
            `image aspect ratio ${actualRatio.toFixed(3)} is below minimum ${aspectRatio.min}`,
          );
          return false;
        }
        if (
          aspectRatio.max !== undefined &&
          actualRatio > aspectRatio.max + tol
        ) {
          this.failureReasons.set(
            file,
            `image aspect ratio ${actualRatio.toFixed(3)} exceeds maximum ${aspectRatio.max}`,
          );
          return false;
        }
      }
    }

    return true;
  }

  buildErrorMessage(file: UploadedFileInfo): string {
    const { errorMessage, ...config } = this.validationOptions;
    if (errorMessage !== undefined) {
      return isFunction(errorMessage)
        ? errorMessage({ file, config })
        : errorMessage;
    }
    const reason = file ? this.failureReasons.get(file) : undefined;
    return reason
      ? `Validation failed (${reason})`
      : "Validation failed (invalid image dimensions)";
  }
}
