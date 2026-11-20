import "reflect-metadata";
import { afterEach, describe, expect, it } from "bun:test";
import { SqlMigrationRunner, SqlService } from "../../../../../packages/sql/src";
import {
  BaseSqliteRepository,
  SqliteEntity,
  SqliteMigrationRunner,
  SqliteService,
  assertSafeSqlIdentifier,
  quoteSqlIdentifier,
} from "../../../../../packages/sqlite/src";
import { describeConformance } from "../../../_helpers/index";

interface UserRow extends Record<string, unknown> {
  id: number;
  username: string;
  bio: string;
}

const MALICIOUS_IDENTIFIERS = [
  "users; DROP TABLE users; --",
  'users" OR 1=1 --',
  "users' OR '1'='1",
  "users--comment",
  "users/*block*/",
  "user name",
  "users\0hidden",
  "1leading_digit",
  "my-table",
  "",
  "   ",
  "schema.table",
] as const;

const SQL_INJECTION_VALUES = [
  "'; DROP TABLE users; --",
  "' OR '1'='1",
  '" OR 1=1 --',
  "Robert'); DROP TABLE users;--",
  "admin' UNION SELECT 1,2,3 --",
  "value\0with-null",
] as const;

describeConformance(
  "Persistence (bun-native) - SQL injection, identifier validation & security guardrails",
  {
    upstreamPath: "bun-native/sql-injection-and-security",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Verifies SQL identifier allowlisting, repository column/sort/pagination validation, strict value parameterization, PRAGMA sanitization, savepointName validation, and migrationsTable validation.",
  },
  () => {
    const openSqlite: SqliteService[] = [];
    const openSql: SqlService[] = [];

    const trackSqlite = (svc: SqliteService): SqliteService => {
      openSqlite.push(svc);
      return svc;
    };

    const trackSql = (svc: SqlService): SqlService => {
      openSql.push(svc);
      return svc;
    };

    afterEach(async () => {
      while (openSqlite.length > 0) {
        openSqlite.pop()!.close();
      }
      while (openSql.length > 0) {
        await openSql.pop()!.close();
      }
    });

    describe("assertSafeSqlIdentifier() & quoteSqlIdentifier()", () => {
      it("accepts valid ASCII SQL identifiers and wraps them in double quotes", () => {
        for (const valid of ["users", "_internal", "Order_Items_2026", "A"]) {
          expect(assertSafeSqlIdentifier(valid)).toBe(valid);
          expect(quoteSqlIdentifier(valid)).toBe(`"${valid}"`);
        }
      });

      it.each(MALICIOUS_IDENTIFIERS)(
        "rejects unsafe identifier %p",
        (payload) => {
          expect(() => assertSafeSqlIdentifier(payload, "table name")).toThrow(
            /Invalid table name/,
          );
          expect(() => quoteSqlIdentifier(payload, "column name")).toThrow(
            /Invalid column name/,
          );
        },
      );

      it("rejects malicious table or idColumn in @SqliteEntity() at decoration time", () => {
        expect(() => SqliteEntity("users; DROP TABLE users")).toThrow(
          /Invalid table name/,
        );
        expect(() => SqliteEntity("users", "id; --")).toThrow(
          /Invalid id column name/,
        );
      });
    });

    describe("BaseSqliteRepository identifier & query-shape validation", () => {
      const makeRepo = () => {
        const db = trackSqlite(new SqliteService({ filename: ":memory:" }));
        db.exec(
          "CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, bio TEXT NOT NULL)",
        );
        return {
          db,
          repo: new BaseSqliteRepository<UserRow, number>(db, "users"),
        };
      };

      it("rejects malicious tableName and idColumn in constructor", () => {
        const db = trackSqlite(new SqliteService({ filename: ":memory:" }));
        expect(
          () => new BaseSqliteRepository(db, "users; DROP TABLE users"),
        ).toThrow(/Invalid table name/);
        expect(
          () => new BaseSqliteRepository(db, "users", "id OR 1=1"),
        ).toThrow(/Invalid id column name/);
      });

      it("rejects malicious column names in select, where, insert, update, orderBy, and upsert", () => {
        const { repo } = makeRepo();

        expect(() =>
          repo.findAll({ select: ["username; DROP TABLE users" as any] }),
        ).toThrow(/Invalid select column/);

        expect(() =>
          repo.findWhere({ "username = 'a' OR 1=1 --": "x" } as any),
        ).toThrow(/Invalid column name/);

        expect(() =>
          repo.insert({ "username) VALUES ('x'); --": "x" } as any),
        ).toThrow(/Invalid column name/);

        expect(() =>
          repo.updateById(1, { "bio = 'pwned' WHERE 1=1 --": "x" } as any),
        ).toThrow(/Invalid column name/);

        expect(() =>
          repo.findAll({ orderBy: "id; DROP TABLE users" }),
        ).toThrow(/Invalid orderBy column/);

        expect(() =>
          repo.findAll({
            orderBy: [{ column: "id; --", order: "ASC" }],
          }),
        ).toThrow(/Invalid orderBy column/);

        expect(() =>
          repo.findAll({ orderBy: "id", order: "ASC; DROP TABLE users" as any }),
        ).toThrow(/Invalid sort direction/);

        expect(() =>
          repo.findAll({
            orderBy: [{ column: "id", order: "DESC; --" as any }],
          }),
        ).toThrow(/Invalid sort direction/);

        expect(() =>
          repo.upsert(
            { username: "alice", bio: "ok" },
            "username); DROP TABLE users; --" as any,
          ),
        ).toThrow(/Invalid conflict column/);

        expect(() =>
          repo.upsert(
            { username: "alice", bio: "ok" },
            "username",
            ["bio = 'x'; DROP TABLE users; --" as any],
          ),
        ).toThrow(/Invalid update column/);
      });

      it("rejects negative, fractional, NaN, and Infinity limit/offset values", () => {
        const { repo } = makeRepo();

        for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
          expect(() => repo.findAll({ limit: bad })).toThrow(/Invalid limit/);
          expect(() => repo.findAll({ offset: bad })).toThrow(/Invalid offset/);
        }
      });
    });

    describe("strict value parameterization (SQL injection payloads stored literally)", () => {
      it("stores and queries injection payloads literally via SqlService tagged templates and unsafe()", async () => {
        const svc = trackSql(new SqlService("sqlite://:memory:"));
        await svc.sql`
          CREATE TABLE users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            bio TEXT NOT NULL
          )
        `;

        for (let i = 0; i < SQL_INJECTION_VALUES.length; i++) {
          const payload = SQL_INJECTION_VALUES[i]!;
          await svc.sql`INSERT INTO users (username, bio) VALUES (${`u${i}`}, ${payload})`;
        }

        // Table must still exist with all rows intact
        expect(
          await svc.queryScalar<number>("SELECT COUNT(*) FROM users"),
        ).toBe(SQL_INJECTION_VALUES.length);

        // Parameterized lookup does not match all rows when querying "' OR '1'='1"
        const tautology = "' OR '1'='1";
        const taggedMatch = await svc.sql<{ username: string; bio: string }>`
          SELECT username, bio FROM users WHERE bio = ${tautology}
        `;
        expect([...taggedMatch]).toEqual([{ username: "u1", bio: tautology }]);

        const unsafeMatch = await svc.query<{ username: string; bio: string }>(
          "SELECT username, bio FROM users WHERE bio = ?",
          [tautology],
        );
        expect(unsafeMatch.rows).toEqual([{ username: "u1", bio: tautology }]);
      });

      it("stores and queries injection payloads literally via SqliteService and BaseSqliteRepository", () => {
        const db = trackSqlite(new SqliteService({ filename: ":memory:" }));
        db.exec(
          "CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, bio TEXT NOT NULL)",
        );
        const repo = new BaseSqliteRepository<UserRow, number>(db, "users");

        for (let i = 0; i < SQL_INJECTION_VALUES.length; i++) {
          repo.insert({
            username: `user_${i}`,
            bio: SQL_INJECTION_VALUES[i]!,
          });
        }

        expect(repo.count()).toBe(SQL_INJECTION_VALUES.length);

        const tautology = "' OR '1'='1";
        const found = repo.findWhere({ bio: tautology });
        expect(found).toHaveLength(1);
        expect(found[0]!.bio).toBe(tautology);

        // updateById & deleteWhere with injection values affect ONLY targeted row
        const dropPayload = "'; DROP TABLE users; --";
        repo.updateById(found[0]!.id, { bio: dropPayload });
        expect(repo.count()).toBe(SQL_INJECTION_VALUES.length);

        const deleted = repo.deleteWhere({ bio: dropPayload });
        expect(deleted.changes).toBe(2); // original u0 + updated u1
        expect(repo.count()).toBe(SQL_INJECTION_VALUES.length - 2);
      });
    });

    describe("PRAGMA, savepointName & migrationsTable injection defenses", () => {
      it("rejects malicious PRAGMA keys, string values, and non-finite numeric values on SqliteService", () => {
        expect(
          () =>
            new SqliteService({
              filename: ":memory:",
              pragmas: { "foreign_keys; DROP TABLE x": "ON" },
            }),
        ).toThrow(/Invalid PRAGMA name/);

        expect(
          () =>
            new SqliteService({
              filename: ":memory:",
              pragmas: { synchronous: "NORMAL; DROP TABLE x" },
            }),
        ).toThrow(/disallowed characters/);

        expect(
          () =>
            new SqliteService({
              filename: ":memory:",
              pragmas: { synchronous: "NORMAL -- comment" },
            }),
        ).toThrow(/disallowed characters/);

        expect(
          () =>
            new SqliteService({
              filename: ":memory:",
              pragmas: { cache_size: Number.NaN },
            }),
        ).toThrow(/must be finite/);

        expect(
          () =>
            new SqliteService({
              filename: ":memory:",
              pragmas: { cache_size: Number.POSITIVE_INFINITY },
            }),
        ).toThrow(/must be finite/);

        expect(
          () =>
            new SqliteService({
              filename: ":memory:",
              busyTimeout: Number.NaN,
            }),
        ).toThrow(/Invalid busyTimeout/);
      });

      it("rejects malicious savepointName payloads on both SqliteService and SqlService", async () => {
        const sqlite = trackSqlite(new SqliteService({ filename: ":memory:" }));
        await sqlite.transaction(async () => {
          for (const badSp of [
            "sp; DROP TABLE users; --",
            'sp"quote',
            "sp space",
            "1digit",
            "",
          ]) {
            await expect(
              sqlite.transaction(async () => {}, { savepointName: badSp }),
            ).rejects.toThrow(/Invalid savepoint name/);

            expect(() =>
              sqlite.transactionSync(() => {}, { savepointName: badSp }),
            ).toThrow(/Invalid savepoint name/);
          }
        });

        const sql = trackSql(new SqlService("sqlite://:memory:"));
        await sql.transaction(async () => {
          for (const badSp of [
            "sp; DROP TABLE users; --",
            'sp"quote',
            "sp space",
            "1digit",
            "",
          ]) {
            await expect(
              sql.transaction(async () => {}, { savepointName: badSp }),
            ).rejects.toThrow(/Invalid savepoint name/);
          }
        });
      });

      it("rejects malicious migrationsTable identifiers on both SqlMigrationRunner and SqliteMigrationRunner", () => {
        const sqlite = trackSqlite(new SqliteService({ filename: ":memory:" }));
        const sql = trackSql(new SqlService("sqlite://:memory:"));

        for (const badTable of [
          "_migs; DROP TABLE users; --",
          'bad"table',
          "bad table",
          "123migs",
          "",
        ]) {
          expect(() => new SqliteMigrationRunner(sqlite, [], badTable)).toThrow(
            /Invalid migrations table name/,
          );
          expect(() => new SqlMigrationRunner(sql, [], badTable)).toThrow(
            /Invalid migrations table name/,
          );
        }
      });
    });
  },
);
