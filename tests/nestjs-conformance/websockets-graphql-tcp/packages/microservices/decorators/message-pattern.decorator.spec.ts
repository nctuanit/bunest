import { describe, expect, it } from "bun:test";
import { MetadataRegistry } from "../../../../../../packages/core/src/common";
import {
  GRPC_METHOD_METADATA,
  GrpcMethod,
  GrpcStreamCall,
  GrpcStreamMethod,
  MESSAGE_PATTERN_METADATA,
  MessagePattern,
  Transport,
  type GrpcMethodMetadata,
  type PatternHandlerMetadata,
} from "../../../../../../packages/microservices/src";
import { describeConformance, itAdapted } from "../../../../_helpers";

describeConformance(
  "@MessagePattern & @GrpcMethod decorators",
  {
    upstreamPath:
      "packages/microservices/test/decorators/message-pattern.decorator.spec.ts",
    category: "DIRECT_PORT",
    adrs: ["ADR-002", "ADR-008"],
    notes:
      "Tests @MessagePattern, @GrpcMethod, @GrpcStreamMethod, and @GrpcStreamCall metadata storage and method behavior.",
  },
  () => {
    describe("@MessagePattern", () => {
      const pattern = { role: "test" };
      const extras = { param: "value" };

      class TestComponent {
        @MessagePattern(pattern)
        public test() {}

        @MessagePattern("math.sum")
        public sum() {}

        @MessagePattern({ z: 1, a: 2 })
        public canonical() {}

        @MessagePattern(/^rpc\./i)
        public regex() {}
      }

      it("should enhance class with MESSAGE_PATTERN_METADATA metadata", () => {
        const metadata = MetadataRegistry.getOwn<
          readonly PatternHandlerMetadata[]
        >(MESSAGE_PATTERN_METADATA, TestComponent);
        const entry = metadata?.find((m) => m.methodName === "test");

        expect(entry).toEqual({
          methodName: "test",
          pattern,
          normalizedPattern: '{"role":"test"}',
          isEventHandler: false,
        });
      });

      it("should normalize string, object (sorted keys), and RegExp patterns", () => {
        const metadata = MetadataRegistry.getOwn<
          readonly PatternHandlerMetadata[]
        >(MESSAGE_PATTERN_METADATA, TestComponent);

        expect(metadata?.find((m) => m.methodName === "sum")).toEqual({
          methodName: "sum",
          pattern: "math.sum",
          normalizedPattern: "math.sum",
          isEventHandler: false,
        });
        expect(metadata?.find((m) => m.methodName === "canonical")).toEqual({
          methodName: "canonical",
          pattern: { z: 1, a: 2 },
          normalizedPattern: '{"a":2,"z":1}',
          isEventHandler: false,
        });
        expect(metadata?.find((m) => m.methodName === "regex")).toEqual({
          methodName: "regex",
          pattern: /^rpc\./i,
          normalizedPattern: "/^rpc\\./i",
          isEventHandler: false,
        });
      });

      it("should isolate metadata between base and derived classes (copy-on-write)", () => {
        class BaseRpc {
          @MessagePattern("base.op")
          baseOp() {}
        }
        class DerivedRpc extends BaseRpc {
          @MessagePattern("derived.op")
          derivedOp() {}
        }

        const baseMeta = MetadataRegistry.getOwn<
          readonly PatternHandlerMetadata[]
        >(MESSAGE_PATTERN_METADATA, BaseRpc);
        const derivedMeta = MetadataRegistry.getOwn<
          readonly PatternHandlerMetadata[]
        >(MESSAGE_PATTERN_METADATA, DerivedRpc);

        expect(baseMeta?.map((m) => m.normalizedPattern)).toEqual(["base.op"]);
        expect(derivedMeta?.map((m) => m.normalizedPattern)).toEqual([
          "derived.op",
        ]);
      });

      describe("decorator overloads (unimplemented parity)", () => {
        it("should enhance method with transport and extras metadata overloads", () => {
          const dynamicMessagePattern = MessagePattern as (
            ...args: unknown[]
          ) => MethodDecorator;

          class TestComponentWithOverloads {
            @dynamicMessagePattern(pattern, Transport.TCP, extras)
            public test() {}
          }

          const metadata = MetadataRegistry.getOwn<
            readonly (PatternHandlerMetadata & {
              transport?: Transport;
              extras?: Record<string, unknown>;
            })[]
          >(MESSAGE_PATTERN_METADATA, TestComponentWithOverloads);
          expect(metadata?.[0]?.pattern).toEqual(pattern);
          expect(metadata?.[0]?.transport).toBe(Transport.TCP);
          expect(metadata?.[0]?.extras).toEqual(extras);
        });

        itAdapted(
          "ADR-002",
          "should store pattern extras metadata on @MessagePattern",
          () => {
            const dynamicMessagePattern = MessagePattern as (
              ...args: unknown[]
            ) => MethodDecorator;

            class TestComponentMerged {
              @dynamicMessagePattern(pattern, Transport.TCP, {
                foo: "bar",
                ...extras,
              })
              public test() {}
            }

            const metadata = MetadataRegistry.getOwn<
              readonly (PatternHandlerMetadata & {
                extras?: Record<string, unknown>;
              })[]
            >(MESSAGE_PATTERN_METADATA, TestComponentMerged);
            expect(metadata?.[0]?.extras).toEqual({
              foo: "bar",
              ...extras,
            });
          },
          "ADR-002: @MessagePattern stores extras directly in MESSAGE_PATTERN_METADATA",
        );
      });
    });

    describe("@GrpcMethod", () => {
      class TestService {
        @GrpcMethod("TestService2")
        public test2() {}

        @GrpcMethod("TestService2", "Test2")
        public test3() {}

        @GrpcMethod("CustomService", "ExplicitRpcName")
        public customMethod() {}
      }

      it("should derive both method and service name when called with no arguments", () => {
        const dynamicGrpcMethod = GrpcMethod as (
          service?: string,
          method?: string,
        ) => MethodDecorator;

        class DerivedGrpcService {
          @dynamicGrpcMethod()
          public test() {}
        }

        const metadata = MetadataRegistry.getOwn<readonly GrpcMethodMetadata[]>(
          GRPC_METHOD_METADATA,
          DerivedGrpcService,
        );
        expect(metadata?.[0]).toEqual({
          methodName: "test",
          service: "DerivedGrpcService",
          method: "Test",
          streaming: false,
        });
      });

      it("should derive PascalCase RPC method name when only service is provided", () => {
        const metadata = MetadataRegistry.getOwn<readonly GrpcMethodMetadata[]>(
          GRPC_METHOD_METADATA,
          TestService,
        );
        const entry = metadata?.find((m) => m.methodName === "test2");

        expect(entry).toEqual({
          methodName: "test2",
          service: "TestService2",
          method: "Test2",
          streaming: false,
        });
      });

      it("should override both method and service when both are provided", () => {
        const metadata = MetadataRegistry.getOwn<readonly GrpcMethodMetadata[]>(
          GRPC_METHOD_METADATA,
          TestService,
        );
        expect(metadata?.find((m) => m.methodName === "test3")).toEqual({
          methodName: "test3",
          service: "TestService2",
          method: "Test2",
          streaming: false,
        });
        expect(metadata?.find((m) => m.methodName === "customMethod")).toEqual({
          methodName: "customMethod",
          service: "CustomService",
          method: "ExplicitRpcName",
          streaming: false,
        });
      });
    });

    describe("@GrpcStreamMethod", () => {
      class TestService {
        @GrpcStreamMethod("TestService2")
        public test2() {}

        @GrpcStreamMethod("TestService2", "Test2")
        public test3() {}
      }

      it("should derive both method and service name when called with no arguments", () => {
        const dynamicGrpcStream = GrpcStreamMethod as (
          service?: string,
          method?: string,
        ) => MethodDecorator;

        class DerivedStreamService {
          @dynamicGrpcStream()
          public test() {}
        }

        const metadata = MetadataRegistry.getOwn<readonly GrpcMethodMetadata[]>(
          GRPC_METHOD_METADATA,
          DerivedStreamService,
        );
        expect(metadata?.[0]).toEqual({
          methodName: "test",
          service: "DerivedStreamService",
          method: "Test",
          streaming: true,
        });
      });

      it("should derive PascalCase method name with streaming: true", () => {
        const metadata = MetadataRegistry.getOwn<readonly GrpcMethodMetadata[]>(
          GRPC_METHOD_METADATA,
          TestService,
        );
        const entry = metadata?.find((m) => m.methodName === "test2");

        expect(entry).toEqual({
          methodName: "test2",
          service: "TestService2",
          method: "Test2",
          streaming: true,
        });
      });

      it("should override both method and service with streaming: true", () => {
        const metadata = MetadataRegistry.getOwn<readonly GrpcMethodMetadata[]>(
          GRPC_METHOD_METADATA,
          TestService,
        );
        const entry = metadata?.find((m) => m.methodName === "test3");

        expect(entry).toEqual({
          methodName: "test3",
          service: "TestService2",
          method: "Test2",
          streaming: true,
        });
      });

      itAdapted(
        "ADR-008",
        "should return stream value directly (not wrapped in Promise) when method is called directly",
        () => {
          class DirectStreamService {
            @GrpcStreamMethod("DirectStreamService")
            test(stream: AsyncIterable<number> | Record<string, unknown>) {
              return stream;
            }
          }
          const service = new DirectStreamService();
          const input = { kind: "async-stream" };
          const result = service.test(input);
          expect(result).toBe(input);
          expect(result).not.toHaveProperty("then");
        },
        "AsyncIterable instead of RxJS Observable",
      );
    });

    describe("@GrpcStreamCall", () => {
      class TestService {
        @GrpcStreamCall("TestService2")
        public test2() {}

        @GrpcStreamCall("TestService2", "Test2")
        public test3() {}
      }

      it("should derive both method and service name when called with no arguments", () => {
        const dynamicGrpcStreamCall = GrpcStreamCall as (
          service?: string,
          method?: string,
        ) => MethodDecorator;

        class DerivedStreamCallService {
          @dynamicGrpcStreamCall()
          public test() {}
        }

        const metadata = MetadataRegistry.getOwn<readonly GrpcMethodMetadata[]>(
          GRPC_METHOD_METADATA,
          DerivedStreamCallService,
        );
        expect(metadata?.[0]).toEqual({
          methodName: "test",
          service: "DerivedStreamCallService",
          method: "Test",
          streaming: true,
        });
      });

      it("should derive PascalCase method name with streaming: true", () => {
        const metadata = MetadataRegistry.getOwn<readonly GrpcMethodMetadata[]>(
          GRPC_METHOD_METADATA,
          TestService,
        );
        const entry = metadata?.find((m) => m.methodName === "test2");

        expect(entry).toEqual({
          methodName: "test2",
          service: "TestService2",
          method: "Test2",
          streaming: true,
        });
      });

      it("should override both method and service with streaming: true", () => {
        const metadata = MetadataRegistry.getOwn<readonly GrpcMethodMetadata[]>(
          GRPC_METHOD_METADATA,
          TestService,
        );
        const entry = metadata?.find((m) => m.methodName === "test3");

        expect(entry).toEqual({
          methodName: "test3",
          service: "TestService2",
          method: "Test2",
          streaming: true,
        });
      });
    });
  },
);
