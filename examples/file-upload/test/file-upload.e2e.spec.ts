import { describe, expect, it } from "bun:test";
import { Test } from "@bunest/testing";
import { createFileUploadModule } from "../src/app.module";
import type { StoredFileMeta } from "../src/files/files.service";

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

describe("File Upload & Storage (NestJS 29-file-upload E2E)", () => {
  it("validates PNG magic bytes with ParseFilePipeBuilder, uploads multiple files, lists, and serves downloads", async () => {
    const mod = await Test.createTestingModule({
      imports: [createFileUploadModule()],
    }).compile();

    const app = mod.createBunestApplication();
    await app.init();

    try {
      // 1. Valid PNG upload with multipart form label -> 201
      const validForm = new FormData();
      validForm.append(
        "file",
        new File([PNG_BYTES], "avatar.png", { type: "image/png" }),
      );
      validForm.append("label", "profile-pic");

      const okRes = await app.fetch(
        new Request("http://localhost/files/upload", {
          method: "POST",
          body: validForm,
        }),
      );
      expect(okRes.status).toBe(201);
      const uploaded = (await okRes.json()) as StoredFileMeta;
      expect(uploaded).toEqual({
        key: "avatar.png",
        originalname: "avatar.png",
        mimetype: "image/png",
        size: PNG_BYTES.byteLength,
        label: "profile-pic",
      });

      // 2. Spoofed non-PNG payload rejected by ParseFilePipeBuilder magic-byte validator -> 400
      const spoofedForm = new FormData();
      spoofedForm.append(
        "file",
        new File(["not-actually-a-png"], "fake.png", { type: "image/png" }),
      );
      const badRes = await app.fetch(
        new Request("http://localhost/files/upload", {
          method: "POST",
          body: spoofedForm,
        }),
      );
      expect(badRes.status).toBe(400);

      // 3. Multiple files upload -> 201
      const multiForm = new FormData();
      multiForm.append(
        "files",
        new File(["hello note 1"], "note1.txt", { type: "text/plain" }),
      );
      multiForm.append(
        "files",
        new File(["hello note 2"], "note2.txt", { type: "text/plain" }),
      );
      const multiRes = await app.fetch(
        new Request("http://localhost/files/uploads", {
          method: "POST",
          body: multiForm,
        }),
      );
      expect(multiRes.status).toBe(201);
      const multiBody = (await multiRes.json()) as {
        count: number;
        files: StoredFileMeta[];
      };
      expect(multiBody.count).toBe(2);

      // 4. List & download stored file
      const listRes = await app.fetch(new Request("http://localhost/files"));
      expect(listRes.status).toBe(200);
      const { keys } = (await listRes.json()) as { keys: string[] };
      expect(keys).toContain("avatar.png");
      expect(keys).toContain("note1.txt");
      expect(keys).toContain("note2.txt");

      const dlRes = await app.fetch(
        new Request("http://localhost/files/note1.txt"),
      );
      expect(dlRes.status).toBe(200);
      expect(await dlRes.text()).toBe("hello note 1");
    } finally {
      await app.close();
    }
  });
});
