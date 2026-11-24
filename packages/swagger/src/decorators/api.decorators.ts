import { HttpStatus, Logger, MetadataRegistry, type Type } from "@bunest/core";
import { DECORATORS, SWAGGER_METADATA_KEYS } from "../constants";
import type {
  ApiBodyOptions,
  ApiHeaderOptions,
  ApiLinkOptions,
  ApiOperationOptions,
  ApiParamOptions,
  ApiPropertyMetadata,
  ApiPropertyOptions,
  ApiQueryOptions,
  ApiResponseNoStatusOptions,
  ApiResponseOptions,
  ApiSchemaOptions,
  ApiTagOptions,
  CallBackObject,
  OpenApiSecurityRequirement,
} from "../interfaces/openapi.interface";

function createClassAndMethodArrayDecorator<T>(
  metadataKey: symbol,
  items: readonly T[],
  cloneItem?: (item: T) => T,
  order: "prepend" | "append" = "prepend",
): ClassDecorator & MethodDecorator {
  return (
    target: object,
    _propertyKey?: string | symbol,
    descriptor?: PropertyDescriptor,
  ): void => {
    const dest =
      descriptor && descriptor.value !== undefined ? descriptor.value : target;
    const next = cloneItem ? items.map(cloneItem) : items;
    if (order === "append") {
      MetadataRegistry.appendOwnArray<T>(metadataKey, next, dest);
      return;
    }
    MetadataRegistry.prependOwnArray<T>(metadataKey, next, dest);
  };
}

function cloneExtensionValue(entry: {
  readonly key: string;
  readonly value: unknown;
}): { readonly key: string; readonly value: unknown } {
  const { value } = entry;
  if (Array.isArray(value)) {
    return { key: entry.key, value: [...value] };
  }
  if (value !== null && typeof value === "object") {
    return { key: entry.key, value: { ...(value as object) } };
  }
  return { key: entry.key, value };
}

/**
 * Attaches one or more OpenAPI tags (strings or OAS 3.2 `ApiTagOptions`) to a
 * controller class or route handler method.
 */
export function ApiTags(
  ...tags: Array<string | ApiTagOptions>
): ClassDecorator & MethodDecorator {
  const tagNames = tags.map((t) => (typeof t === "string" ? t : t.name));
  const tagObjects = tags.filter(
    (t): t is ApiTagOptions => typeof t === "object" && t !== null,
  );
  for (const tag of tagObjects) {
    if (tag.parent !== undefined || tag.kind !== undefined) {
      new Logger("SwaggerModule").warn(
        `@ApiTags(): tag "${tag.name}" declares OpenAPI 3.2 hierarchy fields (parent/kind), which are ignored at the operation level. Declare them once via DocumentBuilder.addTag() instead.`,
      );
    }
  }
  return (
    target: object,
    _propertyKey?: string | symbol,
    descriptor?: PropertyDescriptor,
  ): void => {
    const dest =
      descriptor && descriptor.value !== undefined ? descriptor.value : target;
    MetadataRegistry.prependOwnArray<string>(
      SWAGGER_METADATA_KEYS.API_TAGS,
      tagNames,
      dest,
    );
    if (tagObjects.length > 0) {
      MetadataRegistry.prependOwnArray<ApiTagOptions>(
        SWAGGER_METADATA_KEYS.API_TAG_OPTIONS,
        tagObjects,
        dest,
      );
    }
  };
}

/**
 * Declares OpenAPI operation metadata (summary, description, operationId, deprecated, etc.).
 */
export function ApiOperation(
  options: ApiOperationOptions,
  { overrideExisting = true }: { overrideExisting?: boolean } = {},
): MethodDecorator {
  return (
    _target: object,
    _propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ) => {
    const existing = MetadataRegistry.getOwn<ApiOperationOptions>(
      SWAGGER_METADATA_KEYS.API_OPERATION,
      descriptor.value,
    );
    const merged: ApiOperationOptions = existing
      ? overrideExisting
        ? { ...existing, ...options }
        : { ...options, ...existing }
      : { ...options };
    MetadataRegistry.define<ApiOperationOptions>(
      SWAGGER_METADATA_KEYS.API_OPERATION,
      merged,
      descriptor.value,
    );
    return descriptor;
  };
}

/**
 * Declares an OpenAPI response definition on a route handler or controller.
 * Multiple `@ApiResponse()` decorators can be stacked safely.
 */
