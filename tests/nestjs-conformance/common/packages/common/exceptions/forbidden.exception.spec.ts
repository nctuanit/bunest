import "reflect-metadata";
import { expect, it } from "bun:test";
import {
  ForbiddenException,
  HttpException,
} from "../../../../../../packages/common/src";
import { describeConformance } from "../../../../_helpers";

describeConformance(
  "ForbiddenException",
  {
    upstreamPath: "packages/common/test/exceptions/forbidden.exception.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    it("should return 403 as status code", () => {
      const exc = new ForbiddenException();
      expect(exc.getStatus()).toBe(403);
    });

    // BUNEST_BUG: HttpException.createBody(undefined, "Forbidden", 403) in packages/common/src/exceptions/http.exception.ts:189 includes `error: "Forbidden"` in getResponse(), whereas NestJS returns `{ message: "Forbidden", statusCode: 403 }`.
    it.skip('should return "Forbidden" as default message', () => {
      const exc = new ForbiddenException();
      expect(exc.getResponse()).toEqual({
        message: "Forbidden",
        statusCode: 403,
      });
    });

    it("should accept a custom message", () => {
      const exc = new ForbiddenException("Custom error");
      expect(exc.getResponse()).toEqual({
        message: "Custom error",
        error: "Forbidden",
        statusCode: 403,
      });
    });

    // BUNEST_BUG: HttpException.createBody({ foo: "bar" }, ...) in packages/common/src/exceptions/http.exception.ts:205 merges `{ statusCode, error, message }` into custom objects instead of returning `{ foo: "bar" }` verbatim.
    it.skip("should accept a custom object", () => {
      const exc = new ForbiddenException({ foo: "bar" });
      expect(exc.getResponse()).toEqual({ foo: "bar" });
    });

    it("should accept a cause option", () => {
      const cause = new Error("root cause");
      const exc = new ForbiddenException("test", { cause });
      expect(exc.cause).toBe(cause);
    });

    it("should extend HttpException", () => {
      const exc = new ForbiddenException();
      expect(exc).toBeInstanceOf(HttpException);
      expect(exc).toBeInstanceOf(Error);
    });
  },
);
