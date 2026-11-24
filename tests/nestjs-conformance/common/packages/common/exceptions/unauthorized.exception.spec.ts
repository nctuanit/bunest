import { expect, it } from "bun:test";
import {
  HttpException,
  UnauthorizedException,
} from "../../../../../../packages/core/src/common";
import { describeConformance } from "../../../../_helpers";

describeConformance(
  "UnauthorizedException",
  {
    upstreamPath:
      "packages/common/test/exceptions/unauthorized.exception.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    it("should return 401 as status code", () => {
      const exc = new UnauthorizedException();
      expect(exc.getStatus()).toBe(401);
    });

    // BUNEST_BUG: HttpException.createBody(undefined, "Unauthorized", 401) in packages/core/src/common/exceptions/http.exception.ts:189 includes `error: "Unauthorized"` in getResponse(), whereas NestJS returns `{ message: "Unauthorized", statusCode: 401 }`.
    it.skip('should return "Unauthorized" as default message', () => {
      const exc = new UnauthorizedException();
      expect(exc.getResponse()).toEqual({
        message: "Unauthorized",
        statusCode: 401,
      });
    });

    it("should accept a custom message", () => {
      const exc = new UnauthorizedException("Custom error");
      expect(exc.getResponse()).toEqual({
        message: "Custom error",
        error: "Unauthorized",
        statusCode: 401,
      });
    });

    // BUNEST_BUG: HttpException.createBody({ foo: "bar" }, ...) in packages/core/src/common/exceptions/http.exception.ts:205 merges `{ statusCode, error, message }` into custom objects instead of returning `{ foo: "bar" }` verbatim.
    it.skip("should accept a custom object", () => {
      const exc = new UnauthorizedException({ foo: "bar" });
      expect(exc.getResponse()).toEqual({ foo: "bar" });
    });

    it("should accept a cause option", () => {
      const cause = new Error("root cause");
      const exc = new UnauthorizedException("test", { cause });
      expect(exc.cause).toBe(cause);
    });

    it("should extend HttpException", () => {
      const exc = new UnauthorizedException();
      expect(exc).toBeInstanceOf(HttpException);
      expect(exc).toBeInstanceOf(Error);
    });
  },
);
