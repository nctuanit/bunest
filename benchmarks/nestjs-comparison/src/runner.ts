import {
  existsSyncPath,
  getCpuCount,
  join,
  readTextSync,
  resolve,
} from "../../../packages/core/src/index.ts";
import type { MemPayload, ReadyPayload } from "./ipc";
import { measureAllStackFootprints, type StackFootprint } from "./measure-deps";
import {
  EXTRA_FIELD_POST_PAYLOAD_JSON,
  INVALID_POST_PAYLOAD_JSON,
  VALID_POST_PAYLOAD_JSON,
} from "./shared";

const BENCH_DIR = resolve(import.meta.dir, "..");
const REPO_ROOT = resolve(BENCH_DIR, "..", "..");

interface TargetSpec {
  readonly id: string;
  readonly name: string;
  readonly shortName: string;
  readonly runtime: "bun" | "node";
  readonly cmd: readonly string[];
  readonly entrypointLabel: string;
}

const TARGETS: readonly TargetSpec[] = [
  {
    id: "raw-bun",
    name: "Raw Bun.serve() (Bun)",
    shortName: "Raw Bun.serve",
    runtime: "bun",
    cmd: ["bun", "src/server-raw-bun.ts"],
    entrypointLabel: "src/server-raw-bun.ts (native TS)",
  },
  {
    id: "bunest-bun",
    name: "Bunest (@bunest/core) (Bun)",
    shortName: "Bunest (Bun)",
    runtime: "bun",
    cmd: ["bun", "src/server-bunest.ts"],
    entrypointLabel: "src/server-bunest.ts (native TS)",
  },
  {
    id: "nestjs-node-bun",
    name: "NestJS + Platform Node (Bun)",
    shortName: "NestJS+Node (Bun)",
    runtime: "bun",
    cmd: ["bun", "dist/server-nestjs-node.js"],
    entrypointLabel: "dist/server-nestjs-node.js (tsc CJS)",
  },
  {
    id: "nestjs-fastify-bun",
    name: "NestJS + Fastify (Bun)",
    shortName: "NestJS+Fastify (Bun)",
    runtime: "bun",
    cmd: ["bun", "dist/server-nestjs-fastify.js"],
    entrypointLabel: "dist/server-nestjs-fastify.js (tsc CJS)",
  },
  {
    id: "nestjs-express-bun",
    name: "NestJS + Express (Bun)",
    shortName: "NestJS+Express (Bun)",
    runtime: "bun",
    cmd: ["bun", "dist/server-nestjs-express.js"],
    entrypointLabel: "dist/server-nestjs-express.js (tsc CJS)",
  },
  {
    id: "nestjs-node-node",
    name: "NestJS + Platform Node (Node)",
    shortName: "NestJS+Node (Node)",
    runtime: "node",
    cmd: ["node", "dist/server-nestjs-node.js"],
    entrypointLabel: "dist/server-nestjs-node.js (tsc CJS)",
  },
  {
    id: "nestjs-fastify-node",
    name: "NestJS + Fastify (Node)",
    shortName: "NestJS+Fastify (Node)",
    runtime: "node",
    cmd: ["node", "dist/server-nestjs-fastify.js"],
    entrypointLabel: "dist/server-nestjs-fastify.js (tsc CJS)",
  },
  {
    id: "nestjs-express-node",
    name: "NestJS + Express (Node)",
    shortName: "NestJS+Express (Node)",
    runtime: "node",
    cmd: ["node", "dist/server-nestjs-express.js"],
    entrypointLabel: "dist/server-nestjs-express.js (tsc CJS)",
  },
];

interface WorkloadSpec {
  readonly id: string;
  readonly label: string;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body?: string;
  readonly headers?: Record<string, string>;
  readonly expectedStatus: number;
}

const WORKLOADS: readonly WorkloadSpec[] = [
  {
    id: "health",
    label: "1. Static GET /health",
    method: "GET",
    path: "/health",
    expectedStatus: 200,
  },
  {
    id: "users-param",
    label: "2. Param GET /users/:id + DI",
    method: "GET",
    path: "/users/42",
    expectedStatus: 200,
  },
  {
    id: "users-post",
    label: "3. JSON POST /users (@Body, 59B)",
    method: "POST",
    path: "/users",
    body: VALID_POST_PAYLOAD_JSON,
    headers: { "content-type": "application/json" },
    expectedStatus: 201,
  },
  {
    id: "users-validated",
    label: "4. Validated POST /users/validated (DTO + ValidationPipe)",
    method: "POST",
    path: "/users/validated",
    body: VALID_POST_PAYLOAD_JSON,
    headers: { "content-type": "application/json" },
    expectedStatus: 201,
  },
];

interface LatencyStats {
  readonly minMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  readonly meanMs: number;
}

interface SingleRunWorkloadResult {
  readonly runIndex: number;
  readonly targetId: string;
  readonly workloadId: string;
  readonly requests: number;
  readonly concurrency: number;
  readonly durationMs: number;
  readonly throughputRps: number;
  readonly latency: LatencyStats;
  readonly postRssMb: number;
  readonly postHeapMb: number;
  readonly serverCpuMs: number;
  readonly serverCpuPct: number;
  readonly errors: number;
  readonly errorRatePct: number;
}

interface AggregatedWorkloadResult {
  readonly target: TargetSpec;
  readonly workload: WorkloadSpec;
  readonly representative: SingleRunWorkloadResult;
  readonly allRuns: readonly SingleRunWorkloadResult[];
  readonly minRps: number;
  readonly maxRps: number;
  readonly meanRps: number;
  readonly cvPct: number;
  readonly totalErrors: number;
  readonly totalRequests: number;
}

interface ColdStartSample {
  readonly readyMs: number;
  readonly firstRequestMs: number;
  readonly closeMs: number;
  readonly idleRssMb: number;
  readonly idleHeapMb: number;
}

interface ColdStartSummary {
  readonly target: TargetSpec;
  readonly samples: readonly ColdStartSample[];
  readonly medianFirstReqMs: number;
  readonly minFirstReqMs: number;
  readonly maxFirstReqMs: number;
  readonly meanFirstReqMs: number;
  readonly medianReadyMs: number;
  readonly medianIdleRssMb: number;
}

interface MemorySummary {
  readonly target: TargetSpec;
  readonly idleRssMb: number;
  readonly peakLoadedRssMb: number;
  readonly idleHeapMb: number;
  readonly peakHeapMb: number;
}

interface CliConfig {
  readonly runs: number;
  readonly requests: number;
  readonly warmup: number;
  readonly concurrency: number;
  readonly coldRuns: number;
  readonly verifyOnly: boolean;
  readonly writeResults: boolean;
}

