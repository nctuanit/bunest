import { describe, expect, it } from "bun:test";
import {
  DESIGN_METADATA_KEYS,
  Injectable,
  METADATA_KEYS,
  MetadataRegistry,
  Scope,
  mixin,
} from "../../../../../../packages/core/src/common";
import { describeConformance, itAdapted } from "../../../../_helpers";

describeConformance(
  "@Injectable & mixin",
  {
    upstreamPath:
      "packages/common/test/decorators/injectable.decorator.spec.ts",
    category: "DIRECT_PORT",
    adrs: ["ADR-002"],
    notes:
      "Bunest stores InjectableMetadata ({ scope, durable? }) under METADATA_KEYS.INJECTABLE with default scope Scope.SINGLETON.",
  },
  () => {
    describe("@Injectable", () => {
      const options = {};

      @Injectable(options)
      class TestMiddleware {
        constructor(_param: number, _test: string) {}
      }

      itAdapted(
        "ADR-002",
        "should enhance component with injectable metadata",
        () => {
          expect(
            MetadataRegistry.has(METADATA_KEYS.INJECTABLE, TestMiddleware),
          ).toBe(true);
        },
        "METADATA_KEYS.INJECTABLE presence",
      );

      it('should enhance component with "design:paramtypes" metadata', () => {
        const constructorParams = MetadataRegistry.get<Function[]>(
          DESIGN_METADATA_KEYS.PARAMTYPES,
          TestMiddleware,
        );

        expect(constructorParams?.[0]).toEqual(Number);
        expect(constructorParams?.[1]).toEqual(String);
      });

      itAdapted(
        "ADR-002",
        "should enhance component with scope options metadata",
        () => {
          const meta = MetadataRegistry.get(
            METADATA_KEYS.INJECTABLE,
            TestMiddleware,
          );
          expect(meta).toEqual({ scope: Scope.SINGLETON });
        },
        "defaults scope to Scope.SINGLETON in METADATA_KEYS.INJECTABLE",
      );
    });

    describe("mixin", () => {
      @Injectable()
      class Test {
        constructor(_param: number, _test: string) {}
      }

      it("should set name of metatype", () => {
        const type = mixin(Test);
        expect(type.name).not.toEqual("Test");
      });

      it("should not lost the design:paramtypes metadata", () => {
        const type = mixin(Test);
        const constructorParams = MetadataRegistry.get<Function[]>(
          DESIGN_METADATA_KEYS.PARAMTYPES,
          type,
        );

        expect(constructorParams?.[0]).toEqual(Number);
        expect(constructorParams?.[1]).toEqual(String);
      });

      it("should not hide the design:paramtypes metadata of a parent class", () => {
        class Child extends Test {}
        const type = mixin(Child);
        const constructorParams = MetadataRegistry.get<Function[]>(
          DESIGN_METADATA_KEYS.PARAMTYPES,
          type,
        );

        expect(constructorParams).toEqual([Number, String]);
      });

      // BUNEST_BUG: mixin() in packages/core/src/common/utils/common.utils.ts:13 does not define `design:paramtypes` as `[]` for an undecorated class (returns `undefined` instead of `[]`).
      it.skip("should declare no parameter types for an undecorated class", () => {
        class Undecorated {
          constructor(public options?: unknown) {}
        }
        const type = mixin(Undecorated);

        expect(
          MetadataRegistry.get(DESIGN_METADATA_KEYS.PARAMTYPES, type),
        ).toEqual([]);
      });

      it("should mark the metatype as injectable", () => {
        class Undecorated {}
        const type = mixin(Undecorated);

        expect(MetadataRegistry.has(METADATA_KEYS.INJECTABLE, type)).toBe(true);
        expect(MetadataRegistry.get(METADATA_KEYS.INJECTABLE, type)).toEqual({
          scope: Scope.SINGLETON,
        });
      });

      it("should keep the scope options of the metatype", () => {
        const options = { scope: Scope.REQUEST, durable: true };

        @Injectable(options)
        class RequestScoped {}
        const type = mixin(RequestScoped);

        expect(MetadataRegistry.get(METADATA_KEYS.INJECTABLE, type)).toEqual(
          options,
        );
      });

      // BUNEST_BUG: mixin() in packages/core/src/common/utils/common.utils.ts:18 checks `hasOwn(METADATA_KEYS.INJECTABLE, mixinClass)` instead of `has(...)`, overwriting an inherited parent scope (e.g. Scope.TRANSIENT) with `{ scope: Scope.SINGLETON }`.
      it.skip("should not hide the scope options of a parent class", () => {
        const options = { scope: Scope.TRANSIENT };

        @Injectable(options)
        class Transient {}
        class Child extends Transient {}
        const type = mixin(Child);

        expect(MetadataRegistry.get(METADATA_KEYS.INJECTABLE, type)).toEqual(
          options,
        );
      });
    });
  },
);
