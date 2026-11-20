import "reflect-metadata";
import os from "node:os";
import { resolve } from "node:path";
import {
  IsEmail,
  IsInt,
  IsString,
  Min,
  MinLength,
} from "class-validator";
import {
  Body,
  BunestFactory,
  Controller,
  Get,
  Injectable,
  Module,
  Param,
  Post,
  Scope,
  ValidationPipe,
} from "../packages/core/src";

export interface LatencyStats {
  readonly minMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  readonly meanMs: number;
}

export interface BenchmarkRow {
  readonly workload: string;
  readonly variant: "Bun.serve (raw)" | "Bunest";
  readonly mode: "live-http" | "in-process";
  readonly requests: number;
  readonly concurrency: number;
  readonly durationMs: number;
  readonly throughputRps: number;
  readonly latency: LatencyStats;
  readonly rssMb: number;
  readonly errors: number;
  readonly errorRatePct: number;
}

export interface DiBenchmarkRow {
  readonly operation: string;
  readonly iterations: number;
  readonly durationMs: number;
  readonly opsPerSec: number;
  readonly latency: LatencyStats;
  readonly rssMb: number;
}

export interface BenchmarkEnvironment {
  readonly timestamp: string;
  readonly bunVersion: string;
  readonly bunRevision: string;
  readonly osPlatform: NodeJS.Platform;
  readonly osRelease: string;
  readonly arch: string;
  readonly cpuModel: string;
  readonly cpuCores: number;
  readonly totalRamGb: number;
  readonly bunestCoreVersion: string;
  readonly classValidatorVersion: string;
  readonly classTransformerVersion: string;
}

export interface BenchmarkConfig {
  readonly liveRequests: number;
  readonly liveWarmup: number;
  readonly concurrency: number;
  readonly inProcessIterations: number;
  readonly inProcessWarmup: number;
  readonly diIterations: number;
  readonly coldBootstrapIterations: number;
  readonly payloadBytes: number;
}

export interface BenchmarkReport {
  readonly env: BenchmarkEnvironment;
  readonly config: BenchmarkConfig;
  readonly liveHttp: readonly BenchmarkRow[];
  readonly inProcess: readonly BenchmarkRow[];
  readonly di: readonly DiBenchmarkRow[];
}

export interface RunBenchmarkOptions {
  liveRequests?: number;
  liveWarmup?: number;
  concurrency?: number;
  inProcessIterations?: number;
  inProcessWarmup?: number;
  diIterations?: number;
  coldBootstrapIterations?: number;
}

// --- Shared Fixture Data & DTO ---

interface BenchUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly age: number;
}

const SEED_USERS = new Map<string, BenchUser>();
for (let i = 1; i <= 100; i += 1) {
  SEED_USERS.set(String(i), {
    id: String(i),
    email: `user${i}@bunest.dev`,
    name: `User ${i}`,
    age: 20 + (i % 30),
  });
}

const VALID_POST_PAYLOAD_OBJ = {
  email: "alice@bunest.dev",
  name: "Alice Nguyen",
  age: 28,
};
const VALID_POST_PAYLOAD_JSON = JSON.stringify(VALID_POST_PAYLOAD_OBJ);

class CreateBenchUserDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(2)
  name!: string;

  @IsInt()
  @Min(18)
  age!: number;
}

@Injectable()
class UsersBenchService {
  findById(id: string): BenchUser {
    return (
      SEED_USERS.get(id) ?? {
        id,
        email: `unknown-${id}@bunest.dev`,
        name: "Unknown",
        age: 25,
      }
    );
  }

  create(payload: { email: string; name: string; age: number }): BenchUser {
    return {
      id: "u_new",
      email: payload.email,
      name: payload.name,
      age: payload.age,
    };
  }
}

@Injectable({ scope: Scope.TRANSIENT })
class TransientBenchService {
  constructor(public readonly users: UsersBenchService) {}
}

@Injectable({ scope: Scope.REQUEST })
class RequestScopedBenchService {
  readonly createdAt = Bun.nanoseconds();
  constructor(public readonly users: UsersBenchService) {}
}

