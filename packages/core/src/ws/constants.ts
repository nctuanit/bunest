/**
 * Namespaced Symbol metadata keys & DI tokens for `@bunest/core/ws`.
 */
export const WS_METADATA_KEYS = Object.freeze({
  GATEWAY: Symbol.for("bunest:ws:gateway"),
  MESSAGE_HANDLERS: Symbol.for("bunest:ws:message_handlers"),
  MESSAGE_PARAMS: Symbol.for("bunest:ws:message_params"),
  WEBSOCKET_SERVER_PROPS: Symbol.for("bunest:ws:server_props"),
} as const);

export const WS_MODULE_OPTIONS = Symbol.for("bunest:ws:module_options");
export const WS_HTTP_ADAPTER = Symbol.for("bunest:ws:http_adapter");
