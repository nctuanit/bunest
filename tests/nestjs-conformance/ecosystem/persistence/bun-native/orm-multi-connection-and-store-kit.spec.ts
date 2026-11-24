import { afterEach, describe, expect, it } from "bun:test";
import { Injectable } from "../../../../../packages/core/src/common";
import {
  DataSource,
  DataSourceNotInitializedError,
  EntityManager,
  InjectDataSource,
  InjectEntityManager,
  InjectOrmMigrations,
  OrmMigrationRunner,
  OrmModule,
  type OrmQueryLogEvent,
} from "../../../../../packages/orm/src";
import {
  isNotATransactionError,
  toBool,
  toInt,
  toJson,
  toText,
} from "../../../../../packages/orm/src/store-kit/index";
import {
  SqlParams as MysqlSqlParams,
  columns as mysqlColumns,
  quoteIdentifier as mysqlQuoteIdentifier,
  quoteTable as mysqlQuoteTable,
} from "../../../../../packages/orm/src/store-kit/mysql/index";
import {
  SqlParams as PgSqlParams,
  columns as pgColumns,
  quoteSchema as pgQuoteSchema,
} from "../../../../../packages/orm/src/store-kit/postgres/index";
import { sqlExecutorContract } from "../../../../../packages/orm/src/store-kit/testing/index";
import { Test, describeConformance } from "../../../_helpers/index";

