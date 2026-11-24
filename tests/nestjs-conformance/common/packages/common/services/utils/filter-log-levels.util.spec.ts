import { expect, it } from "bun:test";
import { filterLogLevels } from "../../../../../../../packages/core/src/common";
import { describeConformance } from "../../../../../_helpers";

describeConformance(
  "filterLogLevels",
  {
    upstreamPath:
      "packages/common/test/services/utils/filter-log-levels.util.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    it("should correctly parse an exclusive range", () => {
      const returned = filterLogLevels(">warn");
      expect(returned).toEqual(["error", "fatal"]);
    });

    it("should correctly parse an inclusive range", () => {
      const returned = filterLogLevels(">=warn");
      expect(returned).toEqual(["warn", "error", "fatal"]);
    });

    it("should correctly parse a string list", () => {
      const returned = filterLogLevels("verbose,warn,fatal");
      expect(returned).toEqual(["verbose", "warn", "fatal"]);
    });

    it("should correctly parse a single log level", () => {
      const returned = filterLogLevels("debug");
      expect(returned).toEqual(["debug"]);
    });

    it("should return all otherwise", () => {
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
