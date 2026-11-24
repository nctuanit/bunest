import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  join,
  mkdirSyncPath,
  readTextSync,
  removePath,
  writeTextSync,
} from "../../../../../packages/core/src";
import {
  addLibrary,
  runCli,
  type AddLibraryResult,
  type CliIO,
  type SpawnFn,
} from "../../../../../packages/cli/src";
import {
  createSpy,
  describeConformance,
  itAdapted,
} from "../../../_helpers/index";

function makeTempDir(prefix: string): string {
  const dir = join(
    Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp",
    `${prefix}${crypto.randomUUID()}`,
  );
  mkdirSyncPath(dir, { recursive: true });
  return dir;
}

function createCapturedIO(cwd: string): {
  io: CliIO;
  stdout: string[];
  stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      cwd,
      stdout: (msg) => stdout.push(msg),
      stderr: (msg) => stderr.push(msg),
    },
  };
}

describeConformance(
  "Add Command (e2e)",
  {
    upstreamPath: "nest-cli/test/e2e/add.command.e2e-spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Adapts NestJS `nest add` e2e specs to Bunest's native `bunest add` (`addLibrary` / `runCli`) with mocked spawn to avoid network access.",
  },
  () => {
    let tmpDir: string;
    let pkgPath: string;

    beforeEach(() => {
      tmpDir = makeTempDir("bunest-cli-conf-add-");
      pkgPath = join(tmpDir, "package.json");
      writeTextSync(pkgPath, JSON.stringify(
          {
            name: "add-app",
            version: "0.1.0",
            dependencies: { "@bunest/core": "^0.1.0" },
          },
          null,
          2,
        ));
    });

    afterEach(async () => {
      await removePath(tmpDir, { recursive: true, force: true });
    });

    itAdapted(
      ["ADR-001"],
      "should install the package via bun add and print Bunest integration hint",
      async () => {
        const cap = createCapturedIO(tmpDir);
        const spawnSpy = createSpy<SpawnFn>(async () => ({ exitCode: 0 }));

        const result = await addLibrary(
          { library: "@bunest/orm", cwd: tmpDir, spawn: spawnSpy },
          cap.io,
        );

        expect(result.exitCode).toBe(0);
        expect(result.installed).toBe(true);
        expect(result.dryRun).toBe(false);
        expect(result.library).toBe("@bunest/orm");
        expect(result.command).toEqual(["bun", "add", "@bunest/orm"]);
        expect(spawnSpy.calledOnce).toBe(true);
        expect(spawnSpy.firstCall?.args[0]).toEqual([
          process.execPath,
          "add",
          "@bunest/orm",
        ]);
        expect(spawnSpy.firstCall?.args[1].cwd).toBe(tmpDir);
        const out = cap.stdout.join("\n");
        expect(out).toContain('Successfully installed "@bunest/orm"');
        expect(out).toContain("OrmModule.forRoot");
      },
    );

    it("should not install the library or touch package.json on a dry run", async () => {
      const pkgBefore = readTextSync(pkgPath);
      const cap = createCapturedIO(tmpDir);

      const res = await runCli(["add", "@bunest/swagger", "--dry-run"], cap.io);

      expect(res.exitCode).toBe(0);
      const out = res.output as AddLibraryResult;
      expect(out.installed).toBe(false);
      expect(out.dryRun).toBe(true);
      expect(out.command).toEqual(["bun", "add", "@bunest/swagger"]);
      expect(cap.stdout.join("\n")).toContain(
        "[dry-run] Would run: bun add @bunest/swagger",
      );
      expect(cap.stdout.join("\n")).toContain("SwaggerModule.setup");
      expect(readTextSync(pkgPath)).toBe(pkgBefore);
    });

    it("should skip installation with --skip-install without modifying package.json", async () => {
      const pkgBefore = readTextSync(pkgPath);
      const cap = createCapturedIO(tmpDir);

      const res = await runCli(
        ["add", "@bunest/security", "--skip-install"],
        cap.io,
      );

      expect(res.exitCode).toBe(0);
      const out = res.output as AddLibraryResult;
      expect(out.installed).toBe(false);
      expect(out.dryRun).toBe(false);
      expect(cap.stdout.join("\n")).toContain(
        "[skip-install] Would run: bun add @bunest/security",
      );
      expect(cap.stdout.join("\n")).toContain("JwtModule");
      expect(readTextSync(pkgPath)).toBe(pkgBefore);
    });

    it("supports versioned package specifiers and strips version when looking up hints", async () => {
      const cap = createCapturedIO(tmpDir);
      const res = await runCli(["add", "@bunest/graphql@^0.1.0", "-d"], cap.io);

      expect(res.exitCode).toBe(0);
      expect(cap.stdout.join("\n")).toContain("bun add @bunest/graphql@^0.1.0");
      expect(cap.stdout.join("\n")).toContain("GraphQLModule.forRoot");
    });

    it("rejects unsafe or malformed library specifiers", async () => {
      const unsafeInputs = [
        "",
        "   ",
        "../evil-pkg",
        "@bunest/core; rm -rf /",
        "pkg with spaces",
      ];

      for (const bad of unsafeInputs) {
        await expect(addLibrary({ library: bad, cwd: tmpDir })).rejects.toThrow(
          /Invalid library specifier/,
        );
      }
    });

    it("reports error when bun add exits with a non-zero exit code", async () => {
      const spawnSpy = createSpy<SpawnFn>(async () => ({ exitCode: 1 }));
      await expect(
        addLibrary({
          library: "@bunest/nonexistent",
          cwd: tmpDir,
          spawn: spawnSpy,
        }),
      ).rejects.toThrow(/Failed to add library.*exited with code 1/);
    });

    it("exits non-zero with usage message when library argument is omitted", async () => {
      const cap = createCapturedIO(tmpDir);
      const res = await runCli(["add"], cap.io);

      expect(res.exitCode).toBe(1);
      expect(cap.stderr.join("\n")).toContain(
        "Missing required argument: <library>",
      );
    });
  },
);
