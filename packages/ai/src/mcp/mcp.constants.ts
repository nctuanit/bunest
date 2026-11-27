/** Where `@Tool()`, `@Resource()`, `@ResourceTemplate()` and `@Prompt()` record themselves, on the method. */
export const MCP_PRIMITIVE_METADATA = "nestjs:mcp:primitive";

/** Where `@McpExpose()` records itself on controller classes or route handler methods. */
export const MCP_EXPOSE_METADATA: unique symbol = Symbol.for(
  "bunest:mcp:expose",
);

/** Dedicated parameter metadata key for REST-to-MCP bridged controller routes. */
export const MCP_REST_BRIDGE_PARAMS_METADATA: unique symbol = Symbol.for(
  "bunest:mcp:rest_bridge_params",
);

/** Internal marker on MCP transport controllers so `exposeControllers: true` skips them. */
export const MCP_INTERNAL_CONTROLLER: unique symbol = Symbol.for(
  "bunest:mcp:internal_controller",
);

/** Cross-package symbol bridging `createSchemaDto(schema)` classes without importing `@bunest/validation`. */
export const STANDARD_SCHEMA_DTO_KEY = Symbol.for("bunest:standard-schema-dto");

/** Reflect metadata key mirrored alongside `STANDARD_SCHEMA_DTO_KEY`. */
export const STANDARD_SCHEMA_DTO_METADATA_KEY = "bunest:standard-schema-dto";

/** The parameter metadata key read by `ExternalContextCreator`. */
export const MCP_PARAMS_METADATA = "__routeArguments__";

/** The `ExecutionContext` type of MCP calls: `context.getType() === 'mcp'`. */
export const MCP_CONTEXT_TYPE = "mcp" as const;

/** The HTTP endpoint the module serves (`{ path }`, `path` being `null` when it serves none). Internal. */
export const MCP_HTTP_ENDPOINT: unique symbol = Symbol("MCP_HTTP_ENDPOINT");

/** The token verifier `forRoot()` was given as a class, instantiated by DI. Internal. */
export const MCP_TOKEN_VERIFIER: unique symbol = Symbol("MCP_TOKEN_VERIFIER");

/** Default HTTP path of the endpoint. */
export const DEFAULT_MCP_PATH = "mcp";

/** The module options (`forRoot()`'s, or what the `forRootAsync()` factory returns). */
export const MCP_MODULE_OPTIONS = "MCP_MODULE_OPTIONS";
