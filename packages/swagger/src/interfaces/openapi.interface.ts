import type { JsonValue, StandardSchemaV1, Type } from "@bunest/core";

// ============================================================================
// Standard JSON Schema v1 & Conversion Types (Zero External Deps)
// ============================================================================

export interface StandardJsonSchemaOptions {
  readonly target: "draft-2020-12" | "draft-07" | "openapi-3.0" | ({} & string);
  readonly libraryOptions?: Record<string, unknown> | undefined;
}

export interface StandardJsonSchemaConverter {
  readonly input: (
    options: StandardJsonSchemaOptions,
  ) => Record<string, unknown>;
  readonly output: (
    options: StandardJsonSchemaOptions,
  ) => Record<string, unknown>;
}

export interface StandardJSONSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly jsonSchema: StandardJsonSchemaConverter;
    readonly types?:
      | {
          readonly input: Input;
          readonly output: Output;
        }
      | undefined;
  };
}

export type StandardSchemaObject = StandardSchemaV1 | StandardJSONSchemaV1;

export interface StandardSchemaConversionResult {
  schema: unknown;
  components?: Record<string, OpenApiSchema | ReferenceObject>;
}

export type StandardSchemaConverter = (
  schema: unknown,
  options: { schemaType: "input" | "output" },
) => StandardSchemaConversionResult | undefined;

// ============================================================================
// OpenAPI 3.0 / 3.1 Specification Types
// ============================================================================

export type OpenApiSchemaType =
  "string" | "number" | "integer" | "boolean" | "array" | "object" | "null";

export type OpenAPIFormat =
  | "int32"
  | "int64"
  | "float"
  | "double"
  | "byte"
  | "binary"
  | "date"
  | "date-time"
  | "time"
  | "duration"
  | "password"
  | "email"
  | "idn-email"
  | "hostname"
  | "idn-hostname"
  | "ipv4"
  | "ipv6"
  | "uri"
  | "uri-reference"
  | "uri-template"
  | "iri"
  | "iri-reference"
  | "uuid"
  | "json-pointer"
  | "relative-json-pointer"
  | "regex"
  | (string & {});

export type ExtensionLocation = "root" | "info";

export interface ReferenceObject {
  $ref: string;
}

export interface DiscriminatorObject {
  propertyName: string;
  mapping?: Record<string, string>;
}

export interface XmlObject {
  name?: string;
  namespace?: string;
  prefix?: string;
  attribute?: boolean;
  wrapped?: boolean;
}

export interface OpenApiExternalDocs {
  description?: string;
  url: string;
}
export type ExternalDocumentationObject = OpenApiExternalDocs;

export interface OpenApiContact {
  name?: string;
  url?: string;
  email?: string;
}
export type ContactObject = OpenApiContact;

export interface OpenApiLicense {
  name: string;
  identifier?: string;
  url?: string;
}
export type LicenseObject = OpenApiLicense;

export interface OpenApiInfo {
  title: string;
  summary?: string;
  description?: string;
  termsOfService?: string;
  contact?: OpenApiContact;
  license?: OpenApiLicense;
  version: string;
  [extension: `x-${string}`]: unknown;
}
export type InfoObject = OpenApiInfo;

export interface OpenApiServerVariable {
  enum?: string[] | boolean[] | number[];
  default: string | boolean | number;
  description?: string;
}
export type ServerVariableObject = OpenApiServerVariable;

export interface OpenApiServer {
  url: string;
  description?: string;
  variables?: Record<string, OpenApiServerVariable>;
  [extension: string]: unknown;
}
export type ServerObject = OpenApiServer;

export interface OpenApiTag {
  name: string;
  summary?: string;
  description?: string;
  externalDocs?: OpenApiExternalDocs;
  parent?: string;
  kind?: string;
}
export type TagObject = OpenApiTag;

export interface ApiTagOptions {
  name: string;
  parent?: string;
  kind?: string;
}