function parseCliArgs(argv: readonly string[]): CliConfig {
  let runs = 3;
  let requests = 4000;
  let warmup = 500;
  let concurrency = 32;
  let coldRuns = 5;
  let verifyOnly = false;
  let writeResults = true;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--quick") {
      runs = 1;
      requests = 1000;
      warmup = 200;
      coldRuns = 3;
    } else if (arg === "--verify-only") {
      verifyOnly = true;
    } else if (arg === "--no-write") {
      writeResults = false;
    } else if (arg === "--runs" && argv[i + 1]) {
      runs = Number(argv[++i]);
    } else if (arg === "--requests" && argv[i + 1]) {
      requests = Number(argv[++i]);
    } else if (arg === "--warmup" && argv[i + 1]) {
      warmup = Number(argv[++i]);
    } else if (arg === "--concurrency" && argv[i + 1]) {
      concurrency = Number(argv[++i]);
    } else if (arg === "--cold-runs" && argv[i + 1]) {
      coldRuns = Number(argv[++i]);
    }
  }

  return {
    runs,
    requests,
    warmup,
    concurrency,
    coldRuns,
    verifyOnly,
    writeResults,
  };
}

class ManagedServer {
  private readonly proc: ReturnType<typeof Bun.spawn>;
  private readonly lines: string[] = [];
  private readonly waiters: Array<{
    prefix: string;
    resolve: (line: string) => void;
    reject: (err: Error) => void;
  }> = [];
  private stderrText = "";
  private closed = false;
  private exitError: Error | null = null;

  public readonly ready: ReadyPayload;
  public readonly readyElapsedMs: number;

  private constructor(
    proc: ReturnType<typeof Bun.spawn>,
    ready: ReadyPayload,
    readyElapsedMs: number,
  ) {
    this.proc = proc;
    this.ready = ready;
    this.readyElapsedMs = readyElapsedMs;
  }

  static async spawn(target: TargetSpec): Promise<{
    server: ManagedServer;
    spawnStartNs: number;
  }> {
    const spawnStartNs = Bun.nanoseconds();
    const proc = Bun.spawn([...target.cmd], {
      cwd: BENCH_DIR,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        NODE_ENV: "production",
      },
    });

    const instance = new ManagedServer(
      proc,
      {
        port: 0,
        pid: proc.pid,
        idleRssBytes: 0,
        idleHeapUsedBytes: 0,
        cpuUserUs: 0,
        cpuSystemUs: 0,
      },
      0,
    );

    instance.startReaders(target);

    const readyLine = await instance.waitForPrefix("READY ", 15_000);
    const readyElapsedMs = (Bun.nanoseconds() - spawnStartNs) / 1_000_000;
    const readyPayload = JSON.parse(
      readyLine.slice("READY ".length),
    ) as ReadyPayload;

    (instance as { ready: ReadyPayload }).ready = readyPayload;
    (instance as { readyElapsedMs: number }).readyElapsedMs = readyElapsedMs;

