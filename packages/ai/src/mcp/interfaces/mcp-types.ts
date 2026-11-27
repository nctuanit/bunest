import type {
  ControllerOptions,
  ModuleMetadata,
  StandardSchemaV1,
  StandardSchemaV1Props,
  Type,
} from "@bunest/core";

export interface McpIcon {
  src: string;
  mimeType?: string;
  sizes?: string[];
}

export interface McpAnnotations {
  audience?: Array<"user" | "assistant">;
  priority?: number;
  lastModified?: string;
}

export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpCacheHint {
  maxAge?: number;
  etag?: string;
}

export interface McpAuthInfo {
  token: string;
  clientId: string;
  scopes: string[];
  expiresAt?: number;
  resource?: URL | string;
  extra?: Record<string, unknown>;
}

export interface OAuthProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported?: string[];
  bearer_methods_supported?: string[];
  resource_name?: string;
  resource_documentation?: string;
}

export interface McpContentBlock {
  type: "text" | "image" | "audio" | "resource" | "resource_link";
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  name?: string;
  resource?: McpResourceContent;
  annotations?: McpAnnotations;
  _meta?: Record<string, unknown>;
}

export interface CallToolResult {
  content: McpContentBlock[];
  structuredContent?: Record<string, unknown> | unknown;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

export interface InputRequiredResult {
  inputRequired: true;
  message?: string;
  requestedSchema?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

export interface McpResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
  _meta?: Record<string, unknown>;
}

export interface ReadResourceResult {
  contents: McpResourceContent[];
  _meta?: Record<string, unknown>;
}

export interface PromptMessage {
  role: "user" | "assistant";
  content: McpContentBlock;
}

export interface GetPromptResult {
  description?: string;
  messages: PromptMessage[];
  _meta?: Record<string, unknown>;
}

export interface McpServerContext {
  mcpReq: {
    id?: string | number;
    method: string;
    _meta?: Record<string, unknown>;
    envelope?: Record<string, unknown>;
    inputResponses?: unknown;
    notify: (method: string, params?: Record<string, unknown>) => Promise<void>;
  };
}

export interface StandardJsonSchemaProps {
  input?: (options?: { target?: string }) => Record<string, unknown>;
  output?: (options?: { target?: string }) => Record<string, unknown>;
}

export interface StandardSchemaWithJsonProps<
  Input = unknown,
  Output = Input,
> extends StandardSchemaV1Props<Input, Output> {
  readonly jsonSchema?: StandardJsonSchemaProps;
}

/**
 * Any Standard Schema v1 (with optional `~standard.jsonSchema` JSON Schema emitter).
 */
export type McpSchema<Input = any, Output = Input> = StandardSchemaV1<
  Input,
  Output
> & {
  readonly "~standard": StandardSchemaWithJsonProps<Input, Output>;
};

const STANDARD_SCHEMA_DTO_SYMBOL = Symbol.for("bunest:standard-schema-dto");

/**
 * A DTO class constructor created via `createSchemaDto(schema)` carrying a
 * Standard Schema v1 on `Symbol.for("bunest:standard-schema-dto")`.
 */
export type McpSchemaDtoConstructor<
  Output = any,
  TSchema extends StandardSchemaV1<any, any> = StandardSchemaV1<any, any>,
> = Type<Output> & {
  readonly [STANDARD_SCHEMA_DTO_SYMBOL]?: TSchema;
};

/**
 * Accepted schema input for `@Tool()` and `@Prompt()`: either a Standard Schema v1
 * object or a `createSchemaDto(schema)` DTO class constructor.
 */
export type McpSchemaInput<Input = any, Output = Input> =
  | McpSchema<Input, Output>
  | McpSchemaDtoConstructor<Output>;

/**
 * Options for the `@McpExpose()` decorator bridging HTTP `@Controller()` routes
 * to MCP tools.
 */
export interface McpExposeOptions {
  /**
   * Custom tool name (on a route handler method) or tool name prefix (on a controller class).
   */
  name?: string;
  /**
   * Human-readable tool description shown in MCP `tools/list`.
   */
  description?: string;
  /**
   * Set to `false` to opt a specific route or controller out when exposed via
   * class-level `@McpExpose()` or `McpModule.forRoot({ exposeControllers })`.
   * @default true
   */
  include?: boolean;
  /**
   * Optional OAuth scopes required when invoking the exposed tool over HTTP.
   */
  scopes?: string[];
  /**
   * Optional MCP tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, etc.).
   */
  annotations?: McpToolAnnotations;
}

export type McpCallKind = "tool" | "resource" | "prompt";
export type McpProtocolEra = "legacy" | "modern";
export type McpContextType = "mcp";

export interface McpContext<TRequest = any> {
  readonly kind: McpCallKind;
  readonly name: string;
  readonly uri?: URL;
  readonly transport: "http" | "stdio";
  readonly era: McpProtocolEra;
  readonly authInfo?: McpAuthInfo;
  readonly request?: TRequest;
  readonly requestInfo?: Request;
  readonly sessionId?: string;
  readonly signal: AbortSignal;
  readonly server: McpServerContext;
  reportProgress(
    progress: number,
    total?: number,
    message?: string,
  ): Promise<void>;
}

export interface McpTokenVerifier {
  verifyAccessToken(
    token: string,
  ): McpAuthInfo | null | undefined | Promise<McpAuthInfo | null | undefined>;
}

export interface McpHttpOptions {
  legacy?: "stateless" | "reject";
  responseMode?: "auto" | "json" | "sse";
  allowedHosts?: string[];
  allowedOrigins?: string[] | false;
  maxRequestBodySize?: number;
}

export interface McpAuthOptions {
  verifier: McpTokenVerifier | Type<McpTokenVerifier>;
  resource: string;
  authorizationServers: string[];
  scopesSupported?: string[];
  requiredScopes?: string[];
  resourceName?: string;
  resourceDocumentation?: string;
}

export interface McpStdioOptions {
  legacy?: "serve" | "reject";
}

export interface McpModuleOptions {
  name: string;
  version: string;
  title?: string;
  description?: string;
  websiteUrl?: string;
  icons?: McpIcon[];
  instructions?: string;
  include?: Function[];
  /**
   * Automatically expose HTTP `@Controller()` routes as MCP tools:
   * - `true`: expose routes from all discovered controllers (excluding internal MCP endpoints
   *   and routes/controllers marked `@McpExpose({ include: false })`)
   * - `Type[]`: expose routes from the specified controller classes
   * - `false` / `undefined`: only expose routes opted-in with `@McpExpose()`
   */
  exposeControllers?: boolean | Type<unknown>[];
  http?: McpHttpOptions;
  auth?: McpAuthOptions;
  stdio?: McpStdioOptions;
}

export interface McpModuleStructure {
  path?: string | false;
  endpointVersion?: ControllerOptions["version"];
  decorators?: ClassDecorator[];
  imports?: ModuleMetadata["imports"];
}

export interface McpOptionsFactory {
  createMcpOptions(): McpModuleOptions | Promise<McpModuleOptions>;
}

export interface McpStdioInputLike {
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
}

export interface McpStdioOutputLike {
  write(chunk: string | Uint8Array): unknown;
}

export interface McpStdioListenOptions {
  stdin?: McpStdioInputLike;
  stdout?: McpStdioOutputLike;
}

interface PrimitiveOptions {
  title?: string;
  description?: string;
  icons?: McpIcon[];
  _meta?: Record<string, unknown>;
  scopes?: string[];
}

export interface ToolOptions extends PrimitiveOptions {
  name?: string;
  inputSchema?: McpSchemaInput;
  outputSchema?: McpSchemaInput;
  annotations?: McpToolAnnotations;
}

export interface ResourceOptions extends PrimitiveOptions {
  uri: string;
  name?: string;
  mimeType?: string;
  size?: number;
  annotations?: McpAnnotations;
  cacheHint?: McpCacheHint;
}

export interface ResourceTemplateOptions extends PrimitiveOptions {
  uriTemplate: string;
  name?: string;
  mimeType?: string;
  annotations?: McpAnnotations;
  cacheHint?: McpCacheHint;
}

export interface PromptOptions extends PrimitiveOptions {
  name?: string;
  argsSchema?: McpSchemaInput;
}

export type McpPrimitiveMetadata =
  | { kind: "tool"; options: ToolOptions }
  | { kind: "resource"; options: ResourceOptions }
  | { kind: "resource-template"; options: ResourceTemplateOptions }
  | { kind: "prompt"; options: PromptOptions };
