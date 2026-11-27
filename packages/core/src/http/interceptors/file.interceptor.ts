import {
  BODY_SANITIZED_SYMBOL,
  HttpStatus,
  Injectable,
  PayloadTooLargeException,
  createParamDecorator,
  ensureDir,
  join,
  resolve,
  type BunestInterceptor,
  type CallHandler,
  type ExecutionContext,
  type Type,
  type UploadedFileInfo,
} from "../../common/index";
import { getCurrentRequestContext } from "../context/request-context";
import type { DiskUploadedFileInfo } from "../interfaces/http-bridge.interface";
import {
  extractMultipartStreamBoundary,
  parseMultipartStream,
  type MultipartFilePart,
  type MultipartStreamOptions,
  type MultipartStreamPart,
} from "../parsers/multipart-stream";
import { isDangerousKey } from "../security/prototype-sanitizer";

const EMPTY_BYTES = new Uint8Array(0);

/**
 * Live streaming file handle exposed to `@UploadedFileStream()` when using
 * `FileInterceptor(field, { mode: "stream" })` or `FilesInterceptor(...)`.
 */
export type UploadedFileStream = MultipartFilePart;

/**
 * File payload passed to custom storage engines (`handleFile` / `_handleFile`).
 * Exposes both `stream` and `file` aliases pointing to the live `ReadableStream<Uint8Array>`
 * for direct plug-and-play compatibility with `@bunest/storage`'s `uploadToDisk()`.
 */
export interface UploadStorageEngineFile {
  readonly fieldname: string;
  readonly originalname: string;
  readonly filename: string;
  readonly encoding: string;
  readonly mimetype: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly stream: ReadableStream<Uint8Array>;
  readonly file: ReadableStream<Uint8Array>;
  readonly truncated: boolean;
}

/**
 * Result produced when a storage engine persists an uploaded file.
 */
export interface StoredUploadedFile extends UploadedFileInfo {
  readonly key?: string;
  readonly disk?: string;
  readonly contentType?: string;
  readonly etag?: string;
  readonly path?: string;
  readonly filename?: string;
  readonly destination?: string;
  readonly [key: string]: unknown;
}

/**
 * Structural upload storage engine contract supporting BOTH:
 * - Promise-based `handleFile(req, file)` / `removeFile(req, file)` engines
 * - Callback-based `_handleFile(req, file, cb)` / `_removeFile(req, file, cb)`
 *   engines (exact `@bunest/storage` `uploadToDisk()` / Multer contract).
 */
export interface UploadStorageEngineLike {
  handleFile?(
    req: Request,
    file: UploadStorageEngineFile,
  ): Promise<Record<string, unknown> | void> | Record<string, unknown> | void;
  removeFile?(
    req: Request,
    file: Record<string, unknown>,
  ): Promise<void> | void;
  _handleFile?(
    req: unknown,
    file: unknown,
    callback: (error?: unknown, info?: Record<string, unknown>) => void,
  ): void;
  _removeFile?(
    req: unknown,
    file: unknown,
    callback: (error: Error | null) => void,
  ): void;
}

/** Upload processing mode for `FileInterceptor()` / `FilesInterceptor()`. */
export type FileUploadMode = "stream" | "memory" | "disk";

/** Options accepted by `FileInterceptor()` and `FilesInterceptor()`. */
export interface FileInterceptorOptions {
  /**
   * Processing mode when `storage` is omitted:
   * - `"stream"` (default): zero-buffer live `ReadableStream<Uint8Array>` via `@UploadedFileStream()`.
   * - `"memory"`: streams file into `Uint8Array` buffer (respecting `maxFileSize`).
   * - `"disk"`: streams file directly to disk via `Bun.file().writer()`.
   */
  readonly mode?: FileUploadMode;
  /**
   * Optional storage engine (e.g. `@bunest/storage`'s `uploadToDisk()` or a custom
   * `{ handleFile(req, file) }` engine). Streams straight from `req.body` into storage.
   */
  readonly storage?: UploadStorageEngineLike;
  /** Destination directory for `mode: "disk"` uploads (defaults to system temp dir). */
  readonly dest?: string;
  /** Alias for `dest`. */
  readonly diskStorageDir?: string;
  /** Multipart limits (`maxFileSize`, `maxFiles`, `maxFields`, `maxFieldSize`, `allowedMimeTypes`). */
  readonly limits?: MultipartStreamOptions;
  /** Shorthand for `limits.maxFileSize`. */
  readonly maxFileSize?: number;
  /** Shorthand for `limits.maxFiles`. */
  readonly maxFiles?: number;
  /** Shorthand for `limits.maxFields`. */
  readonly maxFields?: number;
  /** Shorthand for `limits.maxFieldSize`. */
  readonly maxFieldSize?: number;
  /** Shorthand for `limits.allowedMimeTypes`. */
  readonly allowedMimeTypes?: readonly (string | RegExp)[];
  /** Optional filter called per file before streaming its body. Return `false` to skip. */
  readonly fileFilter?: (
    req: Request,
    file: MultipartFilePart,
  ) => boolean | Promise<boolean>;
}

