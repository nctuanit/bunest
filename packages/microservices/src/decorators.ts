import { MetadataRegistry, type PipeLike } from "@bunest/core";
import {
  normalizePattern,
  type ClientOptions,
  type PatternHandlerMetadata,
  type PatternInput,
  type RpcParamMetadata,
} from "./interfaces";
import {
  CLIENT_CONFIGURATION_METADATA,
  CLIENT_METADATA,
  EVENT_PATTERN_METADATA,
  MESSAGE_PATTERN_METADATA,
  PATTERN_EXTRAS_METADATA,
  PATTERN_METADATA,
  RPC_PARAM_METADATA,
  TRANSPORT_METADATA,
  type Transport,
} from "./tokens";

export type EventDataMethodDecorator<
  TEventTypes extends Record<string, unknown>,
  TKey extends keyof TEventTypes,
> = (
  target: object,
  propertyKey: string | symbol,
  descriptor: TypedPropertyDescriptor<
    (data: TEventTypes[TKey], ...args: unknown[]) => unknown
  >,
) => void;

function parsePatternArgs(
  transportOrExtras?: Transport | symbol | Record<string, unknown>,
  maybeExtras?: Record<string, unknown>,
): {
  transport?: Transport | symbol;
  extras?: Record<string, unknown>;
} {
  if (
    transportOrExtras !== undefined &&
    transportOrExtras !== null &&
    typeof transportOrExtras === "object"
  ) {
    return { extras: transportOrExtras };
  }
  return {
    transport: transportOrExtras as Transport | symbol | undefined,
    extras: maybeExtras,
  };
}

/**
 * Registers a controller/provider method as a request-reply RPC handler for `pattern`.
 * Inheritance-safe (copy-on-write on target constructor).
 */
export function MessagePattern(
  pattern: PatternInput | readonly PatternInput[],
  transportOrExtras?: Transport | symbol | Record<string, unknown>,
  maybeExtras?: Record<string, unknown>,
): MethodDecorator {
  const { transport, extras } = parsePatternArgs(
    transportOrExtras,
    maybeExtras,
  );
  const patterns: readonly PatternInput[] = Array.isArray(pattern)
    ? (pattern as readonly PatternInput[])
    : [pattern as PatternInput];

  return (
    target: object,
    propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ) => {
    const entries: PatternHandlerMetadata[] = patterns.map((p) => ({
      methodName: propertyKey,
      pattern: p,
      normalizedPattern: normalizePattern(p),
      isEventHandler: false,
      transport,
      extras,
    }));

    MetadataRegistry.appendOwnArray<PatternHandlerMetadata>(
      MESSAGE_PATTERN_METADATA,
      entries,
      target.constructor,
    );

    if (descriptor?.value) {
      const existingPatterns =
        MetadataRegistry.get<unknown[]>(PATTERN_METADATA, descriptor.value) ??
        [];
      MetadataRegistry.define(
        PATTERN_METADATA,
        [...existingPatterns, ...patterns],
        descriptor.value,
      );
      if (transport !== undefined) {
        MetadataRegistry.define(
          TRANSPORT_METADATA,
          transport,
          descriptor.value,
        );
      }
      if (extras !== undefined) {
        const prevExtras =
          MetadataRegistry.get<Record<string, unknown>>(
            PATTERN_EXTRAS_METADATA,
            descriptor.value,
          ) ?? {};
        MetadataRegistry.define(
          PATTERN_EXTRAS_METADATA,
          { ...prevExtras, ...extras },
          descriptor.value,
        );
      }
    }
  };
}

/**
 * Registers a controller/provider method as a fire-and-forget event handler for `pattern`.
 * Inheritance-safe (copy-on-write on target constructor).
 */