const benchValidationPipe = new ValidationPipe();

@Controller()
class BenchController {
  constructor(private readonly usersService: UsersBenchService) {}

  @Get("/health")
  health(): { status: string } {
    return { status: "ok" };
  }

  @Get("/users/:id")
  getUser(@Param("id") id: string): BenchUser {
    return this.usersService.findById(id);
  }

  @Post("/users")
  createUser(
    @Body() body: { email: string; name: string; age: number },
  ): BenchUser {
    return this.usersService.create(body);
  }

  @Post("/users/validated")
  createValidatedUser(
    @Body(benchValidationPipe) dto: CreateBenchUserDto,
  ): BenchUser {
    return this.usersService.create(dto);
  }
}

@Module({
  controllers: [BenchController],
  providers: [
    UsersBenchService,
    TransientBenchService,
    RequestScopedBenchService,
  ],
})
class BenchModule {}

// --- Helpers ---

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

function getRssMb(): number {
  return Math.round((process.memoryUsage().rss / (1024 * 1024)) * 100) / 100;
}

async function readPkgVersion(relPath: string): Promise<string> {
  try {
    const root = resolve(import.meta.dir, "..");
    const pkg = (await Bun.file(resolve(root, relPath)).json()) as {
      version?: string;
    };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export async function collectEnvironment(): Promise<BenchmarkEnvironment> {
  const cpus = os.cpus();
  const [bunestCoreVersion, classValidatorVersion, classTransformerVersion] =
    await Promise.all([
      readPkgVersion("packages/core/package.json"),
      readPkgVersion("node_modules/class-validator/package.json"),
      readPkgVersion("node_modules/class-transformer/package.json"),
    ]);

  return {
    timestamp: new Date().toISOString(),
    bunVersion: Bun.version,
    bunRevision: Bun.revision,
    osPlatform: os.platform(),
    osRelease: os.release(),
    arch: process.arch,
    cpuModel: cpus[0]?.model?.trim() || "unknown",
    cpuCores: cpus.length,
    totalRamGb:
      Math.round((os.totalmem() / (1024 * 1024 * 1024)) * 100) / 100,
    bunestCoreVersion,
    classValidatorVersion,
    classTransformerVersion,
  };
}

interface HttpWorkloadSpec {
  readonly label: string;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body?: string;
  readonly headers?: Record<string, string>;
  readonly expectedStatus: number;
}

const LIVE_WORKLOADS: readonly HttpWorkloadSpec[] = [
  {
    label: "1. Static GET /health",
    method: "GET",
    path: "/health",
    expectedStatus: 200,
  },
  {
    label: "2. Param GET /users/:id + DI",
    method: "GET",
    path: "/users/42",
    expectedStatus: 200,
  },
  {
    label: "3. JSON POST /users (@Body)",
    method: "POST",
    path: "/users",
    body: VALID_POST_PAYLOAD_JSON,
    headers: { "content-type": "application/json" },
    expectedStatus: 201,
  },
  {
    label: "4. Validated POST /users/validated (DTO)",
    method: "POST",
    path: "/users/validated",
    body: VALID_POST_PAYLOAD_JSON,
    headers: { "content-type": "application/json" },
    expectedStatus: 201,
  },
];

async function runLiveHttpWorkload(
  baseUrl: string,
  spec: HttpWorkloadSpec,
  variant: "Bun.serve (raw)" | "Bunest",
  requests: number,
  warmup: number,
  concurrency: number,
): Promise<BenchmarkRow> {
  const url = `${baseUrl}${spec.path}`;
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
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, warmup) }, runWarmupWorker),
  );

  // Measured phase
  const latenciesNs: number[] = new Array<number>(requests);
  let nextIdx = 0;
  let errors = 0;
  const startNs = Bun.nanoseconds();

  const runWorker = async () => {
    while (true) {
      const idx = nextIdx++;
      if (idx >= requests) {
        return;
      }
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
  const totalNs = Bun.nanoseconds() - startNs;
  const durationMs = totalNs / 1_000_000;

  return {
    workload: spec.label,
    variant,
    mode: "live-http",
    requests,
    concurrency,
    durationMs,
    throughputRps: (requests / durationMs) * 1000,
    latency: computeLatencyStats(latenciesNs),
    rssMb: getRssMb(),
    errors,
    errorRatePct: (errors / requests) * 100,
  };
}

async function runInProcessWorkload(
  dispatcher: (req: Request) => Promise<Response> | Response,
  spec: HttpWorkloadSpec,
  variant: "Bun.serve (raw)" | "Bunest",
  iterations: number,
  warmup: number,
): Promise<BenchmarkRow> {
  const url = `http://localhost${spec.path}`;
  const makeRequest = (): Request =>
    new Request(url, {
      method: spec.method,
      headers: spec.headers,
      ...(spec.body !== undefined ? { body: spec.body } : {}),
    });

  for (let i = 0; i < warmup; i += 1) {
    const res = await dispatcher(makeRequest());
    await res.arrayBuffer();
  }

  const latenciesNs = new Array<number>(iterations);
  let errors = 0;
  const startNs = Bun.nanoseconds();

  for (let i = 0; i < iterations; i += 1) {
    const t0 = Bun.nanoseconds();
    const res = await dispatcher(makeRequest());
    if (res.status !== spec.expectedStatus) {
      errors += 1;
    }
    latenciesNs[i] = Bun.nanoseconds() - t0;
  }

  const durationMs = (Bun.nanoseconds() - startNs) / 1_000_000;

  return {
    workload: spec.label,
    variant,
    mode: "in-process",
    requests: iterations,
    concurrency: 1,
    durationMs,
    throughputRps: (iterations / durationMs) * 1000,
    latency: computeLatencyStats(latenciesNs),
    rssMb: getRssMb(),
    errors,
    errorRatePct: (errors / iterations) * 100,
  };
}

function createRawBaselineServer() {
  const usersService = new UsersBenchService();

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    routes: {
      "/health": {
        GET: () => Response.json({ status: "ok" }),
      },
      "/users/:id": {
        GET: (req) => Response.json(usersService.findById(req.params.id)),
      },
      "/users": {
        POST: async (req) => {
          const body = (await req.json()) as {
            email: string;
            name: string;
            age: number;
          };
          return Response.json(usersService.create(body), { status: 201 });
        },
      },
      "/users/validated": {
        POST: async (req) => {
          const body = (await req.json()) as Record<string, unknown>;
          const dto = (await benchValidationPipe.transform(body, {
            type: "body",
            metatype: CreateBenchUserDto,
          })) as CreateBenchUserDto;
          return Response.json(usersService.create(dto), { status: 201 });
        },
      },
    },
    fetch() {
      return new Response("Not Found", { status: 404 });
    },
  });

  const inProcessFetch = async (req: Request): Promise<Response> => {
    const pathname = new URL(req.url).pathname;
    if (req.method === "GET" && pathname === "/health") {
      return Response.json({ status: "ok" });
    }
    if (req.method === "GET" && pathname.startsWith("/users/")) {
      const id = pathname.slice("/users/".length);
      return Response.json(usersService.findById(id));
    }
    if (req.method === "POST" && pathname === "/users") {
      const body = (await req.json()) as {
        email: string;
        name: string;
        age: number;
      };
      return Response.json(usersService.create(body), { status: 201 });
    }
    if (req.method === "POST" && pathname === "/users/validated") {
      const body = (await req.json()) as Record<string, unknown>;
      const dto = (await benchValidationPipe.transform(body, {
        type: "body",
        metatype: CreateBenchUserDto,
      })) as CreateBenchUserDto;
      return Response.json(usersService.create(dto), { status: 201 });
    }
    return new Response("Not Found", { status: 404 });
  };

  return { server, inProcessFetch };
}

