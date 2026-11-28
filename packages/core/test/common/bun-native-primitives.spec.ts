import { describe, expect, it } from "bun:test";
import {
  FileTypeValidator,
  ImageDimensionsValidator,
  UUID_NAMESPACE_DNS,
  createByteSink,
  detectMagicMimeType,
  findEmbeddedFile,
  formatColor,
  indexOfLine,
  isDeepMatch,
  isStandaloneExecutable,
  listEmbeddedFiles,
  matchesShape,
  nanoseconds,
  nowMonotonicAndUnixNano,
  nowUnixNanoBigInt,
  parseJsonl,
  parseJsonlChunk,
  readAgentErrorTracesFromFile,
  runSubprocess,
  semverOrder,
  semverSatisfies,
  sliceAnsi,
  uuidv5,
  wrapAnsi,
  type UploadedFileInfo,
} from "../../src/index";
import { join } from "../../src/common/utils/path.util";

// Valid 1x1 PNG
const PNG_1X1 = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  ),
);

// Valid 2x1 PNG (aspect ratio = 2.0)
const PNG_2X1 = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR42mNk+M9QzwAEjAwAAn8BAX+V5dYAAAAASUVORK5CYII=",
    "base64",
  ),
);

// Minimal valid 26-byte Windows BMP header (14-byte file header + 12-byte BITMAPCOREHEADER)
const VALID_BMP_HEADER = new Uint8Array([
  0x42, 0x4d, // "BM"
  0x1a, 0x00, 0x00, 0x00, // file size = 26
  0x00, 0x00, 0x00, 0x00, // reserved = 0
  0x1a, 0x00, 0x00, 0x00, // pixel offset = 26
  0x0c, 0x00, 0x00, 0x00, // DIB header size = 12 (BITMAPCOREHEADER)
  0x01, 0x00, 0x01, 0x00, // 1x1
  0x01, 0x00, 0x18, 0x00, // 1 plane, 24bpp
]);

