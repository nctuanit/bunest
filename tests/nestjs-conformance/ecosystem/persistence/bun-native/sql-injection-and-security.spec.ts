import { afterEach, describe, expect, it } from "bun:test";
import {
  Column,
  DataSource,
  Entity,
  PrimaryGeneratedColumn,
  assertSafeSqlIdentifier,
  escapeLikePattern,
  formatPlaceholder,
  formatTableRef,
  quoteIdentifier,
} from "../../../../../packages/orm/src";
import { describeConformance } from "../../../_helpers/index";

@Entity("sec_users")
class SecUser {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ unique: true })
  username!: string;

  @Column()
  bio!: string;
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
  "'; DROP TABLE sec_users; --",
  "' OR '1'='1",
  '" OR 1=1 --',
  "Robert'); DROP TABLE sec_users;--",
  "admin' UNION SELECT 1,2,3 --",
  "value\0with-null",
] as const;

describeConformance(
  "Persistence (bun-native) - @bunest/orm SQL injection, identifier validation & security guardrails",
  {
    upstreamPath: "bun-native/sql-injection-and-security",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002"],
    notes:
      "Verifies SQL identifier allowlisting, multi-dialect quoting, LIKE metacharacter escaping, and strict value parameterization across SqliteOrmDriver, BunSqlOrmDriver, and Repository<Entity>.",
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

    describe("assertSafeSqlIdentifier(), quoteIdentifier(), formatTableRef() & escapeLikePattern()", () => {
      it("accepts valid ASCII SQL identifiers and quotes them accurately per dialect", () => {
        for (const valid of ["users", "_internal", "Order_Items_2026", "A"]) {
          expect(assertSafeSqlIdentifier(valid)).toBe(valid);
          expect(quoteIdentifier(valid, "sqlite")).toBe(`"${valid}"`);
          expect(quoteIdentifier(valid, "postgres")).toBe(`"${valid}"`);
          expect(quoteIdentifier(valid, "mysql")).toBe(`\`${valid}\``);
          expect(quoteIdentifier(valid, "mariadb")).toBe(`\`${valid}\``);
          expect(quoteIdentifier(valid, "mssql")).toBe(`[${valid}]`);
        }

        expect(formatTableRef("users", "public", "postgres")).toBe(
          '"public"."users"',
        );
        expect(formatTableRef("users", "app", "mysql")).toBe("`app`.`users`");
        expect(formatPlaceholder(1, "postgres")).toBe("$1");
        expect(formatPlaceholder(2, "sqlite")).toBe("?");
        expect(formatPlaceholder(3, "mssql")).toBe("@p3");
        expect(formatPlaceholder(4, "oracle")).toBe(":4");
        expect(escapeLikePattern("100%_test!ok")).toBe("100!%!_test!!ok");
      });

      it.each(MALICIOUS_IDENTIFIERS)(
        "rejects unsafe identifier %p",
        (payload) => {
          expect(() => assertSafeSqlIdentifier(payload, "table name")).toThrow(
            /Invalid table name/,
          );
          expect(() =>
            quoteIdentifier(payload, "sqlite", "column name"),
          ).toThrow(/Invalid column name/);
          expect(() => formatTableRef(payload, undefined, "postgres")).toThrow(
            /Invalid table name/,
          );
        },
      );

      it("rejects malicious table or schema names during DataSource metadata compilation / schema build", async () => {
        @Entity("users; DROP TABLE users")
        class BadTableEntity {
          @PrimaryGeneratedColumn()
          id!: number;
        }

        const ds = new DataSource({
          type: "sqlite",
          database: ":memory:",
          entities: [BadTableEntity],
          synchronize: true,
        });
        await expect(ds.initialize()).rejects.toThrow(/Invalid/);
        await ds.destroy().catch(() => {});
      });
    });

    describe("strict value parameterization (SQL injection payloads stored literally)", () => {
      it("stores and queries injection payloads literally via Repository<SecUser> on SqliteOrmDriver", async () => {
        const ds = await track(
          new DataSource({
            type: "sqlite",
            database: ":memory:",
            entities: [SecUser],
            synchronize: true,
          }),
        );
        const repo = ds.getRepository(SecUser);

        for (let i = 0; i < SQL_INJECTION_VALUES.length; i++) {
          await repo.save({
            username: `user_${i}`,
            bio: SQL_INJECTION_VALUES[i]!,
          });
        }

        expect(await repo.count()).toBe(SQL_INJECTION_VALUES.length);

        const tautology = "' OR '1'='1";
        const found = await repo.findBy({ bio: tautology });
        expect(found).toHaveLength(1);
        expect(found[0]!.bio).toBe(tautology);

        const dropPayload = "'; DROP TABLE sec_users; --";
        await repo.update(found[0]!.id, { bio: dropPayload });
        expect(await repo.count()).toBe(SQL_INJECTION_VALUES.length);

        const deleted = await repo.delete({ bio: dropPayload });
        expect(deleted.affected).toBe(2);
        expect(await repo.count()).toBe(SQL_INJECTION_VALUES.length - 2);
      });

      it("stores and queries injection payloads literally via BunSqlOrmDriver parameterized queries", async () => {
        const ds = await track(
          new DataSource({
            type: "sqlite",
            url: "sqlite://:memory:",
            useBunSql: true,
            entities: [SecUser],
            synchronize: true,
          }),
        );
        const repo = ds.getRepository(SecUser);

        for (let i = 0; i < SQL_INJECTION_VALUES.length; i++) {
          await repo.save({
            username: `sql_u_${i}`,
            bio: SQL_INJECTION_VALUES[i]!,
          });
        }

        expect(await repo.count()).toBe(SQL_INJECTION_VALUES.length);

        const tautology = "' OR '1'='1";
        const rows = await ds.query<{ username: string; bio: string }>(
          'SELECT username, bio FROM "sec_users" WHERE bio = ?',
          [tautology],
        );
        expect(rows).toEqual([{ username: "sql_u_1", bio: tautology }]);
      });
    });
  },
);