function appendFormField(
  fields: Record<string, unknown>,
  key: string,
  value: string,
): void {
  if (!key || isDangerousKey(key)) return;
  if (Object.prototype.hasOwnProperty.call(fields, key)) {
    const existing = fields[key];
    if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      fields[key] = [existing, value];
    }
  } else {
    fields[key] = value;
  }
}

function markFieldsSanitized(fields: Record<string, unknown>): void {
  Object.defineProperty(fields, BODY_SANITIZED_SYMBOL, {
    value: true,
    enumerable: false,
    configurable: true,
  });
}

function extractSafeExt(originalname: string): string {
  const base = originalname.split(/[\\/]/).pop() ?? "";
  const dotIdx = base.lastIndexOf(".");
  if (dotIdx <= 0 || dotIdx === base.length - 1) return "";
  const ext = base.slice(dotIdx).toLowerCase();
  return /^\.[a-z0-9]{1,15}$/.test(ext) ? ext : "";
}

function resolveDefaultTempDir(): string {
  if (typeof Bun !== "undefined" && Bun.env) {
    return Bun.env.TMPDIR ?? Bun.env.TEMP ?? Bun.env.TMP ?? "/tmp";
  }
  return "/tmp";
}

function buildStreamOptions(
  opts: FileInterceptorOptions,
): MultipartStreamOptions {
  return {
    maxFileSize: opts.maxFileSize ?? opts.limits?.maxFileSize,
    maxFiles: opts.maxFiles ?? opts.limits?.maxFiles,
    maxFields: opts.maxFields ?? opts.limits?.maxFields,
    maxFieldSize: opts.maxFieldSize ?? opts.limits?.maxFieldSize,
    maxHeaderSize: opts.limits?.maxHeaderSize,
    allowedMimeTypes: opts.allowedMimeTypes ?? opts.limits?.allowedMimeTypes,
  };
}

function invokeStorageEngine(
  storage: UploadStorageEngineLike,
  req: Request,
  file: UploadStorageEngineFile,
): Promise<Record<string, unknown>> {
  if (typeof storage.handleFile === "function") {
    return Promise.resolve(storage.handleFile(req, file)).then(
      (res) => res ?? {},
    );
  }
  if (typeof storage._handleFile === "function") {
    return new Promise<Record<string, unknown>>((resolvePromise, reject) => {
      storage._handleFile!(req, file, (err, info) => {
        if (err) {
          reject(err);
        } else {
          resolvePromise(info ?? {});
        }
      });
    });
  }
  throw new TypeError(
    "UploadStorageEngine must implement either `handleFile(req, file)` or `_handleFile(req, file, callback)`.",
  );
}

async function removeFromStorageEngine(
  storage: UploadStorageEngineLike,
  req: Request,
  file: Record<string, unknown>,
): Promise<void> {
  try {
    if (typeof storage.removeFile === "function") {
      await storage.removeFile(req, file);
    } else if (typeof storage._removeFile === "function") {
      await new Promise<void>((resolvePromise) => {
        storage._removeFile!(req, file, () => resolvePromise());
      });
    }
  } catch {
    // Best-effort cleanup on failed upload
  }
}

async function readStreamToMemory(
  part: MultipartFilePart,
): Promise<UploadedFileInfo> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = part.stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
  } finally {
    reader.releaseLock();
  }

  let buffer: Uint8Array;
  if (chunks.length === 0) {
    buffer = EMPTY_BYTES;
  } else if (chunks.length === 1) {
    buffer = chunks[0]!;
  } else {
    buffer = new Uint8Array(total);
    let offset = 0;
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i]!;
      buffer.set(c, offset);
      offset += c.byteLength;
    }
  }

  const fileCopy = new Uint8Array(buffer.byteLength);
  fileCopy.set(buffer);
  const webFile = new File([fileCopy], part.originalname, {
    type: part.mimetype,
  });

  return {
    fieldname: part.fieldname,
    originalname: part.originalname,
    encoding: part.encoding,
    mimetype: part.mimetype,
    size: total,
    buffer,
    file: webFile,
    stream: () => webFile.stream(),
  };
}

