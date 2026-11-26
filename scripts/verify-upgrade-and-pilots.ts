/**
 * End-to-end Week 5 & Week 6 verification harness:
 *   - Local HTTP npm registry serving packed @bunest/* tarballs (0 monorepo symlinks)
 *   - Pilot A: Greenfield REST API scaffolded via `bunest new` + UsersModule + DTO validation
 *              + /live & /ready + burst load check + SIGTERM in-flight drain
 *   - Pilot B: NestJS-migrated module with @Controller, @UseGuards, @UseInterceptors,
 *              ValidationPipe, @Entity + @Repository (SQLite), restart persistence, tx rollback
 *   - Week 5 Upgrade: 0.1.0 -> 0.1.1-rc.0 (packed in temp dir without touching tracked repo
 *              package.json files), upgrading both Pilot A & Pilot B via `bun install` and
 *              re-verifying typecheck, tests, build, and live runtime behavior.
 *
 * Usage:
 *   bun run scripts/verify-upgrade-and-pilots.ts
 */
import {
  dirname,
  ensureDir,
  existsSyncPath,
  join,
  lstatPath,
  readDirSyncNames,
  realpathOf,
  removePath,
  resolve,
  statSyncPath,
} from "../packages/core/src/common/index";
import { rewriteExportsForPublish, type PublishableManifest } from "./publish-manifest";

interface PkgMeta extends PublishableManifest {
  name: string;
  version: string;
  dir: string;
  private?: boolean;
  files?: string[];
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  bin?: Record<string, string> | string;
  publishConfig?: { access?: string; registry?: string };
}

interface PackedTarballRecord {
  name: string;
  version: string;
  tarballFilename: string;
  tarballPath: string;
  shasum: string;
  integrity: string;
  manifest: Record<string, unknown>;
}

interface LoadBurstMetrics {
  totalRequests: number;
  concurrency: number;
  status2xx: number;
  status5xx: number;
  errorRate5xxPct: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  durationMs: number;
  rssBeforeMb: number;
  rssAfterMb: number;
  rssDeltaMb: number;
}

interface PilotAReport {
  version: string;
  scaffoldMs: number;
  installMs: number;
  typecheckMs: number;
  testMs: number;
  verifyMs: number;
  buildMs: number;
  load: LoadBurstMetrics;
  sigtermDrainMs: number;
  sigtermInFlightStatus: number;
  sigtermExitCode: number | null;
}

interface PilotBReport {
  version: string;
  installMs: number;
  typecheckMs: number;
  testMs: number;
  buildMs: number;
  restartPersistCount: number;
  txRollbackRowCountAfterFail: number;
  guardRejectStatus: number;
  guardAllowStatus: number;
  validationRejectStatus: number;
  interceptorHeader: string | null;
}

const ROOT = resolve(import.meta.dir, "..");
const PACKAGES_DIR = join(ROOT, "packages");
const BASE_VERSION = "0.1.0";
const UPGRADE_VERSION = "0.1.1-rc.0";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
}

