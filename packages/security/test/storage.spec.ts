import "reflect-metadata";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Injectable } from "@bunest/common";
import { Test } from "@bunest/testing";
import {
  InjectStorage,
  LocalStorageAdapter,
  MemoryStorageAdapter,
  S3StorageAdapter,
  StorageModule,
  StoragePathTraversalException,
  type S3ClientLike,
  type StorageAdapter,
} from "../src";

describe("StorageModule & Adapters (Local, Memory, S3)", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reads, writes, stats, and deletes nested files in LocalStorageAdapter and blocks all path-traversal attacks", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "bunest-storage-"));
    tempDirs.push(rootDir);

    const adapter = new LocalStorageAdapter({ rootDir });

    const stat = await adapter.put("avatars/2026/user-1.txt", "hello bunest", {
      contentType: "text/plain",
    });
    expect(stat.key).toBe("avatars/2026/user-1.txt");
    expect(stat.size).toBe(12);
    expect(await adapter.exists("avatars/2026/user-1.txt")).toBe(true);

    const obj = await adapter.get("avatars/2026/user-1.txt");
    expect(obj).not.toBeNull();
    expect(new TextDecoder().decode(obj!.body)).toBe("hello bunest");

    const info = await adapter.stat("avatars/2026/user-1.txt");
    expect(info?.size).toBe(12);

    expect(await adapter.delete("avatars/2026/user-1.txt")).toBe(true);
    expect(await adapter.delete("avatars/2026/user-1.txt")).toBe(false);
    expect(await adapter.get("avatars/2026/user-1.txt")).toBeNull();

    // Path traversal & invalid key attacks MUST all fail with StoragePathTraversalException
    const maliciousKeys = [
      "../secret.txt",
      "avatars/../../secret.txt",
      "..\\secret.txt",
      "avatars\\..\\..\\secret.txt",
      "/etc/passwd",
      "\\windows\\system32\\config",
      "C:\\Windows\\win.ini",
      "nested/file.txt:hiddenstream",
      "nested/C:drive.txt",
      "file\0.png",
      ".",
      "..",
      "",
      "   ",
    ];

    for (const badKey of maliciousKeys) {
      await expect(adapter.put(badKey, "pwn")).rejects.toThrow(
        StoragePathTraversalException,
      );
      await expect(adapter.get(badKey)).rejects.toThrow(
        StoragePathTraversalException,
      );
      await expect(adapter.delete(badKey)).rejects.toThrow(
        StoragePathTraversalException,
      );
      await expect(adapter.exists(badKey)).rejects.toThrow(
        StoragePathTraversalException,
      );
    }
  });

  it("supports MemoryStorageAdapter with defensive buffer copies and signed URLs", async () => {
    const adapter = new MemoryStorageAdapter();
    const source = new Uint8Array([1, 2, 3, 4]);
    await adapter.put("docs/bin.dat", source, {
      contentType: "application/octet-stream",
      metadata: { owner: "alice" },
    });

    // Mutating caller buffer does NOT mutate stored data
    source[0] = 99;
    const fetched = await adapter.get("docs/bin.dat");
    expect(Array.from(fetched!.body)).toEqual([1, 2, 3, 4]);
    expect(fetched!.metadata).toEqual({ owner: "alice" });
    expect(await adapter.getSignedUrl("docs/bin.dat", { expiresInSeconds: 60 })).toContain(
      "docs/bin.dat",
    );
    expect(adapter.listKeys()).toEqual(["docs/bin.dat"]);
    expect(await adapter.delete("docs/bin.dat")).toBe(true);
    expect(await adapter.exists("docs/bin.dat")).toBe(false);
  });

  it("supports S3StorageAdapter with prefixing, presigned URLs, and StorageModule DI", async () => {
    const bucket = new Map<string, { data: Uint8Array; type?: string }>();
    const fakeS3Client: S3ClientLike = {
      async write(key, data, opts) {
        const bytes =
          data instanceof Uint8Array
            ? new Uint8Array(data)
            : new TextEncoder().encode(String(data));
        bucket.set(key, { data: bytes, type: opts?.type });
        return bytes.byteLength;
      },
      file(key) {
        return {
          get type() {
            return bucket.get(key)?.type;
          },
          get size() {
            return bucket.get(key)?.data.byteLength;
          },
          async exists() {
            return bucket.has(key);
          },
          async arrayBuffer() {
            const d = bucket.get(key)!.data;
            return d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) as ArrayBuffer;
          },
          async delete() {
            bucket.delete(key);
          },
        };
      },
      presign(key, opts) {
        return `https://s3.test/${key}?method=${opts?.method ?? "GET"}&exp=${opts?.expiresIn ?? 300}`;
      },
    };

    @Injectable()
    class UploadService {
      constructor(@InjectStorage() public readonly storage: StorageAdapter) {}
    }

    const mod = await Test.createTestingModule({
      imports: [
        StorageModule.forRootAsync({
          useFactory: () => ({
            driver: "s3",
            client: fakeS3Client,
            prefix: "uploads",
          }),
        }),
      ],
      providers: [UploadService],
    }).compile();

    const svc = mod.get(UploadService);
    expect(svc.storage).toBeInstanceOf(S3StorageAdapter);

    await svc.storage.put("img/logo.svg", "<svg/>", {
      contentType: "image/svg+xml",
    });
    expect(bucket.has("uploads/img/logo.svg")).toBe(true);

    const obj = await svc.storage.get("img/logo.svg");
    expect(new TextDecoder().decode(obj!.body)).toBe("<svg/>");
    expect(await svc.storage.getSignedUrl!("img/logo.svg")).toBe(
      "https://s3.test/uploads/img/logo.svg?method=GET&exp=300",
    );
    expect(await svc.storage.delete("img/logo.svg")).toBe(true);
    expect(await svc.storage.exists("img/logo.svg")).toBe(false);

    // Path traversal blocked on S3 adapter too
    await expect(svc.storage.put("../escape", "x")).rejects.toThrow(
      StoragePathTraversalException,
    );

    await mod.close();
  });
});
