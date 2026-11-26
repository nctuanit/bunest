import { afterEach, describe, expect, it } from "bun:test";
import {
  ensureDir,
  join,
  readDirNames,
  removePath,
  resolve,
} from "@bunest/core";
import { runDevServer, type CliIO } from "../src";

const TMP_DIR = Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp";
const CORE_ENTRY = resolve(
  import.meta.dir,
  "../../core/src/index.ts",
).replace(/\\/g, "/");

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = join(TMP_DIR, `${prefix}${crypto.randomUUID().slice(0, 8)}`);
  await ensureDir(dir);
  tempDirs.push(dir);
  return dir;
}

const READY_LINE_RE = /\[dev\] Ready \[boot #(\d+)\]: (https?:\/\/[^\s]+)/;

interface ReadyRecord {
  readonly boot: number;
  readonly url: string;
  readonly timestamp: number;
}

function createLiveCapture(cwd: string): {
  io: CliIO;
  stdout: string[];
  stderr: string[];
  readyEvents: ReadyRecord[];
  waitForReady: (minBoot: number, timeoutMs?: number) => Promise<ReadyRecord>;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const readyEvents: ReadyRecord[] = [];
  const waiters: Array<{
    minBoot: number;
    resolve: (rec: ReadyRecord) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  const io: CliIO = {
    cwd,
    stdout: (msg) => {
      stdout.push(msg);
      const match = READY_LINE_RE.exec(msg);
      if (match) {
        const rec: ReadyRecord = {
          boot: Number(match[1]),
          url: match[2]!,
          timestamp: Date.now(),
        };
        readyEvents.push(rec);
        for (let i = waiters.length - 1; i >= 0; i--) {
          const w = waiters[i]!;
          if (rec.boot >= w.minBoot) {
            clearTimeout(w.timer);
            waiters.splice(i, 1);
            w.resolve(rec);
          }
        }
      }
    },
    stderr: (msg) => {
      stderr.push(msg);
    },
  };

  const waitForReady = (
    minBoot: number,
    timeoutMs = 15_000,
  ): Promise<ReadyRecord> => {
    const existing = readyEvents.find((e) => e.boot >= minBoot);
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise<ReadyRecord>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        const idx = waiters.findIndex((w) => w.timer === timer);
        if (idx >= 0) waiters.splice(idx, 1);
        rejectPromise(
          new Error(
            `Timed out waiting for Ready [boot #${minBoot}].\nstdout:\n${stdout.join("\n")}\nstderr:\n${stderr.join("\n")}`,
          ),
        );
      }, timeoutMs);
      waiters.push({
        minBoot,
        resolve: resolvePromise,
        reject: rejectPromise,
        timer,
      });
    });
  };

  return { io, stdout, stderr, readyEvents, waitForReady };
}

function buildAppSource(opts: {
  marker: string;
  delayMs?: number;
}): string {
  const delayBlock =
    opts.delayMs && opts.delayMs > 0
      ? `await new Promise((r) => setTimeout(r, ${opts.delayMs}));\n`
      : "";
  return `import { BunestFactory, Controller, Get, Module } from "${CORE_ENTRY}";

@Controller()
class AppController {
  @Get("/marker")
  getMarker() {
    return { marker: ${JSON.stringify(opts.marker)} };
  }
}

@Module({ controllers: [AppController] })
class AppModule {}

async function bootstrap() {
  ${delayBlock}const app = await BunestFactory.create(AppModule, { logger: false });
  const port = Number(Bun.env.PORT ?? 0);
  await app.listen(port, "127.0.0.1");
}

void bootstrap();
`;
}

async function writeTsconfig(dir: string): Promise<void> {
  await Bun.write(
    join(dir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          verbatimModuleSyntax: true,
          strict: true,
        },
      },
      null,
      2,
    ),
  );
}

async function stopDevRun(
  runPromise: Promise<unknown>,
  timeoutMs = 10_000,
): Promise<void> {
  process.emit("SIGTERM");
  await Promise.race([
    runPromise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("Timed out waiting for runDevServer to exit")),
        timeoutMs,
      ),
    ),
  ]);
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await removePath(dir, { recursive: true, force: true }).catch(() => {});
  }
});