export interface OpenApiSchema {
  $ref?: string;
  nullable?: boolean;
  discriminator?: DiscriminatorObject;
  readOnly?: boolean;
  writeOnly?: boolean;
  xml?: XmlObject;
  externalDocs?: ExternalDocumentationObject;
  example?: unknown;
  examples?: unknown[] | Record<string, unknown>;
  deprecated?: boolean;
  type?: OpenApiSchemaType | OpenApiSchemaType[] | (string & {}) | string[];
  allOf?: Array<OpenApiSchema | ReferenceObject>;
  oneOf?: Array<OpenApiSchema | ReferenceObject>;
  anyOf?: Array<OpenApiSchema | ReferenceObject>;
  not?: OpenApiSchema | ReferenceObject;
  items?: OpenApiSchema | ReferenceObject;
  properties?: Record<string, OpenApiSchema | ReferenceObject>;
  additionalProperties?: boolean | OpenApiSchema | ReferenceObject;
  patternProperties?: Record<string, OpenApiSchema | ReferenceObject>;
  description?: string;
  format?: OpenAPIFormat;
  default?: unknown;
  title?: string;
  multipleOf?: number;
  maximum?: number;
  exclusiveMaximum?: number | boolean;
  minimum?: number;
  exclusiveMinimum?: number | boolean;
  maxLength?: number;
  minLength?: number;
  pattern?: string;
  maxItems?: number;
  minItems?: number;
  uniqueItems?: boolean;
  maxProperties?: number;
  minProperties?: number;
  required?: string[];
  enum?: unknown[];
  const?: unknown;
  contentEncoding?: string;
  contentMediaType?: string;
  "x-enumNames"?: string[];
}
export type SchemaObject = OpenApiSchema;
export type SchemasObject = Record<string, SchemaObject>;

export interface ExampleObject {
  summary?: string;
  description?: string;
  value?: unknown;
  externalValue?: string;
}
export type ExamplesObject = Record<string, ExampleObject | ReferenceObject>;

export type ParameterLocation = "query" | "header" | "path" | "cookie";
export type ParameterStyle =
  | "matrix"
  | "label"
  | "form"
  | "simple"
  | "spaceDelimited"
  | "pipeDelimited"
  | "deepObject";

export interface EncodingPropertyObject {
  contentType?: string;
  headers?: Record<string, HeaderObject | ReferenceObject>;
  style?: string;
  explode?: boolean;
  allowReserved?: boolean;
}
export type EncodingObject = Record<string, EncodingPropertyObject>;

export interface OpenApiMediaType {
  schema?: OpenApiSchema | ReferenceObject;
  examples?: ExamplesObject;
  example?: unknown;
  encoding?: EncodingObject;
}
export type MediaTypeObject = OpenApiMediaType;
export type ContentObject = Record<string, MediaTypeObject>;

export interface BaseParameterObject {
  $ref?: string;
  description?: string;
  required?: boolean;
  deprecated?: boolean;
  allowEmptyValue?: boolean;
  style?: ParameterStyle;
  explode?: boolean;
  allowReserved?: boolean;
  schema?: OpenApiSchema;
  examples?: Record<string, ExampleObject | ReferenceObject>;
  example?: unknown;
  content?: ContentObject;
}

export type HeaderObject = BaseParameterObject;
export type OpenApiHeader = HeaderObject;
export type HeadersObject = Record<string, HeaderObject | ReferenceObject>;

export interface OpenApiParameter extends BaseParameterObject {
  name: string;
  in: ParameterLocation;
}
export type ParameterObject = OpenApiParameter;

export interface OpenApiRequestBody {
  $ref?: string;
  description?: string;
  required?: boolean;
  content: ContentObject;
}
export type RequestBodyObject = OpenApiRequestBody;

export type LinkParametersObject = Record<string, JsonValue | unknown>;

export interface LinkObject {
  operationRef?: string;
  operationId?: string;
  parameters?: LinkParametersObject;
  requestBody?: JsonValue | unknown;
  description?: string;
  server?: ServerObject;
}
export type LinksObject = Record<string, LinkObject | ReferenceObject>;