export function ApiResponse(
  options: ApiResponseOptions,
  { overrideExisting = true }: { overrideExisting?: boolean } = {},
): ClassDecorator & MethodDecorator {
  return (
    target: object,
    _propertyKey?: string | symbol,
    descriptor?: PropertyDescriptor,
  ): void => {
    const dest =
      descriptor && descriptor.value !== undefined ? descriptor.value : target;
    if (!overrideExisting) {
      const existing =
        MetadataRegistry.getOwn<readonly ApiResponseOptions[]>(
          SWAGGER_METADATA_KEYS.API_RESPONSES,
          dest,
        ) ?? [];
      if (
        options.status !== undefined &&
        existing.some((e) => String(e.status) === String(options.status))
      ) {
        return;
      }
    }
    MetadataRegistry.prependOwnArray<ApiResponseOptions>(
      SWAGGER_METADATA_KEYS.API_RESPONSES,
      [{ ...options }],
      dest,
    );
  };
}

function createResponseShorthand(
  status: number | "default",
  defaultDescription: string,
): (options?: ApiResponseNoStatusOptions) => MethodDecorator & ClassDecorator {
  return (
    options: ApiResponseNoStatusOptions = {},
  ): MethodDecorator & ClassDecorator =>
    ApiResponse({
      description: defaultDescription,
      ...options,
      status,
    } as ApiResponseOptions);
}

// 1xx Informational
export const ApiContinueResponse = createResponseShorthand(
  HttpStatus.CONTINUE,
  "Continue",
);
export const ApiSwitchingProtocolsResponse = createResponseShorthand(
  HttpStatus.SWITCHING_PROTOCOLS,
  "Switching Protocols",
);
export const ApiProcessingResponse = createResponseShorthand(
  HttpStatus.PROCESSING,
  "Processing",
);
export const ApiEarlyhintsResponse = createResponseShorthand(
  HttpStatus.EARLYHINTS,
  "Early Hints",
);

// 2xx Success
export const ApiOkResponse = createResponseShorthand(HttpStatus.OK, "OK");
export const ApiCreatedResponse = createResponseShorthand(
  HttpStatus.CREATED,
  "Created",
);
export const ApiAcceptedResponse = createResponseShorthand(
  HttpStatus.ACCEPTED,
  "Accepted",
);
export const ApiNonAuthoritativeInformationResponse = createResponseShorthand(
  HttpStatus.NON_AUTHORITATIVE_INFORMATION,
  "Non-Authoritative Information",
);
export const ApiNoContentResponse = createResponseShorthand(
  HttpStatus.NO_CONTENT,
  "No Content",
);
export const ApiResetContentResponse = createResponseShorthand(
  HttpStatus.RESET_CONTENT,
  "Reset Content",
);
export const ApiPartialContentResponse = createResponseShorthand(
  HttpStatus.PARTIAL_CONTENT,
  "Partial Content",
);

// 3xx Redirection
export const ApiAmbiguousResponse = createResponseShorthand(
  HttpStatus.AMBIGUOUS,
  "Ambiguous",
);
export const ApiMovedPermanentlyResponse = createResponseShorthand(
  HttpStatus.MOVED_PERMANENTLY,
  "Moved Permanently",
);
export const ApiFoundResponse = createResponseShorthand(
  HttpStatus.FOUND,
  "Found",
);
export const ApiSeeOtherResponse = createResponseShorthand(
  HttpStatus.SEE_OTHER,
  "See Other",
);
export const ApiNotModifiedResponse = createResponseShorthand(
  HttpStatus.NOT_MODIFIED,
  "Not Modified",
);
export const ApiTemporaryRedirectResponse = createResponseShorthand(
  HttpStatus.TEMPORARY_REDIRECT,
  "Temporary Redirect",
);
export const ApiPermanentRedirectResponse = createResponseShorthand(
  HttpStatus.PERMANENT_REDIRECT,
  "Permanent Redirect",
);

