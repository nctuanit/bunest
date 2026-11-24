import { MetadataRegistry, type PipeLike } from "@bunest/core";
import { EVENT_PARAMS_METADATA, EVENT_PAYLOAD } from "../constants";

export interface EventParamMetadata {
  readonly index: number;
  readonly type: "eventPayload";
  readonly token: typeof EVENT_PAYLOAD;
  readonly data?: string;
  readonly pipes?: readonly PipeLike[];
}

/**
 * Parameter decorator binding an `@OnEvent()` handler parameter to the emitted
 * event payload (or a named property on the payload object), with optional pipes.
 * Copy-on-write: never mutates parent class metadata.
 */
export function EventPayload(): ParameterDecorator;
export function EventPayload(...pipes: PipeLike[]): ParameterDecorator;
export function EventPayload(
  property: string,
  ...pipes: PipeLike[]
): ParameterDecorator;
export function EventPayload(
  propertyOrPipe?: string | PipeLike,
  ...restPipes: PipeLike[]
): ParameterDecorator {
  let property: string | undefined;
  let pipes: PipeLike[];

  if (typeof propertyOrPipe === "string") {
    property = propertyOrPipe;
    pipes = [...restPipes];
  } else if (propertyOrPipe !== undefined) {
    property = undefined;
    pipes = [propertyOrPipe, ...restPipes];
  } else {
    property = undefined;
    pipes = [...restPipes];
  }

  return (
    target: object,
    propertyKey: string | symbol | undefined,
    parameterIndex: number,
  ) => {
    if (propertyKey === undefined) {
      throw new Error(
        "@EventPayload() can only be used on method parameters, not constructor parameters.",
      );
    }

    const existing =
      MetadataRegistry.getOwn<Record<string, EventParamMetadata>>(
        EVENT_PARAMS_METADATA,
        target,
        propertyKey,
      ) ?? {};

    const entryKey = `eventPayload:${parameterIndex}`;
    const next: Record<string, EventParamMetadata> = {
      ...existing,
      [entryKey]: {
        index: parameterIndex,
        type: "eventPayload",
        token: EVENT_PAYLOAD,
        ...(property !== undefined ? { data: property } : {}),
        ...(pipes.length > 0 ? { pipes } : {}),
      },
    };

    MetadataRegistry.define(EVENT_PARAMS_METADATA, next, target, propertyKey);
  };
}

/**
 * Inheritance-safe reader for `@EventPayload()` parameter metadata on a class
 * method. Reads own metadata from the defining prototype of `methodName` so
 * overridden methods never leak parent parameter decorators.
 */
export function getEventParamMetadata(
  target: Function,
  methodName: string | symbol,
): Record<string, EventParamMetadata> | undefined {
  let proto: object | null = (target.prototype as object | null) ?? null;
  let definingProto: object | null = null;

  while (proto && proto !== Object.prototype) {
    if (Object.prototype.hasOwnProperty.call(proto, methodName)) {
      definingProto = proto;
      break;
    }
    proto = Object.getPrototypeOf(proto) as object | null;
  }

  if (!definingProto) {
    return undefined;
  }

  const raw = MetadataRegistry.getOwn<Record<string, EventParamMetadata>>(
    EVENT_PARAMS_METADATA,
    definingProto,
    methodName,
  );
  if (!raw || Object.keys(raw).length === 0) {
    return undefined;
  }
  return { ...raw };
}
