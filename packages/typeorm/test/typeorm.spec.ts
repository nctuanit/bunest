import "reflect-metadata";
import { afterEach, describe, expect, it } from "bun:test";
import { Injectable, Module } from "@bunest/common";
import { Test } from "@bunest/testing";
import {
  CircularDependencyException,
  CustomRepository,
  DEFAULT_DATA_SOURCE_NAME,
  DataSource,
  DataSourceNameRegistry,
  DuplicateDataSourceException,
  EntitiesMetadataStorage,
  EntityManager,
  EntitySchema,
  InjectConnection,
  InjectDataSource,
  InjectEntityManager,
  InjectRepository,
  MongoRepository,
  Repository,
  TreeRepository,
  TypeOrmModule,
  generateString,
  getConnectionToken,
  getCustomRepositoryEntity,
  getCustomRepositoryToken,
  getDataSourceName,
  getDataSourcePrefix,
  getDataSourceToken,
  getEntityManagerToken,
  getRepositoryToken,
  handleRetry,
  type DataSourceLike,
  type TypeOrmModuleOptions,
  type TypeOrmOptionsFactory,
} from "../src/index";

class User {
  id!: number;
  name!: string;
  role?: string;
}

class Item {
  id!: number;
  sku!: string;
  qty!: number;
}

class Category {
  id!: number;
  title!: string;
  parentId?: number;
}
Reflect.defineMetadata("typeorm:treeType", "adjacency-list", Category);

const PostSchema = new EntitySchema<{ id: number; title: string }>({
  name: "Post",
  tableName: "posts",
  columns: {
    id: { type: "integer", primary: true, generated: true },
    title: { type: "text" },
  },
});

const TargetPostSchema = new EntitySchema<User>({
  name: "UserAlias",
  target: User,
});

@CustomRepository(User)
class CustomUserRepository extends Repository<User> {
  async findAdmins(): Promise<User[]> {
    return this.findBy({ role: "admin" });
  }
}

afterEach(() => {
  DataSourceNameRegistry.clear();
  DataSourceNameRegistry.setStrict(false);
  EntitiesMetadataStorage.clear();
});

