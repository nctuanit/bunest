import { afterAll, describe, expect, it } from "bun:test";
import {
  ensureDir,
  getPlatform,
  join,
  realpathSyncOf,
  removePath,
  resolve,
  writeTextSync,
} from "@bunest/core";
import {
  formatEnvironmentInfo,
  getEnvironmentInfo,
  resolveDeclaredBunestPackages,
  type ExtendedEnvironmentInfo,
} from "../src/commands/info";
import { runCli, type CliIO } from "../src";

const TMP_DIR = Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp";
const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = join(
    TMP_DIR,
    `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await ensureDir(dir);
  tempDirs.push(dir);
  return dir;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  const parent = resolve(filePath, "..");
  await ensureDir(parent);
  writeTextSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function createDirLink(targetDir: string, linkPath: string): void {
  const absTarget = resolve(targetDir);
  const absLink = resolve(linkPath);
  const res =
    getPlatform() === "win32"
      ? Bun.spawnSync(["cmd", "/c", "mklink", "/J", absLink, absTarget], {
          stdout: "pipe",
          stderr: "pipe",
        })
      : Bun.spawnSync(["ln", "-s", absTarget, absLink], {
          stdout: "pipe",
          stderr: "pipe",
        });

  if (res.exitCode !== 0) {
    throw new Error(
      `Failed to create directory link from "${absLink}" -> "${absTarget}": ${res.stderr.toString("utf8")}`,
    );
  }
}

function createCapturedIO(cwd?: string): {
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

afterAll(async () => {
  for (const dir of tempDirs) {
    try {
      await removePath(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures
    }
  }
});

describe("bunest info resolved package versions", () => {
  it("Fixture 1: reports missing packages for an uninstalled app without node_modules", async () => {
    const appDir = await makeTempDir("bunest-info-missing-");
    await writeJson(join(appDir, "package.json"), {
      name: "uninstalled-app",
      version: "1.0.0",
      dependencies: {
        "@bunest/core": "^0.1.0",
      },
      devDependencies: {
        "@bunest/cli": "^0.1.0",
      },
    });

    const info = getEnvironmentInfo(appDir);

    // Backward-compatible fields remain intact
    expect(info.packages).toEqual({
      "@bunest/core": "^0.1.0",
      "@bunest/cli": "^0.1.0",
    });

    // Resolved package entries report missing status offline
    expect(info.resolvedPackages).toEqual([
      {
        name: "@bunest/cli",
        declared: "^0.1.0",
        resolved: null,
        status: "missing",
      },
      {
        name: "@bunest/core",
        declared: "^0.1.0",
        resolved: null,
        status: "missing",
      },
    ]);

    // Pretty output displays declared version and missing status
    const pretty = formatEnvironmentInfo(info);
    expect(pretty).toContain("core version : missing (declared: ^0.1.0, missing)");
    expect(pretty).toContain("cli version : missing (declared: ^0.1.0, missing)");

    // JSON output preserves full structure including resolvedPackages
    const jsonText = formatEnvironmentInfo(info, { format: "json" });
    const parsed = JSON.parse(jsonText) as ExtendedEnvironmentInfo;
    expect(parsed.packages).toEqual(info.packages);
    expect(parsed.resolvedPackages).toEqual(info.resolvedPackages);

    // runCli("info") integrates seamlessly with cwd
    const cap = createCapturedIO(appDir);
    const cliRes = await runCli(["info"], cap.io);
    expect(cliRes.exitCode).toBe(0);
    expect(cap.stdout.join("\n")).toContain("declared: ^0.1.0, missing");
    expect((cliRes.output as ExtendedEnvironmentInfo).resolvedPackages).toEqual(
      info.resolvedPackages,
    );
  });

  it("Fixture 2: resolves installed packages with exports map (no ./package.json export) and tarball specifiers", async () => {
    const appDir = await makeTempDir("bunest-info-installed-");
    await writeJson(join(appDir, "package.json"), {
      name: "installed-app",
      version: "1.0.0",
      dependencies: {
        "@bunest/core": "^0.1.0",
        "@bunest/common": "file:../tarballs/bunest-common-0.1.2.tgz",
      },
    });

    // Local installed @bunest/core with an exports map that does NOT export ./package.json
    const coreDir = join(appDir, "node_modules", "@bunest", "core");
    await writeJson(join(coreDir, "package.json"), {
      name: "@bunest/core",
      version: "0.1.0",
      exports: {
        ".": "./dist/index.js",
      },
    });
    await ensureDir(join(coreDir, "dist"));
    writeTextSync(join(coreDir, "dist", "index.js"), "export const core = true;\n");

    // Tarball-installed @bunest/common extracted into node_modules
    const commonDir = join(appDir, "node_modules", "@bunest", "common");
    await writeJson(join(commonDir, "package.json"), {
      name: "@bunest/common",
      version: "0.1.2",
      main: "./index.js",
    });
    writeTextSync(join(commonDir, "index.js"), "export const common = true;\n");

    const info = getEnvironmentInfo(appDir);
    const resolvedCore = info.resolvedPackages?.find(
      (pkg) => pkg.name === "@bunest/core",
    );
    const resolvedCommon = info.resolvedPackages?.find(
      (pkg) => pkg.name === "@bunest/common",
    );

    expect(resolvedCore).toEqual({
      name: "@bunest/core",
      declared: "^0.1.0",
      resolved: "0.1.0",
      status: "installed",
      resolvedPath: realpathSyncOf(join(coreDir, "package.json")),
    });

    expect(resolvedCommon).toEqual({
      name: "@bunest/common",
      declared: "file:../tarballs/bunest-common-0.1.2.tgz",
      resolved: "0.1.2",
      status: "installed",
      resolvedPath: realpathSyncOf(join(commonDir, "package.json")),
    });

    const pretty = formatEnvironmentInfo(info);
    expect(pretty).toContain("core version : 0.1.0 (declared: ^0.1.0, installed)");
    expect(pretty).toContain(
      "common version : 0.1.2 (declared: file:../tarballs/bunest-common-0.1.2.tgz, installed)",
    );

    const parsedJson = JSON.parse(
      formatEnvironmentInfo(info, { format: "json" }),
    ) as ExtendedEnvironmentInfo;
    expect(parsedJson.resolvedPackages).toEqual(info.resolvedPackages);
  });

  it("Fixture 3: resolves hoisted monorepo dependencies and workspace links from a child package dir", async () => {
    const monoDir = await makeTempDir("bunest-info-monorepo-");
    await writeJson(join(monoDir, "package.json"), {
      name: "demo-monorepo",
      private: true,
      workspaces: ["packages/*", "apps/*"],
    });

    // Hoisted regular installed package at monorepo root node_modules
    const hoistedCoreDir = join(monoDir, "node_modules", "@bunest", "core");
    await writeJson(join(hoistedCoreDir, "package.json"), {
      name: "@bunest/core",
      version: "0.1.5",
      exports: {
        ".": "./dist/index.js",
      },
    });
    await ensureDir(join(hoistedCoreDir, "dist"));
    writeTextSync(
      join(hoistedCoreDir, "dist", "index.js"),
      "export const version = '0.1.5';\n",
    );

    // Workspace package in packages/orm linked into root node_modules/@bunest/orm
    const workspaceOrmDir = join(monoDir, "packages", "orm");
    await writeJson(join(workspaceOrmDir, "package.json"), {
      name: "@bunest/orm",
      version: "0.2.0",
      exports: {
        ".": "./src/index.ts",
      },
    });
    await ensureDir(join(workspaceOrmDir, "src"));
    writeTextSync(
      join(workspaceOrmDir, "src", "index.ts"),
      "export const orm = true;\n",
    );

    await ensureDir(join(monoDir, "node_modules", "@bunest"));
    createDirLink(
      workspaceOrmDir,
      join(monoDir, "node_modules", "@bunest", "orm"),
    );

    // Workspace package in packages/validation linked with a semver range (still detected as workspace via realpath)
    const workspaceValDir = join(monoDir, "packages", "validation");
    await writeJson(join(workspaceValDir, "package.json"), {
      name: "@bunest/validation",
      version: "0.2.1",
      exports: {
        ".": "./src/index.ts",
      },
    });
    await ensureDir(join(workspaceValDir, "src"));
    writeTextSync(
      join(workspaceValDir, "src", "index.ts"),
      "export const validation = true;\n",
    );
    createDirLink(
      workspaceValDir,
      join(monoDir, "node_modules", "@bunest", "validation"),
    );

    // Child app inside monorepo with NO local node_modules
    const childAppDir = join(monoDir, "apps", "orders");
    await writeJson(join(childAppDir, "package.json"), {
      name: "orders-app",
      version: "1.0.0",
      dependencies: {
        "@bunest/core": "^0.1.0",
        "@bunest/orm": "workspace:*",
        "@bunest/validation": "^0.2.0",
      },
    });

    const resolved = resolveDeclaredBunestPackages(childAppDir);
    expect(resolved).toEqual([
      {
        name: "@bunest/core",
        declared: "^0.1.0",
        resolved: "0.1.5",
        status: "installed",
        resolvedPath: realpathSyncOf(join(hoistedCoreDir, "package.json")),
      },
      {
        name: "@bunest/orm",
        declared: "workspace:*",
        resolved: "0.2.0",
        status: "workspace",
        resolvedPath: realpathSyncOf(join(workspaceOrmDir, "package.json")),
      },
      {
        name: "@bunest/validation",
        declared: "^0.2.0",
        resolved: "0.2.1",
        status: "workspace",
        resolvedPath: realpathSyncOf(join(workspaceValDir, "package.json")),
      },
    ]);

    const info = getEnvironmentInfo(childAppDir);
    expect(info.resolvedPackages).toEqual(resolved);

    const pretty = formatEnvironmentInfo(info);
    expect(pretty).toContain("core version : 0.1.5 (declared: ^0.1.0, installed)");
    expect(pretty).toContain("orm version : 0.2.0 (declared: workspace:*, workspace)");
    expect(pretty).toContain(
      "validation version : 0.2.1 (declared: ^0.2.0, workspace)",
    );

    const cap = createCapturedIO(childAppDir);
    const cliRes = await runCli(["info"], cap.io);
    expect(cliRes.exitCode).toBe(0);
    expect(cap.stdout.join("\n")).toContain("0.1.5 (declared: ^0.1.0, installed)");
    expect(cap.stdout.join("\n")).toContain("0.2.0 (declared: workspace:*, workspace)");
  });
});
