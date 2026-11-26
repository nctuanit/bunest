import { afterEach, describe, expect, it } from "bun:test";
import {
  ensureDir,
  existsSyncPath,
  getPlatform,
  join,
  removeEmptyDir,
  removePath,
  resolve,
  statPath,
} from "@bunest/core";
import {
  FileCollisionError,
  createProject,
  generateSchematic,
  runCli,
  type CliIO,
  type GenerateSchematicResult,
  type SchematicType,
} from "../src";

const TMP_DIR = Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp";
const tempDirs: Array<{ dir: string; junctions: string[] }> = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = join(TMP_DIR, `${prefix}${crypto.randomUUID().slice(0, 8)}`);
  await ensureDir(dir);
  tempDirs.push({ dir, junctions: [] });
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
    const entry = tempDirs.pop()!;
    for (const junctionPath of entry.junctions) {
      if (getPlatform() === "win32") {
        await removeEmptyDir(junctionPath).catch(() => {});
      } else {
        await removePath(junctionPath, { force: true }).catch(() => {});
      }
    }
    await removePath(entry.dir, { recursive: true, force: true });
  }
});

describe("bunest generate (all schematics, flags, collision safety, and typecheck smoke)", () => {
  it("generates all 11 schematics (including short aliases) with proper kebab/Pascal/camel naming", async () => {
    const workdir = await makeTempDir("bunest-cli-gen-all-");

    const cases: Array<{
      alias: string;
      expectedType: SchematicType;
      name: string;
      expectedFiles: string[];
      expectedSymbol: string;
    }> = [
      {
        alias: "co",
        expectedType: "controller",
        name: "user-profile",
        expectedFiles: [
          "user-profile/user-profile.controller.ts",
          "user-profile/user-profile.controller.spec.ts",
        ],
        expectedSymbol: "export class UserProfileController",
      },
      {
        alias: "s",
        expectedType: "service",
        name: "billingAccount",
        expectedFiles: [
          "billing-account/billing-account.service.ts",
          "billing-account/billing-account.service.spec.ts",
        ],
        expectedSymbol: "export class BillingAccountService",
      },
      {
        alias: "mo",
        expectedType: "module",
        name: "orders",
        expectedFiles: ["orders/orders.module.ts"],
        expectedSymbol: "export class OrdersModule",
      },
      {
        alias: "dto",
        expectedType: "dto",
        name: "create-item",
        expectedFiles: ["create-item/create-item.dto.ts"],
        expectedSymbol: "export class CreateItemDto",
      },
      {
        alias: "gu",
        expectedType: "guard",
        name: "jwt-auth",
        expectedFiles: [
          "jwt-auth/jwt-auth.guard.ts",
          "jwt-auth/jwt-auth.guard.spec.ts",
        ],
        expectedSymbol: "export class JwtAuthGuard implements CanActivate",
      },
      {
        alias: "pi",
        expectedType: "pipe",
        name: "trim-input",
        expectedFiles: [
          "trim-input/trim-input.pipe.ts",
          "trim-input/trim-input.pipe.spec.ts",
        ],
        expectedSymbol: "export class TrimInputPipe",
      },
      {
        alias: "in",
        expectedType: "interceptor",
        name: "timing",
        expectedFiles: [
          "timing/timing.interceptor.ts",
          "timing/timing.interceptor.spec.ts",
        ],
        expectedSymbol: "export class TimingInterceptor",
      },
      {
        alias: "f",
        expectedType: "filter",
        name: "http-error",
        expectedFiles: [
          "http-error/http-error.filter.ts",
          "http-error/http-error.filter.spec.ts",
        ],
        expectedSymbol:
          "export class HttpErrorFilter implements ExceptionFilter",
      },
      {
        alias: "mi",
        expectedType: "middleware",
        name: "request-id",
        expectedFiles: [
          "request-id/request-id.middleware.ts",
          "request-id/request-id.middleware.spec.ts",
        ],
        expectedSymbol:
          "export class RequestIdMiddleware implements BunestMiddleware",
      },
      {
        alias: "ep",
        expectedType: "endpoint",
        name: "create-post",
        expectedFiles: [
          "create-post/create-post.endpoint.ts",
          "create-post/create-post.endpoint.spec.ts",
        ],
        expectedSymbol: "export class CreatePostEndpoint",
      },
      {
        alias: "res",
        expectedType: "resource",
        name: "product-item",
        expectedFiles: [
          "product-item/dto/create-product-item.dto.ts",
          "product-item/dto/update-product-item.dto.ts",
          "product-item/product-item.service.ts",
          "product-item/product-item.controller.ts",
          "product-item/product-item.module.ts",
          "product-item/product-item.spec.ts",
        ],
        expectedSymbol: "export class CreateProductItemDto",
      },
    ];

    for (const c of cases) {
      const cap = createCapturedIO(workdir);
      const res = await runCli(["g", c.alias, c.name], cap.io);
      expect(res.exitCode).toBe(0);

      const out = res.output as GenerateSchematicResult;
      expect(out.schematic).toBe(c.expectedType);
      expect(out.files.map((f) => f.relativePath)).toEqual(c.expectedFiles);

      const firstContent = await Bun.file(out.files[0]!.path).text();
      expect(firstContent).toContain(c.expectedSymbol);
      if (
        c.expectedType === "dto" ||
        c.expectedType === "endpoint" ||
        c.expectedType === "resource"
      ) {
        expect(firstContent).toContain('from "@bunest/validation/validator"');
        expect(firstContent).not.toContain("class-validator");
      }
    }
  });

  it("supports --dry-run, --flat, --no-spec, nested subdirs, and collision refusal vs --force", async () => {
    const workdir = await makeTempDir("bunest-cli-gen-flags-");

    // --dry-run writes nothing
    const dryRes = await generateSchematic({
      schematic: "resource",
      name: "tasks",
      cwd: workdir,
      dryRun: true,
    });
    expect(dryRes.files).toHaveLength(6);
    expect(dryRes.files.every((f) => f.action === "dry-run")).toBe(true);
    expect(
      await fileExists(join(workdir, "src/tasks/tasks.controller.ts")),
    ).toBe(false);

    // --flat + --no-spec on resource adjusts DTO imports cleanly
    const flatRes = await generateSchematic({
      schematic: "resource",
      name: "admin/audit-log",
      dir: "src/modules",
      cwd: workdir,
      flat: true,
      spec: false,
    });
    expect(flatRes.files.map((f) => f.relativePath)).toEqual([
      "admin/create-audit-log.dto.ts",
      "admin/update-audit-log.dto.ts",
      "admin/audit-log.service.ts",
      "admin/audit-log.controller.ts",
      "admin/audit-log.module.ts",
    ]);
    const ctrlText = await Bun.file(
      join(workdir, "src/modules/admin/audit-log.controller.ts"),
    ).text();
    expect(ctrlText).toContain('from "./create-audit-log.dto"');
    expect(ctrlText).toContain('from "./update-audit-log.dto"');

    // Re-running without --force refuses atomically and leaves customized file intact
    const ctrlPath = join(workdir, "src/modules/admin/audit-log.controller.ts");
    await Bun.write(ctrlPath, "// custom user edit\n");

    await expect(
      generateSchematic({
        schematic: "resource",
        name: "admin/audit-log",
        dir: "src/modules",
        cwd: workdir,
        flat: true,
        spec: false,
      }),
    ).rejects.toBeInstanceOf(FileCollisionError);
    expect(await Bun.file(ctrlPath).text()).toBe("// custom user edit\n");

    // Passing --force overwrites cleanly
    const forced = await generateSchematic({
      schematic: "resource",
      name: "admin/audit-log",
      dir: "src/modules",
      cwd: workdir,
      flat: true,
      spec: false,
      force: true,
    });
    expect(forced.files.every((f) => f.action === "overwrite")).toBe(true);
    expect(await Bun.file(ctrlPath).text()).toContain(
      "export class AuditLogController",
    );

    // Unknown schematic errors cleanly via CLI
    const badCap = createCapturedIO(workdir);
    const badRes = await runCli(["generate", "unknown", "foo"], badCap.io);
    expect(badRes.exitCode).toBe(1);
    expect(badCap.stderr.join("\n")).toContain('Unknown schematic "unknown"');
  });

  it("smoke-tests generated bunest new + ALL 11 schematics with real bun check (verbatimModuleSyntax: true) and bun test", async () => {
    const workdir = await makeTempDir("bunest-cli-smoke-");
    const projectDir = join(workdir, "smoke-app");

    await createProject({
      projectName: "smoke-app",
      cwd: workdir,
      skipInstall: true,
    });

    // Generate every schematic into smoke-app/src
    const schematics = [
      ["controller", "alpha"],
      ["service", "beta"],
      ["module", "gamma"],
      ["dto", "delta"],
      ["guard", "epsilon"],
      ["pipe", "zeta"],
      ["interceptor", "eta"],
      ["filter", "theta"],
      ["middleware", "iota"],
      ["endpoint", "kappa"],
      ["resource", "widget-item"],
    ] as const;

    for (const [schematic, name] of schematics) {
      await generateSchematic({
        schematic,
        name,
        cwd: projectDir,
      });
    }

    // Link workspace packages and shared dependencies via directory junctions/symlinks (safe without admin on Windows)
    const repoRoot = resolve(import.meta.dir, "../../..");
    const repoNodeModules = join(repoRoot, "node_modules");
    const projectNodeModules = join(projectDir, "node_modules");
    const bunestScopeDir = join(projectNodeModules, "@bunest");
    await ensureDir(bunestScopeDir);

    const entryRecord = tempDirs[tempDirs.length - 1]!;
    const linkDir = async (target: string, linkPath: string) => {
      const cmd =
        getPlatform() === "win32"
          ? ["cmd", "/c", "mklink", "/J", linkPath, target]
          : ["ln", "-s", target, linkPath];
      const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe" });
      const code = await proc.exited;
      if (code !== 0) {
        const errText = await new Response(proc.stderr).text();
        throw new Error(`Failed to link ${linkPath} -> ${target}: ${errText}`);
      }
      entryRecord.junctions.push(linkPath);
    };

    for (const pkg of ["validation", "core", "testing", "cli"]) {
      await linkDir(join(repoRoot, "packages", pkg), join(bunestScopeDir, pkg));
    }
    for (const dep of ["@types", ".bun"]) {
      const targetDep = join(repoNodeModules, dep);
      if (existsSyncPath(targetDep)) {
        await linkDir(targetDep, join(projectNodeModules, dep));
      }
    }

    // 1. Real `bun check` against generated project's strict verbatimModuleSyntax tsconfig.json
    const checkProc = Bun.spawn(
      [process.execPath, "check", "-p", join(projectDir, "tsconfig.json")],
      { cwd: projectDir, stdout: "pipe", stderr: "pipe" },
    );
    const [checkOut, checkErr, checkCode] = await Promise.all([
      new Response(checkProc.stdout).text(),
      new Response(checkProc.stderr).text(),
      checkProc.exited,
    ]);
    if (checkCode !== 0) {
      throw new Error(
        `Generated project failed bun check (exit ${checkCode}):\n${checkOut}\n${checkErr}`,
      );
    }
    expect(checkCode).toBe(0);

    // 2. Real `bun test` executing generated app.spec.ts + all schematic specs including full CRUD resource spec!
    const testProc = Bun.spawn([process.execPath, "test"], {
      cwd: projectDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [testOut, testErr, testCode] = await Promise.all([
      new Response(testProc.stdout).text(),
      new Response(testProc.stderr).text(),
      testProc.exited,
    ]);
    if (testCode !== 0) {
      throw new Error(
        `Generated project failed bun test (exit ${testCode}):\n${testOut}\n${testErr}`,
      );
    }
    expect(testCode).toBe(0);
  });
});