function nowMs(): number {
  return performance.now();
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function runCmd(
  cmd: string[],
  cwd: string,
  env?: Record<string, string>,
  quiet = false,
): Promise<{ stdout: string; stderr: string; durationMs: number }> {
  const start = nowMs();
  const proc = Bun.spawn(cmd, {
    cwd,
    stdout: quiet ? "pipe" : "pipe",
    stderr: "pipe",
    env: { ...Bun.env, ...(env ?? {}) },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const durationMs = round2(nowMs() - start);
  if (code !== 0) {
    throw new Error(
      `Command failed (exit ${code}, ${durationMs}ms): ${cmd.join(" ")}\n` +
        `cwd: ${cwd}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
    );
  }
  return { stdout, stderr, durationMs };
}

async function loadPublishablePackages(): Promise<PkgMeta[]> {
  const dirs = readDirSyncNames(PACKAGES_DIR)
    .map((name) => join(PACKAGES_DIR, name))
    .filter((p) => {
      try {
        return statSyncPath(p).isDirectory();
      } catch {
        return false;
      }
    });

  const pkgs: PkgMeta[] = [];
  for (const dir of dirs) {
    const pkgPath = join(dir, "package.json");
    const file = Bun.file(pkgPath);
    if (!(await file.exists())) continue;
    const json = (await file.json()) as PkgMeta;
    if (json.private) continue;
    pkgs.push({ ...json, dir });
  }
  return pkgs.sort((a, b) => a.name.localeCompare(b.name));
}

async function copyFileIfExists(src: string, dest: string): Promise<void> {
  if (!existsSyncPath(src)) return;
  await ensureDir(dirname(dest));
  await Bun.write(dest, Bun.file(src));
}

async function copyDirTree(srcRoot: string, destRoot: string): Promise<void> {
  if (!existsSyncPath(srcRoot)) return;
  const glob = new Bun.Glob("**/*");
  for await (const rel of glob.scan({ cwd: srcRoot, onlyFiles: true })) {
    const target = join(destRoot, rel);
    await ensureDir(dirname(target));
    await Bun.write(target, Bun.file(join(srcRoot, rel)));
  }
}

/**
 * Stages and packs all publishable @bunest/* packages at `targetVersion` entirely
 * inside `stageBaseDir` WITHOUT modifying any tracked files in the repository.
 */
async function packAllPackagesForVersion(
  pkgs: PkgMeta[],
  targetVersion: string,
  stageBaseDir: string,
  tarballOutDir: string,
): Promise<PackedTarballRecord[]> {
  const start = nowMs();
  await ensureDir(stageBaseDir);
  await ensureDir(tarballOutDir);

  const records: PackedTarballRecord[] = [];
  const pkgNames = new Set(pkgs.map((p) => p.name));

  for (const pkg of pkgs) {
    const safeName = pkg.name.replace(/^@/, "").replace(/\//g, "-");
    const pkgStageDir = join(stageBaseDir, safeName);
    await ensureDir(pkgStageDir);

    // Copy files declared in `package.json#files` (dist, src, README.md, etc.)
    const declaredFiles = pkg.files ?? ["dist", "src", "README.md"];
    for (const entry of declaredFiles) {
      const srcPath = join(pkg.dir, entry);
      if (!existsSyncPath(srcPath)) continue;
      const st = statSyncPath(srcPath);
      if (st.isDirectory()) {
        await copyDirTree(srcPath, join(pkgStageDir, entry));
      } else {
        await copyFileIfExists(srcPath, join(pkgStageDir, entry));
      }
    }
    await copyFileIfExists(join(pkg.dir, "LICENSE"), join(pkgStageDir, "LICENSE"));

    // Build publishable manifest with rewritten exports + version + concrete internal dep versions
    const { dir: _ignoredDir, ...rawManifest } = pkg;
    const rewritten = rewriteExportsForPublish({
      ...rawManifest,
      version: targetVersion,
    });

    const rewriteDepMap = (
      deps?: Record<string, string>,
    ): Record<string, string> | undefined => {
      if (!deps) return undefined;
      const next: Record<string, string> = {};
      for (const [k, v] of Object.entries(deps)) {
        if (pkgNames.has(k) && v.startsWith("workspace:")) {
          next[k] = targetVersion;
        } else {
          next[k] = v;
        }
      }
      return next;
    };

    const publishManifest: Record<string, unknown> = {
      ...rewritten,
      dependencies: rewriteDepMap(pkg.dependencies),
      peerDependencies: rewriteDepMap(pkg.peerDependencies),
    };
    // Strip workspace devDependencies from published manifest so consumers never resolve them
    delete publishManifest.devDependencies;
    if (!publishManifest.dependencies) delete publishManifest.dependencies;
    if (!publishManifest.peerDependencies) delete publishManifest.peerDependencies;

    await Bun.write(
      join(pkgStageDir, "package.json"),
      JSON.stringify(publishManifest, null, 2) + "\n",
    );

    const expectedFilename = `${safeName}-${targetVersion}.tgz`;
    await runCmd(
      ["bun", "pm", "pack", "--destination", tarballOutDir, "--quiet"],
      pkgStageDir,
      undefined,
      true,
    );

    const tarballPath = join(tarballOutDir, expectedFilename);
    assert(
      existsSyncPath(tarballPath),
      `Expected packed tarball not found: ${tarballPath}`,
    );
    const bytes = new Uint8Array(await Bun.file(tarballPath).arrayBuffer());
    const shasum = new Bun.CryptoHasher("sha1").update(bytes).digest("hex");
    const integrity = `sha512-${new Bun.CryptoHasher("sha512").update(bytes).digest("base64")}`;

    records.push({
      name: pkg.name,
      version: targetVersion,
      tarballFilename: expectedFilename,
      tarballPath,
      shasum,
      integrity,
      manifest: publishManifest,
    });
  }

  console.log(
    `[pack] Packed ${records.length} @bunest/* tarballs @ ${targetVersion} in ${round2(nowMs() - start)}ms`,
  );
  return records;
}

class LocalNpmRegistry {
  private readonly packages = new Map<string, Map<string, PackedTarballRecord>>();
  private readonly tarballs = new Map<string, string>();
  private readonly distTags = new Map<string, Record<string, string>>();
  private server: ReturnType<typeof Bun.serve> | null = null;
  public url = "";

  registerVersion(records: PackedTarballRecord[], tag: string): void {
    for (const rec of records) {
      let byVer = this.packages.get(rec.name);
      if (!byVer) {
        byVer = new Map();
        this.packages.set(rec.name, byVer);
      }
      byVer.set(rec.version, rec);
      this.tarballs.set(rec.tarballFilename, rec.tarballPath);

      const tags = this.distTags.get(rec.name) ?? {};
      tags[tag] = rec.version;
      this.distTags.set(rec.name, tags);
    }
  }

  start(): void {
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        const u = new URL(req.url);
        const pathname = u.pathname;

        if (pathname.startsWith("/tarballs/")) {
          const filename = decodeURIComponent(pathname.slice("/tarballs/".length));
          const filePath = this.tarballs.get(filename);
          if (!filePath) {
            return new Response("Not Found", { status: 404 });
          }
          return new Response(Bun.file(filePath), {
            headers: { "content-type": "application/octet-stream" },
          });
        }

        const pkgName = decodeURIComponent(pathname.slice(1));
        const byVer = this.packages.get(pkgName);
        if (!byVer) {
          return Response.json({ error: "Not found" }, { status: 404 });
        }

        const versions: Record<string, unknown> = {};
        for (const [ver, rec] of byVer.entries()) {
          versions[ver] = {
            ...rec.manifest,
            dist: {
              tarball: `${this.url}/tarballs/${encodeURIComponent(rec.tarballFilename)}`,
              shasum: rec.shasum,
              integrity: rec.integrity,
            },
          };
        }

        return Response.json({
          _id: pkgName,
          name: pkgName,
          "dist-tags": this.distTags.get(pkgName) ?? {},
          versions,
        });
      },
    });
    this.url = `http://127.0.0.1:${this.server.port}`;
    console.log(`[registry] Local HTTP npm registry listening at ${this.url}`);
  }

  stop(): void {
    this.server?.stop(true);
    this.server = null;
  }
}

/**
 * Verifies that every installed `@bunest/*` package in `appDir/node_modules/@bunest`
 * is a real installed copy at `expectedVersion` with ZERO symlinks pointing into the monorepo.
 */
async function assertNoMonorepoSymlinks(
  appDir: string,
  expectedVersion: string,
): Promise<number> {
  const scopeDir = join(appDir, "node_modules", "@bunest");
  assert(existsSyncPath(scopeDir), `Missing ${scopeDir}`);
  const entries = readDirSyncNames(scopeDir);
  assert(entries.length > 0, `No @bunest/* packages installed in ${scopeDir}`);
  const normalizedRoot = (await realpathOf(ROOT)).toLowerCase();

  for (const name of entries) {
    const pkgPath = join(scopeDir, name);
    const lstat = await lstatPath(pkgPath);
    const real = (await realpathOf(pkgPath)).toLowerCase();
    assert(
      !real.startsWith(normalizedRoot),
      `Monorepo symlink leak detected: ${pkgPath} -> ${real}`,
    );
    if (lstat.isSymbolicLink()) {
      // Symlinks inside bun's own .bun cache within appDir are fine; pointing to monorepo is forbidden
      const normalizedApp = (await realpathOf(appDir)).toLowerCase();
      assert(
        real.startsWith(normalizedApp),
        `Unexpected external symlink for @bunest/${name}: ${real}`,
      );
    }
    const pkgJson = (await Bun.file(join(pkgPath, "package.json")).json()) as {
      name: string;
      version: string;
      exports?: Record<string, string | { bun?: string; import?: string }>;
    };
    assert(
      pkgJson.version === expectedVersion,
      `Expected ${pkgJson.name}@${expectedVersion} in ${appDir}, found ${pkgJson.version}`,
    );
    const rootExport = pkgJson.exports?.["."];
    if (rootExport && typeof rootExport === "object" && typeof rootExport.bun === "string") {
      assert(
        !rootExport.bun.startsWith("./src/"),
        `Installed ${pkgJson.name}@${pkgJson.version} still has raw ./src/ bun export (${rootExport.bun}) — stale cache or publish-manifest bug!`,
      );
    }
  }
  return entries.length;
}

async function waitForServerReady(
  url: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = nowMs() + timeoutMs;
  let lastError: unknown;
  while (nowMs() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await Bun.sleep(50);
  }
  throw new Error(`Server at ${url} did not become ready within ${timeoutMs}ms: ${String(lastError)}`);
}

async function getFreePort(): Promise<number> {
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("ok"),
  });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