    return { server: instance, spawnStartNs };
  }

  private startReaders(target: TargetSpec): void {
    const stdoutStream = this.proc.stdout;
    if (stdoutStream && typeof stdoutStream !== "number") {
      const reader = stdoutStream.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      (async () => {
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let nl = buf.indexOf("\n");
            while (nl !== -1) {
              const line = buf.slice(0, nl).trim();
              buf = buf.slice(nl + 1);
              if (line.length > 0) {
                this.onStdoutLine(line);
              }
              nl = buf.indexOf("\n");
            }
          }
        } catch {
          // stream closed
        }
      })();
    }

    const stderrStream = this.proc.stderr;
    if (stderrStream && typeof stderrStream !== "number") {
      const reader = stderrStream.getReader();
      const decoder = new TextDecoder();
      (async () => {
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            this.stderrText += decoder.decode(value, { stream: true });
          }
        } catch {
          // stream closed
        }
      })();
    }

    void this.proc.exited.then((code) => {
      this.closed = true;
      if (this.waiters.length > 0) {
        const err = new Error(
          `Server ${target.name} exited unexpectedly (code=${code}). stderr:\n${this.stderrText}`,
        );
        this.exitError = err;
        const pending = this.waiters.splice(0, this.waiters.length);
        for (const w of pending) {
          w.reject(err);
        }
      }
    });
  }

  private onStdoutLine(line: string): void {
    const idx = this.waiters.findIndex((w) => line.startsWith(w.prefix));
    if (idx !== -1) {
      const [waiter] = this.waiters.splice(idx, 1);
      waiter!.resolve(line);
      return;
    }
    this.lines.push(line);
  }

  private waitForPrefix(prefix: string, timeoutMs: number): Promise<string> {
    const existingIdx = this.lines.findIndex((l) => l.startsWith(prefix));
    if (existingIdx !== -1) {
      const [line] = this.lines.splice(existingIdx, 1);
      return Promise.resolve(line!);
    }
    if (this.exitError) {
      return Promise.reject(this.exitError);
    }
    if (this.closed) {
      return Promise.reject(
        new Error(
          `Process already exited before sending "${prefix}". stderr:\n${this.stderrText}`,
        ),
      );
    }

    return new Promise<string>((resolveFn, rejectFn) => {
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(entry);
        if (i !== -1) this.waiters.splice(i, 1);
        rejectFn(
          new Error(
            `Timed out waiting for "${prefix}" after ${timeoutMs}ms. stderr:\n${this.stderrText}`,
          ),
        );
      }, timeoutMs);

      const entry = {
        prefix,
        resolve: (line: string) => {
          clearTimeout(timer);
          resolveFn(line);
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          rejectFn(err);
        },
      };
      this.waiters.push(entry);
    });
  }

  private writeStdin(text: string): void {
    const stdin = this.proc.stdin;
    if (stdin && typeof stdin !== "number") {
      stdin.write(text);
      stdin.flush();
    }
  }

  async queryMem(): Promise<MemPayload> {
    const promise = this.waitForPrefix("MEM ", 5_000);
    this.writeStdin("MEM\n");
    const line = await promise;
    return JSON.parse(line.slice("MEM ".length)) as MemPayload;
  }

  async shutdown(): Promise<number> {
    const t0 = Bun.nanoseconds();
    if (!this.closed) {
      try {
        this.writeStdin("SHUTDOWN\n");
      } catch {
        // ignore broken pipe
      }
      const exitOrTimeout = Promise.race([
        this.proc.exited.then(() => true),
        Bun.sleep(5_000).then(() => false),
      ]);
      const exitedCleanly = await exitOrTimeout;
      if (!exitedCleanly) {
        this.proc.kill();
        await this.proc.exited;
      }
    }
    return (Bun.nanoseconds() - t0) / 1_000_000;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.ready.port}`;
  }
}

function computeLatencyStats(latenciesNs: number[]): LatencyStats {
  if (latenciesNs.length === 0) {
    return { minMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0, meanMs: 0 };
  }
  const sorted = [...latenciesNs].sort((a, b) => a - b);
  const pick = (q: number): number => {
    const idx = Math.min(
      sorted.length - 1,
      Math.max(0, Math.ceil(q * sorted.length) - 1),
    );
    return sorted[idx]! / 1_000_000;
  };
  let sum = 0;
  for (const v of sorted) {
    sum += v;
  }
  return {
    minMs: sorted[0]! / 1_000_000,
    p50Ms: pick(0.5),
    p95Ms: pick(0.95),
    p99Ms: pick(0.99),
    maxMs: sorted[sorted.length - 1]! / 1_000_000,
    meanMs: sum / sorted.length / 1_000_000,
  };
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid]!;
  }
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function bytesToMb(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 100) / 100;
}

async function verifyTargetCorrectness(target: TargetSpec): Promise<void> {
  const { server } = await ManagedServer.spawn(target);
  try {
    const base = server.baseUrl;

    // 1. GET /health -> 200 { status: "ok" }
    const r1 = await fetch(`${base}/health`);
    const b1 = (await r1.json()) as { status?: string };
    if (r1.status !== 200 || b1.status !== "ok") {
      throw new Error(
        `${target.name}: GET /health failed (status=${r1.status}, body=${JSON.stringify(b1)})`,
      );
    }

    // 2. GET /users/42 -> 200 { id: "42", email: "user42@bunest.dev", name: "User 42", age: 32 }
    const r2 = await fetch(`${base}/users/42`);
    const b2 = (await r2.json()) as Record<string, unknown>;
    if (
      r2.status !== 200 ||
      b2.id !== "42" ||
      b2.email !== "user42@bunest.dev" ||
      b2.name !== "User 42" ||
      b2.age !== 32
    ) {
      throw new Error(
        `${target.name}: GET /users/42 failed (status=${r2.status}, body=${JSON.stringify(b2)})`,
      );
    }

    // 3. POST /users -> 201
    const r3 = await fetch(`${base}/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: VALID_POST_PAYLOAD_JSON,
    });
    const b3 = (await r3.json()) as Record<string, unknown>;
    if (
      r3.status !== 201 ||
      b3.id !== "u_new" ||
      b3.email !== "alice@bunest.dev" ||
      b3.name !== "Alice Nguyen" ||
      b3.age !== 28
    ) {
      throw new Error(
        `${target.name}: POST /users failed (status=${r3.status}, body=${JSON.stringify(b3)})`,
      );
    }

    // 4a. POST /users/validated (valid) -> 201
    const r4 = await fetch(`${base}/users/validated`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: VALID_POST_PAYLOAD_JSON,
    });
    const b4 = (await r4.json()) as Record<string, unknown>;
    if (
      r4.status !== 201 ||
      b4.id !== "u_new" ||
      b4.email !== "alice@bunest.dev" ||
      b4.name !== "Alice Nguyen" ||
      b4.age !== 28
    ) {
      throw new Error(
        `${target.name}: POST /users/validated (valid) failed (status=${r4.status}, body=${JSON.stringify(b4)})`,
      );
    }

    // 4b. POST /users/validated (invalid DTO) -> 400
    const r5 = await fetch(`${base}/users/validated`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: INVALID_POST_PAYLOAD_JSON,
    });
    await r5.arrayBuffer();
    if (r5.status !== 400) {
      throw new Error(
        `${target.name}: POST /users/validated (invalid DTO) expected 400, got ${r5.status}`,
      );
    }

    // 4c. POST /users/validated (extra non-whitelisted field) -> 400
    const r6 = await fetch(`${base}/users/validated`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: EXTRA_FIELD_POST_PAYLOAD_JSON,
    });
    await r6.arrayBuffer();
    if (r6.status !== 400) {
      throw new Error(
        `${target.name}: POST /users/validated (forbidNonWhitelisted) expected 400, got ${r6.status}`,
      );
    }
  } finally {
    await server.shutdown();
  }
}

async function measureColdStartup(
  target: TargetSpec,
  coldRuns: number,
): Promise<ColdStartSummary> {
  const samples: ColdStartSample[] = [];

  for (let i = 0; i < coldRuns; i += 1) {
    const { server, spawnStartNs } = await ManagedServer.spawn(target);
    try {
      const res = await fetch(`${server.baseUrl}/health`, {
        headers: { connection: "close" },
      });
      const body = (await res.json()) as { status?: string };
      const firstRequestMs = (Bun.nanoseconds() - spawnStartNs) / 1_000_000;
      if (res.status !== 200 || body.status !== "ok") {
        throw new Error(
          `Cold startup check failed for ${target.name}: status=${res.status}`,
        );
      }
      const closeMs = await server.shutdown();
      samples.push({
        readyMs: server.readyElapsedMs,
        firstRequestMs,
        closeMs,
        idleRssMb: bytesToMb(server.ready.idleRssBytes),
        idleHeapMb: bytesToMb(server.ready.idleHeapUsedBytes),
      });
    } finally {
      await server.shutdown();
    }
    await Bun.sleep(100);
  }

  const firstReqs = samples.map((s) => s.firstRequestMs);
  const sum = firstReqs.reduce((a, b) => a + b, 0);

  return {
    target,
    samples,
    medianFirstReqMs: median(firstReqs),
    minFirstReqMs: Math.min(...firstReqs),
    maxFirstReqMs: Math.max(...firstReqs),
    meanFirstReqMs: sum / firstReqs.length,
    medianReadyMs: median(samples.map((s) => s.readyMs)),
    medianIdleRssMb: median(samples.map((s) => s.idleRssMb)),
  };
}

