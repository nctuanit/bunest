import { describe, expect, it } from "bun:test";
import {
  ensureDir,
  join,
  removePath,
  resolve,
} from "../../packages/core/src/common/index";
import {
  extractPackageJsonFromTgz,
  loadPublishablePackages,
  loadTarballsFromDir,
  parseUpgradeCliArgs,
} from "../../scripts/verify-upgrade-and-pilots";

/**
 * Builds a minimal valid POSIX ustar `.tgz` archive containing `package/package.json`
 * using only Bun-native APIs (zero `node:*` imports, zero external deps).
 */
function buildMockTgz(manifest: Record<string, unknown>): Uint8Array {
  const encoder = new TextEncoder();
  const payload = encoder.encode(JSON.stringify(manifest, null, 2) + "\n");
  const entryName = "package/package.json";

  const header = new Uint8Array(512);
  const writeString = (offset: number, str: string, maxLen: number): void => {
    const bytes = encoder.encode(str);
    header.set(bytes.subarray(0, maxLen), offset);
  };

  writeString(0, entryName, 100);
  writeString(100, "0000644\0", 8);
  writeString(108, "0000000\0", 8);
  writeString(116, "0000000\0", 8);
  writeString(124, `${payload.length.toString(8).padStart(11, "0")}\0`, 12);
  writeString(136, `${Math.floor(Date.now() / 1000).toString(8).padStart(11, "0")}\0`, 12);
  // Checksum field filled with spaces before computing checksum
  writeString(148, "        ", 8);
  header[156] = 48; // '0' regular file
  writeString(257, "ustar\0", 6);
  writeString(263, "00", 2);

  let checksum = 0;
  for (let i = 0; i < 512; i++) {
    checksum += header[i]!;
  }
  writeString(148, `${checksum.toString(8).padStart(6, "0")}\0 `, 8);

  const paddedPayloadLen = Math.ceil(payload.length / 512) * 512;
  const tar = new Uint8Array(512 + paddedPayloadLen + 1024);
  tar.set(header, 0);
  tar.set(payload, 512);
  // Remaining 1024 bytes are already zeroed (EOF blocks)

  return Bun.gzipSync(tar);
}

