import {
  APP_PIPE,
  ApplicationConfig,
  BadRequestException,
  DiscoveryService,
  ExternalContextCreator,
  HttpStatus,
  METADATA_KEYS,
  MetadataRegistry,
  ModuleRef,
  StandardSchemaValidationPipe,
  ValidationPipe,
  getValidationMetadatasForTarget,
  type ArgumentMetadata,
  type ParameterMetadata,
  type ParameterSource,
  type Paramtype,
  type ParamsFactory,
  type PipeLike,
  type PipeTransform,
  type PrecompiledControllerDescriptor,
  type PrecompiledRouteDescriptor,
  type StandardSchemaV1,
  type StandardSchemaV1Issue,
  type Type,
  type ValidationErrorDetail,
} from "@bunest/core";
import { isBoolean } from "@bunest/core/common";
import { extractRequestCookies } from "@bunest/core/http";
import type {
  McpContext,
  McpExposeOptions,
  McpModuleOptions,
  McpSchema,
  McpToolAnnotations,
  ToolOptions,
} from "../interfaces/mcp-types";
import {
  MCP_CONTEXT_TYPE,
  MCP_EXPOSE_METADATA,
  MCP_INTERNAL_CONTROLLER,
  MCP_PRIMITIVE_METADATA,
  MCP_REST_BRIDGE_PARAMS_METADATA,
} from "../mcp.constants";
import { assertScopes, assertToolName } from "../utils/names.util";
import { getSchemaJson, unwrapStandardSchemaDto } from "../utils/schema.util";

const SWAGGER_API_PROPERTIES_KEY = Symbol.for("bunest:swagger:api_properties");
const SWAGGER_API_OPERATION_KEY = Symbol.for("bunest:swagger:api_operation");

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const PARAM_SEGMENT_RE = /:([A-Za-z_][A-Za-z0-9_]*)(?:\([^)]*\))?(\?)?/g;
const BUILTIN_NON_DTO_CTORS = new Set<Function>([
  String,
  Number,
  Boolean,
  Object,
  Array,
  Date,
  Function,
  Symbol,
  BigInt,
  Promise,
  RegExp,
  Map,
  Set,
  Error,
  Uint8Array,
  ArrayBuffer,
  Blob,
  File,
  Response,
  Request,
  ReadableStream,
]);

export interface BridgedRestTool {
  readonly name: string;
  readonly options: ToolOptions;
  readonly inputSchema: McpSchema;
  readonly handler: (input: unknown, context: McpContext) => Promise<unknown>;
  readonly where: string;
}

interface SwaggerApiPropLike {
  readonly propertyKey: string;
  readonly name?: string;
  readonly type?: unknown;
  readonly isArray?: boolean;
  readonly required?: boolean | string[];
  readonly selfRequired?: boolean;
  readonly description?: string;
  readonly format?: string;
  readonly enum?: readonly unknown[] | Record<string, unknown>;
  readonly designType?: Function;
}

function isDtoClass(value: unknown): value is Type<unknown> {
  if (typeof value !== "function" || BUILTIN_NON_DTO_CTORS.has(value)) {
    return false;
  }
  return Boolean(value.prototype);
}

function toSnakeCase(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[-._]+|[-._]+$/g, "")
    .toLowerCase();
}

function sanitizeToolName(raw: string): string {
  const cleaned = raw
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[-.]+|[-.]+$/g, "");
  return cleaned.slice(0, 128) || "tool";
}