async function runDiMicrobenchmarks(
  iterations: number,
  coldBootstrapIterations: number,
): Promise<DiBenchmarkRow[]> {
  const rows: DiBenchmarkRow[] = [];

  // 1. Cold bootstrap (ModuleScanner + DIContainer + Route Compilation)
  const coldLatencies: number[] = [];
  const coldStart = Bun.nanoseconds();
  for (let i = 0; i < coldBootstrapIterations; i += 1) {
    const t0 = Bun.nanoseconds();
    const app = await BunestFactory.create(BenchModule, { logger: false });
    await app.init();
    coldLatencies.push(Bun.nanoseconds() - t0);
    await app.close();
  }
  const coldDurationMs = (Bun.nanoseconds() - coldStart) / 1_000_000;
  rows.push({
    operation: "Cold bootstrap (scan + DI + route compile + init)",
    iterations: coldBootstrapIterations,
    durationMs: coldDurationMs,
    opsPerSec: (coldBootstrapIterations / coldDurationMs) * 1000,
    latency: computeLatencyStats(coldLatencies),
    rssMb: getRssMb(),
  });

  const app = await BunestFactory.create(BenchModule, { logger: false });
  await app.init();
  const container = app.getModuleContainer();

  try {
    // 2. Hot singleton DI lookup
    for (let i = 0; i < 500; i += 1) {
      app.get(UsersBenchService);
    }
    const singletonLatencies = new Array<number>(iterations);
    const sStart = Bun.nanoseconds();
    for (let i = 0; i < iterations; i += 1) {
      const t0 = Bun.nanoseconds();
      app.get(UsersBenchService);
      singletonLatencies[i] = Bun.nanoseconds() - t0;
    }
    const sDurationMs = (Bun.nanoseconds() - sStart) / 1_000_000;
    rows.push({
      operation: "Hot singleton DI lookup (app.get)",
      iterations,
      durationMs: sDurationMs,
      opsPerSec: (iterations / sDurationMs) * 1000,
      latency: computeLatencyStats(singletonLatencies),
      rssMb: getRssMb(),
    });

    // 3. Hot transient DI resolution
    for (let i = 0; i < 200; i += 1) {
      await app.resolve(TransientBenchService);
    }
    const transientLatencies = new Array<number>(iterations);
    const tStart = Bun.nanoseconds();
    for (let i = 0; i < iterations; i += 1) {
      const t0 = Bun.nanoseconds();
      await app.resolve(TransientBenchService);
      transientLatencies[i] = Bun.nanoseconds() - t0;
    }
    const tDurationMs = (Bun.nanoseconds() - tStart) / 1_000_000;
    rows.push({
      operation: "Hot transient DI resolve (app.resolve)",
      iterations,
      durationMs: tDurationMs,
      opsPerSec: (iterations / tDurationMs) * 1000,
      latency: computeLatencyStats(transientLatencies),
      rssMb: getRssMb(),
    });

    // 4. Request-scoped DI container create + resolve + destroy
    const dummyReq = new Request("http://localhost/users/1");
    for (let i = 0; i < 200; i += 1) {
      const rc = container.createRequestContainer(dummyReq);
      await app.resolve(RequestScopedBenchService, rc);
      await rc.destroy();
    }
    const reqLatencies = new Array<number>(iterations);
    const rStart = Bun.nanoseconds();
    for (let i = 0; i < iterations; i += 1) {
      const t0 = Bun.nanoseconds();
      const rc = container.createRequestContainer(dummyReq);
      await app.resolve(RequestScopedBenchService, rc);
      await rc.destroy();
      reqLatencies[i] = Bun.nanoseconds() - t0;
    }
    const rDurationMs = (Bun.nanoseconds() - rStart) / 1_000_000;
    rows.push({
      operation: "Request-scoped DI lifecycle (create + resolve + destroy)",
      iterations,
      durationMs: rDurationMs,
      opsPerSec: (iterations / rDurationMs) * 1000,
      latency: computeLatencyStats(reqLatencies),
      rssMb: getRssMb(),
    });
  } finally {
    await app.close();
  }

  return rows;
}

