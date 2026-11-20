import { describe, expect, it } from "bun:test";
import {
  isNotATransactionError,
  runStoreCli,
  type StoreCliIo,
  toBool,
  toInt,
  toJson,
  toText,
} from "../src/index";
import { StoreSchema as MySqlStoreSchema } from "../src/mysql/index";
import { StoreSchema as PgStoreSchema } from "../src/postgres/index";
import { cliErrorMessage } from "../src/cli/cli-error-message";
import { NOT_A_TRANSACTION, notATransaction } from "../src/sql/not-a-transaction";
import { parseDuration } from "../src/utils/duration.util";

function createTestIo(env: Record<string, string | undefined> = {}): {
  io: StoreCliIo;
  stdout: () => string;
  stderr: () => string;
} {
  let out = "";
  let err = "";
  return {
    io: {
      out: (text) => {
        out += text;
      },
      err: (text) => {
        err += text;
      },
      env,
    },
    stdout: () => out,
    stderr: () => err,
  };
}

const pgSchema = new PgStoreSchema({
  packageName: "@bunest/outbox",
  storeName: "PostgresOutboxStore",
  command: "nest-outbox",
  defaultSchema: "nest_outbox",
  migrations: [
    {
      version: 1,
      name: "initial",
      up: (s) => [
        `CREATE TABLE ${s}.messages (id text PRIMARY KEY, payload jsonb NOT NULL)`,
      ],
    },
    {
      version: 2,
      name: "add_index",
      up: (s) => [`CREATE INDEX messages_idx ON ${s}.messages (id)`],
    },
  ],
  createError: (msg) => new Error(msg),
});

const mysqlSchema = new MySqlStoreSchema({
  packageName: "@bunest/outbox",
  storeName: "MySqlOutboxStore",
  command: "nest-outbox",
  defaultSchema: "nest_outbox",
  migrations: [
    {
      version: 1,
      name: "initial",
      up: (t) => [
        `CREATE TABLE ${t("messages")} (id varchar(255) NOT NULL PRIMARY KEY, payload json NOT NULL)`,
      ],
    },
  ],
  createError: (msg) => new Error(msg),
});

