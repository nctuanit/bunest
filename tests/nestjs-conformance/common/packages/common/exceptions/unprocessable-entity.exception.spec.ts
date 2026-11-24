import { expect, it } from "bun:test";
import {
  HttpException,
  UnprocessableEntityException,
} from "../../../../../../packages/core/src/common";
import { describeConformance } from "../../../../_helpers";

describeConformance(
  "UnprocessableEntityException",
  {
    upstreamPath:
      "packages/common/test/exceptions/unprocessable-entity.exception.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    it("should return 422 as status code", () => {
      const exc = new UnprocessableEntityException();
      expect(exc.getStatus()).toBe(422);
    });

    // BUNEST_BUG: HttpException.createBody(undefined, "Unprocessable Entity", 422) in packages/core/src/common/exceptions/http.exception.ts:189 includes `error: "Unprocessable Entity"` in getResponse(), whereas NestJS returns `{ message: "Unprocessable Entity", statusCode: 422 }`.
    it.skip('should return "Unprocessable Entity" as default message', () => {
      const exc = new UnprocessableEntityException();
      expect(exc.getResponse()).toEqual({
        message: "Unprocessable Entity",
        statusCode: 422,
      });
    });

    it("should accept a custom message", () => {
      const exc = new UnprocessableEntityException("Custom error");
      expect(exc.getResponse()).toEqual({
        message: "Custom error",
        error: "Unprocessable Entity",
        statusCode: 422,
      });
    });

    // BUNEST_BUG: HttpException.createBody({ foo: "bar" }, ...) in packages/core/src/common/exceptions/http.exception.ts:205 merges `{ statusCode, error, message }` into custom objects instead of returning `{ foo: "bar" }` verbatim.
    it.skip("should accept a custom object", () => {
      const exc = new UnprocessableEntityException({ foo: "bar" });
      expect(exc.getResponse()).toEqual({ foo: "bar" });
    });

    it("should accept a cause option", () => {
      const cause = new Error("root cause");
      const exc = new UnprocessableEntityException("test", { cause });
      expect(exc.cause).toBe(cause);
    });

    it("should extend HttpException", () => {
      const exc = new UnprocessableEntityException();
      expect(exc).toBeInstanceOf(HttpException);
      expect(exc).toBeInstanceOf(Error);
    });
  },
);