/**
 * Executes the full Bunest vs raw `Bun.serve()` HTTP & DI benchmark suite.
 */
export async function runAllBenchmarks(
  options: RunBenchmarkOptions = {},
): Promise<BenchmarkReport> {
  const config: BenchmarkConfig = {
    liveRequests: options.liveRequests ?? 4000,
    liveWarmup: options.liveWarmup ?? 400,
    concurrency: options.concurrency ?? 32,
    inProcessIterations: options.inProcessIterations ?? 10_000,
    inProcessWarmup: options.inProcessWarmup ?? 1_000,
    diIterations: options.diIterations ?? 10_000,
    coldBootstrapIterations: options.coldBootstrapIterations ?? 50,
    payloadBytes: Buffer.byteLength(VALID_POST_PAYLOAD_JSON, "utf8"),
  };

  const env = await collectEnvironment();
  const raw = createRawBaselineServer();
  const bunestApp = await BunestFactory.create(BenchModule, { logger: false });
  const bunestInfo = await bunestApp.listen({
    hostname: "127.0.0.1",
    port: 0,
  });

  const liveHttp: BenchmarkRow[] = [];
  const inProcess: BenchmarkRow[] = [];

  try {
    const rawBaseUrl = `http://127.0.0.1:${raw.server.port}`;
    const bunestBaseUrl = bunestInfo.url.replace(/\/$/, "");

    for (const spec of LIVE_WORKLOADS) {
      liveHttp.push(
        await runLiveHttpWorkload(
          rawBaseUrl,
          spec,
          "Bun.serve (raw)",
          config.liveRequests,
          config.liveWarmup,
          config.concurrency,
        ),
      );
      liveHttp.push(
        await runLiveHttpWorkload(
          bunestBaseUrl,
          spec,
          "Bunest",
          config.liveRequests,
          config.liveWarmup,
          config.concurrency,
        ),
      );
    }

    for (const spec of LIVE_WORKLOADS) {
      inProcess.push(
        await runInProcessWorkload(
          raw.inProcessFetch,
          spec,
          "Bun.serve (raw)",
          config.inProcessIterations,
          config.inProcessWarmup,
        ),
      );
      inProcess.push(
        await runInProcessWorkload(
          (req) => bunestApp.fetch(req),
          spec,
          "Bunest",
          config.inProcessIterations,
          config.inProcessWarmup,
        ),
      );
    }
  } finally {
    raw.server.stop(true);
    await bunestApp.close();
  }

  const di = await runDiMicrobenchmarks(
    config.diIterations,
    config.coldBootstrapIterations,
  );

  return {
    env,
    config,
    liveHttp,
    inProcess,
    di,
  };
}

