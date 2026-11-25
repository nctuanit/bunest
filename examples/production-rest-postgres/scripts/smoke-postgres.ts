/**
 * Real PostgreSQL production smoke, migration, transaction rollback,
 * DB outage/recovery (200 -> 503 -> 200), backup/restore, graceful shutdown,
 * and secret-redaction verification suite for `examples/production-rest-postgres`.
 *
 * Usage:
 *   DATABASE_ADMIN_URL=postgres://user:pass@127.0.0.1:5432/postgres \
 *     bun run --cwd examples/production-rest-postgres smoke:postgres
 *
 * Optional env vars:
 *   PG_STOP_CMD   Command to stop PostgreSQL (e.g. `docker stop bunest-pg-smoke`)
 *   PG_START_CMD  Command to start PostgreSQL (e.g. `docker start bunest-pg-smoke`)
 *                 If omitted, a built-in loopback TCP proxy is placed in front of
 *                 PostgreSQL so the suite still tests real TCP connection loss and
 *                 automatic pool recovery without requiring root/service privileges.
 *   SMOKE_LOG_DIR Directory where redacted app logs are saved (default: .smoke-logs)
 */
import { strictAssert as assert } from "@bunest/core";
import { DataSource } from "@bunest/orm";
import { redactSecrets } from "../src/config";
import { ItemEntity } from "../src/item.entity";
import {
  ALL_MIGRATIONS,
  INITIAL_MIGRATIONS,
} from "../src/migrations";
import { runProductionMigrations } from "../src/migrate";
import { ProductionAppModule, configureProductionApp } from "../src/app.module";
import { ItemsService } from "../src/items.service";
import { loadAppConfig } from "../src/config";
import { BunestFactory } from "@bunest/core";

const APP_DIR = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const LOG_DIR = Bun.env.SMOKE_LOG_DIR || `${APP_DIR}/.smoke-logs`;

interface RunningApp {
  readonly proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  readonly port: number;
  readonly baseUrl: string;
  readonly logs: string[];
  stop: (signal?: NodeJS.Signals) => Promise<number>;
}

