import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  join,
  mkdirSyncPath,
  removePath,
  resolve,
  writeTextSync,
} from "../../../../../packages/core/src";
import {
  DEFAULT_CONFIGURATION,
  loadCliConfiguration,
  resolveEntryFile,
  resolveProjectConfiguration,
} from "../../../../../packages/cli/src";
import { describeConformance, itAdapted } from "../../../_helpers/index";

function makeTempDir(prefix: string): string {
  const dir = join(
    Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp",
    `${prefix}${crypto.randomUUID()}`,
  );
  mkdirSyncPath(dir, { recursive: true });
  return dir;
}

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
      tmpDir = makeTempDir("bunest-cli-conf-loader-");
    });

    afterEach(async () => {
      await removePath(tmpDir, { recursive: true, force: true });
    });

    itAdapted(
      ["ADR-001"],
      "should prefer bunest.json over .bunestrc.json, nest-cli.json, and .nestcli.json when auto-discovering",
      async () => {
        writeTextSync(join(tmpDir, "nest-cli.json"), JSON.stringify({ sourceRoot: "from-nest" }));
        const fromNest = await loadCliConfiguration(tmpDir);
        expect(fromNest.found).toBe(true);
        expect(fromNest.configPath).toBe(join(tmpDir, "nest-cli.json"));
        expect(fromNest.config.sourceRoot).toBe("from-nest");

        writeTextSync(join(tmpDir, "bunest.json"), JSON.stringify({ sourceRoot: "from-bunest" }));
        const fromBunest = await loadCliConfiguration(tmpDir);
        expect(fromBunest.found).toBe(true);
        expect(fromBunest.configPath).toBe(join(tmpDir, "bunest.json"));
        expect(fromBunest.config.sourceRoot).toBe("from-bunest");
      },
    );

    it("should also discover .bunestrc.json and .nestcli.json fallbacks", async () => {
      const dirA = makeTempDir("bunest-cli-conf-rc-");
      const dirB = makeTempDir("bunest-cli-conf-nestcli-");
      try {
        writeTextSync(join(dirA, ".bunestrc.json"), JSON.stringify({ entryFile: "rc-entry" }));
        const resA = await loadCliConfiguration(dirA);
        expect(resA.found).toBe(true);
        expect(resA.config.entryFile).toBe("rc-entry");

        writeTextSync(join(dirB, ".nestcli.json"), JSON.stringify({ entryFile: "legacy-entry" }));
        const resB = await loadCliConfiguration(dirB);
        expect(resB.found).toBe(true);
        expect(resB.config.entryFile).toBe("legacy-entry");
      } finally {
        await removePath(dirA, { recursive: true, force: true });
        await removePath(dirB, { recursive: true, force: true });
      }
    });

    it("should auto-discover hyphenated .nest-cli.json fallback", async () => {
      writeTextSync(join(tmpDir, ".nest-cli.json"), JSON.stringify({ entryFile: "hyphen-entry" }));
      const loaded = await loadCliConfiguration(tmpDir);
      expect(loaded.found).toBe(true);
      expect(loaded.config.entryFile).toBe("hyphen-entry");
    });

    it("should load an explicit configuration filename when provided and throw when missing", async () => {
      writeTextSync(join(tmpDir, "nest-cli.secondary.config.json"), JSON.stringify({
          language: "ts",
          collection: "@bunest/schematics",
          entryFile: "secondary",
        }));

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
      writeTextSync(join(tmpDir, "compiler-opts-test.json"), JSON.stringify({
          compilerOptions: {
            plugins: ["my-plugin"],
          },
        }));

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
      writeTextSync(join(tmpDir, "generate-opts-test.json"), JSON.stringify({
          generateOptions: {
            spec: false,
          },
        }));

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
      writeTextSync(join(tmpDir, "all-generate-opts-test.json"), JSON.stringify({
          generateOptions: {
            spec: false,
            flat: true,
            specFileSuffix: "test",
            baseDir: "src",
          },
        }));

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
      writeTextSync(join(tmpDir, "both-opts-test.json"), JSON.stringify({
          compilerOptions: { deleteOutDir: true },
          generateOptions: { flat: true },
        }));

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
      writeTextSync(join(tmpDir, "broken.json"), "{ invalid json");
      await expect(loadCliConfiguration(tmpDir, "broken.json")).rejects.toThrow(
        /Invalid JSON/,
      );

      writeTextSync(join(tmpDir, "array.json"), "[1, 2, 3]");
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

      mkdirSyncPath(join(tmpDir, "server"), { recursive: true });
      writeTextSync(join(tmpDir, "server", "boot.ts"), "");
      writeTextSync(join(tmpDir, "server", "alt.ts"), "");

      expect(await resolveEntryFile(tmpDir, cfg)).toBe(
        resolve(tmpDir, "server", "boot.ts"),
      );
      expect(await resolveEntryFile(tmpDir, cfg, { entryFile: "alt" })).toBe(
        resolve(tmpDir, "server", "alt.ts"),
      );
      expect(await resolveEntryFile(tmpDir, cfg, { entry: "server/alt" })).toBe(
        resolve(tmpDir, "server", "alt.ts"),
      );
    });
  },
);