async function streamPartToDisk(
  part: MultipartFilePart,
  destDir: string,
  writtenPaths: string[],
): Promise<DiskUploadedFileInfo> {
  const ext = extractSafeExt(part.originalname);
  const generatedName = `${crypto.randomUUID()}${ext}`;
  const destPath = join(destDir, generatedName);
  writtenPaths.push(destPath);

  const writer = Bun.file(destPath).writer();
  const reader = part.stream.getReader();
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        total += value.byteLength;
        const writeResult = writer.write(value);
        if (writeResult instanceof Promise) {
          await writeResult;
        }
      }
    }
    await writer.end();
  } catch (err) {
    try {
      await writer.end();
    } catch {
      // Ignore close failure during rollback
    }
    throw err;
  } finally {
    reader.releaseLock();
  }

  const diskFile = Bun.file(destPath);
  return {
    fieldname: part.fieldname,
    originalname: part.originalname,
    encoding: part.encoding,
    mimetype: part.mimetype,
    size: total,
    buffer: EMPTY_BYTES,
    file: diskFile as unknown as File,
    stream: () => diskFile.stream(),
    path: destPath,
    filename: generatedName,
    destination: destDir,
  };
}

function toStreamUploadedFileInfo(part: MultipartFilePart): UploadedFileInfo {
  return {
    fieldname: part.fieldname,
    originalname: part.originalname,
    encoding: part.encoding,
    mimetype: part.mimetype,
    get size(): number {
      return part.bytesRead;
    },
    buffer: EMPTY_BYTES,
    file: undefined as unknown as File,
    stream: () => part.stream,
  };
}

