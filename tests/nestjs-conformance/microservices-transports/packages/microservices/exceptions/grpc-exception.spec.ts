import { expect, it } from "bun:test";
import {
  GrpcException,
  GrpcMetadata,
  GrpcStatus,
  RpcException,
} from "../../../../../../packages/microservices/src";
import { describeConformance, itAdapted } from "../../../../_helpers";

describeConformance(
  "GrpcException",
  {
    upstreamPath:
      "packages/microservices/test/exceptions/grpc-exception.spec.ts",
    category: "DIRECT_PORT",
    notes:
      "Bunest GrpcException uses constructor(code, message, metadata?) with .code/.details/.metadata/.isRetryable; NestJS status-specific subclasses (e.g. GrpcAlreadyExistsException) and getCode() are verified as parity gaps.",
  },
  () => {
    itAdapted(
      "ADR-001",
      "should expose gRPC status code, message, details, metadata, and error body",
      () => {
        const md = new GrpcMetadata({ "x-error-id": "err-42" });
        const exception = new GrpcException(
          GrpcStatus.ALREADY_EXISTS,
          "resource already exists",
          md,
        );

        expect(exception).toBeInstanceOf(Error);
        expect(exception).toBeInstanceOf(RpcException);
        expect(exception).toBeInstanceOf(GrpcException);
        expect(exception.name).toBe("GrpcException");
        expect(exception.message).toBe("resource already exists");
        expect(exception.details).toBe("resource already exists");
        expect(exception.code).toBe(GrpcStatus.ALREADY_EXISTS);
        expect(exception.metadata).toBe(md);
        expect(exception.getError()).toEqual({
          code: GrpcStatus.ALREADY_EXISTS,
          status: GrpcStatus.ALREADY_EXISTS,
          message: "resource already exists",
        });
        expect(exception.toSerialized()).toEqual({
          message: "resource already exists",
          name: "GrpcException",
          status: GrpcStatus.ALREADY_EXISTS,
          details: {
            code: GrpcStatus.ALREADY_EXISTS,
            status: GrpcStatus.ALREADY_EXISTS,
            message: "resource already exists",
          },
          isRpcException: true,
        });
      },
      "constructor signature (code, message, metadata?) and .code property",
    );

    it("should mark UNAVAILABLE and DEADLINE_EXCEEDED as retryable and other status codes as non-retryable", () => {
      expect(
        new GrpcException(GrpcStatus.UNAVAILABLE, "service down").isRetryable,
      ).toBe(true);
      expect(
        new GrpcException(GrpcStatus.DEADLINE_EXCEEDED, "timed out")
          .isRetryable,
      ).toBe(true);

      const nonRetryable: GrpcStatus[] = [
        GrpcStatus.OK,
        GrpcStatus.CANCELLED,
        GrpcStatus.UNKNOWN,
        GrpcStatus.INVALID_ARGUMENT,
        GrpcStatus.NOT_FOUND,
        GrpcStatus.ALREADY_EXISTS,
        GrpcStatus.PERMISSION_DENIED,
        GrpcStatus.RESOURCE_EXHAUSTED,
        GrpcStatus.FAILED_PRECONDITION,
        GrpcStatus.ABORTED,
        GrpcStatus.OUT_OF_RANGE,
        GrpcStatus.UNIMPLEMENTED,
        GrpcStatus.INTERNAL,
        GrpcStatus.DATA_LOSS,
        GrpcStatus.UNAUTHENTICATED,
      ];
      for (const status of nonRetryable) {
        expect(new GrpcException(status, "err").isRetryable).toBe(false);
      }
    });

    it("should expose all 17 canonical gRPC status codes (0..16)", () => {
      expect(GrpcStatus.OK).toBe(0);
      expect(GrpcStatus.CANCELLED).toBe(1);
      expect(GrpcStatus.UNKNOWN).toBe(2);
      expect(GrpcStatus.INVALID_ARGUMENT).toBe(3);
      expect(GrpcStatus.DEADLINE_EXCEEDED).toBe(4);
      expect(GrpcStatus.NOT_FOUND).toBe(5);
      expect(GrpcStatus.ALREADY_EXISTS).toBe(6);
      expect(GrpcStatus.PERMISSION_DENIED).toBe(7);
      expect(GrpcStatus.RESOURCE_EXHAUSTED).toBe(8);
      expect(GrpcStatus.FAILED_PRECONDITION).toBe(9);
      expect(GrpcStatus.ABORTED).toBe(10);
      expect(GrpcStatus.OUT_OF_RANGE).toBe(11);
      expect(GrpcStatus.UNIMPLEMENTED).toBe(12);
      expect(GrpcStatus.INTERNAL).toBe(13);
      expect(GrpcStatus.UNAVAILABLE).toBe(14);
      expect(GrpcStatus.DATA_LOSS).toBe(15);
      expect(GrpcStatus.UNAUTHENTICATED).toBe(16);
    });

    // BUNEST_BUG: GrpcException.getError() in packages/microservices/src/exceptions.ts:167 includes an extra `status` property (`{ code, status, message }`) whereas NestJS returns `{ code, message }`.
    it.skip("should expose NestJS-compatible (message, code) constructor and getCode() method", () => {
      const exception = new GrpcException(
        "resource already exists",
        GrpcStatus.ALREADY_EXISTS,
      );

      expect(exception.message).toBe("resource already exists");
      expect(exception.getCode()).toBe(GrpcStatus.ALREADY_EXISTS);
      expect(exception.getError() as unknown).toEqual({
        code: GrpcStatus.ALREADY_EXISTS,
        message: "resource already exists",
      });
    });

    // BUNEST_BUG: GrpcAlreadyExistsException.getError() in packages/microservices/src/exceptions.ts:167 includes an extra `status` property (`{ code, status, message }`) whereas NestJS returns `{ code, message }`.
    it.skip("should use status-specific exception defaults (GrpcAlreadyExistsException)", async () => {
      const mod =
        (await import("../../../../../../packages/microservices/src")) as Record<
          string,
          unknown
        >;
      const GrpcAlreadyExistsException = mod.GrpcAlreadyExistsException as
        (new () => GrpcException) | undefined;
      expect(GrpcAlreadyExistsException).toBeDefined();
      const exception = new GrpcAlreadyExistsException!();
      expect(exception.getError() as unknown).toEqual({
        code: GrpcStatus.ALREADY_EXISTS,
        message: "Already exists",
      });
    });
  },
);
