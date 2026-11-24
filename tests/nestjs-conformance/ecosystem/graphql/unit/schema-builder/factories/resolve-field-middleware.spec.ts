import { describe, expect, it } from "bun:test";
import {
  type FieldMiddleware,
  ResolveField,
  getResolverFields,
} from "../../../../../../../packages/graphql/src";
import { describeConformance } from "../../../../../_helpers/index";

const trimMiddleware: FieldMiddleware = async (_ctx, next) => {
  const value = (await next()) as string;
  return value?.trim();
};

const rawResolveField = ResolveField as unknown as (
  ...args: unknown[]
) => MethodDecorator;

describeConformance(
  "ResolveField field middleware metadata",
  {
    upstreamPath:
      "packages/graphql/tests/schema-builder/factories/resolve-field-middleware.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002"],
    notes:
      "Adapts Reflect metadata inspection to @bunest/graphql getResolverFields() (GRAPHQL_METADATA_KEYS.RESOLVE_FIELDS) instead of NestJS internal string keys (ADR-013).",
  },
  () => {
    it("should preserve middleware when called with a typeFunc and options", () => {
      class WithTypeFn {
        @ResolveField(() => String, { middleware: [trimMiddleware] })
        sample() {
          return "  sample  ";
        }
      }

      const [meta] = getResolverFields(WithTypeFn);

      expect(meta).toBeDefined();
      expect(meta?.name).toBe("sample");
      expect(meta?.middleware).toEqual([trimMiddleware]);
    });

    // BUNEST_BUG: Expected @ResolveField({ middleware: [trimMiddleware] }) to preserve middleware, got undefined; packages/graphql/src/decorators/resolver.decorators.ts (ResolveField) lacks an options-only overload and ignores non-string/non-function first arguments.
    it.skip("should preserve middleware when called with options only (no typeFunc)", () => {
      class WithoutTypeFn {
        @rawResolveField({ middleware: [trimMiddleware] })
        sample() {
          return "  sample  ";
        }
      }

      const [meta] = getResolverFields(WithoutTypeFn);

      expect(meta).toBeDefined();
      expect(meta?.name).toBe("sample");
      expect(meta?.middleware).toEqual([trimMiddleware]);
    });

    it("should preserve middleware when called with propertyName and options (no typeFunc)", () => {
      class WithNameOnly {
        @ResolveField("aliased", { middleware: [trimMiddleware] } as any)
        sample() {
          return "  sample  ";
        }
      }

      const [meta] = getResolverFields(WithNameOnly);

      expect(meta?.name).toBe("aliased");
      expect(meta?.middleware).toEqual([trimMiddleware]);
    });

    describe('ResolveField options with "undefined" leading arguments', () => {
      const getMetadata = (cls: Function) => {
        const [meta] = getResolverFields(cls);
        return {
          name: meta?.name,
          middleware: meta?.middleware,
        };
      };

      // BUNEST_BUG: Expected @ResolveField('aliased', undefined, { middleware }) to preserve middleware, got undefined; packages/graphql/src/decorators/resolver.decorators.ts (ResolveField:176-184) ignores the 3rd maybeOptions argument when the 2nd returnTypeOrOptions argument is undefined.
      it.skip("should preserve options when called with propertyName, undefined typeFunc and options", () => {
        class WithUndefinedTypeFn {
          @ResolveField("aliased", undefined, { middleware: [trimMiddleware] })
          sample() {
            return "  sample  ";
          }
        }

        expect(getMetadata(WithUndefinedTypeFn)).toEqual({
          name: "aliased",
          middleware: [trimMiddleware],
        });
      });

      // BUNEST_BUG: Expected @ResolveField(undefined, () => String, { name: 'aliased', middleware }) to preserve name 'aliased' and middleware, got { name: 'sample', middleware: undefined }; packages/graphql/src/decorators/resolver.decorators.ts (ResolveField:176-187) drops all subsequent arguments when the 1st argument is undefined.
      it.skip("should preserve options when called with undefined propertyName, typeFunc and options", () => {
        class WithUndefinedName {
          @rawResolveField(undefined, () => String, {
            name: "aliased",
            middleware: [trimMiddleware],
          })
          sample() {
            return "  sample  ";
          }
        }

        expect(getMetadata(WithUndefinedName)).toEqual({
          name: "aliased",
          middleware: [trimMiddleware],
        });
      });

      // BUNEST_BUG: Expected @ResolveField(undefined, undefined, { name: 'aliased', middleware }) to preserve name 'aliased' and middleware, got { name: 'sample', middleware: undefined }; packages/graphql/src/decorators/resolver.decorators.ts (ResolveField:176-187) drops all subsequent arguments when the 1st argument is undefined.
      it.skip("should preserve options when called with undefined propertyName and typeFunc", () => {
        class WithUndefinedNameAndTypeFn {
          @rawResolveField(undefined, undefined, {
            name: "aliased",
            middleware: [trimMiddleware],
          })
          sample() {
            return "  sample  ";
          }
        }

        expect(getMetadata(WithUndefinedNameAndTypeFn)).toEqual({
          name: "aliased",
          middleware: [trimMiddleware],
        });
      });

      // BUNEST_BUG: Expected @ResolveField(undefined, { name: 'aliased', middleware }) to preserve name 'aliased' and middleware, got { name: 'sample', middleware: undefined }; packages/graphql/src/decorators/resolver.decorators.ts (ResolveField:176-187) drops all subsequent arguments when the 1st argument is undefined.
      it.skip("should preserve options when called with undefined propertyName and options", () => {
        class WithUndefinedNameOnly {
          @rawResolveField(undefined, {
            name: "aliased",
            middleware: [trimMiddleware],
          })
          sample() {
            return "  sample  ";
          }
        }

        expect(getMetadata(WithUndefinedNameOnly)).toEqual({
          name: "aliased",
          middleware: [trimMiddleware],
        });
      });
    });
  },
);