function createUploadInterceptor(
  fieldName: string,
  maxCount: number,
  isSingle: boolean,
  options: FileInterceptorOptions,
): Type<BunestInterceptor> {
  const mode: FileUploadMode = options.mode ?? "stream";
  const storage = options.storage;
  const streamOpts = buildStreamOptions(options);

  @Injectable()
  class MixinFileInterceptor implements BunestInterceptor {
    async intercept(
      context: ExecutionContext,
      next: CallHandler,
    ): Promise<unknown> {
      if (context.getType() !== "http") {
        return next.handle();
      }

      const req = context.switchToHttp().getRequest<Request>();
      const boundary = extractMultipartStreamBoundary(
        req.headers.get("content-type"),
      );
      if (!boundary) {
        return next.handle();
      }

      const reqCtx = getCurrentRequestContext();
      const fields: Record<string, unknown> = {};
      markFieldsSanitized(fields);

      // ── Mode 1: Storage engine (streams straight into storage with live backpressure) ──
      if (storage) {
        const storedFiles: StoredUploadedFile[] = [];
        try {
          for await (const part of parseMultipartStream(req, streamOpts)) {
            if (part.kind === "field") {
              appendFormField(fields, part.fieldname, part.value);
              continue;
            }
            if (part.fieldname !== fieldName) {
              await part.stream.cancel().catch(() => {});
              continue;
            }
            if (storedFiles.length + 1 > maxCount) {
              await part.stream.cancel().catch(() => {});
              throw new PayloadTooLargeException({
                statusCode: HttpStatus.PAYLOAD_TOO_LARGE,
                error: "Payload Too Large",
                message: `Too many files for field "${fieldName}" (max ${maxCount})`,
                limit: maxCount,
              });
            }
            if (options.fileFilter && !(await options.fileFilter(req, part))) {
              await part.stream.cancel().catch(() => {});
              continue;
            }

            const storageFile: UploadStorageEngineFile = {
              fieldname: part.fieldname,
              originalname: part.originalname,
              filename: part.originalname,
              encoding: part.encoding,
              mimetype: part.mimetype,
              headers: part.headers,
              stream: part.stream,
              file: part.stream,
              get truncated(): boolean {
                return part.truncated;
              },
            };

            const info = await invokeStorageEngine(storage, req, storageFile);
            const size =
              typeof info.size === "number" ? info.size : part.bytesRead;
            const merged: StoredUploadedFile = {
              fieldname: part.fieldname,
              originalname: part.originalname,
              encoding: part.encoding,
              mimetype: part.mimetype,
              size,
              buffer: EMPTY_BYTES,
              file: undefined as unknown as File,
              ...info,
            };
            storedFiles.push(merged);
          }
        } catch (err) {
          for (const stored of storedFiles) {
            await removeFromStorageEngine(storage, req, stored);
          }
          throw err;
        }

        reqCtx?.setInterceptedMultipart({
          body: fields,
          files: storedFiles,
          fileStream: isSingle ? storedFiles[0] : storedFiles,
        });

        try {
          return await next.handle();
        } catch (err) {
          for (const stored of storedFiles) {
            await removeFromStorageEngine(storage, req, stored);
          }
          throw err;
        }
      }

      // ── Mode 2: Memory buffering (chunked stream enforcing limits before buffering) ──
      if (mode === "memory") {
        const memoryFiles: UploadedFileInfo[] = [];
        for await (const part of parseMultipartStream(req, streamOpts)) {
          if (part.kind === "field") {
            appendFormField(fields, part.fieldname, part.value);
            continue;
          }
          if (part.fieldname !== fieldName) {
            await part.stream.cancel().catch(() => {});
            continue;
          }
          if (memoryFiles.length + 1 > maxCount) {
            await part.stream.cancel().catch(() => {});
            throw new PayloadTooLargeException({
              statusCode: HttpStatus.PAYLOAD_TOO_LARGE,
              error: "Payload Too Large",
              message: `Too many files for field "${fieldName}" (max ${maxCount})`,
              limit: maxCount,
            });
          }
          if (options.fileFilter && !(await options.fileFilter(req, part))) {
            await part.stream.cancel().catch(() => {});
            continue;
          }
          memoryFiles.push(await readStreamToMemory(part));
        }

        reqCtx?.setInterceptedMultipart({
          body: fields,
          files: memoryFiles,
          fileStream: isSingle ? memoryFiles[0] : memoryFiles,
        });
        return next.handle();
      }

      // ── Mode 3: Disk streaming (zero RAM buffering via Bun.file().writer()) ──
      if (mode === "disk") {
        const destDir = resolve(
          options.dest ?? options.diskStorageDir ?? resolveDefaultTempDir(),
        );
        await ensureDir(destDir);
        const diskFiles: DiskUploadedFileInfo[] = [];
        const writtenPaths: string[] = [];

        try {
          for await (const part of parseMultipartStream(req, streamOpts)) {
            if (part.kind === "field") {
              appendFormField(fields, part.fieldname, part.value);
              continue;
            }
            if (part.fieldname !== fieldName) {
              await part.stream.cancel().catch(() => {});
              continue;
            }
            if (diskFiles.length + 1 > maxCount) {
              await part.stream.cancel().catch(() => {});
              throw new PayloadTooLargeException({
                statusCode: HttpStatus.PAYLOAD_TOO_LARGE,
                error: "Payload Too Large",
                message: `Too many files for field "${fieldName}" (max ${maxCount})`,
                limit: maxCount,
              });
            }
            if (options.fileFilter && !(await options.fileFilter(req, part))) {
              await part.stream.cancel().catch(() => {});
              continue;
            }
            diskFiles.push(await streamPartToDisk(part, destDir, writtenPaths));
          }
        } catch (err) {
          for (const p of writtenPaths) {
            await Bun.file(p).delete().catch(() => {});
          }
          throw err;
        }

        reqCtx?.setInterceptedMultipart({
          body: fields,
          files: diskFiles,
          fileStream: isSingle ? diskFiles[0] : diskFiles,
        });
        return next.handle();
      }

      // ── Mode 4: Live zero-buffer `ReadableStream` passthrough (`mode: "stream"`) ──
      const iterator = parseMultipartStream(req, streamOpts)[
        Symbol.asyncIterator
      ]();

      if (isSingle) {
        let matchedPart: MultipartFilePart | undefined;
        try {
          while (true) {
            const nextRes = await iterator.next();
            if (nextRes.done) break;
            const part: MultipartStreamPart = nextRes.value;
            if (part.kind === "field") {
              appendFormField(fields, part.fieldname, part.value);
              continue;
            }
            if (part.fieldname !== fieldName) {
              await part.stream.cancel().catch(() => {});
              continue;
            }
            if (options.fileFilter && !(await options.fileFilter(req, part))) {
              await part.stream.cancel().catch(() => {});
              continue;
            }
            matchedPart = part;
            break;
          }

          reqCtx?.setInterceptedMultipart({
            body: fields,
            files: matchedPart ? [toStreamUploadedFileInfo(matchedPart)] : [],
            fileStream: matchedPart,
          });

          return await next.handle();
        } finally {
          if (matchedPart && !matchedPart.stream.locked) {
            await matchedPart.stream.cancel().catch(() => {});
          }
          await iterator.return?.().catch(() => {});
        }
      }

      // Multi-file live AsyncIterable stream (zero buffering across arbitrary file count)
      let yieldedCount = 0;
      const liveFilesIterable: AsyncIterable<UploadedFileStream> = {
        async *[Symbol.asyncIterator]() {
          try {
            while (true) {
              const nextRes = await iterator.next();
              if (nextRes.done) break;
              const part: MultipartStreamPart = nextRes.value;
              if (part.kind === "field") {
                appendFormField(fields, part.fieldname, part.value);
                continue;
              }
              if (part.fieldname !== fieldName) {
                await part.stream.cancel().catch(() => {});
                continue;
              }
              yieldedCount++;
              if (yieldedCount > maxCount) {
                await part.stream.cancel().catch(() => {});
                throw new PayloadTooLargeException({
                  statusCode: HttpStatus.PAYLOAD_TOO_LARGE,
                  error: "Payload Too Large",
                  message: `Too many files for field "${fieldName}" (max ${maxCount})`,
                  limit: maxCount,
                });
              }
              if (options.fileFilter && !(await options.fileFilter(req, part))) {
                yieldedCount--;
                await part.stream.cancel().catch(() => {});
                continue;
              }
              yield part;
            }
          } finally {
            await iterator.return?.().catch(() => {});
          }
        },
      };

      reqCtx?.setInterceptedMultipart({
        body: fields,
        files: [],
        fileStream: liveFilesIterable,
      });

      try {
        return await next.handle();
      } finally {
        await iterator.return?.().catch(() => {});
      }
    }
  }

  Object.defineProperty(MixinFileInterceptor, "name", {
    value: isSingle
      ? `FileInterceptor_${fieldName}`
      : `FilesInterceptor_${fieldName}`,
    configurable: true,
  });

  return MixinFileInterceptor;
}