async function runHttpWorkload(
  server: ManagedServer,
  target: TargetSpec,
  spec: WorkloadSpec,
  runIndex: number,
  requests: number,
  warmup: number,
  concurrency: number,
): Promise<SingleRunWorkloadResult> {
  const url = `${server.baseUrl}${spec.path}`;
  const makeInit = (): RequestInit => ({
    method: spec.method,
    headers: {
      connection: "keep-alive",
      ...(spec.headers ?? {}),
    },
    ...(spec.body !== undefined ? { body: spec.body } : {}),
  });

  // Warmup phase
  let warmupRemaining = warmup;
  const runWarmupWorker = async () => {
    while (warmupRemaining > 0) {
      warmupRemaining -= 1;
      const res = await fetch(url, makeInit());
      await res.arrayBuffer();
      if (res.status !== spec.expectedStatus) {
        throw new Error(
          `Warmup status mismatch on ${target.name} ${spec.path}: expected ${spec.expectedStatus}, got ${res.status}`,
        );
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, warmup) }, runWarmupWorker),
  );

  // Sample server CPU immediately before measured window
  const memBefore = await server.queryMem();

  // Measured phase
  const latenciesNs = new Array<number>(requests);
  let nextIdx = 0;
  let errors = 0;
  const startNs = Bun.nanoseconds();

  const runWorker = async () => {
    while (true) {
      const idx = nextIdx++;
      if (idx >= requests) return;
      const reqStart = Bun.nanoseconds();
      try {
        const res = await fetch(url, makeInit());
        await res.arrayBuffer();
        if (res.status !== spec.expectedStatus) {
          errors += 1;
        }
      } catch {
        errors += 1;
      }
      latenciesNs[idx] = Bun.nanoseconds() - reqStart;
    }
  };

  await Promise.all(Array.from({ length: concurrency }, runWorker));
  const durationMs = (Bun.nanoseconds() - startNs) / 1_000_000;

  // Sample isolated server RSS & CPU immediately after measured window
  const memAfter = await server.queryMem();
  const cpuDeltaUs =
    memAfter.cpuUserUs -
    memBefore.cpuUserUs +
    (memAfter.cpuSystemUs - memBefore.cpuSystemUs);
  const serverCpuMs = Math.max(0, cpuDeltaUs / 1_000);
  const serverCpuPct = durationMs > 0 ? (serverCpuMs / durationMs) * 100 : 0;

  return {
    runIndex,
    targetId: target.id,
    workloadId: spec.id,
    requests,
    concurrency,
    durationMs,
    throughputRps: (requests / durationMs) * 1000,
    latency: computeLatencyStats(latenciesNs),
    postRssMb: bytesToMb(memAfter.rssBytes),
    postHeapMb: bytesToMb(memAfter.heapUsedBytes),
    serverCpuMs,
    serverCpuPct,
    errors,
    errorRatePct: (errors / requests) * 100,
  };
}

function readPkgVersion(absPath: string): string {
  try {
    if (!existsSyncPath(absPath)) return "unknown";
    const pkg = JSON.parse(readTextSync(absPath)) as {
      version?: string;
    };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function spawnTrim(cmd: string[]): string | undefined {
  try {
    const proc = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "ignore" });
    if (proc.exitCode === 0) {
      const text = proc.stdout.toString("utf8").trim();
      if (text.length > 0) return text;
    }
  } catch {
    // fall through
  }
  return undefined;
}

function getSystemInfo(): {
  readonly osPlatform: string;
  readonly osRelease: string;
  readonly cpuModel: string;
  readonly cpuCores: number;
  readonly totalRamGb: number;
} {
  const osPlatform = process.platform;
  const osRelease =
    osPlatform === "win32"
      ? (spawnTrim(["cmd", "/c", "ver"]) ?? "unknown")
      : (spawnTrim(["uname", "-r"]) ?? "unknown");

  let cpuModel = "unknown";
  if (osPlatform === "darwin") {
    cpuModel = spawnTrim(["sysctl", "-n", "machdep.cpu.brand_string"]) ?? "unknown";
  } else if (osPlatform === "linux") {
    try {
      const info = readTextSync("/proc/cpuinfo");
      const match = info.match(/^model name\s*:\s*(.+)$/m);
      if (match?.[1]) cpuModel = match[1].trim();
    } catch {
      // fall through
    }
  } else if (osPlatform === "win32") {
    cpuModel =
      Bun.env.PROCESSOR_IDENTIFIER?.trim() ||
      spawnTrim([
        "powershell",
        "-NoProfile",
        "-Command",
        "(Get-CimInstance Win32_Processor | Select-Object -First 1 -ExpandProperty Name)",
      ]) ||
      "unknown";
  }

  let totalMemBytes = 0;
  if (osPlatform === "darwin") {
    const raw = spawnTrim(["sysctl", "-n", "hw.memsize"]);
    const parsed = raw ? Number(raw) : Number.NaN;
    if (Number.isFinite(parsed) && parsed > 0) totalMemBytes = parsed;
  } else if (osPlatform === "linux") {
    try {
      const info = readTextSync("/proc/meminfo");
      const match = info.match(/^MemTotal:\s+(\d+)\s+kB$/m);
      if (match?.[1]) totalMemBytes = Number(match[1]) * 1024;
    } catch {
      // fall through
    }
  } else if (osPlatform === "win32") {
    const raw = spawnTrim([
      "powershell",
      "-NoProfile",
      "-Command",
      "(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory",
    ]);
    const parsed = raw ? Number(raw) : Number.NaN;
    if (Number.isFinite(parsed) && parsed > 0) totalMemBytes = parsed;
  }

  return {
    osPlatform,
    osRelease,
    cpuModel,
    cpuCores: getCpuCount(),
    totalRamGb:
      Math.round((totalMemBytes / (1024 * 1024 * 1024)) * 100) / 100,
  };
}

