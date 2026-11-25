import { METADATA_KEYS } from "../constants/metadata-keys";
import type {
  CustomParamFactory,
  ParameterMetadata,
  ParameterSource,
  PipeLike,
  ResponseDecoratorOptions,
} from "../interfaces/http.interface";
import type { ExecutionContext } from "../interfaces/pipeline.interface";
import {
  isStandardSchema,
  type StandardSchemaV1,
} from "../interfaces/standard-schema.interface";
import { MetadataRegistry } from "../metadata/metadata-registry";

/**
 * NestJS v12-style options object supporting first-class inline Standard Schema v1
 * validation directly on `@Body({ schema })`, `@Query({ schema })`, and `@Param({ schema })`.
 */
export interface KeyedParamSchemaOptions {
  readonly schema?: StandardSchemaV1;
  readonly property?: string;
  readonly pipes?: readonly PipeLike[];
}

function isKeyedParamSchemaOptions(
  value: unknown,
): value is KeyedParamSchemaOptions {
  if (typeof value !== "object" || value === null || isPipeLike(value)) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  if ("schema" in obj && isStandardSchema(obj.schema)) {
    return true;
  }
  if ("pipes" in obj && Array.isArray(obj.pipes) && !("~standard" in obj)) {
    return true;
  }
  return false;
}

function isPipeLike(value: unknown): value is PipeLike {
  if (typeof value === "object" && value !== null) {
    return typeof (value as { transform?: unknown }).transform === "function";
  }
  if (typeof value === "function") {
    return (
      typeof (value as { prototype?: { transform?: unknown } }).prototype
        ?.transform === "function"
    );
  }
  return false;
}

function registerParameterMetadata(
  target: object,
  propertyKey: string | symbol | undefined,
  entry: ParameterMetadata,
): void {
  if (propertyKey === undefined) {
    throw new Error(
      `Route parameter decorator (@${entry.source}) can only be used on controller methods, not constructor parameters.`,
    );
  }

  // Copy-on-write on own metadata of (target, propertyKey) so subclasses NEVER mutate parent metadata
  const existing =
    MetadataRegistry.getOwn<readonly ParameterMetadata[]>(
      METADATA_KEYS.ROUTE_PARAMS,
      target,
      propertyKey,
    ) ?? [];

  const duplicate = existing.find((item) => item.index === entry.index);
  if (duplicate) {
    const className = target.constructor?.name ?? "UnknownController";
    throw new Error(
      `Duplicate parameter decorator on ${className}.${String(propertyKey)} at parameter index ${entry.index} (existing: "${duplicate.source}", attempted: "${entry.source}").`,
    );
  }

  const next = [...existing, entry].sort((a, b) => a.index - b.index);
  MetadataRegistry.define(
    METADATA_KEYS.ROUTE_PARAMS,
    next,
    target,
    propertyKey,
  );
}

function parsePropertyAndPipes(
  propertyOrPipe:
    string | PipeLike | KeyedParamSchemaOptions | StandardSchemaV1 | undefined,
  restPipes: Array<PipeLike | KeyedParamSchemaOptions | StandardSchemaV1>,
): { key?: string; pipes: PipeLike[]; schema?: StandardSchemaV1 } {
  if (typeof propertyOrPipe === "string") {
    const first = restPipes[0];
    if (isStandardSchema(first)) {
      return {
        key: propertyOrPipe,
        schema: first,
        pipes: restPipes.slice(1) as PipeLike[],
      };
    }
    if (isKeyedParamSchemaOptions(first)) {
      return {
        key: first.property ?? propertyOrPipe,
        schema: first.schema,
        pipes: [...(first.pipes ?? []), ...(restPipes.slice(1) as PipeLike[])],
      };
    }
    return { key: propertyOrPipe, pipes: [...(restPipes as PipeLike[])] };
  }
  if (isStandardSchema(propertyOrPipe)) {
    return {
      key: undefined,
      schema: propertyOrPipe,
      pipes: [...(restPipes as PipeLike[])],
    };
  }
  if (isKeyedParamSchemaOptions(propertyOrPipe)) {
    return {
      key: propertyOrPipe.property,
      schema: propertyOrPipe.schema,
      pipes: [...(propertyOrPipe.pipes ?? []), ...(restPipes as PipeLike[])],
    };
  }
  if (propertyOrPipe !== undefined) {
    return {
      key: undefined,
      pipes: [propertyOrPipe, ...(restPipes as PipeLike[])],
    };
  }
  return { key: undefined, pipes: [...(restPipes as PipeLike[])] };
}

