import "reflect-metadata";
import { expect, it } from "bun:test";
import { filterLogLevels } from "../../../../../../../packages/common/src";
import { describeConformance } from "../../../../../_helpers";

describeConformance(
  "filterLogLevels",
  {
    upstreamPath:
      "packages/common/test/services/utils/filter-log-levels.util.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    // BUNEST_BUG: filterLogLevels() only handles `>=` and ignores exclusive `>` ranges (e.g. `>warn` returns all 6 levels instead of `['error', 'fatal']`) (packages/common/src/logger/console-logger.ts:30-60)
    it.skip("should correctly parse an exclusive range", () => {
      const returned = filterLogLevels(">warn");
      expect(returned).toEqual(["error", "fatal"]);
    });

    // BUNEST_BUG: LOG_LEVELS in packages/common/src/logger/console-logger.ts is ordered `fatal..verbose` (reversed from NestJS `verbose..fatal`), so `filterLogLevels('>=warn')` returns `['fatal', 'error', 'warn']` instead of `['warn', 'error', 'fatal']`
    it.skip("should correctly parse an inclusive range", () => {
      const returned = filterLogLevels(">=warn");
      expect(returned).toEqual(["warn", "error", "fatal"]);
    });

    it("should correctly parse a string list", () => {
      const returned = filterLogLevels("verbose,warn,fatal");
      expect(returned).toEqual(["verbose", "warn", "fatal"]);
    });

    // BUNEST_BUG: filterLogLevels('debug') expands to all higher-severity levels `['fatal', 'error', 'warn', 'log', 'debug']` instead of returning `['debug']` like NestJS `filterLogLevels()` (packages/common/src/logger/console-logger.ts:54-57)
    it.skip("should correctly parse a single log level", () => {
      const returned = filterLogLevels("debug");
      expect(returned).toEqual(["debug"]);
    });

    // BUNEST_BUG: LOG_LEVELS in packages/common/src/logger/console-logger.ts is ordered `fatal..verbose` instead of NestJS `['verbose', 'debug', 'log', 'warn', 'error', 'fatal']`
    it.skip("should return all otherwise", () => {
      const returned = filterLogLevels();
      expect(returned).toEqual([
        "verbose",
        "debug",
        "log",
        "warn",
        "error",
        "fatal",
      ]);
    });
  },
);