describeConformance(
  "Persistence (bun-native) - @bunest/orm multi-connection Bun.SQL, telemetry & Store Kit subpaths",
  {
    upstreamPath: "bun-native/sql-module-di-and-multi-connection",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002", "ADR-007"],
    notes:
      "Bun-native persistence conformance for @bunest/orm multi-connection DataSource/EntityManager/OrmMigrationRunner DI, Bun.SQL adapter, query logging telemetry, post-destroy guards, and @bunest/orm/{store,postgres,mysql,testing} subpaths.",
  },
  () => {
    const openSources: DataSource[] = [];

    const track = async (ds: DataSource): Promise<DataSource> => {
      await ds.initialize();
      openSources.push(ds);
      return ds;
    };

    afterEach(async () => {
      while (openSources.length > 0) {
        await openSources.pop()!.destroy();
      }
    });

    it("wires multiple named Bun.SQL & bun:sqlite connections without cross-contamination", async () => {
      @Injectable()
      class MultiDbConsumer {
        constructor(
          @InjectDataSource() readonly primary: DataSource,
          @InjectDataSource("analytics") readonly analytics: DataSource,
          @InjectEntityManager() readonly primaryEm: EntityManager,
          @InjectEntityManager("analytics") readonly analyticsEm: EntityManager,
          @InjectOrmMigrations() readonly primaryMigrations: OrmMigrationRunner,
          @InjectOrmMigrations("analytics")
          readonly analyticsMigrations: OrmMigrationRunner,
        ) {}
      }

      const mod = await Test.createTestingModule({
        imports: [
          OrmModule.forRoot({
            type: "sqlite",
            url: "sqlite://:memory:",
            useBunSql: true,
          }),
          OrmModule.forRoot({
            name: "analytics",
            type: "sqlite",
            database: ":memory:",
          }),
        ],
        providers: [MultiDbConsumer],
      }).compile({ logger: false });
      await mod.init();

      try {
        const c = mod.get(MultiDbConsumer);
        expect(c.primary.name).toBe("default");
        expect(c.analytics.name).toBe("analytics");
        expect(c.primary.driver.driverKind).toBe("bun-sql");
        expect(c.analytics.driver.driverKind).toBe("bun-sqlite");
        expect(c.primaryEm).toBe(c.primary.manager);
        expect(c.analyticsEm).toBe(c.analytics.manager);
        expect(c.primaryMigrations).not.toBe(c.analyticsMigrations);

        await c.primary.driver.execute(
          "CREATE TABLE primary_only (id INTEGER PRIMARY KEY)",
        );
        await expect(
          c.analytics.query("SELECT * FROM primary_only"),
        ).rejects.toThrow(/no such table/i);
      } finally {
        await mod.close();
      }
    });

    it("invokes logging telemetry callback with sql, params, durationMs, and error across queries", async () => {
      const events: OrmQueryLogEvent[] = [];
      const ds = await track(
        new DataSource({
          type: "sqlite",
          url: "sqlite://:memory:",
          useBunSql: true,
          logging: (e) => events.push(e),
        }),
      );

      await ds.driver.execute("CREATE TABLE t (id INTEGER PRIMARY KEY)");
      await ds.query("INSERT INTO t (id) VALUES (?)", [1]);
      await ds.query("SELECT COUNT(*) AS cnt FROM t");
      await expect(ds.query("SELECT * FROM nonexistent_tbl")).rejects.toThrow();

      expect(events.length).toBeGreaterThanOrEqual(4);
      const insertEvt = events.find((e) => e.sql.includes("INSERT INTO t"));
      expect(insertEvt?.params).toEqual([1]);
      expect(insertEvt?.durationMs).toBeGreaterThanOrEqual(0);
      const errEvt = events.find((e) => e.sql.includes("nonexistent_tbl"));
      expect(errEvt?.error).toBeInstanceOf(Error);
    });

    it("rejects operations cleanly with DataSourceNotInitializedError after destroy()", async () => {
      const ds = new DataSource({
        type: "sqlite",
        url: "sqlite://:memory:",
        useBunSql: true,
      });
      await ds.initialize();
      expect(ds.isInitialized).toBe(true);
      expect(await ds.ping()).toBe(true);

      await ds.destroy();
      await ds.destroy(); // idempotent

      expect(ds.isInitialized).toBe(false);
      expect(await ds.ping()).toBe(false);
      expect(() => ds.driver).toThrow(DataSourceNotInitializedError);
      expect(() => ds.manager).toThrow(DataSourceNotInitializedError);
      await expect(ds.query("SELECT 1")).rejects.toThrow(
        DataSourceNotInitializedError,
      );
    });

    describe("@bunest/orm Store Kit subpaths (./store, ./postgres, ./mysql, ./testing)", () => {
      it("coerces SQL row values accurately via toBool, toInt, toJson, toText & isNotATransactionError", () => {
        expect(toBool(1)).toBe(true);
        expect(toBool(0)).toBe(false);
        expect(toBool("true")).toBe(true);
        expect(toBool("false")).toBe(false);
        expect(toInt("42")).toBe(42);
        expect(toInt(42)).toBe(42);
        expect(toJson('{"a":1}')).toEqual({ a: 1 });
        expect(toText("hello")).toBe("hello");
        expect(toText(42)).toBe("42");
        expect(toText(null)).toBeNull();
        expect(
          isNotATransactionError({ code: "ERR_SQL_NOT_A_TRANSACTION" }),
        ).toBe(true);
        expect(isNotATransactionError(new Error("syntax error"))).toBe(false);
      });

      it("builds parameterized SQL and quotes identifiers cleanly across ./postgres and ./mysql helpers", () => {
        expect(pgQuoteSchema("app_schema", "Store")).toBe('"app_schema"');
        expect(pgColumns(["id", "created_at"])).toBe(
          "id::text AS id, created_at::text AS created_at",
        );
        expect(pgColumns(["id"], "t")).toBe("t.id::text AS id");
        const pgParams = new PgSqlParams();
        expect(pgParams.text("alice")).toBe("$1::text");
        expect(pgParams.int(42)).toBe("$2::text::integer");
        expect(pgParams.values).toEqual(["alice", "42"]);

        expect(mysqlQuoteIdentifier("order_id")).toBe("`order_id`");
        expect(mysqlQuoteTable("shop", "orders", "Store")).toBe(
          "`shop_orders`",
        );
        expect(mysqlColumns(["id"], "m")).toBe("CAST(`m`.`id` AS CHAR) AS `id`");
        const myParams = new MysqlSqlParams();
        expect(myParams.text("bob")).toBe("?");
        expect(myParams.int(99)).toBe("CAST(? AS SIGNED)");
        expect(myParams.values).toEqual(["bob", "99"]);

        expect(typeof sqlExecutorContract).toBe("function");
      });
    });
  },
);