export function EventPattern(
  pattern: PatternInput | readonly PatternInput[],
  transportOrExtras?: Transport | symbol | Record<string, unknown>,
  maybeExtras?: Record<string, unknown>,
): MethodDecorator;
export function EventPattern<TEventTypes extends Record<string, unknown>>(
  topic: keyof TEventTypes,
): EventDataMethodDecorator<TEventTypes, typeof topic>;
export function EventPattern<TEventTypes extends Record<string, unknown>>(
  topic: keyof TEventTypes,
  transport: Transport | symbol,
): EventDataMethodDecorator<TEventTypes, typeof topic>;
export function EventPattern<TEventTypes extends Record<string, unknown>>(
  topic: keyof TEventTypes,
  extras: Record<string, unknown>,
): EventDataMethodDecorator<TEventTypes, typeof topic>;
export function EventPattern<TEventTypes extends Record<string, unknown>>(
  topic: keyof TEventTypes,
  transport: Transport | symbol,
  extras: Record<string, unknown>,
): EventDataMethodDecorator<TEventTypes, typeof topic>;
export function EventPattern(
  pattern: PatternInput | readonly PatternInput[] | PropertyKey,
  transportOrExtras?: Transport | symbol | Record<string, unknown>,
  maybeExtras?: Record<string, unknown>,
): MethodDecorator {
  const { transport, extras } = parsePatternArgs(
    transportOrExtras,
    maybeExtras,
  );
  const patterns: readonly PatternInput[] = Array.isArray(pattern)
    ? (pattern as readonly PatternInput[])
    : [pattern as PatternInput];

  return (
    target: object,
    propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ) => {
    const entries: PatternHandlerMetadata[] = patterns.map((p) => ({
      methodName: propertyKey,
      pattern: p,
      normalizedPattern: normalizePattern(p),
      isEventHandler: true,
      transport,
      extras,
    }));

    MetadataRegistry.appendOwnArray<PatternHandlerMetadata>(
      EVENT_PATTERN_METADATA,
      entries,
      target.constructor,
    );

    if (descriptor?.value) {
      const existingPatterns =
        MetadataRegistry.get<unknown[]>(PATTERN_METADATA, descriptor.value) ??
        [];
      MetadataRegistry.define(
        PATTERN_METADATA,
        [...existingPatterns, ...patterns],
        descriptor.value,
      );
      if (transport !== undefined) {
        MetadataRegistry.define(
          TRANSPORT_METADATA,
          transport,
          descriptor.value,
        );
      }
      if (extras !== undefined) {
        const prevExtras =
          MetadataRegistry.get<Record<string, unknown>>(
            PATTERN_EXTRAS_METADATA,
            descriptor.value,
          ) ?? {};
        MetadataRegistry.define(
          PATTERN_EXTRAS_METADATA,
          { ...prevExtras, ...extras },
          descriptor.value,
        );
      }
    }
  };
}

/**
 * Property decorator attaching a `ClientProxy` instance configured with `metadata`
 * onto a controller or provider property (matches NestJS `@Client(options)`).
 */
export function Client(metadata?: ClientOptions): PropertyDecorator {
  return (target: object, propertyKey: string | symbol) => {
    Reflect.set(target, propertyKey, null);
    MetadataRegistry.define(CLIENT_METADATA, true, target, propertyKey);
    MetadataRegistry.define(
      CLIENT_CONFIGURATION_METADATA,
      metadata,
      target,
      propertyKey,
    );

    // Record decorated property keys on the constructor for fast discovery
    MetadataRegistry.appendOwnArray<string | symbol>(
      CLIENT_METADATA,
      [propertyKey],
      target.constructor,
    );
  };
}

function recordRpcParam(
  target: object,
  propertyKey: string | symbol,
  entry: RpcParamMetadata,
): void {
  const existing =
    MetadataRegistry.getOwn<readonly RpcParamMetadata[]>(
      RPC_PARAM_METADATA,
      target,
      propertyKey,
    ) ?? [];
  const filtered = existing.filter((p) => p.index !== entry.index);
  const next = [...filtered, entry].sort((a, b) => a.index - b.index);
  MetadataRegistry.define(RPC_PARAM_METADATA, next, target, propertyKey);
}

/**
 * Extracts the incoming RPC payload (or a named property of it), optionally running pipes.
 */
export function Payload(
  propertyOrPipe?: string | PipeLike,
  ...pipes: PipeLike[]
): ParameterDecorator {
  return (
    target: object,
    propertyKey: string | symbol | undefined,
    parameterIndex: number,
  ) => {
    if (propertyKey === undefined) {
      throw new Error("@Payload() can only be used on method parameters.");
    }
    const property =
      typeof propertyOrPipe === "string" ? propertyOrPipe : undefined;
    const resolvedPipes =
      typeof propertyOrPipe === "string"
        ? pipes
        : propertyOrPipe !== undefined
          ? [propertyOrPipe, ...pipes]
          : pipes;

    recordRpcParam(target, propertyKey, {
      index: parameterIndex,
      kind: "payload",
      property,
      pipes: resolvedPipes,
    });
  };
}

/**
 * Injects the transport-specific `RpcContext` for the active RPC message/event.
 */
export function Ctx(): ParameterDecorator {
  return (
    target: object,
    propertyKey: string | symbol | undefined,
    parameterIndex: number,
  ) => {
    if (propertyKey === undefined) {
      throw new Error("@Ctx() can only be used on method parameters.");
    }
    recordRpcParam(target, propertyKey, {
      index: parameterIndex,
      kind: "ctx",
    });
  };
}
