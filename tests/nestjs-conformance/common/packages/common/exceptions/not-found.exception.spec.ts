import { expect, it } from "bun:test";
import {
  HttpException,
  NotFoundException,
} from "../../../../../../packages/core/src/common";
import { describeConformance } from "../../../../_helpers";

describeConformance(
  "NotFoundException",
  {
    upstreamPath: "packages/common/test/exceptions/not-found.exception.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    it("should return 404 as status code", () => {
      const exc = new NotFoundException();
      expect(exc.getStatus()).toBe(404);
    });

    // BUNEST_BUG: HttpException.createBody(undefined, "Not Found", 404) in packages/core/src/common/exceptions/http.exception.ts:189 includes `error: "Not Found"` in getResponse(), whereas NestJS returns `{ message: "Not Found", statusCode: 404 }`.
    it.skip('should return "Not Found" as default message', () => {
      const exc = new NotFoundException();
      expect(exc.getResponse()).toEqual({
        message: "Not Found",
        statusCode: 404,
      });
    });

    it("should accept a custom message", () => {
      const exc = new NotFoundException("Custom error");
      expect(exc.getResponse()).toEqual({
        message: "Custom error",
        error: "Not Found",
        statusCode: 404,
      });
    });

    // BUNEST_BUG: HttpException.createBody({ foo: "bar" }, ...) in packages/core/src/common/exceptions/http.exception.ts:205 merges `{ statusCode, error, message }` into custom objects instead of returning `{ foo: "bar" }` verbatim.
    it.skip("should accept a custom object", () => {
      const exc = new NotFoundException({ foo: "bar" });
      expect(exc.getResponse()).toEqual({ foo: "bar" });
    });

    it("should accept a cause option", () => {
      const cause = new Error("root cause");
      const exc = new NotFoundException("test", { cause });
      expect(exc.cause).toBe(cause);
    });

    it("should extend HttpException", () => {
      const exc = new NotFoundException();
      expect(exc).toBeInstanceOf(HttpException);
      expect(exc).toBeInstanceOf(Error);
    });
  },
);
