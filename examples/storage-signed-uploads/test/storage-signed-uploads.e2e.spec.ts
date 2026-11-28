import { describe, expect, it } from "bun:test";
import { Test } from "@bunest/testing";
import { createStorageSignedUploadsModule } from "../src/app.module";

// Minimal valid 1x1 PNG (IHDR + IDAT + IEND)
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

describe("Production Storage & Signed Uploads (E2E)", () => {
  it("issues signed upload URLs, enforces content-type/length, inspects PNG dimensions, and serves signed downloads with Range 206 & ETag 304", async () => {
    const mod = await Test.createTestingModule({
      imports: [createStorageSignedUploadsModule()],
    }).compile();

    const app = mod.createBunestApplication();
    await app.init();

    try {
      // 1. Request pre-signed upload URL for PNG
      const presignRes = await app.fetch(
        new Request("http://localhost/storage/presign-upload", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            key: "banner.png",
            contentType: "image/png",
            contentLength: TINY_PNG.byteLength,
          }),
        }),
      );
      expect(presignRes.status).toBe(201);
      const { uploadUrl } = (await presignRes.json()) as { uploadUrl: string };
      expect(uploadUrl).toContain("/storage/signed");

      // 2. Spoofed content-type rejected with 403
      const badTypeRes = await app.fetch(
        new Request(uploadUrl, {
          method: "PUT",
          headers: {
            "content-type": "text/html",
            "content-length": String(TINY_PNG.byteLength),
          },
          body: TINY_PNG,
        }),
      );
      expect(badTypeRes.status).toBe(403);

      // 3. Valid signed PUT uploads bytes and returns inspected PNG dimensions
      const uploadRes = await app.fetch(
        new Request(uploadUrl, {
          method: "PUT",
          headers: {
            "content-type": "image/png",
            "content-length": String(TINY_PNG.byteLength),
          },
          body: TINY_PNG,
        }),
      );
      expect(uploadRes.status).toBe(200);
      const uploaded = (await uploadRes.json()) as {
        key: string;
        size: number;
        etag: string;
        image?: { format: string; width: number; height: number };
      };
      expect(uploaded.key).toBe("banner.png");
      expect(uploaded.size).toBe(TINY_PNG.byteLength);
      expect(uploaded.image).toMatchObject({
        format: "png",
        width: 1,
        height: 1,
      });

      // 4. Request signed download URL & stream with Range 206 + ETag 304
      const signDlRes = await app.fetch(
        new Request("http://localhost/storage/presign-download", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ key: "banner.png" }),
        }),
      );
      expect(signDlRes.status).toBe(201);
      const { downloadUrl } = (await signDlRes.json()) as {
        downloadUrl: string;
      };

      const rangeRes = await app.fetch(
        new Request(downloadUrl, {
          headers: { range: "bytes=0-7" },
        }),
      );
      expect(rangeRes.status).toBe(206);
      expect(rangeRes.headers.get("content-range")).toBe(
        `bytes 0-7/${TINY_PNG.byteLength}`,
      );
      expect(new Uint8Array(await rangeRes.arrayBuffer())).toEqual(
        TINY_PNG.subarray(0, 8),
      );

      const etagRes = await app.fetch(
        new Request(downloadUrl, {
          headers: { "if-none-match": uploaded.etag },
        }),
      );
      expect(etagRes.status).toBe(304);

      // 5. Tampered signature rejected with 403
      const tamperedRes = await app.fetch(
        new Request(`${downloadUrl}tampered`),
      );
      expect(tamperedRes.status).toBe(403);
    } finally {
      await app.close();
    }
  });
});
