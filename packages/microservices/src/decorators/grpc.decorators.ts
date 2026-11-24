import { Controller, MetadataRegistry } from "@bunest/core";
import { GrpcMethodStreamingType } from "../enums";
import type { GrpcMethodMetadata } from "../interfaces";
import { GRPC_METHOD_METADATA } from "../tokens";

/**
 * Defines a gRPC service controller (alias of `@Controller()`, matching `@nestjs/microservices`).
 */
export const GrpcService: typeof Controller = Controller;

function defaultGrpcMethodName(propertyKey: string | symbol): string {
  const raw = String(propertyKey);
  if (raw.length === 0) {
    return raw;
  }
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

/**
 * Computes NestJS-compatible gRPC method metadata (`{ service, rpc, streaming }`),
 * deriving service name from `target.constructor.name` and PascalCase RPC name
 * from `key` when omitted.
 */
export function createGrpcMethodMetadata(
  target: object,
  key: string | symbol,
  service: string | undefined,
  method: string | undefined,
  streaming: GrpcMethodStreamingType = GrpcMethodStreamingType.NO_STREAMING,
): {
  service: string;
  rpc: string | undefined;
  streaming: GrpcMethodStreamingType;
} {
  if (!service) {
    const name = target.constructor?.name ?? "";
    return {
      service: name,
      rpc: defaultGrpcMethodName(key),
      streaming,
    };
  }
  if (service && !method) {
    return {
      service,
      rpc: defaultGrpcMethodName(key),
      streaming,
    };
  }
  return {
    service,
    rpc: method,
    streaming,
  };
}

/**
 * Registers a controller/provider method as a unary gRPC RPC handler for
 * `/${service}/${method}`. When `service` is omitted, derives from the class name.
 * When `method` is omitted, derives a PascalCase RPC name from the TypeScript
 * method name (e.g. `findOne` -> `FindOne`).
 * Inheritance-safe (copy-on-write on target constructor).
 */
export function GrpcMethod(service?: string): MethodDecorator;
export function GrpcMethod(service: string, method?: string): MethodDecorator;
export function GrpcMethod(service?: string, method?: string): MethodDecorator {
  return (target: object, propertyKey: string | symbol) => {
    const meta = createGrpcMethodMetadata(
      target,
      propertyKey,
      service,
      method,
      GrpcMethodStreamingType.NO_STREAMING,
    );
    MetadataRegistry.appendOwnArray<GrpcMethodMetadata>(
      GRPC_METHOD_METADATA,
      [
        {
          methodName: propertyKey,
          service: meta.service,
          method: meta.rpc ?? defaultGrpcMethodName(propertyKey),
          streaming: false,
        },
      ],
      target.constructor,
    );
  };
}

/**
 * Registers a controller/provider method as a server-streaming gRPC RPC handler
 * returning an `AsyncIterable<T>` / `AsyncGenerator<T>` for `/${service}/${method}`.
 * Inheritance-safe (copy-on-write on target constructor).
 */
export function GrpcStreamMethod(service?: string): MethodDecorator;
export function GrpcStreamMethod(
  service: string,
  method?: string,
): MethodDecorator;
export function GrpcStreamMethod(
  service?: string,
  method?: string,
): MethodDecorator {
  return (target: object, propertyKey: string | symbol) => {
    const meta = createGrpcMethodMetadata(
      target,
      propertyKey,
      service,
      method,
      GrpcMethodStreamingType.RX_STREAMING,
    );
    MetadataRegistry.appendOwnArray<GrpcMethodMetadata>(
      GRPC_METHOD_METADATA,
      [
        {
          methodName: propertyKey,
          service: meta.service,
          method: meta.rpc ?? defaultGrpcMethodName(propertyKey),
          streaming: true,
        },
      ],
      target.constructor,
    );
  };
}

/**
 * Registers a controller/provider method as a bidirectional / client-streaming
 * gRPC call handler (`@GrpcStreamCall()`).
 */
export function GrpcStreamCall(service?: string): MethodDecorator;
export function GrpcStreamCall(
  service: string,
  method?: string,
): MethodDecorator;
export function GrpcStreamCall(
  service?: string,
  method?: string,
): MethodDecorator {
  return (target: object, propertyKey: string | symbol) => {
    const meta = createGrpcMethodMetadata(
      target,
      propertyKey,
      service,
      method,
      GrpcMethodStreamingType.PT_STREAMING,
    );
    MetadataRegistry.appendOwnArray<GrpcMethodMetadata>(
      GRPC_METHOD_METADATA,
      [
        {
          methodName: propertyKey,
          service: meta.service,
          method: meta.rpc ?? defaultGrpcMethodName(propertyKey),
          streaming: true,
        },
      ],
      target.constructor,
    );
  };
}
