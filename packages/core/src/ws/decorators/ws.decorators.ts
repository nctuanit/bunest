import {
  DESIGN_METADATA_KEYS,
  METADATA_KEYS,
  MetadataRegistry,
  type ParameterDecoratorOptions,
  type PipeLike,
  Scope,
  type StandardSchemaV1,
} from "../../common/index";
import { WS_METADATA_KEYS } from "../constants";
import type {
  GatewayMetadata,
  WebSocketGatewayOptions,
  WebSocketServerOptions,
  WsMessageHandlerMetadata,
  WsParamMetadata,
} from "../interfaces/ws.interface";

/**
 * Marks a class as a Bunest WebSocket gateway (and implicitly injectable as a singleton).
 * Supports NestJS overloads:
 * - `@WebSocketGateway()`
 * - `@WebSocketGateway(8080)`
 * - `@WebSocketGateway(8080, { namespace: '/chat' })`
 * - `@WebSocketGateway({ path: '/ws/chat' })`
 * - `@WebSocketGateway('/ws/chat', options?)`
 */
export function WebSocketGateway(port?: number): ClassDecorator;
export function WebSocketGateway(
  path: string,
  options?: WebSocketGatewayOptions,
): ClassDecorator;
export function WebSocketGateway<
  T extends Record<string, any> = WebSocketGatewayOptions & GatewayMetadata,
>(options?: T): ClassDecorator;
export function WebSocketGateway<
  T extends Record<string, any> = WebSocketGatewayOptions & GatewayMetadata,
>(port?: number, options?: T): ClassDecorator;
export function WebSocketGateway(
  portOrPathOrOptions?: number | string | WebSocketGatewayOptions,
  maybeOptions?: WebSocketGatewayOptions,
): ClassDecorator {
  let normalized: WebSocketGatewayOptions;
  if (typeof portOrPathOrOptions === "number") {
    normalized = {
      ...(maybeOptions ?? {}),
      port: portOrPathOrOptions,
    };
  } else if (typeof portOrPathOrOptions === "string") {
    normalized = {
      ...(maybeOptions ?? {}),
      path: portOrPathOrOptions,
    };
  } else {
    normalized = { ...(portOrPathOrOptions ?? {}) };
  }

  return (target: Function) => {
    MetadataRegistry.define<WebSocketGatewayOptions>(
      WS_METADATA_KEYS.GATEWAY,
      normalized,
      target,
    );
    if (!MetadataRegistry.hasOwn(METADATA_KEYS.INJECTABLE, target)) {
      MetadataRegistry.define(
        METADATA_KEYS.INJECTABLE,
        { scope: normalized.scope ?? Scope.SINGLETON },
        target,
      );
    }
  };
}

/**
 * Subscribes a gateway method to an incoming WebSocket event name
 * (use `"binary"` for raw binary frames or `"*"` as a catch-all event listener).
 * Copy-on-write on `target.constructor` so subclasses never mutate parent metadata.
 */
export function SubscribeMessage<T = string>(event: T): MethodDecorator {
  const eventName = String(event);
  return (
    target: object,
    propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ) => {
    const existing =
      MetadataRegistry.getOwn<readonly WsMessageHandlerMetadata[]>(
        WS_METADATA_KEYS.MESSAGE_HANDLERS,
        target.constructor,
      ) ?? [];

    const entry: WsMessageHandlerMetadata = {
      event: eventName,
      handlerKey: propertyKey,
    };

    const next = [...existing, entry];
    MetadataRegistry.define(
      WS_METADATA_KEYS.MESSAGE_HANDLERS,
      next,
      target.constructor,
    );

    if (typeof descriptor?.value === "function") {
      const existingFnEntries =
        MetadataRegistry.getOwn<readonly WsMessageHandlerMetadata[]>(
          WS_METADATA_KEYS.MESSAGE_HANDLERS,
          descriptor.value,
        ) ?? [];
      MetadataRegistry.define(
        WS_METADATA_KEYS.MESSAGE_HANDLERS,
        [...existingFnEntries, entry],
        descriptor.value,
      );
    }

    return descriptor;
  };
}

const WS_PARAM_DECORATOR_NAMES: Record<string, string> = {
  body: "MessageBody",
  param: "WsParam",
  ack: "Ack",
};