function fmtNum(n: number, decimals = 0): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function buildOverheadRows(rows: readonly BenchmarkRow[]): string[] {
  const byWorkload = new Map<
    string,
    { raw?: BenchmarkRow; bunest?: BenchmarkRow }
  >();
  for (const row of rows) {
    const pair = byWorkload.get(row.workload) ?? {};
    if (row.variant === "Bun.serve (raw)") {
      pair.raw = row;
    } else {
      pair.bunest = row;
    }
    byWorkload.set(row.workload, pair);
  }

  const lines: string[] = [
    "| Workload | Raw `Bun.serve` (req/s) | Bunest (req/s) | Relative Throughput | p50 Overhead (ms) | p99 Overhead (ms) |",
    "|---|---:|---:|---:|---:|---:|",
  ];

  for (const [workload, pair] of byWorkload.entries()) {
    if (!pair.raw || !pair.bunest) continue;
    const ratio = (pair.bunest.throughputRps / pair.raw.throughputRps) * 100;
    const p50Delta = pair.bunest.latency.p50Ms - pair.raw.latency.p50Ms;
    const p99Delta = pair.bunest.latency.p99Ms - pair.raw.latency.p99Ms;
    const sign = (v: number) => (v >= 0 ? `+${v.toFixed(3)}` : v.toFixed(3));
    lines.push(
      `| ${workload} | ${fmtNum(pair.raw.throughputRps)} | ${fmtNum(pair.bunest.throughputRps)} | ${ratio.toFixed(1)}% | ${sign(p50Delta)} | ${sign(p99Delta)} |`,
    );
  }

  return lines;
}

/**
 * Formats a `BenchmarkReport` into a reproducible Markdown document suitable
 * for `benchmarks/RESULTS.md` and `docs/benchmarks.md`.
 */
