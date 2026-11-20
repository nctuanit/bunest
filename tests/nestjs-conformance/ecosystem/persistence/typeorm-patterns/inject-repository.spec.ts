import "reflect-metadata";
import { expect, it } from "bun:test";
import { Injectable } from "../../../../../packages/common/src";
import {
  BaseSqliteRepository,
  InjectSqliteRepository,
  SqliteEntity,
  getSqliteRepositoryToken,
} from "../../../../../packages/sqlite/src";
import { Test, describeConformance } from "../../../_helpers/index";

interface PhotoRow extends Record<string, unknown> {
  id: number;
  name: string;
}

@SqliteEntity("photos")
class Photo {}

@Injectable()
class ByNamedConnection {
  constructor(
    @InjectSqliteRepository(Photo, "foo")
    readonly repository: BaseSqliteRepository<PhotoRow, number>,
  ) {}
}

@Injectable()
class ByDefaultConnection {
  constructor(
    @InjectSqliteRepository(Photo)
    readonly repository: BaseSqliteRepository<PhotoRow, number>,
  ) {}
}

@Injectable()
class ByTableNameOnNamedConnection {
  constructor(
    @InjectSqliteRepository("photos", "foo")
    readonly repository: BaseSqliteRepository<PhotoRow, number>,
  ) {}
}

describeConformance(
  "Persistence (typeorm-patterns) - @InjectSqliteRepository decorator",
  {
    upstreamPath: "typeorm/tests/unit/inject-repository.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002"],
    notes:
      "Adapts @InjectRepository + getRepositoryToken unit tests to @InjectSqliteRepository + getSqliteRepositoryToken for default and named connections.",
  },
  () => {
    const fooRepository = {} as BaseSqliteRepository<PhotoRow, number>;
    const defaultRepository = {} as BaseSqliteRepository<PhotoRow, number>;
    const tableRepository = {} as BaseSqliteRepository<PhotoRow, number>;

    async function resolve<T>(
      target: new (...args: any[]) => T,
      token: string,
      value: BaseSqliteRepository<PhotoRow, number>,
    ): Promise<T> {
      const moduleRef = await Test.createTestingModule({
        providers: [target, { provide: token, useValue: value }],
      }).compile({ logger: false });
      try {
        return moduleRef.get(target);
      } finally {
        await moduleRef.close();
      }
    }

    it("resolves repository token for a named connection", async () => {
      const instance = await resolve(
        ByNamedConnection,
        getSqliteRepositoryToken(Photo, "foo"),
        fooRepository,
      );
      expect(instance.repository).toBe(fooRepository);
    });

    it("resolves default connection and table-string targets to distinct tokens", async () => {
      expect(getSqliteRepositoryToken(Photo)).toBe(
        getSqliteRepositoryToken(Photo, "default"),
      );
      expect(getSqliteRepositoryToken(Photo, "foo")).not.toBe(
        getSqliteRepositoryToken(Photo, "default"),
      );

      const defaultInstance = await resolve(
        ByDefaultConnection,
        getSqliteRepositoryToken(Photo),
        defaultRepository,
      );
      const tableInstance = await resolve(
        ByTableNameOnNamedConnection,
        getSqliteRepositoryToken("photos", "foo"),
        tableRepository,
      );

      expect(defaultInstance.repository).toBe(defaultRepository);
      expect(tableInstance.repository).toBe(tableRepository);
    });
  },
);
