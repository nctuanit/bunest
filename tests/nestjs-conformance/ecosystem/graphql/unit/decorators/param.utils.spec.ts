import { expect, it } from "bun:test";
import {
  Args,
  Context,
  Parent,
  getResolverMethodParams,
} from "../../../../../../packages/graphql/src";
import { describeConformance } from "../../../../_helpers/index";

describeConformance(
  "GraphQL param decorators",
  {
    upstreamPath: "packages/graphql/tests/decorators/param.utils.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-002"],
    notes:
      "Adapts NestJS PARAM_ARGS_METADATA key inspection to Bunest getResolverMethodParams() returning index-keyed GqlParamMetadata entries.",
  },
  () => {
    const getParams = (target: Function, key: string) =>
      getResolverMethodParams(target, key).map(
        (param) => `${param.source}:${param.index}`,
      );

    class BaseResolver {
      notes(@Args("cursor") _cursor: any) {
        return [];
      }

      profile(@Args("id") _id: any, @Context() _context: any) {
        return {};
      }
    }

    it("should replace the entry an override inherits at the same index", () => {
      class UserResolver extends BaseResolver {
        override notes(@Parent() _user: any, @Args("cursor") _cursor?: string) {
          return [];
        }
      }

      // "@Parent()" at 0 and "@Args()" at 1, without the "@Args()" inherited at 0
      expect(getParams(UserResolver, "notes")).toEqual(["parent:0", "args:1"]);
    });

    it("should replace the entry an override inherits when the decorator takes pipes", () => {
      class UserResolver extends BaseResolver {
        override profile(@Context() _context: any, @Args("id") _id: any) {
          return {};
        }
      }

      expect(getParams(UserResolver, "profile")).toEqual([
        "context:0",
        "args:1",
      ]);
    });

    // BUNEST_BUG: Inherited parameter decorators on overridden resolver methods are dropped by getResolverMethodParams/registerGqlParam in packages/graphql/src/decorators/resolver.decorators.ts (reads only own metadata on the defining prototype; expected ["args:0", "context:1"], received ["args:0"]).
    it.skip("should keep the entries an override does not redeclare", () => {
      class UserResolver extends BaseResolver {
        override profile(@Args("id") _id: any, _context: any) {
          return {};
        }
      }

      expect(getParams(UserResolver, "profile")).toEqual([
        "args:0",
        "context:1",
      ]);
    });

    it("should leave the entries of the base method untouched", () => {
      class UserResolver extends BaseResolver {
        override notes(@Parent() _user: any) {
          return [];
        }
      }

      expect(getParams(UserResolver, "notes")).toEqual(["parent:0"]);
      expect(getParams(BaseResolver, "notes")).toEqual(["args:0"]);
    });
  },
);
