import {
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from "@bunest/core";
import { StorageDisk } from "../disks/storage.disk";
import type { UploadToDiskOptions } from "../interfaces/module-options.interface";
import type {
  StoredUpload,
  UploadFileInfo,
  UploadStorageEngine,
} from "../interfaces/storage-types";
import {
  contentTypeEssence,
  DEFAULT_CONTENT_TYPE,
  detectContentType,
  extensionForContentType,
  SNIFF_BYTES,
} from "../utils/content-type.util";
import { storageForRequest } from "./app-registry.util";

const DEFAULT_SAMPLE_BYTES = 4096;
const MAX_SAMPLE_BYTES = 65536;

interface UploadFileLike {
  readonly stream?: AsyncIterable<Uint8Array>;
  readonly file?: AsyncIterable<Uint8Array>;
  readonly fieldname?: unknown;
  readonly originalname?: unknown;
  readonly mimetype?: unknown;
  readonly truncated?: unknown;
  readonly key?: unknown;
}

function resolveDiskFromOptions(
  diskOption: string | StorageDisk | undefined,
  req: unknown,
): { disk: StorageDisk; diskName?: string } {
  if (diskOption instanceof StorageDisk) {
    return { disk: diskOption };
  }
  const storage = storageForRequest(req);
  if (!storage) {
    throw new Error(
      "uploadToDisk() could not find StorageModule for this request. Pass a StorageDisk instance or import StorageModule.",
    );
  }
  const disk = storage.disk(diskOption);
  return {
    disk,
    ...(typeof diskOption === "string" ? { diskName: diskOption } : {}),
  };
}

/**
 * A storage engine for `FileInterceptor()` / multipart upload handlers that streams each upload
 * straight into a disk with magic-byte content-type sniffing before any byte is written.
 */
export function uploadToDisk(
  options: UploadToDiskOptions = {},
): UploadStorageEngine {
  if (options.contentTypeSampleBytes !== undefined) {
    if (!options.detectContentType) {
      throw new TypeError(
        "uploadToDisk() `contentTypeSampleBytes` requires `detectContentType`",
      );
    }
    if (
      !Number.isInteger(options.contentTypeSampleBytes) ||
      options.contentTypeSampleBytes < 1 ||
      options.contentTypeSampleBytes > MAX_SAMPLE_BYTES
    ) {
      throw new RangeError(
        `uploadToDisk() \`contentTypeSampleBytes\` must be an integer between 1 and ${MAX_SAMPLE_BYTES}`,
      );
    }
  }

  const allowedTypes = options.contentTypes
    ? new Set(options.contentTypes.map(contentTypeEssence))
    : undefined;
  const sampleLimit = options.detectContentType
    ? (options.contentTypeSampleBytes ?? DEFAULT_SAMPLE_BYTES)
    : SNIFF_BYTES;

  return {
    _handleFile(req, file, callback) {
      void (async () => {
        try {
          const { disk, diskName } = resolveDiskFromOptions(options.disk, req);
          const uploadFile = (
            file && typeof file === "object" ? file : {}
          ) as UploadFileLike;
          const stream: AsyncIterable<Uint8Array> | undefined =
            uploadFile.stream ?? uploadFile.file;
          if (!stream || typeof stream[Symbol.asyncIterator] !== "function") {
            throw new TypeError("Upload file is missing a readable stream");
          }

          const iterator = stream[Symbol.asyncIterator]();
          const buffered: Buffer[] = [];
          let bufferedBytes = 0;
          let streamEnded = false;

          while (bufferedBytes < sampleLimit) {
            const next = await iterator.next();
            if (next.done) {
              streamEnded = true;
              break;
            }
            const buf = Buffer.isBuffer(next.value)
              ? next.value
              : Buffer.from(next.value);
            if (buf.byteLength > 0) {
              buffered.push(buf);
              bufferedBytes += buf.byteLength;
            }
          }

          const prefixBuf = Buffer.concat(buffered);
          const sampleSlice = prefixBuf.subarray(0, sampleLimit);

          let detected = detectContentType(sampleSlice);
          const baseInfo: UploadFileInfo = {
            fieldname: String(uploadFile.fieldname ?? ""),
            originalname: String(uploadFile.originalname ?? ""),
            mimetype: String(uploadFile.mimetype ?? ""),
            contentType: undefined,
            extension: "",
          };

          if (detected === undefined && options.detectContentType) {
            detected = await options.detectContentType(
              Buffer.from(sampleSlice),
              baseInfo,
            );
          }

          if (allowedTypes) {
            if (!detected || !allowedTypes.has(contentTypeEssence(detected))) {
              void iterator.return?.().catch(() => {});
              throw new UnsupportedMediaTypeException(
                `Unsupported file type: ${detected ?? "unknown"}`,
              );
            }
          }

          const extension = extensionForContentType(detected);
          const info: UploadFileInfo = {
            ...baseInfo,
            contentType: detected,
            extension,
          };

          const key = options.key
            ? await options.key(info, req)
            : `${crypto.randomUUID()}${extension}`;

          const storedContentType = detected ?? DEFAULT_CONTENT_TYPE;
          const userMeta = options.metadata
            ? options.metadata(info, req)
            : undefined;

          const replayStream: AsyncIterable<Buffer> = {
            async *[Symbol.asyncIterator]() {
              if (prefixBuf.byteLength > 0) {
                yield prefixBuf;
              }
              if (!streamEnded) {
                while (true) {
                  const next = await iterator.next();
                  if (next.done) break;
                  const buf = Buffer.isBuffer(next.value)
                    ? next.value
                    : Buffer.from(next.value);
                  if (buf.byteLength > 0) {
                    yield buf;
                  }
                }
              }
              if (uploadFile.truncated) {
                throw new PayloadTooLargeException("Uploaded file too large");
              }
            },
          };

          const written = await disk.put(key, replayStream, {
            contentType: storedContentType,
            ...(options.cacheControl !== undefined
              ? { cacheControl: options.cacheControl }
              : {}),
            ...(userMeta ? { metadata: userMeta } : {}),
          });

          const stored: Partial<StoredUpload> = {
            size: written.size,
            key: written.key,
            ...(diskName !== undefined ? { disk: diskName } : {}),
            contentType: written.contentType,
            ...(written.etag !== undefined ? { etag: written.etag } : {}),
          };
          callback(null, stored);
        } catch (err) {
          callback(err);
        }
      })();
    },

    _removeFile(req, file, callback) {
      void (async () => {
        try {
          const uploadFile = (
            file && typeof file === "object" ? file : undefined
          ) as UploadFileLike | undefined;
          if (uploadFile?.key) {
            const { disk } = resolveDiskFromOptions(options.disk, req);
            await disk.delete(String(uploadFile.key));
          }
          callback(null);
        } catch (err) {
          callback(err instanceof Error ? err : new Error(String(err)));
        }
      })();
    },
  };
}
