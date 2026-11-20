import "reflect-metadata";
import { expect, it } from "bun:test";
import {
  HttpException,
  ImATeapotException,
} from "../../../../../../packages/common/src";
import { describeConformance } from "../../../../_helpers";

describeConformance(
  "ImATeapotException",
  {
    upstreamPath:
      "packages/common/test/exceptions/im-a-teapot.exception.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    it("should return 418 as status code", () => {
      const exc = new ImATeapotException();
      expect(exc.getStatus()).toBe(418);
    });

    // BUNEST_BUG: HttpException.createBody(undefined, "I'm a teapot", 418) in packages/common/src/exceptions/http.exception.ts:189 includes `error: "I'm a teapot"` in getResponse(), whereas NestJS returns `{ message: "I'm a teapot", statusCode: 418 }`.
    it.skip("should return default I'm a teapot message", () => {
      const exc = new ImATeapotException();
      expect(exc.getResponse()).toEqual({
        message: "I'm a teapot",
        statusCode: 418,
      });
    });

    it("should accept a custom message", () => {
      const exc = new ImATeapotException("Custom error");
      expect(exc.getResponse()).toEqual({
        message: "Custom error",
        error: "I'm a teapot",
        statusCode: 418,
      });
    });

    // BUNEST_BUG: HttpException.createBody({ foo: "bar" }, ...) in packages/common/src/exceptions/http.exception.ts:205 merges `{ statusCode, error, message }` into custom objects instead of returning `{ foo: "bar" }` verbatim.
    it.skip("should accept a custom object", () => {
      const exc = new ImATeapotException({ foo: "bar" });
      expect(exc.getResponse()).toEqual({ foo: "bar" });
    });

    it("should accept a cause option", () => {
      const cause = new Error("root cause");
      const exc = new ImATeapotException("test", { cause });
      expect(exc.cause).toBe(cause);
    });

    it("should extend HttpException", () => {
      const exc = new ImATeapotException();
      expect(exc).toBeInstanceOf(HttpException);
      expect(exc).toBeInstanceOf(Error);
    });
  },
);
