const BY_EXTENSION: Record<string, string> = {
  avif: "image/avif",
  bmp: "image/bmp",
  css: "text/css; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  epub: "application/epub+zip",
  gif: "image/gif",
  gz: "application/gzip",
  heic: "image/heic",
  htm: "text/html; charset=utf-8",
  html: "text/html; charset=utf-8",
  ico: "image/vnd.microsoft.icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "text/javascript; charset=utf-8",
  json: "application/json",
  m4a: "audio/mp4",
  md: "text/markdown; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  ogg: "audio/ogg",
  pdf: "application/pdf",
  png: "image/png",
  svg: "image/svg+xml",
  tar: "application/x-tar",
  tif: "image/tiff",
  tiff: "image/tiff",
  txt: "text/plain; charset=utf-8",
  wav: "audio/wav",
  webm: "video/webm",
  webp: "image/webp",
  woff: "font/woff",
  woff2: "font/woff2",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xml: "application/xml",
  zip: "application/zip",
};

export const DEFAULT_CONTENT_TYPE = "application/octet-stream";

export function contentTypeFromKey(key: string): string {
  const name = key.slice(key.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) {
    return DEFAULT_CONTENT_TYPE;
  }
  return (
    BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? DEFAULT_CONTENT_TYPE
  );
}

/** The usual extension for a detected type, for keys built from uploads. */
export const EXTENSION_BY_TYPE: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/avif": ".avif",
  "image/heic": ".heic",
  "application/pdf": ".pdf",
};

/** A content type without its parameters, lowercased: `text/csv; charset=utf-8` is `text/csv`. */
export function contentTypeEssence(type: string): string {
  return (type.split(";", 1)[0] ?? "").trim().toLowerCase();
}

const EXTENSION_BY_ESSENCE: Record<string, string> = { ...EXTENSION_BY_TYPE };
for (const [extension, type] of Object.entries(BY_EXTENSION)) {
  const essence = contentTypeEssence(type);
  if (EXTENSION_BY_ESSENCE[essence] === undefined) {
    EXTENSION_BY_ESSENCE[essence] = `.${extension}`;
  }
}

/** The usual extension for a content type (`.csv` for `text/csv; charset=utf-8`), or `''`. */
export function extensionForContentType(type: string | undefined): string {
  return type === undefined
    ? ""
    : (EXTENSION_BY_ESSENCE[contentTypeEssence(type)] ?? "");
}

/** How many leading bytes `detectContentType()` needs to recognize every format it knows. */
export const SNIFF_BYTES = 16;

function startsWith(
  bytes: Uint8Array,
  signature: readonly number[],
  offset = 0,
): boolean {
  if (bytes.length < offset + signature.length) {
    return false;
  }
  for (let i = 0; i < signature.length; i++) {
    if (bytes[offset + i] !== signature[i]) {
      return false;
    }
  }
  return true;
}

function ascii(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    out.push(text.charCodeAt(i));
  }
  return out;
}

const SIG_JPEG = [0xff, 0xd8, 0xff];
const SIG_PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const SIG_GIF87 = ascii("GIF87a");
const SIG_GIF89 = ascii("GIF89a");
const SIG_RIFF = ascii("RIFF");
const SIG_WEBP = ascii("WEBP");
const SIG_PDF = ascii("%PDF-");
const SIG_FTYP = ascii("ftyp");

/**
 * The type of a file from its first bytes (at least 16 for every format below), or
 * `undefined` when it isn't one of: JPEG, PNG, GIF, WebP, AVIF, HEIC, PDF.
 */
export function detectContentType(bytes: Uint8Array): string | undefined {
  if (startsWith(bytes, SIG_JPEG)) {
    return "image/jpeg";
  }
  if (startsWith(bytes, SIG_PNG)) {
    return "image/png";
  }
  if (startsWith(bytes, SIG_GIF87) || startsWith(bytes, SIG_GIF89)) {
    return "image/gif";
  }
  if (startsWith(bytes, SIG_RIFF) && startsWith(bytes, SIG_WEBP, 8)) {
    return "image/webp";
  }
  if (startsWith(bytes, SIG_PDF)) {
    return "application/pdf";
  }
  if (startsWith(bytes, SIG_FTYP, 4) && bytes.length >= 12) {
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
      brand === "heim" ||
      brand === "heis"
    ) {
      return "image/heic";
    }
  }
  return undefined;
}