describe("verify-upgrade-and-pilots CLI", () => {
  describe("parseUpgradeCliArgs", () => {
    it("returns default versions and undefined paths for empty argv", () => {
      const parsed = parseUpgradeCliArgs([]);
      expect(parsed).toEqual({
        fromVersion: "0.1.0",
        toVersion: "0.1.1-rc.0",
      });
    });

    it("parses all supported --flag=value options and resolves paths", () => {
      const parsed = parseUpgradeCliArgs([
        "--from-tarballs=./artifacts/v0.1.0",
        "--to-tarballs=./artifacts/v0.2.0-rc.1",
        "--from-version=0.1.0",
        "--to-version=0.2.0-rc.1",
        "--output=./reports/upgrade.json",
      ]);

      expect(parsed.fromTarballsDir).toBe(resolve("./artifacts/v0.1.0"));
      expect(parsed.toTarballsDir).toBe(resolve("./artifacts/v0.2.0-rc.1"));
      expect(parsed.fromVersion).toBe("0.1.0");
      expect(parsed.toVersion).toBe("0.2.0-rc.1");
      expect(parsed.outputPath).toBe(resolve("./reports/upgrade.json"));
    });

    it("parses space-separated --flag value options", () => {
      const parsed = parseUpgradeCliArgs([
        "--from-tarballs",
        "./tars-from",
        "--from-version",
        "0.1.0",
        "--to-version",
        "0.1.2",
        "--output",
        "./out.json",
      ]);

      expect(parsed.fromTarballsDir).toBe(resolve("./tars-from"));
      expect(parsed.toTarballsDir).toBeUndefined();
      expect(parsed.fromVersion).toBe("0.1.0");
      expect(parsed.toVersion).toBe("0.1.2");
      expect(parsed.outputPath).toBe(resolve("./out.json"));
    });

    it("rejects empty values, unknown flags, and unexpected positional arguments", () => {
      expect(() => parseUpgradeCliArgs(["--from-tarballs="])).toThrow(
        "requires a non-empty value",
      );
      expect(() => parseUpgradeCliArgs(["--to-version="])).toThrow(
        "requires a non-empty value",
      );
      expect(() => parseUpgradeCliArgs(["--output"])).toThrow(
        "requires a non-empty value",
      );
      expect(() => parseUpgradeCliArgs(["--bogus=123"])).toThrow(
        'Unknown flag "--bogus"',
      );
      expect(() => parseUpgradeCliArgs(["positional"])).toThrow(
        'Unexpected positional argument "positional"',
      );
    });
  });

  describe("loadTarballsFromDir & external tarball validation", () => {
    it("extracts package/package.json from a .tgz buffer", () => {
      const tgz = buildMockTgz({
        name: "@bunest/core",
        version: "0.1.0",
        exports: { ".": "./dist/index.js" },
      });
      const manifest = extractPackageJsonFromTgz(tgz, "bunest-core-0.1.0.tgz");
      expect(manifest.name).toBe("@bunest/core");
      expect(manifest.version).toBe("0.1.0");
    });

    it("fails clearly when the external tarball directory does not exist", async () => {
      const pkgs = await loadPublishablePackages();
      expect(pkgs.length).toBe(19);
      const missingDir = join(
        Bun.env.TMPDIR ?? Bun.env.TEMP ?? Bun.env.TMP ?? "/tmp",
        `bunest-nonexistent-${crypto.randomUUID()}`,
      );

      await expect(loadTarballsFromDir(missingDir, pkgs, "0.1.0")).rejects.toThrow(
        "External tarball directory does not exist",
      );
    });

    it("fails clearly and lists all missing @bunest/* tarballs", async () => {
      const pkgs = await loadPublishablePackages();
      expect(pkgs.length).toBe(19);

      const tmpBase = Bun.env.TMPDIR ?? Bun.env.TEMP ?? Bun.env.TMP ?? "/tmp";
      const tmpDir = join(tmpBase, `bunest-missing-tars-${crypto.randomUUID()}`);
      await ensureDir(tmpDir);

      try {
        // Populate 17 of 19 tarballs, leaving 2 missing
        const missingPkgs = pkgs.slice(0, 2);
        for (const pkg of pkgs.slice(2)) {
          const safeName = pkg.name.replace(/^@/, "").replace(/\//g, "-");
          const tgz = buildMockTgz({ name: pkg.name, version: "0.1.0" });
          await Bun.write(join(tmpDir, `${safeName}-0.1.0.tgz`), tgz);
        }

        let errorMessage = "";
        try {
          await loadTarballsFromDir(tmpDir, pkgs, "0.1.0");
        } catch (err) {
          errorMessage = err instanceof Error ? err.message : String(err);
        }

        expect(errorMessage).toContain("missing 2 of 19 @bunest/* tarballs");
        for (const missingPkg of missingPkgs) {
          expect(errorMessage).toContain(missingPkg.name);
        }
      } finally {
        await removePath(tmpDir, { recursive: true, force: true });
      }
    });

    it("fails clearly when a tarball manifest version does not match expectedVersion", async () => {
      const pkgs = await loadPublishablePackages();
      const tmpBase = Bun.env.TMPDIR ?? Bun.env.TEMP ?? Bun.env.TMP ?? "/tmp";
      const tmpDir = join(tmpBase, `bunest-badver-tars-${crypto.randomUUID()}`);
      await ensureDir(tmpDir);

      try {
        for (const [idx, pkg] of pkgs.entries()) {
          const safeName = pkg.name.replace(/^@/, "").replace(/\//g, "-");
          const manifestVersion = idx === 0 ? "0.9.9" : "0.1.0";
          const tgz = buildMockTgz({ name: pkg.name, version: manifestVersion });
          await Bun.write(join(tmpDir, `${safeName}-0.1.0.tgz`), tgz);
        }

        await expect(loadTarballsFromDir(tmpDir, pkgs, "0.1.0")).rejects.toThrow(
          'manifest version mismatch: expected "0.1.0", found "0.9.9"',
        );
      } finally {
        await removePath(tmpDir, { recursive: true, force: true });
      }
    });

    it("loads all 19 valid @bunest/* tarballs with shasum, integrity, and manifest", async () => {
      const pkgs = await loadPublishablePackages();
      expect(pkgs.length).toBe(19);

      const tmpBase = Bun.env.TMPDIR ?? Bun.env.TEMP ?? Bun.env.TMP ?? "/tmp";
      const tmpDir = join(tmpBase, `bunest-valid-tars-${crypto.randomUUID()}`);
      await ensureDir(tmpDir);

      try {
        for (const pkg of pkgs) {
          const safeName = pkg.name.replace(/^@/, "").replace(/\//g, "-");
          const tgz = buildMockTgz({
            name: pkg.name,
            version: "0.1.0",
            exports: { ".": { import: "./dist/index.js" } },
          });
          await Bun.write(join(tmpDir, `${safeName}-0.1.0.tgz`), tgz);
        }

        const records = await loadTarballsFromDir(tmpDir, pkgs, "0.1.0");
        expect(records.length).toBe(19);

        for (const rec of records) {
          expect(rec.version).toBe("0.1.0");
          expect(rec.tarballFilename).toEndWith("-0.1.0.tgz");
          expect(rec.shasum).toMatch(/^[a-f0-9]{40}$/);
          expect(rec.integrity).toStartWith("sha512-");
          expect(rec.manifest.name).toBe(rec.name);
          expect(rec.manifest.version).toBe("0.1.0");
        }
      } finally {
        await removePath(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