function registerWsParam(
  target: object,
  propertyKey: string | symbol | undefined,
  entry: WsParamMetadata,
): void {
  if (propertyKey === undefined) {
    const decoratorName =
      WS_PARAM_DECORATOR_NAMES[entry.source] ?? "ConnectedSocket";
    throw new Error(
      `WebSocket parameter decorator (@${decoratorName}) can only be used on gateway methods, not constructor parameters.`,
    );
  }

  const existing =
    MetadataRegistry.getOwn<readonly WsParamMetadata[]>(
      WS_METADATA_KEYS.MESSAGE_PARAMS,
      target,
      propertyKey,
    ) ?? [];

  const duplicate = existing.find((item) => item.index === entry.index);
  if (duplicate) {
    throw new Error(
      `Duplicate WebSocket parameter decorator on ${target.constructor?.name ?? "Gateway"}.${String(propertyKey)} at index ${entry.index}.`,
    );
  }

  const next = [...existing, entry].sort((a, b) => a.index - b.index);
  MetadataRegistry.define(
    WS_METADATA_KEYS.MESSAGE_PARAMS,
    next,
    target,
    propertyKey,
  );
  const methodFn = Object.getOwnPropertyDescriptor(target, propertyKey)?.value;
  if (typeof methodFn === "function") {
    MetadataRegistry.define(WS_METADATA_KEYS.MESSAGE_PARAMS, next, methodFn);
  }
}

function isWsParameterDecoratorOptions(
  value: unknown,
): value is ParameterDecoratorOptions {
  if (
    value === null ||
    value === undefined ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }
  if (typeof (value as { transform?: unknown }).transform === "function") {
    return false;
  }
  return "schema" in value || "pipes" in value || "property" in value;
}

function parseWsParamArgs(
  propertyOrPipeOrOptions?: string | PipeLike | ParameterDecoratorOptions,
  restPipesOrOptions: (PipeLike | ParameterDecoratorOptions)[] = [],
): {
  key?: string;
  schema?: StandardSchemaV1;
  pipes: PipeLike[];
} {
  let key: string | undefined;
  let schema: StandardSchemaV1 | undefined;
  let pipes: PipeLike[] = [];

  if (typeof propertyOrPipeOrOptions === "string") {
    key = propertyOrPipeOrOptions;
    if (
      restPipesOrOptions.length > 0 &&
      isWsParameterDecoratorOptions(restPipesOrOptions[0])
    ) {
      const opts = restPipesOrOptions[0];
      schema = opts.schema;
      pipes = [
        ...(opts.pipes ?? []),
        ...(restPipesOrOptions.slice(1) as PipeLike[]),
      ];
    } else {
      pipes = [...(restPipesOrOptions as PipeLike[])];
    }
  } else if (isWsParameterDecoratorOptions(propertyOrPipeOrOptions)) {
    key = propertyOrPipeOrOptions.property;
    schema = propertyOrPipeOrOptions.schema;
    pipes = [
      ...(propertyOrPipeOrOptions.pipes ?? []),
      ...(restPipesOrOptions as PipeLike[]),
    ];
  } else if (propertyOrPipeOrOptions !== undefined) {
    pipes = [
      propertyOrPipeOrOptions,
      ...(restPipesOrOptions as PipeLike[]),
    ];
  } else {
    pipes = [...(restPipesOrOptions as PipeLike[])];
  }

  return { key, schema, pipes };
}

/**
 * Extracts the parsed message payload (or a specific property key) and runs
 * any parameter-level pipes (`ValidationPipe`, `ParseIntPipe`, etc.) or schema.
 */
