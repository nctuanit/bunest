import { afterEach, describe, expect, it } from "bun:test";
import { ensureDir, existsSyncPath, join, removePath } from "@bunest/core";
import {
  buildProject,
  generateSchematic,
  runCli,
  runCronParseCommand,
  runCronRegisterCommand,
  runCronRemoveCommand,
  runCronRunCommand,
  type CliIO,
} from "../src";

function createTestIO(cwd?: string): {
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

describe("CLI Bun.cron Integration (`bunest cron`, `generate cron`, `build` auto-discovery)", () => {
  const tmpDirs: string[] = [];

  async function makeTmpDir(prefix: string): Promise<string> {
    const baseTmp = Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp";
    const dir = join(baseTmp, `${prefix}-${crypto.randomUUID()}`);
    await ensureDir(dir);
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    while (tmpDirs.length > 0) {
      await removePath(tmpDirs.pop()!, { recursive: true, force: true });
    }
  });

  describe("bunest cron parse", () => {
    it("previews upcoming occurrences in pretty and json formats via runCli", async () => {
      const jsonCtx = createTestIO();
      const jsonRes = await runCli(
        [
          "cron",
          "parse",
          "0 9 * * MON-FRI",
          "--tz",
          "UTC",
          "--from",
          "2026-06-13T10:00:00.000Z",
          "--count",
          "3",
          "--format",
          "json",
        ],
        jsonCtx.io,
      );
      expect(jsonRes.exitCode).toBe(0);
      const parsed = JSON.parse(jsonCtx.stdout.join("\n")) as {
        occurrences: string[];
        timeZone: string;
      };
      expect(parsed.timeZone).toBe("UTC");
      expect(parsed.occurrences).toEqual([
        "2026-06-15T09:00:00.000Z",
        "2026-06-16T09:00:00.000Z",
        "2026-06-17T09:00:00.000Z",
      ]);

      const prettyCtx = createTestIO();
      const prettyRes = await runCronParseCommand(
        {
          expression: "@hourly",
          tz: "UTC",
          from: "2026-06-15T10:15:00.000Z",
          count: 2,
        },
        prettyCtx.io,
      );
      expect(prettyRes.exitCode).toBe(0);
      expect(prettyCtx.stdout.join("\n")).toContain("2026-06-15T11:00:00.000Z");
      expect(prettyCtx.stdout.join("\n")).toContain("2026-06-15T12:00:00.000Z");
    });

    it("fails cleanly on impossible dates, invalid expressions, and bad --count", async () => {
      const badExpr = await runCronParseCommand({
        expression: "0 0 30 2 *",
        tz: "UTC",
      });
      expect(badExpr.exitCode).toBe(1);
      expect(badExpr.error).toContain("no matching date");

      const badCountCtx = createTestIO();
      const badCount = await runCli(
        ["cron", "parse", "@daily", "--count", "abc"],
        badCountCtx.io,
      );
      expect(badCount.exitCode).toBe(1);
      expect(badCountCtx.stderr.join("\n")).toContain("Invalid --count");
    });
  });

  describe("bunest cron register & remove", () => {
    it("validates and registers/removes via --dry-run and injectable callbacks without touching host OS", async () => {
      const dir = await makeTmpDir("bunest-cron-cli");
      const jobPath = join(dir, "weekly.cron.ts");
      await Bun.write(
        jobPath,
        `export default { scheduled() {} };\n`,
      );

      // Dry-run via runCli
      const dryCtx = createTestIO(dir);
      const dryReg = await runCli(
        [
          "cron",
          "register",
          "./weekly.cron.ts",
          "30 2 * * MON",
          "weekly-report",
          "--dry-run",
          "--format",
          "json",
        ],
        dryCtx.io,
      );
      expect(dryReg.exitCode).toBe(0);
      const dryJson = JSON.parse(dryCtx.stdout.join("\n")) as {
        title: string;
        schedule: string;
        dryRun: boolean;
        nextRun: string;
      };
      expect(dryJson.title).toBe("weekly-report");
      expect(dryJson.schedule).toBe("30 2 * * MON");
      expect(dryJson.dryRun).toBe(true);
      expect(dryJson.nextRun).toBeTruthy();

      // Programmatic register with mock registerFn
      const calls: Array<{ path: string; schedule: string; title: string }> = [];
      const regRes = await runCronRegisterCommand({
        cwd: dir,
        file: "./weekly.cron.ts",
        schedule: "@daily",
        title: "daily-job",
        registerFn: async (path, schedule, title) => {
          calls.push({ path, schedule, title });
        },
      });
      expect(regRes.exitCode).toBe(0);
      expect(calls).toEqual([
        { path: jobPath, schedule: "@daily", title: "daily-job" },
      ]);

      // Invalid title / missing file fail fast
      const badTitle = await runCronRegisterCommand({
        cwd: dir,
        file: "./weekly.cron.ts",
        schedule: "@daily",
        title: "bad title!",
        dryRun: true,
      });
      expect(badTitle.exitCode).toBe(1);

      const missingFile = await runCronRegisterCommand({
        cwd: dir,
        file: "./missing.cron.ts",
        schedule: "@daily",
        title: "ok-title",
        dryRun: true,
      });
      expect(missingFile.exitCode).toBe(1);

      // Remove dry-run & programmatic mock
      const rmDryCtx = createTestIO(dir);
      const rmDry = await runCli(
        ["cron", "remove", "daily-job", "--dry-run"],
        rmDryCtx.io,
      );
      expect(rmDry.exitCode).toBe(0);
      expect(rmDryCtx.stdout.join("\n")).toContain("[dry-run] Would remove");

      const removed: string[] = [];
      const rmRes = await runCronRemoveCommand({
        title: "daily-job",
        removeFn: async (t) => {
          removed.push(t);
        },
      });
      expect(rmRes.exitCode).toBe(0);
      expect(removed).toEqual(["daily-job"]);
    });
  });

  describe("bunest cron run", () => {
    it("imports and executes a cron module's default.scheduled(controller) locally", async () => {
      const dir = await makeTmpDir("bunest-cron-run");
      const markerPath = join(dir, "ran.json");
      const cronFile = join(dir, "sync.cron.ts");
      await Bun.write(
        cronFile,
        `export default {
  async scheduled(controller: { type: string; cron: string; scheduledTime: number }) {
    await Bun.write(${JSON.stringify(markerPath)}, JSON.stringify(controller));
  },
};
`,
      );

      const runCtx = createTestIO(dir);
      const res = await runCli(
        [
          "cron",
          "run",
          "./sync.cron.ts",
          "--schedule",
          "0 9 * * MON-FRI",
          "--time",
          "2026-06-15T09:00:00.000Z",
          "--format",
          "json",
        ],
        runCtx.io,
      );
      expect(res.exitCode).toBe(0);
      const written = (await Bun.file(markerPath).json()) as {
        type: string;
        cron: string;
        scheduledTime: number;
      };
      expect(written).toEqual({
        type: "scheduled",
        cron: "0 9 * * MON-FRI",
        scheduledTime: Date.parse("2026-06-15T09:00:00.000Z"),
      });

      // Module without default.scheduled fails with actionable error
      const invalidFile = join(dir, "bad.cron.ts");
      await Bun.write(invalidFile, "export const nope = 1;\n");
      const badRes = await runCronRunCommand({ cwd: dir, file: "./bad.cron.ts" });
      expect(badRes.exitCode).toBe(1);
      expect(badRes.error).toContain("scheduled(controller)");
    });
  });

  describe("bunest generate cron & build auto-discovery", () => {
    it("generates cron entrypoint and spec files via schematic and alias 'cr'", async () => {
      const dir = await makeTmpDir("bunest-gen-cron");
      const srcDir = join(dir, "src");
      await ensureDir(srcDir);

      const res = await generateSchematic({
        schematic: "cr",
        name: "weekly-report",
        cwd: dir,
        dir: "src",
      });
      expect(res.schematic).toBe("cron");
      expect(res.files.map((f) => f.relativePath)).toEqual([
        "weekly-report/weekly-report.cron.ts",
        "weekly-report/weekly-report.cron.spec.ts",
      ]);

      const cronSrc = await Bun.file(
        join(srcDir, "weekly-report", "weekly-report.cron.ts"),
      ).text();
      expect(cronSrc).toContain("defineOsCronJob");
      expect(cronSrc).toContain('from "@bunest/jobs/scheduler"');
      expect(cronSrc).toContain("export default defineOsCronJob");
    });

    it("auto-discovers *.cron.ts entrypoints in buildProject and respects autoDiscoverCrons: false", async () => {
      const dir = await makeTmpDir("bunest-build-cron");
      await ensureDir(join(dir, "src", "jobs"));
      await Bun.write(
        join(dir, "src", "main.ts"),
        `console.log("main app");\n`,
      );
      await Bun.write(
        join(dir, "src", "jobs", "cleanup.cron.ts"),
        `export default { async scheduled() { console.log("cleanup"); } };\n`,
      );
      await Bun.write(
        join(dir, "src", "jobs", "cleanup.cron.spec.ts"),
        `// ignored test file\n`,
      );

      const built = await buildProject({
        cwd: dir,
        entry: "src/main.ts",
        outdir: "dist",
        silent: true,
      });
      expect(built.success).toBe(true);
      expect(built.cronEntries).toEqual([
        join(dir, "src", "jobs", "cleanup.cron.ts"),
      ]);
      expect(existsSyncPath(join(dir, "dist", "jobs", "cleanup.cron.js"))).toBe(
        true,
      );

      const withoutCrons = await buildProject({
        cwd: dir,
        entry: "src/main.ts",
        outdir: "dist-no-crons",
        autoDiscoverCrons: false,
        silent: true,
      });
      expect(withoutCrons.success).toBe(true);
      expect(withoutCrons.cronEntries).toBeUndefined();
    });
  });
});
