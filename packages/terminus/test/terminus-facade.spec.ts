import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import { Controller, Get, Injectable, Module } from "@bunest/common";
import { BunestFactory } from "@bunest/core";
import { Test } from "@bunest/testing";
import {
  DatabaseNotConnectedError,
  DiskHealthIndicator,
  FetchHealthIndicator,
  GRPCHealthIndicator,
  HealthCheck,
  HealthCheckAttempt,
  HealthCheckError,
  HealthCheckService,
  HealthCheckStatus,
  HealthIndicator,
  HealthIndicatorService,
  HealthIndicatorSession,
  HealthIndicatorStatus,
  HttpHealthIndicator,
  MemoryHealthIndicator,
  MicroserviceHealthIndicator,
  MikroOrmHealthIndicator,
  MongooseHealthIndicator,
  PrismaHealthIndicator,
  SequelizeHealthIndicator,
  TerminusModule,
  TypeOrmHealthIndicator,
  toBytes,
  toMs,
  type MikroOrmPingCheckSettings,
  type MongoosePingCheckSettings,
  type SequelizePingCheckSettings,
  type TerminusAsyncModuleOptions,
  type TerminusOptionsFactory,
  type TypeOrmPingCheckSettings,
} from "../src";

describe("@bunest/terminus drop-in facade (@nestjs/terminus@12.2.0 43/43 parity)", () => {
  it("exports all 19 @nestjs/terminus@12.2.0 runtime values", () => {
    expect(DiskHealthIndicator).toBeDefined();
    expect(FetchHealthIndicator).toBeDefined();
    expect(GRPCHealthIndicator).toBeDefined();
    expect(typeof HealthCheck).toBe("function");
    expect(HealthCheckAttempt).toBeDefined();
    expect(HealthCheckService).toBeDefined();
    expect(HealthCheckStatus.OK).toBe("ok");
    expect(HealthIndicatorService).toBeDefined();
    expect(HealthIndicatorSession).toBeDefined();
    expect(HealthIndicatorStatus.UP).toBe("up");
    expect(HttpHealthIndicator).toBeDefined();
    expect(MemoryHealthIndicator).toBeDefined();
    expect(MicroserviceHealthIndicator).toBeDefined();
    expect(MikroOrmHealthIndicator).toBeDefined();
    expect(MongooseHealthIndicator).toBeDefined();
    expect(PrismaHealthIndicator).toBeDefined();
    expect(SequelizeHealthIndicator).toBeDefined();
    expect(TerminusModule).toBeDefined();
    expect(TypeOrmHealthIndicator).toBeDefined();

    // Bonus helpers
    expect(HealthIndicator).toBeDefined();
    expect(HealthCheckError).toBeDefined();
    expect(DatabaseNotConnectedError).toBeDefined();
    expect(toMs("2s")).toBe(2000);
    expect(toBytes("1mb")).toBe(1024 * 1024);
  });

  it("supports TypeOrmHealthIndicator across SQL, Oracle, SAP, MongoDB, uninitialized, and error codes", async () => {
    const indicator = new TypeOrmHealthIndicator();
    await indicator.onModuleInit();

    const executedQueries: string[] = [];

    // Default SQL (postgres/sqlite/mysql)
    const sqlOpts: TypeOrmPingCheckSettings = {
      connection: {
        options: { type: "postgres" },
        isInitialized: true,
        query: async (sql: string) => {
          executedQueries.push(sql);
          return [{ "?column?": 1 }];
        },
      },
    };
    const sqlRes = await indicator.pingCheck("pg", sqlOpts);
    expect(sqlRes.pg.status).toBe("up");
    expect(executedQueries[0]).toBe("SELECT 1");

    // Oracle
    const oracleRes = await indicator.pingCheck("oracle", {
      connection: {
        options: { type: "oracle" },
        query: async (sql: string) => {
          executedQueries.push(sql);
          return [1];
        },
      },
    });
    expect(oracleRes.oracle.status).toBe("up");
    expect(executedQueries[1]).toBe("SELECT 1 FROM DUAL");

    // SAP
    const sapRes = await indicator.pingCheck("sap", {
      connection: {
        options: { type: "sap" },
        query: async (sql: string) => {
          executedQueries.push(sql);
          return [1];
        },
      },
    });
    expect(sapRes.sap.status).toBe("up");
    expect(executedQueries[2]).toBe("SELECT now() FROM dummy");

    // MongoDB
    let mongoPinged = false;
    const mongoRes = await indicator.pingCheck("mongo", {
      connection: {
        options: { type: "mongodb" },
        driver: {
          queryRunner: {
            databaseConnection: {
              db: () => ({
                command: async (cmd: Record<string, unknown>) => {
                  mongoPinged = cmd.ping === 1;
                  return { ok: 1 };
                },
              }),
            },
          },
        },
      },
    });
    expect(mongoRes.mongo.status).toBe("up");
    expect(mongoPinged).toBe(true);

    // Uninitialized connection -> down
    const uninitRes = await indicator.pingCheck("uninit", {
      connection: { isInitialized: false, query: async () => [] },
    });
    expect(uninitRes.uninit.status).toBe("down");

    // Query failure preserves driver error code
    const errRes = await indicator.pingCheck("broken", {
      connection: {
        options: { type: "postgres" },
        query: async () => {
          throw Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
        },
      },
    });
    expect(errRes.broken.status).toBe("down");
    expect(errRes.broken.code).toBe("ECONNREFUSED");

    // Missing connection in context -> down
    const missingRes = await indicator.pingCheck("missing");
    expect(missingRes.missing.status).toBe("down");
    expect(missingRes.missing.message).toContain("Connection provider not found");
  });

  it("supports MongooseHealthIndicator, SequelizeHealthIndicator, and MikroOrmHealthIndicator", async () => {
    // 1. MongooseHealthIndicator
    const mongooseInd = new MongooseHealthIndicator();
    await mongooseInd.onModuleInit();

    const mongooseOpts: MongoosePingCheckSettings = {
      connection: {
        readyState: 1,
        db: { command: async () => ({ ok: 1 }) },
      },
    };
    const mUp = await mongooseInd.pingCheck("mongodb", mongooseOpts);
    expect(mUp.mongodb.status).toBe("up");

    const mDown = await mongooseInd.pingCheck("mongodb_down", {
      connection: { readyState: 0 },
    });
    expect(mDown.mongodb_down.status).toBe("down");
    expect(mDown.mongodb_down.message).toContain("Database is not connected");

    // 2. SequelizeHealthIndicator
    const seqInd = new SequelizeHealthIndicator();
    await seqInd.onModuleInit();

    const seqOpts: SequelizePingCheckSettings = {
      connection: { query: async (sql: string) => (sql === "SELECT 1" ? [1] : []) },
    };
    const sUp = await seqInd.pingCheck("seq_sql", seqOpts);
    expect(sUp.seq_sql.status).toBe("up");

    const sAuthUp = await seqInd.pingCheck("seq_auth", {
      connection: { authenticate: async () => undefined },
    });
    expect(sAuthUp.seq_auth.status).toBe("up");

    const sErr = await seqInd.pingCheck("seq_err", {
      connection: {
        query: async () => {
          throw Object.assign(new Error("Access denied"), {
            parent: { code: "ER_ACCESS_DENIED_ERROR" },
          });
        },
      },
    });
    expect(sErr.seq_err.status).toBe("down");
    expect(sErr.seq_err.code).toBe("ER_ACCESS_DENIED_ERROR");

    // 3. MikroOrmHealthIndicator
    const mikroInd = new MikroOrmHealthIndicator();
    await mikroInd.onModuleInit();

    const mikroOpts: MikroOrmPingCheckSettings = {
      connection: { isConnected: async () => true },
    };
    const mkUp = await mikroInd.pingCheck("mikro_direct", mikroOpts);
    expect(mkUp.mikro_direct.status).toBe("up");

    const mkOrmUp = await mikroInd.pingCheck("mikro_orm", {
      connection: { em: { getConnection: () => ({ isConnected: async () => true }) } },
    });
    expect(mkOrmUp.mikro_orm.status).toBe("up");

    const mkDown = await mikroInd.pingCheck("mikro_down", {
      connection: { isConnected: async () => false },
    });
    expect(mkDown.mikro_down.status).toBe("down");
  });

  it("registers TerminusModule, TerminusModule.forRoot(), and forRootAsync() with DI resolution for all built-in + ORM indicators", async () => {
    // 1. Plain TerminusModule import + context connection resolution via ModuleRef
    const plainMod = await Test.createTestingModule({
      imports: [TerminusModule],
      providers: [
        {
          provide: "DataSource",
          useValue: { options: { type: "sqlite" }, query: async () => [1] },
        },
        {
          provide: "DatabaseConnection",
          useValue: { readyState: 1, db: { command: async () => ({ ok: 1 }) } },
        },
        {
          provide: "Sequelize",
          useValue: { query: async () => [1] },
        },
        {
          provide: "MikroORM",
          useValue: { em: { getConnection: () => ({ isConnected: async () => true }) } },
        },
      ],
    }).compile();

    try {
      const health = plainMod.get(HealthCheckService);
      const typeorm = await plainMod.resolve(TypeOrmHealthIndicator);
      const mongoose = await plainMod.resolve(MongooseHealthIndicator);
      const sequelize = await plainMod.resolve(SequelizeHealthIndicator);
      const mikro = await plainMod.resolve(MikroOrmHealthIndicator);
      const memory = plainMod.get(MemoryHealthIndicator);

      const result = await health.check([
        () => typeorm.pingCheck("typeorm"),
        () => mongoose.pingCheck("mongoose"),
        () => sequelize.pingCheck("sequelize"),
        () => mikro.pingCheck("mikro"),
        () => memory.checkHeap("heap", "16gb"),
      ]);

      expect(result.status).toBe("ok");
      expect(result.details.typeorm.status).toBe("up");
      expect(result.details.mongoose.status).toBe("up");
      expect(result.details.sequelize.status).toBe("up");
      expect(result.details.mikro.status).toBe("up");
      expect(result.details.heap.status).toBe("up");
    } finally {
      await plainMod.close();
    }

    // 2. TerminusModule.forRoot() + @HealthCheck() HTTP route
    @Controller("/health")
    class HealthController {
      constructor(
        private readonly health: HealthCheckService,
        private readonly typeorm: TypeOrmHealthIndicator,
      ) {}

      @Get()
      @HealthCheck()
      check() {
        return this.health.check([
          () =>
            this.typeorm.pingCheck("db", {
              connection: { query: async () => [1] },
            }),
        ]);
      }
    }

    @Module({
      imports: [TerminusModule.forRoot({ logger: false })],
      controllers: [HealthController],
    })
    class SyncApp {}

    const syncApp = await BunestFactory.create(SyncApp, { logger: false });
    try {
      const res = await syncApp.fetch(new Request("http://localhost/health"));
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe(
        "no-cache, no-store, must-revalidate",
      );
      const body = (await res.json()) as { status: string; details: { db: { status: string } } };
      expect(body.status).toBe("ok");
      expect(body.details.db.status).toBe("up");
    } finally {
      await syncApp.close();
    }

    // 3. TerminusModule.forRootAsync()
    @Injectable()
    class TerminusFactory implements TerminusOptionsFactory {
      createTerminusOptions(): TerminusAsyncModuleOptions {
        return { logger: false, errorLogStyle: "json" };
      }
    }

    @Module({
      imports: [TerminusModule.forRootAsync({ useClass: TerminusFactory })],
    })
    class AsyncApp {}

    const asyncApp = await BunestFactory.create(AsyncApp, { logger: false });
    try {
      expect(asyncApp.get(HealthCheckService)).toBeInstanceOf(HealthCheckService);
      expect(asyncApp.get(FetchHealthIndicator)).toBeInstanceOf(FetchHealthIndicator);
      expect(await asyncApp.resolve(TypeOrmHealthIndicator)).toBeInstanceOf(
        TypeOrmHealthIndicator,
      );
      expect(await asyncApp.resolve(MongooseHealthIndicator)).toBeInstanceOf(
        MongooseHealthIndicator,
      );
      expect(await asyncApp.resolve(SequelizeHealthIndicator)).toBeInstanceOf(
        SequelizeHealthIndicator,
      );
      expect(await asyncApp.resolve(MikroOrmHealthIndicator)).toBeInstanceOf(
        MikroOrmHealthIndicator,
      );
    } finally {
      await asyncApp.close();
    }
  });
});
