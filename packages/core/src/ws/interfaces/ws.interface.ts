import type {
  CorsOptions,
  PipeLike,
  Scope,
  StandardSchemaV1,
} from "../../common/index";
import type { BunHttpAdapter } from "../../http/index";

export type WsAuthenticateResult = boolean | Record<string, unknown> | Response;

export type WsAuthenticateFn = (
  req: Request,
) => WsAuthenticateResult | Promise<WsAuthenticateResult>;

export type WsData = string | Buffer | ArrayBuffer | Uint8Array | Buffer[];

export type WsMessageParser = (data: WsData) => {
  event: string;
  data?: unknown;
  id?: string;
} | void;

export interface WsAdapterOptions {
  messageParser?: WsMessageParser;
  /**
   * Maximum concurrent in-flight message handlers per client connection.
   * @default 1000
   */
  maxConcurrentMessages?: number;
  /**
   * Maximum queued outbound bytes per client before disconnecting slow consumers.
   * Set to `0` to lift the limit.
   * @default 134217728 (128 MB)
   */
  maxSendBufferSize?: number;
  /**
   * Milliseconds before unclaimed upgrade requests are closed.
   * @default 1000
   */
  unclaimedUpgradeTimeout?: number;
  /**
   * Maximum incoming message size in bytes (mapped to Bun's `maxPayloadLength`).
   * @default 1048576 (1 MB)
   */
  maxPayload?: number;
}

/**
 * NestJS-compatible gateway metadata options accepted by `@WebSocketGateway(...)`.
 */
export interface GatewayMetadata {
  /**
   * Logical namespace label or pattern for this gateway.
   */
  namespace?: string | RegExp;
  /**
   * HTTP upgrade path for this WebSocket gateway. Defaults to `"/ws"`.
   */
  path?: string;
  serveClient?: boolean;
  adapter?: unknown;
  parser?: unknown;
  connectTimeout?: number;
  pingTimeout?: number;
  pingInterval?: number;
  upgradeTimeout?: number;
  maxHttpBufferSize?: number;
  allowRequest?: (
    req: unknown,
    fn: (err: string | null | undefined, success: boolean) => void,
  ) => void;
  transports?: Array<"polling" | "websocket">;
  allowUpgrades?: boolean;
  /**
   * Enable WebSocket per-message deflate compression.
   */
  perMessageDeflate?: boolean | Record<string, unknown>;
  httpCompression?: boolean | Record<string, unknown>;
  wsEngine?: string;
  initialPacket?: unknown;
  cookie?: unknown;
  /**
   * Optional CORS origin check performed during HTTP upgrade handshake.
   */
  cors?: CorsOptions | boolean;
  allowEIO3?: boolean;
  destroyUpgrade?: boolean;
  destroyUpgradeTimeout?: number;
}

export interface WebSocketGatewayOptions extends GatewayMetadata {
  /**
   * Optional standalone port when using `@WebSocketGateway(port, options?)`.
   */
  port?: number;
  /**
   * Maximum WebSocket message payload length in bytes (passed to Bun.serve websocket).
   */
  maxPayloadLength?: number;
  /**
   * Maximum message payload size alias matching `@nestjs/platform-ws`.
   */
  maxPayload?: number;
  /**
   * Idle timeout in seconds (passed to Bun.serve websocket).
   */
  idleTimeout?: number;
  /**
   * Optional DI scope for this gateway (`Scope.SINGLETON` / `Scope.DEFAULT` or `Scope.REQUEST`).
   */
  scope?: Scope;
  /**
   * Maximum concurrent in-flight message handlers per client connection before
   * applying backpressure (NestJS v12.2 parity).
   */
  maxConcurrentMessages?: number;
  /**
   * Optional HTTP upgrade handshake authenticator invoked BEFORE `server.upgrade(req)`.
   * Return `false`, throw an `HttpException`, or return a `Response` to reject before upgrading;
   * return `true` or an object (stored on `client.data`) to allow upgrade.
   */
  authenticate?: WsAuthenticateFn;
}

export interface WebSocketServerOptions {
  port: number;
  namespace: string;
}

export interface MessageMappingProperties {
  message: unknown;
  methodName: string;
  callback: (...args: any[]) => Promise<unknown> | unknown;
  isAckHandledManually: boolean;
}

export interface WsMessageFrame<T = unknown> {
  readonly event: string;
  readonly data?: T;
  readonly id?: string;
}

export interface WsResponse<T = unknown> {
  readonly event: string;
  readonly data: T;
  readonly id?: string;
}

export interface WsRoomEmitter {
  emit<T = unknown>(event: string, data?: T): void;
  send<T = unknown>(event: string, data?: T): void;
}

/**
 * Structural subset of Bun's native `ServerWebSocket<TData>` used by `@bunest/core/ws`.
 */
