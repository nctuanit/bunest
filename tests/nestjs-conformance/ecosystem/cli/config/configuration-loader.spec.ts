import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  DEFAULT_CONFIGURATION,
  loadCliConfiguration,
  resolveEntryFile,
  resolveProjectConfiguration,
} from "../../../../../packages/cli/src";
import { describeConformance, itAdapted } from "../../../_helpers/index";

describeConformance(
  "CLI Configuration Loader (bunest.json / nest-cli.json)",
  {
    upstreamPath:
      "nest-cli/test/lib/configuration/nest-configuration.loader.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Adapts NestJS NestConfigurationLoader specs to Bunest's zero-dependency `loadCliConfiguration`, `resolveProjectConfiguration`, and `resolveEntryFile`.",
  },
  () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "bunest-cli-conf-loader-"));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    itAdapted(
      ["ADR-001"],
      "should prefer bunest.json over .bunestrc.json, nest-cli.json, and .nestcli.json when auto-discovering",
      async () => {
        writeFileSync(
          join(tmpDir, "nest-cli.json"),
          JSON.stringify({ sourceRoot: "from-nest" }),
          "utf8",
        );
        const fromNest = await loadCliConfiguration(tmpDir);
        expect(fromNest.found).toBe(true);
        expect(fromNest.configPath).toBe(join(tmpDir, "nest-cli.json"));
        expect(fromNest.config.sourceRoot).toBe("from-nest");

        writeFileSync(
          join(tmpDir, "bunest.json"),
          JSON.stringify({ sourceRoot: "from-bunest" }),
          "utf8",
        );
        const fromBunest = await loadCliConfiguration(tmpDir);
        expect(fromBunest.found).toBe(true);
        expect(fromBunest.configPath).toBe(join(tmpDir, "bunest.json"));
        expect(fromBunest.config.sourceRoot).toBe("from-bunest");
      },
    );

    it("should also discover .bunestrc.json and .nestcli.json fallbacks", async () => {
      const dirA = mkdtempSync(join(tmpdir(), "bunest-cli-conf-rc-"));
      const dirB = mkdtempSync(join(tmpdir(), "bunest-cli-conf-nestcli-"));
      try {
        writeFileSync(
          join(dirA, ".bunestrc.json"),
          JSON.stringify({ entryFile: "rc-entry" }),
          "utf8",
        );
        const resA = await loadCliConfiguration(dirA);
        expect(resA.found).toBe(true);
        expect(resA.config.entryFile).toBe("rc-entry");

        writeFileSync(
          join(dirB, ".nestcli.json"),
          JSON.stringify({ entryFile: "legacy-entry" }),
          "utf8",
        );
        const resB = await loadCliConfiguration(dirB);
        expect(resB.found).toBe(true);
        expect(resB.config.entryFile).toBe("legacy-entry");
      } finally {
        rmSync(dirA, { recursive: true, force: true });
        rmSync(dirB, { recursive: true, force: true });
      }
    });

    // BUNEST_BUG: DEFAULT_CONFIG_FILENAMES checks `.nestcli.json` (no hyphen) instead of NestJS's `.nest-cli.json` (with hyphen), so `.nest-cli.json` is ignored during auto-discovery (packages/cli/src/config/configuration.loader.ts:166-171)
    it.skip("should auto-discover hyphenated .nest-cli.json fallback", async () => {
      writeFileSync(
        join(tmpDir, ".nest-cli.json"),
        JSON.stringify({ entryFile: "hyphen-entry" }),
        "utf8",
      );
      const loaded = await loadCliConfiguration(tmpDir);
      expect(loaded.found).toBe(true);
      expect(loaded.config.entryFile).toBe("hyphen-entry");
    });

    it("should load an explicit configuration filename when provided and throw when missing", async () => {
      writeFileSync(
        join(tmpDir, "nest-cli.secondary.config.json"),
        JSON.stringify({
          language: "ts",
          collection: "@bunest/schematics",
          entryFile: "secondary",
        }),
        "utf8",
      );

      const loaded = await loadCliConfiguration(
        tmpDir,
        "nest-cli.secondary.config.json",
      );
      expect(loaded.found).toBe(true);
      expect(loaded.configPath).toBe(
        resolve(tmpDir, "nest-cli.secondary.config.json"),
      );
      expect(loaded.config).toEqual({
        language: "ts",
        collection: "@bunest/schematics",
        sourceRoot: "src",
        entryFile: "secondary",
        compilerOptions: {
          deleteOutDir: false,
          assets: [],
          plugins: [],
        },
        generateOptions: {
          spec: true,
          flat: false,
          specFileSuffix: "spec",
        },
      });

      await expect(
        loadCliConfiguration(tmpDir, "does-not-exist.json"),
      ).rejects.toThrow(/Configuration file not found/);
    });

    it("should return isolated default copies when no config file exists", async () => {
      const loaded = await loadCliConfiguration(tmpDir);
      expect(loaded.found).toBe(false);
      expect(loaded.configPath).toBeUndefined();
      expect(loaded.config).toEqual(DEFAULT_CONFIGURATION);
      expect(loaded.config.compilerOptions).not.toBe(
        DEFAULT_CONFIGURATION.compilerOptions,
      );
      expect(loaded.config.generateOptions).not.toBe(
        DEFAULT_CONFIGURATION.generateOptions,
      );
    });

    it("should deep-merge compilerOptions with defaults", async () => {
      writeFileSync(
        join(tmpDir, "compiler-opts-test.json"),
        JSON.stringify({
          compilerOptions: {
            plugins: ["my-plugin"],
          },
        }),
        "utf8",
      );

      const { config } = await loadCliConfiguration(
        tmpDir,
        "compiler-opts-test.json",
      );
      expect(config.compilerOptions).toEqual({
        deleteOutDir: false,
        assets: [],
        plugins: ["my-plugin"],
      });
    });

    it("should deep-merge generateOptions with defaults", async () => {
      writeFileSync(
        join(tmpDir, "generate-opts-test.json"),
        JSON.stringify({
          generateOptions: {
            spec: false,
          },
        }),
        "utf8",
      );

      const { config } = await loadCliConfiguration(
        tmpDir,
        "generate-opts-test.json",
      );
      expect(config.generateOptions).toEqual({
        spec: false,
        flat: false,
        specFileSuffix: "spec",
      });
    });

    it("should preserve all generateOptions fields when merging", async () => {
      writeFileSync(
        join(tmpDir, "all-generate-opts-test.json"),
        JSON.stringify({
          generateOptions: {
            spec: false,
            flat: true,
            specFileSuffix: "test",
            baseDir: "src",
          },
        }),
        "utf8",
      );

      const { config } = await loadCliConfiguration(
        tmpDir,
        "all-generate-opts-test.json",
      );
      expect(config.generateOptions).toEqual({
        spec: false,
        flat: true,
        specFileSuffix: "test",
        baseDir: "src",
      });
    });

    it("should deep-merge both compilerOptions and generateOptions simultaneously", async () => {
      writeFileSync(
        join(tmpDir, "both-opts-test.json"),
        JSON.stringify({
          compilerOptions: { deleteOutDir: true },
          generateOptions: { flat: true },
        }),
        "utf8",
      );

      const { config } = await loadCliConfiguration(
        tmpDir,
        "both-opts-test.json",
      );
      expect(config.compilerOptions).toEqual({
        deleteOutDir: true,
        assets: [],
        plugins: [],
      });
      expect(config.generateOptions).toEqual({
        spec: true,
        flat: true,
        specFileSuffix: "spec",
      });
    });

    it("should reject invalid JSON and non-object JSON config files", async () => {
      writeFileSync(join(tmpDir, "broken.json"), "{ invalid json", "utf8");
      await expect(
        loadCliConfiguration(tmpDir, "broken.json"),
      ).rejects.toThrow(/Invalid JSON/);

      writeFileSync(join(tmpDir, "array.json"), "[1, 2, 3]", "utf8");
      await expect(loadCliConfiguration(tmpDir, "array.json")).rejects.toThrow(
        /must export a JSON object/,
      );
    });

    it("should resolve named projects and entry files cleanly", async () => {
      const cfg = {
        sourceRoot: "server",
        entryFile: "boot",
        projects: {
          api: { type: "application", sourceRoot: "apps/api/src" },
          worker: { type: "application", sourceRoot: "apps/worker/src" },
        },
      };

      expect(resolveProjectConfiguration(cfg)).toBeUndefined();
      expect(resolveProjectConfiguration(cfg, "api")?.sourceRoot).toBe(
        "apps/api/src",
      );
      expect(() => resolveProjectConfiguration(cfg, "unknown")).toThrow(
        /Unknown project "unknown".*Available projects: api, worker/,
      );

      mkdirSync(join(tmpDir, "server"), { recursive: true });
      writeFileSync(join(tmpDir, "server", "boot.ts"), "", "utf8");
      writeFileSync(join(tmpDir, "server", "alt.ts"), "", "utf8");

      expect(await resolveEntryFile(tmpDir, cfg)).toBe(
        resolve(tmpDir, "server", "boot.ts"),
      );
      expect(await resolveEntryFile(tmpDir, cfg, { entryFile: "alt" })).toBe(
        resolve(tmpDir, "server", "alt.ts"),
      );
      expect(
        await resolveEntryFile(tmpDir, cfg, { entry: "server/alt" }),
      ).toBe(resolve(tmpDir, "server", "alt.ts"));
    });
  },
);
