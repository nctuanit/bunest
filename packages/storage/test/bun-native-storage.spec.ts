import { describe, expect, it } from "bun:test";
import {
  BunS3Disk,
  InMemoryDisk,
  StorageError,
  StorageInvalidKeyError,
  archiveDiskPrefix,
  createTarArchive,
  extractArchiveToDisk,
  extractTarArchive,
  inspectImage,
  transformImage,
  type BunS3ClientLike,
} from "../src/index";

const PNG_1X1 = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  ),
);

function buildRawUstarTar(
  entries: ReadonlyArray<{
    readonly name: string;
    readonly content?: string;
    readonly typeflag?: string;
    readonly linkname?: string;
  }>,
): Uint8Array {
  const encoder = new TextEncoder();
  const blocks: Uint8Array[] = [];

  for (const entry of entries) {
    const payload = encoder.encode(entry.content ?? "");
    const header = new Uint8Array(512);
    const writeStr = (str: string, off: number, len: number) => {
      const b = encoder.encode(str);
      header.set(b.subarray(0, len), off);
    };
    writeStr(entry.name, 0, 100);
    writeStr("0000644\0", 100, 8);
    writeStr("0000000\0", 108, 8);
    writeStr("0000000\0", 116, 8);
    writeStr(payload.byteLength.toString(8).padStart(11, "0") + "\0", 124, 12);
    writeStr("00000000000\0", 136, 12);
    writeStr("        ", 148, 8);
    header[156] = (entry.typeflag ?? "0").charCodeAt(0);
    if (entry.linkname) {
      writeStr(entry.linkname, 157, 100);
    }
    writeStr("ustar\0", 257, 6);
    writeStr("00", 263, 2);
    let checksum = 0;
    for (let i = 0; i < 512; i++) {
      checksum += header[i]!;
    }
    writeStr(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
    blocks.push(header);

    if (payload.byteLength > 0) {
      const paddedLen = Math.ceil(payload.byteLength / 512) * 512;
      const dataBlock = new Uint8Array(paddedLen);
      dataBlock.set(payload);
      blocks.push(dataBlock);
    }
  }

  // Two 512-byte zero EOF blocks
  blocks.push(new Uint8Array(1024));
  return new Uint8Array(Bun.concatArrayBuffers(blocks));
}

describe("Wave 5 — @bunest/storage Bun 1.4.5 Native APIs (S3File.writer, Bun.Archive, Bun.Image)", () => {
  it("BunS3Disk.put streams chunks via s3File.writer() without buffering into client.write()", async () => {
    const writtenChunks: Uint8Array[] = [];
    let ended = false;
    let clientWriteCalls = 0;

    const mockClient: BunS3ClientLike = {
      file(key: string) {
        return {
          writer() {
            return {
              write(chunk: Uint8Array | ArrayBuffer | string) {
                writtenChunks.push(
                  typeof chunk === "string"
                    ? new TextEncoder().encode(chunk)
                    : new Uint8Array(chunk),
                );
              },
              async end() {
                ended = true;
              },
            };
          },
          async arrayBuffer() {
            return new ArrayBuffer(0);
          },
          async exists() {
            return ended;
          },
          async delete() {},
          async stat() {
            return { size: 11, type: "text/plain", etag: `"e-${key}"` };
          },
        };
      },
      async write() {
        clientWriteCalls += 1;
        return 0;
      },
    };

    const disk = new BunS3Disk({ client: mockClient });
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("hello "));
        c.enqueue(new TextEncoder().encode("world"));
        c.close();
      },
    });
    const res = await disk.put("docs/hello.txt", stream, {
      contentType: "text/plain",
    });

    expect(clientWriteCalls).toBe(0);
    expect(ended).toBe(true);
    expect(writtenChunks.length).toBe(2);
    expect(res.size).toBe(11);
  });

  it("BunS3Disk.put aborts/closes writer on mid-stream error or AbortSignal, and falls back to client.write when writer is absent", async () => {
    let closedOnError = false;
    const abortingClient: BunS3ClientLike = {
      file() {
        return {
          writer() {
            return {
              write() {},
              async end() {},
              async close() {
                closedOnError = true;
              },
            };
          },
          async arrayBuffer() {
            return new ArrayBuffer(0);
          },
          async exists() {
            return false;
          },
          async delete() {},
        };
      },
      async write() {
        return 0;
      },
    };

    const diskWithWriter = new BunS3Disk({ client: abortingClient });
    const ac = new AbortController();
    const failingStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("part-1"));
      },
      pull() {
        ac.abort(new Error("user cancelled upload"));
        return Promise.resolve();
      },
    });

    await expect(
      diskWithWriter.put("aborted.bin", failingStream, { signal: ac.signal }),
    ).rejects.toThrow("user cancelled upload");
    expect(closedOnError).toBe(true);

    // Fallback path when writer() is not provided
    let fallbackBytes = 0;
    const minimalClient: BunS3ClientLike = {
      file() {
        return {
          async arrayBuffer() {
            return new ArrayBuffer(0);
          },
          async exists() {
            return true;
          },
          async delete() {},
        };
      },
      async write(_key, data) {
        fallbackBytes =
          typeof data === "string" ? data.length : (data as Uint8Array).byteLength;
        return fallbackBytes;
      },
    };

    const fallbackDisk = new BunS3Disk({ client: minimalClient });
    const putRes = await fallbackDisk.put("plain.txt", "fallback-payload");
    expect(fallbackBytes).toBe(16);
    expect(putRes.size).toBe(16);
  });

  it("BunS3Disk.copy streams srcFile.stream() -> destFile.writer() and cleans up on abort/error", async () => {
    const destChunks: Uint8Array[] = [];
    let destEnded = false;
    let clientWriteCalls = 0;

    const streamingClient: BunS3ClientLike = {
      file(key: string) {
        return {
          stream() {
            return new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("chunkA-"));
                controller.enqueue(new TextEncoder().encode("chunkB"));
                controller.close();
              },
            });
          },
          writer() {
            return {
              write(chunk: Uint8Array | ArrayBuffer | string) {
                destChunks.push(
                  typeof chunk === "string"
                    ? new TextEncoder().encode(chunk)
                    : new Uint8Array(chunk),
                );
              },
              async end() {
                destEnded = true;
              },
            };
          },
          async arrayBuffer() {
            return new ArrayBuffer(0);
          },
          async exists() {
            return key === "src.txt";
          },
          async delete() {},
          async stat() {
            return { size: 13, type: "text/plain" };
          },
        };
      },
      async write() {
        clientWriteCalls += 1;
        return 0;
      },
    };

    const disk = new BunS3Disk({ client: streamingClient });
    const copied = await disk.copy("src.txt", "dst.txt");
    expect(clientWriteCalls).toBe(0);
    expect(destEnded).toBe(true);
    expect(destChunks.length).toBe(2);
    expect(copied.size).toBe(13);

    // Verify reader.cancel() + writer.close() on mid-copy failure
    let readerCancelled = false;
    let writerClosed = false;
    const failingCopyClient: BunS3ClientLike = {
      file(key: string) {
        return {
          stream() {
            return new ReadableStream<Uint8Array>({
              pull(controller) {
                controller.enqueue(new TextEncoder().encode("ok"));
              },
              cancel() {
                readerCancelled = true;
              },
            });
          },
          writer() {
            return {
              write() {
                throw new Error("S3 network reset");
              },
              async end() {},
              async close() {
                writerClosed = true;
              },
            };
          },
          async arrayBuffer() {
            return new ArrayBuffer(0);
          },
          async exists() {
            return key === "src.txt";
          },
          async delete() {},
          async stat() {
            return { size: 100, type: "application/octet-stream" };
          },
        };
      },
      async write() {
        return 0;
      },
    };

    const failingDisk = new BunS3Disk({ client: failingCopyClient });
    await expect(failingDisk.copy("src.txt", "dst.txt")).rejects.toThrow(
      "S3 network reset",
    );
    expect(readerCancelled).toBe(true);
    expect(writerClosed).toBe(true);
  });

  it("Bun.Archive creates & extracts .tar.gz archives, enforces prefix boundaries, blocks traversal/crafted tar attacks, and excludes symlinks", async () => {
    const disk = new InMemoryDisk();
    await disk.put("docs/a.txt", "alpha");
    await disk.put("docs/sub/b.txt", "beta");
    await disk.put("docs2/other.txt", "must-not-match");

    // Prefix boundary without trailing slash must NOT pull in `docs2/other.txt`
    const tgz = await archiveDiskPrefix(disk, "docs", { compress: "gzip" });
    expect(tgz.byteLength).toBeGreaterThan(20);

    const extracted = await extractTarArchive(tgz);
    expect([...extracted.keys()].sort()).toEqual(["a.txt", "sub/b.txt"]);
    expect(await extracted.get("a.txt")?.text()).toBe("alpha");
    expect(await extracted.get("sub/b.txt")?.text()).toBe("beta");

    const targetDisk = new InMemoryDisk();
    const results = await extractArchiveToDisk(targetDisk, tgz, {
      prefix: "imported",
    });
    expect(results.length).toBe(2);
    expect(await targetDisk.getText("imported/a.txt")).toBe("alpha");
    expect(await targetDisk.getText("imported/sub/b.txt")).toBe("beta");

    await expect(
      createTarArchive({ "../escape.txt": "bad" }),
    ).rejects.toBeInstanceOf(StorageInvalidKeyError);

    // Crafted USTAR archives with malicious paths must be rejected on extraction
    for (const unsafeName of [
      "../escape.txt",
      "/etc/passwd",
      "././nested.txt",
      "a//b.txt",
      "C:drive.txt",
    ]) {
      const badTar = buildRawUstarTar([{ name: unsafeName, content: "x" }]);
      await expect(extractTarArchive(badTar)).rejects.toBeInstanceOf(
        StorageInvalidKeyError,
      );
      await expect(
        extractArchiveToDisk(new InMemoryDisk(), badTar),
      ).rejects.toBeInstanceOf(StorageInvalidKeyError);
    }

    // Crafted USTAR archive containing a symlink alongside a regular file excludes the symlink
    const symlinkTar = buildRawUstarTar([
      { name: "safe.txt", content: "ok", typeflag: "0" },
      {
        name: "evil-link",
        typeflag: "2",
        linkname: "/etc/passwd",
      },
    ]);
    const safeFiles = await extractTarArchive(symlinkTar);
    expect([...safeFiles.keys()]).toEqual(["safe.txt"]);
  });

  it("Bun.Image inspectImage & transformImage handle height-only resize, fit, rotate/flip/flop, multiple formats, and invalid/empty inputs", async () => {
    const meta = await inspectImage(PNG_1X1);
    expect(meta.width).toBe(1);
    expect(meta.height).toBe(1);
    expect(meta.format.toLowerCase()).toBe("png");

    // WebP resize with fit
    const webpRes = await transformImage(PNG_1X1, {
      width: 8,
      height: 8,
      fit: "fill",
      format: "webp",
      quality: 80,
    });
    expect(webpRes.width).toBe(8);
    expect(webpRes.height).toBe(8);
    expect(webpRes.format).toBe("webp");
    expect(webpRes.contentType).toBe("image/webp");
    expect(webpRes.bytes.byteLength).toBeGreaterThan(0);

    // Height-only resize preserves aspect ratio (both square 1x1 and rectangular 20x10)
    const heightOnly = await transformImage(PNG_1X1, {
      height: 10,
      fit: "inside",
    });
    expect(heightOnly.height).toBe(10);
    expect(heightOnly.width).toBe(10);

    const rect20x10 = await transformImage(PNG_1X1, {
      width: 20,
      height: 10,
      fit: "fill",
      format: "png",
    });
    const rectHeightOnly = await transformImage(rect20x10.bytes, {
      height: 5,
      fit: "inside",
    });
    expect(rectHeightOnly.width).toBe(10);
    expect(rectHeightOnly.height).toBe(5);

    // Rotate + flip + flop + JPEG / PNG / AVIF transcoding
    const jpegRes = await transformImage(PNG_1X1, {
      width: 4,
      height: 2,
      rotate: 90,
      flip: true,
      flop: true,
      format: "jpeg",
      quality: 85,
    });
    expect(jpegRes.format).toBe("jpeg");
    expect(jpegRes.contentType).toBe("image/jpeg");
    expect(jpegRes.bytes.byteLength).toBeGreaterThan(0);

    const pngRes = await transformImage(PNG_1X1, {
      width: 4,
      height: 4,
      format: "png",
    });
    expect(pngRes.format).toBe("png");
    expect(pngRes.contentType).toBe("image/png");

    const avifRes = await transformImage(PNG_1X1, {
      width: 4,
      height: 4,
      format: "avif",
      quality: 60,
    });
    expect(avifRes.format).toBe("avif");
    expect(avifRes.contentType).toBe("image/avif");

    // Empty & invalid buffers and invalid rotate angles fail cleanly with StorageError
    await expect(inspectImage(new Uint8Array(0))).rejects.toBeInstanceOf(
      StorageError,
    );
    await expect(transformImage(new Uint8Array(0))).rejects.toBeInstanceOf(
      StorageError,
    );
    await expect(
      inspectImage(new Uint8Array([1, 2, 3, 4])),
    ).rejects.toBeInstanceOf(StorageError);
    await expect(
      transformImage(new Uint8Array([1, 2, 3, 4]), { format: "webp" }),
    ).rejects.toBeInstanceOf(StorageError);
    await expect(
      transformImage(PNG_1X1, { rotate: 45 }),
    ).rejects.toBeInstanceOf(StorageError);
  });
});
