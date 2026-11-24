import { expect, it } from "bun:test";
import {
  ConflictException,
  HttpException,
} from "../../../../../../packages/core/src/common";
import { describeConformance } from "../../../../_helpers";

describeConformance(
  "ConflictException",
  {
    upstreamPath: "packages/common/test/exceptions/conflict.exception.spec.ts",
    category: "DIRECT_PORT",
  },
  () => {
    it("should return 409 as status code", () => {
      const exc = new ConflictException();
      expect(exc.getStatus()).toBe(409);
    });

    it('should return "Conflict" as default message', () => {
      const exc = new ConflictException();
      expect(exc.getResponse()).toEqual({
        message: "Conflict",
        statusCode: 409,
      });
    });

    it("should accept a custom message", () => {
      const exc = new ConflictException("Custom error");
      expect(exc.getResponse()).toEqual({
        message: "Custom error",
        error: "Conflict",
        statusCode: 409,
      });
    });

    it("should accept a custom object", () => {
      const exc = new ConflictException({ foo: "bar" });
      expect(exc.getResponse()).toEqual({ foo: "bar" });
    });

    it("should accept a cause option", () => {
      const cause = new Error("root cause");
      const exc = new ConflictException("test", { cause });
      expect(exc.cause).toBe(cause);
    });

    it("should extend HttpException", () => {
      const exc = new ConflictException();
      expect(exc).toBeInstanceOf(HttpException);
      expect(exc).toBeInstanceOf(Error);
    });
  },
);
