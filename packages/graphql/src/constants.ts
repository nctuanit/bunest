import { REQUEST } from "@bunest/core";

/**
 * Namespaced Symbol metadata keys and DI tokens for `@bunest/graphql`.
 */
export const GRAPHQL_METADATA_KEYS = Object.freeze({
  OBJECT_TYPE: Symbol.for("bunest:graphql:object_type"),
  INTERFACE_TYPE: Symbol.for("bunest:graphql:interface_type"),
  INPUT_TYPE: Symbol.for("bunest:graphql:input_type"),
  ARGS_TYPE: Symbol.for("bunest:graphql:args_type"),
  FIELDS: Symbol.for("bunest:graphql:fields"),
  FIELD_MIDDLEWARE: Symbol.for("bunest:graphql:field_middleware"),
  RESOLVER: Symbol.for("bunest:graphql:resolver"),
  QUERIES: Symbol.for("bunest:graphql:queries"),
  MUTATIONS: Symbol.for("bunest:graphql:mutations"),
  SUBSCRIPTIONS: Symbol.for("bunest:graphql:subscriptions"),
  RESOLVE_FIELDS: Symbol.for("bunest:graphql:resolve_fields"),
  PARAMS: Symbol.for("bunest:graphql:params"),
  SCALAR: Symbol.for("bunest:graphql:scalar"),
  DIRECTIVES: Symbol.for("bunest:graphql:directives"),
  HIDDEN_FIELDS: Symbol.for("bunest:graphql:hidden_fields"),
  EXTENSIONS: Symbol.for("bunest:graphql:extensions"),
  RESOLVE_REFERENCE: Symbol.for("bunest:graphql:resolve_reference"),
} as const);

export const GRAPHQL_MODULE_OPTIONS = Symbol.for(
  "bunest:graphql:module_options",
);
export const GRAPHQL_SCHEMA_TOKEN = Symbol.for("bunest:graphql:schema");

// NestJS `@nestjs/graphql` compatibility metadata keys & tokens
export const RESOLVER_TYPE_METADATA = "graphql:resolver_type";
export const RESOLVER_NAME_METADATA = "graphql:resolver_name";
export const RESOLVER_PROPERTY_METADATA = "graphql:resolve_property";
export const FIELD_RESOLVER_MIDDLEWARE_METADATA =
  "graphql:field_resolver_middleware";
export const FIELD_MIDDLEWARE_METADATA = "graphql:field_middleware";
export const RESOLVER_DELEGATE_METADATA = "graphql:delegate_property";
export const SCALAR_NAME_METADATA = "graphql:scalar_name";
export const SCALAR_TYPE_METADATA = "graphql:scalar_type";
export const PARAM_ARGS_METADATA = "__routeArguments__";
export const ARGS_TYPE_METADATA = "graphql:args_type";
export const SUBSCRIPTION_OPTIONS_METADATA = "graphql:subscription_options;";
export const CLASS_TYPE_METADATA = "graphql:class_type";
export const RESOLVER_REFERENCE_KEY = "__resolveReference";
export const RESOLVER_REFERENCE_METADATA = "graphql:resolve_reference";
export const FIELD_TYPENAME = "__resolveType";
export const GRAPHQL_MODULE_ID = "GqlModuleId";
export const SUBSCRIPTION_TYPE = "Subscription";
export const HIDE_FIELD_METADATA = "graphql:hide_field";
export const DEFINITIONS_FILE_HEADER = `
/*
 * -------------------------------------------------------
 * THIS FILE WAS AUTOMATICALLY GENERATED (DO NOT MODIFY)
 * -------------------------------------------------------
 */

/* tslint:disable */
/* eslint-disable */`;
export const GRAPHQL_SDL_FILE_HEADER =
  "# ------------------------------------------------------\n# THIS FILE WAS AUTOMATICALLY GENERATED (DO NOT MODIFY)\n# ------------------------------------------------------\n\n";
export const GRAPHQL_SDL_FILE_END = "\n";
export const FIELD_RESOLVER_COMPOSITION_METADATA =
  "graphql:field_resolver_composition";
export const CONTEXT = REQUEST;