// 4xx Client Error
export const ApiBadRequestResponse = createResponseShorthand(
  HttpStatus.BAD_REQUEST,
  "Bad Request",
);
export const ApiUnauthorizedResponse = createResponseShorthand(
  HttpStatus.UNAUTHORIZED,
  "Unauthorized",
);
export const ApiPaymentRequiredResponse = createResponseShorthand(
  HttpStatus.PAYMENT_REQUIRED,
  "Payment Required",
);
export const ApiForbiddenResponse = createResponseShorthand(
  HttpStatus.FORBIDDEN,
  "Forbidden",
);
export const ApiNotFoundResponse = createResponseShorthand(
  HttpStatus.NOT_FOUND,
  "Not Found",
);
export const ApiMethodNotAllowedResponse = createResponseShorthand(
  HttpStatus.METHOD_NOT_ALLOWED,
  "Method Not Allowed",
);
export const ApiNotAcceptableResponse = createResponseShorthand(
  HttpStatus.NOT_ACCEPTABLE,
  "Not Acceptable",
);
export const ApiProxyAuthenticationRequiredResponse = createResponseShorthand(
  HttpStatus.PROXY_AUTHENTICATION_REQUIRED,
  "Proxy Authentication Required",
);
export const ApiRequestTimeoutResponse = createResponseShorthand(
  HttpStatus.REQUEST_TIMEOUT,
  "Request Timeout",
);
export const ApiConflictResponse = createResponseShorthand(
  HttpStatus.CONFLICT,
  "Conflict",
);
export const ApiGoneResponse = createResponseShorthand(HttpStatus.GONE, "Gone");
export const ApiLengthRequiredResponse = createResponseShorthand(
  HttpStatus.LENGTH_REQUIRED,
  "Length Required",
);
export const ApiPreconditionFailedResponse = createResponseShorthand(
  HttpStatus.PRECONDITION_FAILED,
  "Precondition Failed",
);
export const ApiPayloadTooLargeResponse = createResponseShorthand(
  HttpStatus.PAYLOAD_TOO_LARGE,
  "Payload Too Large",
);
export const ApiUriTooLongResponse = createResponseShorthand(
  HttpStatus.URI_TOO_LONG,
  "URI Too Long",
);
export const ApiUnsupportedMediaTypeResponse = createResponseShorthand(
  HttpStatus.UNSUPPORTED_MEDIA_TYPE,
  "Unsupported Media Type",
);
export const ApiRequestedRangeNotSatisfiableResponse = createResponseShorthand(
  HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE,
  "Requested Range Not Satisfiable",
);
export const ApiExpectationFailedResponse = createResponseShorthand(
  HttpStatus.EXPECTATION_FAILED,
  "Expectation Failed",
);
export const ApiIAmATeapotResponse = createResponseShorthand(
  HttpStatus.I_AM_A_TEAPOT,
  "I'm a teapot",
);
export const ApiMisdirectedResponse = createResponseShorthand(
  HttpStatus.MISDIRECTED,
  "Misdirected",
);
export const ApiUnprocessableEntityResponse = createResponseShorthand(
  HttpStatus.UNPROCESSABLE_ENTITY,
  "Unprocessable Entity",
);
export const ApiFailedDependencyResponse = createResponseShorthand(
  HttpStatus.FAILED_DEPENDENCY,
  "Failed Dependency",
);
export const ApiPreconditionRequiredResponse = createResponseShorthand(
  HttpStatus.PRECONDITION_REQUIRED,
  "Precondition Required",
);
export const ApiTooManyRequestsResponse = createResponseShorthand(
  HttpStatus.TOO_MANY_REQUESTS,
  "Too Many Requests",
);

// 5xx Server Error
export const ApiInternalServerErrorResponse = createResponseShorthand(
  HttpStatus.INTERNAL_SERVER_ERROR,
  "Internal Server Error",
);
export const ApiNotImplementedResponse = createResponseShorthand(
  HttpStatus.NOT_IMPLEMENTED,
  "Not Implemented",
);
export const ApiBadGatewayResponse = createResponseShorthand(
  HttpStatus.BAD_GATEWAY,
  "Bad Gateway",
);
export const ApiServiceUnavailableResponse = createResponseShorthand(
  HttpStatus.SERVICE_UNAVAILABLE,
  "Service Unavailable",
);
export const ApiGatewayTimeoutResponse = createResponseShorthand(
  HttpStatus.GATEWAY_TIMEOUT,
  "Gateway Timeout",
);
export const ApiHttpVersionNotSupportedResponse = createResponseShorthand(
  HttpStatus.HTTP_VERSION_NOT_SUPPORTED,
  "HTTP Version Not Supported",
);

export const ApiDefaultResponse = createResponseShorthand(
  "default",
  "Default response",
);

const API_PROPERTY_EXPLICIT_REQUIRED = Symbol.for(
  "bunest:swagger:explicit_required",
);

