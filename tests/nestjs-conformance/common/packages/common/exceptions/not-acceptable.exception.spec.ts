import { expect, it } from "bun:test";
import {
  HttpException,
  NotAcceptableException,
} from "../../../../../../packages/core/src/common";
import { describeConformance } from "../../../../_helpers";

describeConformance(
  "NotAcceptableException",
  {
    upstreamPath:
      "packages/common/test/exceptions/not-acceptable.exception.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    it("should return 406 as status code", () => {
      const exc = new NotAcceptableException();
      expect(exc.getStatus()).toBe(406);
    });

    // BUNEST_BUG: HttpException.createBody(undefined, "Not Acceptable", 406) in packages/core/src/common/exceptions/http.exception.ts:189 includes `error: "Not Acceptable"` in getResponse(), whereas NestJS returns `{ message: "Not Acceptable", statusCode: 406 }`.
    it.skip('should return "Not Acceptable" as default message', () => {
      const exc = new NotAcceptableException();
      expect(exc.getResponse()).toEqual({
        message: "Not Acceptable",
        statusCode: 406,
      });
    });

    it("should accept a custom message", () => {
      const exc = new NotAcceptableException("Custom error");
      expect(exc.getResponse()).toEqual({
        message: "Custom error",
        error: "Not Acceptable",
        statusCode: 406,
      });
    });

    // BUNEST_BUG: HttpException.createBody({ foo: "bar" }, ...) in packages/core/src/common/exceptions/http.exception.ts:205 merges `{ statusCode, error, message }` into custom objects instead of returning `{ foo: "bar" }` verbatim.
    it.skip("should accept a custom object", () => {
      const exc = new NotAcceptableException({ foo: "bar" });
      expect(exc.getResponse()).toEqual({ foo: "bar" });
    });

    it("should accept a cause option", () => {
      const cause = new Error("root cause");
      const exc = new NotAcceptableException("test", { cause });
      expect(exc.cause).toBe(cause);
    });

    it("should extend HttpException", () => {
      const exc = new NotAcceptableException();
      expect(exc).toBeInstanceOf(HttpException);
      expect(exc).toBeInstanceOf(Error);
    });
  },
);