// ============================================================================
// Pilot A: Greenfield REST API (scaffolded via `bunest new`)
// ============================================================================

async function setupPilotA(
  workDir: string,
  registryUrl: string,
  version: string,
): Promise<{ appDir: string; scaffoldMs: number; installMs: number }> {
  console.log(`\n=== [Pilot A] Scaffolding greenfield REST API @ ${version} ===`);

  // 1. Install @bunest/cli from local HTTP registry in isolated cli-runner dir
  const cliRunnerDir = join(workDir, "cli-runner");
  await ensureDir(cliRunnerDir);
  await Bun.write(
    join(cliRunnerDir, "package.json"),
    JSON.stringify(
      {
        name: "bunest-cli-runner",
        private: true,
        dependencies: { "@bunest/cli": version },
      },
      null,
      2,
    ) + "\n",
  );
  await Bun.write(
    join(cliRunnerDir, "bunfig.toml"),
    `[install.cache]\ndisable = true\n\n[install.scopes]\n"@bunest" = "${registryUrl}"\n`,
  );
  await runCmd(["bun", "install", "--no-cache"], cliRunnerDir, { BUN_INSTALL_CACHE_DIR: join(workDir, "bun-cache") }, true);
  await assertNoMonorepoSymlinks(cliRunnerDir, version);

  // 2. Scaffold Pilot A via `bunest new`
  const appDir = join(workDir, "pilot-a");
  const cliEntry = join(
    cliRunnerDir,
    "node_modules",
    "@bunest",
    "cli",
    "dist",
    "cli.js",
  );
  const scaffoldRes = await runCmd(
    ["bun", cliEntry, "new", "pilot-a", "--dir", appDir, "--skip-install"],
    workDir,
    undefined,
    true,
  );
  const scaffoldMs = scaffoldRes.durationMs;

  // Pin exact version in package.json and add scoped registry in bunfig.toml
  const pkgPath = join(appDir, "package.json");
  const pkgJson = (await Bun.file(pkgPath).json()) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  for (const section of [pkgJson.dependencies, pkgJson.devDependencies]) {
    for (const key of Object.keys(section)) {
      if (key.startsWith("@bunest/")) {
        section[key] = version;
      }
    }
  }
  await Bun.write(pkgPath, JSON.stringify(pkgJson, null, 2) + "\n");

  const bunfigPath = join(appDir, "bunfig.toml");
  const existingBunfig = await Bun.file(bunfigPath).text();
  await Bun.write(
    bunfigPath,
    `${existingBunfig.trimEnd()}\n\n[install.cache]\ndisable = true\n\n[install.scopes]\n"@bunest" = "${registryUrl}"\n`,
  );

  // 3. Add UsersModule (DTO with @bunest/validation/validator, service, controller),
  //    /live & /ready probes, /metrics/memory, /slow, and graceful shutdown hooks.
  await ensureDir(join(appDir, "src", "users", "dto"));

  await Bun.write(
    join(appDir, "src", "users", "dto", "create-user.dto.ts"),
    `import { IsEmail, IsInt, IsString, Min, MinLength } from "@bunest/validation/validator";

export class CreateUserDto {
  @IsString()
  @MinLength(2)
  name!: string;

  @IsEmail()
  email!: string;

  @IsInt()
  @Min(18)
  age!: number;
}
`,
  );

  await Bun.write(
    join(appDir, "src", "users", "users.service.ts"),
    `import { Injectable, NotFoundException } from "@bunest/core";
import type { CreateUserDto } from "./dto/create-user.dto";

export interface UserRecord {
  id: number;
  name: string;
  email: string;
  age: number;
}

@Injectable()
export class UsersService {
  private readonly users: UserRecord[] = [];
  private nextId = 1;

  create(dto: CreateUserDto): UserRecord {
    const user: UserRecord = {
      id: this.nextId++,
      name: dto.name,
      email: dto.email,
      age: dto.age,
    };
    this.users.push(user);
    return user;
  }

  findAll(): UserRecord[] {
    return [...this.users];
  }

  findOne(id: number): UserRecord {
    const user = this.users.find((u) => u.id === id);
    if (!user) {
      throw new NotFoundException(\`User \${id} not found\`);
    }
    return user;
  }
}
`,
  );

  await Bun.write(
    join(appDir, "src", "users", "users.controller.ts"),
    `import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseIntPipe, Post } from "@bunest/core";
import { CreateUserDto } from "./dto/create-user.dto";
import { UsersService, type UserRecord } from "./users.service";

@Controller("users")
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateUserDto): UserRecord {
    return this.usersService.create(dto);
  }

  @Get()
  findAll(): UserRecord[] {
    return this.usersService.findAll();
  }

  @Get(":id")
  findOne(@Param("id", ParseIntPipe) id: number): UserRecord {
    return this.usersService.findOne(id);
  }
}
`,
  );

  await Bun.write(
    join(appDir, "src", "users", "users.module.ts"),
    `import { Module } from "@bunest/core";
import { UsersController } from "./users.controller";
import { UsersService } from "./users.service";

@Module({
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
`,
  );

  await Bun.write(
    join(appDir, "src", "health.controller.ts"),
    `import {
  Controller,
  Get,
  Post,
  Query,
  ServiceUnavailableException,
  type BeforeApplicationShutdown,
  type OnApplicationShutdown,
} from "@bunest/core";

@Controller()
export class HealthController implements BeforeApplicationShutdown, OnApplicationShutdown {
  private ready = true;

  beforeApplicationShutdown(_signal?: string): void {
    this.ready = false;
  }

  onApplicationShutdown(signal?: string): void {
    console.log(\`[pilot-a] onApplicationShutdown signal=\${signal ?? "unknown"}\`);
  }

  @Get("live")
  live(): { status: "ok" } {
    return { status: "ok" };
  }

  @Get("ready")
  readyProbe(): { status: "ready" } {
    if (!this.ready) {
      throw new ServiceUnavailableException("Shutting down");
    }
    return { status: "ready" };
  }

  @Get("metrics/memory")
  memory(): { rssBytes: number; heapUsedBytes: number } {
    const mem = process.memoryUsage();
    return { rssBytes: mem.rss, heapUsedBytes: mem.heapUsed };
  }

  @Get("slow")
  async slow(@Query("ms") msRaw?: string): Promise<{ drained: true; waitedMs: number }> {
    const ms = Math.min(2000, Math.max(10, Number(msRaw ?? 200) || 200));
    await Bun.sleep(ms);
    return { drained: true, waitedMs: ms };
  }

  @Post("_internal/trigger-sigterm")
  triggerSigterm(): { triggered: boolean } {
    if (Bun.env.ALLOW_SIGTERM_TRIGGER !== "1") {
      throw new ServiceUnavailableException("Disabled");
    }
    setTimeout(() => {
      process.emit("SIGTERM" as never);
    }, 5);
    return { triggered: true };
  }
}
`,
  );

  await Bun.write(
    join(appDir, "src", "app.module.ts"),
    `import { Module } from "@bunest/core";
import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import { HealthController } from "./health.controller";
import { UsersModule } from "./users/users.module";

@Module({
  imports: [UsersModule],
  controllers: [AppController, HealthController],
  providers: [AppService],
})
export class AppModule {}
`,
  );

  await Bun.write(
    join(appDir, "src", "main.ts"),
    `import { BunestFactory } from "@bunest/core";
import { ValidationPipe } from "@bunest/validation";
import { AppModule } from "./app.module";

async function bootstrap(): Promise<void> {
  const app = await BunestFactory.create(AppModule);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.enableShutdownHooks();

  const port = Number(Bun.env.PORT ?? 3000);
  const info = await app.listen(port, "127.0.0.1");
  console.log(\`Bunest server listening at \${info.url}\`);
}

await bootstrap();
`,
  );

  await Bun.write(
    join(appDir, "test", "users.spec.ts"),
    `import { describe, expect, it } from "bun:test";
import { ValidationPipe } from "@bunest/validation";
import { Test } from "@bunest/testing";
import { AppModule } from "../src/app.module";

describe("Pilot A UsersModule & Probes", () => {
  it("validates DTOs, creates users, and serves /live and /ready", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    const app = moduleRef.createBunestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    const client = moduleRef.createTestClient(app);

    try {
      const live = await client.get("/live");
      live.expectStatus(200);
      expect(await live.json()).toEqual({ status: "ok" });

      const ready = await client.get("/ready");
      ready.expectStatus(200);
      expect(await ready.json()).toEqual({ status: "ready" });

      const created = await client.post("/users", {
        json: { name: "Ada", email: "ada@bunest.dev", age: 30 },
      });
      created.expectStatus(201);
      expect(await created.json()).toEqual({
        id: 1,
        name: "Ada",
        email: "ada@bunest.dev",
        age: 30,
      });

      const invalid = await client.post("/users", {
        json: { name: "A", email: "not-an-email", age: 12 },
      });
      invalid.expectStatus(400);
      const errBody = await invalid.json<{
        statusCode: number;
        error: string;
        message: string;
        details: Array<{ field: string; message: string }>;
      }>();
      expect(errBody.statusCode).toBe(400);
      expect(errBody.message).toBe("Validation failed");
      expect(Array.isArray(errBody.details)).toBe(true);
      expect(errBody.details.length).toBeGreaterThanOrEqual(2);
    } finally {
      await moduleRef.close();
    }
  });
});
`,
  );

  const installRes = await runCmd(["bun", "install", "--no-cache"], appDir, { BUN_INSTALL_CACHE_DIR: join(workDir, "bun-cache") }, true);
  await assertNoMonorepoSymlinks(appDir, version);

  return { appDir, scaffoldMs, installMs: installRes.durationMs };
}