describe("Wave 1 — Bun 1.4.5 Native Primitives in @bunest/core/common", () => {
  it("uuidv5 produces deterministic RFC 4122 v5 UUIDs via Bun.randomUUIDv5", () => {
    const a = uuidv5("bunest.dev", UUID_NAMESPACE_DNS);
    const b = uuidv5("bunest.dev", UUID_NAMESPACE_DNS);
    const c = uuidv5("other.dev", UUID_NAMESPACE_DNS);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a[14]).toBe("5");
  });

  it("wrapAnsi, sliceAnsi, and formatColor delegate to Bun native APIs", () => {
    const wrapped = wrapAnsi("hello world from bunest", 10);
    expect(wrapped.split("\n").length).toBeGreaterThan(1);

    const sliced = sliceAnsi("\x1b[31mhello world\x1b[0m", 0, 5);
    expect(sliced).toContain("hello");
    expect(sliced).not.toContain("world");

    expect(formatColor("rebeccapurple", "hex")).toBe("#663399");
  });

  it("nanoseconds, nowUnixNanoBigInt, and nowMonotonicAndUnixNano are monotonic and re-anchor on wall-clock jump", () => {
    const t1 = nanoseconds();
    const t2 = nanoseconds();
    expect(t2).toBeGreaterThanOrEqual(t1);

    const s1 = nowMonotonicAndUnixNano();
    const s2 = nowMonotonicAndUnixNano();
    expect(s2.monotonicNs).toBeGreaterThanOrEqual(s1.monotonicNs);
    expect(s2.unixNano).toBeGreaterThanOrEqual(s1.unixNano);
    expect(s1.unixNano).toBeGreaterThan(1_700_000_000_000_000_000n);

    const u1 = nowUnixNanoBigInt();
    const u2 = nowUnixNanoBigInt();
    expect(u2).toBeGreaterThanOrEqual(u1);

    // Simulate a >1s wall-clock step (e.g. OS sleep or NTP adjustment)
    const origDateNow = Date.now;
    try {
      const jumpedMs = origDateNow() + 10_000;
      Date.now = () => jumpedMs;
      const jumped = nowMonotonicAndUnixNano();
      expect(jumped.unixNano).toBeGreaterThanOrEqual(
        BigInt(jumpedMs) * 1_000_000n - 5_000_000n,
      );
    } finally {
      Date.now = origDateNow;
      // Re-anchor back to real wall clock for subsequent tests
      nowMonotonicAndUnixNano();
    }
  });

  it("isDeepMatch and matchesShape respect subset/target order cleanly", () => {
    const target = { a: 1, nested: { x: "ok", y: 42 } };
    expect(isDeepMatch({ nested: { x: "ok" } }, target)).toBe(true);
    expect(isDeepMatch({ nested: { x: "no" } }, target)).toBe(false);
    expect(matchesShape(target, { a: 1, nested: { y: 42 } })).toBe(true);
    expect(matchesShape(target, { a: 2 })).toBe(false);
  });

  it("semverSatisfies and semverOrder delegate to Bun.semver", () => {
    expect(semverSatisfies("1.4.5", ">=1.4.5")).toBe(true);
    expect(semverSatisfies("1.4.3", ">=1.4.5")).toBe(false);
    expect(semverOrder("1.4.5", "1.4.3")).toBe(1);
    expect(semverOrder("1.4.5", "1.4.5")).toBe(0);
    expect(semverOrder("1.4.2", "1.4.5")).toBe(-1);
  });

  it("parseJsonl, parseJsonlChunk, indexOfLine, and createByteSink work natively", () => {
    const items = parseJsonl<{ id: number }>('{"id":1}\n{"id":2}\n');
    expect(items).toEqual([{ id: 1 }, { id: 2 }]);

    const partial = parseJsonlChunk<{ id: number }>('{"id":1}\n{"id":');
    expect(partial.values).toEqual([{ id: 1 }]);
    expect(partial.done).toBe(false);
    expect(partial.read).toBeGreaterThan(0);

    const bytes = new TextEncoder().encode("line1\nline2\n");
    expect(indexOfLine(bytes)).toBe(5);
    expect(indexOfLine(bytes, 6)).toBe(11);

    const sink = createByteSink();
    sink.write(new Uint8Array([65, 66]));
    sink.write("CD");
    expect(Array.from(sink.end() as Uint8Array)).toEqual([65, 66, 67, 68]);
  });

  it("embedded-files helpers normalize Windows/leading slashes, reject traversal, and prefer exact over suffix matches", () => {
    expect(typeof isStandaloneExecutable()).toBe("boolean");
    expect(Array.isArray(listEmbeddedFiles())).toBe(true);

    const nestedFile = new File(["nested"], "public/assets/app.css", {
      type: "text/css",
    });
    const exactFile = new File(["exact"], "assets/app.css", {
      type: "text/css",
    });

    expect(findEmbeddedFile("./public/assets/app.css", [nestedFile])).toBe(
      nestedFile,
    );
    expect(findEmbeddedFile("././public\\assets\\app.css", [nestedFile])).toBe(
      nestedFile,
    );
    expect(findEmbeddedFile("/./public/assets/app.css", [nestedFile])).toBe(
      nestedFile,
    );
    expect(findEmbeddedFile("assets/app.css", [nestedFile])).toBe(nestedFile);
    // Exact match wins over earlier suffix match
    expect(findEmbeddedFile("assets/app.css", [nestedFile, exactFile])).toBe(
      exactFile,
    );
    // Path traversal segments must be rejected
    expect(findEmbeddedFile("../public/assets/app.css", [nestedFile])).toBeUndefined();
    expect(findEmbeddedFile("public/../public/assets/app.css", [nestedFile])).toBeUndefined();
    expect(findEmbeddedFile("missing.css", [nestedFile])).toBeUndefined();
  });

  it("detectMagicMimeType detects valid BMP, TIFF, AVIF, HEIC, MP4 without false-positive BMP on 'BM...' text", async () => {
    expect(detectMagicMimeType(VALID_BMP_HEADER)).toBe("image/bmp");

    // Plain UTF-8 text starting with "BM" must NOT be misclassified as image/bmp
    const bmText = new TextEncoder().encode("BMW is a car\n");
    expect(detectMagicMimeType(bmText)).toBe("text/plain");
    const textValidator = new FileTypeValidator({ fileType: "text/plain" });
    expect(
      await textValidator.isValid({
        fieldname: "doc",
        originalname: "cars.txt",
        encoding: "7bit",
        mimetype: "text/plain",
        size: bmText.byteLength,
        buffer: bmText,
        file: new File([bmText], "cars.txt", { type: "text/plain" }),
      }),
    ).toBe(true);

    expect(detectMagicMimeType(new Uint8Array([0x49, 0x49, 0x2a, 0x00]))).toBe(
      "image/tiff",
    );
    const avif = new Uint8Array([
      0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66,
    ]);
    expect(detectMagicMimeType(avif)).toBe("image/avif");
    const heic = new Uint8Array([
      0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63,
    ]);
    expect(detectMagicMimeType(heic)).toBe("image/heic");
    const mp4 = new Uint8Array([
      0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
    ]);
    expect(detectMagicMimeType(mp4)).toBe("video/mp4");
  });

  it("ImageDimensionsValidator covers all dimension/aspect/error/fallback branches via Bun.Image", async () => {
    const file1x1: UploadedFileInfo = {
      fieldname: "avatar",
      originalname: "pixel.png",
      encoding: "7bit",
      mimetype: "image/png",
      size: PNG_1X1.byteLength,
      buffer: PNG_1X1,
      file: new File([PNG_1X1], "pixel.png", { type: "image/png" }),
    };

    const file2x1: UploadedFileInfo = {
      fieldname: "banner",
      originalname: "banner.png",
      encoding: "7bit",
      mimetype: "image/png",
      size: PNG_2X1.byteLength,
      buffer: PNG_2X1,
      file: new File([PNG_2X1], "banner.png", { type: "image/png" }),
    };

    const okValidator = new ImageDimensionsValidator({
      minWidth: 1,
      maxWidth: 10,
      minHeight: 1,
      maxHeight: 10,
      formats: ["png"],
      aspectRatio: 1,
    });
    expect(await okValidator.isValid(file1x1)).toBe(true);

    // minWidth / maxWidth / minHeight / maxHeight failures
    const tooSmallW = new ImageDimensionsValidator({ minWidth: 16 });
    expect(await tooSmallW.isValid(file1x1)).toBe(false);
    expect(tooSmallW.buildErrorMessage(file1x1)).toContain("minimum 16px");

    const tooWide = new ImageDimensionsValidator({ maxWidth: 1 });
    expect(await tooWide.isValid(file2x1)).toBe(false);
    expect(tooWide.buildErrorMessage(file2x1)).toContain("exceeds maximum 1px");

    const tooShort = new ImageDimensionsValidator({ minHeight: 5 });
    expect(await tooShort.isValid(file1x1)).toBe(false);
    expect(tooShort.buildErrorMessage(file1x1)).toContain("height 1px is less than minimum 5px");

    const tooTall = new ImageDimensionsValidator({ maxHeight: 0 });
    expect(await tooTall.isValid(file1x1)).toBe(false);
    expect(tooTall.buildErrorMessage(file1x1)).toContain("height 1px exceeds maximum 0px");

    // Format failure
    const badFormat = new ImageDimensionsValidator({ formats: ["webp"] });
    expect(await badFormat.isValid(file1x1)).toBe(false);
    expect(badFormat.buildErrorMessage(file1x1)).toContain('"png"');

    // Exact numeric aspectRatio mismatch
    const exactRatio = new ImageDimensionsValidator({ aspectRatio: 1.5 });
    expect(await exactRatio.isValid(file2x1)).toBe(false);
    expect(exactRatio.buildErrorMessage(file2x1)).toContain("aspect ratio");

    // Range aspectRatio with tolerance pass & fail
    const rangePass = new ImageDimensionsValidator({
      aspectRatio: { min: 1.9, max: 2.1, tolerance: 0.05 },
    });
    expect(await rangePass.isValid(file2x1)).toBe(true);

    const rangeBelow = new ImageDimensionsValidator({
      aspectRatio: { min: 2.5, tolerance: 0.1 },
    });
    expect(await rangeBelow.isValid(file2x1)).toBe(false);
    expect(rangeBelow.buildErrorMessage(file2x1)).toContain("below minimum 2.5");

    const rangeAbove = new ImageDimensionsValidator({
      aspectRatio: { max: 1.5, tolerance: 0.1 },
    });
    expect(await rangeAbove.isValid(file2x1)).toBe(false);
    expect(rangeAbove.buildErrorMessage(file2x1)).toContain("exceeds maximum 1.5");

    // Fallback to `file.file` when `buffer` is empty
    const fileOnly: UploadedFileInfo = {
      fieldname: "avatar",
      originalname: "pixel.png",
      encoding: "7bit",
      mimetype: "image/png",
      size: PNG_1X1.byteLength,
      buffer: new Uint8Array(0),
      file: new File([PNG_1X1], "pixel.png", { type: "image/png" }),
    };
    expect(await okValidator.isValid(fileOnly)).toBe(true);

    // Empty buffer failure (and empty file)
    const emptyFile: UploadedFileInfo = {
      fieldname: "avatar",
      originalname: "empty.png",
      encoding: "7bit",
      mimetype: "image/png",
      size: 0,
      buffer: new Uint8Array(0),
      file: new File([], "empty.png", { type: "image/png" }),
    };
    expect(await okValidator.isValid(emptyFile)).toBe(false);
    expect(okValidator.buildErrorMessage(emptyFile)).toContain("empty or unavailable");

    // Malformed image bytes
    const badFile: UploadedFileInfo = {
      ...file1x1,
      buffer: new TextEncoder().encode("not an image"),
    };
    expect(await okValidator.isValid(badFile)).toBe(false);
    expect(okValidator.buildErrorMessage(badFile)).toContain(
      "not a valid supported image",
    );

    // Custom errorMessage string and factory
    const customStr = new ImageDimensionsValidator({
      minWidth: 100,
      errorMessage: "custom image error",
    });
    expect(await customStr.isValid(file1x1)).toBe(false);
    expect(customStr.buildErrorMessage(file1x1)).toBe("custom image error");

    const customFn = new ImageDimensionsValidator({
      minWidth: 100,
      errorMessage: ({ file, config }) =>
        `${file?.originalname}: need >= ${config.minWidth}px`,
    });
    expect(await customFn.isValid(file1x1)).toBe(false);
    expect(customFn.buildErrorMessage(file1x1)).toBe("pixel.png: need >= 100px");
  });

  it("readAgentErrorTracesFromFile recovers from malformed, truncated, CRLF, blank, and non-object JSONL lines", async () => {
    const tmpPath = join(
      "/tmp",
      `bunest-jsonl-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`,
    );
    await Bun.write(
      tmpPath,
      [
        "MALFORMED_FIRST_LINE",
        "",
        "   ",
        JSON.stringify({ id: "t1", message: "first" }),
        '{"truncated_unclosed":',
        "{broken-json-line",
        "123",
        "null",
        '"plain-string"',
        "[1, 2, 3]",
        `${JSON.stringify({ id: "t2", message: "second" })} TRAILING_GARBAGE`,
        JSON.stringify({ id: "t3", message: "third" }),
        '{"eof_no_newline_broken":',
      ].join("\r\n"),
    );
    try {
      const traces = await readAgentErrorTracesFromFile(tmpPath, 10);
      expect(traces.map((t) => t.id)).toEqual(["t3", "t2", "t1"]);

      const limited = await readAgentErrorTracesFromFile(tmpPath, 2);
      expect(limited.map((t) => t.id)).toEqual(["t3", "t2"]);
    } finally {
      await Bun.file(tmpPath).delete().catch(() => {});
    }
  });

  it("runSubprocess handles normal exit, non-zero exit, stdin piping, and SIGKILL timeout on SIGTERM-trapping process", async () => {
    const okRes = await runSubprocess([
      process.execPath,
      "-e",
      "console.log('hello-sub')",
    ]);
    expect(okRes.exitCode).toBe(0);
    expect(okRes.timedOut).toBe(false);
    expect(okRes.stdout.trim()).toBe("hello-sub");

    const failRes = await runSubprocess([
      process.execPath,
      "-e",
      "console.error('boom'); process.exit(2)",
    ]);
    expect(failRes.exitCode).toBe(2);
    expect(failRes.timedOut).toBe(false);
    expect(failRes.stderr.trim()).toBe("boom");

    const stdinRes = await runSubprocess(
      [
        process.execPath,
        "-e",
        "const text = await Bun.stdin.text(); console.log(text.toUpperCase())",
      ],
      { stdin: "piped-input" },
    );
    expect(stdinRes.exitCode).toBe(0);
    expect(stdinRes.timedOut).toBe(false);
    expect(stdinRes.stdout.trim()).toBe("PIPED-INPUT");

    // Process ignoring SIGTERM must still be terminated cleanly by SIGKILL timeout
    const started = Date.now();
    const timeoutRes = await runSubprocess(
      [
        process.execPath,
        "-e",
        'process.on("SIGTERM", () => {}); await Bun.sleep(5000)',
      ],
      { timeoutMs: 100 },
    );
    expect(timeoutRes.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
