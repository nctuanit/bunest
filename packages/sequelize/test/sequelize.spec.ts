import "reflect-metadata";
import { afterEach, describe, expect, it } from "bun:test";
import { Injectable, Module } from "@bunest/common";
import { Test } from "@bunest/testing";
import {
  CircularDependencyException,
  DEFAULT_CONNECTION_NAME,
  EntitiesMetadataStorage,
  InjectConnection,
  InjectModel,
  Model,
  Sequelize,
  SequelizeModule,
  SequelizeRepository,
  generateString,
  getConnectionName,
  getConnectionPrefix,
  getConnectionToken,
  getModelToken,
  handleRetry,
  type SequelizeLike,
  type SequelizeModuleOptions,
  type SequelizeOptionsFactory,
} from "../src/index";

class UserModel extends Model<{ id: number; email: string; active: boolean }> {
  id!: number;
  email!: string;
  active!: boolean;
}

class OrderModel extends Model<{ id: number; total: number }> {
  id!: number;
  total!: number;
}

afterEach(() => {
  EntitiesMetadataStorage.clear();
  UserModel.sequelize = undefined;
  OrderModel.sequelize = undefined;
});

describe("@bunest/sequelize utilities & tokens", () => {
  it("matches @nestjs/sequelize v12 token & prefix conventions", () => {
    expect(getConnectionName({})).toBe(DEFAULT_CONNECTION_NAME);
    expect(getConnectionName({ name: "reporting" })).toBe("reporting");

    expect(getConnectionPrefix()).toBe("");
    expect(getConnectionPrefix("default")).toBe("");
    expect(getConnectionPrefix("reporting")).toBe("reporting_");
    expect(getConnectionPrefix({ name: "reporting" })).toBe("reporting_");
    expect(getConnectionPrefix({})).toBe("");

    expect(getConnectionToken()).toBe(Sequelize);
    expect(getConnectionToken("default")).toBe(Sequelize);
    expect(getConnectionToken({})).toBe(Sequelize);
    expect(getConnectionToken("reporting")).toBe("reportingConnection");
    expect(getConnectionToken({ name: "reporting" })).toBe("reportingConnection");

    expect(getModelToken(UserModel)).toBe("UserModelRepository");
    expect(getModelToken(UserModel, "reporting")).toBe(
      "reporting_UserModelRepository",
    );
    expect(() => getModelToken(null as any)).toThrow(
      CircularDependencyException,
    );

    expect(generateString()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("retries failed connection attempts via Promise factory and Subscribable", async () => {
    let tries = 0;
    const res = await handleRetry(3, 5)(async () => {
      tries++;
      if (tries < 3) throw new Error("not-ready");
      return "ok";
    });
    expect(res).toBe("ok");
    expect(tries).toBe(3);

    await expect(
      handleRetry(2, 2)(async () => {
        throw new Error("always-fails");
      }),
    ).rejects.toThrow("always-fails");

    let subTries = 0;
    const subRes = await new Promise<string>((resolve, reject) => {
      handleRetry(3, 1)<string>({
        subscribe(obs: any) {
          subTries++;
          if (subTries < 2) {
            obs.error?.(new Error("sub-fail"));
          } else {
            obs.next?.("sub-success");
            obs.complete?.();
          }
          return { unsubscribe() {} };
        },
      }).subscribe({ next: resolve, error: reject });
    });
    expect(subRes).toBe("sub-success");
    expect(subTries).toBe(2);
  });
});

describe("@bunest/sequelize DI lifecycle & Bun SQLite integration", () => {
  it("loads models, authenticates, syncs, runs CRUD/transactions, and closes on shutdown", async () => {
    @Injectable()
    class UsersService {
      constructor(
        @InjectModel(UserModel) public readonly userModel: typeof UserModel,
        @InjectConnection() public readonly sequelize: Sequelize,
      ) {}
    }

    const mod = await Test.createTestingModule({
      imports: [
        SequelizeModule.forRoot({
          dialect: "sqlite",
          storage: ":memory:",
          autoLoadModels: true,
          synchronize: true,
        }),
        SequelizeModule.forFeature([UserModel]),
      ],
      providers: [UsersService],
    }).compile();

    await mod.init();

    const svc = mod.get(UsersService);
    expect(svc.sequelize).toBeInstanceOf(Sequelize);
    expect(svc.sequelize.isAuthenticated).toBe(true);
    expect(svc.sequelize.isSynced).toBe(true);
    expect(svc.sequelize.models.UserModel).toBe(UserModel);
    expect(svc.userModel).toBe(UserModel);

    const created = await svc.userModel.create({
      email: "a@bunest.dev",
      active: true,
    });
    expect(created.id).toBe(1);
    expect(await svc.userModel.findByPk(1)).toMatchObject({
      email: "a@bunest.dev",
    });

    await svc.userModel.bulkCreate([
      { email: "b@bunest.dev", active: false },
      { email: "c@bunest.dev", active: true },
    ]);
    const { rows, count } = await svc.userModel.findAndCountAll({
      where: { active: true },
    });
    expect(count).toBe(2);
    expect(rows).toHaveLength(2);

    const [affected] = await svc.userModel.update(
      { active: false },
      { where: { email: "a@bunest.dev" } },
    );
    expect(affected).toBe(1);

    // Transaction rollback
    await expect(
      svc.sequelize.transaction(async () => {
        await svc.userModel.create({ email: "rollback@bunest.dev", active: true });
        expect(await svc.userModel.count()).toBe(4);
        throw new Error("tx-rollback");
      }),
    ).rejects.toThrow("tx-rollback");
    expect(await svc.userModel.count()).toBe(3);

    const [rawRows] = await svc.sequelize.query("SELECT 42 AS answer");
    expect(rawRows).toEqual([{ answer: 42 }]);

    await mod.close();
    expect(svc.sequelize.isClosed).toBe(true);
  });

  it("supports repositoryMode & multi-connection isolation", async () => {
    @Injectable()
    class OrdersService {
      constructor(
        @InjectModel(OrderModel, "primary")
        public readonly primaryRepo: SequelizeRepository<OrderModel>,
        @InjectModel(OrderModel, "archive")
        public readonly archiveRepo: SequelizeRepository<OrderModel>,
        @InjectConnection("primary") public readonly primaryConn: Sequelize,
        @InjectConnection("archive") public readonly archiveConn: Sequelize,
      ) {}
    }

    const mod = await Test.createTestingModule({
      imports: [
        SequelizeModule.forRoot({
          name: "primary",
          dialect: "sqlite",
          storage: ":memory:",
          repositoryMode: true,
          autoLoadModels: true,
        }),
        SequelizeModule.forRoot({
          name: "archive",
          dialect: "sqlite",
          storage: ":memory:",
          repositoryMode: true,
          autoLoadModels: true,
          autoCloseConnection: false,
        }),
        SequelizeModule.forFeature([OrderModel], "primary"),
        SequelizeModule.forFeature([OrderModel], "archive"),
      ],
      providers: [OrdersService],
    }).compile();

    await mod.init();
    const svc = mod.get(OrdersService);
    expect(svc.primaryRepo).toBeInstanceOf(SequelizeRepository);
    expect(svc.archiveRepo).toBeInstanceOf(SequelizeRepository);
    expect(svc.primaryConn).not.toBe(svc.archiveConn);

    await svc.primaryRepo.create({ total: 100 });
    await svc.archiveRepo.create({ total: 500 });

    expect(await svc.primaryRepo.findAll()).toMatchObject([{ total: 100 }]);
    expect(await svc.archiveRepo.findAll()).toMatchObject([{ total: 500 }]);

    await mod.close();
    expect(svc.primaryConn.isClosed).toBe(true);
    // autoCloseConnection: false preserves archive connection
    expect(svc.archiveConn.isClosed).toBe(false);
    await svc.archiveConn.close();
  });

  it("supports forRootAsync (useFactory, useClass, useExisting) and retry with custom sequelizeFactory", async () => {
    let authAttempts = 0;
    let synced = false;
    let closed = false;

    const customFactory = async (
      opts: SequelizeModuleOptions,
    ): Promise<SequelizeLike> => {
      const inner = new Sequelize(opts);
      return {
        options: inner.options,
        repositoryMode: inner.repositoryMode,
        models: inner.models,
        addModels: (m) => inner.addModels(m),
        async authenticate() {
          authAttempts++;
          if (authAttempts < 2) {
            throw new Error("db-booting");
          }
          await inner.authenticate();
        },
        async sync(syncOpts) {
          synced = true;
          return inner.sync(syncOpts);
        },
        async close() {
          closed = true;
          await inner.close();
        },
        getRepository: (m) => inner.getRepository(m),
        model: (n) => inner.model(n),
        query: (s, o) => inner.query(s, o),
        transaction: (fn) => inner.transaction(fn),
      };
    };

    const modFactory = await Test.createTestingModule({
      imports: [
        SequelizeModule.forRootAsync({
          useFactory: () => ({
            dialect: "sqlite",
            storage: ":memory:",
            autoLoadModels: true,
            synchronize: true,
            retryAttempts: 3,
            retryDelay: 5,
            sequelizeFactory: customFactory,
          }),
        }),
        SequelizeModule.forFeature([UserModel]),
      ],
    }).compile();

    await modFactory.init();
    expect(authAttempts).toBe(2);
    expect(synced).toBe(true);
    await modFactory.close();
    expect(closed).toBe(true);

    // useClass + synchronize: false
    @Injectable()
    class SeqConfigFactory implements SequelizeOptionsFactory {
      createSequelizeOptions(): SequelizeModuleOptions {
        return {
          dialect: "sqlite",
          storage: ":memory:",
          autoLoadModels: true,
          synchronize: false,
        };
      }
    }

    const modClass = await Test.createTestingModule({
      imports: [
        SequelizeModule.forRootAsync({
          name: "nosync",
          useClass: SeqConfigFactory,
        }),
      ],
    }).compile();
    await modClass.init();
    const nosyncConn = modClass.get<Sequelize>(
      getConnectionToken("nosync") as any,
    );
    expect(nosyncConn.isAuthenticated).toBe(true);
    expect(nosyncConn.isSynced).toBe(false);
    await modClass.close();

    // useExisting
    @Module({
      providers: [SeqConfigFactory],
      exports: [SeqConfigFactory],
    })
    class SeqConfigModule {}

    const modExisting = await Test.createTestingModule({
      imports: [
        SequelizeModule.forRootAsync({
          name: "existing",
          imports: [SeqConfigModule],
          useExisting: SeqConfigFactory,
        }),
      ],
    }).compile();
    await modExisting.init();
    const existingConn = modExisting.get<Sequelize>(
      getConnectionToken("existing") as any,
    );
    expect(existingConn.isAuthenticated).toBe(true);
    await modExisting.close();
  });
});
