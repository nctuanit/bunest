import {
  DESIGN_METADATA_KEYS,
  METADATA_KEYS,
  MetadataRegistry,
  type PipeLike,
  Scope,
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

    return descriptor;
  };
}

function registerWsParam(
  target: object,
  propertyKey: string | symbol | undefined,
  entry: WsParamMetadata,
): void {
  if (propertyKey === undefined) {
    throw new Error(
      `WebSocket parameter decorator (@${entry.source === "body" ? "MessageBody" : "ConnectedSocket"}) can only be used on gateway methods, not constructor parameters.`,
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
}

/**
 * Extracts the parsed message payload (or a specific property key) and runs
 * any parameter-level pipes (`ValidationPipe`, `ParseIntPipe`, etc.).
 */
export function MessageBody(): ParameterDecorator;
export function MessageBody(...pipes: PipeLike[]): ParameterDecorator;
export function MessageBody(
  property: string,
  ...pipes: PipeLike[]
): ParameterDecorator;
export function MessageBody(
  propertyOrPipe?: string | PipeLike,
  ...restPipes: PipeLike[]
): ParameterDecorator {
  const key = typeof propertyOrPipe === "string" ? propertyOrPipe : undefined;
  const pipes =
    typeof propertyOrPipe === "string"
      ? [...restPipes]
      : propertyOrPipe !== undefined
        ? [propertyOrPipe, ...restPipes]
        : [...restPipes];

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
    const existing =
      MetadataRegistry.getOwn<readonly (string | symbol)[]>(
        WS_METADATA_KEYS.WEBSOCKET_SERVER_PROPS,
        target.constructor,
      ) ?? [];

    if (!existing.includes(propertyKey)) {
      MetadataRegistry.define(
        WS_METADATA_KEYS.WEBSOCKET_SERVER_PROPS,
        [...existing, propertyKey],
        target.constructor,
      );
    }
  };
}

/**
 * Inheritance-safe reader for `@SubscribeMessage` handlers across a gateway's prototype chain.
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

  const rawParams =
    MetadataRegistry.getOwn<readonly WsParamMetadata[]>(
      WS_METADATA_KEYS.MESSAGE_PARAMS,
      definingProto,
      handlerKey,
    ) ?? [];

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
