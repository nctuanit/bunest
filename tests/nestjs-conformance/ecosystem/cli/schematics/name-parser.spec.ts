import { afterEach, expect, it } from "bun:test";
import {
  existsSyncPath,
  join,
  mkdirSyncPath,
  removePath,
  resolve,
} from "../../../../../packages/core/src";
import {
  generateSchematic,
  parseSchematicName,
  resolveSafeChildPath,
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
  "Name Parser",
  {
    upstreamPath: "schematics/test/utils/name.parser.test.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Adapts @nestjs/schematics NameParser tests to Bunest parseSchematicName + resolveSafeChildPath (security hardening rejects all '..' traversal segments instead of resolving parent paths).",
  },
  () => {
    const tempDirs: string[] = [];

    function createTempDir(): string {
      const dir = makeTempDir("bunest-cli-conf-");
      tempDirs.push(dir);
      return dir;
    }

    afterEach(async () => {
      while (tempDirs.length > 0) {
        const dir = tempDirs.pop();
        if (dir) {
          await removePath(dir, { recursive: true, force: true });
        }
      }
    });

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should handle no path",
      () => {
        const parsed = parseSchematicName("foo");
        expect(parsed.kebab).toEqual("foo");
        expect(parsed.rawName).toEqual("foo");
        expect(parsed.pascal).toEqual("Foo");
        expect(parsed.camel).toEqual("foo");
        expect(parsed.subDir).toEqual("");
      },
      "parseSchematicName returns empty subDir and normalized name variants",
    );

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should handle just the name with an explicit base path",
      async () => {
        const parsed = parseSchematicName("foo");
        expect(parsed.kebab).toEqual("foo");
        expect(parsed.subDir).toEqual("");

        const cwd = createTempDir();
        const result = await generateSchematic({
          schematic: "module",
          name: "foo",
          dir: "baz",
          flat: true,
          cwd,
        });
        expect(result.targetDir).toBe(resolve(cwd, "baz"));
        expect(existsSyncPath(join(cwd, "baz/foo.module.ts"))).toBe(true);
      },
      "combines parseSchematicName leaf with generateSchematic dir option",
    );

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should handle name has a path (sub-dir)",
      async () => {
        const parsed = parseSchematicName("bar/foo");
        expect(parsed.kebab).toEqual("foo");
        expect(parsed.rawName).toEqual("foo");
        expect(parsed.subDir).toEqual("bar");

        const cwd = createTempDir();
        const result = await generateSchematic({
          schematic: "module",
          name: "bar/foo",
          dir: "baz",
          flat: true,
          cwd,
        });
        expect(result.targetDir).toBe(resolve(cwd, "baz"));
        expect(existsSyncPath(join(cwd, "baz/bar/foo.module.ts"))).toBe(true);
      },
      "splits nested path into subDir ('bar') and leaf name ('foo') under target dir ('baz')",
    );

    itAdapted(
      ["ADR-001", "ADR-002"],
      "should reject relative parent path traversal ('../foo') instead of resolving upward",
      () => {
        expect(() => parseSchematicName("../foo")).toThrow(
          /path-traversal|\.\./,
        );
      },
      "Bunest security hardening forbids '..' traversal segments in schematic names",
    );

    it("should reject a higher path escaping above root ('../../../foo')", () => {
      expect(() => parseSchematicName("../../../foo")).toThrow(
        /path-traversal|\.\./,
      );
      const baseDir = resolve((Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp"), "bunest-root-check", "baz");
      expect(() => resolveSafeChildPath(baseDir, "../../../foo")).toThrow(
        /Unsafe target path/,
      );
    });

    it("should normalize Windows separators and camelCase directory/leaf segments", () => {
      const parsed = parseSchematicName("adminPanel\\userProfile");
      expect(parsed.subDir).toBe("admin-panel");
      expect(parsed.kebab).toBe("user-profile");
      expect(parsed.pascal).toBe("UserProfile");
      expect(parsed.camel).toBe("userProfile");
    });

    it("should reject empty names, absolute paths, null bytes, and dot segments", () => {
      expect(() => parseSchematicName("")).toThrow();
      expect(() => parseSchematicName("   ")).toThrow();
      expect(() => parseSchematicName("/foo")).toThrow();
      expect(() => parseSchematicName("C:/foo")).toThrow();
      expect(() => parseSchematicName("foo\0bar")).toThrow();
      expect(() => parseSchematicName("./foo")).toThrow();
      expect(() => parseSchematicName("bar//foo")).toThrow();
    });

    it("should preserve leading underscores in directory and leaf segments", () => {
      const parsed = parseSchematicName("_bar/_foo");
      expect(parsed.subDir).toBe("_bar");
      expect(parsed.kebab).toBe("_foo");
      expect(parsed.pascal).toBe("Foo");
    });

    it("should accept dot-separated schematic names like 'foo.entity'", () => {
      const parsed = parseSchematicName("foo.entity");
      expect(parsed.kebab).toBe("foo.entity");
      expect(parsed.pascal).toBe("FooEntity");
    });
  },
);