async function verifyPilotA(
  appDir: string,
  version: string,
  scaffoldMs: number,
  installMs: number,
): Promise<PilotAReport> {
  const typecheckRes = await runCmd(["bun", "run", "typecheck"], appDir, undefined, true);
  const testRes = await runCmd(["bun", "test"], appDir, undefined, true);
  const verifyRes = await runCmd(["bun", "run", "verify"], appDir, undefined, true);
  const buildRes = await runCmd(["bun", "run", "build"], appDir, undefined, true);

  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const proc = Bun.spawn(["bun", "dist/main.js"], {
    cwd: appDir,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...Bun.env,
      PORT: String(port),
      ALLOW_SIGTERM_TRIGGER: "1",
    },
  });

  try {
    await waitForServerReady(`${baseUrl}/live`);

    // 1. /live & /ready
    const liveRes = await fetch(`${baseUrl}/live`);
    assert(liveRes.status === 200, `Expected GET /live 200, got ${liveRes.status}`);
    const readyRes = await fetch(`${baseUrl}/ready`);
    assert(readyRes.status === 200, `Expected GET /ready 200, got ${readyRes.status}`);

    // 2. Valid POST /users (201)
    const postValid = await fetch(`${baseUrl}/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Grace Hopper", email: "grace@bunest.dev", age: 42 }),
    });
    assert(postValid.status === 201, `Expected POST /users 201, got ${postValid.status}`);
    const createdUser = (await postValid.json()) as { id: number; name: string; email: string; age: number };
    assert(createdUser.id === 1 && createdUser.email === "grace@bunest.dev", "Unexpected created user payload");

    // 3. Invalid DTO POST /users (400 envelope)
    const postInvalid = await fetch(`${baseUrl}/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "X", email: "bad-email", age: 10 }),
    });
    assert(postInvalid.status === 400, `Expected invalid POST /users 400, got ${postInvalid.status}`);
    const errEnvelope = (await postInvalid.json()) as {
      statusCode?: number;
      message?: unknown;
      details?: unknown;
    };
    assert(errEnvelope.statusCode === 400, "Expected statusCode=400 in error envelope");
    assert(errEnvelope.message === "Validation failed", `Expected message="Validation failed", got ${JSON.stringify(errEnvelope)}`);
    assert(
      Array.isArray(errEnvelope.details) && errEnvelope.details.length >= 2,
      `Expected validation details array, got ${JSON.stringify(errEnvelope)}`,
    );

    // 4. Short burst load check (240 requests, concurrency 40)
    const memBefore = (await (await fetch(`${baseUrl}/metrics/memory`)).json()) as {
      rssBytes: number;
    };
    const totalRequests = 240;
    const concurrency = 40;
    const latencies: number[] = [];
    let status2xx = 0;
    let status5xx = 0;

    const loadStart = nowMs();
    for (let offset = 0; offset < totalRequests; offset += concurrency) {
      const batchSize = Math.min(concurrency, totalRequests - offset);
      const batch = Array.from({ length: batchSize }, async (_, idx) => {
        const reqStart = nowMs();
        const url = (offset + idx) % 2 === 0 ? `${baseUrl}/users` : `${baseUrl}/live`;
        const res = await fetch(url);
        await res.arrayBuffer();
        latencies.push(nowMs() - reqStart);
        if (res.status >= 200 && res.status < 300) status2xx++;
        else if (res.status >= 500) status5xx++;
      });
      await Promise.all(batch);
    }
    const loadDurationMs = round2(nowMs() - loadStart);
    const memAfter = (await (await fetch(`${baseUrl}/metrics/memory`)).json()) as {
      rssBytes: number;
    };

    latencies.sort((a, b) => a - b);
    const load: LoadBurstMetrics = {
      totalRequests,
      concurrency,
      status2xx,
      status5xx,
      errorRate5xxPct: round2((status5xx / totalRequests) * 100),
      p50Ms: round2(percentile(latencies, 50)),
      p95Ms: round2(percentile(latencies, 95)),
      maxMs: round2(latencies[latencies.length - 1] ?? 0),
      durationMs: loadDurationMs,
      rssBeforeMb: round2(memBefore.rssBytes / (1024 * 1024)),
      rssAfterMb: round2(memAfter.rssBytes / (1024 * 1024)),
      rssDeltaMb: round2((memAfter.rssBytes - memBefore.rssBytes) / (1024 * 1024)),
    };
    assert(load.status2xx === totalRequests, `Expected ${totalRequests} 2xx responses, got ${load.status2xx}`);
    assert(load.status5xx === 0, `Expected 0 5xx responses, got ${load.status5xx}`);

    // 5. SIGTERM in-flight drain verification
    const drainStart = nowMs();
    const slowPromise = fetch(`${baseUrl}/slow?ms=220`);
    await Bun.sleep(60);

    if (process.platform === "win32") {
      // On Windows, TerminateProcess (proc.kill) bypasses JS signal handlers;
      // trigger process.emit("SIGTERM") inside the built server to exercise the exact
      // enableShutdownHooks() -> app.close() -> server.stop(false) in-flight drain path.
      const trigRes = await fetch(`${baseUrl}/_internal/trigger-sigterm`, { method: "POST" });
      assert(trigRes.status === 200 || trigRes.status === 201, `Trigger SIGTERM failed: ${trigRes.status}`);
    } else {
      proc.kill("SIGTERM");
    }

    const slowRes = await slowPromise;
    assert(slowRes.status === 200, `In-flight request failed during SIGTERM drain: HTTP ${slowRes.status}`);
    const slowJson = (await slowRes.json()) as { drained: boolean };
    assert(slowJson.drained === true, "Expected drained=true from in-flight /slow request");

    // Wait for graceful process exit
    const exitCode = await Promise.race([
      proc.exited,
      Bun.sleep(5_000).then(() => null),
    ]);
    const sigtermDrainMs = round2(nowMs() - drainStart);

    // Confirm server stopped accepting new connections
    let refused = false;
    try {
      await fetch(`${baseUrl}/live`);
    } catch {
      refused = true;
    }
    assert(refused, "Expected server to stop listening after SIGTERM shutdown");

    console.log(
      `[Pilot A @ ${version}] PASS — typecheck=${typecheckRes.durationMs}ms test=${testRes.durationMs}ms verify=${verifyRes.durationMs}ms build=${buildRes.durationMs}ms ` +
        `load(${load.totalRequests} reqs): p95=${load.p95Ms}ms 5xx=${load.errorRate5xxPct}% rssDelta=${load.rssDeltaMb}MB drain=${sigtermDrainMs}ms`,
    );

    return {
      version,
      scaffoldMs,
      installMs,
      typecheckMs: typecheckRes.durationMs,
      testMs: testRes.durationMs,
      verifyMs: verifyRes.durationMs,
      buildMs: buildRes.durationMs,
      load,
      sigtermDrainMs,
      sigtermInFlightStatus: slowRes.status,
      sigtermExitCode: exitCode,
    };
  } finally {
    try {
      proc.kill();
    } catch {
      // already exited
    }
    await proc.exited.catch(() => {});
  }
}