export function MessageBody(): ParameterDecorator;
export function MessageBody(
  options: ParameterDecoratorOptions,
): ParameterDecorator;
export function MessageBody(...pipes: PipeLike[]): ParameterDecorator;
export function MessageBody(
  property: string,
  options: ParameterDecoratorOptions,
): ParameterDecorator;
export function MessageBody(
  property: string,
  ...pipes: PipeLike[]
): ParameterDecorator;
export function MessageBody(
  propertyOrPipeOrOptions?: string | PipeLike | ParameterDecoratorOptions,
  ...restPipesOrOptions: (PipeLike | ParameterDecoratorOptions)[]
): ParameterDecorator {
  const { key, schema, pipes } = parseWsParamArgs(
    propertyOrPipeOrOptions,
    restPipesOrOptions,
  );

  return (
    target: object,
    propertyKey: string | symbol | undefined,
    parameterIndex: number,
  ) => {
    registerWsParam(target, propertyKey, {
      index: parameterIndex,
      source: "body",
      key,
      pipes: pipes.length > 0 ? pipes : undefined,
      ...(schema !== undefined ? { schema } : {}),
    });
  };
}

/**
 * Extracts dynamic path parameters matched from `@WebSocketGateway({ path: '/chat/:roomId/socket' })`
 * (either the full frozen params object or a specific named parameter) and runs
 * any parameter-level pipes or Standard Schema validation.
 */
export function WsParam(): ParameterDecorator;
export function WsParam(
  options: ParameterDecoratorOptions,
): ParameterDecorator;
export function WsParam(...pipes: PipeLike[]): ParameterDecorator;
export function WsParam(
  property: string,
  options: ParameterDecoratorOptions,
): ParameterDecorator;
export function WsParam(
  property: string,
  ...pipes: PipeLike[]
): ParameterDecorator;
export function WsParam(
  propertyOrPipeOrOptions?: string | PipeLike | ParameterDecoratorOptions,
  ...restPipesOrOptions: (PipeLike | ParameterDecoratorOptions)[]
): ParameterDecorator {
  const { key, schema, pipes } = parseWsParamArgs(
    propertyOrPipeOrOptions,
    restPipesOrOptions,
  );

  return (
    target: object,
    propertyKey: string | symbol | undefined,
    parameterIndex: number,
  ) => {
    registerWsParam(target, propertyKey, {
      index: parameterIndex,
      source: "param",
      key,
      pipes: pipes.length > 0 ? pipes : undefined,
      ...(schema !== undefined ? { schema } : {}),
    });
  };
}

/**
 * Injects the connected `BunWsClient` into a `@SubscribeMessage()` handler parameter.
 */
export function ConnectedSocket(): ParameterDecorator {
  return (
    target: object,
    propertyKey: string | symbol | undefined,
    parameterIndex: number,
  ) => {
    registerWsParam(target, propertyKey, {
      index: parameterIndex,
      source: "client",
    });
  };
}

/**
 * Injects an acknowledgement callback into a `@SubscribeMessage()` handler
 * (matching NestJS `@Ack()`). Calling `ack(payload)` sends a response frame
 * correlated with the incoming message's `id`.
 */
export function Ack(): ParameterDecorator {
  return (
    target: object,
    propertyKey: string | symbol | undefined,
    parameterIndex: number,
  ) => {
    registerWsParam(target, propertyKey, {
      index: parameterIndex,
      source: "ack",
    });
  };
}

/**
 * Marks a gateway property to receive the gateway's `BunWsServer` instance
 * before `afterInit(server)` executes.
 */
export function WebSocketServer(
  _options?: Partial<WebSocketServerOptions>,
): PropertyDecorator {
  return (target: object, propertyKey: string | symbol): void => {
    Reflect.set(target, propertyKey, null);
    const metaTarget =
      typeof target === "function" ? target : target.constructor;
    const existing =
      MetadataRegistry.getOwn<readonly (string | symbol)[]>(
        WS_METADATA_KEYS.WEBSOCKET_SERVER_PROPS,
        metaTarget,
      ) ?? [];

    if (!existing.includes(propertyKey)) {
      MetadataRegistry.define(
        WS_METADATA_KEYS.WEBSOCKET_SERVER_PROPS,
        [...existing, propertyKey],
        metaTarget,
      );
    }
  };
}

/**
 * Inheritance-safe reader for `@SubscribeMessage` handlers across a gateway's prototype chain,
 * including methods copied onto `gatewayClass.prototype` by mixin helpers (e.g. `applyMixins()`).
 */
