import "reflect-metadata";
import { Database } from "bun:sqlite";
import { expect, it } from "bun:test";
import { Injectable, Module } from "../../../../../packages/common/src";
import {
  DrizzleModule,
  InjectDrizzle,
  getDrizzleToken,
  type DrizzleClosableClient,
  type DrizzleDatabaseLike,
} from "../../../../../packages/sql/src";
import { Test, describeConformance } from "../../../_helpers/index";

interface SqliteExecDb extends DrizzleDatabaseLike {
  execute(sql: string): Promise<unknown[]>;
  readonly closed: boolean;
}

function createIsolatedSqliteDb(): {
  db: SqliteExecDb;
  client: DrizzleClosableClient;
} {
  const sqlite = new Database(":memory:");
  let isClosed = false;

  const client: DrizzleClosableClient = {
    close() {
      if (!isClosed) {
        isClosed = true;
        sqlite.close(true);
      }
    },
  };

  const db: SqliteExecDb = {
    get closed() {
      return isClosed;
    },
    async execute(sql: string): Promise<unknown[]> {
      const trimmed = sql.trimStart().toUpperCase();
      if (trimmed.startsWith("SELECT")) {
        return sqlite.prepare(sql).all();
      }
      sqlite.run(sql);
      return [];
    },
  };

  return { db, client };
}

@Injectable()
class ReportsService {
  constructor(
    @InjectDrizzle() readonly db: SqliteExecDb,
    @InjectDrizzle("analytics") readonly analyticsDb: SqliteExecDb,
  ) {}
}

describeConformance(
  "Persistence (drizzle) - multiple connections",
  {
    upstreamPath: "drizzle/tests/e2e/drizzle-multiple-connections.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002"],
    notes:
      "Adapts default + named ('analytics') DrizzleModule connections and DB isolation to @bunest/sql DrizzleModule backed by in-memory bun:sqlite.",
  },
  () => {
    it("should register each database under its own token and isolate schemas", async () => {
      const primary = createIsolatedSqliteDb();
      const analytics = createIsolatedSqliteDb();

      @Module({
        imports: [
          DrizzleModule.forRoot({ db: primary.db, client: primary.client }),
          DrizzleModule.forRootAsync({
            name: "analytics",
            useFactory: () => ({
              db: analytics.db,
              client: analytics.client,
            }),
          }),
        ],
        providers: [ReportsService],
      })
      class AppModule {}

      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile({ logger: false });
      await moduleRef.init();

      try {
        const { db, analyticsDb } = moduleRef.get(ReportsService);
        expect(db).toBe(moduleRef.get(getDrizzleToken()));
        expect(analyticsDb).toBe(moduleRef.get(getDrizzleToken("analytics")));
        expect(db).not.toBe(analyticsDb);

        await db.execute("CREATE TABLE only_in_default (id INTEGER)");
        await expect(
          analyticsDb.execute("SELECT * FROM only_in_default"),
        ).rejects.toThrow(/no such table/i);
      } finally {
        await moduleRef.close();
      }

      expect(primary.db.closed).toBe(true);
      expect(analytics.db.closed).toBe(true);
    });

    it("should register the same database twice under different names", async () => {
      const shared = createIsolatedSqliteDb();

      @Module({
        imports: [
          DrizzleModule.forRoot({ db: shared.db, client: shared.client }),
          DrizzleModule.forRoot({
            name: "analytics",
            db: shared.db,
            client: shared.client,
            autoClose: false,
          }),
        ],
      })
      class AppModule {}

      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile({ logger: false });
      await moduleRef.init();

      try {
        expect(moduleRef.get(getDrizzleToken())).toBe(shared.db);
        expect(moduleRef.get(getDrizzleToken("analytics"))).toBe(shared.db);
      } finally {
        await moduleRef.close();
      }

      expect(shared.db.closed).toBe(true);
    });
  },
);
