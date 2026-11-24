import { afterEach, beforeEach, expect, it } from "bun:test";
import {
  existsSyncPath,
  join,
  mkdirSyncPath,
  readTextSync,
  removePath,
} from "../../../../../packages/core/src";
import {
  buildSchematicFiles,
  generateSchematic,
  loadCliConfiguration,
  parseSchematicName,
  resolveSchematicType,
  runCli,
  type CliIO,
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
  "Configuration Schematic Factory",
  {
    upstreamPath:
      "schematics/src/lib/configuration/configuration.factory.test.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Ports upstream @nestjs/schematics configuration factory tests to Bunest CLI configuration schematic (generates bunest.json with @bunest/schematics defaults).",
  },
  () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = makeTempDir("bunest-cli-conf-config-");
    });

    afterEach(async () => {
      await removePath(tempDir, { recursive: true, force: true });
    });

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should support missing project name by using the current working directory instead",
      async () => {
        expect(resolveSchematicType("configuration")).toBe("configuration");
        expect(resolveSchematicType("config")).toBe("configuration");

        const logs: string[] = [];
        const io: CliIO = {
          cwd: tempDir,
          stdout: (msg) => logs.push(msg),
          stderr: (msg) => logs.push(msg),
        };

        const cliRes = await runCli(["g", "configuration"], io);
        expect(cliRes.exitCode).toBe(0);
        expect(existsSyncPath(join(tempDir, "bunest.json"))).toBe(true);

        const parsed = JSON.parse(
          readTextSync(join(tempDir, "bunest.json")),
        ) as Record<string, unknown>;
        expect(parsed).toEqual({
          collection: "@bunest/schematics",
          sourceRoot: "src",
          entryFile: "main",
          compilerOptions: {
            deleteOutDir: true,
            assets: [],
            plugins: [],
          },
          generateOptions: {
            spec: true,
            flat: false,
            specFileSuffix: "spec",
          },
        });

        const loaded = await loadCliConfiguration(tempDir);
        expect(loaded.found).toBe(true);
        expect(loaded.config.collection).toBe("@bunest/schematics");
        expect(loaded.config.sourceRoot).toBe("src");
      },
      "Bunest generates bunest.json with @bunest/schematics collection instead of nest-cli.json",
    );

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should manage a default configuration in an explicit directory",
      async () => {
        const planned = buildSchematicFiles(
          "configuration",
          parseSchematicName("project/bunest"),
          { flat: false, spec: false },
        );
        expect(planned.map((f) => f.relativePath)).toEqual([
          "project/bunest.json",
        ]);

        const result = await generateSchematic({
          schematic: "configuration",
          name: "bunest",
          dir: "project",
          cwd: tempDir,
        });

        expect(result.files.map((f) => f.relativePath)).toEqual([
          "bunest.json",
        ]);
        expect(existsSyncPath(join(tempDir, "project/bunest.json"))).toBe(true);
        expect(
          JSON.parse(
            readTextSync(join(tempDir, "project/bunest.json")),
          ),
        ).toMatchObject({
          collection: "@bunest/schematics",
          sourceRoot: "src",
          entryFile: "main",
        });
      },
      "Explicit dir or nested path places bunest.json under project/",
    );

    it("should manage a default configuration under named project folder", async () => {
      const result = await generateSchematic({
        schematic: "configuration",
        name: "project",
        cwd: tempDir,
      });

      expect(
        result.files.find((f) => f.relativePath === "project/bunest.json"),
      ).toBeDefined();
      expect(existsSyncPath(join(tempDir, "project/bunest.json"))).toBe(true);
    });

    it("should manage provided language input", async () => {
      await generateSchematic({
        schematic: "configuration",
        name: "bunest",
        dir: "project",
        cwd: tempDir,
        ...({ language: "ts" } as Record<string, unknown>),
      });

      const parsed = JSON.parse(
        readTextSync(join(tempDir, "project/bunest.json")),
      ) as Record<string, unknown>;
      expect(parsed.language).toBe("ts");
    });

    it("should manage provided collection input", async () => {
      await generateSchematic({
        schematic: "configuration",
        name: "bunest",
        dir: "project",
        cwd: tempDir,
        ...({ collection: "foo" } as Record<string, unknown>),
      });

      const parsed = JSON.parse(
        readTextSync(join(tempDir, "project/bunest.json")),
      ) as Record<string, unknown>;
      expect(parsed.collection).toBe("foo");
    });
  },
);
