import { afterEach, expect, it } from "bun:test";
import {
  join,
  mkdirSyncPath,
  removePath,
} from "../../../../../packages/core/src";
import { Injectable, Module } from "../../../../../packages/core/src/common";
import {
  Column,
  CrudRepository,
  DataSource,
  Entity,
  EntityManager,
  EntityNotFoundError,
  InjectDataSource,
  InjectOrmMigrations,
  InjectRepository,
  Modifying,
  OrmMigrationRunner,
  OrmModule,
  OrmRepository,
  PrimaryGeneratedColumn,
  Query,
  SqlParam,
  Transactional,
  getOrmDataSourceToken,
  getOrmEntityManagerToken,
  getOrmMigrationRunnerToken,
  getOrmRepositoryToken,
  type OrmDataSourceOptions,
  type OrmOptionsFactory,
  type Repository,
} from "../../../../../packages/orm/src";
import { Test, describeConformance } from "../../../_helpers/index";

@Entity("decl_users")
class DeclUser {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ unique: true })
  email!: string;

  @Column({ default: "member" })
  role!: string;

  @Column({ type: "boolean", default: true })
  active!: boolean;

  @Column({ type: "integer", default: 0 })
  score!: number;

  @Column({ nullable: true })
  bio?: string | null;
}

@OrmRepository(DeclUser)
abstract class DeclUserRepository extends CrudRepository<DeclUser, number> {
  abstract findByEmail(email: string): Promise<DeclUser | null>;
  abstract findAllByRoleAndActiveOrderByScoreDesc(
    role: string,
    active: boolean,
  ): Promise<DeclUser[]>;
  abstract findFirstByRoleOrderByScoreDesc(role: string): Promise<DeclUser | null>;
  abstract findAllByEmailContainingIgnoreCase(fragment: string): Promise<DeclUser[]>;
  abstract findAllByScoreGreaterThanEqual(minScore: number): Promise<DeclUser[]>;
  abstract findAllByRoleIn(roles: string[]): Promise<DeclUser[]>;
  abstract findAllByBioIsNull(): Promise<DeclUser[]>;
  abstract existsByEmail(email: string): Promise<boolean>;
  abstract countByRole(role: string): Promise<number>;
  abstract deleteByRole(role: string): Promise<number>;

  @Modifying()
  @Query("UPDATE decl_users SET active = 0 WHERE email = :email")
  deactivateByEmail(@SqlParam("email") _email: string): Promise<number> {
    return 0 as unknown as Promise<number>;
  }

  @Query("SELECT * FROM decl_users WHERE score >= :min ORDER BY id ASC")
  findTopScorers(@SqlParam("min") _min: number): Promise<DeclUser[]> {
    return [] as unknown as Promise<DeclUser[]>;
  }
}

