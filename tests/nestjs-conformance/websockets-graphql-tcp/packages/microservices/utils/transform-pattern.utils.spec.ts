import { describe, expect, it } from "bun:test";
import {
  normalizePattern,
  type PatternInput,
} from "../../../../../../packages/microservices/src";
import { describeConformance, spyOnMethod } from "../../../../_helpers";

function equalTest(testPatterns: unknown[], expectedResults: string[]) {
  testPatterns.forEach((testPattern, index) => {
    const testData = normalizePattern(testPattern as PatternInput);
    expect(testData).toBe(expectedResults[index]!);
  });
}

describeConformance(
  "normalizePattern (transformPatternToRoute)",
  {
    upstreamPath:
      "packages/microservices/test/utils/transform-pattern.utils.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002"],
    notes:
      "Ports upstream transformPatternToRoute tests to Bunest normalizePattern(). Documents missing pattern complexity limits / exceedsPatternLimits().",
  },
  () => {
    describe("when gets 'number' value", () => {
      it("should return the 'number' wrapped in a string", () => {
        const testPatterns = [1, 150, 12345];
        const expectedResults = ["1", "150", "12345"];

        equalTest(testPatterns, expectedResults);
      });
    });

    describe("when gets 'string' value", () => {
      it("should return the same string unchanged", () => {
        const testPatterns = ["pattern1", "PaTteRn2", "3PaTteRn"];

        equalTest(testPatterns, testPatterns);
      });
    });

    describe("when gets 'RegExp' value", () => {
      it("should return its string representation including flags", () => {
        expect(normalizePattern(/^user\./)).toBe("/^user\\./");
        expect(normalizePattern(/orders\.\d+/gi)).toBe("/orders\\.\\d+/gi");
      });
    });

    describe("when gets 'JSON' value", () => {
      describe("without nested JSON (1 level)", () => {
        it("should return deterministic route regardless of key insertion order", () => {
          const testPatterns: PatternInput[] = [
            {
              controller: "app",
              use: "getHello",
            },
            {
              use: "getHello",
              controller: "app",
            },
            {
              service: "one",
              use: "getHello",
              controller: "app",
              id: 150,
            },
          ];

          const expectedResults = [
            JSON.stringify(testPatterns[0]),
            '{"controller":"app","use":"getHello"}',
            '{"controller":"app","id":150,"service":"one","use":"getHello"}',
          ];

          equalTest(testPatterns, expectedResults);
        });
      });

      describe("with nested JSON (2 levels)", () => {
        it("should canonically sort keys at both levels", () => {
          const testPatterns: PatternInput[] = [
            {
              controller: "app",
              use: { p1: "path1", p2: "path2", p3: 10 },
            },
            {
              use: { p1: "path1", p2: "path2" },
              controller: "app",
            },
            {
              service: "one",
              use: { p1: "path1", p2: "path2", id: 160 },
              controller: "app",
            },
          ];

          const expectedResults = [
            JSON.stringify(testPatterns[0]),
            '{"controller":"app","use":{"p1":"path1","p2":"path2"}}',
            '{"controller":"app","service":"one","use":{"id":160,"p1":"path1","p2":"path2"}}',
          ];

          equalTest(testPatterns, expectedResults);
        });
      });

      describe("with nested JSON (3 levels)", () => {
        it("should canonically sort keys at all 3 levels", () => {
          const testPatterns: PatternInput[] = [
            {
              controller: "app",
              use: { p1: "path1", p2: { pp1: "ppath1" } },
            },
            {
              use: { p1: "path1" },
              controller: { p2: "path2" },
            },
            {
              service: "one",
              use: { p1: "path1", p2: { pp1: "ppath1" } },
              controller: { p1: { pp1: "ppath1", id: 180 } },
            },
          ];

          const expectedResults = [
            JSON.stringify(testPatterns[0]),
            '{"controller":{"p2":"path2"},"use":{"p1":"path1"}}',
            '{"controller":{"p1":{"id":180,"pp1":"ppath1"}},"service":"one","use":{"p1":"path1","p2":{"pp1":"ppath1"}}}',
          ];

          equalTest(testPatterns, expectedResults);
        });
      });

      describe("with arrays inside object patterns", () => {
        it("should preserve arrays as JSON arrays and canonicalize objects inside arrays", () => {
          expect(normalizePattern({ cmd: [1, 2] })).toBe('{"cmd":[1,2]}');
          expect(
            normalizePattern({
              items: [
                { b: 2, a: 1 },
                { z: 9, y: 8 },
              ],
            }),
          ).toBe('{"items":[{"a":1,"b":2},{"y":8,"z":9}]}');
        });
      });

      describe("with primitive/null values inside object patterns", () => {
        it("should preserve null, booleans, and numbers", () => {
          expect(normalizePattern({ flag: true, empty: null, count: 0 })).toBe(
            '{"count":0,"empty":null,"flag":true}',
          );
        });
      });
    });

    describe("key order and localeCompare DoS resistance", () => {
      it("should sort ASCII keys deterministically in UTF-16 code unit order", () => {
        const keys = [
          "userid",
          "userZip",
          "B",
          "a",
          "service_id",
          "serviceName",
        ];
        const pattern = Object.fromEntries(keys.map((key, i) => [key, i]));
        const expected = keys
          .slice()
          .sort()
          .map((key) => `"${key}":${keys.indexOf(key)}`)
          .join(",");

        expect(normalizePattern(pattern)).toBe(`{${expected}}`);
      });

      it("should put non-ASCII keys after ASCII keys in UTF-16 code unit order", () => {
        expect(normalizePattern({ ä: 1, z: 2, é: 3, a: 4 })).toBe(
          '{"a":4,"z":2,"ä":1,"é":3}',
        );
      });

      it("should not call localeCompare on combining-mark or decomposing keys (immune to quadratic localeCompare DoS)", () => {
        const marks = "\u0344".repeat(60) + "\u0F71".repeat(191);
        const decomposing = "\uFB2C".repeat(100);
        const pattern = Object.fromEntries([
          ...["aaaaa", "aaaaA", "aaaAa", "aaAaa"].map(
            (prefix) => [prefix + marks, 0] as const,
          ),
          [decomposing + "a", 0] as const,
          [decomposing + "b", 0] as const,
          ["cmd", "x"] as const,
          ["id", 1] as const,
        ]);
        const localeCompareSpy = spyOnMethod(String.prototype, "localeCompare");

        try {
          const result = normalizePattern(pattern);
          expect(typeof result).toBe("string");
          expect(localeCompareSpy.notCalled).toBe(true);
        } finally {
          localeCompareSpy.restore();
        }
      });
    });

    describe("pattern complexity limits (NestJS v12 DoS protection parity)", () => {
      it("should return non-string/number/object values unchanged", () => {
        const sym = Symbol(213);
        expect(normalizePattern(null as unknown as PatternInput)).toBeNull();
        expect(
          normalizePattern(undefined as unknown as PatternInput),
        ).toBeUndefined();
        expect(normalizePattern(sym as unknown as PatternInput)).toBe(
          sym as unknown as string,
        );
      });

      it("should return special sentinel strings when exceeding max depth or max keys", () => {
        const deepNestedPattern = {
          a: { b: { c: { d: { e: { f: { g: "too deep" } } } } } },
        };
        const tooManyKeysPattern = Object.fromEntries(
          Array.from({ length: 25 }, (_, i) => [`key${i}`, `value${i}`]),
        );

        expect(normalizePattern(deepNestedPattern)).toBe(
          '{"a":{"b":{"c":{"d":{"e":{"f":[MAX_DEPTH_REACHED]}}}}}}',
        );
        expect(normalizePattern(tooManyKeysPattern)).toBe("[TOO_MANY_KEYS]");
      });

      it("should return [KEY_TOO_LONG] when a key exceeds max key length", () => {
        const longestKey = "k".repeat(256);
        expect(normalizePattern({ [`${longestKey}k`]: "value" })).toBe(
          "[KEY_TOO_LONG]",
        );
        expect(normalizePattern({ cmd: { [`${longestKey}k`]: "value" } })).toBe(
          '{"cmd":[KEY_TOO_LONG]}',
        );
      });

      it("should return [TOO_MANY_KEYS] for an array with more items than max keys", () => {
        const items = Array(21).fill(0);
        expect(normalizePattern({ cmd: items })).toBe(
          '{"cmd":[TOO_MANY_KEYS]}',
        );
      });

      it("should return [VALUE_TOO_LONG] when a string value exceeds max value length", () => {
        const longestValue = "v".repeat(4096);
        expect(normalizePattern({ cmd: `${longestValue}v` })).toBe(
          '{"cmd":[VALUE_TOO_LONG]}',
        );
      });

      it("should return [TOO_MANY_KEYS] when total keys across nested objects exceed limit", () => {
        const objectOfKeys = (count: number) =>
          Object.fromEntries(
            Array.from({ length: count }, (_, i) => [`key${i}`, i]),
          );
        const patternOfKeys = (objects: number, keysEach: number) =>
          Object.fromEntries(
            Array.from({ length: objects }, (_, i) => [
              `object${i}`,
              objectOfKeys(keysEach),
            ]),
          );

        expect(normalizePattern(patternOfKeys(5, 20))).toBe("[TOO_MANY_KEYS]");
      });
    });
  },
);
