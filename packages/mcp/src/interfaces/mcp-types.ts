import type {
  ControllerOptions,
  ModuleMetadata,
  StandardSchemaV1,
  StandardSchemaV1Props,
  Type,
} from "@bunest/common";
import type { Readable, Writable } from "node:stream";

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

export interface StandardSchemaWithJsonProps<Input = unknown, Output = Input>
  extends StandardSchemaV1Props<Input, Output> {
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
  ):
    | McpAuthInfo
    | null
    | undefined
    | Promise<McpAuthInfo | null | undefined>;
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

export interface McpStdioListenOptions {
  stdin?: Readable;
  stdout?: Writable;
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
  inputSchema?: McpSchema;
  outputSchema?: McpSchema;
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
  argsSchema?: McpSchema;
}

export type McpPrimitiveMetadata =
  | { kind: "tool"; options: ToolOptions }
  | { kind: "resource"; options: ResourceOptions }
  | { kind: "resource-template"; options: ResourceTemplateOptions }
  | { kind: "prompt"; options: PromptOptions };
