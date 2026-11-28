import { describe, expect, it } from "bun:test";
import { BunestFactory, Controller, Get, Module } from "@bunest/core";
import {
  Column,
  DataSource,
  Entity,
  In,
  OrmError,
  OrmModule,
  OrmNPlusOneError,
  PrimaryGeneratedColumn,
  createNPlusOneDetector,
  emitOrmQueryDiagnostic,
  getOrmDataSourceToken,
  normalizeSqlFingerprint,
  withNPlusOneDetection,
  type NPlusOneDetectionEvent,
} from "../src/index";

@Entity("n1_users")
class N1User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar" })
  name!: string;
}

describe("ORM Runtime N+1 Query Detector", () => {
  it("normalizes SQL literals, placeholders, and IN lists into stable fingerprints", () => {
    const fp1 = normalizeSqlFingerprint(
      `SELECT "id", "name" FROM "users" WHERE "id" = 1`,
    );
    const fp2 = normalizeSqlFingerprint(
      `SELECT "id", "name" FROM "users" WHERE "id" = 99`,
    );
    expect(fp1).toBe(fp2);

    const pg1 = normalizeSqlFingerprint(
      `SELECT * FROM "users" WHERE "email" = $1 AND "id" IN ($2, $3, $4)`,
    );
    const pg2 = normalizeSqlFingerprint(
      `SELECT * FROM "users" WHERE "email" = 'a@b.com' AND "id" IN (?)`,
    );
    expect(pg1).toBe(pg2);
  });

  it("detects N+1 queries in a loop with withNPlusOneDetection() and stays silent for batched In([...]) queries", async () => {
    const ds = new DataSource({
      type: "sqlite",
      database: ":memory:",
      entities: [N1User],
      synchronize: true,
    });
    await ds.initialize();

    try {
      const repo = ds.getRepository(N1User);
      const inserted: N1User[] = [];
      for (let i = 1; i <= 6; i++) {
        inserted.push(await repo.save({ name: `User ${i}` }));
      }

      // 1. Non-strict mode records N+1 detection
      const { detections } = await withNPlusOneDetection(
        async () => {
          for (const u of inserted) {
            await repo.findOneBy({ id: u.id });
          }
        },
        { threshold: 5, strict: false, onDetect: () => {} },
      );
      expect(detections).toHaveLength(1);
      expect(detections[0]!.count).toBe(5);
      expect(detections[0]!.fingerprint).toContain("n1_users");

      // 2. Strict mode throws OrmNPlusOneError
      await expect(
        withNPlusOneDetection(
          async () => {
            for (const u of inserted) {
              await repo.findOneBy({ id: u.id });
            }
          },
          { threshold: 4, strict: true },
        ),
      ).rejects.toBeInstanceOf(OrmNPlusOneError);

      // 3. Batched query via In([...]) triggers ZERO detections
      const batched = await withNPlusOneDetection(
        async () => {
          return await repo.findBy({ id: In(inserted.map((u) => u.id)) });
        },
        { threshold: 2, strict: true },
      );
      expect(batched.result).toHaveLength(6);
      expect(batched.detections).toHaveLength(0);
    } finally {
      await ds.destroy();
    }
  });

  it("wires detectNPlusOne option directly on DataSource and unsubscribes cleanly on destroy()", async () => {
    const seen: NPlusOneDetectionEvent[] = [];
    const ds = new DataSource({
      type: "sqlite",
      database: ":memory:",
      entities: [N1User],
      synchronize: true,
      detectNPlusOne: {
        threshold: 3,
        onDetect: (ev) => seen.push(ev),
      },
    });
    await ds.initialize();

    try {
      const repo = ds.getRepository(N1User);
      const u = await repo.save({ name: "Alice" });
      await repo.findOneBy({ id: u.id });
      await repo.findOneBy({ id: u.id });
      await repo.findOneBy({ id: u.id });

      expect(seen).toHaveLength(1);
      expect(seen[0]!.count).toBe(3);
    } finally {
      await ds.destroy();
    }
  });

  it("throws unwrapped OrmNPlusOneError (not QueryFailedError) when strict: true is set directly on DataSource", async () => {
    const loggedErrors: Error[] = [];
    const ds = new DataSource({
      type: "sqlite",
      database: ":memory:",
      entities: [N1User],
      synchronize: true,
      logging: (ev) => {
        if (ev.error) loggedErrors.push(ev.error);
      },
      detectNPlusOne: {
        threshold: 3,
        strict: true,
      },
    });
    await ds.initialize();

    try {
      const repo = ds.getRepository(N1User);
      const u = await repo.save({ name: "StrictUser" });
      await repo.findOneBy({ id: u.id });
      await repo.findOneBy({ id: u.id });

      let caught: unknown;
      try {
        await repo.findOneBy({ id: u.id });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(OrmNPlusOneError);
      expect(caught).toBeInstanceOf(OrmError);
      expect((caught as OrmNPlusOneError).count).toBe(3);
      // Must NOT emit a spurious error telemetry event for the succeeded query
      expect(loggedErrors).toHaveLength(0);
    } finally {
      await ds.destroy();
    }
  });

  it("normalizes SQL comments, negative numbers, escaped quotes, UUIDs, Postgres $10, SQLite ?1, and IN lists", () => {
    // Comments stripped before whitespace collapsing (including per-request trace comments)
    const c1 = normalizeSqlFingerprint(
      `/* traceparent=00-abc-123 */ SELECT * FROM "n1_users" -- req_id=1\nWHERE "id" = 1`,
    );
    const c2 = normalizeSqlFingerprint(
      `/* traceparent=00-def-456 */ SELECT * FROM "n1_users" -- req_id=2\nWHERE "id" = 999`,
    );
    expect(c1).toBe(c2);
    expect(c1).toBe(`SELECT * FROM "n1_users" WHERE "id" = ?`);

    // Comment markers inside string literals are NOT treated as comments
    const strWithComment = normalizeSqlFingerprint(
      `SELECT * FROM "links" WHERE "url" = 'https://a.com/*x*/--y' AND "id" = 5`,
    );
    expect(strWithComment).toBe(
      `SELECT * FROM "links" WHERE "url" = ? AND "id" = ?`,
    );

    // Negative numbers & decimals & IN lists with negatives
    const neg1 = normalizeSqlFingerprint(
      `SELECT * FROM "ledger" WHERE "delta" = -42.5 AND "code" IN (-1, 2, -3)`,
    );
    const neg2 = normalizeSqlFingerprint(
      `SELECT * FROM "ledger" WHERE "delta" = 100 AND "code" IN (9)`,
    );
    expect(neg1).toBe(neg2);

    // Escaped quotes (SQL '' and MySQL \') + UUIDs + Postgres $10 + SQLite ?1
    const q1 = normalizeSqlFingerprint(
      `SELECT * FROM "users" WHERE "name" = 'O''Brien' AND "uuid" = '550e8400-e29b-41d4-a716-446655440000' AND "id" = $10`,
    );
    const q2 = normalizeSqlFingerprint(
      `SELECT * FROM "users" WHERE "name" = 'O\\'Malley' AND "uuid" = ?1 AND "id" = ?2`,
    );
    expect(q1).toBe(q2);
  });

  it("enforces dataSourceName filtering, stateless ignorePatterns (/g), maxDetections cap, and concurrent RequestContext isolation", async () => {
    const seen: NPlusOneDetectionEvent[] = [];
    const detector = createNPlusOneDetector({
      threshold: 2,
      dataSourceName: "primary",
      ignorePatterns: [/audit_logs/gi],
      maxDetections: 2,
      onDetect: (ev) => seen.push(ev),
    });

    try {
      // Other dataSource AND undefined dataSource must both be ignored
      for (let i = 0; i < 4; i++) {
        emitOrmQueryDiagnostic({
          sql: `SELECT * FROM "other" WHERE id = ${i}`,
          dialect: "sqlite",
          durationMs: 1,
          dataSource: "secondary",
        });
        emitOrmQueryDiagnostic({
          sql: `SELECT * FROM "unnamed" WHERE id = ${i}`,
          dialect: "sqlite",
          durationMs: 1,
        });
      }
      expect(seen).toHaveLength(0);

      // Stateful /g ignorePattern must ignore ALL occurrences (not alternate)
      for (let i = 0; i < 5; i++) {
        emitOrmQueryDiagnostic({
          sql: `SELECT * FROM audit_logs WHERE id = ${i}`,
          dialect: "sqlite",
          durationMs: 1,
          dataSource: "primary",
        });
      }
      expect(seen).toHaveLength(0);

      // Concurrent HTTP RequestContext isolation: 1 query per request must NOT trigger threshold 2
      @Controller("/n1-iso")
      class IsoController {
        @Get("/a")
        async a(): Promise<string> {
          emitOrmQueryDiagnostic({
            sql: `SELECT * FROM "items" WHERE id = 1`,
            dialect: "sqlite",
            durationMs: 1,
            dataSource: "primary",
          });
          await Promise.resolve();
          return "a";
        }

        @Get("/b")
        async b(): Promise<string> {
          emitOrmQueryDiagnostic({
            sql: `SELECT * FROM "items" WHERE id = 2`,
            dialect: "sqlite",
            durationMs: 1,
            dataSource: "primary",
          });
          await Promise.resolve();
          return "b";
        }
      }

      @Module({ controllers: [IsoController] })
      class IsoModule {}

      const isoApp = await BunestFactory.create(IsoModule, { logger: false });
      await isoApp.init();
      try {
        const [r1, r2] = await Promise.all([
          isoApp.fetch(new Request("http://localhost/n1-iso/a")),
          isoApp.fetch(new Request("http://localhost/n1-iso/b")),
        ]);
        expect(r1.status).toBe(200);
        expect(r2.status).toBe(200);
      } finally {
        await isoApp.close();
      }
      expect(seen).toHaveLength(0);

      // maxDetections cap (2) prevents unbounded growth
      for (const table of ["t1", "t2", "t3"]) {
        for (let i = 0; i < 2; i++) {
          emitOrmQueryDiagnostic({
            sql: `SELECT * FROM "${table}" WHERE id = ${i}`,
            dialect: "sqlite",
            durationMs: 1,
            dataSource: "primary",
          });
        }
      }
      expect(seen).toHaveLength(3);
      expect(detector.getDetections()).toHaveLength(2);
      expect(detector.getDetections()[0]!.fingerprint).toContain("t2");
      expect(detector.getDetections()[1]!.fingerprint).toContain("t3");

      // reset() clears detections and requestScopes
      detector.reset();
      expect(detector.getDetections()).toHaveLength(0);
    } finally {
      detector.stop();
    }
  });

  it("propagates detectNPlusOne through OrmModule.forRoot() and cleans up on app.close()", async () => {
    const seen: NPlusOneDetectionEvent[] = [];

    @Module({
      imports: [
        OrmModule.forRoot({
          type: "sqlite",
          database: ":memory:",
          entities: [N1User],
          synchronize: true,
          detectNPlusOne: {
            threshold: 3,
            onDetect: (ev) => seen.push(ev),
          },
        }),
      ],
    })
    class AppModule {}

    const app = await BunestFactory.create(AppModule, { logger: false });
    await app.init();

    try {
      const ds = app.get<DataSource>(getOrmDataSourceToken("default") as any);
      const repo = ds.getRepository(N1User);
      const u = await repo.save({ name: "ModUser" });
      await repo.findOneBy({ id: u.id });
      await repo.findOneBy({ id: u.id });
      await repo.findOneBy({ id: u.id });
      expect(seen).toHaveLength(1);
    } finally {
      await app.close();
    }

    // After app.close() -> ds.destroy(), listener is unsubscribed
    for (let i = 0; i < 5; i++) {
      emitOrmQueryDiagnostic({
        sql: `SELECT * FROM "after_close" WHERE id = ${i}`,
        dialect: "sqlite",
        durationMs: 1,
        dataSource: "default",
      });
    }
    expect(seen).toHaveLength(1);
  });
});
