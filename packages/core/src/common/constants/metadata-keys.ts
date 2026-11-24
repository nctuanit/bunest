export type MetadataKey = string | symbol;

/**
 * Namespaced Symbol metadata keys used across Bunest packages.
 * Using Symbol.for("bunest:...") prevents string collisions with user code
 * while remaining consistent across workspace/module boundaries.
 */
export const METADATA_KEYS = Object.freeze({
  MODULE: Symbol.for("bunest:metadata:module"),
  GLOBAL_MODULE: Symbol.for("bunest:metadata:global_module"),
  INJECTABLE: Symbol.for("bunest:metadata:injectable"),
  INJECT_TOKENS: Symbol.for("bunest:metadata:inject_tokens"),
  PROPERTY_INJECT_TOKENS: Symbol.for("bunest:metadata:property_inject_tokens"),
  OPTIONAL_DEPS: Symbol.for("bunest:metadata:optional_deps"),
  OPTIONAL_PROPERTY_DEPS: Symbol.for("bunest:metadata:optional_property_deps"),
  CONTROLLER: Symbol.for("bunest:metadata:controller"),
  ROUTES: Symbol.for("bunest:metadata:routes"),
  ROUTE_METHOD: Symbol.for("bunest:metadata:route_method"),
  ROUTE_PATH: Symbol.for("bunest:metadata:route_path"),
  ROUTE_PARAMS: Symbol.for("bunest:metadata:route_params"),
  HTTP_CODE: Symbol.for("bunest:metadata:http_code"),
  HEADERS: Symbol.for("bunest:metadata:headers"),
  REDIRECT: Symbol.for("bunest:metadata:redirect"),
  RENDER: Symbol.for("bunest:metadata:render"),
  SSE: Symbol.for("bunest:metadata:sse"),
  SSE_OPTIONS: Symbol.for("bunest:metadata:sse_options"),
  DEPENDENCIES: Symbol.for("bunest:metadata:dependencies"),
  GUARDS: Symbol.for("bunest:metadata:guards"),
  PIPES: Symbol.for("bunest:metadata:pipes"),
  INTERCEPTORS: Symbol.for("bunest:metadata:interceptors"),
  EXCEPTION_FILTERS: Symbol.for("bunest:metadata:exception_filters"),
  MIDDLEWARES: Symbol.for("bunest:metadata:middlewares"),
  METHOD_ASPECTS: Symbol.for("bunest:metadata:method_aspects"),
  CLASS_METHOD_ASPECTS: Symbol.for("bunest:metadata:class_method_aspects"),
  INHERIT_METHOD_ENHANCERS: Symbol.for(
    "bunest:metadata:inherit_method_enhancers",
  ),
  CATCH_EXCEPTIONS: Symbol.for("bunest:metadata:catch_exceptions"),
  VERSION: Symbol.for("bunest:metadata:version"),
  ENTITY_SCHEMA: Symbol.for("bunest:metadata:entity_schema"),
  ENTITY_COLUMNS: Symbol.for("bunest:metadata:entity_columns"),
  ENTITY_INDEXES: Symbol.for("bunest:metadata:entity_indexes"),
  CLASS_MACROS: Symbol.for("bunest:metadata:class_macros"),
  MACRO_FIELD_OPTIONS: Symbol.for("bunest:metadata:macro_field_options"),
  MACRO_DELEGATES: Symbol.for("bunest:metadata:macro_delegates"),
  MACRO_NON_NULL_PARAMS: Symbol.for("bunest:metadata:macro_non_null_params"),
} as const);

export const DESIGN_METADATA_KEYS = Object.freeze({
  TYPE: "design:type",
  PARAMTYPES: "design:paramtypes",
  RETURNTYPE: "design:returntype",
} as const);
