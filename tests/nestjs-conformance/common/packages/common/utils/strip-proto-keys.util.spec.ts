import { describe, expect, it } from "bun:test";
import { stripProtoKeys } from "../../../../../../packages/core/src/common";
import { describeConformance } from "../../../../_helpers";

describeConformance(
  "stripProtoKeys",
  {
    upstreamPath: "packages/common/test/utils/strip-proto-keys.util.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    describe("with built-in JavaScript primitives", () => {
      it("should not throw error when processing Date objects", () => {
        const value = { date: new Date() };
        expect(() => stripProtoKeys(value)).not.toThrow();
      });

      it("should not throw error when processing RegExp objects", () => {
        const value = { regex: /test/i };
        expect(() => stripProtoKeys(value)).not.toThrow();
      });

      it("should not throw error when processing Error objects", () => {
        const value = { error: new Error("test") };
        expect(() => stripProtoKeys(value)).not.toThrow();
      });

      it("should not throw error when processing Map objects", () => {
        const value = { map: new Map() };
        expect(() => stripProtoKeys(value)).not.toThrow();
      });

      it("should not throw error when processing Set objects", () => {
        const value = { set: new Set() };
        expect(() => stripProtoKeys(value)).not.toThrow();
      });

      it("should preserve Date object properties", () => {
        const date = new Date();
        const value = { date };
        stripProtoKeys(value);
        expect(value.date).toBe(date);
        expect(value.date.constructor).toBe(Date);
      });
    });

    describe("with plain objects", () => {
      it("should still strip constructor from regular objects", () => {
        const value: Record<string, Record<string, unknown>> = {
          nested: { constructor: "malicious" },
        };
        stripProtoKeys(value);
        expect(
          Object.prototype.hasOwnProperty.call(value.nested, "constructor"),
        ).toBe(false);
      });

      it("should strip constructor whatever its value", () => {
        for (const constructor of [null, 0, false, ""]) {
          const value = { constructor, nested: { constructor } };
          stripProtoKeys(value);
          expect(Object.keys(value)).toEqual(["nested"]);
          expect(Object.keys(value.nested)).toEqual([]);
        }
      });

      it("should leave objects without a prototype as they are", () => {
        const value = Object.assign(Object.create(null), { id: 1 });
        stripProtoKeys(value);
        expect(value).toEqual({ id: 1 });
      });

      it("should strip __proto__ from objects", () => {
        const value = JSON.parse('{"__proto__": {"malicious": "code"}}');
        stripProtoKeys(value);
        expect(Object.prototype.hasOwnProperty.call(value, "__proto__")).toBe(
          false,
        );
      });

      it("should strip prototype from objects", () => {
        const value: Record<string, unknown> = {
          prototype: { malicious: "code" },
        };
        stripProtoKeys(value);
        expect(value).not.toHaveProperty("prototype");
      });

      it("should recursively strip nested objects", () => {
        const value: Record<string, any> = {
          level1: {
            constructor: "malicious",
            level2: {
              constructor: "alsoMalicious",
            },
          },
        };
        stripProtoKeys(value);
        expect(
          Object.prototype.hasOwnProperty.call(value.level1, "constructor"),
        ).toBe(false);
        expect(
          Object.prototype.hasOwnProperty.call(
            value.level1.level2,
            "constructor",
          ),
        ).toBe(false);
      });
    });

    describe("with arrays", () => {
      it("should process arrays recursively", () => {
        const value = {
          items: [
            { constructor: "malicious" },
            { constructor: "alsoMalicious" },
          ],
        };
        stripProtoKeys(value);
        expect(
          Object.prototype.hasOwnProperty.call(value.items[0], "constructor"),
        ).toBe(false);
        expect(
          Object.prototype.hasOwnProperty.call(value.items[1], "constructor"),
        ).toBe(false);
      });

      it("should not throw error when array contains Date objects", () => {
        const value = { dates: [new Date(), new Date()] };
        expect(() => stripProtoKeys(value)).not.toThrow();
      });

      it("should only read the items of a sparse array, not every index", () => {
        const items: unknown[] = [];
        items[999] = { constructor: "malicious" };
        const reads: PropertyKey[] = [];
        const value = {
          items: new Proxy(items, {
            get(target, key, receiver) {
              reads.push(key);
              return Reflect.get(target, key, receiver);
            },
          }),
        };
        stripProtoKeys(value);
        expect(reads).toEqual(["999"]);
        expect(
          Object.prototype.hasOwnProperty.call(items[999], "constructor"),
        ).toBe(false);
      });

      it("should strip the items of a sparse array with the largest index", () => {
        const items: unknown[] = [];
        items[2 ** 32 - 2] = { constructor: "malicious" };
        stripProtoKeys({ items });
        expect(items).toHaveLength(2 ** 32 - 1);
        expect(
          Object.prototype.hasOwnProperty.call(
            items[2 ** 32 - 2],
            "constructor",
          ),
        ).toBe(false);
      });
    });

    describe("with cycles", () => {
      it("should strip a self-referencing object", () => {
        const value: Record<string, unknown> = { constructor: "malicious" };
        value.self = value;

        expect(() => stripProtoKeys(value)).not.toThrow();
        expect(Object.prototype.hasOwnProperty.call(value, "constructor")).toBe(
          false,
        );
        expect(value.self).toBe(value);
      });

      it("should strip both objects of a cycle between two objects", () => {
        const user: Record<string, unknown> = { constructor: "malicious" };
        const profile: Record<string, unknown> = {
          constructor: "alsoMalicious",
        };
        user.profile = profile;
        profile.owner = user;

        expect(() => stripProtoKeys(user)).not.toThrow();
        expect(Object.prototype.hasOwnProperty.call(user, "constructor")).toBe(
          false,
        );
        expect(
          Object.prototype.hasOwnProperty.call(profile, "constructor"),
        ).toBe(false);
      });

      it("should strip a cycle that goes through an array", () => {
        const value: Record<string, any> = { constructor: "malicious" };
        value.items = [value, { constructor: "alsoMalicious" }];

        expect(() => stripProtoKeys(value)).not.toThrow();
        expect(Object.prototype.hasOwnProperty.call(value, "constructor")).toBe(
          false,
        );
        expect(
          Object.prototype.hasOwnProperty.call(value.items[1], "constructor"),
        ).toBe(false);
      });
    });

    describe("with deeply nested values", () => {
      it("should not overflow the stack on deeply nested objects", () => {
        const value: Record<string, any> = {};
        let current = value;
        for (let i = 0; i < 20_000; i++) {
          current.next = {};
          current = current.next;
        }
        current["constructor"] = "malicious";

        expect(() => stripProtoKeys(value)).not.toThrow();
        expect(
          Object.prototype.hasOwnProperty.call(current, "constructor"),
        ).toBe(false);
      });

      it("should not overflow the stack on deeply nested arrays", () => {
        const value: any[] = [];
        let current = value;
        for (let i = 0; i < 20_000; i++) {
          const next: any[] = [];
          current.push(next);
          current = next;
        }
        current.push({ constructor: "malicious" });

        expect(() => stripProtoKeys(value)).not.toThrow();
        expect(
          Object.prototype.hasOwnProperty.call(current[0], "constructor"),
        ).toBe(false);
      });
    });

    describe("Issue #16195: Jest useFakeTimers compatibility", () => {
      it("should handle Date objects with non-configurable constructor", () => {
        const value = { date: new Date() };

        Object.defineProperty(value.date, "constructor", {
          value: Date,
          writable: false,
          enumerable: false,
          configurable: false,
        });

        expect(() => stripProtoKeys(value)).not.toThrow();
      });

      it("should not attempt to delete constructor from built-in types", () => {
        const testCases = [
          { date: new Date() },
          { regex: /test/i },
          { error: new Error("test") },
          { map: new Map() },
          { set: new Set() },
        ];

        for (const testCase of testCases) {
          expect(() => stripProtoKeys(testCase)).not.toThrow();
        }
      });
    });
  },
);