export interface OpenApiResponse {
  $ref?: string;
  summary?: string;
  description: string;
  headers?: HeadersObject;
  content?: ContentObject;
  links?: LinksObject;
}
export type ResponseObject = OpenApiResponse;

export interface ResponsesObject extends Record<
  string,
  ResponseObject | undefined
> {
  default?: ResponseObject;
}

export type OpenApiSecurityRequirement = Record<string, string[]>;
export type SecurityRequirementObject = OpenApiSecurityRequirement;

export type CallbackObject = Record<string, OpenApiPathItem>;
export type CallbacksObject = Record<string, CallbackObject | ReferenceObject>;

export interface CallBackObject<T = any> {
  name: string;
  callbackUrl: string;
  method: string;
  requestBody: {
    type: T;
  };
  expectedResponse: {
    status: number;
    description?: string;
  };
}

export interface OpenApiOperation {
  tags?: string[];
  summary?: string;
  description?: string;
  externalDocs?: OpenApiExternalDocs;
  operationId?: string;
  parameters?: OpenApiParameter[];
  requestBody?: OpenApiRequestBody;
  responses: ResponsesObject;
  callbacks?: CallbacksObject;
  deprecated?: boolean;
  security?: OpenApiSecurityRequirement[];
  servers?: OpenApiServer[];
}
export type OperationObject = OpenApiOperation;

export interface OpenApiPathItem {
  $ref?: string;
  summary?: string;
  description?: string;
  get?: OpenApiOperation;
  put?: OpenApiOperation;
  post?: OpenApiOperation;
  delete?: OpenApiOperation;
  options?: OpenApiOperation;
  head?: OpenApiOperation;
  patch?: OpenApiOperation;
  trace?: OpenApiOperation;
  query?: OpenApiOperation;
  additionalOperations?: Record<string, OpenApiOperation>;
  servers?: OpenApiServer[];
  parameters?: OpenApiParameter[];
}
export type PathItemObject = OpenApiPathItem;
export type PathsObject = Record<string, PathItemObject>;
export type WebhooksObject = Record<string, PathItemObject>;

export type ScopesObject = Record<string, string>;

export interface OAuthFlowObject {
  authorizationUrl?: string;
  tokenUrl?: string;
  refreshUrl?: string;
  scopes: ScopesObject;
}

export interface OAuthFlowsObject {
  implicit?: OAuthFlowObject;
  password?: OAuthFlowObject;
  clientCredentials?: OAuthFlowObject;
  authorizationCode?: OAuthFlowObject;
}

export type SecuritySchemeType =
  "apiKey" | "http" | "mutualTLS" | "oauth2" | "openIdConnect";

export interface OpenApiSecurityScheme {
  $ref?: string;
  type: SecuritySchemeType;
  description?: string;
  name?: string;
  in?: string;
  scheme?: string;
  bearerFormat?: string;
  flows?: OAuthFlowsObject;
  openIdConnectUrl?: string;
  "x-tokenName"?: string;
  [extension: `x-${string}`]: unknown;
}
export type SecuritySchemeObject = OpenApiSecurityScheme;

export interface OpenApiComponents {
  schemas?: Record<string, OpenApiSchema>;
  responses?: Record<string, OpenApiResponse>;
  parameters?: Record<string, OpenApiParameter>;
  examples?: Record<string, ExampleObject | ReferenceObject>;
  requestBodies?: Record<string, OpenApiRequestBody>;
  headers?: Record<string, OpenApiHeader>;
  securitySchemes?: Record<string, OpenApiSecurityScheme>;
  links?: Record<string, LinkObject | ReferenceObject>;
  callbacks?: Record<string, CallbackObject | ReferenceObject>;
}
export type ComponentsObject = OpenApiComponents;

export interface OpenApiDocument {
  openapi: string;
  info: OpenApiInfo;
  servers?: OpenApiServer[];
  paths: PathsObject;
  webhooks?: WebhooksObject;
  components?: OpenApiComponents;
  security?: OpenApiSecurityRequirement[];
  tags?: OpenApiTag[];
  externalDocs?: OpenApiExternalDocs;
  [extension: `x-${string}`]: unknown;
}
export type OpenAPIObject = OpenApiDocument;

