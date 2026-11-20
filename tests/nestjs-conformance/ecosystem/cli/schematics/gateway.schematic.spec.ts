import "reflect-metadata";
import { afterEach, beforeEach, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSchematicFiles,
  generateSchematic,
  parseSchematicName,
  resolveSchematicType,
} from "../../../../../packages/cli/src";
import { describeConformance, itAdapted } from "../../../_helpers/index";

const expectedGatewaySource = (pascal: string): string =>
  "import {\n" +
  "  SubscribeMessage,\n" +
  "  WebSocketGateway,\n" +
  '} from "@bunest/websockets";\n' +
  "\n" +
  "@WebSocketGateway()\n" +
  `export class ${pascal}Gateway {\n` +
  '  @SubscribeMessage("message")\n' +
  "  handleMessage(_client: unknown, payload: unknown): unknown {\n" +
  "    return payload;\n" +
  "  }\n" +
  "}\n";

describeConformance(
  "Gateway Schematic Factory",
  {
    upstreamPath: "schematics/src/lib/gateway/gateway.factory.test.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Ports upstream @nestjs/schematics gateway factory tests to Bunest CLI gateway schematic (@bunest/websockets, strict unknown typing, bun:test specs, extensionless ESM imports).",
  },
  () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), "bunest-cli-conf-gw-"));
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should manage name only",
      async () => {
        const planned = buildSchematicFiles(
          "gateway",
          parseSchematicName("foo"),
          { flat: false, spec: false },
        );
        expect(planned.map((f) => f.relativePath)).toEqual([
          "foo/foo.gateway.ts",
        ]);
        expect(planned[0]?.content).toEqual(expectedGatewaySource("Foo"));

        const result = await generateSchematic({
          schematic: "gateway",
          name: "foo",
          dir: ".",
          flat: false,
          cwd: tempDir,
        });

        expect(
          result.files.find((f) => f.relativePath === "foo/foo.gateway.ts"),
        ).toBeDefined();
        expect(
          readFileSync(join(tempDir, "foo/foo.gateway.ts"), "utf8"),
        ).toEqual(expectedGatewaySource("Foo"));
      },
      "Bunest gateway imports from @bunest/websockets with strict unknown parameter types",
    );

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should manage name as a path",
      async () => {
        const result = await generateSchematic({
          schematic: "gateway",
          name: "bar/foo",
          dir: ".",
          flat: false,
          cwd: tempDir,
        });

        expect(
          result.files.find((f) => f.relativePath === "bar/foo/foo.gateway.ts"),
        ).toBeDefined();
        expect(
          readFileSync(join(tempDir, "bar/foo/foo.gateway.ts"), "utf8"),
        ).toEqual(expectedGatewaySource("Foo"));
      },
      "Bunest gateway uses @bunest/websockets",
    );

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should manage name and path",
      async () => {
        const result = await generateSchematic({
          schematic: "gateway",
          name: "foo",
          dir: "baz",
          flat: false,
          cwd: tempDir,
        });

        expect(
          result.files.find((f) => f.relativePath === "foo/foo.gateway.ts"),
        ).toBeDefined();
        expect(
          readFileSync(join(tempDir, "baz/foo/foo.gateway.ts"), "utf8"),
        ).toEqual(expectedGatewaySource("Foo"));
      },
      "Bunest uses dir option for base directory",
    );

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should manage name to normalize",
      async () => {
        const result = await generateSchematic({
          schematic: "gateway",
          name: "fooBar",
          dir: ".",
          flat: false,
          cwd: tempDir,
        });

        expect(
          result.files.find(
            (f) => f.relativePath === "foo-bar/foo-bar.gateway.ts",
          ),
        ).toBeDefined();
        expect(
          readFileSync(join(tempDir, "foo-bar/foo-bar.gateway.ts"), "utf8"),
        ).toEqual(expectedGatewaySource("FooBar"));
      },
      "Normalizes camelCase gateway name to kebab-case path and PascalCase class",
    );

    // BUNEST_BUG: parseSchematicName() in packages/cli/src/utils/naming.ts rejects leading "_" in "_foo" (VALID_SEGMENT_REGEX requires leading [a-zA-Z]); expected "_foo/_foo.gateway.ts" exporting FooGateway.
    it.skip("should keep underscores", async () => {
      const result = await generateSchematic({
        schematic: "gateway",
        name: "_foo",
        dir: ".",
        flat: false,
        cwd: tempDir,
      });

      expect(
        result.files.find((f) => f.relativePath === "_foo/_foo.gateway.ts"),
      ).toBeDefined();
      expect(
        readFileSync(join(tempDir, "_foo/_foo.gateway.ts"), "utf8"),
      ).toEqual(expectedGatewaySource("Foo"));
    });

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should manage path to normalize",
      async () => {
        const result = await generateSchematic({
          schematic: "gateway",
          name: "barBaz/foo",
          dir: ".",
          flat: false,
          cwd: tempDir,
        });

        expect(
          result.files.find(
            (f) => f.relativePath === "bar-baz/foo/foo.gateway.ts",
          ),
        ).toBeDefined();
        expect(
          readFileSync(join(tempDir, "bar-baz/foo/foo.gateway.ts"), "utf8"),
        ).toEqual(expectedGatewaySource("Foo"));
      },
      "Normalizes camelCase directory segment to kebab-case",
    );

    itAdapted(
      ["ADR-001", "ADR-002"],
      "generates TypeScript gateway only and resolves 'ga' alias (no language: js)",
      () => {
        expect(resolveSchematicType("ga")).toBe("gateway");

        const files = buildSchematicFiles(
          "gateway",
          parseSchematicName("foo"),
          { flat: false, spec: false },
        );
        expect(files.map((f) => f.relativePath)).toEqual([
          "foo/foo.gateway.ts",
        ]);
        expect(files.some((f) => f.relativePath.endsWith(".js"))).toBe(false);
      },
      "Bunest targets TypeScript natively on Bun without JS output templates",
    );

    it("should create a spec file", async () => {
      const result = await generateSchematic({
        schematic: "gateway",
        name: "foo",
        dir: ".",
        spec: true,
        flat: true,
        cwd: tempDir,
      });

      expect(
        result.files.find((f) => f.relativePath === "foo.gateway.spec.ts"),
      ).toBeDefined();
      expect(existsSync(join(tempDir, "foo.gateway.spec.ts"))).toBe(true);
    });

    it("should create a spec file with custom file suffix", async () => {
      const result = await generateSchematic({
        schematic: "gateway",
        name: "foo",
        dir: ".",
        spec: true,
        specFileSuffix: "test",
        flat: true,
        cwd: tempDir,
      });

      expect(
        result.files.find((f) => f.relativePath === "foo.gateway.spec.ts"),
      ).toBeUndefined();
      expect(
        result.files.find((f) => f.relativePath === "foo.gateway.test.ts"),
      ).toBeDefined();
      expect(existsSync(join(tempDir, "foo.gateway.spec.ts"))).toBe(false);
      expect(existsSync(join(tempDir, "foo.gateway.test.ts"))).toBe(true);
    });

    // BUNEST_BUG: generateSchematic("gateway") in packages/cli/src/commands/generate.ts does not auto-register FooGateway in src/app.module.ts providers[] (note: per ADR-001/ADR-002, Bunest ESM uses extensionless imports).
    it.skip("should manage declaration in app module for ESM projects", async () => {
      await generateSchematic({
        schematic: "application",
        name: "app",
        flat: true,
        cwd: tempDir,
      });

      await generateSchematic({
        schematic: "gateway",
        name: "foo",
        flat: true,
        cwd: tempDir,
      });

      const appModule = readFileSync(
        join(tempDir, "src/app.module.ts"),
        "utf8",
      );
      expect(appModule).toContain(
        'import { FooGateway } from "./foo.gateway";',
      );
      expect(appModule).toContain("providers: [AppService, FooGateway]");
    });

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should generate bun:test spec file with extensionless ESM import",
      async () => {
        await generateSchematic({
          schematic: "application",
          name: "app",
          flat: true,
          cwd: tempDir,
        });

        await generateSchematic({
          schematic: "gateway",
          name: "foo",
          spec: true,
          flat: true,
          cwd: tempDir,
        });

        const specContent = readFileSync(
          join(tempDir, "src/foo.gateway.spec.ts"),
          "utf8",
        );
        expect(specContent).toContain('import "reflect-metadata";');
        expect(specContent).toContain(
          'import { describe, expect, it } from "bun:test";',
        );
        expect(specContent).toContain(
          'import { FooGateway } from "./foo.gateway";',
        );
        expect(specContent).toContain("new FooGateway()");
      },
      "Bunest generates bun:test gateway spec with extensionless bundler imports",
    );

    // BUNEST_BUG: generateSchematic("gateway") in packages/cli/src/commands/generate.ts defaults flat to false for all schematics instead of flat: true as defined in upstream gateway/schema.json.
    it.skip("should default to flat: true when flat option is omitted", async () => {
      const result = await generateSchematic({
        schematic: "gateway",
        name: "foo",
        dir: ".",
        spec: false,
        cwd: tempDir,
      });

      expect(result.files.map((f) => f.relativePath)).toEqual([
        "foo.gateway.ts",
      ]);
    });
  },
);