/**
 * Describes a DTO class property for OpenAPI 3.1 schema generation.
 * Copy-on-write on `target.constructor`: subclasses NEVER mutate parent DTO metadata.
 */
export function ApiProperty(
  options: ApiPropertyOptions = {},
): PropertyDecorator {
  return (target: object, propertyKey: string | symbol): void => {
    const key = String(propertyKey);
    const ctor = target.constructor;
    const designType = MetadataRegistry.getType(target, propertyKey);

    const existing =
      MetadataRegistry.getOwn<readonly ApiPropertyMetadata[]>(
        SWAGGER_METADATA_KEYS.API_PROPERTIES,
        ctor,
      ) ?? [];

    const normalizedPattern =
      options.pattern instanceof RegExp
        ? options.pattern.source
        : options.pattern;

    const hasExplicitRequired =
      options.selfRequired !== undefined ||
      typeof options.required === "boolean";

    const entry: ApiPropertyMetadata = {
      ...options,
      ...(normalizedPattern !== undefined
        ? { pattern: normalizedPattern }
        : {}),
      propertyKey: key,
      required:
        options.selfRequired !== undefined
          ? options.selfRequired
          : typeof options.required === "boolean"
            ? options.required
            : true,
      designType,
    };

    if (hasExplicitRequired) {
      Object.defineProperty(entry, API_PROPERTY_EXPLICIT_REQUIRED, {
        value: true,
        enumerable: false,
      });
    }

    const filtered = existing.filter((item) => item.propertyKey !== key);
    MetadataRegistry.define<ApiPropertyMetadata[]>(
      SWAGGER_METADATA_KEYS.API_PROPERTIES,
      [...filtered, entry],
      ctor,
    );
  };
}

/**
 * Shorthand for `@ApiProperty({ ...options, required: false })`.
 */
export function ApiPropertyOptional(
  options: ApiPropertyOptions = {},
): PropertyDecorator {
  return ApiProperty({ ...options, required: false });
}

/**
 * Shorthand for a read-only response property (`@ApiProperty({ readOnly: true, ...options })`).
 */
export function ApiResponseProperty(
  options: Pick<
    ApiPropertyOptions,
    "type" | "example" | "format" | "deprecated" | "enum"
  > = {},
): PropertyDecorator {
  return ApiProperty({
    readOnly: true,
    ...options,
  });
}

/**
 * Customizes the OpenAPI `components.schemas` name and/or description for a DTO class.
 */
export function ApiSchema(options: ApiSchemaOptions = {}): ClassDecorator {
  return (target: Function): void => {
    MetadataRegistry.define<ApiSchemaOptions>(
      SWAGGER_METADATA_KEYS.API_SCHEMA,
      { ...options },
      target,
    );
    MetadataRegistry.define(DECORATORS.API_SCHEMA, { ...options }, target);
  };
}

/**
 * Declares an OpenAPI 3.1 top-level webhook operation on a handler method.
 */
export function ApiWebhook(name?: string): MethodDecorator {
  return (
    _target: object,
    _propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ) => {
    const value = name ?? true;
    MetadataRegistry.define<string | boolean>(
      SWAGGER_METADATA_KEYS.API_WEBHOOK,
      value,
      descriptor.value,
    );
    MetadataRegistry.define(DECORATORS.API_WEBHOOK, value, descriptor.value);
    return descriptor;
  };
}

/**
 * Declares OpenAPI operation callbacks on a controller class or route handler method.
 */
export function ApiCallbacks(
  ...callbackObject: Array<CallBackObject<any>>
): MethodDecorator & ClassDecorator {
  return createClassAndMethodArrayDecorator<CallBackObject<any>>(
    SWAGGER_METADATA_KEYS.API_CALLBACKS,
    callbackObject,
  );
}

/**
 * Declares an OpenAPI response link connecting a field returned by another model/operation
 * to a route parameter of this operation.
 */
export function ApiLink({
  from,
  fromField,
  routeParam,
}: ApiLinkOptions): MethodDecorator {
  return (
    _target: object,
    _propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ) => {
    MetadataRegistry.prependOwnArray<ApiLinkOptions>(
      SWAGGER_METADATA_KEYS.API_LINKS,
      [{ from, fromField, routeParam }],
      descriptor.value,
    );
    return descriptor;
  };
}

/**
 * Marks an endpoint as the default getter operation for a model type & parameter,
 * enabling automatic OpenAPI response `links` resolution from `@ApiProperty({ link })`.
 */