/**
 * Interceptor handling a single multipart file upload under `fieldName` with
 * zero-buffer `ReadableStream` passthrough (`mode: "stream"`), disk streaming
 * (`mode: "disk"`), bounded memory buffering (`mode: "memory"`), or direct
 * storage engine streaming (`storage: uploadToDisk(...)`).
 */
export function FileInterceptor(
  fieldName: string,
  options: FileInterceptorOptions = {},
): Type<BunestInterceptor> {
  if (typeof fieldName !== "string" || fieldName.length === 0) {
    throw new TypeError("FileInterceptor() requires a non-empty fieldName.");
  }
  return createUploadInterceptor(fieldName, 1, true, options);
}

/**
 * Interceptor handling multiple multipart file uploads under `fieldName` up to
 * `maxCount` (default `Infinity`), supporting `mode: "stream" | "memory" | "disk"`
 * and storage engines matching `@bunest/storage`'s `UploadStorageEngine` contract.
 */
export function FilesInterceptor(
  fieldName: string,
  maxCount?: number,
  options?: FileInterceptorOptions,
): Type<BunestInterceptor>;
export function FilesInterceptor(
  fieldName: string,
  options?: FileInterceptorOptions,
): Type<BunestInterceptor>;
export function FilesInterceptor(
  fieldName: string,
  maxCountOrOptions?: number | FileInterceptorOptions,
  maybeOptions?: FileInterceptorOptions,
): Type<BunestInterceptor> {
  if (typeof fieldName !== "string" || fieldName.length === 0) {
    throw new TypeError("FilesInterceptor() requires a non-empty fieldName.");
  }
  const maxCount =
    typeof maxCountOrOptions === "number" ? maxCountOrOptions : Infinity;
  const options =
    typeof maxCountOrOptions === "object" && maxCountOrOptions !== null
      ? maxCountOrOptions
      : (maybeOptions ?? {});
  return createUploadInterceptor(fieldName, maxCount, false, options);
}

/**
 * Parameter decorator injecting the live `UploadedFileStream` (or stored/disk/memory
 * upload result, or `AsyncIterable<UploadedFileStream>` for `FilesInterceptor` in
 * stream mode) attached by `FileInterceptor` / `FilesInterceptor`.
 */
export const UploadedFileStream = createParamDecorator<
  string | undefined,
  ExecutionContext,
  unknown
>((fieldName, ctx) => {
  const reqCtx = getCurrentRequestContext();
  const intercepted = reqCtx?.getInterceptedFileStream();
  if (intercepted !== undefined) {
    return intercepted;
  }
  const req = ctx.switchToHttp().getRequest<Request>();
  if (!extractMultipartStreamBoundary(req.headers.get("content-type"))) {
    return undefined;
  }
  if (!fieldName) {
    return parseMultipartStream(req);
  }
  return (async function* () {
    for await (const part of parseMultipartStream(req)) {
      if (part.kind === "file" && part.fieldname === fieldName) {
        yield part;
      } else if (part.kind === "file") {
        await part.stream.cancel().catch(() => {});
      }
    }
  })();
});