export function getGatewayMessageHandlers(
  gatewayClass: Function,
): WsMessageHandlerMetadata[] {
  const chain = MetadataRegistry.getPrototypeChain(gatewayClass);
  const byHandler = new Map<string | symbol, WsMessageHandlerMetadata[]>();
  const orderedKeys: Array<string | symbol> = [];

  for (const ctor of chain) {
    const own = MetadataRegistry.getOwn<readonly WsMessageHandlerMetadata[]>(
      WS_METADATA_KEYS.MESSAGE_HANDLERS,
      ctor,
    );
    if (!own || own.length === 0) continue;

    const grouped = new Map<string | symbol, WsMessageHandlerMetadata[]>();
    for (const entry of own) {
      let bucket = grouped.get(entry.handlerKey);
      if (!bucket) {
        bucket = [];
        grouped.set(entry.handlerKey, bucket);
      }
      bucket.push({ ...entry });
    }

    for (const [key, list] of grouped.entries()) {
      if (!byHandler.has(key)) {
        orderedKeys.push(key);
      }
      byHandler.set(key, list);
    }
  }

  // Also discover mixed-in methods whose descriptors were copied onto the prototype
  const proto = gatewayClass.prototype as object | undefined;
  if (proto) {
    const descriptors = Object.getOwnPropertyDescriptors(proto);
    for (const key of [
      ...Object.keys(descriptors),
      ...Object.getOwnPropertySymbols(descriptors),
    ]) {
      if (key === "constructor" || byHandler.has(key)) continue;
      const desc = descriptors[key as keyof typeof descriptors];
      if (!desc || typeof desc.value !== "function") continue;
      const fnHandlers = MetadataRegistry.getOwn<
        readonly WsMessageHandlerMetadata[]
      >(WS_METADATA_KEYS.MESSAGE_HANDLERS, desc.value);
      if (!fnHandlers || fnHandlers.length === 0) continue;
      orderedKeys.push(key);
      byHandler.set(
        key,
        fnHandlers.map((entry) => ({ ...entry, handlerKey: key })),
      );
    }
  }

  const out: WsMessageHandlerMetadata[] = [];
  for (const key of orderedKeys) {
    const list = byHandler.get(key);
    if (list) out.push(...list);
  }
  return out;
}

/**
 * Inheritance-safe reader for `@MessageBody` / `@ConnectedSocket` parameter metadata
 * enriched with TypeScript `design:paramtypes`.
 */
export function getGatewayMethodParams(
  gatewayClass: Function,
  handlerKey: string | symbol,
): WsParamMetadata[] {
  let proto: object | null = (gatewayClass.prototype as object | null) ?? null;
  let definingProto: object | null = null;

  while (proto && proto !== Object.prototype) {
    if (Object.prototype.hasOwnProperty.call(proto, handlerKey)) {
      definingProto = proto;
      break;
    }
    proto = Object.getPrototypeOf(proto) as object | null;
  }

  if (!definingProto) {
    return [];
  }

  let rawParams =
    MetadataRegistry.getOwn<readonly WsParamMetadata[]>(
      WS_METADATA_KEYS.MESSAGE_PARAMS,
      definingProto,
      handlerKey,
    ) ?? [];

  if (rawParams.length === 0) {
    const methodFn = Object.getOwnPropertyDescriptor(
      definingProto,
      handlerKey,
    )?.value;
    if (typeof methodFn === "function") {
      rawParams =
        MetadataRegistry.getOwn<readonly WsParamMetadata[]>(
          WS_METADATA_KEYS.MESSAGE_PARAMS,
          methodFn,
        ) ?? [];
    }
  }

  const paramTypes = MetadataRegistry.getOwn<Function[]>(
    DESIGN_METADATA_KEYS.PARAMTYPES,
    definingProto,
    handlerKey,
  );

  return rawParams
    .map((param) => ({
      ...param,
      metatype: param.metatype ?? paramTypes?.[param.index],
    }))
    .sort((a, b) => a.index - b.index);
}

/**
 * Reads all `@WebSocketServer()` property keys across the gateway's inheritance chain.
 */
export function getGatewayServerProperties(
  gatewayClass: Function,
): Array<string | symbol> {
  const merged = MetadataRegistry.getMergedClassArray<string | symbol>(
    WS_METADATA_KEYS.WEBSOCKET_SERVER_PROPS,
    gatewayClass,
  );
  return [...new Set(merged)];
}