export function ApiDefaultGetter(
  type: Type<unknown> | Function,
  parameter: string,
): MethodDecorator {
  return (
    _target: object,
    _propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ) => {
    const value = { type, parameter };
    MetadataRegistry.define<{
      readonly type: Type<unknown> | Function;
      readonly parameter: string;
    }>(SWAGGER_METADATA_KEYS.API_DEFAULT_GETTER, value, descriptor.value);
    MetadataRegistry.define(
      DECORATORS.API_DEFAULT_GETTER,
      value,
      descriptor.value,
    );
    return descriptor;
  };
}

/**
 * Explicitly opts an endpoint into OpenAPI document generation when
 * `SwaggerDocumentOptions.onlyIncludeDecoratedEndpoints` is `true`.
 */
export function ApiIncludeEndpoint(disable = true): MethodDecorator {
  return (
    _target: object,
    _propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ) => {
    MetadataRegistry.define<boolean>(
      SWAGGER_METADATA_KEYS.API_INCLUDE_ENDPOINT,
      disable,
      descriptor.value,
    );
    MetadataRegistry.define(
      DECORATORS.API_INCLUDE_ENDPOINT,
      { disable },
      descriptor.value,
    );
    return descriptor;
  };
}

/**
 * Excludes a DTO property from generated OpenAPI schemas (matching NestJS `@ApiHideProperty()`).
 */
export function ApiHideProperty(): PropertyDecorator {
  return (target: object, propertyKey: string | symbol): void => {
    const key = String(propertyKey);
    const ctor = target.constructor;
    const existing =
      MetadataRegistry.getOwn<readonly string[]>(
        SWAGGER_METADATA_KEYS.API_HIDDEN_PROPERTIES,
        ctor,
      ) ?? [];
    if (!existing.includes(key)) {
      MetadataRegistry.define(
        SWAGGER_METADATA_KEYS.API_HIDDEN_PROPERTIES,
        [...existing, key],
        ctor,
      );
    }
  };
}

/**
 * Registers additional DTO models to be included in `components.schemas`
 * even if not directly referenced on a route signature (matching `@ApiExtraModels()`).
 */
export function ApiExtraModels(
  ...models: Array<Type<unknown> | Function>
): ClassDecorator & MethodDecorator {
  return createClassAndMethodArrayDecorator<Type<unknown> | Function>(
    SWAGGER_METADATA_KEYS.API_EXTRA_MODELS,
    models,
  );
}

/**
 * Declares accepted request media types on a controller or route handler (`@ApiConsumes()`).
 */
export function ApiConsumes(
  ...mimeTypes: string[]
): ClassDecorator & MethodDecorator {
  return createClassAndMethodArrayDecorator<string>(
    SWAGGER_METADATA_KEYS.API_CONSUMES,
    mimeTypes,
  );
}

/**
 * Declares produced response media types on a controller or route handler (`@ApiProduces()`).
 */
export function ApiProduces(
  ...mimeTypes: string[]
): ClassDecorator & MethodDecorator {
  return createClassAndMethodArrayDecorator<string>(
    SWAGGER_METADATA_KEYS.API_PRODUCES,
    mimeTypes,
  );
}

/**
 * Attaches an OpenAPI vendor extension (`x-*`) to a controller or route operation.
 */
export function ApiExtension(
  extensionKey: string,
  extensionProperties: unknown,
): ClassDecorator & MethodDecorator {
  if (!extensionKey.startsWith("x-")) {
    throw new Error(
      `Extension key "${extensionKey}" is not prefixed with "x-".`,
    );
  }
  return createClassAndMethodArrayDecorator<{
    readonly key: string;
    readonly value: unknown;
  }>(SWAGGER_METADATA_KEYS.API_EXTENSIONS, [
    { key: extensionKey, value: extensionProperties },
  ], cloneExtensionValue);
}

/**
 * Declares multiple HTTP request headers at once (`@ApiHeaders()`).
 */
export function ApiHeaders(
  headers: readonly ApiHeaderOptions[],
): ClassDecorator & MethodDecorator {
  return createClassAndMethodArrayDecorator<ApiHeaderOptions>(
    SWAGGER_METADATA_KEYS.API_HEADERS,
    headers.map((h) => ({ ...h })),
  );
}

/**
 * Documents a path parameter on a controller class or route handler method.
 */