function joinRoutePath(ctrlPath: string, methodPath: string): string {
  const raw = `${ctrlPath}/${methodPath}`.replace(/\/+/g, "/");
  if (!raw.startsWith("/")) {
    return `/${raw}`;
  }
  return raw.length > 1 && raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

function extractUrlPathParams(
  fullPath: string,
): Array<{ readonly name: string; readonly optional: boolean }> {
  const out: Array<{ readonly name: string; readonly optional: boolean }> = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  PARAM_SEGMENT_RE.lastIndex = 0;
  while ((match = PARAM_SEGMENT_RE.exec(fullPath)) !== null) {
    const name = match[1]!;
    const optional = match[2] === "?";
    if (!seen.has(name)) {
      seen.add(name);
      out.push({ name, optional });
    }
  }
  return out;
}

function mapSourceToParamtype(source: ParameterSource): Paramtype {
  switch (source) {
    case "body":
    case "rawBody":
      return "body";
    case "query":
      return "query";
    case "param":
      return "param";
    case "header":
      return "header";
    case "cookies":
      return "cookies";
    case "signedCookies":
      return "signedCookies";
    case "session":
      return "session";
    case "hostParam":
      return "hostParam";
    case "uploadedFile":
      return "uploadedFile";
    case "uploadedFiles":
      return "uploadedFiles";
    case "request":
    case "response":
    case "next":
    case "ip":
    case "sseSignal":
    case "custom":
      return "custom";
  }
}

function isSkippedForHigherScopePipes(source: ParameterSource): boolean {
  return (
    source === "request" ||
    source === "response" ||
    source === "sseSignal" ||
    source === "rawBody"
  );
}

function primitiveToJsonSchema(type: unknown): Record<string, unknown> {
  if (type === String) return { type: "string" };
  if (type === Number) return { type: "number" };
  if (type === Boolean) return { type: "boolean" };
  if (type === Date) return { type: "string", format: "date-time" };
  if (type === BigInt) return { type: "integer" };
  if (type === Array) return { type: "array", items: {} };
  if (type === Object) return { type: "object" };
  if (typeof type === "string") {
    const lower = type.toLowerCase();
    if (
      lower === "string" ||
      lower === "number" ||
      lower === "integer" ||
      lower === "boolean" ||
      lower === "array" ||
      lower === "object"
    ) {
      return { type: lower };
    }
  }
  return { type: "string" };
}

function introspectClassicDtoJsonSchema(
  dto: Type<unknown>,
  seen = new Set<Function>(),
): Record<string, unknown> {
  if (seen.has(dto)) {
    return { type: "object" };
  }
  seen.add(dto);

  const properties: Record<string, Record<string, unknown>> = {};
  const requiredSet = new Set<string>();
  const optionalSet = new Set<string>();
  const propApiMap = new Map<string, SwaggerApiPropLike>();

  for (const ctor of MetadataRegistry.getPrototypeChain(dto)) {
    const ownProps = MetadataRegistry.getOwn<readonly SwaggerApiPropLike[]>(
      SWAGGER_API_PROPERTIES_KEY,
      ctor,
    );
    if (ownProps) {
      for (const p of ownProps) {
        if (p?.propertyKey) {
          propApiMap.set(p.propertyKey, p);
        }
      }
    }
  }

  const validatorMap = new Map<string, Record<string, unknown>>();
  try {
    const metas = getValidationMetadatasForTarget(dto, false, false);
    for (const meta of metas) {
      if (!meta?.propertyName) continue;
      const key = meta.propertyName;
      if (meta.type === "conditionalValidation" && meta.name === "isOptional") {
        optionalSet.add(key);
        continue;
      }
      let schema = validatorMap.get(key);
      if (!schema) {
        schema = {};
        validatorMap.set(key, schema);
      }
      const rule = (meta.name ?? meta.type ?? "").toLowerCase();
      const constraints = meta.constraints ?? [];
      switch (rule) {
        case "isstring":
          schema.type = "string";
          break;
        case "isemail":
          schema.type = "string";
          schema.format = "email";
          break;
        case "isuuid":
          schema.type = "string";
          schema.format = "uuid";
          break;
        case "isint":
          schema.type = "integer";
          break;
        case "isnumber":
          schema.type = schema.type ?? "number";
          break;
        case "isboolean":
          schema.type = "boolean";
          break;
        case "isarray":
          schema.type = "array";
          break;
        case "isobject":
          schema.type = "object";
          break;
        case "minlength":
          if (typeof constraints[0] === "number") schema.minLength = constraints[0];
          break;
        case "maxlength":
          if (typeof constraints[0] === "number") schema.maxLength = constraints[0];
          break;
        case "min":
          if (typeof constraints[0] === "number") schema.minimum = constraints[0];
          break;
        case "max":
          if (typeof constraints[0] === "number") schema.maximum = constraints[0];
          break;
        case "isnotempty":
          if (schema.type === undefined || schema.type === "string") {
            schema.minLength = Math.max(
              typeof schema.minLength === "number" ? schema.minLength : 0,
              1,
            );
          }
          break;
        case "isenum":
          if (constraints[0] && typeof constraints[0] === "object") {
            schema.enum = Object.values(constraints[0] as Record<string, unknown>);
          }
          break;
        default:
          break;
      }
    }
  } catch {
    // Ignore if validation metadata storage is unavailable
  }

  const allKeys = new Set<string>([
    ...propApiMap.keys(),
    ...validatorMap.keys(),
  ]);

  for (const key of allKeys) {
    const api = propApiMap.get(key);
    const val = validatorMap.get(key);
    const designType =
      api?.designType ?? MetadataRegistry.getType(dto.prototype, key);
    let propSchema: Record<string, unknown>;

    const rawType = api?.type ?? designType;
    if (Array.isArray(rawType)) {
      propSchema = {
        type: "array",
        items: resolveMetatypeToJsonSchema(rawType[0], seen),
      };
    } else if (rawType !== undefined) {
      propSchema = resolveMetatypeToJsonSchema(rawType, seen);
      if (api?.isArray) {
        propSchema = { type: "array", items: propSchema };
      }
    } else {
      propSchema = {};
    }

    if (val) {
      propSchema = { ...propSchema, ...val };
    }
    if (api?.description !== undefined) {
      propSchema.description = api.description;
    }
    if (api?.format !== undefined) {
      propSchema.format = api.format;
    }
    if (api?.enum !== undefined) {
      propSchema.enum = Array.isArray(api.enum)
        ? [...api.enum]
        : Object.values(api.enum);
    }

    const outKey = api?.name ?? key;
    properties[outKey] = propSchema;

    const explicitRequired =
      api?.selfRequired ?? (isBoolean(api?.required) ? api.required : true);
    if (explicitRequired && !optionalSet.has(key)) {
      requiredSet.add(outKey);
    }
  }

  return {
    type: "object",
    properties,
    ...(requiredSet.size > 0 ? { required: [...requiredSet] } : {}),
  };
}

function resolveMetatypeToJsonSchema(
  metatype: unknown,
  seen = new Set<Function>(),
): Record<string, unknown> {
  if (metatype === undefined) {
    return { type: "string" };
  }
  const std = unwrapStandardSchemaDto(metatype);
  if (std) {
    const { $schema: _ignored, ...rest } = getSchemaJson(std, "input");
    return rest;
  }
  if (isDtoClass(metatype)) {
    return introspectClassicDtoJsonSchema(metatype, seen);
  }
  return primitiveToJsonSchema(metatype);
}

function resolveParamSchemaJson(
  param: ParameterMetadata,
): Record<string, unknown> {
  if (param.schema) {
    const { $schema: _ignored, ...rest } = getSchemaJson(
      param.schema as McpSchema,
      "input",
    );
    return rest;
  }
  if (param.metatype !== undefined) {
    return resolveMetatypeToJsonSchema(param.metatype);
  }
  return param.source === "body" ? { type: "object" } : { type: "string" };
}

function formatStandardSchemaIssuesToBadRequest(
  issues: readonly StandardSchemaV1Issue[],
  fallbackField: string,
): BadRequestException {
  const byField = new Map<string, Record<string, string>>();
  for (const issue of issues) {
    const segments = Array.isArray(issue.path)
      ? issue.path.map((seg) =>
          typeof seg === "object" && seg !== null && "key" in seg
            ? String(seg.key)
            : String(seg),
        )
      : [];
    const field = segments.join(".") || fallbackField;
    let constraints = byField.get(field);
    if (!constraints) {
      constraints = {};
      byField.set(field, constraints);
    }
    let k = "standardSchema";
    let suffix = 2;
    while (Object.prototype.hasOwnProperty.call(constraints, k)) {
      k = `standardSchema_${suffix++}`;
    }
    constraints[k] = issue.message || "Invalid value";
  }

  const details: ValidationErrorDetail[] = [];
  for (const [field, constraints] of byField.entries()) {
    details.push({
      field,
      constraints,
      messages: Object.values(constraints),
    });
  }

  return new BadRequestException({
    statusCode: HttpStatus.BAD_REQUEST,
    error: "Bad Request",
    message: "Validation failed",
    details,
  });
}

function buildSyntheticHttpRequest(
  method: string,
  fullPath: string,
  inputRecord: Record<string, unknown>,
  parameters: readonly ParameterMetadata[],
  mcpContext: McpContext,
): Request {
  const interpolated = fullPath.replace(
    PARAM_SEGMENT_RE,
    (_full, name: string) => {
      const val = inputRecord[name];
      return val !== undefined && val !== null
        ? encodeURIComponent(String(val))
        : "";
    },
  );

  const normalizedPath = interpolated.startsWith("/")
    ? interpolated
    : `/${interpolated}`;
  const url = new URL(`http://localhost${normalizedPath}`);

  for (const param of parameters) {
    if (param.source === "query") {
      if (param.key !== undefined) {
        const val = inputRecord[param.key];
        if (val !== undefined && val !== null) {
          url.searchParams.set(param.key, String(val));
        }
      } else {
        for (const [k, v] of Object.entries(inputRecord)) {
          if (v !== undefined && v !== null && typeof v !== "object") {
            url.searchParams.set(k, String(v));
          }
        }
      }
    }
  }

  const headers = new Headers();
  if (mcpContext.requestInfo instanceof Request) {
    mcpContext.requestInfo.headers.forEach((v, k) => {
      const lower = k.toLowerCase();
      if (lower !== "content-length" && lower !== "content-type") {
        headers.set(k, v);
      }
    });
  } else if (
    mcpContext.request &&
    typeof mcpContext.request === "object" &&
    "headers" in mcpContext.request
  ) {
    const rawHeaders = (
      mcpContext.request as { headers?: Record<string, unknown> }
    ).headers;
    if (rawHeaders && typeof rawHeaders === "object") {
      for (const [k, v] of Object.entries(rawHeaders)) {
        if (typeof v === "string") {
          headers.set(k, v);
        }
      }
    }
  }

  for (const param of parameters) {
    if (param.source === "header" && param.key !== undefined) {
      const val = inputRecord[param.key];
      if (val !== undefined && val !== null) {
        headers.set(param.key, String(val));
      }
    }
  }

  const upper = method.toUpperCase();
  const safeMethod = upper === "ALL" ? "POST" : upper;
  return new Request(url.toString(), {
    method: safeMethod,
    headers,
  });
}

function buildInputSchemaForRoute(
  fullPath: string,
  parameters: readonly ParameterMetadata[],
): {
  readonly inputSchema: McpSchema;
  readonly isFlatWholeBody: boolean;
  readonly reservedNonBodyKeys: ReadonlySet<string>;
} {
  const urlPathParams = extractUrlPathParams(fullPath);
  const wholeBodyParam = parameters.find(
    (p) => p.source === "body" && p.key === undefined,
  );
  const otherInputParams = parameters.filter(
    (p) =>
      p.source === "param" ||
      p.source === "query" ||
      p.source === "header" ||
      (p.source === "body" && p.key !== undefined),
  );
  const isFlatWholeBody =
    wholeBodyParam !== undefined &&
    otherInputParams.length === 0 &&
    urlPathParams.length === 0;

  const reservedNonBodyKeys = new Set<string>();
  let rootJsonSchema: Record<string, unknown>;

  if (isFlatWholeBody && wholeBodyParam) {
    const bodySchema = resolveParamSchemaJson(wholeBodyParam);
    rootJsonSchema =
      bodySchema.type === "object" || bodySchema.properties !== undefined
        ? { type: "object", ...bodySchema }
        : { type: "object", properties: { body: bodySchema } };
  } else {
    const properties: Record<string, unknown> = {};
    const requiredSet = new Set<string>();

    for (const pp of urlPathParams) {
      reservedNonBodyKeys.add(pp.name);
      properties[pp.name] = { type: "string" };
      if (!pp.optional) {
        requiredSet.add(pp.name);
      }
    }

    for (const param of otherInputParams) {
      if (param.source === "param") {
        if (param.key !== undefined) {
          reservedNonBodyKeys.add(param.key);
          properties[param.key] = resolveParamSchemaJson(param);
          const urlInfo = urlPathParams.find((p) => p.name === param.key);
          if (!urlInfo?.optional) {
            requiredSet.add(param.key);
          }
        } else {
          const objSchema = resolveParamSchemaJson(param);
          if (
            objSchema.properties &&
            typeof objSchema.properties === "object"
          ) {
            for (const [k, v] of Object.entries(
              objSchema.properties as Record<string, unknown>,
            )) {
              reservedNonBodyKeys.add(k);
              properties[k] = v;
            }
            if (Array.isArray(objSchema.required)) {
              for (const r of objSchema.required) {
                if (typeof r === "string") requiredSet.add(r);
              }
            }
          }
        }
      } else if (param.source === "query") {
        if (param.key !== undefined) {
          reservedNonBodyKeys.add(param.key);
          properties[param.key] = resolveParamSchemaJson(param);
        } else {
          const objSchema = resolveParamSchemaJson(param);
          if (
            objSchema.properties &&
            typeof objSchema.properties === "object"
          ) {
            for (const [k, v] of Object.entries(
              objSchema.properties as Record<string, unknown>,
            )) {
              reservedNonBodyKeys.add(k);
              properties[k] = v;
            }
            if (Array.isArray(objSchema.required)) {
              for (const r of objSchema.required) {
                if (typeof r === "string") requiredSet.add(r);
              }
            }
          }
        }
      } else if (param.source === "header") {
        if (param.key !== undefined) {
          reservedNonBodyKeys.add(param.key);
          properties[param.key] = resolveParamSchemaJson(param);
        }
      } else if (param.source === "body" && param.key !== undefined) {
        properties[param.key] = resolveParamSchemaJson(param);
      }
    }

    if (wholeBodyParam) {
      properties.body = resolveParamSchemaJson(wholeBodyParam);
      requiredSet.add("body");
    }

    rootJsonSchema = {
      type: "object",
      properties,
      ...(requiredSet.size > 0 ? { required: [...requiredSet] } : {}),
    };
  }

  // Validate basic object envelope at MCP layer so Guards run FIRST inside
  // ExternalContextCreator before full param-level Standard Schema / ValidationPipe validation.
  const bridgeSchema: McpSchema<Record<string, unknown>, Record<string, unknown>> = {
    "~standard": {
      version: 1,
      vendor: "bunest-mcp-rest-bridge",
      validate(value: unknown) {
        if (value === undefined || value === null) {
          return { value: {} };
        }
        if (typeof value !== "object" || Array.isArray(value)) {
          return { issues: [{ message: "Expected an object of arguments" }] };
        }
        return { value: value as Record<string, unknown> };
      },
      jsonSchema: {
        input: () => rootJsonSchema,
        output: () => rootJsonSchema,
      },
    },
  };

  return {
    inputSchema: bridgeSchema,
    isFlatWholeBody,
    reservedNonBodyKeys,
  };
}

function defaultAnnotationsForMethod(
  method: string,
): McpToolAnnotations | undefined {
  switch (method.toUpperCase()) {
    case "GET":
    case "HEAD":
    case "OPTIONS":
      return { readOnlyHint: true, idempotentHint: true };
    case "PUT":
      return { idempotentHint: true };
    case "DELETE":
      return { destructiveHint: true };
    default:
      return undefined;
  }
}

function resolveRouteDescription(
  methodExpose: McpExposeOptions | undefined,
  handlerFn: Function,
  method: string,
  fullPath: string,
): string {
  if (methodExpose?.description) {
    return methodExpose.description;
  }
  const swaggerOp = MetadataRegistry.get<{
    summary?: string;
    description?: string;
  }>(SWAGGER_API_OPERATION_KEY, handlerFn);
  if (swaggerOp?.description) {
    return swaggerOp.description;
  }
  if (swaggerOp?.summary) {
    return swaggerOp.summary;
  }
  return `${method.toUpperCase()} ${fullPath}`;
}

export function shouldExposeControllerRoute(
  controllerCtor: Type<unknown>,
  route: PrecompiledRouteDescriptor,
  options: McpModuleOptions,
): {
  readonly expose: boolean;
  readonly classExpose?: McpExposeOptions;
  readonly methodExpose?: McpExposeOptions;
} {
  if (
    MetadataRegistry.get<boolean>(MCP_INTERNAL_CONTROLLER, controllerCtor) ===
    true
  ) {
    return { expose: false };
  }
  const handlerFn = route.handlerFn;
  if (typeof handlerFn !== "function") {
    return { expose: false };
  }
  if (MetadataRegistry.has(MCP_PRIMITIVE_METADATA, handlerFn)) {
    return { expose: false };
  }

  const classExpose = MetadataRegistry.get<McpExposeOptions>(
    MCP_EXPOSE_METADATA,
    controllerCtor,
  );
  const methodExpose = MetadataRegistry.get<McpExposeOptions>(
    MCP_EXPOSE_METADATA,
    handlerFn,
  );

  if (methodExpose !== undefined) {
    return {
      expose: methodExpose.include !== false,
      classExpose,
      methodExpose,
    };
  }
  if (classExpose !== undefined) {
    return {
      expose: classExpose.include !== false && !route.isSse,
      classExpose,
      methodExpose,
    };
  }
  if (options.exposeControllers === true) {
    return { expose: !route.isSse, classExpose, methodExpose };
  }
  if (Array.isArray(options.exposeControllers)) {
    return {
      expose:
        options.exposeControllers.includes(controllerCtor) && !route.isSse,
      classExpose,
      methodExpose,
    };
  }
  return { expose: false };
}

export function buildBridgedRestToolsForController(
  instance: object,
  controllerCtor: Type<unknown>,
  options: McpModuleOptions,
  deps: {
    readonly discovery: DiscoveryService;
    readonly externalContextCreator: ExternalContextCreator;
    readonly applicationConfig?: ApplicationConfig;
    readonly moduleRef?: ModuleRef;
  },
): BridgedRestTool[] {
  const precompiled: PrecompiledControllerDescriptor | undefined =
    MetadataRegistry.getPrecompiledController(controllerCtor);
  if (!precompiled || precompiled.routes.length === 0) {
    return [];
  }

  const ctrlBasePath = precompiled.paths[0] ?? "/";
  const ctrlRawName = controllerCtor.name || "Controller";
  const ctrlPrefix = toSnakeCase(ctrlRawName.replace(/Controller$/, "") || ctrlRawName);

  const tools: BridgedRestTool[] = [];
  const handledKeys = new Set<string | symbol>();

  for (const route of precompiled.routes) {
    if (handledKeys.has(route.handlerKey)) {
      continue;
    }

    const decision = shouldExposeControllerRoute(controllerCtor, route, options);
    if (!decision.expose || typeof route.handlerFn !== "function") {
      continue;
    }
    handledKeys.add(route.handlerKey);

    const handlerFn = route.handlerFn as (...args: unknown[]) => unknown;
    const methodName = String(route.handlerKey);
    const where = `${ctrlRawName}.${methodName}`;
    const routePath = route.paths[0] ?? "";
    const fullPath = joinRoutePath(ctrlBasePath, routePath);

    const scopes =
      decision.methodExpose?.scopes ?? decision.classExpose?.scopes;
    assertScopes(scopes, where);

    const prefix = decision.classExpose?.name || ctrlPrefix;
    const baseName = toSnakeCase(methodName);
    const toolName =
      decision.methodExpose?.name ||
      sanitizeToolName(prefix ? `${prefix}_${baseName}` : baseName);
    assertToolName(toolName, where);

    const description = resolveRouteDescription(
      decision.methodExpose,
      handlerFn,
      route.method,
      fullPath,
    );
    const methodDefaults = defaultAnnotationsForMethod(route.method);
    const annotations: McpToolAnnotations | undefined =
      methodDefaults ||
      decision.classExpose?.annotations ||
      decision.methodExpose?.annotations
        ? {
            ...(methodDefaults ?? {}),
            ...(decision.classExpose?.annotations ?? {}),
            ...(decision.methodExpose?.annotations ?? {}),
          }
        : undefined;

    const { inputSchema, isFlatWholeBody, reservedNonBodyKeys } =
      buildInputSchemaForRoute(fullPath, route.parameters);

    const paramsByIndex = new Map<number, ParameterMetadata>();
    for (const p of route.parameters) {
      paramsByIndex.set(p.index, p);
    }

    const collectGlobalPipes = async (): Promise<PipeLike[]> => {
      const globalPipes: PipeLike[] = [];
      if (deps.moduleRef) {
        try {
          const appPipes = await deps.moduleRef.resolve<PipeTransform>(
            APP_PIPE,
            undefined,
            { strict: false, each: true },
          );
          if (Array.isArray(appPipes)) {
            for (const p of appPipes) {
              if (p) globalPipes.push(p);
            }
          }
        } catch {
          // No APP_PIPE multi-providers registered
        }
      }
      const imperative = deps.applicationConfig?.getGlobalPipes() ?? [];
      for (const p of imperative) {
        if (p) globalPipes.push(p);
      }
      return globalPipes;
    };

    const createBridgePipeForParam = (
      param: ParameterMetadata,
    ): PipeTransform => {
      const realMeta: ArgumentMetadata = {
        type: mapSourceToParamtype(param.source),
        metatype: param.metatype as Type<unknown> | Function | undefined,
        data: param.key,
        ...(param.schema !== undefined ? { schema: param.schema } : {}),
      };
      const skipHigher = isSkippedForHigherScopePipes(param.source);

      return {
        async transform(rawValue: unknown): Promise<unknown> {
          const pipeSpecs: PipeLike[] = [];
          if (!skipHigher) {
            pipeSpecs.push(...(await collectGlobalPipes()));
            pipeSpecs.push(
              ...MetadataRegistry.getMergedClassArray<PipeLike>(
                METADATA_KEYS.PIPES,
                controllerCtor,
              ),
            );
            pipeSpecs.push(
              ...(MetadataRegistry.get<readonly PipeLike[]>(
                METADATA_KEYS.PIPES,
                handlerFn,
              ) ?? []),
            );
          }
          if (param.pipes && param.pipes.length > 0) {
            pipeSpecs.push(...param.pipes);
          }

          const resolvedPipes: PipeTransform[] = [];
          for (const spec of pipeSpecs) {
            if (!spec) continue;
            resolvedPipes.push(
              typeof spec === "function"
                ? await deps.discovery.resolveEnhancer<PipeTransform>(spec)
                : spec,
            );
          }

          const hasStdPipe = resolvedPipes.some(
            (p) => p instanceof StandardSchemaValidationPipe,
          );
          const hasValidationPipe = resolvedPipes.some(
            (p) => p instanceof ValidationPipe,
          );

          let current = rawValue;

          // Inline Standard Schema validation on `@Body(schema)` / `@Query(schema)` / `@Param(schema)`
          if (param.schema && !hasStdPipe) {
            const check = await (
              param.schema as StandardSchemaV1
            )["~standard"].validate(current);
            if (check.issues && check.issues.length > 0) {
              throw formatStandardSchemaIssuesToBadRequest(
                check.issues,
                realMeta.data ?? realMeta.type ?? "value",
              );
            }
            current = "value" in check ? check.value : current;
          }

          // Run Global -> Controller -> Method -> Param pipes with the real HTTP ArgumentMetadata
          for (const pipe of resolvedPipes) {
            current = await pipe.transform(current, realMeta);
          }

          // If `createSchemaDto(schema)` is used without ValidationPipe, still validate & hydrate it
          if (!hasValidationPipe && !skipHigher && param.metatype) {
            const stdDtoSchema = unwrapStandardSchemaDto(param.metatype);
            if (stdDtoSchema) {
              const check = await stdDtoSchema["~standard"].validate(current);
              if (check.issues && check.issues.length > 0) {
                throw formatStandardSchemaIssuesToBadRequest(
                  check.issues,
                  realMeta.data ?? realMeta.type ?? "value",
                );
              }
              const validated = "value" in check ? check.value : current;
              if (
                validated &&
                typeof validated === "object" &&
                !Array.isArray(validated) &&
                !(validated instanceof (param.metatype as Type<unknown>))
              ) {
                current = new (param.metatype as new (
                  data?: Record<string, unknown>,
                ) => unknown)(validated as Record<string, unknown>);
              } else {
                current = validated;
              }
            }
          }

          return current;
        },
      };
    };

    const bridgeParamsMeta: Record<string, unknown> = {};
    for (const param of route.parameters) {
      bridgeParamsMeta[`${param.index}:${param.index}`] = {
        index: param.index,
        type: param.index,
        data: param.key ?? param.data,
        pipes: [createBridgePipeForParam(param)],
        ...(param.source === "custom" && typeof param.factory === "function"
          ? { factory: param.factory }
          : {}),
      };
    }

    MetadataRegistry.define(
      MCP_REST_BRIDGE_PARAMS_METADATA,
      bridgeParamsMeta,
      controllerCtor,
      methodName,
    );

    const restParamsFactory: ParamsFactory = {
      exchangeKeyForValue(
        type: number | string,
        _data: unknown,
        args: unknown[],
      ): unknown {
        const httpRequest = args[0] as Request;
        const mcpCtx = args[1] as McpContext;
        const inputObj = (args[2] ?? {}) as Record<string, unknown>;
        const param = paramsByIndex.get(Number(type));
        if (!param) {
          return undefined;
        }

        switch (param.source) {
          case "body": {
            if (param.key !== undefined) {
              return inputObj[param.key];
            }
            if (isFlatWholeBody) {
              return inputObj;
            }
            if (inputObj.body !== undefined) {
              return inputObj.body;
            }
            const restBody: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(inputObj)) {
              if (!reservedNonBodyKeys.has(k) && !FORBIDDEN_KEYS.has(k)) {
                restBody[k] = v;
              }
            }
            return restBody;
          }
          case "param":
            return param.key !== undefined ? inputObj[param.key] : inputObj;
          case "query":
            return param.key !== undefined ? inputObj[param.key] : inputObj;
          case "header": {
            if (param.key !== undefined) {
              return (
                inputObj[param.key] ??
                httpRequest.headers.get(param.key) ??
                undefined
              );
            }
            const headerMap: Record<string, string> = {};
            httpRequest.headers.forEach((v, k) => {
              headerMap[k.toLowerCase()] = v;
            });
            return headerMap;
          }
          case "request":
            return httpRequest;
          case "ip":
            return (
              httpRequest.headers
                .get("x-forwarded-for")
                ?.split(",")[0]
                ?.trim() ?? "127.0.0.1"
            );
          case "sseSignal":
            return mcpCtx.signal;
          case "cookies":
          case "signedCookies": {
            const parsed = extractRequestCookies(httpRequest);
            return param.key !== undefined ? parsed[param.key] : parsed;
          }
          case "next":
            return () => undefined;
          default:
            return undefined;
        }
      },
    };

    const externalWrapped = deps.externalContextCreator.create(
      instance,
      handlerFn,
      methodName,
      route.parameters.length > 0 ? MCP_REST_BRIDGE_PARAMS_METADATA : undefined,
      route.parameters.length > 0 ? restParamsFactory : undefined,
      undefined,
      undefined,
      { guards: true, interceptors: true, filters: true, pipes: false },
      MCP_CONTEXT_TYPE,
    );

    const handler = async (
      input: unknown,
      mcpContext: McpContext,
    ): Promise<unknown> => {
      const inputRecord =
        input && typeof input === "object" && !Array.isArray(input)
          ? (input as Record<string, unknown>)
          : {};
      const syntheticRequest = buildSyntheticHttpRequest(
        route.method,
        fullPath,
        inputRecord,
        route.parameters,
        mcpContext,
      );
      return await externalWrapped(syntheticRequest, mcpContext, inputRecord);
    };

    const toolOptions: ToolOptions = {
      name: toolName,
      description,
      ...(scopes ? { scopes } : {}),
      ...(annotations ? { annotations } : {}),
    };

    tools.push({
      name: toolName,
      options: toolOptions,
      inputSchema,
      handler,
      where,
    });
  }

  return tools;
}