describe("bunest dev ready signaling", () => {
  it("delays Ready URL until slow app actually binds, then immediate fetch succeeds", async () => {
    const workdir = await makeTempDir("bunest-dev-slow-");
    await writeTsconfig(workdir);
    await ensureDir(join(workdir, "src"));
    await Bun.write(
      join(workdir, "src/main.ts"),
      buildAppSource({ marker: "slow-boot-ok", delayMs: 250 }),
    );

    const cap = createLiveCapture(workdir);
    const startTime = Date.now();
    const runPromise = runDevServer(
      {
        cwd: workdir,
        entry: "src/main.ts",
        port: 0,
        typegen: false,
      },
      cap.io,
    );

    try {
      // Wait 120ms (less than the 250ms startup delay): startup info printed,
      // but NO Ready URL and NO premature http:// URL yet.
      await Bun.sleep(120);
      expect(cap.readyEvents).toHaveLength(0);
      const earlyOut = cap.stdout.join("\n");
      expect(earlyOut).toContain("Starting Bunest dev server:");
      expect(earlyOut).not.toContain("Listening URL");
      expect(earlyOut).not.toMatch(/https?:\/\//);

      const ready = await cap.waitForReady(1);
      expect(ready.boot).toBe(1);
      expect(ready.timestamp - startTime).toBeGreaterThanOrEqual(220);

      // Immediate fetch right after Ready line MUST succeed
      const res = await fetch(`${ready.url}/marker`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ marker: "slow-boot-ok" });
    } finally {
      await stopDevRun(runPromise);
    }
  }, 20_000);

  it("announces the actual bound URL when preferred port is occupied and with PORT=0", async () => {
    // 1. Occupied preferred port via Bun.env.PORT fallback
    const blocker = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => Response.json({ marker: "blocker-server" }),
    });
    const busyPort = blocker.port!;
    const prevPortEnv = Bun.env.PORT;
    Bun.env.PORT = String(busyPort);

    const workdirBusy = await makeTempDir("bunest-dev-busy-");
    await writeTsconfig(workdirBusy);
    await ensureDir(join(workdirBusy, "src"));
    await Bun.write(
      join(workdirBusy, "src/main.ts"),
      buildAppSource({ marker: "fallback-orders-app" }),
    );

    const capBusy = createLiveCapture(workdirBusy);
    const runBusy = runDevServer(
      {
        cwd: workdirBusy,
        entry: "src/main.ts",
        typegen: false,
      },
      capBusy.io,
    );

    try {
      const ready = await capBusy.waitForReady(1);
      const boundPort = Number(new URL(ready.url).port);
      expect(boundPort).toBeGreaterThan(0);
      expect(boundPort).not.toBe(busyPort);

      const res = await fetch(`${ready.url}/marker`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ marker: "fallback-orders-app" });
    } finally {
      await stopDevRun(runBusy);
      await blocker.stop(true);
      if (prevPortEnv === undefined) {
        delete Bun.env.PORT;
      } else {
        Bun.env.PORT = prevPortEnv;
      }
    }

    // 2. Explicit port: 0 (ephemeral OS-assigned port)
    const workdirZero = await makeTempDir("bunest-dev-zero-");
    await writeTsconfig(workdirZero);
    await ensureDir(join(workdirZero, "src"));
    await Bun.write(
      join(workdirZero, "src/main.ts"),
      buildAppSource({ marker: "ephemeral-port-app" }),
    );

    const capZero = createLiveCapture(workdirZero);
    const runZero = runDevServer(
      {
        cwd: workdirZero,
        entry: "src/main.ts",
        port: 0,
        typegen: false,
      },
      capZero.io,
    );

    try {
      const ready = await capZero.waitForReady(1);
      const boundPort = Number(new URL(ready.url).port);
      expect(boundPort).toBeGreaterThan(0);

      const res = await fetch(`${ready.url}/marker`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ marker: "ephemeral-port-app" });
    } finally {
      await stopDevRun(runZero);
    }
  }, 25_000);

  it("increments boot generation across consecutive reloads (v1 -> v2 -> v3) and never serves stale marker", async () => {
    const workdir = await makeTempDir("bunest-dev-reload-");
    await writeTsconfig(workdir);
    await ensureDir(join(workdir, "src"));
    const entryPath = join(workdir, "src/main.ts");
    await Bun.write(entryPath, buildAppSource({ marker: "v1" }));

    const cap = createLiveCapture(workdir);
    const runPromise = runDevServer(
      {
        cwd: workdir,
        entry: "src/main.ts",
        port: 0,
        typegen: false,
      },
      cap.io,
    );

    try {
      const boot1 = await cap.waitForReady(1);
      expect(boot1.boot).toBe(1);
      expect(await (await fetch(`${boot1.url}/marker`)).json()).toEqual({
        marker: "v1",
      });

      await Bun.write(entryPath, buildAppSource({ marker: "v2" }));
      const boot2 = await cap.waitForReady(2);
      expect(boot2.boot).toBe(2);
      expect(await (await fetch(`${boot2.url}/marker`)).json()).toEqual({
        marker: "v2",
      });

      await Bun.write(entryPath, buildAppSource({ marker: "v3" }));
      const boot3 = await cap.waitForReady(3);
      expect(boot3.boot).toBe(3);
      expect(await (await fetch(`${boot3.url}/marker`)).json()).toEqual({
        marker: "v3",
      });
    } finally {
      await stopDevRun(runPromise);
    }
  }, 25_000);

  it("emits no Ready line on syntax or DI bootstrap failure, then recovers once fixed", async () => {
    const workdir = await makeTempDir("bunest-dev-recover-");
    await writeTsconfig(workdir);
    await ensureDir(join(workdir, "src"));
    const entryPath = join(workdir, "src/main.ts");

    // 1. Start with a syntax error
    await Bun.write(
      entryPath,
      `export const broken = (((;\n`,
    );

    const cap = createLiveCapture(workdir);
    const runPromise = runDevServer(
      {
        cwd: workdir,
        entry: "src/main.ts",
        port: 0,
        typegen: false,
      },
      cap.io,
    );

    try {
      await Bun.sleep(600);
      expect(cap.readyEvents).toHaveLength(0);

      // 2. Replace with a DI bootstrap error (missing provider in module)
      await Bun.write(
        entryPath,
        `import { BunestFactory, Controller, Get, Injectable, Module } from "${CORE_ENTRY}";

@Injectable()
class MissingService {}

@Controller()
class BrokenController {
  constructor(private readonly missing: MissingService) {}
  @Get("/marker")
  getMarker() { return { marker: String(this.missing) }; }
}

@Module({ controllers: [BrokenController] })
class BrokenModule {}

async function bootstrap() {
  const app = await BunestFactory.create(BrokenModule, { logger: false });
  await app.listen(0, "127.0.0.1");
}
void bootstrap();
`,
      );
      await Bun.sleep(700);
      expect(cap.readyEvents).toHaveLength(0);

      // 3. Fix with valid app -> should emit Ready exactly once (boot #1)
      await Bun.write(entryPath, buildAppSource({ marker: "recovered-ok" }));
      const ready = await cap.waitForReady(1);
      expect(ready.boot).toBe(1);
      expect(cap.readyEvents).toHaveLength(1);

      const res = await fetch(`${ready.url}/marker`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ marker: "recovered-ok" });
    } finally {
      await stopDevRun(runPromise);
    }
  }, 25_000);

  it("respects --silent, never fakes Ready for custom entries, cleans up temp ready file, and frees the port", async () => {
    // Isolate TMPDIR so we can assert temp ready file creation and deletion cleanly
    const isolatedTmp = await makeTempDir("bunest-dev-tmp-");
    const prevTmpDir = Bun.env.TMPDIR;
    Bun.env.TMPDIR = isolatedTmp;

    try {
      // 1. --silent suppresses all startup/ready output while still cleaning up temp file & freeing port
      const probe = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch: () => new Response(),
      });
      const targetPort = probe.port!;
      await probe.stop(true);

      const silentDir = await makeTempDir("bunest-dev-silent-");
      await writeTsconfig(silentDir);
      await ensureDir(join(silentDir, "src"));
      await Bun.write(
        join(silentDir, "src/main.ts"),
        buildAppSource({ marker: "silent-ok" }),
      );

      const silentCap = createLiveCapture(silentDir);
      const silentRun = runDevServer(
        {
          cwd: silentDir,
          entry: "src/main.ts",
          port: targetPort,
          silent: true,
          typegen: false,
        },
        silentCap.io,
      );

      try {
        // Wait until the ready signal file appears and server responds
        const deadline = Date.now() + 10_000;
        let responded = false;
        while (Date.now() < deadline) {
          try {
            const res = await fetch(`http://127.0.0.1:${targetPort}/marker`);
            if (res.status === 200) {
              expect(await res.json()).toEqual({ marker: "silent-ok" });
              responded = true;
              break;
            }
          } catch {
            // Still starting
          }
          await Bun.sleep(40);
        }
        expect(responded).toBe(true);
        // Silent mode must suppress startup and Ready stdout lines
        expect(silentCap.stdout).toHaveLength(0);
      } finally {
        await stopDevRun(silentRun);
      }

      // Temp ready file must be deleted after exit
      const remainingFiles = (await readDirNames(isolatedTmp)).filter((f) =>
        f.startsWith("bunest-dev-ready-"),
      );
      expect(remainingFiles).toHaveLength(0);

      // Port must be immediately reusable after cleanup
      const rebound = Bun.serve({
        port: targetPort,
        hostname: "127.0.0.1",
        fetch: () => new Response("reused"),
      });
      expect(rebound.port).toBe(targetPort);
      await rebound.stop(true);

      // 2. Custom entry that does not call BunestApplication.listen() never prints a fake Ready URL
      const customDir = await makeTempDir("bunest-dev-custom-");
      await ensureDir(join(customDir, "src"));
      await Bun.write(
        join(customDir, "src/main.ts"),
        `const timer = setInterval(() => {}, 10_000);\n`,
      );

      const customCap = createLiveCapture(customDir);
      const customRun = runDevServer(
        {
          cwd: customDir,
          entry: "src/main.ts",
          port: 0,
          typegen: false,
        },
        customCap.io,
      );

      try {
        await Bun.sleep(450);
        expect(customCap.readyEvents).toHaveLength(0);
        const out = customCap.stdout.join("\n");
        expect(out).toContain("Starting Bunest dev server:");
        expect(out).not.toContain("Ready [boot");
        expect(out).not.toContain("Listening URL");
      } finally {
        await stopDevRun(customRun);
      }
    } finally {
      if (prevTmpDir === undefined) {
        delete Bun.env.TMPDIR;
      } else {
        Bun.env.TMPDIR = prevTmpDir;
      }
    }
  }, 25_000);
});
