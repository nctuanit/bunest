import "reflect-metadata";
import { expect, it } from "bun:test";
import type { Provider } from "../../../../../packages/common/src";
import {
  SqlModule,
  SqlService,
  getSqlConnectionToken,
  getSqlOptionsToken,
} from "../../../../../packages/sql/src";
import {
  SqliteModule,
  SqliteService,
  getSqliteConnectionToken,
  getSqliteOptionsToken,
} from "../../../../../packages/sqlite/src";
import { describeConformance } from "../../../_helpers/index";

type ValueProviderLike = Provider & { provide: unknown; useValue: unknown };

function findOptionsValue(
  providers: readonly Provider[] | undefined,
  token: string,
): Record<string, unknown> | undefined {
  if (!providers) {
    return undefined;
  }
  const match = providers.find(
    (provider): provider is ValueProviderLike =>
      typeof provider === "object" &&
      provider !== null &&
      "provide" in provider &&
      "useValue" in provider &&
      (provider as ValueProviderLike).provide === token,
  );
  return match?.useValue as Record<string, unknown> | undefined;
}

describeConformance(
  "Persistence (typeorm-patterns) - forRoot dynamic module options resolution",
  {
    upstreamPath: "typeorm/tests/e2e/typeorm-module.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002"],
    notes:
      "Adapts TypeOrmModule.forRoot options provider inspection to SqliteModule.forRoot and SqlModule.forRoot default/named connection options tokens.",
  },
  () => {
    it("should register default connection options and class alias when name is omitted", () => {
      const sqliteMod = SqliteModule.forRoot({
        filename: ":memory:",
        foreignKeys: true,
      });
      const sqliteOpts = findOptionsValue(
        sqliteMod.providers,
        getSqliteOptionsToken(),
      );
      expect(sqliteOpts).toBeDefined();
      expect(sqliteOpts!.name).toBe("default");
      expect(sqliteOpts!.filename).toBe(":memory:");
      expect(sqliteMod.exports).toContain(getSqliteConnectionToken());
      expect(sqliteMod.exports).toContain(SqliteService);

      const sqlMod = SqlModule.forRoot({
        url: "sqlite://:memory:",
        connectOnInit: true,
      });
      const sqlOpts = findOptionsValue(sqlMod.providers, getSqlOptionsToken());
      expect(sqlOpts).toBeDefined();
      expect(sqlOpts!.name).toBe("default");
      expect(sqlOpts!.url).toBe("sqlite://:memory:");
      expect(sqlMod.exports).toContain(getSqlConnectionToken());
      expect(sqlMod.exports).toContain(SqlService);
    });

    it("should preserve explicit options.name under its named options token and omit default class alias", () => {
      const sqliteMod = SqliteModule.forRoot({
        name: "fromOptions",
        filename: ":memory:",
        busyTimeout: 2500,
      });
      const sqliteOpts = findOptionsValue(
        sqliteMod.providers,
        getSqliteOptionsToken("fromOptions"),
      );
      expect(sqliteOpts).toBeDefined();
      expect(sqliteOpts!.name).toBe("fromOptions");
      expect(sqliteOpts!.busyTimeout).toBe(2500);
      expect(sqliteMod.exports).toContain(
        getSqliteConnectionToken("fromOptions"),
      );
      expect(sqliteMod.exports).not.toContain(SqliteService);

      const sqlMod = SqlModule.forRoot({
        name: "analytics",
        url: "sqlite://:memory:",
      });
      const sqlOpts = findOptionsValue(
        sqlMod.providers,
        getSqlOptionsToken("analytics"),
      );
      expect(sqlOpts).toBeDefined();
      expect(sqlOpts!.name).toBe("analytics");
      expect(sqlMod.exports).toContain(getSqlConnectionToken("analytics"));
      expect(sqlMod.exports).not.toContain(SqlService);
    });

    it("should normalize string and URL shorthand inputs in SqlModule.forRoot", () => {
      const fromString = SqlModule.forRoot("sqlite://:memory:");
      const stringOpts = findOptionsValue(
        fromString.providers,
        getSqlOptionsToken(),
      );
      expect(stringOpts).toEqual({
        url: "sqlite://:memory:",
        name: "default",
      });

      const urlObj = new URL("file:///tmp/bunest-for-root-options.sqlite");
      const fromUrl = SqlModule.forRoot(urlObj);
      const urlOpts = findOptionsValue(fromUrl.providers, getSqlOptionsToken());
      expect(urlOpts).toBeDefined();
      expect(urlOpts!.url).toBe(urlObj);
      expect(urlOpts!.name).toBe("default");
    });
  },
);
