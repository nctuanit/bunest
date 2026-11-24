import { beforeEach, describe, expect, it } from "bun:test";
import { MetadataScanner } from "../../../../../packages/core/src";
import { describeConformance } from "../../../_helpers";

describeConformance(
  "MetadataScanner",
  {
    upstreamPath: "packages/core/test/metadata-scanner.spec.ts",
    category: "DIRECT_PORT",
    adrs: ["ADR-002"],
  },
  () => {
    let scanner: MetadataScanner;

    beforeEach(() => {
      scanner = new MetadataScanner();
    });

    describe("scanFromPrototype", () => {
      class Parent {
        constructor() {}
        public testParent() {}
        public testParent2() {}
        get propParent() {
          return "";
        }
        set valParent(_value: string) {}
      }

      class Test extends Parent {
        constructor() {
          super();
        }
        get prop() {
          return "";
        }
        set val(_value: string) {}
        public test() {}
        public test2() {}
      }

      it("should return only methods", () => {
        const methods = scanner.getAllMethodNames(Test.prototype);
        expect(methods).toEqual(["test", "test2", "testParent", "testParent2"]);
      });

      it("should return the same instance for the same prototype", () => {
        const methods1 = scanner.getAllMethodNames(Test.prototype);
        const methods2 = scanner.getAllMethodNames(Test.prototype);
        expect(methods1 === methods2).toEqual(true);
      });

      it("should keep compatibility with older methods", () => {
        const methods1 = scanner
          .getAllMethodNames(Test.prototype)
          .map((m) => m[0]);
        const methods2 = scanner.scanFromPrototype(
          new Test(),
          Test.prototype,
          (r) => r[0],
        );

        expect(methods1).toEqual(methods2);

        const methods3 = scanner.getAllMethodNames(Test.prototype);
        const methods4 = [
          ...new Set(scanner.getAllFilteredMethodNames(Test.prototype)),
        ];

        expect(methods3).toEqual(methods4);
      });
    });

    describe("getAllMethodNames", () => {
      it("should return empty array when prototype is null", () => {
        expect(scanner.getAllMethodNames(null)).toEqual([]);
      });

      it("should exclude getters and setters", () => {
        class WithAccessors {
          get myProp() {
            return 1;
          }
          set myProp(_v: number) {}
          method() {}
        }
        const methods = scanner.getAllMethodNames(WithAccessors.prototype);
        expect(methods).toContain("method");
        expect(methods).not.toContain("myProp");
      });

      it("should exclude non-function properties", () => {
        function MyClass() {}
        (MyClass.prototype as any).stringProp = "hello";
        (MyClass.prototype as any).realMethod = function () {};
        const methods = scanner.getAllMethodNames(MyClass.prototype);
        expect(methods).toContain("realMethod");
        expect(methods).not.toContain("stringProp");
      });
    });

    describe("scanFromPrototype (edge cases)", () => {
      it("should return empty array when prototype is null", () => {
        expect(scanner.scanFromPrototype({}, null, () => "x")).toEqual([]);
      });

      it("should skip nil return values from callback", () => {
        class Simple {
          a() {}
          b() {}
        }
        const result = scanner.scanFromPrototype(
          new Simple(),
          Simple.prototype,
          (name) => (name === "a" ? name : undefined),
        );
        expect(result).toEqual(["a"]);
      });
    });
  },
);