function createKeyedParamDecorator(source: ParameterSource) {
  function decorator(): ParameterDecorator;
  function decorator(
    schema: StandardSchemaV1,
    ...pipes: PipeLike[]
  ): ParameterDecorator;
  function decorator(
    options: KeyedParamSchemaOptions,
    ...pipes: PipeLike[]
  ): ParameterDecorator;
  function decorator(...pipes: PipeLike[]): ParameterDecorator;
  function decorator(
    property: string,
    schema: StandardSchemaV1,
    ...pipes: PipeLike[]
  ): ParameterDecorator;
  function decorator(
    property: string,
    options: KeyedParamSchemaOptions,
    ...pipes: PipeLike[]
  ): ParameterDecorator;
  function decorator(
    property: string,
    ...pipes: PipeLike[]
  ): ParameterDecorator;
  function decorator(
    propertyOrPipe?:
      string | PipeLike | KeyedParamSchemaOptions | StandardSchemaV1,
    ...restPipes: Array<PipeLike | KeyedParamSchemaOptions | StandardSchemaV1>
  ): ParameterDecorator {
    const { key, pipes, schema } = parsePropertyAndPipes(
      propertyOrPipe,
      restPipes,
    );

    return (
      target: object,
      propertyKey: string | symbol | undefined,
      parameterIndex: number,
    ) => {
      registerParameterMetadata(target, propertyKey, {
        index: parameterIndex,
        source,
        key,
        data: key,
        pipes: pipes.length > 0 ? pipes : undefined,
        schema,
      });
    };
  }
  return decorator;
}

function createSimpleParamDecorator(source: ParameterSource) {
  return (): ParameterDecorator => {
    return (
      target: object,
      propertyKey: string | symbol | undefined,
      parameterIndex: number,
    ) => {
      registerParameterMetadata(target, propertyKey, {
        index: parameterIndex,
        source,
      });
    };
  };
}

export const Body = createKeyedParamDecorator("body");
export const Query = createKeyedParamDecorator("query");
export const Param = createKeyedParamDecorator("param");
export const Headers = createKeyedParamDecorator("header");
export const HostParam = createKeyedParamDecorator("hostParam");
export const Cookies = createKeyedParamDecorator("cookies");
export const SignedCookies = createKeyedParamDecorator("signedCookies");
export const Session = createKeyedParamDecorator("session");
export const UploadedFile = createKeyedParamDecorator("uploadedFile");
export const UploadedFiles = createKeyedParamDecorator("uploadedFiles");

export const Req = createSimpleParamDecorator("request");
export const Request = Req;

export function Res(options?: ResponseDecoratorOptions): ParameterDecorator {
  return (
    target: object,
    propertyKey: string | symbol | undefined,
    parameterIndex: number,
  ) => {
    registerParameterMetadata(target, propertyKey, {
      index: parameterIndex,
      source: "response",
      ...(options?.passthrough !== undefined
        ? { passthrough: options.passthrough }
        : {}),
    });
  };
}
export const Response = Res;

export const Next = createSimpleParamDecorator("next");
export const Ip = createSimpleParamDecorator("ip");

/**
 * Applies parameter decorators to a method for plain JavaScript / non-parameter-decorator
 * compatibility (matching NestJS `@Bind()`).
 */
export function Bind(...decorators: ParameterDecorator[]): MethodDecorator {
  return (
    target: object,
    propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ) => {
    for (let index = 0; index < decorators.length; index++) {
      const decorator = decorators[index];
      if (typeof decorator === "function") {
        decorator(target, propertyKey, index);
      }
    }
    return descriptor;
  };
}

/**
 * Injects the request's `AbortSignal` into an `@Sse()` (or regular) route handler
 * for clean client-disconnect and backpressure cleanup (NestJS v12.2 parity).
 */
