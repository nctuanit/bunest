/**
 * Canonical string prefix matching NestJS `@nestjs/swagger` decorator metadata keys.
 */
export const DECORATORS_PREFIX = "swagger" as const;

/**
 * Canonical string metadata keys matching `@nestjs/swagger` `DECORATORS`.
 */
export const DECORATORS = Object.freeze({
  API_OPERATION: `${DECORATORS_PREFIX}/apiOperation`,
  API_RESPONSE: `${DECORATORS_PREFIX}/apiResponse`,
  API_PRODUCES: `${DECORATORS_PREFIX}/apiProduces`,
  API_CONSUMES: `${DECORATORS_PREFIX}/apiConsumes`,
  API_TAGS: `${DECORATORS_PREFIX}/apiUseTags`,
  API_WEBHOOK: `${DECORATORS_PREFIX}/apiWebhook`,
  API_CALLBACKS: `${DECORATORS_PREFIX}/apiCallbacks`,
  API_PARAMETERS: `${DECORATORS_PREFIX}/apiParameters`,
  API_HEADERS: `${DECORATORS_PREFIX}/apiHeaders`,
  API_MODEL_PROPERTIES: `${DECORATORS_PREFIX}/apiModelProperties`,
  API_MODEL_PROPERTIES_ARRAY: `${DECORATORS_PREFIX}/apiModelPropertiesArray`,
  API_MODEL_PROPERTY_HIDDEN: `${DECORATORS_PREFIX}/apiModelPropertyHidden`,
  API_MODEL_PROPERTY_EXPLICIT_OPTIONS: `${DECORATORS_PREFIX}/apiModelPropertyExplicitOptions`,
  API_SECURITY: `${DECORATORS_PREFIX}/apiSecurity`,
  API_EXCLUDE_ENDPOINT: `${DECORATORS_PREFIX}/apiExcludeEndpoint`,
  API_INCLUDE_ENDPOINT: `${DECORATORS_PREFIX}/apiIncludeEndpoint`,
  API_EXCLUDE_CONTROLLER: `${DECORATORS_PREFIX}/apiExcludeController`,
  API_EXTRA_MODELS: `${DECORATORS_PREFIX}/apiExtraModels`,
  API_EXTENSION: `${DECORATORS_PREFIX}/apiExtension`,
  API_SCHEMA: `${DECORATORS_PREFIX}/apiSchema`,
  API_DEFAULT_GETTER: `${DECORATORS_PREFIX}/apiDefaultGetter`,
  API_LINK: `${DECORATORS_PREFIX}/apiLink`,
});

/**
 * Namespaced Symbol metadata keys for `@bunest/swagger` OpenAPI 3.1 decorators.
 */
export const SWAGGER_METADATA_KEYS = Object.freeze({
  API_TAGS: Symbol.for("bunest:swagger:api_tags"),
  API_TAG_OPTIONS: Symbol.for("bunest:swagger:api_tag_options"),
  API_OPERATION: Symbol.for("bunest:swagger:api_operation"),
  API_RESPONSES: Symbol.for("bunest:swagger:api_responses"),
  API_PROPERTIES: Symbol.for("bunest:swagger:api_properties"),
  API_HIDDEN_PROPERTIES: Symbol.for("bunest:swagger:api_hidden_properties"),
  API_EXTRA_MODELS: Symbol.for("bunest:swagger:api_extra_models"),
  API_CONSUMES: Symbol.for("bunest:swagger:api_consumes"),
  API_PRODUCES: Symbol.for("bunest:swagger:api_produces"),
  API_EXTENSIONS: Symbol.for("bunest:swagger:api_extensions"),
  API_PARAMS: Symbol.for("bunest:swagger:api_params"),
  API_QUERIES: Symbol.for("bunest:swagger:api_queries"),
  API_HEADERS: Symbol.for("bunest:swagger:api_headers"),
  API_BODY: Symbol.for("bunest:swagger:api_body"),
  API_SECURITY: Symbol.for("bunest:swagger:api_security"),
  API_EXCLUDE_ENDPOINT: Symbol.for("bunest:swagger:api_exclude_endpoint"),
  API_INCLUDE_ENDPOINT: Symbol.for("bunest:swagger:api_include_endpoint"),
  API_EXCLUDE_CONTROLLER: Symbol.for("bunest:swagger:api_exclude_controller"),
  API_SCHEMA: Symbol.for("bunest:swagger:api_schema"),
  API_WEBHOOK: Symbol.for("bunest:swagger:api_webhook"),
  API_CALLBACKS: Symbol.for("bunest:swagger:api_callbacks"),
  API_LINKS: Symbol.for("bunest:swagger:api_links"),
  API_DEFAULT_GETTER: Symbol.for("bunest:swagger:api_default_getter"),
} as const);
