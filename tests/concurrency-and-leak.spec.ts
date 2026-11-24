import { afterEach, describe, expect, it } from "bun:test";
import {
  Body,
  BunestFactory,
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  Param,
  Post,
  REQUEST,
  Scope,
  ensureDir,
  join,
  removePath,
  type OnRequestDestroy,
} from "../packages/core/src";
import {
  EventEmitterModule,
  EventEmitterService,
  OnEvent,
} from "../packages/messaging/src/events";
import {
  MessagePattern,
  Payload,
  TcpClientProxy,
  TcpServer,
} from "../packages/microservices/src";
import {
  InjectQueue,
  Process,
  Processor,
  Queue,
  QueueModule,
} from "../packages/jobs/src/queues";
import {
  Cron,
  CronExpression,
  Interval,
  ScheduleModule,
  SchedulerRegistry,
} from "../packages/jobs/src/scheduler";
import { DataSource, OrmModule } from "../packages/orm/src";
import {
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketModule,
} from "../packages/core/src/ws";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    await removePath(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("High-Concurrency Stress & Multi-Subsystem Teardown Suite (Phase 6)", () => {
  it("isolates 100 concurrent mixed HTTP + Request-Scoped DI + SQLite transactions with zero state leaks", async () => {
    let destroyedContainers = 0;

    @Injectable({ scope: Scope.REQUEST })
    class RequestLedgerService implements OnRequestDestroy {
      readonly reqTag: string;

      constructor(
        @Inject(REQUEST) private readonly req: Request,
        private readonly db: DataSource,
      ) {
        this.reqTag = this.req.headers.get("x-req-tag") ?? "missing";
      }

      async recordEntry(
        key: string,
        amount: number,
        shouldFail: boolean,
      ): Promise<{ key: string; reqTag: string; committed: boolean }> {
        if (shouldFail) {
          try {
            await this.db.transaction(async (em) => {
              await em.query(
                "INSERT INTO ledger (entry_key, req_tag, amount) VALUES (?, ?, ?)",
                [key, this.reqTag, amount],
              );
              await Bun.sleep(1);
              throw new Error("intentional-rollback");
            });
          } catch {
            // Expected rollback
          }
          return { key, reqTag: this.reqTag, committed: false };
        }

        await this.db.transaction(async (em) => {
          await em.query(
            "INSERT INTO ledger (entry_key, req_tag, amount) VALUES (?, ?, ?)",
            [key, this.reqTag, amount],
          );
          await Bun.sleep(1);
        });
        return { key, reqTag: this.reqTag, committed: true };
      }

      async readEntry(key: string) {
        const rows = await this.db.query<{
          entry_key: string;
          req_tag: string;
          amount: number;
        }>(
          "SELECT entry_key, req_tag, amount FROM ledger WHERE entry_key = ?",
          [key],
        );
        return {
          reqTag: this.reqTag,
          row: rows[0] ?? null,
        };
      }

      onRequestDestroy(): void {
        destroyedContainers += 1;
      }
    }

    @Controller({ path: "/tx", scope: Scope.REQUEST })
    class LedgerController {
      constructor(private readonly ledger: RequestLedgerService) {}

      @Post()
      create(@Body() body: { key: string; amount: number; fail?: boolean }) {
        return this.ledger.recordEntry(
          body.key,
          body.amount,
          body.fail ?? false,
        );
      }

      @Get(":key")
      find(@Param("key") key: string) {
        return this.ledger.readEntry(key);
      }
    }

    @Module({
      imports: [
        OrmModule.forRoot({
          type: "sqlite",
          database: ":memory:",
          migrations: [
            {
              id: "001_ledger",
              async up(runner) {
                await runner.execute(`
                  CREATE TABLE ledger (
                    entry_key TEXT PRIMARY KEY,
                    req_tag TEXT NOT NULL,
                    amount INTEGER NOT NULL
                  );
                `);
              },
            },
          ],
          migrationsRun: true,
        }),
      ],
      controllers: [LedgerController],
      providers: [RequestLedgerService],
    })
    class ConcurrencyAppModule {}

    const app = await BunestFactory.create(ConcurrencyAppModule, {
      logger: false,
    });
    const info = await app.listen({ hostname: "127.0.0.1", port: 0 });

    try {
      // Launch 100 concurrent mixed requests: 60 committing POSTs, 20 rolling-back POSTs, 20 GETs
      const tasks = Array.from({ length: 100 }, async (_, idx) => {
        const tag = `tag_${idx}`;
        if (idx < 80) {
          const shouldFail = idx % 4 === 3; // 20 rollbacks, 60 commits
          const key = `k_${idx}`;
          const res = await fetch(`${info.url}/tx`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-req-tag": tag,
            },
            body: JSON.stringify({ key, amount: idx * 10, fail: shouldFail }),
          });
          expect(res.status).toBe(201);
          const data = (await res.json()) as {
            key: string;
            reqTag: string;
            committed: boolean;
          };
          expect(data).toEqual({ key, reqTag: tag, committed: !shouldFail });
        } else {
          const res = await fetch(`${info.url}/tx/k_0`, {
            headers: { "x-req-tag": tag },
          });
          expect(res.status).toBe(200);
          const data = (await res.json()) as { reqTag: string };
          expect(data.reqTag).toBe(tag);
        }
      });

      await Promise.all(tasks);

      const db = app.get(DataSource);
      const countRows = await db.query<{ total: number }>(
        "SELECT COUNT(*) as total FROM ledger",
      );
      expect(countRows[0]?.total).toBe(60);

      // Verify every single committed row matches its exact request tag
      const rows = await db.query<{
        entry_key: string;
        req_tag: string;
        amount: number;
      }>("SELECT entry_key, req_tag, amount FROM ledger");
      for (const row of rows) {
        const idx = Number.parseInt(row.entry_key.slice(2), 10);
        expect(row.req_tag).toBe(`tag_${idx}`);
        expect(row.amount).toBe(idx * 10);
        expect(idx % 4).not.toBe(3);
      }

      // Every single one of the 100 request containers was destroyed cleanly
      expect(destroyedContainers).toBe(100);
    } finally {
      await app.close();
    }
  });

  it("tears down ALL 7 subsystems cleanly (HTTP + SQLite WAL + Scheduler + Queue + EventEmitter + TCP Microservice + WebSocket)", async () => {
    const dir = join(
      Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp",
      `bunest-teardown-${crypto.randomUUID()}`,
    );
    await ensureDir(dir);
    tempDirs.push(dir);
    const dbPath = join(dir, "teardown.sqlite");

    let intervalTicks = 0;
    const processedJobs: string[] = [];
    const receivedEvents: string[] = [];

    @Injectable()
    class SubsystemWorker {
      @Interval("teardown-heartbeat", 20)
      onTick() {
        intervalTicks += 1;
      }

      @Cron(CronExpression.EVERY_MINUTE, { name: "teardown-cron" })
      onMinute() {
        intervalTicks += 1;
      }

      @OnEvent("subsystem.ping")
      onPing(payload: string) {
        receivedEvents.push(payload);
      }
    }

    @Processor("tasks")
    class TasksProcessor {
      @Process()
      async handle(job: { data: { label: string } }) {
        processedJobs.push(job.data.label);
        return { done: job.data.label };
      }
    }

    @WebSocketGateway("/ws")
    class LiveGateway {
      @SubscribeMessage("echo")
      onEcho(@MessageBody() data: { msg: string }) {
        return { event: "echoed", data };
      }
    }

    @Controller("/full")
    class FullController {
      constructor(
        private readonly db: DataSource,
        private readonly events: EventEmitterService,
        @InjectQueue("tasks") private readonly queue: Queue<{ label: string }>,
      ) {}

      @Get("status")
      async status() {
        const ok = await this.db.ping();
        this.events.emit("subsystem.ping", "from-http");
        const job = await this.queue.add("run", { label: "job-1" });
        return { dbOk: ok, jobId: job.id };
      }
    }

    @Controller()
    class TcpMathHandler {
      @MessagePattern("math.double")
      double(@Payload() n: number): number {
        return n * 2;
      }
    }

    @Module({
      imports: [
        OrmModule.forRoot({
          type: "sqlite",
          database: dbPath,
          enableWAL: true,
        }),
        EventEmitterModule.forRoot({ global: true }),
        ScheduleModule.forRoot({ global: true }),
        QueueModule.forRoot({ global: true }),
        QueueModule.registerQueue({ name: "tasks", concurrency: 2 }),
        WebSocketModule.forRoot(),
      ],
      controllers: [FullController],
      providers: [SubsystemWorker, TasksProcessor, LiveGateway],
    })
    class FullStackAppModule {}

    const app = await BunestFactory.create(FullStackAppModule, {
      logger: false,
    });
    await WebSocketModule.attach(app);
    const httpInfo = await app.listen({ hostname: "127.0.0.1", port: 0 });
    const baseUrl = httpInfo.url.replace(/\/$/, "");

    // Also spin up a live TCP Microservice on an ephemeral port
    const tcpServer = new TcpServer({ host: "127.0.0.1", port: 0 });
    const handlerInstance = new TcpMathHandler();
    tcpServer.addMessageHandler("math.double", (data: unknown) =>
      handlerInstance.double(data as number),
    );
    await tcpServer.listen();
    const tcpClient = new TcpClientProxy({
      host: "127.0.0.1",
      port: tcpServer.port,
    });

    // Connect a real live WebSocket client
    const wsUrl = baseUrl.replace(/^http/, "ws") + "/ws";
    const ws = new WebSocket(wsUrl);
    let wsClosed = false;
    const wsOpened = new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", (e) => reject(e));
    });
    const wsClosePromise = new Promise<void>((resolve) => {
      ws.addEventListener("close", () => {
        wsClosed = true;
        resolve();
      });
    });

    try {
      await wsOpened;

      // 1. Exercise HTTP + SQLite + EventEmitter + Queue
      const res = await fetch(`${baseUrl}/full/status`);
      expect(res.status).toBe(200);
      const statusData = (await res.json()) as { dbOk: boolean; jobId: string };
      expect(statusData.dbOk).toBe(true);
      expect(receivedEvents).toEqual(["from-http"]);

      // 2. Exercise WebSocket round-trip
      const wsReply = await new Promise<string>((resolve) => {
        ws.addEventListener("message", (ev) => resolve(String(ev.data)), {
          once: true,
        });
        ws.send(JSON.stringify({ event: "echo", data: { msg: "alive" } }));
      });
      expect(JSON.parse(wsReply)).toEqual({
        event: "echoed",
        data: { msg: "alive" },
      });

      // 3. Exercise TCP Microservice RPC round-trip
      const doubled = await tcpClient.send<number, number>("math.double", 21);
      expect(doubled).toBe(42);

      // Wait briefly for scheduler + queue to fire at least once
      await Bun.sleep(60);
      expect(intervalTicks).toBeGreaterThanOrEqual(1);
      expect(processedJobs).toEqual(["job-1"]);

      const emitter = app.get(EventEmitterService);
      const scheduler = app.get(SchedulerRegistry);
      expect(emitter.listenerCount("subsystem.ping")).toBe(1);
      expect(scheduler.getIntervals()).toContain("teardown-heartbeat");

      // 4. Measure graceful shutdown across ALL subsystems
      const shutdownStart = performance.now();
      await Promise.all([app.close(), tcpClient.close(), tcpServer.close()]);
      await Promise.race([wsClosePromise, Bun.sleep(500)]);
      const shutdownMs = performance.now() - shutdownStart;

      expect(shutdownMs).toBeLessThan(2000);
      expect(app.getUrl()).toBeUndefined();
      expect(wsClosed).toBe(true);
      expect(emitter.listenerCount("subsystem.ping")).toBe(0);
      expect(scheduler.getIntervals()).toEqual([]);
      expect(scheduler.getCronJobs().size).toBe(0);

      // Verify zero ticks fire after close
      const ticksAtClose = intervalTicks;
      await Bun.sleep(70);
      expect(intervalTicks).toBe(ticksAtClose);

      // Verify Windows SQLite file handle was cleanly released (delete succeeds without EBUSY!)
      await Bun.file(dbPath).delete();
    } finally {
      if (
        ws.readyState === WebSocket.OPEN ||
        ws.readyState === WebSocket.CONNECTING
      ) {
        ws.close();
      }
      await app.close().catch(() => {});
      await tcpClient.close().catch(() => {});
      await tcpServer.close().catch(() => {});
    }
  });
});