export type SwaggerConfig = Omit<OpenApiDocument, "paths">;

// ============================================================================
// Decorator & Builder Options
// ============================================================================

export type ApiTypeInput =
  | Type<unknown>
  | Function
  | [Function]
  | string
  | (() => Type<unknown> | Function | [Function]);

export type SwaggerEnumType =
  | readonly unknown[]
  | Record<string, unknown>
  | (() => readonly unknown[] | Record<string, unknown>);

export type EnumSchemaAttributes = Pick<
  SchemaObject,
  | "default"
  | "description"
  | "deprecated"
  | "readOnly"
  | "writeOnly"
  | "nullable"
>;

export type ApiOperationOptions = Partial<OperationObject>;

export interface ApiResponseExamples {
  summary: string;
  value: unknown;
}

export interface ApiResponseCommonMetadata extends Omit<
  ResponseObject,
  "description"
> {
  status?:
    number | "default" | "1XX" | "2XX" | "3XX" | "4XX" | "5XX" | `${number}`;
  type?: ApiTypeInput;
  standardSchema?: StandardSchemaObject;
  isArray?: boolean;
  description?: string;
  nullable?: boolean;
  contentType?: string;
}

export type ApiResponseMetadata =
  | (ApiResponseCommonMetadata & { example?: unknown })
  | (ApiResponseCommonMetadata & {
      examples?: { [key: string]: ApiResponseExamples };
    });

export interface ApiResponseSchemaHost extends Omit<
  ResponseObject,
  "description"
> {
  schema: SchemaObject & Partial<ReferenceObject>;
  status?:
    number | "default" | "1XX" | "2XX" | "3XX" | "4XX" | "5XX" | `${number}`;
  description?: string;
  contentType?: string;
  example?: unknown;
  examples?: { [key: string]: ApiResponseExamples };
}

export type ApiResponseOptions = ApiResponseMetadata | ApiResponseSchemaHost;

export type ApiResponseNoStatusOptions =
  | (Omit<ApiResponseCommonMetadata, "status"> & { example?: unknown })
  | (Omit<ApiResponseCommonMetadata, "status"> & {
      examples?: { [key: string]: ApiResponseExamples };
    })
  | Omit<ApiResponseSchemaHost, "status">;

export interface ApiPropertyOptions {
  name?: string;
  type?: ApiTypeInput;
  isArray?: boolean;
  required?: boolean | string[];
  selfRequired?: boolean;
  nullable?: boolean;
  description?: string;
  title?: string;
  format?: OpenAPIFormat;
  enum?: SwaggerEnumType;
  enumName?: string;
  enumSchema?: EnumSchemaAttributes;
  "x-enumNames"?: string[];
  const?: unknown;
  default?: unknown;
  example?: unknown;
  examples?: unknown[] | Record<string, unknown>;
  exampleMaxDepth?: number;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number | boolean;
  exclusiveMaximum?: number | boolean;
  multipleOf?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string | RegExp;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minProperties?: number;
  maxProperties?: number;
  readOnly?: boolean;
  writeOnly?: boolean;
  deprecated?: boolean;
  items?: OpenApiSchema | ReferenceObject;
  properties?: Record<
    string,
    ApiPropertyOptions | OpenApiSchema | ReferenceObject
  >;
  additionalProperties?: boolean | OpenApiSchema | ReferenceObject;
  patternProperties?: Record<string, OpenApiSchema | ReferenceObject>;
  allOf?: Array<OpenApiSchema | ReferenceObject>;
  anyOf?: Array<OpenApiSchema | ReferenceObject>;
  oneOf?: Array<OpenApiSchema | ReferenceObject>;
  not?: OpenApiSchema | ReferenceObject;
  discriminator?: DiscriminatorObject;
  xml?: XmlObject;
  externalDocs?: ExternalDocumentationObject;
  contentEncoding?: string;
  contentMediaType?: string;
  link?: () => Type<unknown> | Function;
  schema?: OpenApiSchema;
}

