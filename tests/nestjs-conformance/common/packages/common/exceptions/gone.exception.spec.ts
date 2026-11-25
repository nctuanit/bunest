import { expect, it } from "bun:test";
import {
  GoneException,
  HttpException,
} from "../../../../../../packages/core/src/common";
import { describeConformance } from "../../../../_helpers";

describeConformance(
  "GoneException",
  {
    upstreamPath: "packages/common/test/exceptions/gone.exception.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    it("should return 410 as status code", () => {
      const exc = new GoneException();
      expect(exc.getStatus()).toBe(410);
    });

    it('should return "Gone" as default message', () => {
      const exc = new GoneException();
      expect(exc.getResponse()).toEqual({
        message: "Gone",
        statusCode: 410,
      });
    });

    it("should accept a custom message", () => {
      const exc = new GoneException("Custom error");
      expect(exc.getResponse()).toEqual({
        message: "Custom error",
        error: "Gone",
        statusCode: 410,
      });
    });

    it("should accept a custom object", () => {
      const exc = new GoneException({ foo: "bar" });
      expect(exc.getResponse()).toEqual({ foo: "bar" });
    });

    it("should accept a cause option", () => {
      const cause = new Error("root cause");
      const exc = new GoneException("test", { cause });
      expect(exc.cause).toBe(cause);
    });

    it("should extend HttpException", () => {
      const exc = new GoneException();
      expect(exc).toBeInstanceOf(HttpException);
      expect(exc).toBeInstanceOf(Error);
    });
  },
);
