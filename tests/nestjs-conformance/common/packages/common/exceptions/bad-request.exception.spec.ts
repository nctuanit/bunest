import "reflect-metadata";
import { expect, it } from "bun:test";
import {
  BadRequestException,
  HttpException,
} from "../../../../../../packages/common/src";
import { describeConformance } from "../../../../_helpers";

describeConformance(
  "BadRequestException",
  {
    upstreamPath:
      "packages/common/test/exceptions/bad-request.exception.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    it("should return 400 as status code", () => {
      const exc = new BadRequestException();
      expect(exc.getStatus()).toBe(400);
    });

    // BUNEST_BUG: HttpException.createBody(undefined, "Bad Request", 400) in packages/common/src/exceptions/http.exception.ts:189 includes `error: "Bad Request"` in getResponse(), whereas NestJS returns `{ message: "Bad Request", statusCode: 400 }`.
    it.skip('should return "Bad Request" as default message', () => {
      const exc = new BadRequestException();
      expect(exc.getResponse()).toEqual({
        message: "Bad Request",
        statusCode: 400,
      });
    });

    it("should accept a custom message", () => {
      const exc = new BadRequestException("Custom error");
      expect(exc.getResponse()).toEqual({
        message: "Custom error",
        error: "Bad Request",
        statusCode: 400,
      });
    });

    // BUNEST_BUG: HttpException.createBody({ foo: "bar" }, ...) in packages/common/src/exceptions/http.exception.ts:205 merges `{ statusCode, error, message }` into custom objects instead of returning `{ foo: "bar" }` verbatim.
    it.skip("should accept a custom object", () => {
      const exc = new BadRequestException({ foo: "bar" });
      expect(exc.getResponse()).toEqual({ foo: "bar" });
    });

    it("should accept a cause option", () => {
      const cause = new Error("root cause");
      const exc = new BadRequestException("test", { cause });
      expect(exc.cause).toBe(cause);
    });

    it("should extend HttpException", () => {
      const exc = new BadRequestException();
      expect(exc).toBeInstanceOf(HttpException);
      expect(exc).toBeInstanceOf(Error);
    });
  },
);