export interface ApiPropertyMetadata extends ApiPropertyOptions {
  readonly propertyKey: string;
  readonly designType?: Function;
}

export interface ApiSchemaOptions {
  name?: string;
  description?: string;
}

export interface ApiLinkOptions {
  from: Type<unknown> | Function;
  fromField?: string;
  routeParam: string;
}

export interface ApiParamOptions extends Omit<
  ParameterObject,
  "in" | "schema"
> {
  type?: ApiTypeInput;
  format?: OpenAPIFormat;
  enum?: SwaggerEnumType;
  enumName?: string;
  enumSchema?: EnumSchemaAttributes;
  extensions?: Record<string, unknown>;
  schema?: OpenApiSchema;
}

export interface ApiQueryMetadata
  extends
    Omit<ParameterObject, "in" | "schema" | "name">,
    Omit<
      SchemaObject,
      | "required"
      | "type"
      | "enum"
      | "example"
      | "examples"
      | "description"
      | "deprecated"
    > {
  name?: string;
  type?: ApiTypeInput;
  isArray?: boolean;
  enum?: SwaggerEnumType;
  enumName?: string;
  enumSchema?: EnumSchemaAttributes;
  extensions?: Record<string, unknown>;
  schema?: OpenApiSchema | ReferenceObject;
}

export type ApiQueryOptions = ApiQueryMetadata;

export interface ApiHeaderOptions extends Omit<ParameterObject, "in"> {
  enum?: SwaggerEnumType;
  extensions?: Record<string, unknown>;
}

export interface ApiBodyOptions extends Omit<RequestBodyObject, "content"> {
  type?: ApiTypeInput;
  isArray?: boolean;
  enum?: SwaggerEnumType;
  schema?: OpenApiSchema | ReferenceObject;
  contentType?: string;
  examples?: ExamplesObject;
  encoding?: EncodingObject;
}

// ============================================================================
// Document, UI & Type-Helper Options
// ============================================================================

export type OperationIdFactory = (
  controllerKey: string,
  methodKey: string,
  version?: string,
) => string;

export interface SwaggerDocumentOptions {
  /**
   * Extra DTO classes to register under `components.schemas` even if not directly referenced by a route.
   */
  extraModels?: readonly (Type<unknown> | Function)[];
  /**
   * Optional custom operationId factory.
   */
  operationIdFactory?: OperationIdFactory;
  /**
   * Optional custom OpenAPI link name factory.
   */
  linkNameFactory?: (
    controllerKey: string,
    methodKey: string,
    fieldKey: string,
  ) => string;
  /**
   * Optional filter to include only specific controllers or modules.
   */
  include?: readonly (Type<unknown> | Function)[];
  /**
   * When true, routes ignore the application's global prefix when building OpenAPI paths.
   */
  ignoreGlobalPrefix?: boolean;
  /**
   * When true (default), recursively scans routes from imported modules.
   */
  deepScanRoutes?: boolean;
  /**
   * When true (default), automatically tags operations with their controller name when no `@ApiTags` is present.
   */
  autoTagControllers?: boolean;
  /**
   * When true, only endpoints explicitly decorated with `@ApiIncludeEndpoint()` are included.
   */
  onlyIncludeDecoratedEndpoints?: boolean;
  /**
   * When true, omits dynamic property defaults (e.g., functions) from generated schemas.
   */
  excludeDynamicDefaults?: boolean;
  /**
   * Maximum recursion depth for generated schema examples.
   */
  exampleMaxDepth?: number;
  /**
   * Custom converter turning Standard Schema objects into OpenAPI/JSON schemas.
   */
  standardSchemaConverter?: StandardSchemaConverter;
}

export interface SwaggerUiOptions {
  initOAuth?: {
    clientId?: string;
    clientSecret?: string;
    realm?: string;
    appName?: string;
    scopeSeparator?: string;
    scopes?: string[];
    additionalQueryStringParams?: Record<string, string>;
    useBasicAuthenticationWithAccessCodeGrant?: boolean;
    usePkceWithAuthorizationCodeGrant?: boolean;
  };
  persistAuthorization?: boolean;
  [key: string]: unknown;
}

