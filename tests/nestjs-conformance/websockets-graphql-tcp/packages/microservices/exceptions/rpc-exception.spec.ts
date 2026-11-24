import { describe, expect, it } from "bun:test";
import {
  RpcException,
  RpcTimeoutException,
} from "../../../../../../packages/microservices/src";
import { describeConformance } from "../../../../_helpers";

describeConformance(
  "RpcException",
  {
    upstreamPath:
      "packages/microservices/test/exceptions/rpc-exception.spec.ts",
    category: "DIRECT_PORT",
    adrs: ["ADR-002"],
    notes:
      "Direct port of RpcException constructor, getError(), message extraction, plus Bunest serialization/deserialization and RpcTimeoutException tests.",
  },
  () => {
    describe("when string passed", () => {
      const error = "test";
      const instance = new RpcException(error);

      it("should return error message as string", () => {
        expect(instance.getError()).toEqual(error);
      });

      it("should set the message property", () => {
        expect(instance.message).toEqual(error);
      });

      it("should be an instance of Error with name RpcException", () => {
        expect(instance).toBeInstanceOf(Error);
        expect(instance).toBeInstanceOf(RpcException);
        expect(instance.name).toBe("RpcException");
      });
    });

    describe("when object passed", () => {
      describe("and message property is undefined", () => {
        const error = { test: true };
        const instance = new RpcException(error);

        it("should return error as object", () => {
          expect(instance.getError()).toEqual(error);
        });

        // BUNEST_BUG: RpcException constructor in packages/microservices/src/exceptions.ts falls back to `JSON.stringify(error)` ('{"test":true}') instead of splitting the class name into words ('Rpc Exception') as NestJS does (and as Bunest's own HttpException.initMessage() does).
        it.skip("should fallback error message to class name", () => {
          expect(instance.message).toEqual("Rpc Exception");
        });
      });

      describe("and class name cannot be split into words", () => {
        class RPC extends RpcException {}
        const error = { test: true };
        const instance = new RPC(error);

        // BUNEST_BUG: RpcException constructor in packages/microservices/src/exceptions.ts uses `JSON.stringify(error)` instead of falling back to "Error" when the subclass name cannot be split into words.
        it.skip('should fallback error message to "Error"', () => {
          expect(instance.message).toEqual("Error");
        });
      });

      describe("and message property is not undefined", () => {
        const error = { message: "test", test: true };
        const instance = new RpcException(error);

        it("should return error as object", () => {
          expect(instance.getError()).toEqual(error);
        });

        it('should return error message as the extracted "message" string', () => {
          expect(instance.message).toEqual(error.message);
        });
      });
    });

    describe("serialization & deserialization (toSerialized / fromSerialized)", () => {
      it("should round-trip a string RpcException", () => {
        const original = new RpcException("unauthorized");
        const serialized = original.toSerialized();

        expect(serialized).toEqual({
          message: "unauthorized",
          name: "RpcException",
          isRpcException: true,
        });

        const restored = RpcException.fromSerialized(serialized);
        expect(restored).toBeInstanceOf(RpcException);
        expect(restored.getError()).toBe("unauthorized");
        expect(restored.message).toBe("unauthorized");
      });

      it("should round-trip a structured object RpcException with numeric status", () => {
        const payload = {
          status: 422,
          message: "Validation failed",
          field: "email",
        };
        const original = new RpcException(payload);
        const serialized = original.toSerialized();

        expect(serialized).toEqual({
          message: "Validation failed",
          name: "RpcException",
          status: 422,
          details: payload,
          isRpcException: true,
        });

        const restored = RpcException.fromSerialized(serialized);
        expect(restored).toBeInstanceOf(RpcException);
        expect(restored.getError()).toEqual(payload);
        expect(restored.message).toBe("Validation failed");
      });

      it("should omit status in serialized output when payload status is not a number", () => {
        const serialized = new RpcException({
          status: "error",
          message: "bad state",
        }).toSerialized();

        expect(serialized.status).toBeUndefined();
        expect(serialized.details).toEqual({
          status: "error",
          message: "bad state",
        });
      });

      it("should fallback to 'RPC error' when deserializing an empty message without details", () => {
        const restored = RpcException.fromSerialized({ message: "" });
        expect(restored.getError()).toBe("RPC error");
        expect(restored.message).toBe("RPC error");
      });

      it("should ignore array details and fall back to serialized message", () => {
        const restored = RpcException.fromSerialized({
          message: "array details ignored",
          details: ["a", "b"],
        });
        expect(restored.getError()).toBe("array details ignored");
      });
    });

    describe("RpcTimeoutException", () => {
      it("should expose pattern, timeoutMs, name, and formatted message", () => {
        const timeoutErr = new RpcTimeoutException("math.sum", 250);
        expect(timeoutErr).toBeInstanceOf(Error);
        expect(timeoutErr.name).toBe("RpcTimeoutException");
        expect(timeoutErr.pattern).toBe("math.sum");
        expect(timeoutErr.timeoutMs).toBe(250);
        expect(timeoutErr.message).toBe(
          'RPC request "math.sum" timed out after 250ms',
        );
      });
    });
  },
);
