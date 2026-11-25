import { expect, it } from "bun:test";
import {
  HttpException,
  UnsupportedMediaTypeException,
} from "../../../../../../packages/core/src/common";
import { describeConformance } from "../../../../_helpers";

describeConformance(
  "UnsupportedMediaTypeException",
  {
    upstreamPath:
      "packages/common/test/exceptions/unsupported-media-type.exception.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    it("should return 415 as status code", () => {
      const exc = new UnsupportedMediaTypeException();
      expect(exc.getStatus()).toBe(415);
    });

    it('should return "Unsupported Media Type" as default message', () => {
      const exc = new UnsupportedMediaTypeException();
      expect(exc.getResponse()).toEqual({
        message: "Unsupported Media Type",
        statusCode: 415,
      });
    });

    it("should accept a custom message", () => {
      const exc = new UnsupportedMediaTypeException("Custom error");
      expect(exc.getResponse()).toEqual({
        message: "Custom error",
        error: "Unsupported Media Type",
        statusCode: 415,
      });
    });

    it("should accept a custom object", () => {
      const exc = new UnsupportedMediaTypeException({ foo: "bar" });
      expect(exc.getResponse()).toEqual({ foo: "bar" });
    });

    it("should accept a cause option", () => {
      const cause = new Error("root cause");
      const exc = new UnsupportedMediaTypeException("test", { cause });
      expect(exc.cause).toBe(cause);
    });

    it("should extend HttpException", () => {
      const exc = new UnsupportedMediaTypeException();
      expect(exc).toBeInstanceOf(HttpException);
      expect(exc).toBeInstanceOf(Error);
    });
  },
);