describe("@bunest/typeorm utilities & tokens", () => {
  it("computes DataSource names, prefixes, and tokens matching @nestjs/typeorm v12", () => {
    expect(getDataSourceName()).toBe(DEFAULT_DATA_SOURCE_NAME);
    expect(getDataSourceName("default")).toBe("default");
    expect(getDataSourceName("analytics")).toBe("analytics");
    expect(getDataSourceName({ name: "billing" })).toBe("billing");
    expect(getDataSourceName({})).toBe("default");

    expect(getDataSourcePrefix()).toBe("");
    expect(getDataSourcePrefix("default")).toBe("");
    expect(getDataSourcePrefix("analytics")).toBe("analytics_");
    expect(getDataSourcePrefix({ name: "billing" })).toBe("billing_");

    expect(getDataSourceToken()).toBe(DataSource);
    expect(getDataSourceToken("default")).toBe(DataSource);
    expect(getDataSourceToken("analytics")).toBe("analyticsDataSource");
    expect(getConnectionToken("analytics")).toBe("analyticsDataSource");
    expect(getConnectionToken()).toBe(DataSource);

    expect(getEntityManagerToken()).toBe(EntityManager);
    expect(getEntityManagerToken("analytics")).toBe("analyticsEntityManager");

    expect(getRepositoryToken(User)).toBe("UserRepository");
    expect(getRepositoryToken(User, "analytics")).toBe("analytics_UserRepository");
    expect(getRepositoryToken(PostSchema)).toBe("PostRepository");
    expect(getRepositoryToken(TargetPostSchema)).toBe("UserRepository");
    expect(getRepositoryToken(PostSchema, "analytics")).toBe(
      "analytics_PostRepository",
    );

    expect(getCustomRepositoryToken(CustomUserRepository)).toBe(
      "CustomUserRepository",
    );
    expect(getCustomRepositoryEntity(CustomUserRepository)).toBe(User);
    expect(getRepositoryToken(CustomUserRepository)).toBe(CustomUserRepository);
    expect(getRepositoryToken(CustomUserRepository, "analytics")).toBe(
      "analytics_CustomUserRepository",
    );

    expect(() => getRepositoryToken(null as any)).toThrow(
      CircularDependencyException,
    );
    expect(() => getCustomRepositoryToken(undefined as any)).toThrow(
      CircularDependencyException,
    );
    expect(() =>
      getRepositoryToken(new EntitySchema({ name: "" })),
    ).toThrow('EntitySchema must have either "target" or "name" defined');

    expect(generateString()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("formats DuplicateDataSourceException and enforces strict registry mode", () => {
    const defErr = new DuplicateDataSourceException("default");
    expect(defErr.message).toContain("default (unnamed)");
    const namedErr = new DuplicateDataSourceException("reporting");
    expect(namedErr.message).toContain('"reporting"');

    DataSourceNameRegistry.register("reporting");
    expect(DataSourceNameRegistry.has("reporting")).toBe(true);
    expect(() => DataSourceNameRegistry.register("reporting", true)).toThrow(
      DuplicateDataSourceException,
    );
    DataSourceNameRegistry.unregister("reporting");
    expect(DataSourceNameRegistry.has("reporting")).toBe(false);
  });

  it("handles retries with backoff, toRetry predicate, and Subscribable support", async () => {
    let attempts = 0;
    const value = await handleRetry(3, 5, "default", true)(async () => {
      attempts++;
      if (attempts < 3) {
        throw new Error(`boom-${attempts}`);
      }
      return "connected";
    });
    expect(value).toBe("connected");
    expect(attempts).toBe(3);

    // Non-retryable error stops immediately
    let predicateCalls = 0;
    await expect(
      handleRetry(5, 5, "analytics", false, () => false)(async () => {
        predicateCalls++;
        throw new Error("fatal");
      }),
    ).rejects.toThrow("fatal");
    expect(predicateCalls).toBe(1);

    // Subscribable compatibility
    let subAttempts = 0;
    const result = await new Promise<string>((resolve, reject) => {
      const source = {
        subscribe(observer: any) {
          subAttempts++;
          if (subAttempts < 2) {
            observer.error?.(new Error("transient"));
          } else {
            observer.next?.("sub-ok");
            observer.complete?.();
          }
          return { unsubscribe() {} };
        },
      };
      handleRetry(3, 1)<string>(source).subscribe({
        next: (v) => resolve(v),
        error: (e) => reject(e),
      });
    });
    expect(result).toBe("sub-ok");
    expect(subAttempts).toBe(2);
  });
});

describe("@bunest/typeorm DI lifecycle & Bun SQLite integration", () => {
  it("supports forRoot, forFeature, autoLoadEntities, CRUD, transactions, custom repo, and shutdown", async () => {
    @Injectable()
    class UsersService {
      constructor(
        @InjectRepository(User) public readonly usersRepo: Repository<User>,
        @InjectRepository(PostSchema)
        public readonly postsRepo: Repository<{ id: number; title: string }>,
        @InjectRepository(CustomUserRepository)
        public readonly customRepo: CustomUserRepository,
        @InjectDataSource() public readonly dataSource: DataSource,
        @InjectConnection() public readonly connection: DataSource,
        @InjectEntityManager() public readonly manager: EntityManager,
      ) {}
    }

    const mod = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: "sqlite",
          database: ":memory:",
          synchronize: true,
          autoLoadEntities: true,
        }),
        TypeOrmModule.forFeature([User, PostSchema, CustomUserRepository]),
      ],
      providers: [UsersService],
    }).compile();

    await mod.init();

    const svc = mod.get(UsersService);
    expect(svc.dataSource).toBeInstanceOf(DataSource);
    expect(svc.connection).toBe(svc.dataSource);
    expect(svc.dataSource.isInitialized).toBe(true);
    expect(svc.manager).toBe(svc.dataSource.manager);
    expect(DataSourceNameRegistry.has("default")).toBe(true);

    // CRUD operations
    const alice = await svc.usersRepo.save(
      svc.usersRepo.create({ name: "Alice", role: "admin" }),
    );
    const bob = await svc.usersRepo.save({ name: "Bob", role: "user" });
    expect(alice.id).toBe(1);
    expect(bob.id).toBe(2);
    expect(await svc.usersRepo.count()).toBe(2);
    expect(await svc.usersRepo.existsBy({ name: "Alice" })).toBe(true);

    const admins = await svc.customRepo.findAdmins();
    expect(admins).toHaveLength(1);
    expect(admins[0]?.name).toBe("Alice");

    await svc.usersRepo.update(bob.id, { role: "editor" });
    const updatedBob = await svc.usersRepo.findOneByOrFail({ id: bob.id });
    expect(updatedBob.role).toBe("editor");

    // EntitySchema repository
    await svc.postsRepo.insert({ title: "Hello Bunest" });
    const [posts, totalPosts] = await svc.postsRepo.findAndCount();
    expect(totalPosts).toBe(1);
    expect(posts[0]?.title).toBe("Hello Bunest");

    // SQLite transaction rollback
    await expect(
      svc.dataSource.transaction(async (em) => {
        await em.save(User, { name: "RolledBack", role: "temp" });
        expect(await em.getRepository(User).count()).toBe(3);
        throw new Error("abort-tx");
      }),
    ).rejects.toThrow("abort-tx");
    expect(await svc.usersRepo.count()).toBe(2);

    // Raw SQL query
    const ping = await svc.dataSource.query("SELECT 1 + 1 AS sum");
    expect(ping).toEqual([{ sum: 2 }]);

    // Shutdown destroys DataSource and unregisters name
    await mod.close();
    expect(svc.dataSource.isInitialized).toBe(false);
    expect(DataSourceNameRegistry.has("default")).toBe(false);
  });

  it("isolates multiple named DataSources cleanly", async () => {
    @Injectable()
    class MultiDbService {
      constructor(
        @InjectRepository(Item, "primary")
        public readonly primaryRepo: Repository<Item>,
        @InjectRepository(Item, "secondary")
        public readonly secondaryRepo: Repository<Item>,
        @InjectDataSource("primary") public readonly primaryDs: DataSource,
        @InjectDataSource("secondary") public readonly secondaryDs: DataSource,
      ) {}
    }

    const mod = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot(
          { type: "sqlite", database: ":memory:", synchronize: true },
          "primary",
        ),
        TypeOrmModule.forRoot({
          name: "secondary",
          type: "sqlite",
          database: ":memory:",
          synchronize: true,
        }),
        TypeOrmModule.forFeature([Item], "primary"),
        TypeOrmModule.forFeature([Item], "secondary"),
      ],
      providers: [MultiDbService],
    }).compile();

    await mod.init();
    const svc = mod.get(MultiDbService);
    expect(svc.primaryDs).not.toBe(svc.secondaryDs);

    await svc.primaryRepo.save({ sku: "P-1", qty: 10 });
    await svc.secondaryRepo.save({ sku: "S-1", qty: 99 });

    expect(await svc.primaryRepo.find()).toMatchObject([{ sku: "P-1", qty: 10 }]);
    expect(await svc.secondaryRepo.find()).toMatchObject([{ sku: "S-1", qty: 99 }]);

    await mod.close();
    expect(svc.primaryDs.isInitialized).toBe(false);
    expect(svc.secondaryDs.isInitialized).toBe(false);
  });

  it("supports forRootAsync (useFactory, useClass, useExisting), custom dataSourceFactory, retry, and manualInitialization", async () => {
    let initCalls = 0;
    let destroyCalls = 0;
    let factoryReceivedEntities: unknown[] = [];

    @Injectable()
    class FakeConfigService {
      dbName = ":memory:";
    }

    @Module({
      providers: [FakeConfigService],
      exports: [FakeConfigService],
    })
    class ConfigModule {}

    const modFactory = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRootAsync({
          name: "custom",
          imports: [ConfigModule],
          inject: [FakeConfigService],
          useFactory: (cfg: FakeConfigService) => ({
            type: "sqlite",
            database: cfg.dbName,
            autoLoadEntities: true,
            retryAttempts: 3,
            retryDelay: 5,
          }),
          dataSourceFactory: async (opts) => {
            factoryReceivedEntities = Array.isArray(opts?.entities)
              ? opts.entities
              : [];
            const real = new DataSource(opts);
            const wrapped: DataSourceLike = {
              name: real.name,
              options: real.options,
              get isInitialized() {
                return real.isInitialized;
              },
              get manager() {
                return real.manager;
              },
              get entityMetadatas() {
                return real.entityMetadatas;
              },
              async initialize() {
                initCalls++;
                if (initCalls < 2) {
                  throw new Error("transient-init-failure");
                }
                await real.initialize();
                return wrapped;
              },
              async destroy() {
                destroyCalls++;
                await real.destroy();
              },
              getRepository: (t) => real.getRepository(t),
              getTreeRepository: (t) => real.getTreeRepository(t),
              getMongoRepository: (t) => real.getMongoRepository(t),
              query: (q, p) => real.query(q, p),
              transaction: (fn) => real.transaction((em) => fn(em)),
              createQueryRunner: () => real.createQueryRunner(),
              synchronize: (d) => real.synchronize(d),
            };
            return wrapped;
          },
        }),
        TypeOrmModule.forFeature([User], "custom"),
      ],
    }).compile();

    await modFactory.init();
    expect(initCalls).toBe(2);
    expect(factoryReceivedEntities).toContain(User);
    const customDs = modFactory.get<DataSourceLike>(
      getDataSourceToken("custom") as any,
    );
    expect(customDs.isInitialized).toBe(true);
    await modFactory.close();
    expect(destroyCalls).toBe(1);

    // useClass + manualInitialization
    @Injectable()
    class MyTypeOrmOptionsFactory implements TypeOrmOptionsFactory {
      createTypeOrmOptions(): TypeOrmModuleOptions {
        return {
          type: "sqlite",
          database: ":memory:",
          manualInitialization: true,
        };
      }
    }

    const modClass = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRootAsync({
          useClass: MyTypeOrmOptionsFactory,
        }),
      ],
    }).compile();
    await modClass.init();
    const dsManual = modClass.get(DataSource);
    expect(dsManual.isInitialized).toBe(false);
    await modClass.close();

    // useExisting
    @Module({
      providers: [MyTypeOrmOptionsFactory],
      exports: [MyTypeOrmOptionsFactory],
    })
    class ExistingFactoryModule {}

    const modExisting = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRootAsync({
          name: "existing",
          imports: [ExistingFactoryModule],
          useExisting: MyTypeOrmOptionsFactory,
        }),
      ],
    }).compile();
    await modExisting.init();
    const dsExisting = modExisting.get<DataSource>(
      getDataSourceToken("existing") as any,
    );
    expect(dsExisting.isInitialized).toBe(false);
    await modExisting.close();
  });

  it("provides TreeRepository for tree entities and MongoRepository for mongodb connections", async () => {
    const modTree = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: "sqlite",
          database: ":memory:",
          entities: [Category],
          synchronize: true,
        }),
        TypeOrmModule.forFeature([Category]),
      ],
    }).compile();
    await modTree.init();
    const catRepo = modTree.get<TreeRepository<Category>>(
      getRepositoryToken(Category) as any,
    );
    expect(catRepo).toBeInstanceOf(TreeRepository);
    const root = await catRepo.save({ title: "Root" });
    await catRepo.save({ title: "Child", parentId: root.id });
    expect(await catRepo.findRoots()).toHaveLength(1);
    expect(await catRepo.findDescendants(root)).toHaveLength(1);
    await modTree.close();

    const modMongo = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          name: "mongo",
          type: "mongodb",
          entities: [User],
        }),
        TypeOrmModule.forFeature([User], "mongo"),
      ],
    }).compile();
    await modMongo.init();
    const mongoRepo = modMongo.get<MongoRepository<User>>(
      getRepositoryToken(User, "mongo") as any,
    );
    expect(mongoRepo).toBeInstanceOf(MongoRepository);
    await mongoRepo.insertOne({ name: "Doc1" });
    expect(await mongoRepo.countDocuments({ name: "Doc1" })).toBe(1);
    await modMongo.close();
  });
});
