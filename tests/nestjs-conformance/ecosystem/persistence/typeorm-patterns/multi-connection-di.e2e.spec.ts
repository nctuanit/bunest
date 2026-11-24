import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Module } from "../../../../../packages/core/src/common";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  Column,
  CrudRepository,
  DataSource,
  Entity,
  EntityManager,
  OrmMigrationRunner,
  OrmModule,
  OrmRepository,
  PrimaryGeneratedColumn,
  Query,
  SqlParam,
  getOrmDataSourceToken,
  getOrmEntityManagerToken,
  getOrmMigrationRunnerToken,
  getOrmRepositoryToken,
  type Repository,
} from "../../../../../packages/orm/src";
import { Test, describeConformance } from "../../../_helpers/index";

@Entity("photos")
class Photo {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;

  @Column()
  description!: string;

  @Column({ type: "integer", default: 0 })
  views!: number;
}

@OrmRepository(Photo)
abstract class CustomPhotoRepository extends CrudRepository<Photo, number> {
  @Query("SELECT * FROM photos WHERE views >= :minViews ORDER BY views DESC")
  findPopular(@SqlParam("minViews") _minViews: number): Promise<Photo[]> {
    return [] as unknown as Promise<Photo[]>;
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
    OrmModule.forFeature([Photo, CustomPhotoRepository]),
    OrmModule.forFeature([Photo], "connection_2"),
  ],
})
class PhotoFeatureModule {}

@Module({
  imports: [
    OrmModule.forRoot({
      type: "sqlite",
      database: ":memory:",
      entities: [Photo],
      autoMigrate: true,
      migrations: [CREATE_PHOTOS_MIGRATION],
    }),
    PhotoFeatureModule,
    OrmModule.forRoot({
      name: "connection_2",
      type: "sqlite",
      database: ":memory:",
      entities: [Photo],
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
      "Adapts TypeORM DataSource/EntityManager/named connection/custom repository DI checks to @bunest/orm DataSource, EntityManager, OrmMigrationRunner, getOrmDataSourceToken, and @OrmRepository CrudRepository subclasses.",
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

    it("injects an initialized default DataSource and EntityManager", async () => {
      const ds = app.get(DataSource);
      const em = app.get(EntityManager);
      expect(ds).toBeInstanceOf(DataSource);
      expect(em).toBeInstanceOf(EntityManager);
      expect(ds.isInitialized).toBe(true);
      expect(await ds.ping()).toBe(true);
      expect(app.get(getOrmDataSourceToken())).toBe(ds);
      expect(app.get(getOrmEntityManagerToken())).toBe(em);
      expect(ds.manager).toBe(em);
    });

    it("injects the default OrmMigrationRunner bound to the default DataSource", async () => {
      const runner = app.get<OrmMigrationRunner>(getOrmMigrationRunnerToken());
      expect(runner).toBeInstanceOf(OrmMigrationRunner);
      expect(app.get(OrmMigrationRunner)).toBe(runner);
      expect((await runner.getApplied()).map((m) => m.id)).toEqual([
        "001_create_photos",
      ]);
    });

    it("resolves a named DataSource and OrmMigrationRunner by their tokens", async () => {
      const named = app.get<DataSource>(getOrmDataSourceToken("connection_2"));
      const namedRunner = app.get<OrmMigrationRunner>(
        getOrmMigrationRunnerToken("connection_2"),
      );
      expect(named).toBeInstanceOf(DataSource);
      expect(named.name).toBe("connection_2");
      expect(await named.ping()).toBe(true);
      expect(named).not.toBe(app.get(DataSource));
      expect(namedRunner).toBeInstanceOf(OrmMigrationRunner);
      expect(namedRunner).not.toBe(app.get(OrmMigrationRunner));
    });

    it("injects a declarative custom repository (@OrmRepository extending CrudRepository)", async () => {
      const repository = app.get<CustomPhotoRepository>(
        getOrmRepositoryToken(CustomPhotoRepository),
      );
      expect(app.get(CustomPhotoRepository)).toBe(repository);

      await repository.save({
        name: "Viral",
        description: "Top photo",
        views: 9000,
      });
      await repository.save({
        name: "Quiet",
        description: "Low views",
        views: 50,
      });

      const popular = await repository.findPopular(5000);
      expect(popular).toHaveLength(1);
      expect(popular[0]?.name).toBe("Viral");
    });

    describe("default connection class alias scoping", () => {
      it("isolates repositories bound to default vs named DataSource", async () => {
        const defaultRepo = app.get<Repository<Photo>>(
          getOrmRepositoryToken(Photo),
        );
        const namedRepo = app.get<Repository<Photo>>(
          getOrmRepositoryToken(Photo, "connection_2"),
        );

        await defaultRepo.save({
          name: "PrimaryOnly",
          description: "Stored on default",
          views: 100,
        });

        expect(await defaultRepo.count()).toBe(1);
        expect(await namedRepo.count()).toBe(0);
      });
    });

    it("allows registering declarative @OrmRepository on both default and named connections", async () => {
      @Module({
        imports: [
          OrmModule.forRoot({
            type: "sqlite",
            database: ":memory:",
            entities: [Photo],
            autoMigrate: true,
            migrations: [CREATE_PHOTOS_MIGRATION],
          }),
          OrmModule.forRoot({
            name: "connection_2",
            type: "sqlite",
            database: ":memory:",
            entities: [Photo],
            autoMigrate: true,
            migrations: [CREATE_PHOTOS_MIGRATION],
          }),
          OrmModule.forFeature([CustomPhotoRepository]),
          OrmModule.forFeature([CustomPhotoRepository], "connection_2"),
        ],
      })
      class DualCustomRepoModule {}

      const dualRef = await Test.createTestingModule({
        imports: [DualCustomRepoModule],
      }).compile({ logger: false });
      try {
        await dualRef.init();
        const repo1 = dualRef.get<CustomPhotoRepository>(
          getOrmRepositoryToken(CustomPhotoRepository),
        );
        const repo2 = dualRef.get<CustomPhotoRepository>(
          getOrmRepositoryToken(CustomPhotoRepository, "connection_2"),
        );
        expect(repo1).not.toBe(repo2);

        await repo1.save({
          name: "One",
          description: "Primary",
          views: 500,
        });
        expect(await repo1.count()).toBe(1);
        expect(await repo2.count()).toBe(0);
      } finally {
        await dualRef.close();
      }
    });
  },
);
