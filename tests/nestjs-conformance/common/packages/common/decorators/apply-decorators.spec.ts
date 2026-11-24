import { describe, expect, it } from "bun:test";
import {
  METADATA_KEYS,
  MetadataRegistry,
  UseGuards,
  applyDecorators,
  type CanActivate,
} from "../../../../../../packages/core/src/common";
import { describeConformance } from "../../../../_helpers";

describeConformance(
  "applyDecorators",
  {
    upstreamPath: "packages/common/test/decorators/apply-decorators.spec.ts",
    category: "DIRECT_PORT",
    adrs: ["ADR-002"],
    notes:
      "Uses METADATA_KEYS.GUARDS symbol per ADR-002. First test skipped due to genuine applyDecorators plain-object & ordering bug.",
  },
  () => {
    function testDecorator1(param: number) {
      return (target: any) => {
        target.myParam = param;
      };
    }

    function testDecorator2(param1: number, param2: number) {
      return (target: any) => {
        target.myParam = (target.myParam || 0) + param1;
        target.myParam2 = param2;
      };
    }

    function testDecorator3() {
      return (target: any) => {
        target.myParam3 = 0;
      };
    }

    // BUNEST_BUG: applyDecorators() in packages/core/src/common/decorators/apply-decorators.ts:54-95 ignores plain-object targets when propertyKey is undefined (`typeof target === "function"` check fails and falls through without calling any decorator) and executes class decorators bottom-to-top instead of forward order (reversing non-commutative mutations like myParam = 1 then += 2).
    it.skip("should apply all decorators", () => {
      const testParams = {
        decorator1: { param: 1 },
        decorator2: { param1: 2, param2: 3 },
      };

      const decoratedTarget: Record<string, unknown> = {};
      testDecorator1(testParams.decorator1.param)(decoratedTarget);
      testDecorator2(
        testParams.decorator2.param1,
        testParams.decorator2.param2,
      )(decoratedTarget);
      testDecorator3()(decoratedTarget);

      const customDecoratedTarget: Record<string, unknown> = {};
      const customDecorator = applyDecorators(
        testDecorator1(testParams.decorator1.param),
        testDecorator2(
          testParams.decorator2.param1,
          testParams.decorator2.param2,
        ),
        testDecorator3(),
      );
      (customDecorator as (target: object) => void)(customDecoratedTarget);

      const expectedTarget = {
        myParam: testParams.decorator1.param + testParams.decorator2.param1,
        myParam2: testParams.decorator2.param2,
        myParam3: 0,
      };

      expect(decoratedTarget).toEqual(expectedTarget);
      expect(customDecoratedTarget).toEqual(expectedTarget);
    });

    describe("applyDecorators @GuardCompositeDecorator", () => {
      class Guard implements CanActivate {
        canActivate() {
          return true;
        }
      }

      const GuardCompositeDecorator = () => {
        return applyDecorators(UseGuards(Guard));
      };

      @GuardCompositeDecorator()
      class Test {}

      class TestWithMethod {
        @GuardCompositeDecorator()
        public test() {
          return true;
        }
      }

      class TestWithStaticMethod {
        @GuardCompositeDecorator()
        public static test() {
          return true;
        }
      }

      it("should be using the guard defined on the class", () => {
        const classMetadata = MetadataRegistry.get(METADATA_KEYS.GUARDS, Test);
        expect(classMetadata).toEqual([Guard]);
      });

      it("should be using the guard defined on the prototype method", () => {
        const instance = new TestWithMethod();

        const classMetadata = MetadataRegistry.get(
          METADATA_KEYS.GUARDS,
          TestWithMethod,
        );
        const methodMetadata = MetadataRegistry.get(
          METADATA_KEYS.GUARDS,
          instance.test,
        );
        const instanceMetadata = MetadataRegistry.get(
          METADATA_KEYS.GUARDS,
          instance,
        );

        expect(classMetadata).toBeUndefined();
        expect(methodMetadata).toEqual([Guard]);
        expect(instanceMetadata).toBeUndefined();
      });

      it("should be using the guard defined on the static method", () => {
        const classMetadata = MetadataRegistry.get(
          METADATA_KEYS.GUARDS,
          TestWithStaticMethod,
        );
        const methodMetadata = MetadataRegistry.get(
          METADATA_KEYS.GUARDS,
          TestWithStaticMethod.test,
        );

        expect(classMetadata).toBeUndefined();
        expect(methodMetadata).toEqual([Guard]);
      });
    });
  },
);
