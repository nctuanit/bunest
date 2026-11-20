import { randomUUID } from "node:crypto";
import {
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from "@bunest/common";
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

function resolveDiskFromOptions(
  diskOption: string | StorageDisk | undefined,
  req: any,
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
          const stream: AsyncIterable<Uint8Array> | undefined =
            file?.stream ?? file?.file;
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
            fieldname: String(file.fieldname ?? ""),
            originalname: String(file.originalname ?? ""),
            mimetype: String(file.mimetype ?? ""),
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
            : `${randomUUID()}${extension}`;

          const storedContentType = detected ?? DEFAULT_CONTENT_TYPE;
          const userMeta = options.metadata ? options.metadata(info, req) : undefined;

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
              if (file?.truncated) {
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
          if (file?.key) {
            const { disk } = resolveDiskFromOptions(options.disk, req);
            await disk.delete(String(file.key));
          }
          callback(null);
        } catch (err) {
          callback(err instanceof Error ? err : new Error(String(err)));
        }
      })();
    },
  };
}