describeConformance(
  "Persistence (bun-native) - @bunest/orm OrmModule DI, @OrmRepository/CrudRepository & SQLite PRAGMAs",
  {
    upstreamPath: "bun-native/sqlite-module-di-and-for-feature",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-002", "ADR-007"],
    notes:
      "Bun-native conformance for OrmModule forRoot/forRootAsync/forFeature, Spring Data-style @OrmRepository + CrudRepository derived finders & @Query/@Modifying/@SqlParam, autoRegisterRepositories, WAL/foreignKeys PRAGMAs, and Symbol.asyncDispose.",
  },
  () => {
    const openSources: DataSource[] = [];
    const tempDirs: string[] = [];

    const makeTempDir = (prefix: string): string => {
      const dir = join(
        Bun.env.TMPDIR ?? Bun.env.TEMP ?? "/tmp",
        `${prefix}${crypto.randomUUID()}`,
      );
      mkdirSyncPath(dir);
      tempDirs.push(dir);
      return dir;
    };

    afterEach(async () => {
      while (openSources.length > 0) {
        await openSources.pop()!.destroy();
      }
      while (tempDirs.length > 0) {
        await removePath(tempDirs.pop()!, { recursive: true, force: true });
      }
    });

    it("derives deterministic DI tokens for DataSource, EntityManager, OrmMigrationRunner, and Repositories", () => {
      expect(getOrmDataSourceToken()).toBe(DataSource);
      expect(getOrmDataSourceToken("read")).toBe("bunest:orm:data_source:read");
      expect(getOrmEntityManagerToken()).toBe(EntityManager);
      expect(getOrmEntityManagerToken("read")).toBe(
        "bunest:orm:entity_manager:read",
      );
      expect(getOrmMigrationRunnerToken()).toBe(OrmMigrationRunner);
      expect(getOrmMigrationRunnerToken("read")).toBe(
        "bunest:orm:migration_runner:read",
      );
      expect(getOrmRepositoryToken(DeclUser)).toBe(
        "bunest:orm:repo:default:DeclUser",
      );
      expect(getOrmRepositoryToken(DeclUserRepository, "read")).toBe(
        "bunest:orm:repo:read:DeclUserRepository",
      );
    });

    it("exposes DataSource, EntityManager, and OrmMigrationRunner globally across sibling modules", async () => {
      @Injectable()
      class Consumer {
        constructor(
          readonly ds: DataSource,
          readonly em: EntityManager,
          readonly migrations: OrmMigrationRunner,
        ) {}
      }

      @Module({
        providers: [Consumer],
        exports: [Consumer],
      })
      class ConsumerModule {}

      const mod = await Test.createTestingModule({
        imports: [
          OrmModule.forRoot({ type: "sqlite", database: ":memory:" }),
          ConsumerModule,
        ],
      }).compile({ logger: false });
      await mod.init();
      try {
        const consumer = mod.get(Consumer);
        expect(await consumer.ds.ping()).toBe(true);
        expect(consumer.em).toBe(consumer.ds.manager);
        expect(consumer.migrations).toBeInstanceOf(OrmMigrationRunner);
      } finally {
        await mod.close();
      }
    });

    it("supports OrmModule.forRootAsync() with useFactory, useClass, useExisting, and missing-strategy error", async () => {
      expect(() => OrmModule.forRootAsync({})).toThrow(
        /requires one of "useFactory", "useClass", or "useExisting"/,
      );

      const PATH_TOKEN = "ORM_DB_PATH";
      @Module({
        providers: [{ provide: PATH_TOKEN, useValue: ":memory:" }],
        exports: [PATH_TOKEN],
      })
      class PathMod {}

      const modFactory = await Test.createTestingModule({
        imports: [
          OrmModule.forRootAsync({
            imports: [PathMod],
            inject: [PATH_TOKEN],
            useFactory: async (database: string) => ({
              type: "sqlite",
              database,
            }),
          }),
        ],
      }).compile({ logger: false });
      await modFactory.init();
      expect(await modFactory.get(DataSource).ping()).toBe(true);
      await modFactory.close();

      @Injectable()
      class MyOrmOptionsFactory implements OrmOptionsFactory {
        createOrmOptions(): OrmDataSourceOptions {
          return { type: "sqlite", database: ":memory:", busyTimeout: 1234 };
        }
      }

      const modClass = await Test.createTestingModule({
        imports: [OrmModule.forRootAsync({ useClass: MyOrmOptionsFactory })],
      }).compile({ logger: false });
      await modClass.init();
      const timeoutRows = await modClass
        .get(DataSource)
        .query<{ timeout: number }>("PRAGMA busy_timeout");
      expect(timeoutRows[0]?.timeout).toBe(1234);
      await modClass.close();

      @Module({
        providers: [MyOrmOptionsFactory],
        exports: [MyOrmOptionsFactory],
      })
      class FactoryModule {}

      const modExisting = await Test.createTestingModule({
        imports: [
          OrmModule.forRootAsync({
            imports: [FactoryModule],
            useExisting: MyOrmOptionsFactory,
          }),
        ],
      }).compile({ logger: false });
      await modExisting.init();
      expect(await modExisting.get(DataSource).ping()).toBe(true);
      await modExisting.close();
    });

    it("wires @OrmRepository / CrudRepository derived finders, @Query, @Modifying, @SqlParam & @Transactional via OrmModule.forFeature()", async () => {
      @Injectable()
      class UserFacadeService {
        constructor(
          readonly declRepo: DeclUserRepository,
          @InjectRepository(DeclUser) readonly entityRepo: Repository<DeclUser>,
        ) {}

        @Transactional()
        async createAndMaybeFail(email: string, shouldFail: boolean) {
          await this.declRepo.save({
            email,
            role: "admin",
            active: true,
            score: 100,
          });
          if (shouldFail) {
            throw new Error("rollback-declarative");
          }
        }
      }

      const mod = await Test.createTestingModule({
        imports: [
          OrmModule.forRoot({
            type: "sqlite",
            database: ":memory:",
            autoSync: true,
          }),
          OrmModule.forFeature([DeclUser, DeclUserRepository]),
        ],
        providers: [UserFacadeService],
      }).compile({ logger: false });
      await mod.init();

      try {
        const svc = mod.get(UserFacadeService);
        const repo = svc.declRepo;

        await repo.saveMany([
          { email: "ada@bunest.dev", role: "admin", active: true, score: 95, bio: "founder" },
          { email: "grace@bunest.dev", role: "admin", active: true, score: 120, bio: null },
          { email: "linus@bunest.dev", role: "member", active: false, score: 60, bio: null },
        ]);

        // Base CRUD
        expect(await repo.count()).toBe(3);
        const ada = await repo.findByEmail("ada@bunest.dev");
        expect(ada).not.toBeNull();
        expect(await repo.existsById(ada!.id)).toBe(true);
        expect(await repo.findByIdOrFail(ada!.id)).toMatchObject({
          email: "ada@bunest.dev",
        });
        await expect(repo.findByIdOrFail(99999)).rejects.toThrow(
          EntityNotFoundError,
        );

        // Derived finders
        const activeAdmins = await repo.findAllByRoleAndActiveOrderByScoreDesc(
          "admin",
          true,
        );
        expect(activeAdmins.map((u) => u.email)).toEqual([
          "grace@bunest.dev",
          "ada@bunest.dev",
        ]);
        expect(
          (await repo.findFirstByRoleOrderByScoreDesc("admin"))?.email,
        ).toBe("grace@bunest.dev");
        expect(
          (await repo.findAllByEmailContainingIgnoreCase("GRACE")).map((u) => u.email),
        ).toEqual(["grace@bunest.dev"]);
        expect(
          (await repo.findAllByScoreGreaterThanEqual(95)).length,
        ).toBe(2);
        expect(
          (await repo.findAllByRoleIn(["member"])).map((u) => u.email),
        ).toEqual(["linus@bunest.dev"]);
        expect((await repo.findAllByBioIsNull()).length).toBe(2);
        expect(await repo.existsByEmail("ada@bunest.dev")).toBe(true);
        expect(await repo.countByRole("admin")).toBe(2);

        // Custom @Query + @Modifying + @SqlParam
        const top = await repo.findTopScorers(90);
        expect(top.map((u) => u.email)).toEqual([
          "ada@bunest.dev",
          "grace@bunest.dev",
        ]);

        const deactivated = await repo.deactivateByEmail("ada@bunest.dev");
        expect(deactivated).toBe(1);
        expect((await repo.findByEmail("ada@bunest.dev"))?.active).toBe(false);

        // @Transactional rollback with CrudRepository
        await expect(
          svc.createAndMaybeFail("rolled@bunest.dev", true),
        ).rejects.toThrow("rollback-declarative");
        expect(await repo.existsByEmail("rolled@bunest.dev")).toBe(false);

        await svc.createAndMaybeFail("committed@bunest.dev", false);
        expect(await repo.existsByEmail("committed@bunest.dev")).toBe(true);

        // Derived delete
        expect(await repo.deleteByRole("member")).toBe(1);
        expect(await repo.countByRole("member")).toBe(0);
      } finally {
        await mod.close();
      }
    });

    it("supports autoRegisterRepositories: true with zero OrmModule.forFeature() calls", async () => {
      const mod = await Test.createTestingModule({
        imports: [
          OrmModule.forRoot({
            type: "sqlite",
            database: ":memory:",
            autoSync: true,
            autoRegisterRepositories: true,
          }),
        ],
      }).compile({ logger: false });
      await mod.init();
      try {
        const repo = mod.get(DeclUserRepository);
        await repo.save({
          email: "auto@bunest.dev",
          role: "member",
          active: true,
          score: 10,
        });
        expect(await repo.findByEmail("auto@bunest.dev")).toMatchObject({
          email: "auto@bunest.dev",
        });
      } finally {
        await mod.close();
      }
    });

    it("applies busyTimeout, foreignKeys (enforced vs disabled), WAL on file DB, and Symbol.asyncDispose", async () => {
      const dir = makeTempDir("bunest-orm-pragmas-");
      const dbPath = join(dir, "app.sqlite");

      const ds = new DataSource({
        type: "sqlite",
        database: dbPath,
        busyTimeout: 3200,
        enforceForeignKeys: true,
        enableWAL: true,
      });
      await ds.initialize();
      openSources.push(ds);

      expect(
        (await ds.query<{ timeout: number }>("PRAGMA busy_timeout"))[0]?.timeout,
      ).toBe(3200);
      expect(
        (await ds.query<{ foreign_keys: number }>("PRAGMA foreign_keys"))[0]
          ?.foreign_keys,
      ).toBe(1);
      expect(
        String(
          (await ds.query<{ journal_mode: string }>("PRAGMA journal_mode"))[0]
            ?.journal_mode,
        ).toLowerCase(),
      ).toBe("wal");

      await ds.driver.execute(
        "CREATE TABLE parents (id INTEGER PRIMARY KEY);",
      );
      await ds.driver.execute(
        "CREATE TABLE children (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parents(id));",
      );
      await expect(
        ds.query("INSERT INTO children (id, parent_id) VALUES (?, ?)", [1, 999]),
      ).rejects.toThrow(/FOREIGN KEY/i);

      // Symbol.asyncDispose
      let disposed!: DataSource;
      {
        await using scoped = new DataSource({
          type: "sqlite",
          database: ":memory:",
          enforceForeignKeys: false,
        });
        await scoped.initialize();
        disposed = scoped;
        expect(
          (await scoped.query<{ foreign_keys: number }>("PRAGMA foreign_keys"))[0]
            ?.foreign_keys,
        ).toBe(0);
        expect(scoped.isInitialized).toBe(true);
      }
      expect(disposed.isInitialized).toBe(false);
    });

    it("supports named multi-connections with @InjectDataSource and @InjectOrmMigrations", async () => {
      @Injectable()
      class MultiConsumer {
        constructor(
          @InjectDataSource() readonly primary: DataSource,
          @InjectDataSource("analytics") readonly analytics: DataSource,
          @InjectOrmMigrations("analytics")
          readonly analyticsMigrations: OrmMigrationRunner,
        ) {}
      }

      const mod = await Test.createTestingModule({
        imports: [
          OrmModule.forRoot({ type: "sqlite", database: ":memory:" }),
          OrmModule.forRoot({
            name: "analytics",
            type: "sqlite",
            database: ":memory:",
          }),
        ],
        providers: [MultiConsumer],
      }).compile({ logger: false });
      await mod.init();
      try {
        const c = mod.get(MultiConsumer);
        expect(c.primary.name).toBe("default");
        expect(c.analytics.name).toBe("analytics");
        expect(c.primary).not.toBe(c.analytics);
        expect(c.analyticsMigrations).toBeInstanceOf(OrmMigrationRunner);
      } finally {
        await mod.close();
      }
    });
  },
);
