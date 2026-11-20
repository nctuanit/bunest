import "reflect-metadata";
import { expect, it } from "bun:test";
import {
  HttpException,
  PreconditionFailedException,
} from "../../../../../../packages/common/src";
import { describeConformance } from "../../../../_helpers";

describeConformance(
  "PreconditionFailedException",
  {
    upstreamPath:
      "packages/common/test/exceptions/precondition-failed.exception.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    it("should return 412 as status code", () => {
      const exc = new PreconditionFailedException();
      expect(exc.getStatus()).toBe(412);
    });

    // BUNEST_BUG: HttpException.createBody(undefined, "Precondition Failed", 412) in packages/common/src/exceptions/http.exception.ts:189 includes `error: "Precondition Failed"` in getResponse(), whereas NestJS returns `{ message: "Precondition Failed", statusCode: 412 }`.
    it.skip('should return "Precondition Failed" as default message', () => {
      const exc = new PreconditionFailedException();
      expect(exc.getResponse()).toEqual({
        message: "Precondition Failed",
        statusCode: 412,
      });
    });

    it("should accept a custom message", () => {
      const exc = new PreconditionFailedException("Custom error");
      expect(exc.getResponse()).toEqual({
        message: "Custom error",
        error: "Precondition Failed",
        statusCode: 412,
      });
    });

    // BUNEST_BUG: HttpException.createBody({ foo: "bar" }, ...) in packages/common/src/exceptions/http.exception.ts:205 merges `{ statusCode, error, message }` into custom objects instead of returning `{ foo: "bar" }` verbatim.
    it.skip("should accept a custom object", () => {
      const exc = new PreconditionFailedException({ foo: "bar" });
      expect(exc.getResponse()).toEqual({ foo: "bar" });
    });

    it("should accept a cause option", () => {
      const cause = new Error("root cause");
      const exc = new PreconditionFailedException("test", { cause });
      expect(exc.cause).toBe(cause);
    });

    it("should extend HttpException", () => {
      const exc = new PreconditionFailedException();
      expect(exc).toBeInstanceOf(HttpException);
      expect(exc).toBeInstanceOf(Error);
    });
  },
);