export function renderResultsMarkdown(report: BenchmarkReport): string {
  const { env, config, liveHttp, inProcess, di } = report;

  const formatHttpTable = (rows: readonly BenchmarkRow[]): string => {
    const header = [
      "| Workload | Framework | Throughput (req/s) | p50 (ms) | p95 (ms) | p99 (ms) | RSS (MB) | Errors (%) |",
      "|---|---|---:|---:|---:|---:|---:|---:|",
    ];
    for (const r of rows) {
      header.push(
        `| ${r.workload} | ${r.variant} | ${fmtNum(r.throughputRps)} | ${r.latency.p50Ms.toFixed(3)} | ${r.latency.p95Ms.toFixed(3)} | ${r.latency.p99Ms.toFixed(3)} | ${r.rssMb.toFixed(1)} | ${r.errorRatePct.toFixed(2)}% |`,
      );
    }
    return header.join("\n");
  };

  const diHeader = [
    "| Operation | Iterations | Throughput (ops/s) | p50 (ms) | p95 (ms) | p99 (ms) | RSS (MB) |",
    "|---|---:|---:|---:|---:|---:|---:|",
  ];
  for (const r of di) {
    diHeader.push(
      `| ${r.operation} | ${fmtNum(r.iterations)} | ${fmtNum(r.opsPerSec)} | ${r.latency.p50Ms.toFixed(4)} | ${r.latency.p95Ms.toFixed(4)} | ${r.latency.p99Ms.toFixed(4)} | ${r.rssMb.toFixed(1)} |`,
    );
  }

  return `# Bunest Benchmark Results

> **Measured automatically on real hardware** via \`bun run benchmarks/run.ts\`.
> No synthetic or extrapolated claims — every figure below was recorded directly on this machine.

## Environment & Configuration

| Property | Value |
|---|---|
| Measured At (UTC) | \`${env.timestamp}\` |
| Bun Runtime | \`v${env.bunVersion}\` (\`${env.bunRevision.slice(0, 8)}\`) |
| OS / Arch | \`${env.osPlatform} ${env.osRelease} (${env.arch})\` |
| CPU | \`${env.cpuModel}\` (${env.cpuCores} logical cores) |
| Total RAM | \`${env.totalRamGb.toFixed(2)} GiB\` |
| Package Versions | \`@bunest/core@${env.bunestCoreVersion}\`, \`class-validator@${env.classValidatorVersion}\`, \`class-transformer@${env.classTransformerVersion}\` |
| Live HTTP Config | ${fmtNum(config.liveRequests)} requests/workload, ${fmtNum(config.liveWarmup)} warmup, concurrency ${config.concurrency}, HTTP/1.1 \`keep-alive\`, POST JSON payload ${config.payloadBytes} bytes, logging disabled |
| In-Process Dispatch Config | ${fmtNum(config.inProcessIterations)} iterations/workload, ${fmtNum(config.inProcessWarmup)} warmup, concurrency 1 (isolates framework routing/pipeline/DI overhead from loopback TCP) |
| DI Microbench Config | ${fmtNum(config.diIterations)} hot ops, ${config.coldBootstrapIterations} cold bootstraps |

## 1. Live Loopback HTTP (\`Bun.serve({ port: 0 })\`, Concurrency ${config.concurrency})

${formatHttpTable(liveHttp)}

### Live HTTP Overhead vs Raw \`Bun.serve()\`

${buildOverheadRows(liveHttp).join("\n")}

## 2. In-Process \`fetch()\` Dispatch Microbenchmark (${fmtNum(config.inProcessIterations)} ops)

Separates Bunest's compiled route matching, parameter extraction, DI resolution, and serialization cost from OS loopback socket overhead:

${formatHttpTable(inProcess)}

### In-Process Overhead vs Raw Handler

${buildOverheadRows(inProcess).join("\n")}

## 3. DI Container & Bootstrap Microbenchmarks

${diHeader.join("\n")}

## Reproduction

\`\`\`bash
bun run benchmarks/run.ts
\`\`\`

Optional flags: \`--requests <n>\`, \`--warmup <n>\`, \`--concurrency <n>\`, \`--iterations <n>\`.
`;
}
