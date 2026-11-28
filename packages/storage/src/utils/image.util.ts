import { StorageError } from "../errors";

export type StorageImageFormat =
  | "webp"
  | "avif"
  | "jpeg"
  | "png"
  | "heic";

export interface ImageMetadataInfo {
  readonly width: number;
  readonly height: number;
  readonly format: string;
}

export type StorageImageFit = "fill" | "inside";

export interface ImageTransformOptions {
  /** Target width in pixels (when omitted with `height`, computed from the source aspect ratio). */
  readonly width?: number;
  /** Target height in pixels. */
  readonly height?: number;
  /** Resize fit strategy supported by `Bun.Image.resize()` (`"fill"` or `"inside"`). */
  readonly fit?: StorageImageFit;
  /** Optional clockwise rotation angle in degrees (multiples of 90: `90`, `180`, `270`). */
  readonly rotate?: number;
  /** Flip vertically. */
  readonly flip?: boolean;
  /** Flop horizontally. */
  readonly flop?: boolean;
  /** Output image format (`"webp"`, `"avif"`, `"jpeg"`, `"png"`, `"heic"`). */
  readonly format?: StorageImageFormat;
  /** Output encoder quality (`1`–`100`) where supported by the chosen format. */
  readonly quality?: number;
}

export interface ImageTransformResult {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly width: number;
  readonly height: number;
  readonly format: string;
}

interface BunImageInstance {
  readonly width: number;
  readonly height: number;
  metadata(): Promise<ImageMetadataInfo>;
  resize(
    width: number,
    height?: number,
    options?: { fit?: StorageImageFit },
  ): BunImageInstance;
  rotate(angle: number): BunImageInstance;
  flip(): BunImageInstance;
  flop(): BunImageInstance;
  webp(options?: { quality?: number }): BunImageInstance;
  avif(options?: { quality?: number }): BunImageInstance;
  jpeg(options?: { quality?: number }): BunImageInstance;
  png(): BunImageInstance;
  heic(options?: { quality?: number }): BunImageInstance;
  bytes(): Promise<Uint8Array>;
}

type BunImageCtor = new (
  input: Uint8Array | ArrayBuffer | Blob,
) => BunImageInstance;

const FORMAT_MIME: Readonly<Record<string, string>> = {
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  avif: "image/avif",
  heic: "image/heic",
  gif: "image/gif",
  bmp: "image/bmp",
  tiff: "image/tiff",
};

function getBunImageCtor(): BunImageCtor {
  const ctor = (Bun as unknown as { Image?: BunImageCtor }).Image;
  if (typeof ctor !== "function") {
    throw new StorageError(
      "Bun.Image is unavailable in the current runtime (requires Bun >= 1.4.5).",
    );
  }
  return ctor;
}

function assertNonEmptyImageInput(
  input: Uint8Array | ArrayBuffer | Blob,
): void {
  const size =
    input instanceof Blob
      ? input.size
      : input instanceof Uint8Array || input instanceof ArrayBuffer
        ? input.byteLength
        : 0;
  if (size <= 0) {
    throw new StorageError("Image input buffer is empty.");
  }
}

/**
 * Inspects image dimensions and decoded format natively via `Bun.Image` (zero external deps).
 */
export async function inspectImage(
  input: Uint8Array | ArrayBuffer | Blob,
): Promise<ImageMetadataInfo> {
  assertNonEmptyImageInput(input);
  const ImageCtor = getBunImageCtor();
  try {
    return await new ImageCtor(input).metadata();
  } catch (err) {
    if (err instanceof StorageError) throw err;
    throw new StorageError(
      `Failed to inspect image: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

/**
 * Resizes, rotates, flips, and/or transcodes an image (WebP/AVIF/JPEG/PNG/HEIC)
 * natively using Bun 1.4.5's built-in `Bun.Image` (zero `sharp` dependency).
 */
export async function transformImage(
  input: Uint8Array | ArrayBuffer | Blob,
  options: ImageTransformOptions = {},
): Promise<ImageTransformResult> {
  assertNonEmptyImageInput(input);

  if (
    options.width !== undefined &&
    (!Number.isInteger(options.width) || options.width <= 0)
  ) {
    throw new StorageError(
      `Image resize width must be a positive integer (received ${String(options.width)}).`,
    );
  }
  if (
    options.height !== undefined &&
    (!Number.isInteger(options.height) || options.height <= 0)
  ) {
    throw new StorageError(
      `Image resize height must be a positive integer (received ${String(options.height)}).`,
    );
  }
  if (
    options.fit !== undefined &&
    options.fit !== "fill" &&
    options.fit !== "inside"
  ) {
    throw new StorageError(
      `Invalid image fit mode "${String(options.fit)}": expected "fill" or "inside".`,
    );
  }
  if (
    options.rotate !== undefined &&
    (!Number.isFinite(options.rotate) || options.rotate % 90 !== 0)
  ) {
    throw new StorageError(
      `Image rotation angle must be a multiple of 90 degrees (received ${String(options.rotate)}).`,
    );
  }

  const ImageCtor = getBunImageCtor();
  try {
    let img = new ImageCtor(input);

    if (options.width !== undefined || options.height !== undefined) {
      let targetWidth = options.width;
      if (targetWidth === undefined && options.height !== undefined) {
        // Bun.Image.resize(0, height) clamps width to 1px; compute aspect-ratio width explicitly.
        const srcMeta = await img.metadata();
        const srcHeight = srcMeta.height > 0 ? srcMeta.height : 1;
        const srcWidth = srcMeta.width > 0 ? srcMeta.width : 1;
        targetWidth = Math.max(
          1,
          Math.round((srcWidth * options.height) / srcHeight),
        );
      }
      img =
        options.fit !== undefined
          ? img.resize(targetWidth!, options.height, { fit: options.fit })
          : img.resize(targetWidth!, options.height);
    }
    if (options.rotate !== undefined && options.rotate !== 0) {
      img = img.rotate(options.rotate);
    }
    if (options.flip) {
      img = img.flip();
    }
    if (options.flop) {
      img = img.flop();
    }

    const qualityOpt =
      options.quality !== undefined ? { quality: options.quality } : undefined;
    switch (options.format) {
      case "webp":
        img = img.webp(qualityOpt);
        break;
      case "avif":
        img = img.avif(qualityOpt);
        break;
      case "jpeg":
        img = img.jpeg(qualityOpt);
        break;
      case "png":
        img = img.png();
        break;
      case "heic":
        img = img.heic(qualityOpt);
        break;
    }

    const outBytes = await img.bytes();
    const meta = await new ImageCtor(outBytes).metadata();
    const format = meta.format.toLowerCase();

    return {
      bytes: outBytes,
      contentType: FORMAT_MIME[format] ?? "application/octet-stream",
      width: meta.width,
      height: meta.height,
      format,
    };
  } catch (err) {
    if (err instanceof StorageError) throw err;
    throw new StorageError(
      `Failed to transform image: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}