// ============================================================================
// Pilot B: NestJS-migrated module (Guards, Interceptors, ValidationPipe, ORM/SQLite)
// ============================================================================

async function setupPilotB(
  workDir: string,
  registryUrl: string,
  version: string,
): Promise<{ appDir: string; dbPath: string; installMs: number }> {
  console.log(`\n=== [Pilot B] Creating NestJS-migrated module app @ ${version} ===`);

  const appDir = join(workDir, "pilot-b");
  const dbPath = join(appDir, "data", "pilot-b.sqlite");
  await ensureDir(join(appDir, "src", "orders", "dto"));
  await ensureDir(join(appDir, "test"));
  await ensureDir(join(appDir, "data"));

  await Bun.write(
    join(appDir, "package.json"),
    JSON.stringify(
      {
        name: "pilot-b-nestjs-migration",
        version: "0.1.0",
        private: true,
        type: "module",
        scripts: {
          build: "bun build ./src/main.ts --outdir ./dist --target bun --format esm",
          start: "bun dist/main.js",
          test: "bun test",
          typecheck: "bun check",
        },
        dependencies: {
          "@bunest/core": version,
          "@bunest/orm": version,
          "@bunest/validation": version,
        },
        devDependencies: {
          "@bunest/cli": version,
          "@bunest/testing": version,
          "@types/bun": "latest",
          typescript: "^7.0.2",
        },
      },
      null,
      2,
    ) + "\n",
  );

  await Bun.write(
    join(appDir, "bunfig.toml"),
    `[install.cache]\ndisable = true\n\n[install.scopes]\n"@bunest" = "${registryUrl}"\n`,
  );

  await Bun.write(
    join(appDir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          lib: ["ESNext"],
          target: "ESNext",
          module: "Preserve",
          moduleDetection: "force",
          moduleResolution: "bundler",
          types: ["bun"],
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          verbatimModuleSyntax: true,
          strict: true,
          strictPropertyInitialization: false,
          skipLibCheck: true,
          noEmit: true,
        },
        include: ["src/**/*.ts", "test/**/*.ts"],
        exclude: ["node_modules", "dist"],
      },
      null,
      2,
    ) + "\n",
  );

  await Bun.write(
    join(appDir, "src", "orders", "order.entity.ts"),
    `import { Column, Entity, PrimaryGeneratedColumn } from "@bunest/orm";

@Entity("orders")
export class Order {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ unique: true })
  sku!: string;

  @Column("integer")
  amount!: number;
}
`,
  );

  await Bun.write(
    join(appDir, "src", "orders", "order.repository.ts"),
    `import { CrudRepository, Repository } from "@bunest/orm";
import { Order } from "./order.entity";

@Repository(Order)
export abstract class OrderRepository extends CrudRepository<Order, number> {
  abstract findBySku(sku: string): Promise<Order | null>;
}
`,
  );

  await Bun.write(
    join(appDir, "src", "orders", "dto", "create-order.dto.ts"),
    `import { IsInt, IsString, Min, MinLength } from "@bunest/validation/validator";

export class CreateOrderDto {
  @IsString()
  @MinLength(3)
  sku!: string;

  @IsInt()
  @Min(1)
  amount!: number;
}
`,
  );

  await Bun.write(
    join(appDir, "src", "orders", "api-key.guard.ts"),
    `import {
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from "@bunest/core";

@Injectable()
export class ApiKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const apiKey = req.headers.get("x-api-key");
    if (apiKey !== "pilot-secret-key") {
      throw new UnauthorizedException("Invalid or missing x-api-key header");
    }
    return true;
  }
}
`,
  );

  await Bun.write(
    join(appDir, "src", "orders", "envelope.interceptor.ts"),
    `import {
  Injectable,
  type BunestInterceptor,
  type CallHandler,
  type ExecutionContext,
} from "@bunest/core";

@Injectable()
export class EnvelopeInterceptor implements BunestInterceptor {
  async intercept(context: ExecutionContext, next: CallHandler): Promise<unknown> {
    const start = performance.now();
    const data = await next.handle();
    const res = context.switchToHttp().getResponse();
    res.header("x-pilot-interceptor", "active");
    return {
      ok: true,
      elapsedMs: Math.round((performance.now() - start) * 100) / 100,
      data,
    };
  }
}
`,
  );

  await Bun.write(
    join(appDir, "src", "orders", "orders.service.ts"),
    `import { Injectable } from "@bunest/core";
import { DataSource, InjectDataSource } from "@bunest/orm";
import type { CreateOrderDto } from "./dto/create-order.dto";
import { Order } from "./order.entity";
import { OrderRepository } from "./order.repository";

@Injectable()
export class OrdersService {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  private repo(): OrderRepository {
    return this.dataSource.getDeclarativeRepository(OrderRepository);
  }

  async create(dto: CreateOrderDto): Promise<Order> {
    return this.repo().save({ sku: dto.sku, amount: dto.amount });
  }

  async findAll(): Promise<Order[]> {
    return this.repo().findAll();
  }

  async findBySku(sku: string): Promise<Order | null> {
    return this.repo().findBySku(sku);
  }

  async createAndFailInTransaction(dto: CreateOrderDto): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await manager.getRepository(Order).save({
        sku: dto.sku,
        amount: dto.amount,
      });
      throw new Error("Simulated transaction failure");
    });
  }
}
`,
  );

  await Bun.write(
    join(appDir, "src", "orders", "orders.controller.ts"),
    `import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
  UseInterceptors,
} from "@bunest/core";
import { ApiKeyGuard } from "./api-key.guard";
import { CreateOrderDto } from "./dto/create-order.dto";
import { EnvelopeInterceptor } from "./envelope.interceptor";
import { Order } from "./order.entity";
import { OrdersService } from "./orders.service";

@Controller("orders")
@UseGuards(ApiKeyGuard)
@UseInterceptors(EnvelopeInterceptor)
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() dto: CreateOrderDto): Promise<Order> {
    return this.ordersService.create(dto);
  }

  @Get()
  findAll(): Promise<Order[]> {
    return this.ordersService.findAll();
  }

  @Post("tx-rollback")
  async txRollback(@Body() dto: CreateOrderDto): Promise<{ neverReached: boolean }> {
    await this.ordersService.createAndFailInTransaction(dto);
    return { neverReached: true };
  }
}
`,
  );

  await Bun.write(
    join(appDir, "src", "app.module.ts"),
    `import { Controller, Get, Module, type DynamicModule } from "@bunest/core";
import { OrmModule } from "@bunest/orm";
import { ApiKeyGuard } from "./orders/api-key.guard";
import { EnvelopeInterceptor } from "./orders/envelope.interceptor";
import { Order } from "./orders/order.entity";
import { OrdersController } from "./orders/orders.controller";
import { OrdersService } from "./orders/orders.service";

@Controller()
class HealthController {
  @Get("live")
  live(): { status: "ok" } {
    return { status: "ok" };
  }
}

@Module({})
export class AppModule {
  static register(databasePath: string): DynamicModule {
    return {
      module: AppModule,
      imports: [
        OrmModule.forRoot({
          type: "sqlite",
          database: databasePath,
          entities: [Order],
          synchronize: true,
        }),
        OrmModule.forFeature([Order]),
      ],
      controllers: [HealthController, OrdersController],
      providers: [ApiKeyGuard, EnvelopeInterceptor, OrdersService],
    };
  }
}
`,
  );

  await Bun.write(
    join(appDir, "src", "main.ts"),
    `import { BunestFactory } from "@bunest/core";
import { ValidationPipe } from "@bunest/validation";
import { AppModule } from "./app.module";

async function bootstrap(): Promise<void> {
  const dbPath = Bun.env.SQLITE_DB_PATH ?? ":memory:";
  const app = await BunestFactory.create(AppModule.register(dbPath));
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.enableShutdownHooks();

  const port = Number(Bun.env.PORT ?? 3001);
  const info = await app.listen(port, "127.0.0.1");
  console.log(\`Pilot B listening at \${info.url}\`);
}

await bootstrap();
`,
  );

  await Bun.write(
    join(appDir, "test", "orders.spec.ts"),
    `import { describe, expect, it } from "bun:test";
import { ValidationPipe } from "@bunest/validation";
import { Test } from "@bunest/testing";
import { AppModule } from "../src/app.module";

describe("Pilot B NestJS-migrated OrdersModule", () => {
  it("enforces guard, interceptor, validation, CRUD, and tx rollback", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register(":memory:")],
    }).compile();

    const app = moduleRef.createBunestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    const client = moduleRef.createTestClient(app);

    try {
      const unauth = await client.get("/orders");
      unauth.expectStatus(401);

      const invalid = await client.post("/orders", {
        headers: { "x-api-key": "pilot-secret-key" },
        json: { sku: "x", amount: 0 },
      });
      invalid.expectStatus(400);

      const created = await client.post("/orders", {
        headers: { "x-api-key": "pilot-secret-key" },
        json: { sku: "SKU-001", amount: 5 },
      });
      created.expectStatus(201);
      expect(created.headers.get("x-pilot-interceptor")).toBe("active");
      const body = await created.json<{ ok: boolean; data: { sku: string; amount: number } }>();
      expect(body.ok).toBe(true);
      expect(body.data.sku).toBe("SKU-001");

      const rollback = await client.post("/orders/tx-rollback", {
        headers: { "x-api-key": "pilot-secret-key" },
        json: { sku: "SKU-ROLLBACK", amount: 99 },
      });
      rollback.expectStatus(500);

      const list = await client.get("/orders", {
        headers: { "x-api-key": "pilot-secret-key" },
      });
      list.expectStatus(200);
      const listJson = await list.json<{ ok: boolean; data: Array<{ sku: string }> }>();
      expect(listJson.data.map((o) => o.sku)).toEqual(["SKU-001"]);
    } finally {
      await moduleRef.close();
    }
  });
});
`,
  );

  const installRes = await runCmd(["bun", "install", "--no-cache"], appDir, { BUN_INSTALL_CACHE_DIR: join(workDir, "bun-cache") }, true);
  await assertNoMonorepoSymlinks(appDir, version);

  return { appDir, dbPath, installMs: installRes.durationMs };
}