export const SseSignal = createSimpleParamDecorator("sseSignal");

function isParamDecoratorOptions(
  value: unknown,
): value is KeyedParamSchemaOptions {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    isPipeLike(value) ||
    "~standard" in value
  ) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) {
    return false;
  }
  for (const key of keys) {
    if (key !== "schema" && key !== "pipes") {
      return false;
    }
  }
  if (
    "schema" in obj &&
    obj.schema !== undefined &&
    !isStandardSchema(obj.schema)
  ) {
    return false;
  }
  if ("pipes" in obj && obj.pipes !== undefined) {
    if (
      !Array.isArray(obj.pipes) ||
      !obj.pipes.every((p) => p === undefined || isPipeLike(p))
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Extracts the raw unparsed request body (`Uint8Array`) when `rawBody: true`
 * is enabled on the application/adapter (ideal for HMAC webhook verification).
 */
export function RawBody(
  ...pipesOrOptions: Array<PipeLike | KeyedParamSchemaOptions | StandardSchemaV1>
): ParameterDecorator {
  const pipes: PipeLike[] = [];
  let schema: StandardSchemaV1 | undefined;
  for (const arg of pipesOrOptions) {
    if (isStandardSchema(arg)) {
      schema = arg;
    } else if (isParamDecoratorOptions(arg) || isKeyedParamSchemaOptions(arg)) {
      if (arg.schema !== undefined) schema = arg.schema;
      if (arg.pipes) {
        for (const p of arg.pipes) {
          if (p !== undefined) pipes.push(p);
        }
      }
    } else if (arg !== undefined) {
      pipes.push(arg as PipeLike);
    }
  }
  const capturedPipes = pipes.length > 0 ? pipes : undefined;
  return (
    target: object,
    propertyKey: string | symbol | undefined,
    parameterIndex: number,
  ) => {
    registerParameterMetadata(target, propertyKey, {
      index: parameterIndex,
      source: "rawBody",
      pipes: capturedPipes,
      ...(schema !== undefined ? { schema } : {}),
    });
  };
}

export type ParamDecoratorEnhancer = ParameterDecorator;

/**
 * Creates a reusable custom route parameter decorator backed by a factory function.
 */
export function createParamDecorator<
  TData = unknown,
  TContext = ExecutionContext,
  TResult = unknown,
>(
  factory: CustomParamFactory<TData, TContext, TResult>,
  enhancers: readonly ParamDecoratorEnhancer[] = [],
) {
  return (
    ...args: Array<TData | PipeLike | KeyedParamSchemaOptions>
  ): ParameterDecorator => {
    let data: unknown;
    const pipes: PipeLike[] = [];
    let schema: StandardSchemaV1 | undefined;

    if (args.length > 0) {
      const first = args[0];
      let startIndex = 0;

      if (
        first !== undefined &&
        !isPipeLike(first) &&
        !isParamDecoratorOptions(first)
      ) {
        data = first;
        startIndex = 1;
      } else if (first === undefined) {
        data = undefined;
        startIndex = 1;
      }

      for (let i = startIndex; i < args.length; i++) {
        const arg = args[i];
        if (isParamDecoratorOptions(arg)) {
          if (arg.schema !== undefined) {
            schema = arg.schema;
          }
          if (arg.pipes) {
            for (const p of arg.pipes) {
              if (p !== undefined) {
                pipes.push(p);
              }
            }
          }
        } else if (arg !== undefined) {
          pipes.push(arg as PipeLike);
        }
      }
    }

    return (
      target: object,
      propertyKey: string | symbol | undefined,
      parameterIndex: number,
    ) => {
      registerParameterMetadata(target, propertyKey, {
        index: parameterIndex,
        source: "custom",
        key: typeof data === "string" ? data : undefined,
        data,
        pipes: pipes.length > 0 ? pipes : undefined,
        factory: factory as CustomParamFactory,
        ...(schema !== undefined ? { schema } : {}),
      });
      for (const enhancer of enhancers) {
        enhancer(target, propertyKey, parameterIndex);
      }
    };
  };
}
