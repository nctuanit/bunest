import "reflect-metadata";
import { afterEach, expect, it } from "bun:test";
import {
  Injectable,
  type DynamicModule,
} from "../../../../../packages/common/src";
import {
  SqlModule,
  SqlService,
  getSqlConnectionToken,
  type SqlModuleForRootInput,
  type SqlOptionsFactory,
} from "../../../../../packages/sql/src";
import {
  SqliteModule,
  SqliteService,
  getSqliteConnectionToken,
  type SqliteModuleOptions,
  type SqliteOptionsFactory,
} from "../../../../../packages/sqlite/src";
import {
  Test,
  createSandbox,
  describeConformance,
} from "../../../_helpers/index";

@Injectable()
class SqliteOptionsFactoryImpl implements SqliteOptionsFactory {
  createSqliteOptions(): SqliteModuleOptions {
    return { filename: ":memory:" };
  }
}

@Injectable()
class SqlOptionsFactoryImpl implements SqlOptionsFactory {
  createSqlOptions(): SqlModuleForRootInput {
    return { url: "sqlite://:memory:" };
  }
}

describeConformance(
  "Persistence (typeorm-patterns) - module lifecycle shutdown",
  {
    upstreamPath: "typeorm/tests/unit/typeorm-core-shutdown.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002"],
    notes:
      "Adapts TypeOrmCoreModule shutdown matrix across sync/async default & named registrations to SqliteModule and SqlModule onModuleDestroy cleanup.",
  },
  () => {
    const sandbox = createSandbox();

    afterEach(() => {
      sandbox.restore();
    });

    it.each<{
      case: string;
      kind: "sqlite" | "sql";
      name: string;
      createModule: () => DynamicModule;
    }>([
      {
        case: "SqliteModule named forRootAsync (name only on async options)",
        kind: "sqlite",
        name: "secondary",
        createModule: () =>
          SqliteModule.forRootAsync({
            name: "secondary",
            useFactory: () => ({ filename: ":memory:" }),
          }),
      },
      {
        case: "SqliteModule named forRootAsync (useClass)",
        kind: "sqlite",
        name: "secondary",
        createModule: () =>
          SqliteModule.forRootAsync({
            name: "secondary",
            useClass: SqliteOptionsFactoryImpl,
          }),
      },
      {
        case: "SqliteModule unnamed forRootAsync",
        kind: "sqlite",
        name: "default",
        createModule: () =>
          SqliteModule.forRootAsync({
            useFactory: () => ({ filename: ":memory:" }),
          }),
      },
      {
        case: "SqliteModule named forRoot",
        kind: "sqlite",
        name: "secondary",
        createModule: () =>
          SqliteModule.forRoot({
            name: "secondary",
            filename: ":memory:",
          }),
      },
      {
        case: "SqliteModule unnamed forRoot",
        kind: "sqlite",
        name: "default",
        createModule: () => SqliteModule.forRoot({ filename: ":memory:" }),
      },
      {
        case: "SqlModule named forRootAsync (factory returns different name normalized to async name)",
        kind: "sql",
        name: "secondary",
        createModule: () =>
          SqlModule.forRootAsync({
            name: "secondary",
            useFactory: () => ({ name: "other", url: "sqlite://:memory:" }),
          }),
      },
      {
        case: "SqlModule named forRootAsync (useClass)",
        kind: "sql",
        name: "secondary",
        createModule: () =>
          SqlModule.forRootAsync({
            name: "secondary",
            useClass: SqlOptionsFactoryImpl,
          }),
      },
      {
        case: "SqlModule unnamed forRoot",
        kind: "sql",
        name: "default",
        createModule: () => SqlModule.forRoot("sqlite://:memory:"),
      },
    ])(
      "closes the connection on moduleRef.close() ($case)",
      async ({ kind, name, createModule }) => {
        const moduleRef = await Test.createTestingModule({
          imports: [createModule()],
        }).compile({ logger: false });

        await moduleRef.init();

        if (kind === "sqlite") {
          const svc = moduleRef.get<SqliteService>(
            getSqliteConnectionToken(name),
          );
          const closeSpy = sandbox.spy(svc, "close");

          expect(svc.connectionName).toBe(name);
          expect(svc.isClosed).toBe(false);
          expect(svc.healthCheck()).toBe(true);

          await moduleRef.close();

          expect(closeSpy.calledOnce).toBe(true);
          expect(svc.isClosed).toBe(true);
          expect(svc.healthCheck()).toBe(false);
        } else {
          const svc = moduleRef.get<SqlService>(getSqlConnectionToken(name));
          const closeSpy = sandbox.spy(svc, "close");

          expect(svc.connectionName).toBe(name);
          expect(svc.isClosed).toBe(false);
          expect(await svc.healthCheck()).toBe(true);

          await moduleRef.close();

          expect(closeSpy.calledOnce).toBe(true);
          expect(svc.isClosed).toBe(true);
          expect(await svc.healthCheck()).toBe(false);
        }
      },
    );

    it("rejects SqliteModule.forRootAsync when factory returns a conflicting connection name", async () => {
      await expect(
        Test.createTestingModule({
          imports: [
            SqliteModule.forRootAsync({
              name: "secondary",
              useFactory: () => ({ name: "other", filename: ":memory:" }),
            }),
          ],
        }).compile({ logger: false }),
      ).rejects.toThrow(/conflicting connection name "other"/);
    });

    it("keeps SqlService and SqliteService close() idempotent if manually closed before moduleRef.close()", async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [
          SqliteModule.forRoot({ filename: ":memory:" }),
          SqlModule.forRoot("sqlite://:memory:"),
        ],
      }).compile({ logger: false });

      await moduleRef.init();
      const sqlite = moduleRef.get(SqliteService);
      const sql = moduleRef.get(SqlService);

      sqlite.close();
      await sql.close();

      expect(sqlite.isClosed).toBe(true);
      expect(sql.isClosed).toBe(true);

      await expect(moduleRef.close()).resolves.toBeUndefined();
      expect(sqlite.isClosed).toBe(true);
      expect(sql.isClosed).toBe(true);
    });
  },
);
