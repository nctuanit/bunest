import { afterEach, beforeEach, expect, it, mock } from "bun:test";
import type { GraphQLResolveInfo } from "../../../../../../packages/graphql/src";
import type {
  MiddlewareContext,
  NextFn,
} from "../../../../../../packages/graphql/src";
import { describeConformance } from "../../../../_helpers/index";

export const testMiddleware = async (ctx: MiddlewareContext, next: NextFn) => {
  let logData: MiddlewareContext = {
    source: ctx.source,
    args: ctx.args,
    context: ctx.context,
  };

  if (ctx.info) {
    logData = {
      ...logData,
      info: ctx.info,
    };
  }
  void logData;

  return next();
};

describeConformance(
  "testMiddleware",
  {
    upstreamPath:
      "packages/graphql/tests/middleware/middleware-type-check.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    let mockContext: MiddlewareContext;
    let mockNext: ReturnType<typeof mock<NextFn>>;

    beforeEach(() => {
      mockContext = {
        source: {},
        args: {},
        context: {},
        info: {
          path: { typename: "TestType", key: "testField" },
        } as unknown as GraphQLResolveInfo,
      };

      mockNext = mock(() => Promise.resolve("next result"));
    });

    afterEach(() => {
      mockNext.mockClear();
    });

    it("should call next when info is provided", async () => {
      await testMiddleware(mockContext, mockNext);
      expect(mockNext).toHaveBeenCalled();
    });

    it("should handle case when info is undefined", async () => {
      mockContext.info = undefined;
      await testMiddleware(mockContext, mockNext);
      expect(mockNext).toHaveBeenCalled();
    });

    it("should handle case when info is null", async () => {
      mockContext.info = null;
      await testMiddleware(mockContext, mockNext);
      expect(mockNext).toHaveBeenCalled();
    });
  },
);