async function verifyPilotB(
  appDir: string,
  dbPath: string,
  version: string,
  installMs: number,
  skuPrefix: string,
): Promise<PilotBReport> {
  const typecheckRes = await runCmd(["bun", "run", "typecheck"], appDir, undefined, true);
  const testRes = await runCmd(["bun", "test"], appDir, undefined, true);
  const buildRes = await runCmd(["bun", "run", "build"], appDir, undefined, true);

  // Start server #1 -> verify guard, interceptor, validation, CRUD, tx rollback -> stop
  const port1 = await getFreePort();
  const url1 = `http://127.0.0.1:${port1}`;
  const proc1 = Bun.spawn(["bun", "dist/main.js"], {
    cwd: appDir,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...Bun.env, PORT: String(port1), SQLITE_DB_PATH: dbPath },
  });

  let guardRejectStatus = 0;
  let guardAllowStatus = 0;
  let validationRejectStatus = 0;
  let interceptorHeader: string | null = null;
  let txRollbackRowCountAfterFail = -1;

  try {
    await waitForServerReady(`${url1}/live`);

    // Guard rejects without x-api-key
    const unauthRes = await fetch(`${url1}/orders`);
    guardRejectStatus = unauthRes.status;
    assert(guardRejectStatus === 401, `Expected 401 without x-api-key, got ${guardRejectStatus}`);

    // Validation rejects invalid DTO
    const invalidRes = await fetch(`${url1}/orders`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "pilot-secret-key",
      },
      body: JSON.stringify({ sku: "a", amount: -5 }),
    });
    validationRejectStatus = invalidRes.status;
    assert(validationRejectStatus === 400, `Expected 400 on invalid DTO, got ${validationRejectStatus}`);

    // Valid POST /orders (201) with interceptor envelope & header
    const persistedSku = `${skuPrefix}-PERSIST`;
    const createRes = await fetch(`${url1}/orders`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "pilot-secret-key",
      },
      body: JSON.stringify({ sku: persistedSku, amount: 42 }),
    });
    assert(createRes.status === 201, `Expected 201 on valid POST /orders, got ${createRes.status}`);
    interceptorHeader = createRes.headers.get("x-pilot-interceptor");
    assert(interceptorHeader === "active", `Expected x-pilot-interceptor=active, got ${interceptorHeader}`);
    const createJson = (await createRes.json()) as {
      ok: boolean;
      data: { id: number; sku: string; amount: number };
    };
    assert(createJson.ok === true && createJson.data.sku === persistedSku, "Unexpected interceptor envelope");

    // Transaction rollback test: failed tx writes nothing
    const rollbackSku = `${skuPrefix}-ROLLBACK`;
    const txRes = await fetch(`${url1}/orders/tx-rollback`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "pilot-secret-key",
      },
      body: JSON.stringify({ sku: rollbackSku, amount: 999 }),
    });
    assert(txRes.status === 500, `Expected 500 from failed transaction, got ${txRes.status}`);

    const afterTxRes = await fetch(`${url1}/orders`, {
      headers: { "x-api-key": "pilot-secret-key" },
    });
    guardAllowStatus = afterTxRes.status;
    assert(guardAllowStatus === 200, `Expected 200 on GET /orders, got ${guardAllowStatus}`);
    const afterTxJson = (await afterTxRes.json()) as {
      ok: boolean;
      data: Array<{ sku: string }>;
    };
    assert(
      !afterTxJson.data.some((o) => o.sku === rollbackSku),
      `Transaction rollback leaked row ${rollbackSku}!`,
    );
    txRollbackRowCountAfterFail = afterTxJson.data.length;
  } finally {
    try {
      proc1.kill();
    } catch {
      // ignore
    }
    await proc1.exited.catch(() => {});
  }

  // Start server #2 pointing at the SAME SQLite file -> verify persistence across restart
  const port2 = await getFreePort();
  const url2 = `http://127.0.0.1:${port2}`;
  const proc2 = Bun.spawn(["bun", "dist/main.js"], {
    cwd: appDir,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...Bun.env, PORT: String(port2), SQLITE_DB_PATH: dbPath },
  });

  let restartPersistCount = 0;
  try {
    await waitForServerReady(`${url2}/live`);
    const listRes = await fetch(`${url2}/orders`, {
      headers: { "x-api-key": "pilot-secret-key" },
    });
    assert(listRes.status === 200, `Expected 200 after restart, got ${listRes.status}`);
    const listJson = (await listRes.json()) as {
      ok: boolean;
      data: Array<{ sku: string; amount: number }>;
    };
    const persistedSku = `${skuPrefix}-PERSIST`;
    assert(
      listJson.data.some((o) => o.sku === persistedSku && o.amount === 42),
      `Persisted order ${persistedSku} missing after restart!`,
    );
    restartPersistCount = listJson.data.length;
  } finally {
    try {
      proc2.kill();
    } catch {
      // ignore
    }
    await proc2.exited.catch(() => {});
  }

  console.log(
    `[Pilot B @ ${version}] PASS — typecheck=${typecheckRes.durationMs}ms test=${testRes.durationMs}ms build=${buildRes.durationMs}ms ` +
      `guard=${guardRejectStatus}/${guardAllowStatus} validation=${validationRejectStatus} persistedRows=${restartPersistCount}`,
  );

  return {
    version,
    installMs,
    typecheckMs: typecheckRes.durationMs,
    testMs: testRes.durationMs,
    buildMs: buildRes.durationMs,
    restartPersistCount,
    txRollbackRowCountAfterFail,
    guardRejectStatus,
    guardAllowStatus,
    validationRejectStatus,
    interceptorHeader,
  };
}

