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
  runDevServer,
  type CliIO,
} from "../src";
import {
  discoverSampleHttpFiles,
  formatDevStartupInfo,
  resolveAvailableDevPort,
} from "../src/commands/dev";

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

async function linkWorkspacePackages(
  projectDir: string,
  entryRecord: { dir: string; junctions: string[] },
): Promise<void> {
  const repoRoot = resolve(import.meta.dir, "../../..");
  const repoNodeModules = join(repoRoot, "node_modules");
  const projectNodeModules = join(projectDir, "node_modules");
  const bunestScopeDir = join(projectNodeModules, "@bunest");
  await ensureDir(bunestScopeDir);

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

describe("P0.1 DX: rest-sqlite preset, resource --with-scenario, dry-run module preview, and dev startup", () => {
  it("scaffolds rest-sqlite preset in a directory WITH SPACES, quotes Next steps, previews bootstrap files on dry-run, and passes bun check + bun test with scenario resource", async () => {
    const workdir = await makeTempDir("bunest dx space dir ");
    const entryRecord = tempDirs[tempDirs.length - 1]!;

    // 1. Dry-run preview includes bunest.json, preload.ts, bunfig.toml and writes nothing
    const dryCap = createCapturedIO(workdir);
    const dryOut = await createProject(
      {
        projectName: "orders-api",
        dir: "orders api app",
        preset: "rest-sqlite",
        cwd: workdir,
        skipInstall: true,
        dryRun: true,
      },
      dryCap.io,
    );
    expect(dryOut.dryRun).toBe(true);
    expect(dryOut.preset).toBe("rest-sqlite");
    const dryText = dryCap.stdout.join("\n");
    expect(dryText).toContain("DRY-RUN bunest.json");
    expect(dryText).toContain("DRY-RUN preload.ts");
    expect(dryText).toContain("DRY-RUN bunfig.toml");
    expect(
      await fileExists(join(workdir, "orders api app", "package.json")),
    ).toBe(false);

    // 2. Real create inside path with spaces
    const createCap = createCapturedIO(workdir);
    const created = await createProject(
      {
        projectName: "orders-api",
        dir: "orders api app",
        preset: "rest-sqlite",
        cwd: workdir,
        skipInstall: true,
      },
      createCap.io,
    );

    const projectDir = created.targetDir;
    expect(projectDir).toBe(join(workdir, "orders api app"));
    expect(created.preset).toBe("rest-sqlite");

    const createStdout = createCap.stdout.join("\n");
    expect(createStdout).toContain('cd "orders api app"');

    // Verify zero-dep bun:sqlite fixture files and wiring
    for (const rel of [
      "src/database/sqlite.service.ts",
      "src/database/database.module.ts",
      "src/database/seed.ts",
      "src/app.module.ts",
      "src/main.ts",
    ]) {
      expect(await fileExists(join(projectDir, rel))).toBe(true);
    }

    const sqliteServiceSrc = await Bun.file(
      join(projectDir, "src/database/sqlite.service.ts"),
    ).text();
    expect(sqliteServiceSrc).toContain('from "bun:sqlite"');
    expect(sqliteServiceSrc).toContain(".bunest");
    expect(sqliteServiceSrc).toContain(":memory:");
    expect(sqliteServiceSrc).not.toContain("node:");

    const appModuleBefore = await Bun.file(
      join(projectDir, "src/app.module.ts"),
    ).text();
    expect(appModuleBefore).toContain("DatabaseModule");

    const mainSrc = await Bun.file(join(projectDir, "src/main.ts")).text();
    expect(mainSrc).toContain("whitelist: true");
    expect(mainSrc).toContain("forbidNonWhitelisted: true");
    expect(mainSrc).toContain("transform: true");
    expect(mainSrc).toContain("EADDRINUSE");

    // 3. generate resource orders --with-scenario --dry-run previews file creations AND module update
    const dryGenCap = createCapturedIO(projectDir);
    const dryGen = await generateSchematic(
      {
        schematic: "resource",
        name: "orders",
        cwd: projectDir,
        withScenario: true,
        dryRun: true,
      },
      dryGenCap.io,
    );
    expect(dryGen.dryRun).toBe(true);
    expect(dryGen.files.map((f) => f.relativePath)).toContain(
      "orders/orders.http",
    );
    expect(dryGen.files.map((f) => f.relativePath)).toContain(
      "orders/orders.spec.ts",
    );
    expect(dryGen.plannedUpdates).toEqual([
      join(projectDir, "src/app.module.ts"),
    ]);
    const dryGenStdout = dryGenCap.stdout.join("\n");
    expect(dryGenStdout).toContain("DRY-RUN UPDATE");
    expect(dryGenStdout).toContain("DRY-RUN orders/orders.http");

    // Disk must be completely untouched by dry-run
    expect(
      await fileExists(join(projectDir, "src/orders/orders.controller.ts")),
    ).toBe(false);
    expect(
      await Bun.file(join(projectDir, "src/app.module.ts")).text(),
    ).toBe(appModuleBefore);

    // 4. Real generate resource orders --with-scenario
    const genCap = createCapturedIO(projectDir);
    const gen = await generateSchematic(
      {
        schematic: "resource",
        name: "orders",
        cwd: projectDir,
        withScenario: true,
      },
      genCap.io,
    );
    expect(gen.files).toHaveLength(7);
    expect(gen.plannedUpdates).toEqual([join(projectDir, "src/app.module.ts")]);

    const httpSample = await Bun.file(
      join(projectDir, "src/orders/orders.http"),
    ).text();
    expect(httpSample).toContain("POST {{baseUrl}}/orders");
    expect(httpSample).toContain("201");
    expect(httpSample).toContain("400");

    const specSrc = await Bun.file(
      join(projectDir, "src/orders/orders.spec.ts"),
    ).text();
    expect(specSrc).toContain("expectStatus(201)");
    expect(specSrc).toContain("expectStatus(400)");
    expect(specSrc).toContain("ValidationPipe");
    expect(specSrc).toContain("moduleRef.close()");

    const appModuleAfter = await Bun.file(
      join(projectDir, "src/app.module.ts"),
    ).text();
    expect(appModuleAfter).toContain("OrdersModule");

    // 5. Real `bun check` and `bun test` in directory with spaces
    await linkWorkspacePackages(projectDir, entryRecord);

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
        `Generated rest-sqlite project failed bun check (exit ${checkCode}):\n${checkOut}\n${checkErr}`,
      );
    }
    expect(checkCode).toBe(0);

    const testProc = Bun.spawn([process.execPath, "test"], {
      cwd: projectDir,
      env: { ...Bun.env, NODE_ENV: "test" },
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
        `Generated rest-sqlite project failed bun test (exit ${testCode}):\n${testOut}\n${testErr}`,
      );
    }
    expect(testCode).toBe(0);
  });

  it("aborts atomically on FileCollisionError without writing partial files and preserves user edits", async () => {
    const workdir = await makeTempDir("bunest-dx-collision-");
    await createProject({
      projectName: "collision-app",
      cwd: workdir,
      preset: "rest-sqlite",
      skipInstall: true,
    });
    const projectDir = join(workdir, "collision-app");

    await generateSchematic({
      schematic: "resource",
      name: "orders",
      cwd: projectDir,
      withScenario: true,
    });

    // Simulate user editing controller and deleting orders.http
    const controllerPath = join(projectDir, "src/orders/orders.controller.ts");
    const httpPath = join(projectDir, "src/orders/orders.http");
    const customContent = "// user-customized controller\nexport class OrdersController {}\n";
    await Bun.write(controllerPath, customContent);
    await removePath(httpPath, { force: true });
    expect(await fileExists(httpPath)).toBe(false);

    // Re-running generator must throw FileCollisionError BEFORE writing orders.http or touching controller
    await expect(
      generateSchematic({
        schematic: "resource",
        name: "orders",
        cwd: projectDir,
        withScenario: true,
      }),
    ).rejects.toBeInstanceOf(FileCollisionError);

    expect(await Bun.file(controllerPath).text()).toBe(customContent);
    expect(await fileExists(httpPath)).toBe(false);
  });

  it("falls back to next available port when preferred port is occupied and formats dev startup info", async () => {
    // Occupy an ephemeral loopback port
    const blocker = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("busy"),
    });
    const occupiedPort = blocker.port!;

    try {
      const resolved = await resolveAvailableDevPort(occupiedPort, 10);
      expect(resolved.preferredPort).toBe(occupiedPort);
      expect(resolved.fellBack).toBe(true);
      expect(resolved.port).not.toBe(occupiedPort);
      expect(resolved.port).toBeGreaterThan(0);
    } finally {
      await blocker.stop(true);
    }

    // Verify startup info formatting + runDevServer integration with routes and *.http discovery
    const workdir = await makeTempDir("bunest-dx-dev-info-");
    await createProject({
      projectName: "dev-info-app",
      cwd: workdir,
      preset: "rest-sqlite",
      skipInstall: true,
    });
    const projectDir = join(workdir, "dev-info-app");
    await generateSchematic({
      schematic: "resource",
      name: "orders",
      cwd: projectDir,
      withScenario: true,
    });

    const sampleHttpFiles = await discoverSampleHttpFiles(projectDir, "src");
    expect(sampleHttpFiles).toEqual(["src/orders/orders.http"]);

    const formatted = formatDevStartupInfo({
      port: 3001,
      fellBackFromPort: 3000,
      routes: [
        {
          key: "POST /orders",
          method: "POST",
          path: "/orders",
          paramsTypeText: "Record<string, never>",
          queryTypeText: "Record<string, never>",
          bodyTypeText: "CreateOrdersDto",
          responseTypeText: "OrdersRecord",
          controllerName: "OrdersController",
          handlerName: "create",
          sourceFile: join(projectDir, "src/orders/orders.controller.ts"),
          location: {
            filePath: join(projectDir, "src/orders/orders.controller.ts"),
            line: 20,
            column: 3,
            endLine: 20,
            endColumn: 20,
            start: 400,
            end: 417,
          },
          imports: [],
        },
      ],
      sampleHttpFiles,
      cwd: projectDir,
    });
    const formattedText = formatted.join("\n");
    expect(formattedText).toContain("Port 3000 is in use; using http://localhost:3001");
    expect(formattedText).toContain("POST /orders -> src/orders/orders.controller.ts:20");
    expect(formattedText).toContain("src/orders/orders.http");

    // Verify runDevServer prints listening URL, discovered routes, and sample .http paths
    const devCap = createCapturedIO(projectDir);
    const devRes = await runDevServer(
      {
        cwd: projectDir,
        port: 4123,
        spawn: async () => ({ exitCode: 0 }),
      },
      devCap.io,
    );
    expect(devRes.exitCode).toBe(0);
    const devOutput = devCap.stdout.join("\n");
    expect(devOutput).toContain("http://localhost:4123");
    expect(devOutput).toContain("src/orders/orders.http");
    expect(devOutput).toContain("POST /orders");
  });
});