export interface SwaggerSetupOptions {
  /**
   * When true, Swagger routes respect `app.setGlobalPrefix(...)`. Defaults to `false`.
   */
  useGlobalPrefix?: boolean;
  /**
   * Enable/disable serving the Swagger UI HTML endpoint. Defaults to `true`.
   */
  swaggerUiEnabled?: boolean;
  /**
   * Interactive API explorer renderer preset or boolean toggle (`false` disables UI).
   * - `"builtin"` (default) or `true`: zero-CDN offline interactive Try-It-Out Explorer
   * - `"scalar"`: Scalar API Reference shell
   * - `"swagger-ui"`: Swagger UI shell
   * - `false`: disables serving the HTML UI
   */
  ui?: boolean | "builtin" | "scalar" | "swagger-ui";
  /**
   * Controls raw OpenAPI definition endpoints (`true` = json + yaml, `false` = none, or `["json"]` / `["yaml"]`).
   * Defaults to `true`.
   */
  raw?: boolean | Array<"json" | "yaml">;
  /**
   * External URL pointing to a Swagger/OpenAPI JSON document.
   */
  swaggerUrl?: string;
  /**
   * Custom path for raw OpenAPI JSON endpoint. Defaults to `<path>-json`.
   */
  jsonDocumentUrl?: string;
  /**
   * Custom path for raw OpenAPI YAML endpoint. Defaults to `<path>-yaml`.
   */
  yamlDocumentUrl?: string;
  /**
   * Hook invoked on every request to dynamically patch/filter the served OpenAPI document.
   */
  patchDocumentOnRequest?: <TRequest = unknown, TResponse = unknown>(
    req: TRequest,
    res: TResponse,
    document: OpenAPIObject,
  ) => OpenAPIObject | Promise<OpenAPIObject>;
  /**
   * Enables a search/explorer bar in the UI.
   */
  explorer?: boolean;
  /**
   * Extra Swagger UI configuration options.
   */
  swaggerOptions?: SwaggerUiOptions;
  /**
   * Additional CSS injected inside `<style>` on the explorer page.
   */
  customCss?: string;
  /**
   * External stylesheet URL(s) injected as `<link rel="stylesheet">`.
   */
  customCssUrl?: string | string[];
  /**
   * External script URL(s) injected as `<script src="...">`.
   */
  customJs?: string | string[];
  /**
   * Inline JavaScript string(s) injected as `<script>...</script>`.
   */
  customJsStr?: string | string[];
  /**
   * Custom favicon URL.
   */
  customfavIcon?: string;
  /**
   * Custom HTML document `<title>`. Defaults to `${document.info.title} - API Explorer`.
   */
  customSiteTitle?: string;
  /**
   * Custom filesystem path for static Swagger UI assets.
   */
  customSwaggerUiPath?: string;
  /**
   * Custom validator URL for Swagger UI.
   */
  validatorUrl?: string;
  /**
   * Single spec URL override for Swagger UI.
   */
  url?: string;
  /**
   * Multiple spec URLs selector for Swagger UI Explorer.
   */
  urls?: Array<Record<"url" | "name", string>>;
}

export type SwaggerCustomOptions = SwaggerSetupOptions;

type DeepPartialLeaf = Date | RegExp | ((...args: any[]) => any);

type DeepPartialArray<T> =
  T extends Array<infer U>
    ? Array<DeepPartial<U>>
    : T extends ReadonlyArray<infer U>
      ? ReadonlyArray<DeepPartial<U>>
      : never;

type DeepPartialObject<T> = T extends object
  ? { [P in keyof T]?: DeepPartial<T[P]> }
  : T;

export type DeepPartial<T> = T extends DeepPartialLeaf
  ? T
  : T extends ReadonlyArray<unknown>
    ? DeepPartialArray<T>
    : DeepPartialObject<T>;