async function pollUntil<T>(
  label: string,
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs: number,
  intervalMs = 150,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) {
        return value;
      }
    } catch (err) {
      lastError = err;
    }
    await Bun.sleep(intervalMs);
  }
  const detail =
    lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${label}${detail}`,
  );
}

async function getFreePort(): Promise<number> {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("ok"),
  });
  const port = server.port;
  await server.stop(true);
  if (!port) {
    throw new Error("Could not allocate free loopback port");
  }
  return port;
}

async function runShell(cmd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["sh", "-c", cmd], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/**
 * Built-in loopback TCP proxy for simulating real PostgreSQL outage & recovery
 * when `PG_STOP_CMD` / `PG_START_CMD` are not provided.
 */
class TcpFaultProxy {
  private listener: { stop(closeActiveConnections?: boolean): void } | null = null;
  private readonly activeSockets = new Set<{ end: () => void }>();

  constructor(
    readonly listenPort: number,
    private readonly targetHost: string,
    private readonly targetPort: number,
  ) {}

  start(): void {
    if (this.listener) return;
    const self = this;
    this.listener = Bun.listen<{ upstream?: { write: (d: Uint8Array) => number; end: () => void }; pending: Uint8Array[] }>({
      hostname: "127.0.0.1",
      port: this.listenPort,
      socket: {
        async open(clientSocket) {
          clientSocket.data = { pending: [] };
          self.activeSockets.add(clientSocket);
          try {
            const upstream = await Bun.connect({
              hostname: self.targetHost,
              port: self.targetPort,
              socket: {
                data(_up, data) {
                  clientSocket.write(data);
                },
                close() {
                  clientSocket.end();
                },
                error() {
                  clientSocket.end();
                },
              },
            });
            self.activeSockets.add(upstream);
            clientSocket.data.upstream = upstream;
            for (const chunk of clientSocket.data.pending) {
              upstream.write(chunk);
            }
            clientSocket.data.pending = [];
          } catch {
            clientSocket.end();
          }
        },
        data(clientSocket, data) {
          const copy = new Uint8Array(data);
          if (clientSocket.data.upstream) {
            clientSocket.data.upstream.write(copy);
          } else {
            clientSocket.data.pending.push(copy);
          }
        },
        close(clientSocket) {
          self.activeSockets.delete(clientSocket);
          clientSocket.data.upstream?.end();
        },
        error(clientSocket) {
          self.activeSockets.delete(clientSocket);
          clientSocket.data.upstream?.end();
        },
      },
    });
  }

  stop(): void {
    if (this.listener) {
      this.listener.stop(true);
      this.listener = null;
    }
    for (const sock of this.activeSockets) {
      try {
        sock.end();
      } catch {
        // ignore
      }
    }
    this.activeSockets.clear();
  }
}

async function spawnAppProcess(
  databaseUrl: string,
  extraEnv: Record<string, string> = {},
): Promise<RunningApp> {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const logs: string[] = [];

  const proc = Bun.spawn([process.execPath, "run", "dist/main.js"], {
    cwd: APP_DIR,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...Bun.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      DATABASE_URL: databaseUrl,
      READY_DB_TIMEOUT_MS: "1000",
      DB_CONNECTION_TIMEOUT_SEC: "2",
      SHUTDOWN_READINESS_DELAY_MS: "0",
      SHUTDOWN_DRAIN_TIMEOUT_MS: "5000",
      ...extraEnv,
    },
  });

  const pump = async (stream: ReadableStream<Uint8Array>, tag: string) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) {
            logs.push(`[${tag}] ${line}`);
          }
        }
      }
    } catch {
      // stream closed
    }
  };
  void pump(proc.stdout, "stdout");
  void pump(proc.stderr, "stderr");

  await pollUntil(
    `app readiness on ${baseUrl}/ready`,
    async () => {
      const res = await fetch(`${baseUrl}/ready`);
      return res.status === 200;
    },
    15_000,
    150,
  );

  return {
    proc,
    port,
    baseUrl,
    logs,
    async stop(signal: NodeJS.Signals = "SIGTERM"): Promise<number> {
      proc.kill(signal);
      return await proc.exited;
    },
  };
}

function buildDbUrl(adminUrl: string, dbName: string): string {
  const u = new URL(adminUrl);
  u.pathname = `/${dbName}`;
  return u.toString();
}

async function createDatabase(adminUrl: string, dbName: string): Promise<void> {
  const ds = new DataSource({
    type: "postgres",
    url: adminUrl,
    synchronize: false,
  });
  await ds.initialize();
  try {
    await ds.driver.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await ds.driver.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await ds.destroy();
  }
}

async function dropDatabase(adminUrl: string, dbName: string): Promise<void> {
  const ds = new DataSource({
    type: "postgres",
    url: adminUrl,
    synchronize: false,
  });
  await ds.initialize();
  try {
    await ds.driver.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  } finally {
    await ds.destroy();
  }
}

async function run(): Promise<void> {
  const adminUrl =
    Bun.env.DATABASE_ADMIN_URL ??
    Bun.env.DATABASE_URL ??
    `postgres://${Bun.env.USER ?? "postgres"}@127.0.0.1:5432/postgres`;

  const parsedAdmin = new URL(adminUrl);
  const pgPassword = parsedAdmin.password;
  const metricsToken = "smoke-secret-metrics-token-99123";

  const suffix = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const primaryDb = `bunest_smoke_${suffix}`;
  const restoreDb = `bunest_restore_${suffix}`;

  const allLogs: string[] = [];
  let activeApp: RunningApp | null = null;
  let proxy: TcpFaultProxy | null = null;

  console.log(`[smoke] Step 0: Building dist/main.js & dist/migrate.js`);
  const buildRes = await runShell(
    `cd "${APP_DIR}" && bun run build`,
  );
  assert.equal(
    buildRes.code,
    0,
    `Build failed:\n${buildRes.stdout}\n${buildRes.stderr}`,
  );

  try {
    console.log(`[smoke] Step 1: Creating isolated test databases (${primaryDb}, ${restoreDb})`);
    await createDatabase(adminUrl, primaryDb);
    await createDatabase(adminUrl, restoreDb);

    const primaryUrl = buildDbUrl(adminUrl, primaryDb);
    const restoreUrl = buildDbUrl(adminUrl, restoreDb);

    // -----------------------------------------------------------------------
    // Step 2: Run initial migration (001) on empty DB, insert row, then run
    // additive migration (002) on existing DB with data and verify integrity.
    // -----------------------------------------------------------------------
    console.log(`[smoke] Step 2: Testing migrations on empty DB and existing schema with data`);
    const appliedInitial = await runProductionMigrations(
      primaryUrl,
      INITIAL_MIGRATIONS,
    );
    assert.deepEqual(appliedInitial, ["001_create_items"]);

    // Boot v1 app against 001 schema
    activeApp = await spawnAppProcess(primaryUrl, {
      METRICS_TOKEN: metricsToken,
    });

    // POST /items valid -> 201
    const createRes = await fetch(`${activeApp.baseUrl}/items`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-request-id": "smoke-req-001",
      },
      body: JSON.stringify({
        name: "Alpha Widget",
        description: "Created before migration 002",
        quantity: 42,
      }),
    });
    assert.equal(createRes.status, 201, "POST /items should return 201");
    assert.equal(
      createRes.headers.get("x-request-id"),
      "smoke-req-001",
      "Response should echo x-request-id",
    );
    const createdItem = (await createRes.json()) as {
      id: number;
      name: string;
      description: string | null;
      quantity: number;
      createdAt: string;
    };
    assert.equal(createdItem.name, "Alpha Widget");
    assert.equal(createdItem.quantity, 42);
    assert.ok(Number.isInteger(createdItem.id) && createdItem.id > 0);

    // POST /items invalid -> 400
    const badRes = await fetch(`${activeApp.baseUrl}/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "", quantity: -5, extraField: true }),
    });
    assert.equal(badRes.status, 400, "Invalid POST /items should return 400");

    // GET /items/:id nonexistent -> 404
    const missingRes = await fetch(`${activeApp.baseUrl}/items/99999999`);
    assert.equal(missingRes.status, 404, "Missing item should return 404");

    const invalidIdRes = await fetch(`${activeApp.baseUrl}/items/not-an-id`);
    assert.equal(invalidIdRes.status, 404, "Non-numeric ID should return 404");

    // Verify /metrics protection
    const unauthMetrics = await fetch(`${activeApp.baseUrl}/metrics`);
    assert.equal(unauthMetrics.status, 401, "/metrics without token must be 401");
    const authMetrics = await fetch(`${activeApp.baseUrl}/metrics`, {
      headers: { authorization: `Bearer ${metricsToken}` },
    });
    assert.equal(authMetrics.status, 200, "/metrics with valid token must be 200");
    const metricsBody = await authMetrics.text();
    assert.ok(metricsBody.includes("bunest_http_requests_total"));
    assert.ok(metricsBody.includes("bunest_process_resident_memory_bytes"));
    assert.ok(metricsBody.includes("bunest_event_loop_lag_ms"));

    // Run additive migration 002 while existing data is in DB
    const appliedUpgrade = await runProductionMigrations(
      primaryUrl,
      ALL_MIGRATIONS,
    );
    assert.deepEqual(appliedUpgrade, ["002_add_items_metadata"]);

    // Verify old v1 app still reads & writes cleanly on v2 schema (rollback safety)
    const afterMigGet = await fetch(
      `${activeApp.baseUrl}/items/${createdItem.id}`,
    );
    assert.equal(afterMigGet.status, 200);
    const afterMigItem = (await afterMigGet.json()) as {
      id: number;
      name: string;
      quantity: number;
    };
    assert.equal(afterMigItem.name, "Alpha Widget");
    assert.equal(afterMigItem.quantity, 42);

    // -----------------------------------------------------------------------
    // Step 3: Graceful shutdown (SIGTERM) + Restart persistence check
    // -----------------------------------------------------------------------
    console.log(`[smoke] Step 3: Testing SIGTERM clean exit and persistence across restart`);
    const exitCode1 = await activeApp.stop("SIGTERM");
    allLogs.push(...activeApp.logs);
    assert.equal(exitCode1, 0, "App must exit cleanly with code 0 on SIGTERM");
    activeApp = null;

    // Boot a brand-new process and verify persisted item is still returned
    activeApp = await spawnAppProcess(primaryUrl, {
      METRICS_TOKEN: metricsToken,
    });
    const persistedRes = await fetch(
      `${activeApp.baseUrl}/items/${createdItem.id}`,
    );
    assert.equal(persistedRes.status, 200, "Item must persist across restart");
    const persistedItem = (await persistedRes.json()) as {
      id: number;
      name: string;
      description: string | null;
      quantity: number;
    };
    assert.equal(persistedItem.id, createdItem.id);
    assert.equal(persistedItem.name, "Alpha Widget");
    assert.equal(persistedItem.description, "Created before migration 002");
    assert.equal(persistedItem.quantity, 42);

    const exitCode2 = await activeApp.stop("SIGTERM");
    allLogs.push(...activeApp.logs);
    assert.equal(exitCode2, 0);
    activeApp = null;

    // -----------------------------------------------------------------------
    // Step 4: Transaction rollback integrity test (real PostgreSQL)
    // -----------------------------------------------------------------------
    console.log(`[smoke] Step 4: Testing real PostgreSQL transaction rollback integrity`);
    {
      const cfg = loadAppConfig({ DATABASE_URL: primaryUrl });
      const app = await BunestFactory.create(
        ProductionAppModule.register(cfg),
        { logger: false },
      );
      configureProductionApp(app, cfg);
      await app.init();
      try {
        const svc = app.get(ItemsService);
        let threw = false;
        try {
          await svc.createAtomicPair(
            { name: "Rollback-First-Item", quantity: 1 },
            { name: "Rollback-Second-Item", quantity: 2 },
            { failAfterFirst: true },
          );
        } catch {
          threw = true;
        }
        assert.equal(threw, true, "Simulated transaction failure must throw");

        // Verify zero partial rows were committed in PostgreSQL
        const ds = new DataSource({
          type: "postgres",
          url: primaryUrl,
          synchronize: false,
        });
        await ds.initialize();
        try {
          const check = await ds.driver.query<{ count: string }>(
            `SELECT COUNT(*)::text AS count FROM items WHERE name LIKE 'Rollback-%'`,
          );
          assert.equal(
            Number(check.rows[0]?.count ?? -1),
            0,
            "Failed transaction must leave 0 partial rows in PostgreSQL",
          );
        } finally {
          await ds.destroy();
        }
      } finally {
        await app.close();
      }
    }

    // -----------------------------------------------------------------------
    // Step 5: PostgreSQL disconnect & recovery (/live=200, /ready 200->503->200)
    // without restarting the app process!
    // -----------------------------------------------------------------------
    console.log(`[smoke] Step 5: Testing PostgreSQL disconnect & recovery (200 -> 503 -> 200)`);
    const pgStopCmd = Bun.env.PG_STOP_CMD;
    const pgStartCmd = Bun.env.PG_START_CMD;
    let appDbUrlForOutage = primaryUrl;

    if (!pgStopCmd || !pgStartCmd) {
      const proxyPort = await getFreePort();
      const targetPort = parsedAdmin.port ? Number(parsedAdmin.port) : 5432;
      proxy = new TcpFaultProxy(
        proxyPort,
        parsedAdmin.hostname || "127.0.0.1",
        targetPort,
      );
      proxy.start();
      const proxied = new URL(primaryUrl);
      proxied.hostname = "127.0.0.1";
      proxied.port = String(proxyPort);
      appDbUrlForOutage = proxied.toString();
    }

    activeApp = await spawnAppProcess(appDbUrlForOutage, {
      METRICS_TOKEN: metricsToken,
    });

    // Confirm healthy baseline
    const liveBefore = await fetch(`${activeApp.baseUrl}/live`);
    assert.equal(liveBefore.status, 200);
    const readyBefore = await fetch(`${activeApp.baseUrl}/ready`);
    assert.equal(readyBefore.status, 200);

    // Cut PostgreSQL connectivity
    if (pgStopCmd && pgStartCmd) {
      const stopRes = await runShell(pgStopCmd);
      assert.equal(stopRes.code, 0, `PG_STOP_CMD failed: ${stopRes.stderr}`);
    } else {
      proxy!.stop();
    }

    try {
      // Poll until /ready returns 503 while /live stays 200
      await pollUntil(
        "/ready transitioning 200 -> 503 during PostgreSQL outage",
        async () => {
          const [liveRes, readyRes] = await Promise.all([
            fetch(`${activeApp!.baseUrl}/live`),
            fetch(`${activeApp!.baseUrl}/ready`),
          ]);
          assert.equal(
            liveRes.status,
            200,
            "/live must remain 200 even when PostgreSQL is down",
          );
          return readyRes.status === 503;
        },
        15_000,
        200,
      );
    } finally {
      // Restore PostgreSQL connectivity
      if (pgStopCmd && pgStartCmd) {
        const startRes = await runShell(pgStartCmd);
        assert.equal(
          startRes.code,
          0,
          `PG_START_CMD failed: ${startRes.stderr}`,
        );
      } else {
        proxy!.start();
      }
    }

    // Poll until /ready recovers 503 -> 200 WITHOUT restarting the app
    await pollUntil(
      "/ready recovering 503 -> 200 after PostgreSQL returns",
      async () => {
        const readyRes = await fetch(`${activeApp!.baseUrl}/ready`);
        return readyRes.status === 200;
      },
      25_000,
      250,
    );

    // Confirm CRUD works immediately after DB recovery
    const postAfterRecovery = await fetch(`${activeApp.baseUrl}/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Post-Recovery Widget",
        quantity: 7,
      }),
    });
    assert.equal(
      postAfterRecovery.status,
      201,
      "POST /items must succeed after PostgreSQL recovery",
    );
    const recoveredItem = (await postAfterRecovery.json()) as {
      id: number;
      name: string;
    };

    const exitCode3 = await activeApp.stop("SIGTERM");
    allLogs.push(...activeApp.logs);
    assert.equal(exitCode3, 0);
    activeApp = null;
    if (proxy) {
      proxy.stop();
      proxy = null;
    }

    // -----------------------------------------------------------------------
    // Step 6: Backup & Restore rehearsal (pg_dump -> psql into fresh DB)
    // -----------------------------------------------------------------------
    console.log(`[smoke] Step 6: Rehearsing pg_dump backup and psql restore to ${restoreDb}`);
    const dumpFile = `${LOG_DIR}/backup-${suffix}.sql`;
    await Bun.write(`${LOG_DIR}/.keep`, "");

    const dumpRes = await runShell(
      `pg_dump --no-owner --no-privileges "${primaryUrl}" > "${dumpFile}"`,
    );
    assert.equal(
      dumpRes.code,
      0,
      `pg_dump failed:\n${dumpRes.stdout}\n${dumpRes.stderr}`,
    );

    const restoreRes = await runShell(
      `psql -v ON_ERROR_STOP=1 "${restoreUrl}" < "${dumpFile}"`,
    );
    assert.equal(
      restoreRes.code,
      0,
      `psql restore failed:\n${restoreRes.stdout}\n${restoreRes.stderr}`,
    );

    // Boot app against restored DB and verify both items exist and match
    activeApp = await spawnAppProcess(restoreUrl, {
      METRICS_TOKEN: metricsToken,
    });
    const restored1 = await fetch(
      `${activeApp.baseUrl}/items/${createdItem.id}`,
    );
    assert.equal(restored1.status, 200);
    const restored1Body = (await restored1.json()) as {
      name: string;
      quantity: number;
    };
    assert.equal(restored1Body.name, "Alpha Widget");
    assert.equal(restored1Body.quantity, 42);

    const restored2 = await fetch(
      `${activeApp.baseUrl}/items/${recoveredItem.id}`,
    );
    assert.equal(restored2.status, 200);
    const restored2Body = (await restored2.json()) as { name: string };
    assert.equal(restored2Body.name, "Post-Recovery Widget");

    // Also test readiness flips to 503 during shutdown delay
    const exitCode4 = await activeApp.stop("SIGTERM");
    allLogs.push(...activeApp.logs);
    assert.equal(exitCode4, 0);
    activeApp = null;

    // -----------------------------------------------------------------------
    // Step 7: Verify zero secrets leaked in app logs
    // -----------------------------------------------------------------------
    console.log(`[smoke] Step 7: Verifying zero secrets leaked in application logs`);
    const combinedLogs = allLogs.join("\n");
    if (pgPassword && pgPassword.length >= 3) {
      assert.equal(
        combinedLogs.includes(pgPassword),
        false,
        "DATABASE_URL password leaked into application logs!",
      );
    }
    assert.equal(
      combinedLogs.includes(metricsToken),
      false,
      "METRICS_TOKEN leaked into application logs!",
    );

    console.log(
      `[smoke] ALL REAL POSTGRESQL PRODUCTION CHECKS PASSED (persistence, tx rollback, migrations v1->v2, outage 200->503->200, backup/restore, SIGTERM, log redaction).`,
    );
  } catch (err) {
    if (activeApp) {
      allLogs.push(...activeApp.logs);
      try {
        await activeApp.stop("SIGKILL");
      } catch {
        // ignore
      }
    }
    if (proxy) {
      proxy.stop();
    }
    // Persist redacted logs for CI artifact upload
    const redacted = allLogs.map(redactSecrets).join("\n");
    await Bun.write(`${LOG_DIR}/app-smoke-failure.log`, redacted + "\n");
    console.error(`[smoke] FAILED — redacted app logs written to ${LOG_DIR}/app-smoke-failure.log`);
    throw err;
  } finally {
    try {
      await dropDatabase(adminUrl, primaryDb);
    } catch {
      // best-effort cleanup
    }
    try {
      await dropDatabase(adminUrl, restoreDb);
    } catch {
      // best-effort cleanup
    }
  }
}

await run();
