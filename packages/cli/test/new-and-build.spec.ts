import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildProject,
  createProject,
  runCli,
  runDevServer,
  type BuildProjectResult,
  type CliIO,
  type CreateProjectResult,
} from "../src";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
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

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

describe("bunest new, bunest build, and bunest dev", () => {
  it("scaffolds a complete Bunest project with verified Bun 1.4.3 tsconfig and main.ts", async () => {
    const workdir = await makeTempDir("bunest-cli-new-");
    const cap = createCapturedIO(workdir);

    const res = await runCli(["new", "demo-api", "--skip-install"], cap.io);
    expect(res.exitCode).toBe(0);

    const out = res.output as CreateProjectResult;
    expect(out.projectName).toBe("demo-api");
    expect(out.installed).toBe(false);
    expect(out.dryRun).toBe(false);
    expect(out.files).toHaveLength(9);

    const projectDir = join(workdir, "demo-api");
    for (const rel of [
      "package.json",
      "tsconfig.json",
      "src/main.ts",
      "src/app.module.ts",
      "src/app.controller.ts",
      "src/app.service.ts",
      "test/app.spec.ts",
      ".gitignore",
      "README.md",
    ]) {
      expect(await fileExists(join(projectDir, rel))).toBe(true);
    }

    const pkg = (await Bun.file(join(projectDir, "package.json")).json()) as {
      name: string;
      dependencies: Record<string, string>;
      scripts: Record<string, string>;
    };
    expect(pkg.name).toBe("demo-api");
    expect(pkg.dependencies["@bunest/core"]).toBeDefined();
    expect(pkg.dependencies["reflect-metadata"]).toBeDefined();
    expect(pkg.dependencies["class-validator"]).toBeDefined();
    expect(pkg.dependencies["class-transformer"]).toBeDefined();
    expect(pkg.scripts.typecheck).toBe("bun check");

    const tsconfig = (await Bun.file(
      join(projectDir, "tsconfig.json"),
    ).json()) as {
      compilerOptions: Record<string, unknown>;
    };
    expect(tsconfig.compilerOptions.experimentalDecorators).toBe(true);
    expect(tsconfig.compilerOptions.emitDecoratorMetadata).toBe(true);
    expect(tsconfig.compilerOptions.verbatimModuleSyntax).toBe(true);
    expect(tsconfig.compilerOptions.strict).toBe(true);
    expect(tsconfig.compilerOptions.types).toEqual(["bun"]);

    const mainSrc = await Bun.file(join(projectDir, "src/main.ts")).text();
    expect(mainSrc.startsWith('import "reflect-metadata";')).toBe(true);
    expect(mainSrc).toContain("BunestFactory.create(AppModule)");
    expect(mainSrc).toContain("new ValidationPipe()");
  });

  it("supports --dry-run, --dir, collision protection, --force, path traversal rejection, and install hook", async () => {
    const workdir = await makeTempDir("bunest-cli-new-opts-");

    // Path traversal rejected
    const badCap = createCapturedIO(workdir);
    const badRes = await runCli(["new", "../evil-app", "--skip-install"], badCap.io);
    expect(badRes.exitCode).toBe(1);
    expect(badCap.stderr.join("\n")).toContain("Invalid project name");

    // --dry-run writes 0 files
    const dryCap = createCapturedIO(workdir);
    const dryRes = await runCli(
      ["new", "preview-app", "--dir", "custom-out", "--dry-run"],
      dryCap.io,
    );
    expect(dryRes.exitCode).toBe(0);
    expect(await fileExists(join(workdir, "custom-out", "package.json"))).toBe(
      false,
    );

    // Real create with injected spawn verifying bun install invocation
    const spawned: Array<{ cmd: string[]; cwd: string }> = [];
    const created = await createProject({
      projectName: "install-app",
      cwd: workdir,
      skipInstall: false,
      spawn: async (cmd, opts) => {
        spawned.push({ cmd, cwd: opts.cwd });
        return { exitCode: 0 };
      },
    });
    expect(created.installed).toBe(true);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.cmd[1]).toBe("install");
    expect(spawned[0]?.cwd).toBe(join(workdir, "install-app"));

    // Second create refuses to overwrite without --force
    const collideCap = createCapturedIO(workdir);
    const collideRes = await runCli(
      ["new", "install-app", "--skip-install"],
      collideCap.io,
    );
    expect(collideRes.exitCode).toBe(1);
    expect(collideCap.stderr.join("\n")).toContain("Pass --force");

    // With --force overwrites cleanly
    const forceCap = createCapturedIO(workdir);
    const forceRes = await runCli(
      ["new", "install-app", "--skip-install", "--force"],
      forceCap.io,
    );
    expect(forceRes.exitCode).toBe(0);
  });

  it("bundles a real TypeScript entry via bunest build (minify, sourcemap, and error handling)", async () => {
    const workdir = await makeTempDir("bunest-cli-build-");
    await Bun.write(
      join(workdir, "src/main.ts"),
      `export function greet(name: string): string { return \`hello \${name}\`; }\nconsole.log(greet("bunest"));\n`,
    );

    const cap = createCapturedIO(workdir);
    const res = await runCli(
      [
        "build",
        "--entry",
        "src/main.ts",
        "--outdir",
        "dist",
        "--target",
        "bun",
        "--minify",
        "--sourcemap",
      ],
      cap.io,
    );

    expect(res.exitCode).toBe(0);
    const out = res.output as BuildProjectResult;
    expect(out.success).toBe(true);
    expect(out.outputs.length).toBeGreaterThanOrEqual(1);
    expect(await fileExists(join(workdir, "dist/main.js"))).toBe(true);
    expect(await fileExists(join(workdir, "dist/main.js.map"))).toBe(true);
    expect(cap.stdout.join("\n")).toContain("dist/main.js");

    // Verify bundled JS executes cleanly
    const proc = Bun.spawn([process.execPath, join(workdir, "dist/main.js")], {
      stdout: "pipe",
    });
    const text = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(text.trim()).toBe("hello bunest");

    // Broken TypeScript fails build cleanly with exitCode 1
    await Bun.write(
      join(workdir, "src/broken.ts"),
      `import { nope } from "./does-not-exist";\nconsole.log(nope);\n`,
    );
    const failCap = createCapturedIO(workdir);
    const failRes = await runCli(
      ["build", "--entry", "src/broken.ts", "--outdir", "dist-broken"],
      failCap.io,
    );
    expect(failRes.exitCode).toBe(1);
    expect(failCap.stderr.join("\n")).toContain("Build failed");

    // Missing entrypoint throws cleanly
    await expect(
      buildProject({ entry: "src/missing.ts", cwd: workdir }),
    ).rejects.toThrow(/Build entry file not found/);
  });

  it("spawns bun --watch with PORT env via runDevServer and validates port & entrypoint", async () => {
    const workdir = await makeTempDir("bunest-cli-dev-");
    const entryPath = join(workdir, "src/main.ts");
    await Bun.write(entryPath, `console.log("watching");\n`);

    const calls: Array<{
      cmd: string[];
      cwd: string;
      env?: Record<string, string | undefined>;
    }> = [];

    const devRes = await runDevServer({
      entry: "src/main.ts",
      port: 4321,
      cwd: workdir,
      spawn: async (cmd, opts) => {
        calls.push({ cmd, cwd: opts.cwd, env: opts.env });
        return { exitCode: 0 };
      },
    });

    expect(devRes.exitCode).toBe(0);
    expect(devRes.port).toBe(4321);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toEqual([process.execPath, "--watch", entryPath]);
    expect(calls[0]?.env?.PORT).toBe("4321");

    await expect(
      runDevServer({ entry: "src/main.ts", port: 99999, cwd: workdir }),
    ).rejects.toThrow(/Invalid port/);

    await expect(
      runDevServer({ entry: "src/missing.ts", cwd: workdir }),
    ).rejects.toThrow(/Dev entry file not found/);
  });
});