describe("@bunest/store-kit root entry", () => {
  describe("column value converters", () => {
    it("converts text, int, bool, and json accurately", () => {
      expect(toText(null)).toBeNull();
      expect(toText(undefined)).toBeNull();
      expect(toText("hello")).toBe("hello");
      expect(toText(42)).toBe("42");

      expect(toInt(null)).toBeNull();
      expect(toInt(undefined)).toBeNull();
      expect(toInt("123")).toBe(123);
      expect(toInt(-99)).toBe(-99);

      expect(toBool(true)).toBe(true);
      expect(toBool(1)).toBe(true);
      expect(toBool("true")).toBe(true);
      expect(toBool("1")).toBe(true);
      expect(toBool(false)).toBe(false);
      expect(toBool(0)).toBe(false);
      expect(toBool("false")).toBe(false);
      expect(toBool("0")).toBe(false);
      expect(toBool(null)).toBe(false);
      expect(toBool(undefined)).toBe(false);

      expect(toJson(null)).toBeNull();
      expect(toJson(undefined)).toBeNull();
      expect(toJson('{"a":1,"b":[true,null]}')).toEqual({
        a: 1,
        b: [true, null],
      });
    });
  });

  describe("isNotATransactionError", () => {
    it("recognizes ERR_SQL_NOT_A_TRANSACTION errors across copies", () => {
      const err = notATransaction("not a tx");
      expect(err).toBeInstanceOf(TypeError);
      expect(err.code).toBe(NOT_A_TRANSACTION);
      expect(isNotATransactionError(err)).toBe(true);

      // Plain duck-typed error from another copy of the kit
      expect(
        isNotATransactionError({ code: "ERR_SQL_NOT_A_TRANSACTION" }),
      ).toBe(true);
      expect(isNotATransactionError(new TypeError("other"))).toBe(false);
      expect(isNotATransactionError(null)).toBe(false);
      expect(isNotATransactionError("ERR_SQL_NOT_A_TRANSACTION")).toBe(false);
    });
  });

  describe("parseDuration", () => {
    it("parses numbers and unit strings, rejecting invalid values", () => {
      expect(parseDuration(0)).toBe(0);
      expect(parseDuration(250)).toBe(250);
      expect(parseDuration("500ms")).toBe(500);
      expect(parseDuration("10s")).toBe(10_000);
      expect(parseDuration("1.5m")).toBe(90_000);
      expect(parseDuration("2h")).toBe(7_200_000);
      expect(parseDuration("3d")).toBe(259_200_000);
      expect(parseDuration("1w")).toBe(604_800_000);

      expect(() => parseDuration(-1)).toThrow(TypeError);
      expect(() => parseDuration(Number.NaN)).toThrow(TypeError);
      expect(() => parseDuration(Number.POSITIVE_INFINITY)).toThrow(TypeError);
      expect(() => parseDuration("invalid" as any)).toThrow(TypeError);
    });
  });

  describe("cliErrorMessage", () => {
    it("redacts passwords and handles AggregateError/cause/code", () => {
      const url = "postgres://admin:supersecret@db.internal:5432/prod";
      expect(
        cliErrorMessage(new Error(`failed to connect to ${url}`), url),
      ).toBe("failed to connect to postgres://admin:***@db.internal:5432/prod");

      const agg = new AggregateError(
        [new Error("ECONNREFUSED ::1"), new Error("ECONNREFUSED 127.0.0.1")],
        "",
      );
      expect(cliErrorMessage(agg)).toBe(
        "ECONNREFUSED ::1\nECONNREFUSED 127.0.0.1",
      );

      const nested = { cause: new Error("root cause") };
      expect(cliErrorMessage(nested)).toBe("root cause");

      const withCode = { code: "ECONNREFUSED", address: "127.0.0.1", port: 5432 };
      expect(cliErrorMessage(withCode)).toBe("ECONNREFUSED 127.0.0.1:5432");

      expect(cliErrorMessage({})).toBe(
        "The command failed with an error that has no message.",
      );
    });
  });

  describe("runStoreCli", () => {
    it("validates schemas argument", async () => {
      await expect(runStoreCli([], [])).rejects.toThrow(TypeError);
      await expect(runStoreCli([pgSchema, pgSchema], [])).rejects.toThrow(
        TypeError,
      );
    });

    it("prints help and handles missing/unknown commands", async () => {
      const h = createTestIo();
      expect(await runStoreCli([pgSchema, mysqlSchema], ["--help"], h.io)).toBe(
        0,
      );
      expect(h.stdout()).toContain("Usage: npx @bunest/outbox <command>");
      expect(h.stdout()).toContain("PostgresOutboxStore's schema");
      expect(h.stdout()).toContain("MySqlOutboxStore's");

      const empty = createTestIo();
      expect(await runStoreCli([pgSchema], [], empty.io)).toBe(1);
      expect(empty.stderr()).toContain("Usage: npx @bunest/outbox");

      const unknown = createTestIo();
      expect(await runStoreCli([pgSchema], ["drop"], unknown.io)).toBe(1);
      expect(unknown.stderr()).toContain('Unknown command "drop"');

      const badFlag = createTestIo();
      expect(await runStoreCli([pgSchema], ["--nope"], badFlag.io)).toBe(1);
      expect(badFlag.stderr()).toContain("Usage:");
    });

    it("prints migration SQL for postgres and mysql with options", async () => {
      const pgOut = createTestIo();
      expect(
        await runStoreCli(
          [pgSchema, mysqlSchema],
          ["sql", "--schema", "custom_outbox", "--from", "1", "--to", "2"],
          pgOut.io,
        ),
      ).toBe(0);
      expect(pgOut.stdout()).toContain('schema "custom_outbox", from version 1 to 2');
      expect(pgOut.stdout()).toContain('CREATE INDEX messages_idx ON "custom_outbox".messages');

      const myOut = createTestIo();
      expect(
        await runStoreCli(
          [pgSchema, mysqlSchema],
          ["sql", "--dialect", "mysql", "--statement-breakpoints"],
          myOut.io,
        ),
      ).toBe(0);
      expect(myOut.stdout()).toContain("--> statement-breakpoint");
      expect(myOut.stdout()).toContain("`nest_outbox_messages`");
    });

    it("validates sql flags and database URLs cleanly", async () => {
      const badFrom = createTestIo();
      expect(
        await runStoreCli([pgSchema], ["sql", "--from", "abc"], badFrom.io),
      ).toBe(1);
      expect(badFrom.stderr()).toContain('--from takes a version number');

      const badDialect = createTestIo();
      expect(
        await runStoreCli(
          [pgSchema],
          ["sql", "--dialect", "sqlite"],
          badDialect.io,
        ),
      ).toBe(1);
      expect(badDialect.stderr()).toContain("--dialect takes postgres or mysql");

      const unsupportedDialect = createTestIo();
      expect(
        await runStoreCli(
          [pgSchema],
          ["sql", "--dialect", "mysql"],
          unsupportedDialect.io,
        ),
      ).toBe(1);
      expect(unsupportedDialect.stderr()).toContain("MySQL isn't supported yet");

      const missingUrl = createTestIo();
      expect(await runStoreCli([pgSchema], ["status"], missingUrl.io)).toBe(1);
      expect(missingUrl.stderr()).toContain("pass --url, or set DATABASE_URL");

      const badUrl = createTestIo();
      expect(
        await runStoreCli(
          [pgSchema],
          ["migrate", "--url", "sqlite://test.db"],
          badUrl.io,
        ),
      ).toBe(1);
      expect(badUrl.stderr()).toContain("postgres:// or postgresql://");
    });
  });
});
