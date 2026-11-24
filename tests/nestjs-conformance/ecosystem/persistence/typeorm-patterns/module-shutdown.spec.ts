import { afterEach, expect, it } from "bun:test";
import {
  Injectable,
  type DynamicModule,
} from "../../../../../packages/core/src/common";
import {
  DataSource,
  OrmModule,
  getOrmDataSourceToken,
  type OrmDataSourceOptions,
  type OrmOptionsFactory,
} from "../../../../../packages/orm/src";
import {
  Test,
  createSandbox,
  describeConformance,
} from "../../../_helpers/index";

@Injectable()
class SqliteOrmOptionsFactory implements OrmOptionsFactory {
  createOrmOptions(): OrmDataSourceOptions {
    return { type: "sqlite", database: ":memory:" };
  }
}

@Injectable()
class BunSqlOrmOptionsFactory implements OrmOptionsFactory {
  createOrmOptions(): OrmDataSourceOptions {
    return { type: "sqlite", url: "sqlite://:memory:", useBunSql: true };
  }
}

describeConformance(
  "Persistence (typeorm-patterns) - module lifecycle shutdown",
  {
    upstreamPath: "typeorm/tests/unit/typeorm-core-shutdown.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002"],
    notes:
      "Adapts TypeOrmCoreModule shutdown matrix across sync/async default & named registrations to @bunest/orm OrmModule onApplicationShutdown cleanup for both SqliteOrmDriver and BunSqlOrmDriver.",
  },
  () => {
    const sandbox = createSandbox();

    afterEach(() => {
      sandbox.restore();
    });

    it.each<{
      case: string;
      name: string;
      createModule: () => DynamicModule;
    }>([
      {
        case: "SqliteOrmDriver named forRootAsync (useFactory)",
        name: "secondary",
        createModule: () =>
          OrmModule.forRootAsync({
            name: "secondary",
            useFactory: () => ({ type: "sqlite", database: ":memory:" }),
          }),
      },
      {
        case: "SqliteOrmDriver named forRootAsync (useClass)",
        name: "secondary",
        createModule: () =>
          OrmModule.forRootAsync({
            name: "secondary",
            useClass: SqliteOrmOptionsFactory,
          }),
      },
      {
        case: "SqliteOrmDriver unnamed forRootAsync",
        name: "default",
        createModule: () =>
          OrmModule.forRootAsync({
            useFactory: () => ({ type: "sqlite", database: ":memory:" }),
          }),
      },
      {
        case: "SqliteOrmDriver named forRoot",
        name: "secondary",
        createModule: () =>
          OrmModule.forRoot({
            name: "secondary",
            type: "sqlite",
            database: ":memory:",
          }),
      },
      {
        case: "SqliteOrmDriver unnamed forRoot",
        name: "default",
        createModule: () =>
          OrmModule.forRoot({ type: "sqlite", database: ":memory:" }),
      },
      {
        case: "BunSqlOrmDriver named forRootAsync (useFactory)",
        name: "secondary",
        createModule: () =>
          OrmModule.forRootAsync({
            name: "secondary",
            useFactory: () => ({
              type: "sqlite",
              url: "sqlite://:memory:",
              useBunSql: true,
            }),
          }),
      },
      {
        case: "BunSqlOrmDriver named forRootAsync (useClass)",
        name: "secondary",
        createModule: () =>
          OrmModule.forRootAsync({
            name: "secondary",
            useClass: BunSqlOrmOptionsFactory,
          }),
      },
      {
        case: "BunSqlOrmDriver unnamed forRoot",
        name: "default",
        createModule: () =>
          OrmModule.forRoot({
            type: "sqlite",
            url: "sqlite://:memory:",
            useBunSql: true,
          }),
      },
    ])(
      "destroys the DataSource on moduleRef.close() ($case)",
      async ({ name, createModule }) => {
        const moduleRef = await Test.createTestingModule({
          imports: [createModule()],
        }).compile({ logger: false });

        await moduleRef.init();

        const ds = moduleRef.get<DataSource>(getOrmDataSourceToken(name));
        const destroySpy = sandbox.spy(ds, "destroy");

        expect(ds.name).toBe(name);
        expect(ds.isInitialized).toBe(true);
        expect(await ds.ping()).toBe(true);

        await moduleRef.close();

        expect(destroySpy.calledOnce).toBe(true);
        expect(ds.isInitialized).toBe(false);
        expect(await ds.ping()).toBe(false);
      },
    );

    it("keeps DataSource.destroy() idempotent if manually destroyed before moduleRef.close()", async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [
          OrmModule.forRoot({ type: "sqlite", database: ":memory:" }),
          OrmModule.forRoot({
            name: "bun_sql",
            type: "sqlite",
            url: "sqlite://:memory:",
            useBunSql: true,
          }),
        ],
      }).compile({ logger: false });

      await moduleRef.init();
      const sqliteDs = moduleRef.get(DataSource);
      const bunSqlDs = moduleRef.get<DataSource>(
        getOrmDataSourceToken("bun_sql"),
      );

      await sqliteDs.destroy();
      await bunSqlDs.destroy();

      expect(sqliteDs.isInitialized).toBe(false);
      expect(bunSqlDs.isInitialized).toBe(false);

      await expect(moduleRef.close()).resolves.toBeUndefined();
      expect(sqliteDs.isInitialized).toBe(false);
      expect(bunSqlDs.isInitialized).toBe(false);
    });
  },
);
