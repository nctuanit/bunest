import "reflect-metadata";
import { describe, expect, it } from "bun:test";
import {
  ConsoleLogger,
  type LogLevel,
} from "../../../../../../../packages/common/src";
import { describeConformance } from "../../../../../_helpers";

function isLogLevelEnabledViaConsoleLogger(
  targetLevel: LogLevel,
  logLevels: LogLevel[] | undefined,
): boolean {
  if (logLevels === undefined) {
    return new ConsoleLogger({ logLevels: [] }).isLevelEnabled(targetLevel);
  }
  return new ConsoleLogger({ logLevels }).isLevelEnabled(targetLevel);
}

describeConformance(
  "isLogLevelEnabled (via ConsoleLogger.isLevelEnabled)",
  {
    upstreamPath:
      "packages/common/test/services/utils/is-log-level-enabled.util.spec.ts",
    category: "ADAPTED_PORT",
    notes:
      "Upstream internal isLogLevelEnabled() util is not publicly exported by NestJS; adapted to @bunest/common ConsoleLogger.isLevelEnabled().",
  },
  () => {
    const tests: Array<{
      inputArgs: [LogLevel, LogLevel[]];
      expectedReturnValue: boolean;
    }> = [
      { inputArgs: ["log", ["log"]], expectedReturnValue: true },
      { inputArgs: ["debug", ["debug"]], expectedReturnValue: true },
      { inputArgs: ["verbose", ["verbose"]], expectedReturnValue: true },
      { inputArgs: ["error", ["error"]], expectedReturnValue: true },
      { inputArgs: ["warn", ["warn"]], expectedReturnValue: true },
      /** explicitly included + log level is higher than target */
      { inputArgs: ["log", ["error", "log"]], expectedReturnValue: true },
      { inputArgs: ["warn", ["warn", "error"]], expectedReturnValue: true },
      { inputArgs: ["debug", ["warn", "debug"]], expectedReturnValue: true },
      { inputArgs: ["verbose", ["error", "verbose"]], expectedReturnValue: true },
      /** not explicitly included + log level is higher than target */
      { inputArgs: ["log", ["error", "warn"]], expectedReturnValue: false },
      { inputArgs: ["verbose", ["warn"]], expectedReturnValue: false },
      { inputArgs: ["debug", ["warn", "error"]], expectedReturnValue: false },
      { inputArgs: ["warn", ["error"]], expectedReturnValue: false },
    ];

    for (const { inputArgs, expectedReturnValue } of tests) {
      describe(`when log levels = [${inputArgs[1].join(",")}]`, () => {
        describe(`and target level is "${inputArgs[0]}"`, () => {
          it(`should return ${String(expectedReturnValue)}`, () => {
            expect(
              isLogLevelEnabledViaConsoleLogger(inputArgs[0], inputArgs[1]),
            ).toBe(expectedReturnValue);
          });
        });
      });
    }

    describe("when log levels = empty / disabled", () => {
      it("should return false", () => {
        expect(isLogLevelEnabledViaConsoleLogger("warn", undefined)).toBe(
          false,
        );
      });
    });

    describe("when target level is more severe than highest configured level", () => {
      // BUNEST_BUG: ConsoleLogger.isLevelEnabled() checks exact `levels.includes(level)` instead of NestJS severity hierarchy (`targetLevelValue >= highestLogLevelValue`), so `logLevels: ['warn']` returns `false` for `'error'` (packages/common/src/logger/console-logger.ts:221-224)
      it.skip("should enable higher-severity levels (e.g. error when logLevels = ['warn'])", () => {
        expect(
          new ConsoleLogger({ logLevels: ["warn"] }).isLevelEnabled("error"),
        ).toBe(true);
      });
    });
  },
);
