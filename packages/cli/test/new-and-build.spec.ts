import { afterEach, describe, expect, it } from "bun:test";
import { ensureDir, join, removePath, statPath } from "@bunest/core";
import {
  buildProject,
  createProject,
  runCli,
  runDevServer,
  type BuildProjectResult,
  type CliIO,
  type CreateProjectResult,
} from "../src";

const TMP_DIR = Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp";
const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = join(TMP_DIR, `${prefix}${crypto.randomUUID().slice(0, 8)}`);
  await ensureDir(dir);
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
    await statPath(path);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await removePath(dir, { recursive: true, force: true });
  }
});

describe("bunest new, bunest build, and bunest dev", () => {
  it("scaffolds a complete Bunest project with verified Bun 1.4.5 tsconfig and main.ts", async () => {
    const workdir = await makeTempDir("bunest-cli-new-");
    const cap = createCapturedIO(workdir);

    const res = await runCli(["new", "demo-api", "--skip-install"], cap.io);
    expect(res.exitCode).toBe(0);

    const out = res.output as CreateProjectResult;
    expect(out.projectName).toBe("demo-api");
    expect(out.installed).toBe(false);
    expect(out.dryRun).toBe(false);
    expect(out.files).toHaveLength(10);

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
      engines?: Record<string, string>;
      dependencies: Record<string, string>;
      scripts: Record<string, string>;
    };
    expect(pkg.name).toBe("demo-api");
    expect(pkg.engines?.bun).toBe(">=1.4.5");
    expect(pkg.dependencies["@bunest/core"]).toBeDefined();
    expect(pkg.dependencies["@bunest/validation"]).toBe("^0.1.0");
    expect(pkg.dependencies["reflect-metadata"]).toBeUndefined();
    expect(pkg.dependencies["class-validator"]).toBeUndefined();
    expect(pkg.dependencies["class-transformer"]).toBeUndefined();
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
    expect(mainSrc).not.toContain("reflect-metadata");
    expect(mainSrc).toContain(
      'import { BunestFactory, ValidationPipe } from "@bunest/core"',
    );
    expect(mainSrc).toContain("BunestFactory.create(AppModule)");
    expect(mainSrc).toContain("new ValidationPipe()");
    expect(mainSrc).toContain("Bun.env.PORT ?? 3000");

    const specSrc = await Bun.file(join(projectDir, "test/app.spec.ts")).text();
    expect(specSrc).toContain('import { ValidationPipe } from "@bunest/validation"');

    expect(await fileExists(join(projectDir, "bunfig.toml"))).toBe(true);
    expect(await fileExists(join(projectDir, "preload.ts"))).toBe(true);
    expect(await Bun.file(join(projectDir, "bunfig.toml")).text()).toContain(
      'preload = ["./preload.ts"]',
    );
    expect(await Bun.file(join(projectDir, "preload.ts")).text()).toContain(
      "registerBunestPlugin(",
    );
  });

  it("supports --dry-run, --dir, collision protection, --force, path traversal rejection, and install hook", async () => {
    const workdir = await makeTempDir("bunest-cli-new-opts-");

    // Path traversal rejected
    const badCap = createCapturedIO(workdir);
    const badRes = await runCli(
      ["new", "../evil-app", "--skip-install"],
      badCap.io,
    );
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

  it("bundles 3 circularly-nested decorated classes with raw value imports via bunest build (zero TDZ)", async () => {
    const workdir = await makeTempDir("bunest-cli-circular-build-");
    await Bun.write(
      join(workdir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          verbatimModuleSyntax: true,
        },
      }),
    );
    await Bun.write(
      join(workdir, "src/dec.ts"),
      `export function Rel(_target: () => unknown): PropertyDecorator {\n  return () => {};\n}\n`,
    );
    await Bun.write(
      join(workdir, "src/a.ts"),
      `import { Rel } from "./dec";\nimport { B } from "./b";\nexport class A {\n  @Rel(() => B)\n  b!: B;\n}\n`,
    );
    await Bun.write(
      join(workdir, "src/b.ts"),
      `import { Rel } from "./dec";\nimport { C } from "./c";\nexport class B {\n  @Rel(() => C)\n  c!: C;\n}\n`,
    );
    await Bun.write(
      join(workdir, "src/c.ts"),
      `import { Rel } from "./dec";\nimport { A } from "./a";\nexport class C {\n  @Rel(() => A)\n  a!: A;\n}\n`,
    );
    await Bun.write(
      join(workdir, "src/main.ts"),
      `import { A } from "./a";\nimport { B } from "./b";\nimport { C } from "./c";\nconst a = new A();\nconst b = new B();\nconst c = new C();\na.b = b; b.c = c; c.a = a;\nconsole.log([A.name, B.name, C.name].join("->"));\n`,
    );

    const res = await buildProject({
      entry: "src/main.ts",
      outdir: "dist",
      cwd: workdir,
      silent: true,
    });
    expect(res.success).toBe(true);

    const proc = Bun.spawn([process.execPath, join(workdir, "dist/main.js")], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(0);
    expect(stderr.trim()).toBe("");
    expect(stdout.trim()).toBe("A->B->C");
  });

  it("preserves constructor DI metadata (aotDiMetadata: true by default) when bundling with bunest build", async () => {
    const workdir = join(
      import.meta.dir,
      "..",
      `.tmp-aot-di-${crypto.randomUUID().slice(0, 8)}`,
    );
    await ensureDir(workdir);
    tempDirs.push(workdir);

    await Bun.write(
      join(workdir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          verbatimModuleSyntax: true,
        },
      }),
    );
    await Bun.write(
      join(workdir, "src/greeter.service.ts"),
      `import { Injectable } from "@bunest/core";
@Injectable()
export class GreeterService {
  greet(name: string) { return \`AOT-DI:\${name}\`; }
}
`,
    );
    await Bun.write(
      join(workdir, "src/app.controller.ts"),
      `import { Controller, Get } from "@bunest/core";
import { GreeterService } from "./greeter.service";
@Controller("hello")
export class AppController {
  constructor(private readonly greeter: GreeterService) {}
  @Get()
  say() { return { msg: this.greeter.greet("Bun") }; }
}
`,
    );
    await Bun.write(
      join(workdir, "src/main.ts"),
      `import { BunestFactory, Module } from "@bunest/core";
import { AppController } from "./app.controller";
import { GreeterService } from "./greeter.service";
@Module({ controllers: [AppController], providers: [GreeterService] })
class AppModule {}
const app = await BunestFactory.create(AppModule, { logger: false });
await app.init();
const res = await app.fetch(new Request("http://localhost/hello"));
console.log(await res.text());
await app.close();
`,
    );

    const res = await buildProject({
      entry: "src/main.ts",
      outdir: "dist",
      cwd: workdir,
      silent: true,
    });
    expect(res.logs).toEqual([]);
    expect(res.success).toBe(true);

    const proc = Bun.spawn([process.execPath, join(workdir, "dist/main.js")], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(0);
    expect(stderr.trim()).toBe("");
    expect(JSON.parse(stdout.trim())).toEqual({ msg: "AOT-DI:Bun" });
  });
});
