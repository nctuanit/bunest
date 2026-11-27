import "../common/metadata/reflect-shim";

export type { WsMessageHandler } from "../common/index";

export {
  WS_HTTP_ADAPTER,
  WS_METADATA_KEYS,
  WS_MODULE_OPTIONS,
} from "./constants";

export { WsException } from "./exceptions/ws.exception";

export type {
  BunServerWebSocketLike,
  BunWsClient,
  BunWsServer,
  GatewayMetadata,
  MessageMappingProperties,
  OnGatewayAuthenticate,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  WebSocketGatewayOptions,
  WebSocketModuleOptions,
  WebSocketServerOptions,
  WsAckCallback,
  WsAdapterOptions,
  WsAuthenticateFn,
  WsAuthenticateResult,
  WsData,
  WsMessageFrame,
  WsMessageHandlerMetadata,
  WsMessageParser,
  WsParamMetadata,
  WsParamSource,
  WsPreRequestContext,
  WsPreRequestHook,
  WsResponse,
  WsRoomEmitter,
} from "./interfaces/ws.interface";

export {
  Ack,
  ConnectedSocket,
  getGatewayMessageHandlers,
  getGatewayMethodParams,
  getGatewayServerProperties,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  WsParam,
} from "./decorators/ws.decorators";

export {
  compileWsPathPattern,
  EMPTY_WS_PARAMS,
  isDynamicWsPath,
  matchWsPath,
  type CompiledWsPath,
} from "./path-matcher";

export { WsExecutionContext } from "./context/ws-execution-context";
export {
  BaseWsExceptionFilter,
  type BaseWsExceptionFilterOptions,
  type ErrorPayload,
} from "./filters/base-ws-exception.filter";

export {
  buildGatewayAllTopic,
  buildGatewayRoomTopic,
  BunWsClientImpl,
  BunWsServerImpl,
  parseWsFrame,
  serializeWsFrame,
  type BunWsSocketData,
} from "./client/bun-ws-client";

export {
  AbstractWsAdapter,
  type BaseWsInstance,
} from "./adapter/abstract-ws.adapter";

export {
  BunWebSocketAdapter,
  WsAdapter,
  type EnhancerResolverFn,
} from "./adapter/bun-ws.adapter";

export { WsGatewayExplorer } from "./explorer/ws-gateway.explorer";
export { WebSocketModule } from "./websocket.module";
