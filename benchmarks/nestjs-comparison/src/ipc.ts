export interface ReadyPayload {
  readonly port: number;
  readonly pid: number;
  readonly idleRssBytes: number;
  readonly idleHeapUsedBytes: number;
  readonly cpuUserUs: number;
  readonly cpuSystemUs: number;
}

export interface MemPayload {
  readonly rssBytes: number;
  readonly heapUsedBytes: number;
  readonly cpuUserUs: number;
  readonly cpuSystemUs: number;
}

/**
 * Lightweight stdin/stdout IPC channel so the parent benchmark runner can:
 *  - Detect exact server readiness & ephemeral port
 *  - Query exact isolated server process RSS & CPU time without adding HTTP routes
 *  - Trigger graceful `app.close()` shutdown on demand
 */
export function attachIpcChannel(
  port: number,
  shutdown: () => Promise<void> | void,
): void {
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();
  const ready: ReadyPayload = {
    port,
    pid: process.pid,
    idleRssBytes: mem.rss,
    idleHeapUsedBytes: mem.heapUsed,
    cpuUserUs: cpu.user,
    cpuSystemUs: cpu.system,
  };

  process.stdout.write(`READY ${JSON.stringify(ready)}\n`);

  let buffer = "";
  let shuttingDown = false;

  const doShutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await shutdown();
    } catch {
      // ignore close errors during teardown
    }
    process.stdout.write("BYE\n");
    process.exit(0);
  };

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let nlIdx = buffer.indexOf("\n");
    while (nlIdx !== -1) {
      const cmd = buffer.slice(0, nlIdx).trim();
      buffer = buffer.slice(nlIdx + 1);
      if (cmd === "MEM") {
        const m = process.memoryUsage();
        const c = process.cpuUsage();
        const payload: MemPayload = {
          rssBytes: m.rss,
          heapUsedBytes: m.heapUsed,
          cpuUserUs: c.user,
          cpuSystemUs: c.system,
        };
        process.stdout.write(`MEM ${JSON.stringify(payload)}\n`);
      } else if (cmd === "SHUTDOWN") {
        void doShutdown();
      }
      nlIdx = buffer.indexOf("\n");
    }
  });

  process.stdin.on("end", () => {
    void doShutdown();
  });

  process.stdin.resume();

  process.on("SIGINT", () => void doShutdown());
  process.on("SIGTERM", () => void doShutdown());
}