export interface BunServerWebSocketLike<TData = unknown> {
  readonly data: TData;
  readonly readyState: number;
  readonly remoteAddress?: string;
  readonly subscriptions?: string[];
  send(
    data: string | ArrayBuffer | ArrayBufferView,
    compress?: boolean,
  ): number;
  publish(
    topic: string,
    data: string | ArrayBuffer | ArrayBufferView,
    compress?: boolean,
  ): number;
  subscribe(topic: string): void;
  unsubscribe(topic: string): void;
  isSubscribed(topic: string): boolean;
  close(code?: number, reason?: string): void;
}

/**
 * Typed wrapper around Bun's native `ServerWebSocket` providing JSON event framing,
 * room pub/sub (with sender exclusion on `client.to(room)` and `client.broadcast`),
 * and handshake metadata.
 */
export interface BunWsClient<
  TData extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly id: string;
  readonly data: TData;
  readonly request: Request;
  readonly rooms: ReadonlySet<string>;
  readonly raw: BunServerWebSocketLike;
  send<T = unknown>(event: string, data?: T, id?: string): void;
  emit<T = unknown>(event: string, data?: T, id?: string): void;
  sendRaw(data: string | ArrayBuffer | ArrayBufferView): void;
  join(room: string): void;
  leave(room: string): void;
  to(room: string): WsRoomEmitter;
  broadcast<T = unknown>(event: string, data?: T): void;
  close(code?: number, reason?: string): void;
}

/**
 * Gateway-scoped WebSocket server handle injected via `@WebSocketServer()` and passed
 * to `OnGatewayInit.afterInit(server)`.
 * `server.emit()` and `server.to(room).emit()` deliver to ALL subscribers INCLUDING sender
 * using Bun's native `server.publish()`.
 */
export interface BunWsServer {
  readonly path: string;
  readonly namespace: string;
  readonly clients: ReadonlyMap<string, BunWsClient>;
  emit<T = unknown>(event: string, data?: T): void;
  to(room: string): WsRoomEmitter;
  in(room: string): WsRoomEmitter;
  subscriberCount(room: string): number;
  disconnectAll(code?: number, reason?: string): void;
}

export interface OnGatewayInit<TServer = BunWsServer> {
  afterInit(server: TServer): void | Promise<void>;
}

export interface OnGatewayConnection<TClient = BunWsClient> {
  handleConnection(client: TClient, ...args: any[]): void | Promise<void>;
}

export interface OnGatewayDisconnect<TClient = BunWsClient> {
  handleDisconnect(
    client: TClient,
    code?: number,
    reason?: string,
  ): void | Promise<void>;
}

export interface OnGatewayAuthenticate {
  authenticate(
    request: Request,
  ): WsAuthenticateResult | Promise<WsAuthenticateResult>;
}

export type WsParamSource = "body" | "client" | "ack";

export type WsAckCallback = (...args: unknown[]) => void;

export interface WsParamMetadata {
  readonly index: number;
  readonly source: WsParamSource;
  readonly key?: string;
  readonly pipes?: readonly PipeLike[];
  readonly schema?: StandardSchemaV1;
  readonly metatype?: Function;
}

export interface WsMessageHandlerMetadata {
  readonly event: string;
  readonly handlerKey: string | symbol;
  readonly message?: unknown;
  readonly methodName?: string;
  readonly callback?: (...args: any[]) => Promise<unknown> | unknown;
  readonly isAckHandledManually?: boolean;
}

export interface WebSocketModuleOptions {
  /**
   * Register `WebSocketModule` as a global module. Defaults to `true`.
   */
  global?: boolean;
  /**
   * Optional `BunHttpAdapter` instance to attach discovered gateways to automatically.
   */
  httpAdapter?: BunHttpAdapter;
  /**
   * Global default handshake authenticator (overridden by gateway-level `authenticate`).
   */
  authenticate?: WsAuthenticateFn;
  /**
   * Default `maxPayloadLength` applied to the Bun WebSocket handler.
   */
  maxPayloadLength?: number;
  /**
   * Alias for `maxPayloadLength` matching `@nestjs/platform-ws`.
   */
  maxPayload?: number;
  /**
   * Default `idleTimeout` (seconds) applied to the Bun WebSocket handler.
   */
  idleTimeout?: number;
  /**
   * Default `perMessageDeflate` flag applied to the Bun WebSocket handler.
   */
  perMessageDeflate?: boolean | Record<string, unknown>;
  /**
   * Default per-connection concurrent message backpressure limit (NestJS v12.2).
   */
  maxConcurrentMessages?: number;
  /**
   * Optional custom message parser (matching `@nestjs/platform-ws` `WsAdapterOptions`).
   */
  messageParser?: WsMessageParser;
  /**
   * Maximum queued outbound bytes per client before disconnecting.
   */
  maxSendBufferSize?: number;
  /**
   * Milliseconds before unclaimed upgrade requests are closed.
   */
  unclaimedUpgradeTimeout?: number;
}