export function ApiParam(
  options: ApiParamOptions,
): MethodDecorator & ClassDecorator {
  return createClassAndMethodArrayDecorator<ApiParamOptions>(
    SWAGGER_METADATA_KEYS.API_PARAMS,
    [{ ...options }],
  );
}

/**
 * Documents a query string parameter on a controller class or route handler method.
 */
export function ApiQuery(
  options: ApiQueryOptions,
): MethodDecorator & ClassDecorator {
  return createClassAndMethodArrayDecorator<ApiQueryOptions>(
    SWAGGER_METADATA_KEYS.API_QUERIES,
    [{ ...options }],
  );
}

/**
 * Documents an HTTP request header on a controller class or route handler method.
 */
export function ApiHeader(
  options: ApiHeaderOptions,
): ClassDecorator & MethodDecorator {
  return createClassAndMethodArrayDecorator<ApiHeaderOptions>(
    SWAGGER_METADATA_KEYS.API_HEADERS,
    [{ ...options }],
  );
}

/**
 * Documents the request body schema on a route handler method.
 */
export function ApiBody(options: ApiBodyOptions): MethodDecorator {
  return (
    _target: object,
    _propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ) => {
    MetadataRegistry.define<ApiBodyOptions>(
      SWAGGER_METADATA_KEYS.API_BODY,
      { ...options },
      descriptor.value,
    );
    return descriptor;
  };
}

/**
 * Attaches an OpenAPI security requirement to a controller class or route handler method.
 */
export function ApiSecurity(
  name: string | OpenApiSecurityRequirement,
  requirements: string[] = [],
): ClassDecorator & MethodDecorator {
  const entry: OpenApiSecurityRequirement =
    typeof name === "string" ? { [name]: [...requirements] } : { ...name };
  // NestJS accumulates security requirements bottom-to-top (decorator
  // application order), so append rather than prepend.
  return createClassAndMethodArrayDecorator<OpenApiSecurityRequirement>(
    SWAGGER_METADATA_KEYS.API_SECURITY,
    [entry],
    (req) => ({ ...req }),
    "append",
  );
}

export function ApiBearerAuth(
  name = "bearer",
): ClassDecorator & MethodDecorator {
  return ApiSecurity(name, []);
}

export function ApiBasicAuth(name = "basic"): ClassDecorator & MethodDecorator {
  return ApiSecurity(name, []);
}

export function ApiApiKey(name = "api-key"): ClassDecorator & MethodDecorator {
  return ApiSecurity(name, []);
}

export function ApiCookieAuth(
  name = "cookie",
): ClassDecorator & MethodDecorator {
  return ApiSecurity(name, []);
}

export function ApiOAuth2(
  scopes: string[],
  name = "oauth2",
): ClassDecorator & MethodDecorator {
  return ApiSecurity(name, scopes);
}

/**
 * Returns the OpenAPI `$ref` path for a DTO model class (`#/components/schemas/<Name>`),
 * honoring `@ApiSchema({ name })` overrides if decorated.
 */
export function getSchemaPath(model: string | Function): string {
  if (typeof model === "string") {
    return `#/components/schemas/${model}`;
  }
  const schemaMeta = MetadataRegistry.getOwn<ApiSchemaOptions>(
    SWAGGER_METADATA_KEYS.API_SCHEMA,
    model,
  );
  const name = schemaMeta?.name || model.name;
  return `#/components/schemas/${name}`;
}

/**
 * Builds an array of `$ref` objects for OpenAPI `oneOf`/`anyOf`/`allOf` schemas.
 */
export function refs(
  ...models: Array<string | Function>
): Array<{ $ref: string }> {
  return models.map((model) => ({ $ref: getSchemaPath(model) }));
}

/**
 * Excludes a route handler method from generated OpenAPI documents.
 */
export function ApiExcludeEndpoint(disable = true): MethodDecorator {
  return (
    _target: object,
    _propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ) => {
    MetadataRegistry.define<boolean>(
      SWAGGER_METADATA_KEYS.API_EXCLUDE_ENDPOINT,
      disable,
      descriptor.value,
    );
    return descriptor;
  };
}

/**
 * Excludes an entire controller class from generated OpenAPI documents.
 */
export function ApiExcludeController(disable = true): ClassDecorator {
  return (target: Function) => {
    MetadataRegistry.define<boolean>(
      SWAGGER_METADATA_KEYS.API_EXCLUDE_CONTROLLER,
      disable,
      target,
    );
  };
}