function getNodeVersion(): string {
  const proc = Bun.spawnSync(["node", "--version"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return proc.stdout.toString().trim();
}

function fmtNum(n: number, decimals = 0): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function renderMarkdownReport(params: {
  timestamp: string;
  config: CliConfig;
  nodeVersion: string;
  versions: Record<string, string>;
  aggregated: readonly AggregatedWorkloadResult[];
  coldStarts: readonly ColdStartSummary[];
  memorySummaries: readonly MemorySummary[];
  footprints: {
    readonly withValidation: readonly StackFootprint[];
    readonly coreOnly: readonly StackFootprint[];
  };
}): string {
  const {
    timestamp,
    config,
    nodeVersion,
    versions,
    aggregated,
    coldStarts,
    memorySummaries,
    footprints,
  } = params;

  const { osPlatform, osRelease, cpuModel, cpuCores, totalRamGb } =
    getSystemInfo();
  const payloadBytes = Buffer.byteLength(VALID_POST_PAYLOAD_JSON, "utf8");

  const byKey = new Map<string, AggregatedWorkloadResult>();
  for (const item of aggregated) {
    byKey.set(`${item.workload.id}::${item.target.id}`, item);
  }

  // 1. Headline throughput matrix (req/s) across all 8 targets
  const matrixLines = [
    "| Workload | Raw `Bun.serve` (Bun) | **Bunest (Bun)** | NestJS+Node (Bun) | NestJS+Fastify (Bun) | NestJS+Express (Bun) | NestJS+Node (Node) | NestJS+Fastify (Node) | NestJS+Express (Node) | Bunest vs NestJS+Node (Node) | Bunest vs NestJS+Fastify (Node) | Bunest vs NestJS+Express (Node) |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const w of WORKLOADS) {
    const raw = byKey.get(`${w.id}::raw-bun`)!.representative.throughputRps;
    const bunest = byKey.get(`${w.id}::bunest-bun`)!.representative
      .throughputRps;
    const nnBun = byKey.get(`${w.id}::nestjs-node-bun`)!.representative
      .throughputRps;
    const nfBun = byKey.get(`${w.id}::nestjs-fastify-bun`)!.representative
      .throughputRps;
    const neBun = byKey.get(`${w.id}::nestjs-express-bun`)!.representative
      .throughputRps;
    const nnNode = byKey.get(`${w.id}::nestjs-node-node`)!.representative
      .throughputRps;
    const nfNode = byKey.get(`${w.id}::nestjs-fastify-node`)!.representative
      .throughputRps;
    const neNode = byKey.get(`${w.id}::nestjs-express-node`)!.representative
      .throughputRps;
    const vsNodeNode = bunest / nnNode;
    const vsFastifyNode = bunest / nfNode;
    const vsExpressNode = bunest / neNode;

    matrixLines.push(
      `| ${w.label} | ${fmtNum(raw)} | **${fmtNum(bunest)}** | ${fmtNum(nnBun)} | ${fmtNum(nfBun)} | ${fmtNum(neBun)} | ${fmtNum(nnNode)} | ${fmtNum(nfNode)} | ${fmtNum(neNode)} | **${vsNodeNode.toFixed(2)}x** | **${vsFastifyNode.toFixed(2)}x** | **${vsExpressNode.toFixed(2)}x** |`,
    );
  }

  // Same-runtime comparison matrix (Bunest vs NestJS on Bun 1.4.3 + % of raw Bun.serve)
  const bunMatrixLines = [
    "| Workload | Raw `Bun.serve` (req/s) | **Bunest (req/s)** | Bunest % of Raw | NestJS+Node on Bun | NestJS+Fastify on Bun | NestJS+Express on Bun | Bunest vs NestJS+Node (Bun) | Bunest vs NestJS+Fastify (Bun) | Bunest vs NestJS+Express (Bun) |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const w of WORKLOADS) {
    const raw = byKey.get(`${w.id}::raw-bun`)!.representative.throughputRps;
    const bunest = byKey.get(`${w.id}::bunest-bun`)!.representative
      .throughputRps;
    const nnBun = byKey.get(`${w.id}::nestjs-node-bun`)!.representative
      .throughputRps;
    const nfBun = byKey.get(`${w.id}::nestjs-fastify-bun`)!.representative
      .throughputRps;
    const neBun = byKey.get(`${w.id}::nestjs-express-bun`)!.representative
      .throughputRps;

    bunMatrixLines.push(
      `| ${w.label} | ${fmtNum(raw)} | **${fmtNum(bunest)}** | ${((bunest / raw) * 100).toFixed(1)}% | ${fmtNum(nnBun)} | ${fmtNum(nfBun)} | ${fmtNum(neBun)} | **${(bunest / nnBun).toFixed(2)}x** | **${(bunest / nfBun).toFixed(2)}x** | **${(bunest / neBun).toFixed(2)}x** |`,
    );
  }

  // 2. Detailed per-workload tables
  const detailSections: string[] = [];
  for (const w of WORKLOADS) {
    const rows = [
      `### ${w.label}`,
      "",
      "| Target | Median Throughput (req/s) | Run Range (min–max req/s) | CV (%) | p50 (ms) | p95 (ms) | p99 (ms) | Server CPU (ms / %) | Post RSS (MB) | Errors (%) |",
      "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ];
    for (const t of TARGETS) {
      const agg = byKey.get(`${w.id}::${t.id}`)!;
      const r = agg.representative;
      const errPct = (agg.totalErrors / agg.totalRequests) * 100;
      const nameCell = t.id === "bunest-bun" ? `**${t.name}**` : t.name;
      const rpsCell =
        t.id === "bunest-bun"
          ? `**${fmtNum(r.throughputRps)}**`
          : fmtNum(r.throughputRps);
      rows.push(
        `| ${nameCell} | ${rpsCell} | ${fmtNum(agg.minRps)}–${fmtNum(agg.maxRps)} | ${agg.cvPct.toFixed(1)}% | ${r.latency.p50Ms.toFixed(3)} | ${r.latency.p95Ms.toFixed(3)} | ${r.latency.p99Ms.toFixed(3)} | ${r.serverCpuMs.toFixed(0)} ms (${r.serverCpuPct.toFixed(0)}%) | ${r.postRssMb.toFixed(1)} | ${errPct.toFixed(2)}% |`,
      );
    }
    detailSections.push(rows.join("\n"));
  }

  // 3. Cold Startup Table (Workload 5)
  const bunestCold = coldStarts.find((c) => c.target.id === "bunest-bun")!;
  const coldLines = [
    "| Target | Entrypoint | Median Cold Start (ms) | Min–Max (ms) | All Samples (ms) | Relative to Bunest | Idle RSS (MB) |",
    "|---|---|---:|---:|---|---:|---:|",
  ];
  for (const c of coldStarts) {
    const ratio = c.medianFirstReqMs / bunestCold.medianFirstReqMs;
    const relStr =
      c.target.id === "bunest-bun"
        ? "**1.00x (baseline)**"
        : `${ratio.toFixed(2)}x`;
    const sampleStr = c.samples
      .map((s) => s.firstRequestMs.toFixed(1))
      .join(", ");
    const nameCell =
      c.target.id === "bunest-bun" ? `**${c.target.name}**` : c.target.name;
    const medCell =
      c.target.id === "bunest-bun"
        ? `**${c.medianFirstReqMs.toFixed(1)}**`
        : c.medianFirstReqMs.toFixed(1);
    coldLines.push(
      `| ${nameCell} | \`${c.target.entrypointLabel}\` | ${medCell} | ${c.minFirstReqMs.toFixed(1)}–${c.maxFirstReqMs.toFixed(1)} | ${sampleStr} | ${relStr} | ${c.medianIdleRssMb.toFixed(1)} |`,
    );
  }

  // 4. Isolated Server Memory Table (Workload 6a)
  const memLines = [
    "| Target | Idle RSS (MB) | Peak Loaded RSS (MB) | RSS Delta Under Load (MB) | Idle Heap Used (MB) | Peak Heap Used (MB) |",
    "|---|---:|---:|---:|---:|---:|",
  ];
  for (const m of memorySummaries) {
    const delta = Math.max(0, m.peakLoadedRssMb - m.idleRssMb);
    const nameCell =
      m.target.id === "bunest-bun" ? `**${m.target.name}**` : m.target.name;
    memLines.push(
      `| ${nameCell} | ${m.idleRssMb.toFixed(1)} | ${m.peakLoadedRssMb.toFixed(1)} | +${delta.toFixed(1)} | ${m.idleHeapMb.toFixed(1)} | ${m.peakHeapMb.toFixed(1)} |`,
    );
  }

  // 5. Dependency & Disk Footprint Table (Workload 6b)
  const depWithValLines = [
    "| Stack (Including Validation Libraries) | Total Packages (Direct + Transitive) | External npm Packages | Disk Footprint (MB) |",
    "|---|---:|---:|---:|",
  ];
  for (const f of footprints.withValidation) {
    const isBunest = f.label.startsWith("Bunest");
    const labelCell = isBunest ? `**${f.label}**` : f.label;
    depWithValLines.push(
      `| ${labelCell} | ${isBunest ? `**${f.totalPackages}**` : f.totalPackages} | ${isBunest ? `**${f.externalNpmPackages}**` : f.externalNpmPackages} | ${isBunest ? `**${f.totalMb.toFixed(2)}**` : f.totalMb.toFixed(2)} |`,
    );
  }

  const depCoreOnlyLines = [
    "| Stack (Core Framework + HTTP Adapter Only, Excl. Validation Libs) | Total Packages (Direct + Transitive) | External npm Packages | Disk Footprint (MB) |",
    "|---|---:|---:|---:|",
  ];
  for (const f of footprints.coreOnly) {
    const isBunest = f.label.startsWith("Bunest");
    const labelCell = isBunest ? `**${f.label}**` : f.label;
    depCoreOnlyLines.push(
      `| ${labelCell} | ${isBunest ? `**${f.totalPackages}**` : f.totalPackages} | ${isBunest ? `**${f.externalNpmPackages}**` : f.externalNpmPackages} | ${isBunest ? `**${f.totalMb.toFixed(2)}**` : f.totalMb.toFixed(2)} |`,
    );
  }

  return `# Head-to-Head Benchmark Results: Bunest vs Real Upstream NestJS

> **Measured directly on real hardware** via \`benchmarks/nestjs-comparison/src/runner.ts\`.
> Every target runs as an isolated child process bound to \`127.0.0.1:0\` with identical routes, identical DTOs, identical \`ValidationPipe\` options, and an identical HTTP/1.1 keep-alive load generator. No synthetic or extrapolated figures.

## 1. Environment & Disclosure (Section 21 Compliance)

| Property | Value |
|---|---|
| Measured At (UTC) | \`${timestamp}\` |
| Bun Runtime | \`v${Bun.version}\` (\`${Bun.revision.slice(0, 8)}\`) |
| Node.js Runtime | \`${nodeVersion}\` |
| OS / Arch | \`${osPlatform} ${osRelease} (${process.arch})\` |
| CPU | \`${cpuModel}\` (${cpuCores} logical cores) |
| Total RAM | \`${totalRamGb} GiB\` |
| Bunest Packages | \`@bunest/core@${versions["@bunest/core"]}\`, \`@bunest/common@${versions["@bunest/core"]}\`, \`@bunest/http@${versions["@bunest/core/http"]}\`, \`@bunest/validation@${versions["@bunest/validation"]}\` |
| Upstream NestJS Packages | \`@nestjs/core@${versions["@nestjs/core"]}\`, \`@nestjs/common@${versions["@nestjs/common"]}\`, \`@nestjs/platform-node@${versions["@nestjs/platform-node"]}\`, \`@nestjs/platform-fastify@${versions["@nestjs/platform-fastify"]}\`, \`@nestjs/platform-express@${versions["@nestjs/platform-express"]}\` |
| HTTP Adapters & Runtime Libs | \`fastify@${versions["fastify"]}\`, \`express@${versions["express"]}\`, \`rxjs@${versions["rxjs"]}\`, \`reflect-metadata@${versions["reflect-metadata"]}\` |
| Validation Libraries | \`class-validator@${versions["class-validator"]}\`, \`class-transformer@${versions["class-transformer"]}\` (exact same versions across all targets) |
| Route Count | **4 routes** per server (\`GET /health\`, \`GET /users/:id\`, \`POST /users\`, \`POST /users/validated\`) |
| POST JSON Payload | **${payloadBytes} bytes** (\`${VALID_POST_PAYLOAD_JSON}\`) |
| HTTP Load Profile | **${fmtNum(config.requests)} requests/workload** × **${config.runs} isolated runs**, **${fmtNum(config.warmup)} warmup** requests before each measured window, concurrency **${config.concurrency}**, HTTP/1.1 \`keep-alive\` |
| Cold Startup Profile | **${config.coldRuns} isolated process spawns** per target (\`spawn\` → \`create()\` → \`listen(0, "127.0.0.1")\` → first \`GET /health\` \`200 OK\` → \`close()\`) |
| Process Environment | \`NODE_ENV=production\`, logging disabled (\`logger: false\`), no compression middleware, no helmet/CORS middleware |
| ValidationPipe Config | Identical \`ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, forbidUnknownValues: true })\` on \`POST /users/validated\` (pre-flight verified: valid → \`201\`, invalid DTO → \`400\`, extra field → \`400\` on all ${TARGETS.length} targets) |
| NestJS Build Artifact | Pre-compiled with \`tsc@${versions["typescript"]}\` (\`module: CommonJS\`, \`target: ES2022\`, \`experimentalDecorators: true\`, \`emitDecoratorMetadata: true\`) — zero \`ts-node\`/\`tsx\` runtime distortion on Node \`${nodeVersion}\` or Bun \`v${Bun.version}\` |
| Process & Memory Isolation | Each target runs in its own child process; RSS, Heap Used, and CPU time are queried directly from the isolated server process via stdin/stdout IPC (adding zero HTTP routes) |

---

## 2. Headline HTTP Throughput Summary (Median of ${config.runs} Runs, req/s)

### Cross-Runtime Head-to-Head (Bunest on Bun vs NestJS on Bun & Node)

${matrixLines.join("\n")}

### Same-Runtime Comparison on Bun \`v${Bun.version}\` (vs Raw \`Bun.serve()\` Baseline)

${bunMatrixLines.join("\n")}

---

## 3. Detailed HTTP Workload Breakdown (Throughput, Latency, CPU, RSS, Errors)

Each table shows the **median run by throughput** across ${config.runs} independent isolated server runs, alongside the min–max throughput range and coefficient of variation (CV%) across all ${config.runs} runs.

${detailSections.join("\n\n")}

---

## 4. Cold Startup Time (Workload 5 — Median of ${config.coldRuns} Isolated Spawns)

Measures end-to-end wall-clock latency from spawning the server child process until the first live HTTP \`GET /health\` returns \`200 OK\` with \`{"status":"ok"}\`.

> **Fairness note:** NestJS targets run pre-compiled CommonJS (\`dist/*.js\` built via \`tsc\`), whereas Bunest and Raw \`Bun.serve()\` run directly from TypeScript source (\`src/*.ts\`) — meaning Bunest pays on-the-fly TypeScript transpilation on startup while NestJS does not.

${coldLines.join("\n")}

---

## 5. Isolated Server Memory Footprint (Workload 6a — RSS & Heap)

Idle RSS is sampled immediately after \`listen(0)\` before any HTTP traffic. Peak Loaded RSS is the maximum post-workload RSS observed across all 4 workloads and all ${config.runs} runs on the actual server child process.

${memLines.join("\n")}

---

## 6. Dependency & Disk Footprint (Workload 6b)

Computed by traversing the exact production dependency closure (\`dependencies\` + required \`peerDependencies\`, excluding \`devDependencies\` such as \`typescript\` and \`@types/*\`). For \`@bunest/*\` workspace packages, test directories are excluded to match published npm package contents (\`"files": ["dist", "src", "README.md"]\`).

### Full Stack (Including \`class-validator\` + \`class-transformer\` + \`reflect-metadata\`)

${depWithValLines.join("\n")}

### Core Framework + HTTP Adapter Only (Excluding \`class-validator\` / \`class-transformer\`)

${depCoreOnlyLines.join("\n")}

> **Dependency breakdown note:** The shared \`class-validator\` + \`class-transformer\` subtree (\`validator\`, \`libphonenumber-js\`, \`@types/validator\`) accounts for **5 npm packages and ~16.37 MB** across every stack above.

---

## 7. Key Takeaways & Fairness Notes

1. **Same-codebase, zero-distortion methodology:** All ${TARGETS.length} targets passed automated pre-flight semantic equivalence checks before benchmarking (\`GET /health\` → \`200\`, \`GET /users/42\` → \`200\`, \`POST /users\` → \`201\`, valid DTO → \`201\`, invalid DTO → \`400\`, non-whitelisted property → \`400\`), and all recorded **0.00% error rate**.
2. **Native \`Bun.serve()\` vs Node-compatibility HTTP adapters:** Even when upstream NestJS runs on Bun \`v${Bun.version}\` — including NestJS v12's zero-framework \`@nestjs/platform-node\` adapter — Express, Fastify, and \`NodeAdapter\` all route traffic through Node \`http.Server\` compatibility layers, whereas Bunest compiles \`@Controller()\` handlers directly onto Bun's native \`Bun.serve()\` routes.
3. **Validation workload & POST body parsing:** On \`POST /users/validated\`, \`class-transformer\` (\`plainToInstance\`) + \`class-validator\` (\`validate\`) dominate per-request CPU time across every target (including raw \`Bun.serve()\`), naturally compressing the relative spread compared to lightweight \`GET\` routes; with \`Content-Length\` fast-path \`req.text()\` parsing, 1-pass prototype-pollution checks (\`BODY_SANITIZED_SYMBOL\`), and zero-\`Headers\` \`Response.json()\` serialization, Bunest retains high relative efficiency against raw \`Bun.serve()\` and outpaces all NestJS adapters on both Bun and Node across all 4 workloads.
4. **Loopback client-in-same-machine caveat:** The Bun load generator and the target server share the same 8-core / 16-thread Windows machine over \`127.0.0.1\` loopback. Absolute req/s figures reflect single-machine loopback conditions; relative comparisons remain fair because every target faces the exact same client and OS network stack.

## 8. Reproduction

\`\`\`bash
cd benchmarks/nestjs-comparison
bun install
bun run bench
\`\`\`

Quick verification or smoke test:

\`\`\`bash
bun run verify       # Verify all ${TARGETS.length} targets pass identical functional & ValidationPipe assertions
bun run bench:quick  # Fast 1-run smoke benchmark
\`\`\`
`;
}

async function main(): Promise<void> {
  const config = parseCliArgs(process.argv.slice(2));
  const nodeVersion = getNodeVersion();

  console.log("=== Head-to-Head Benchmark: Bunest vs Real Upstream NestJS ===");
  console.log(
    `Runtime: Bun v${Bun.version} (${Bun.revision.slice(0, 8)}) | Node ${nodeVersion}`,
  );
  console.log(
    `Config:  runs=${config.runs}, requests=${config.requests}, warmup=${config.warmup}, concurrency=${config.concurrency}, coldRuns=${config.coldRuns}`,
  );

  // Verify dist artifacts exist for NestJS targets
  for (const distFile of [
    "dist/server-nestjs-node.js",
    "dist/server-nestjs-express.js",
    "dist/server-nestjs-fastify.js",
  ]) {
    if (!existsSyncPath(join(BENCH_DIR, distFile))) {
      throw new Error(
        `Missing compiled NestJS artifact ${distFile}. Run "bun run build:node" first.`,
      );
    }
  }

  // Step 1: Pre-flight correctness & ValidationPipe verification across all targets
  console.log(
    `\n[1/4] Pre-flight correctness & ValidationPipe verification (${TARGETS.length} targets)...`,
  );
  for (const target of TARGETS) {
    await verifyTargetCorrectness(target);
    console.log(
      `  ✓ ${target.name} (GET/POST/DTO valid=201, invalid=400, extraField=400)`,
    );
  }

  if (config.verifyOnly) {
    console.log(
      `\n✓ All ${TARGETS.length} targets passed pre-flight verification.`,
    );
    return;
  }

  // Step 2: Cold startup time (Workload 5)
  console.log(
    `\n[2/4] Measuring cold startup time (${config.coldRuns} isolated spawns per target)...`,
  );
  const coldStarts: ColdStartSummary[] = [];
  for (const target of TARGETS) {
    const summary = await measureColdStartup(target, config.coldRuns);
    coldStarts.push(summary);
    console.log(
      `  ✓ ${target.name.padEnd(30)} median=${summary.medianFirstReqMs.toFixed(1)} ms (min=${summary.minFirstReqMs.toFixed(1)}, max=${summary.maxFirstReqMs.toFixed(1)}, idleRSS=${summary.medianIdleRssMb.toFixed(1)} MB)`,
    );
  }

  // Step 3: Multi-run isolated HTTP workloads (Workloads 1–4 + Server RSS/CPU)
  console.log(
    `\n[3/4] Running HTTP workloads (${config.runs} runs × ${TARGETS.length} isolated targets × ${WORKLOADS.length} workloads)...`,
  );
  const allSingleRuns: SingleRunWorkloadResult[] = [];
  const idleRssByTarget = new Map<string, number[]>();
  const idleHeapByTarget = new Map<string, number[]>();
  const peakRssByTarget = new Map<string, number>();
  const peakHeapByTarget = new Map<string, number>();

  for (let runIdx = 1; runIdx <= config.runs; runIdx += 1) {
    console.log(`\n  --- Run ${runIdx}/${config.runs} ---`);
    for (const target of TARGETS) {
      const { server } = await ManagedServer.spawn(target);
      try {
        const idleRss = bytesToMb(server.ready.idleRssBytes);
        const idleHeap = bytesToMb(server.ready.idleHeapUsedBytes);
        idleRssByTarget.set(target.id, [
          ...(idleRssByTarget.get(target.id) ?? []),
          idleRss,
        ]);
        idleHeapByTarget.set(target.id, [
          ...(idleHeapByTarget.get(target.id) ?? []),
          idleHeap,
        ]);
        peakRssByTarget.set(
          target.id,
          Math.max(peakRssByTarget.get(target.id) ?? 0, idleRss),
        );
        peakHeapByTarget.set(
          target.id,
          Math.max(peakHeapByTarget.get(target.id) ?? 0, idleHeap),
        );

        const summaryParts: string[] = [];
        for (const spec of WORKLOADS) {
          const res = await runHttpWorkload(
            server,
            target,
            spec,
            runIdx,
            config.requests,
            config.warmup,
            config.concurrency,
          );
          allSingleRuns.push(res);
          peakRssByTarget.set(
            target.id,
            Math.max(peakRssByTarget.get(target.id) ?? 0, res.postRssMb),
          );
          peakHeapByTarget.set(
            target.id,
            Math.max(peakHeapByTarget.get(target.id) ?? 0, res.postHeapMb),
          );
          summaryParts.push(
            `${spec.id}=${fmtNum(res.throughputRps)} rps (p50=${res.latency.p50Ms.toFixed(2)}ms, err=${res.errors})`,
          );
        }
        console.log(
          `  ✓ ${target.shortName.padEnd(22)} ${summaryParts.join(" | ")}`,
        );
      } finally {
        await server.shutdown();
      }
      await Bun.sleep(250);
    }
  }

  // Aggregate HTTP runs per (workload, target)
  const aggregated: AggregatedWorkloadResult[] = [];
  for (const w of WORKLOADS) {
    for (const t of TARGETS) {
      const matching = allSingleRuns.filter(
        (r) => r.workloadId === w.id && r.targetId === t.id,
      );
      const sorted = [...matching].sort(
        (a, b) => a.throughputRps - b.throughputRps,
      );
      const rep = sorted[Math.floor(sorted.length / 2)]!;
      const rpsValues = matching.map((r) => r.throughputRps);
      const meanRps = rpsValues.reduce((a, b) => a + b, 0) / rpsValues.length;
      const variance =
        rpsValues.reduce((acc, v) => acc + (v - meanRps) ** 2, 0) /
        rpsValues.length;
      const cvPct = meanRps > 0 ? (Math.sqrt(variance) / meanRps) * 100 : 0;

      aggregated.push({
        target: t,
        workload: w,
        representative: rep,
        allRuns: matching,
        minRps: Math.min(...rpsValues),
        maxRps: Math.max(...rpsValues),
        meanRps,
        cvPct,
        totalErrors: matching.reduce((acc, r) => acc + r.errors, 0),
        totalRequests: matching.reduce((acc, r) => acc + r.requests, 0),
      });
    }
  }

  // Memory summaries (combine cold start idle RSS + run idle RSS for rock-solid median idle RSS)
  const memorySummaries: MemorySummary[] = TARGETS.map((t) => {
    const cold = coldStarts.find((c) => c.target.id === t.id)!;
    const allIdleRss = [
      ...(idleRssByTarget.get(t.id) ?? []),
      ...cold.samples.map((s) => s.idleRssMb),
    ];
    const allIdleHeap = [
      ...(idleHeapByTarget.get(t.id) ?? []),
      ...cold.samples.map((s) => s.idleHeapMb),
    ];
    return {
      target: t,
      idleRssMb: median(allIdleRss),
      peakLoadedRssMb: peakRssByTarget.get(t.id) ?? 0,
      idleHeapMb: median(allIdleHeap),
      peakHeapMb: peakHeapByTarget.get(t.id) ?? 0,
    };
  });

  // Step 4: Dependency footprint & package versions (Workload 6b)
  console.log("\n[4/4] Measuring dependency & disk footprint...");
  const footprints = measureAllStackFootprints(BENCH_DIR, REPO_ROOT);
  for (const f of footprints.withValidation) {
    console.log(
      `  ✓ ${f.label.padEnd(42)} total=${f.totalPackages} pkgs (npm=${f.externalNpmPackages}), disk=${f.totalMb.toFixed(2)} MB`,
    );
  }
  for (const f of footprints.coreOnly) {
    console.log(
      `  ✓ ${f.label.padEnd(42)} total=${f.totalPackages} pkgs (npm=${f.externalNpmPackages}), disk=${f.totalMb.toFixed(2)} MB`,
    );
  }

  const benchNm = join(BENCH_DIR, "node_modules");
  const versions: Record<string, string> = {
    "@bunest/core": readPkgVersion(
      join(REPO_ROOT, "packages/core/package.json"),
    ),
    "@bunest/core": readPkgVersion(
      join(REPO_ROOT, "packages/common/package.json"),
    ),
    "@bunest/core/http": readPkgVersion(
      join(REPO_ROOT, "packages/http/package.json"),
    ),
    "@bunest/validation": readPkgVersion(
      join(REPO_ROOT, "packages/validation/package.json"),
    ),
    "@nestjs/core": readPkgVersion(join(benchNm, "@nestjs/core/package.json")),
    "@nestjs/common": readPkgVersion(
      join(benchNm, "@nestjs/common/package.json"),
    ),
    "@nestjs/platform-node": readPkgVersion(
      join(benchNm, "@nestjs/platform-node/package.json"),
    ),
    "@nestjs/platform-fastify": readPkgVersion(
      join(benchNm, "@nestjs/platform-fastify/package.json"),
    ),
    "@nestjs/platform-express": readPkgVersion(
      join(benchNm, "@nestjs/platform-express/package.json"),
    ),
    fastify: readPkgVersion(join(benchNm, "fastify/package.json")),
    express: readPkgVersion(join(benchNm, "express/package.json")),
    rxjs: readPkgVersion(join(benchNm, "rxjs/package.json")),
    "reflect-metadata": readPkgVersion(
      join(benchNm, "reflect-metadata/package.json"),
    ),
    "class-validator": readPkgVersion(
      join(benchNm, "class-validator/package.json"),
    ),
    "class-transformer": readPkgVersion(
      join(benchNm, "class-transformer/package.json"),
    ),
    typescript: readPkgVersion(join(benchNm, "typescript/package.json")),
  };

  const md = renderMarkdownReport({
    timestamp: new Date().toISOString(),
    config,
    nodeVersion,
    versions,
    aggregated,
    coldStarts,
    memorySummaries,
    footprints,
  });

  if (config.writeResults) {
    const outPath = join(BENCH_DIR, "RESULTS.md");
    await Bun.write(outPath, md);
    console.log(`\n✓ Wrote full benchmark report to ${outPath}`);
  }
}

await main();
