import { describe, expect, it } from "bun:test";
import type { BunSecretsBackend } from "@bunest/core/config";
import { ensureDir, join, removePath } from "@bunest/core";
import {
  buildProject,
  deleteCliSecret,
  deployProject,
  formatEnvironmentInfo,
  getCliSecret,
  getEnvironmentInfo,
  i18nTypegenPlugin,
  parseCliArgs,
  runCli,
  runExplainErrorCommand,
  runExplainRouteCommand,
  runMcpServer,
  setCliSecret,
  upgradeProject,
} from "../src/index";

describe("Wave 8 — @bunest/cli Bun 1.4.5 Native Features", () => {
  it("parseCliArgs and runCli properly parse --bytecode, --archive, --open, --format ansi, and --format table", async () => {
    const pAnsi = parseCliArgs([
      "explain",
      "error",
      "BUNEST_E001",
      "--format",
      "ansi",
    ]);
    expect(pAnsi.flags.format).toBe("ansi");
    expect(pAnsi.positionals).toEqual(["error", "BUNEST_E001"]);

    const pTable = parseCliArgs(["info", "--format", "table"]);
    expect(pTable.flags.format).toBe("table");
    expect(pTable.positionals).toEqual([]);

    const pBytecode = parseCliArgs([
      "build",
      "--compile",
      "--bytecode",
      "my-app",
    ]);
    expect(pBytecode.flags.compile).toBe(true);
    expect(pBytecode.flags.bytecode).toBe(true);
    expect(pBytecode.positionals).toEqual(["my-app"]);

    const pOpen = parseCliArgs(["explain", "route", "--open", "GET /items"]);
    expect(pOpen.flags.open).toBe(true);
    expect(pOpen.positionals).toEqual(["route", "GET /items"]);

    const pArchiveFlag = parseCliArgs(["build", "--archive", "my-app"]);
    expect(pArchiveFlag.flags.archive).toBe(true);
    expect(pArchiveFlag.positionals).toEqual(["my-app"]);

    const pArchivePath = parseCliArgs([
      "build",
      "--archive",
      "out/release.tar.gz",
    ]);
    expect(pArchivePath.flags.archive).toBe("out/release.tar.gz");

    // End-to-end `runCli(["explain", "error", "BUNEST_E001", "--format", "ansi"])` emits real ANSI codes
    const ansiOut: string[] = [];
    const ansiRes = await runCli(
      ["explain", "error", "BUNEST_E001", "--format", "ansi"],
      { stdout: (m) => ansiOut.push(m), stderr: () => {} },
    );
    expect(ansiRes.exitCode).toBe(0);
    expect(ansiOut.join("\n")).toContain("BUNEST_E001");
    expect(ansiOut.join("\n")).toContain("\x1b[");
  });

  it("buildProject & deployProject support --bytecode for --compile and --archive (.tar.gz verified via Bun.Archive)", async () => {
    const tmpDir = join(
      "/tmp",
      `bunest-cli-w8-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await ensureDir(join(tmpDir, "src"));
    await Bun.write(
      join(tmpDir, "src", "main.ts"),
      'export const answer = 42;\nconsole.log(answer);\n',
    );
    await Bun.write(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "cli-w8-test", engines: { bun: ">=1.4.5" } }),
    );

    try {
      const seenCmds: string[][] = [];
      const compileRes = await buildProject({
        cwd: tmpDir,
        entry: join(tmpDir, "src", "main.ts"),
        outdir: "dist",
        compile: true,
        bytecode: true,
        silent: true,
        spawn: async (cmd) => {
          seenCmds.push(cmd);
          return { exitCode: 0 };
        },
      });
      expect(compileRes.success).toBe(true);
      expect(seenCmds[0]).toContain("--compile");
      expect(seenCmds[0]).toContain("--bytecode");

      // Bundle with default archive path & extract via Bun.Archive to verify contents
      const bundleRes = await buildProject({
        cwd: tmpDir,
        entry: join(tmpDir, "src", "main.ts"),
        outdir: "dist",
        archive: true,
        silent: true,
      });
      expect(bundleRes.success).toBe(true);
      expect(bundleRes.archivePath).toBeDefined();
      const archiveBytes = await Bun.file(bundleRes.archivePath!).bytes();
      const archivedFiles = await new Bun.Archive(archiveBytes).files();
      expect([...archivedFiles.keys()]).toContain("main.js");

      // Custom archive path via deployProject
      const customArchive = join(tmpDir, "release", "bundle.tar.gz");
      const deployRes = await deployProject({
        cwd: tmpDir,
        entry: join(tmpDir, "src", "main.ts"),
        outdir: "dist",
        archive: customArchive,
        silent: true,
      });
      expect(deployRes.success).toBe(true);
      expect(deployRes.archivePath).toBe(customArchive);
      expect(await Bun.file(customArchive).exists()).toBe(true);
    } finally {
      await removePath(tmpDir, { recursive: true, force: true });
    }
  });

  it("runExplainErrorCommand emits ANSI escapes and runExplainRouteCommand invokes openInEditor only when matched", async () => {
    const errRes = await runExplainErrorCommand({
      code: "BUNEST_E001",
      format: "ansi",
      silent: true,
    });
    expect(errRes.exitCode).toBe(0);
    expect(errRes.formatted).toContain("BUNEST_E001");
    expect(errRes.formatted).toContain("\x1b[");

    const tmpDir = join(
      "/tmp",
      `bunest-cli-open-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await ensureDir(join(tmpDir, "src"));
    await Bun.write(
      join(tmpDir, "src", "app.controller.ts"),
      `import { Controller, Get } from "@bunest/core";
@Controller("items")
export class AppController {
  @Get()
  list() { return []; }
}
`,
    );
    const opened: Array<{ file: string; line?: number; column?: number }> = [];
    try {
      const routeRes = await runExplainRouteCommand({
        cwd: tmpDir,
        route: "GET /items",
        open: true,
        silent: true,
        openInEditor(file, opts) {
          opened.push({ file, line: opts?.line, column: opts?.column });
        },
      });
      expect(routeRes.exitCode).toBe(0);
      expect(opened.length).toBe(1);
      expect(opened[0]!.file).toContain("app.controller.ts");

      // Non-matching route must not open editor
      opened.length = 0;
      await runExplainRouteCommand({
        cwd: tmpDir,
        route: "DELETE /nonexistent",
        open: true,
        silent: true,
        openInEditor(file, opts) {
          opened.push({ file, line: opts?.line, column: opts?.column });
        },
      });
      expect(opened.length).toBe(0);
    } finally {
      await removePath(tmpDir, { recursive: true, force: true });
    }
  });

  it("info command and upgradeProject check engines.bun via Bun.semver and support --format table", async () => {
    const tmpDir = join(
      "/tmp",
      `bunest-cli-info-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await ensureDir(tmpDir);
    await Bun.write(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "info-test", engines: { bun: ">=1.4.5" } }),
    );
    try {
      const info = getEnvironmentInfo(tmpDir);
      expect(info.requiredBunRange).toBe(">=1.4.5");
      expect(info.bunVersionSatisfied).toBe(true);
      const table = formatEnvironmentInfo(info, { format: "table" });
      expect(table).toContain("Bunest CLI");
      expect(table).toContain("compatible");

      // Mismatched engines.bun via runCli(["info", "--format", "table"]) + pretty warning
      await Bun.write(
        join(tmpDir, "package.json"),
        JSON.stringify({
          name: "info-mismatch",
          engines: { bun: ">=99.0.0" },
          dependencies: {
            "@bunest/core": "^0.1.0",
            "@bunest/orm": "^0.2.0",
          },
        }),
      );
      const cliTableOut: string[] = [];
      const cliInfoRes = await runCli(["info", "--format", "table"], {
        cwd: tmpDir,
        stdout: (m) => cliTableOut.push(m),
        stderr: () => {},
      });
      expect(cliInfoRes.exitCode).toBe(0);
      expect(cliTableOut.join("\n")).toContain("mismatch");
      expect(cliTableOut.join("\n")).toContain("┌");

      const mismatchPretty = formatEnvironmentInfo(getEnvironmentInfo(tmpDir));
      expect(mismatchPretty).toContain("does not satisfy engines.bun");

      // upgradeProject warns on engines.bun mismatch and mixed @bunest/* versions via Bun.semver
      const upOut: string[] = [];
      const upErr: string[] = [];
      await upgradeProject(
        { cwd: tmpDir, dryRun: true },
        { stdout: (m) => upOut.push(m), stderr: (m) => upErr.push(m) },
      );
      expect(upErr.join("\n")).toContain("does not satisfy engines.bun");
      expect(upOut.join("\n")).toContain("mixed @bunest/* versions");
    } finally {
      await removePath(tmpDir, { recursive: true, force: true });
    }
  });

  it("runMcpServer frames JSON-RPC messages with Bun.indexOfLine across split chunks, CRLF, multi-line chunks, and EOF without trailing newline", async () => {
    const encoder = new TextEncoder();
    const input = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encoder.encode('{"jsonrpc":"2.0","id":1,'));
        c.enqueue(
          encoder.encode(
            '"method":"ping"}\r\n{"jsonrpc":"2.0","id":2,"method":"ping"}\n{"jsonrpc":"2.0","id":3,"method":"ping"}',
          ),
        );
        c.close();
      },
    });
    const out: string[] = [];
    const res = await runMcpServer(
      { input },
      { stdout: (m) => out.push(m), stderr: () => {} },
    );
    expect(res.exitCode).toBe(0);
    const ids = out.map((line) => (JSON.parse(line) as { id: number }).id);
    expect(ids).toEqual([1, 2, 3]);
  });

  it("i18nTypegenPlugin scans .json5 locale files via Bun.JSON5", async () => {
    const tmpDir = join(
      "/tmp",
      `bunest-cli-i18n-json5-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await ensureDir(join(tmpDir, "locales", "en"));
    await Bun.write(
      join(tmpDir, "locales", "en", "common.json5"),
      `{
        // JSON5 comments and unquoted keys
        greeting: 'Hello {{name}}',
      }`,
    );
    try {
      const scanned = i18nTypegenPlugin.scan({
        cwd: tmpDir,
        sourceRootDir: join(tmpDir, "src"),
        sourceFiles: [],
        project: {} as Parameters<typeof i18nTypegenPlugin.scan>[0]["project"],
        scan: {} as Parameters<typeof i18nTypegenPlugin.scan>[0]["scan"],
        printType: () => "unknown",
        addImports: () => {},
      });
      expect(scanned).toEqual([
        { key: "common.greeting", params: ["name"], hasCount: false },
      ]);
    } finally {
      await removePath(tmpDir, { recursive: true, force: true });
    }
  });

  it("CLI secrets helpers wrap Bun.secrets cleanly", async () => {
    const map = new Map<string, string>();
    const backend: BunSecretsBackend = {
      async get({ service, name }) {
        return map.get(`${service}:${name}`) ?? null;
      },
      async set({ service, name, value }) {
        map.set(`${service}:${name}`, value);
      },
      async delete({ service, name }) {
        return map.delete(`${service}:${name}`);
      },
    };
    await setCliSecret("deploy_token", "tok-123", undefined, backend);
    expect(await getCliSecret("deploy_token", undefined, backend)).toBe(
      "tok-123",
    );
    expect(await deleteCliSecret("deploy_token", undefined, backend)).toBe(
      true,
    );
  });
});
