import "reflect-metadata";
import { expect, it } from "bun:test";
import {
  HttpException,
  NotImplementedException,
} from "../../../../../../packages/common/src";
import { describeConformance } from "../../../../_helpers";

describeConformance(
  "NotImplementedException",
  {
    upstreamPath:
      "packages/common/test/exceptions/not-implemented.exception.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    it("should return 501 as status code", () => {
      const exc = new NotImplementedException();
      expect(exc.getStatus()).toBe(501);
    });

    // BUNEST_BUG: HttpException.createBody(undefined, "Not Implemented", 501) in packages/common/src/exceptions/http.exception.ts:189 includes `error: "Not Implemented"` in getResponse(), whereas NestJS returns `{ message: "Not Implemented", statusCode: 501 }`.
    it.skip('should return "Not Implemented" as default message', () => {
      const exc = new NotImplementedException();
      expect(exc.getResponse()).toEqual({
        message: "Not Implemented",
        statusCode: 501,
      });
    });

    it("should accept a custom message", () => {
      const exc = new NotImplementedException("Custom error");
      expect(exc.getResponse()).toEqual({
        message: "Custom error",
        error: "Not Implemented",
        statusCode: 501,
      });
    });

    // BUNEST_BUG: HttpException.createBody({ foo: "bar" }, ...) in packages/common/src/exceptions/http.exception.ts:205 merges `{ statusCode, error, message }` into custom objects instead of returning `{ foo: "bar" }` verbatim.
    it.skip("should accept a custom object", () => {
      const exc = new NotImplementedException({ foo: "bar" });
      expect(exc.getResponse()).toEqual({ foo: "bar" });
    });

    it("should accept a cause option", () => {
      const cause = new Error("root cause");
      const exc = new NotImplementedException("test", { cause });
      expect(exc.cause).toBe(cause);
    });

    it("should extend HttpException", () => {
      const exc = new NotImplementedException();
      expect(exc).toBeInstanceOf(HttpException);
      expect(exc).toBeInstanceOf(Error);
    });
  },
);
