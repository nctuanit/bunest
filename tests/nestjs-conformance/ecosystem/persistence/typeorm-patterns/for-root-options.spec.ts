import { expect, it } from "bun:test";
import type { DynamicModule, Provider } from "../../../../../packages/core/src/common";
import {
  DataSource,
  EntityManager,
  ORM_DATA_SOURCE_NAME,
  ORM_MODULE_OPTIONS,
  OrmCoreModule,
  OrmModule,
  getOrmDataSourceToken,
  getOrmEntityManagerToken,
} from "../../../../../packages/orm/src";
import { describeConformance } from "../../../_helpers/index";

type ValueProviderLike = Provider & { provide: unknown; useValue: unknown };

function findValueProvider<T>(
  providers: readonly Provider[] | undefined,
  token: unknown,
): T | undefined {
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
  return match?.useValue as T | undefined;
}

function exportedTokens(mod: DynamicModule): unknown[] {
  return (mod.exports ?? []).map((entry) =>
    typeof entry === "object" && entry !== null && "provide" in entry
      ? (entry as { provide: unknown }).provide
      : entry,
  );
}

describeConformance(
  "Persistence (typeorm-patterns) - forRoot dynamic module options resolution",
  {
    upstreamPath: "typeorm/tests/e2e/typeorm-module.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002"],
    notes:
      "Adapts TypeOrmModule.forRoot options provider inspection to @bunest/orm OrmModule.forRoot / OrmCoreModule.forRoot default & named DataSource tokens.",
  },
  () => {
    it("should register default DataSource & EntityManager class aliases when name is omitted", () => {
      const coreMod = OrmCoreModule.forRoot({
        type: "sqlite",
        database: ":memory:",
        enforceForeignKeys: true,
      });

      expect(findValueProvider<string>(coreMod.providers, ORM_DATA_SOURCE_NAME)).toBe(
        "default",
      );
      const opts = findValueProvider<Record<string, unknown>>(
        coreMod.providers,
        ORM_MODULE_OPTIONS,
      );
      expect(opts).toBeDefined();
      expect(opts!.type).toBe("sqlite");
      expect(opts!.database).toBe(":memory:");

      const exportsList = exportedTokens(coreMod);
      expect(exportsList).toContain(DataSource);
      expect(exportsList).toContain(EntityManager);
      expect(getOrmDataSourceToken()).toBe(DataSource);
      expect(getOrmEntityManagerToken()).toBe(EntityManager);

      const wrapper = OrmModule.forRoot({ type: "sqlite", database: ":memory:" });
      expect(wrapper.module).toBe(OrmModule);
      expect(wrapper.imports).toHaveLength(1);
    });

    it("should preserve explicit options.name under named tokens and omit default class aliases", () => {
      const coreMod = OrmCoreModule.forRoot({
        name: "fromOptions",
        type: "sqlite",
        database: ":memory:",
        busyTimeout: 2500,
      });

      expect(findValueProvider<string>(coreMod.providers, ORM_DATA_SOURCE_NAME)).toBe(
        "fromOptions",
      );
      const opts = findValueProvider<Record<string, unknown>>(
        coreMod.providers,
        ORM_MODULE_OPTIONS,
      );
      expect(opts).toBeDefined();
      expect(opts!.name).toBe("fromOptions");
      expect(opts!.busyTimeout).toBe(2500);

      const exportsList = exportedTokens(coreMod);
      expect(exportsList).toContain(getOrmDataSourceToken("fromOptions"));
      expect(exportsList).toContain(getOrmEntityManagerToken("fromOptions"));
      expect(exportsList).not.toContain(DataSource);
      expect(exportsList).not.toContain(EntityManager);
    });

    it("should preserve Bun.SQL URL options in OrmCoreModule.forRoot", () => {
      const urlObj = new URL("file:///tmp/bunest-for-root-options.sqlite");
      const coreMod = OrmCoreModule.forRoot({
        type: "sqlite",
        url: urlObj,
        useBunSql: true,
      });
      const opts = findValueProvider<Record<string, unknown>>(
        coreMod.providers,
        ORM_MODULE_OPTIONS,
      );
      expect(opts).toBeDefined();
      expect(opts!.url).toBe(urlObj);
      expect(opts!.useBunSql).toBe(true);
    });
  },
);