// ============================================================================
// Week 5 Upgrade helper: 0.1.0 -> 0.1.1-rc.0
// ============================================================================

async function upgradeAppToVersion(
  appDir: string,
  targetVersion: string,
  cacheDir: string,
): Promise<number> {
  const pkgPath = join(appDir, "package.json");
  const pkgJson = (await Bun.file(pkgPath).json()) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  for (const section of [pkgJson.dependencies, pkgJson.devDependencies]) {
    if (!section) continue;
    for (const key of Object.keys(section)) {
      if (key.startsWith("@bunest/")) {
        section[key] = targetVersion;
      }
    }
  }
  await Bun.write(pkgPath, JSON.stringify(pkgJson, null, 2) + "\n");

  const res = await runCmd(["bun", "install", "--no-cache"], appDir, { BUN_INSTALL_CACHE_DIR: cacheDir }, true);
  await assertNoMonorepoSymlinks(appDir, targetVersion);
  return res.durationMs;
}

// ============================================================================
// Main orchestrator
// ============================================================================

async function main(): Promise<void> {
  const totalStart = nowMs();
  const pkgs = await loadPublishablePackages();
  assert(pkgs.length > 0, "No publishable @bunest/* packages found");

  // Ensure packages are built
  for (const pkg of pkgs) {
    assert(
      existsSyncPath(join(pkg.dir, "dist")),
      `${pkg.name} is missing dist/. Run \`bun run build\` first.`,
    );
  }

  const workDir = join(
    Bun.env.TMPDIR ?? Bun.env.TEMP ?? Bun.env.TMP ?? "/tmp",
    `bunest-upgrade-pilots-${Date.now()}-${Math.floor(Math.random() * 100_000)}`,
  );
  await ensureDir(workDir);
  console.log(`[harness] Clean out-of-monorepo workDir: ${workDir}`);

  const registry = new LocalNpmRegistry();
  try {
    // 1. Pack 0.1.0 tarballs into temp dir & start local HTTP registry
    const tarballs010 = await packAllPackagesForVersion(
      pkgs,
      BASE_VERSION,
      join(workDir, "stage-0.1.0"),
      join(workDir, "tarballs-0.1.0"),
    );
    registry.registerVersion(tarballs010, "latest");
    registry.start();

    // 2. Pilot A @ 0.1.0
    const pilotASetup = await setupPilotA(workDir, registry.url, BASE_VERSION);
    const pilotA010 = await verifyPilotA(
      pilotASetup.appDir,
      BASE_VERSION,
      pilotASetup.scaffoldMs,
      pilotASetup.installMs,
    );

    // 3. Pilot B @ 0.1.0
    const pilotBSetup = await setupPilotB(workDir, registry.url, BASE_VERSION);
    const pilotB010 = await verifyPilotB(
      pilotBSetup.appDir,
      pilotBSetup.dbPath,
      BASE_VERSION,
      pilotBSetup.installMs,
      "V010",
    );

    // 4. Week 5 Upgrade: pack temporary 0.1.1-rc.0 tarballs in temp dir (0 repo edits)
    console.log(`\n=== [Week 5 Upgrade] Packing & upgrading ${BASE_VERSION} -> ${UPGRADE_VERSION} ===`);
    const tarballsRc = await packAllPackagesForVersion(
      pkgs,
      UPGRADE_VERSION,
      join(workDir, "stage-0.1.1-rc.0"),
      join(workDir, "tarballs-0.1.1-rc.0"),
    );
    registry.registerVersion(tarballsRc, "next");

    const pilotAUpgradeInstallMs = await upgradeAppToVersion(
      pilotASetup.appDir,
      UPGRADE_VERSION,
      join(workDir, "bun-cache"),
    );
    const pilotARc = await verifyPilotA(
      pilotASetup.appDir,
      UPGRADE_VERSION,
      0,
      pilotAUpgradeInstallMs,
    );

    const pilotBUpgradeInstallMs = await upgradeAppToVersion(
      pilotBSetup.appDir,
      UPGRADE_VERSION,
      join(workDir, "bun-cache"),
    );
    const pilotBRc = await verifyPilotB(
      pilotBSetup.appDir,
      pilotBSetup.dbPath,
      UPGRADE_VERSION,
      pilotBUpgradeInstallMs,
      "V011RC0",
    );

    const totalMs = round2(nowMs() - totalStart);
    const summary = {
      status: "PASS",
      totalMs,
      packagesPackedPerVersion: pkgs.length,
      pilotA_0_1_0: pilotA010,
      pilotB_0_1_0: pilotB010,
      pilotA_0_1_1_rc_0: pilotARc,
      pilotB_0_1_1_rc_0: pilotBRc,
    };

    console.log("\n=== VERIFY UPGRADE & PILOTS SUMMARY ===");
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    registry.stop();
    await removePath(workDir, { recursive: true, force: true });
    console.log(`[harness] Cleaned up ${workDir}`);
  }
}

await main();
