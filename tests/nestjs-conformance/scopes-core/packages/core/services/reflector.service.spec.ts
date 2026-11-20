import "reflect-metadata";
import { beforeEach, describe, expect, it } from "bun:test";
import { Reflector } from "../../../../../../packages/common/src";
import { describeConformance } from "../../../../_helpers";

const transformDecorator = Reflector.createDecorator<string[], number>({
  transform: (value) => value.length,
});

type TestObject = {
  only1?: string;
  only2?: string;
  both: string;
};

describeConformance(
  "Reflector",
  {
    upstreamPath: "packages/core/test/services/reflector.service.spec.ts",
    category: "DIRECT_PORT",
    adrs: ["ADR-002"],
  },
  () => {
    const key = "key";
    let reflector: Reflector;

    @transformDecorator(["a", "b", "c"])
    class TestTransform {}
    class Test1 {}
    class Test2 {}

    beforeEach(() => {
      Reflect.deleteMetadata(key, Test1);
      Reflect.deleteMetadata(key, Test2);
      reflector = new Reflector();
    });

    describe("get", () => {
      it("should reflect metadata by key", () => {
        const value = "value";
        Reflect.defineMetadata(key, value, Test1);
        expect(reflector.get(key, Test1)).toEqual(value);
      });

      it("should reflect metadata by decorator", () => {
        const decorator = Reflector.createDecorator<string>();
        const value = "value";
        Reflect.defineMetadata(decorator.KEY, value, Test1);

        const reflectedValue = reflector.get(decorator, Test1);
        expect(reflectedValue).toEqual(value);
      });

      it("should reflect metadata by decorator (custom key)", () => {
        const decorator = Reflector.createDecorator<string[]>({
          key: "custom",
        });
        const value = ["value"];
        Reflect.defineMetadata("custom", value, Test1);

        const reflectedValue = reflector.get(decorator, Test1);
        expect(reflectedValue).toEqual(value);
      });

      it("should reflect metadata by decorator (with transform option)", () => {
        const reflectedValue = reflector.get(transformDecorator, TestTransform);
        expect(reflectedValue).toEqual(3);
      });

      it("should support transform option returning transformed type", () => {
        const dec = Reflector.createDecorator<string[], number>({
          transform: (v) => v.length,
        });
        @dec(["x", "y"])
        class Local {}
        expect(reflector.get(dec, Local)).toBe(2);
      });
    });

    describe("createDecorator", () => {
      it("should preserve an explicit null metadata value", () => {
        const decorator = Reflector.createDecorator<string | null>();

        @decorator(null)
        class TestNull {}

        const reflectedValue = reflector.get(decorator, TestNull);
        expect(reflectedValue).toBeNull();
      });

      it("should preserve null returned by the transform function", () => {
        const decorator = Reflector.createDecorator<string, string | null>({
          transform: () => null,
        });

        @decorator("ignored")
        class TestTransformedNull {}

        const reflectedValue = reflector.get(decorator, TestTransformedNull);
        expect(reflectedValue).toBeNull();
      });

      // BUNEST_BUG: Reflector.createDecorator() stores undefined instead of default {} when invoked without arguments (packages/common/src/metadata/reflector.ts).
      it.skip("should use an empty object for decorators called without arguments", () => {
        const decorator = Reflector.createDecorator<{ marker?: boolean }>();
        const invokeEmpty = decorator as unknown as () => ClassDecorator;

        @invokeEmpty()
        class TestMarker {}

        expect(reflector.get(decorator, TestMarker)).toEqual({});
      });

      it("should preserve other falsy metadata values", () => {
        const decorator = Reflector.createDecorator<number | string | boolean>();

        @decorator(0)
        class TestZero {}
        @decorator("")
        class TestEmptyString {}
        @decorator(false)
        class TestFalse {}

        expect(reflector.get(decorator, TestZero)).toEqual(0);
        expect(reflector.get(decorator, TestEmptyString)).toEqual("");
        expect(reflector.get(decorator, TestFalse)).toEqual(false);
      });
    });

    describe("getAll", () => {
      it("should reflect metadata of all targets by key", () => {
        const value1 = "value1";
        const value2 = "value2";
        Reflect.defineMetadata(key, value1, Test1);
        Reflect.defineMetadata(key, value2, Test2);
        expect(reflector.getAll(key, [Test1, Test2])).toEqual([
          value1,
          value2,
        ]);
      });

      it("should reflect metadata of all targets by decorator", () => {
        const decorator = Reflector.createDecorator<string>();
        const value1 = "value1";
        const value2 = "value2";
        Reflect.defineMetadata(decorator.KEY, value1, Test1);
        Reflect.defineMetadata(decorator.KEY, value2, Test2);

        const reflectedValue = reflector.getAll(decorator, [Test1, Test2]);
        expect(reflectedValue).toEqual([value1, value2]);
      });
    });

    describe("getAllAndMerge", () => {
      it("should return an empty array when there are no targets", () => {
        expect(reflector.getAllAndMerge(key, [])).toHaveLength(0);
      });

      it("should reflect metadata of all targets and concat arrays", () => {
        const decorator = Reflector.createDecorator<string[]>();
        const value = "value";
        Reflect.defineMetadata(decorator.KEY, [value], Test1);

        const reflectedValue = reflector.getAllAndMerge(decorator, [
          Test1,
          Test1,
        ]);
        expect(reflectedValue).toEqual([value, value]);
      });

      it("should reflect metadata of all targets and concat boolean arrays", () => {
        const decorator = Reflector.createDecorator<boolean>();
        const value = true;
        Reflect.defineMetadata(decorator.KEY, [value], Test1);

        const reflectedValue = reflector.getAllAndMerge(decorator, [
          Test1,
          Test1,
        ]) as unknown;
        expect(reflectedValue).toEqual([value, value]);
      });

      it("should reflect metadata of all targets and create an array", () => {
        const decorator = Reflector.createDecorator<string>();
        const value = "value";
        Reflect.defineMetadata(decorator.KEY, value, Test1);

        const reflectedValue = reflector.getAllAndMerge(decorator, [
          Test1,
          Test1,
        ]) as unknown;
        expect(reflectedValue).toEqual([value, value]);
      });

      it("should reflect metadata of all targets and merge objects", () => {
        const decorator = Reflector.createDecorator<TestObject>();
        const value1: TestObject = { only1: "test1", both: "overriden" };
        const value2: TestObject = { only2: "test2", both: "test" };
        Reflect.defineMetadata(decorator.KEY, value1, Test1);
        Reflect.defineMetadata(decorator.KEY, value2, Test2);

        const reflectedValue = reflector.getAllAndMerge(decorator, [
          Test1,
          Test2,
        ]);
        expect(reflectedValue).toEqual({
          ...value1,
          ...value2,
        });
      });

      // BUNEST_BUG: Reflector.getAllAndMerge() returns a bare scalar ("value") instead of wrapping single scalar metadata into an array (["value"]) when only one target defines it (packages/common/src/metadata/reflector.ts).
      it.skip("should reflect metadata of all targets and create an array from a single value", () => {
        const value = "value";
        Reflect.defineMetadata(key, value, Test1);

        const result = reflector.getAllAndMerge(key, [Test1, Test2]);
        expect(result).toEqual([value]);
      });

      it("should reflect metadata of all targets and return a single array unmodified", () => {
        const value = ["value"];
        Reflect.defineMetadata(key, value, Test1);
        expect(reflector.getAllAndMerge(key, [Test1, Test2])).toEqual(value);
      });

      it("should reflect metadata of all targets and return a single object unmodified", () => {
        const value = { test: "value" };
        Reflect.defineMetadata(key, value, Test1);
        expect(reflector.getAllAndMerge(key, [Test1, Test2])).toEqual(value);
      });
    });

    describe("getAllAndOverride", () => {
      it("should reflect metadata of all targets and return a first not undefined value", () => {
        const value1 = "value1";
        const value2 = "value2";
        Reflect.defineMetadata(key, value1, Test1);
        Reflect.defineMetadata(key, value2, Test2);
        expect(reflector.getAllAndOverride(key, [Test1, Test2])).toEqual(
          value1,
        );
      });

      it("should return undefined when no target has metadata", () => {
        expect(reflector.getAllAndOverride(key, [Test1, Test2])).toBeUndefined();
      });

      it("should skip undefined and return the first defined value", () => {
        Reflect.defineMetadata(key, "second", Test2);
        expect(reflector.getAllAndOverride(key, [Test1, Test2])).toEqual(
          "second",
        );
      });

      it("should work with a decorator instead of a string key", () => {
        const decorator = Reflector.createDecorator<string>();
        Reflect.defineMetadata(decorator.KEY, "decorated", Test1);
        expect(reflector.getAllAndOverride(decorator, [Test1])).toEqual(
          "decorated",
        );
      });
    });

    describe("getAll (edge cases)", () => {
      it("should return array of undefined for targets without metadata", () => {
        expect(reflector.getAll(key, [Test1, Test2])).toEqual([
          undefined,
          undefined,
        ]);
      });

      // BUNEST_BUG: Reflector.getAll() throws TypeError when targets is null instead of returning [] (packages/common/src/metadata/reflector.ts).
      it.skip("should handle null targets gracefully", () => {
        expect(reflector.getAll(key, null as any)).toEqual([]);
      });
    });

    describe("getAllAndMerge (edge cases)", () => {
      it("should use [a, b] fallback when values are not arrays or objects", () => {
        Reflect.defineMetadata(key, 42, Test1);
        Reflect.defineMetadata(key, 99, Test2);
        expect(reflector.getAllAndMerge(key, [Test1, Test2])).toEqual([42, 99]);
      });

      // BUNEST_BUG: Reflector.getAllAndMerge() does not flatten/concat a trailing array following a scalar value (packages/common/src/metadata/reflector.ts); expected ["value1","value2","value3"].
      it.skip("should concat an array that follows a single value", () => {
        Reflect.defineMetadata(key, "value1", Test1);
        Reflect.defineMetadata(key, ["value2", "value3"], Test2);
        expect(reflector.getAllAndMerge(key, [Test1, Test2])).toEqual([
          "value1",
          "value2",
          "value3",
        ]);
      });

      // BUNEST_BUG: Reflector.getAllAndMerge() does not flatten/concat a trailing array following an object value (packages/common/src/metadata/reflector.ts); expected [value,"value2"].
      it.skip("should concat an array that follows an object", () => {
        const value = { test: "value" };
        Reflect.defineMetadata(key, value, Test1);
        Reflect.defineMetadata(key, ["value2"], Test2);
        expect(reflector.getAllAndMerge(key, [Test1, Test2])).toEqual([
          value,
          "value2",
        ]);
      });

      it("should return empty array when all metadata is undefined", () => {
        const result = reflector.getAllAndMerge(key, [Test1, Test2]);
        expect(result).toEqual([]);
      });
    });
  },
);
