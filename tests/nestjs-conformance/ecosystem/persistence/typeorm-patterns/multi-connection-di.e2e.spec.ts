import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Module } from "../../../../../packages/common/src";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  BaseSqliteRepository,
  SqliteEntity,
  SqliteMigrationRunner,
  SqliteModule,
  SqliteService,
  getSqliteConnectionToken,
  getSqliteMigrationRunnerToken,
  getSqliteRepositoryToken,
} from "../../../../../packages/sqlite/src";
import { Test, describeConformance } from "../../../_helpers/index";

interface PhotoRow extends Record<string, unknown> {
  id: number;
  name: string;
  description: string;
  views: number;
}

@SqliteEntity("photos")
class Photo {}

class CustomPhotoRepository extends BaseSqliteRepository<PhotoRow, number> {
  constructor(sqlite: SqliteService) {
    super(sqlite, "photos");
  }

  findPopular(minViews: number): PhotoRow[] {
    return this.sqlite.query<PhotoRow>(
      'SELECT * FROM "photos" WHERE views >= ? ORDER BY views DESC',
      [minViews],
    );
  }
}

const CREATE_PHOTOS_MIGRATION = {
  id: "001_create_photos",
  up: `CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    views INTEGER NOT NULL DEFAULT 0
  )`,
  down: "DROP TABLE IF EXISTS photos",
};

@Module({
  imports: [
    SqliteModule.forFeature([Photo, CustomPhotoRepository]),
    SqliteModule.forFeature([Photo], "connection_2"),
  ],
})
class PhotoFeatureModule {}

@Module({
  imports: [
    SqliteModule.forRoot({
      filename: ":memory:",
      autoMigrate: true,
      migrations: [CREATE_PHOTOS_MIGRATION],
    }),
    PhotoFeatureModule,
    SqliteModule.forRoot({
      name: "connection_2",
      filename: ":memory:",
      autoMigrate: true,
      migrations: [CREATE_PHOTOS_MIGRATION],
    }),
  ],
})
class ApplicationModule {}

describeConformance(
  "Persistence (typeorm-patterns) - multi-connection dependency injection",
  {
    upstreamPath: "typeorm/tests/e2e/typeorm-di.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002", "ADR-007"],
    notes:
      "Adapts TypeORM DataSource/EntityManager/named connection/custom repository DI checks to SqliteService, SqliteMigrationRunner, getSqliteConnectionToken, and BaseSqliteRepository subclasses.",
  },
  () => {
    let app: BunestApplication;

    beforeEach(async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [ApplicationModule],
      }).compile({ logger: false });

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
    });

    afterEach(async () => {
      await app.close();
    });

    it("injects an initialized default SqliteService", () => {
      const sqlite = app.get(SqliteService);
      expect(sqlite).toBeInstanceOf(SqliteService);
      expect(sqlite.isClosed).toBe(false);
      expect(sqlite.healthCheck()).toBe(true);
      expect(app.get(getSqliteConnectionToken())).toBe(sqlite);
    });

    it("injects the default SqliteMigrationRunner bound to the default connection", () => {
      const runner = app.get<SqliteMigrationRunner>(
        getSqliteMigrationRunnerToken(),
      );
      expect(runner).toBeInstanceOf(SqliteMigrationRunner);
      expect(app.get(SqliteMigrationRunner)).toBe(runner);
      expect(runner.getApplied().map((m) => m.id)).toEqual([
        "001_create_photos",
      ]);
    });

    it("resolves a named SqliteService by its token", () => {
      const named = app.get<SqliteService>(
        getSqliteConnectionToken("connection_2"),
      );
      expect(named).toBeInstanceOf(SqliteService);
      expect(named.connectionName).toBe("connection_2");
      expect(named.healthCheck()).toBe(true);
      expect(named).not.toBe(app.get(SqliteService));
    });

    it("injects a custom repository (extends BaseSqliteRepository)", () => {
      const repository = app.get<CustomPhotoRepository>(
        getSqliteRepositoryToken(CustomPhotoRepository),
      );
      expect(repository).toBeInstanceOf(BaseSqliteRepository);
      expect(repository).toBeInstanceOf(CustomPhotoRepository);
      expect(app.get(CustomPhotoRepository)).toBe(repository);

      repository.insert({
        name: "Viral",
        description: "Top photo",
        views: 9000,
      });
      expect(repository.findPopular(5000)).toHaveLength(1);
    });

    describe("default connection class alias scoping", () => {
      it("only aliases default connection to SqliteService class token and keeps named repositories isolated", () => {
        const defaultRepo = app.get<BaseSqliteRepository<PhotoRow, number>>(
          getSqliteRepositoryToken(Photo),
        );
        const namedRepo = app.get<BaseSqliteRepository<PhotoRow, number>>(
          getSqliteRepositoryToken(Photo, "connection_2"),
        );

        defaultRepo.insert({
          name: "PrimaryOnly",
          description: "Stored on default",
          views: 100,
        });

        expect(defaultRepo.count()).toBe(1);
        expect(namedRepo.count()).toBe(0);
      });
    });

    it("allows registering the same custom BaseSqliteRepository subclass on both default and named connections", async () => {
      @Module({
        imports: [
          SqliteModule.forRoot({
            filename: ":memory:",
            autoMigrate: true,
            migrations: [CREATE_PHOTOS_MIGRATION],
          }),
          SqliteModule.forRoot({
            name: "connection_2",
            filename: ":memory:",
            autoMigrate: true,
            migrations: [CREATE_PHOTOS_MIGRATION],
          }),
          SqliteModule.forFeature([CustomPhotoRepository]),
          SqliteModule.forFeature([CustomPhotoRepository], "connection_2"),
        ],
      })
      class DualCustomRepoModule {}

      const dualRef = await Test.createTestingModule({
        imports: [DualCustomRepoModule],
      }).compile({ logger: false });
      try {
        await dualRef.init();
        const repo1 = dualRef.get<CustomPhotoRepository>(
          getSqliteRepositoryToken(CustomPhotoRepository),
        );
        const repo2 = dualRef.get<CustomPhotoRepository>(
          getSqliteRepositoryToken(CustomPhotoRepository, "connection_2"),
        );
        expect(repo1).toBeInstanceOf(CustomPhotoRepository);
        expect(repo2).toBeInstanceOf(CustomPhotoRepository);
        expect(repo1).not.toBe(repo2);
        expect(dualRef.get(CustomPhotoRepository)).toBe(repo1);
      } finally {
        await dualRef.close();
      }
    });
  },
);
