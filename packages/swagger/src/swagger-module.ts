import { ensurePrefix, toArray, unique } from "@bunest/core/common";
import {
  Controller,
  Get,
  HttpStatus,
  Logger,
  METADATA_KEYS,
  MetadataRegistry,
  Req,
  Res,
  VERSION_NEUTRAL,
  Version,
  VersioningType,
  resolveRouterModulePrefixes,
  type BunestApplication,
  type ControllerMetadata,
  type HttpServer,
  type INestApplication,
  type ParameterMetadata,
  type ResponseContext,
  type RouteDefinition,
  type RouteInfo,
  type Type,
  type VersionValue,
  type VersioningOptions,
} from "@bunest/core";
import {
  type BunHttpAdapter,
  type GlobalPrefixOptions,
  type HttpRuntimeBridge,
  normalizePath,
  scanControllers,
} from "@bunest/core/http";
import { SWAGGER_METADATA_KEYS } from "./constants";
import { ApiExcludeController } from "./decorators/api.decorators";
import {
  getDocumentBuilderExtras,
  type DocumentBuilderExtras,
} from "./document-builder";
import type {
  ApiBodyOptions,
  ApiHeaderOptions,
  ApiLinkOptions,
  ApiOperationOptions,
  ApiParamOptions,
  ApiPropertyMetadata,
  ApiQueryOptions,
  ApiResponseCommonMetadata,
  ApiResponseOptions,
  ApiResponseSchemaHost,
  ApiTagOptions,
  CallBackObject,
  CallbackObject,
  CallbacksObject,
  LinksObject,
  OpenAPIObject,
  OpenApiDocument,
  OpenApiMediaType,
  OpenApiOperation,
  OpenApiParameter,
  OpenApiPathItem,
  OpenApiRequestBody,
  OpenApiResponse,
  OpenApiSchema,
  OpenApiSecurityRequirement,
  OpenApiTag,
  ParameterObject,
  SwaggerConfig,
  SwaggerCustomOptions,
  SwaggerDocumentOptions,
  SwaggerSetupOptions,
  SwaggerVersionedDocumentOptions,
  SwaggerVersionedDocuments,
  WebhooksObject,
} from "./interfaces/openapi.interface";
import {
  getPluginControllerActionMetadata,
  registerLoadedPluginMetadata,
} from "./plugin-metadata-store";
import {
  applyNullable30,
  convertSchemaToOas31,
  isDtoConstructor,
  isSchemaDecoratedClass,
  normalizeEnumValues,
  SchemaExplorer,
  stripDynamicDefaultsFromSchema,
} from "./schema-explorer";
import { renderSwaggerHtml } from "./swagger-ui";
import { serializeToYaml } from "./utils/yaml-serializer";

type LowerHttpMethod =
  | "get"
  | "post"
  | "put"
  | "patch"
  | "delete"
  | "options"
  | "head"
  | "trace"
  | "query";

const ALL_EXPANDED_METHODS: readonly LowerHttpMethod[] = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
];

const STANDARD_OAS_METHODS = new Set<string>([
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
]);

function parseOpenApiVersion(version?: string): [number, number, number] {
  const parts = (version || "3.1.0")
    .split(".")
    .map((n) => Number.parseInt(n, 10));
  return [parts[0] || 3, parts[1] || 0, parts[2] || 0];
}

function isOpenApiAtLeast(
  version: string | undefined,
  major: number,
  minor: number,
): boolean {
  const [maj, min] = parseOpenApiVersion(version);
  return maj > major || (maj === major && min >= minor);
}

function mergeSecurityRequirements(
  existing: OpenApiSecurityRequirement[] | undefined,
  incoming: OpenApiSecurityRequirement[] | undefined,
): OpenApiSecurityRequirement[] | undefined {
  if (!existing || existing.length === 0) return incoming;
  if (!incoming || incoming.length === 0) return existing;
  const merged = [...existing];
  const seen = new Set(existing.map((r) => JSON.stringify(r)));
  for (const req of incoming) {
    const key = JSON.stringify(req);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(req);
    }
  }
  return merged;
}

const PARAM_SEGMENT_RE = /^:([A-Za-z_][A-Za-z0-9_]*)(?:\((.+)\))?(\?)?$/;
const NAMED_WILDCARD_RE = /^\*([A-Za-z_][A-Za-z0-9_]*)$/;
const OPTIONAL_BRACE_PARAM_RE = /\{\/(:[A-Za-z_][A-Za-z0-9_]*(?:\([^)]*\))?)\}/g;

// Core serializer & @bunest/security metadata symbols (zero runtime dep on @bunest/security)
const STANDARD_SCHEMA_SERIALIZER_METADATA_KEY = Symbol.for(
  "bunest:validation:standard_schema_serializer",
);
const CLASS_SERIALIZER_OPTIONS_KEY = Symbol.for(
  "bunest:validation:class_serializer_options",
);
const SECURITY_IS_PUBLIC_KEY = Symbol.for("bunest:security:is_public");
const AUTH_NEXT_PUBLIC_KEY = Symbol.for("@nestjs/authentication:public");
const SECURITY_THROTTLE_KEY = Symbol.for("bunest:security:throttle");
const SECURITY_SKIP_THROTTLE_KEY = Symbol.for("bunest:security:skip_throttle");

export interface ConvertedPathInfo {
  readonly openApiPath: string;
  readonly pathParams: Array<{
    readonly name: string;
    readonly optional: boolean;
    readonly pattern?: string;
  }>;
}

/**
 * Converts a Bunest route path (e.g. `/users/:id/orders/:orderId(\d+)`)
 * into an OpenAPI 3.1 path template (`/users/{id}/orders/{orderId}`).
 */
export function convertPathToOpenApi(fullPath: string): ConvertedPathInfo {
  // Expand Express v5 optional brace groups like `group-first{/:id}` -> `group-first/:id?`
  const expandedBraces = fullPath.replace(
    OPTIONAL_BRACE_PARAM_RE,
    "/$1?",
  );
  const normalized = normalizePath(expandedBraces);
  if (normalized === "/") {
    return { openApiPath: "/", pathParams: [] };
  }

  const segments = normalized.slice(1).split("/");
  const outSegments: string[] = [];
  const pathParams: ConvertedPathInfo["pathParams"] = [];
  let wildcardIdx = 0;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (seg === "*") {
      const wildcardName =
        wildcardIdx === 0 ? "path" : `path${wildcardIdx + 1}`;
      wildcardIdx++;
      outSegments.push(`{${wildcardName}}`);
      pathParams.push({ name: wildcardName, optional: false });
      continue;
    }

    const namedWildcard = NAMED_WILDCARD_RE.exec(seg);
    if (namedWildcard) {
      const name = namedWildcard[1]!;
      outSegments.push(`{${name}}`);
      pathParams.push({ name, optional: false });
      continue;
    }

    const match = PARAM_SEGMENT_RE.exec(seg);
    if (match) {
      const name = match[1]!;
      const pattern = match[2];
      const optional = match[3] === "?";
      outSegments.push(`{${name}}`);
      pathParams.push({ name, optional, pattern });
      continue;
    }

    // Unescape literal colons (`\:`) in static route segments
    outSegments.push(seg.replace(/\\:/g, ":"));
  }

  return {
    openApiPath: `/${outSegments.join("/")}`,
    pathParams,
  };
}

function defaultTagForController(controller: Type<unknown>): string {
  const rawName = controller.name || "default";
  const stripped = rawName.replace(/Controller$/, "");
  return stripped || rawName;
}

function defaultStatusForRoute(
  route: RouteDefinition,
  effectiveMethod?: string,
): string {
  if (route.httpCode !== undefined) {
    return String(route.httpCode);
  }
  if (route.redirect) {
    return String(route.redirect.statusCode ?? HttpStatus.FOUND);
  }
  if (route.isSse) {
    return String(HttpStatus.OK);
  }
  const method = (effectiveMethod ?? route.method).toUpperCase();
  return method === "POST"
    ? String(HttpStatus.CREATED)
    : String(HttpStatus.OK);
}

function defaultStatusDescriptionForCode(status: string): string {
  switch (status) {
    case "200":
      return "OK";
    case "201":
      return "Created";
    case "202":
      return "Accepted";
    case "204":
      return "No Content";
    case "206":
      return "Partial Content";
    case "301":
      return "Moved Permanently";
    case "302":
      return "Found";
    case "303":
      return "See Other";
    case "304":
      return "Not Modified";
    case "307":
      return "Temporary Redirect";
    case "308":
      return "Permanent Redirect";
    case "400":
      return "Bad Request";
    case "401":
      return "Unauthorized";
    case "403":
      return "Forbidden";
    case "404":
      return "Not Found";
    case "429":
      return "Too Many Requests";
    default:
      return "OK";
  }
}

function readAdapterGlobalPrefix(adapter: BunHttpAdapter): {
  prefix?: string;
  rawPrefix?: string | readonly string[];
  options?: GlobalPrefixOptions;
} {
  const rawPrefix = adapter.getGlobalPrefix();
  return {
    prefix: typeof rawPrefix === "string" ? rawPrefix : rawPrefix?.[0],
    rawPrefix,
    options: adapter.getGlobalPrefixOptions(),
  };
}

function resolveRoutesForDocument(
  app: BunestApplication,
  docOptions: SwaggerDocumentOptions,
): readonly RouteDefinition[] {
  const adapter = app.getHttpAdapter();
  const { rawPrefix, options } = readAdapterGlobalPrefix(adapter);
  const effectivePrefix = docOptions.ignoreGlobalPrefix ? undefined : rawPrefix;
  const effectivePrefixOptions = docOptions.ignoreGlobalPrefix
    ? undefined
    : options;
  const registry = adapterRegistries.get(adapter);
  const versioning = app.getVersioningOptions?.();
  const graph = app.getModuleContainer().getGraph();
  const controllerPrefixes = resolveRouterModulePrefixes(graph);

  // Build controller inclusion set supporting BOTH controllers AND module classes in `options.include`
  let allowedControllers: Set<Function> | undefined;
  if (docOptions.include && docOptions.include.length > 0) {
    allowedControllers = new Set<Function>();
    const includeTargets = new Set<Function>(docOptions.include);
    const matchedModules = new Set<unknown>();
    const deepScan = docOptions.deepScanRoutes === true;

    const moduleNodeByClass = new Map<
      Function,
      (typeof graph.topologicalOrder)[number]
    >();
    for (const mod of graph.topologicalOrder) {
      moduleNodeByClass.set(mod.metatype, mod);
    }

    const collectFromModule = (
      mod: (typeof graph.topologicalOrder)[number],
    ): void => {
      if (matchedModules.has(mod)) return;
      matchedModules.add(mod);
      for (const ctrl of mod.controllers) {
        allowedControllers!.add(ctrl);
      }
      if (deepScan) {
        if (Array.isArray(mod.imports)) {
          for (const child of mod.imports) {
            if (child) collectFromModule(child);
          }
        }
        // If raw @Module({ imports }) contains an async Promise import that cannot
        // be matched synchronously, preserve NestJS fallback by including global modules.
        const rawModMeta = MetadataRegistry.getOwn<{
          imports?: readonly unknown[];
        }>(METADATA_KEYS.MODULE, mod.metatype);
        if (
          Array.isArray(rawModMeta?.imports) &&
          rawModMeta.imports.some(
            (imp) =>
              imp !== null &&
              typeof imp === "object" &&
              typeof (imp as { then?: unknown }).then === "function",
          )
        ) {
          for (const candidate of graph.topologicalOrder) {
            if (candidate.isGlobal) {
              collectFromModule(candidate);
            }
          }
        }
      }
    };

    for (const target of includeTargets) {
      const modNode = moduleNodeByClass.get(target);
      if (modNode) {
        collectFromModule(modNode);
      } else {
        allowedControllers.add(target);
      }
    }
  }

  const controllers: Type<unknown>[] = [];
  const seen = new Set<Type<unknown>>();
  for (const mod of graph.topologicalOrder) {
    for (const ctrl of mod.controllers) {
      if (seen.has(ctrl) || registry?.instances.has(ctrl)) {
        continue;
      }
      if (allowedControllers && !allowedControllers.has(ctrl)) {
        continue;
      }
      seen.add(ctrl);
      controllers.push(ctrl);
    }
  }

  if (controllers.length > 0) {
    return scanControllers(controllers, {
      globalPrefix: effectivePrefix,
      globalPrefixOptions: effectivePrefixOptions,
      controllerPrefixes:
        controllerPrefixes.size > 0 ? controllerPrefixes : undefined,
      versioning,
      routeConflictPolicy: "allow",
      preserveDuplicates: true,
    });
  }

  if (allowedControllers && allowedControllers.size === 0) {
    return [];
  }

  return app.getRoutes();
}

interface SwaggerAdapterRegistry {
  readonly controllers: Type<unknown>[];
  readonly instances: Map<Type<unknown>, object>;
  readonly excludedPaths: Set<string>;
  readonly originalSetGlobalPrefix: BunHttpAdapter["setGlobalPrefix"];
  lastUserControllers: readonly Type<unknown>[];
  dirty: boolean;
}

const adapterRegistries = new WeakMap<BunHttpAdapter, SwaggerAdapterRegistry>();

function mergeExcludedGlobalPrefixOptions(
  existingOptions: GlobalPrefixOptions | undefined,
  excludedPaths: ReadonlySet<string>,
): GlobalPrefixOptions {
  const merged: Array<string | RouteInfo> = [
    ...(existingOptions?.exclude ?? []),
  ];
  for (const p of excludedPaths) {
    const alreadyPresent = merged.some(
      (entry) => typeof entry === "string" && normalizePath(entry) === p,
    );
    if (!alreadyPresent) {
      merged.push(p);
    }
  }
  return {
    ...existingOptions,
    exclude: merged,
  };
}

function getOrInstallAdapterRegistry(
  app: BunestApplication,
  adapter: BunHttpAdapter,
): SwaggerAdapterRegistry {
  const existing = adapterRegistries.get(adapter);
  if (existing) {
    return existing;
  }

  const container = app.getModuleContainer();
  const initialControllers: Type<unknown>[] = [];
  const seen = new Set<Type<unknown>>();
  for (const mod of container.getGraph().topologicalOrder) {
    for (const ctrl of mod.controllers) {
      if (!seen.has(ctrl)) {
        seen.add(ctrl);
        initialControllers.push(ctrl);
      }
    }
  }

  const originalSetGlobalPrefix = adapter.setGlobalPrefix.bind(adapter);

  const registry: SwaggerAdapterRegistry = {
    controllers: [],
    instances: new Map(),
    excludedPaths: new Set(),
    originalSetGlobalPrefix,
    lastUserControllers: initialControllers,
    dirty: false,
  };
  adapterRegistries.set(adapter, registry);

  adapter.setGlobalPrefix = (
    prefix: string | readonly string[],
    prefixOptions?: GlobalPrefixOptions,
  ) => {
    const nextOptions =
      registry.excludedPaths.size > 0
        ? mergeExcludedGlobalPrefixOptions(
            prefixOptions,
            registry.excludedPaths,
          )
        : prefixOptions;
    return originalSetGlobalPrefix(prefix, nextOptions);
  };

  const existingBridge: HttpRuntimeBridge | undefined =
    typeof adapter.getBridge === "function" ? adapter.getBridge() : undefined;

  const bridge: HttpRuntimeBridge = {
    resolveController(controllerToken, requestContainer) {
      const swaggerInstance = registry.instances.get(controllerToken);
      if (swaggerInstance) {
        return swaggerInstance;
      }
      return existingBridge
        ? existingBridge.resolveController(controllerToken, requestContainer)
        : container.resolveController(controllerToken, requestContainer);
    },
    resolveEnhancer(enhancer, requestContainer, kind, controllerToken) {
      if (existingBridge) {
        return existingBridge.resolveEnhancer(
          enhancer,
          requestContainer,
          kind,
          controllerToken,
        );
      }
      const owningModule = controllerToken
        ? container.getControllerOwner(controllerToken)
        : undefined;
      return container.resolveEnhancer(
        enhancer,
        requestContainer,
        owningModule,
        kind,
      );
    },
    createRequestContainer(request, responseContext) {
      return existingBridge?.createRequestContainer
        ? existingBridge.createRequestContainer(request, responseContext)
        : container.createRequestContainer(request, responseContext);
    },
    requiresRequestScope(controllerToken, enhancerTokens) {
      if (registry.instances.has(controllerToken)) {
        return false;
      }
      return existingBridge?.requiresRequestScope
        ? existingBridge.requiresRequestScope(controllerToken, enhancerTokens)
        : container.requiresRequestScope(controllerToken, enhancerTokens);
    },
    requiresEnhancerRequestScope(enhancer, kind, controllerToken) {
      if (controllerToken && registry.instances.has(controllerToken)) {
        return false;
      }
      return existingBridge?.requiresEnhancerRequestScope
        ? existingBridge.requiresEnhancerRequestScope(
            enhancer,
            kind,
            controllerToken,
          )
        : container.requiresEnhancerRequestScope(
            enhancer,
            kind,
            controllerToken,
          );
    },
    resolveFilterCatchTypes(filterSpec, resolvedInstance) {
      return existingBridge?.resolveFilterCatchTypes
        ? existingBridge.resolveFilterCatchTypes(filterSpec, resolvedInstance)
        : container.resolveFilterCatchTypes(filterSpec, resolvedInstance);
    },
  };
  adapter.setBridge(bridge);

  const origCompile = adapter.compileControllers.bind(adapter);
  adapter.compileControllers = async (
    controllers: readonly Type<unknown>[],
  ) => {
    registry.lastUserControllers = controllers.filter(
      (c) => !registry.instances.has(c),
    );
    const merged: Type<unknown>[] = [...registry.lastUserControllers];
    for (const swaggerCtrl of registry.controllers) {
      if (!merged.includes(swaggerCtrl)) {
        merged.push(swaggerCtrl);
      }
    }
    registry.dirty = false;
    return origCompile(merged);
  };

  const origFetch = adapter.fetch.bind(adapter);
  adapter.fetch = async (req, server) => {
    if (registry.dirty) {
      await adapter.compileControllers(registry.lastUserControllers);
    }
    return origFetch(req, server);
  };

  return registry;
}

function normalizeVersionList(
  value: VersionValue | undefined,
): Array<string | typeof VERSION_NEUTRAL> {
  if (value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  const deduped: Array<string | typeof VERSION_NEUTRAL> = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (item === VERSION_NEUTRAL) {
      if (!deduped.includes(VERSION_NEUTRAL)) {
        deduped.push(VERSION_NEUTRAL);
      }
    } else if (typeof item === "string") {
      const trimmed = item.trim();
      if (trimmed.length > 0 && !deduped.includes(trimmed)) {
        deduped.push(trimmed);
      }
    }
  }
  return deduped;
}

function resolveRouteVersions(
  controller: Type<unknown>,
  handlerFn: Function,
  versioning: VersioningOptions | undefined,
): Array<string | typeof VERSION_NEUTRAL> {
  if (!versioning) return [];

  const methodVersion = MetadataRegistry.get<VersionValue>(
    METADATA_KEYS.VERSION,
    handlerFn,
  );
  if (methodVersion !== undefined) {
    const list = normalizeVersionList(methodVersion);
    return list.length > 0 ? list : [VERSION_NEUTRAL];
  }

  const classVersion = MetadataRegistry.get<VersionValue>(
    METADATA_KEYS.VERSION,
    controller,
  );
  if (classVersion !== undefined) {
    const list = normalizeVersionList(classVersion);
    return list.length > 0 ? list : [VERSION_NEUTRAL];
  }

  const ctrlMeta = MetadataRegistry.get<ControllerMetadata>(
    METADATA_KEYS.CONTROLLER,
    controller,
  );
  if (ctrlMeta?.version !== undefined) {
    const list = normalizeVersionList(ctrlMeta.version);
    return list.length > 0 ? list : [VERSION_NEUTRAL];
  }

  if (versioning.defaultVersion !== undefined) {
    const list = normalizeVersionList(versioning.defaultVersion);
    return list.length > 0 ? list : [VERSION_NEUTRAL];
  }

  return [VERSION_NEUTRAL];
}

function compareVersionsNaturally(a: string, b: string): number {
  const cmp = a.localeCompare(b, undefined, {
    numeric: true,
    sensitivity: "base",
  });
  if (cmp !== 0) return cmp;
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function formatVersionSegment(version: string): string {
  return ensurePrefix(version, "v");
}

function isVersionedDocuments(
  input: unknown,
): input is SwaggerVersionedDocuments {
  if (input instanceof Map) {
    return true;
  }
  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    return !("openapi" in input && "paths" in input);
  }
  return false;
}

function extractVersionedEntries(
  docs: SwaggerVersionedDocuments,
): Array<[string, OpenApiDocument]> {
  if (docs instanceof Map) {
    return [...docs.entries()];
  }
  return Object.entries(docs);
}

function defaultVersionMatchesRoute(
  versioning: VersioningOptions | undefined,
  concreteVersions: readonly string[],
): boolean {
  if (!versioning?.defaultVersion || concreteVersions.length === 0) {
    return false;
  }
  const defaultTokens = normalizeVersionList(versioning.defaultVersion);
  return defaultTokens.some(
    (d) => typeof d === "string" && concreteVersions.includes(d),
  );
}

function applyUriVersionToPath(
  fullPath: string,
  globalPrefix: string | readonly string[] | undefined,
  uriPrefix: string,
  version: string | typeof VERSION_NEUTRAL,
): string {
  if (version === VERSION_NEUTRAL) {
    return normalizePath(fullPath);
  }
  const normalizedFull = normalizePath(fullPath);
  const versionSegment = `${uriPrefix}${version}`;
  const candidateGlobals = globalPrefix ? toArray(globalPrefix) : [];

  for (const rawGlobal of candidateGlobals) {
    const normalizedGlobal = normalizePath(rawGlobal);
    if (
      normalizedGlobal &&
      normalizedGlobal !== "/" &&
      (normalizedFull === normalizedGlobal ||
        normalizedFull.startsWith(`${normalizedGlobal}/`))
    ) {
      const remainder = normalizedFull.slice(normalizedGlobal.length) || "/";
      if (
        remainder === `/${versionSegment}` ||
        remainder.startsWith(`/${versionSegment}/`)
      ) {
        return normalizedFull;
      }
      return normalizePath(normalizedGlobal, versionSegment, remainder);
    }
  }

  if (
    normalizedFull === `/${versionSegment}` ||
    normalizedFull.startsWith(`/${versionSegment}/`)
  ) {
    return normalizedFull;
  }

  return normalizePath(versionSegment, normalizedFull);
}

function applyExtensions(
  target: Record<string, unknown>,
  extensions: Record<string, any> | undefined,
): void {
  if (!extensions) return;
  for (const [k, v] of Object.entries(extensions)) {
    const key = k.startsWith("x-") ? k : `x-${k}`;
    target[key] = v;
  }
}

function applyQuerySchemaExtras(
  schema: OpenApiSchema,
  q: ApiQueryOptions,
): void {
  if (q.title !== undefined) schema.title = q.title;
  if (q.format !== undefined) schema.format = q.format;
  if (q.default !== undefined) schema.default = q.default;
  if (q.multipleOf !== undefined) schema.multipleOf = q.multipleOf;
  if (q.maximum !== undefined) schema.maximum = q.maximum;
  if (q.exclusiveMaximum !== undefined) {
    schema.exclusiveMaximum = q.exclusiveMaximum;
  }
  if (q.minimum !== undefined) schema.minimum = q.minimum;
  if (q.exclusiveMinimum !== undefined) {
    schema.exclusiveMinimum = q.exclusiveMinimum;
  }
  if (q.maxLength !== undefined) schema.maxLength = q.maxLength;
  if (q.minLength !== undefined) schema.minLength = q.minLength;
  if (q.pattern !== undefined) schema.pattern = q.pattern;
  if (q.maxItems !== undefined) schema.maxItems = q.maxItems;
  if (q.minItems !== undefined) schema.minItems = q.minItems;
  if (q.uniqueItems !== undefined) schema.uniqueItems = q.uniqueItems;
  if (q.maxProperties !== undefined) schema.maxProperties = q.maxProperties;
  if (q.minProperties !== undefined) schema.minProperties = q.minProperties;
  if (q.const !== undefined) schema.const = q.const;
  if (q.contentEncoding !== undefined) {
    schema.contentEncoding = q.contentEncoding;
  }
  if (q.contentMediaType !== undefined) {
    schema.contentMediaType = q.contentMediaType;
  }
  if (q.readOnly !== undefined) schema.readOnly = q.readOnly;
  if (q.writeOnly !== undefined) schema.writeOnly = q.writeOnly;
  if (q.nullable !== undefined) schema.nullable = q.nullable;
  if (q.items !== undefined) schema.items = q.items;
  if (q.properties !== undefined) schema.properties = q.properties;
  if (q.additionalProperties !== undefined) {
    schema.additionalProperties = q.additionalProperties;
  }
  if (q.patternProperties !== undefined) {
    schema.patternProperties = q.patternProperties;
  }
  if (q.allOf !== undefined) {
    schema.allOf = schema.allOf
      ? [...schema.allOf, ...q.allOf]
      : [...q.allOf];
  }
  if (q.anyOf !== undefined) schema.anyOf = q.anyOf;
  if (q.oneOf !== undefined) schema.oneOf = q.oneOf;
  if (q.not !== undefined) schema.not = q.not;
  if (q.discriminator !== undefined) schema.discriminator = q.discriminator;
  if (q.xml !== undefined) schema.xml = q.xml;
  if (q.externalDocs !== undefined) schema.externalDocs = q.externalDocs;
  if (q["x-enumNames"] !== undefined) schema["x-enumNames"] = q["x-enumNames"];
}

function transformDocumentSchemas(
  doc: OpenApiDocument,
  transform: (schema: OpenApiSchema) => OpenApiSchema,
): void {
  const transformContent = (
    content: Record<string, OpenApiMediaType> | undefined,
  ): void => {
    if (!content) return;
    for (const [ct, media] of Object.entries(content)) {
      if (media?.schema) {
        content[ct] = { ...media, schema: transform(media.schema) };
      }
    }
  };

  const transformOperation = (op: OpenApiOperation | undefined): void => {
    if (!op) return;
    if (Array.isArray(op.parameters)) {
      op.parameters = op.parameters.map((param) => {
        const p = { ...param };
        if (p.schema) p.schema = transform(p.schema);
        if (p.content) {
          p.content = { ...p.content };
          transformContent(p.content);
        }
        return p;
      });
    }
    if (op.requestBody?.content) {
      op.requestBody = {
        ...op.requestBody,
        content: { ...op.requestBody.content },
      };
      transformContent(op.requestBody.content);
    }
    if (op.responses) {
      for (const [status, resp] of Object.entries(op.responses)) {
        if (!resp || resp.$ref) continue;
        const r = { ...resp };
        if (r.content) {
          r.content = { ...r.content };
          transformContent(r.content);
        }
        if (r.headers) {
          const newHeaders: Record<string, any> = {};
          for (const [hk, hv] of Object.entries(r.headers)) {
            if (hv && typeof hv === "object" && "schema" in hv && hv.schema) {
              newHeaders[hk] = { ...hv, schema: transform(hv.schema) };
            } else {
              newHeaders[hk] = hv;
            }
          }
          r.headers = newHeaders;
        }
        op.responses[status] = r;
      }
    }
    if (op.callbacks) {
      for (const cb of Object.values(op.callbacks)) {
        if (!cb || typeof cb !== "object") continue;
        for (const cbPathItem of Object.values(cb as Record<string, OpenApiPathItem>)) {
          transformPathItem(cbPathItem);
        }
      }
    }
  };

  const transformPathItem = (pathItem: OpenApiPathItem | undefined): void => {
    if (!pathItem) return;
    for (const m of [
      "get",
      "put",
      "post",
      "delete",
      "options",
      "head",
      "patch",
      "trace",
      "query",
    ] as const) {
      if (pathItem[m]) transformOperation(pathItem[m]);
    }
    if (pathItem.additionalOperations) {
      for (const op of Object.values(pathItem.additionalOperations)) {
        transformOperation(op);
      }
    }
  };

  if (doc.components?.schemas) {
    for (const [name, schema] of Object.entries(doc.components.schemas)) {
      doc.components.schemas[name] = transform(schema);
    }
  }
  for (const pathItem of Object.values(doc.paths)) {
    transformPathItem(pathItem);
  }
  if (doc.webhooks) {
    for (const pathItem of Object.values(doc.webhooks)) {
      transformPathItem(pathItem);
    }
  }
}

interface TrackedOperationRecord {
  readonly controller: Type<unknown>;
  readonly controllerKey: string;
  readonly methodKey: string;
  readonly operation: OpenApiOperation;
  readonly responseModels: Map<string, Type<unknown> | Function>;
}

/**
 * Generates OpenAPI 3.1 documents from Bunest applications and mounts
 * self-contained Swagger UI, JSON, and YAML endpoints on `BunestApplication`.
 */
export class SwaggerModule {
  /**
   * Loads CLI/build-time generated plugin metadata (e.g., `import("./metadata")`)
   * so `SwaggerModule.createDocument()` automatically hydrates DTO properties and
   * controller summaries/responses without runtime reflection overhead.
   */
  static async loadPluginMetadata(
    metadataFn: () => Promise<Record<string, any>>,
  ): Promise<void> {
    const loaded = await metadataFn();
    await registerLoadedPluginMetadata(loaded);
  }

  /**
   * Introspects compiled routes, parameter decorators, `@Api*` metadata,
   * `@Version()` metadata, `design:returntype`, Standard Schemas, webhooks,
   * callbacks, links, and DTO/MappedType schemas to produce an OpenAPI 3.1 document.
   */
  static createDocument(
    app: BunestApplication | INestApplication,
    config: SwaggerConfig,
    options: SwaggerDocumentOptions = {},
  ): OpenApiDocument {
    const bunApp = app as BunestApplication;
    const explorer = new SchemaExplorer({
      excludeDynamicDefaults: options.excludeDynamicDefaults,
      exampleMaxDepth: options.exampleMaxDepth,
      standardSchemaConverter: options.standardSchemaConverter,
      openApiVersion: config.openapi || "3.1.0",
    });
    const builderExtras = getDocumentBuilderExtras(config);

    if (options.extraModels) {
      for (const model of options.extraModels) {
        explorer.registerDtoSchema(model);
      }
    }

    const routes = resolveRoutesForDocument(bunApp, options);
    const versioning = bunApp.getVersioningOptions?.();
    const { rawPrefix: rawGlobalPrefix } = readAdapterGlobalPrefix(
      bunApp.getHttpAdapter(),
    );
    const globalPrefix = options.ignoreGlobalPrefix
      ? undefined
      : rawGlobalPrefix;

    const openApiVersion = config.openapi || "3.1.0";
    const supportsWebhooks = isOpenApiAtLeast(openApiVersion, 3, 1);
    const supportsOas32 = isOpenApiAtLeast(openApiVersion, 3, 2);
    const swaggerLogger = new Logger("SwaggerModule");

    const hasVersionFilter = options.version !== undefined;
    const requestedVersionSet = hasVersionFilter
      ? new Set(
          toArray(options.version)
            .map((v) => String(v).trim())
            .filter((v) => v.length > 0),
        )
      : undefined;
    const includeVersionNeutral = options.includeVersionNeutral !== false;

    const paths: Record<string, OpenApiPathItem> = {};
    const webhooks: WebhooksObject = {};
    const regularPathMethods = new Set<string>();
    const webhookPathMethods = new Set<string>();
    const slotRouteVersions = new Map<string, string>();
    const visitedControllers = new Set<Type<unknown>>();
    const visitedRouteHandlers = new Set<string>();
    const usedOperationIds = new Set<string>();
    const discoveredTagOptions = new Map<string, ApiTagOptions>();
    const trackedOperations: TrackedOperationRecord[] = [];
    const defaultGetters = new Map<
      Function,
      {
        readonly operationId: string;
        readonly parameter: string;
        readonly controllerKey: string;
        readonly methodKey: string;
      }
    >();
    const explicitLinksByModel = new Map<
      Function,
      Array<{
        readonly fromField?: string;
        readonly routeParam: string;
        readonly operationId: string;
        readonly controllerKey: string;
        readonly methodKey: string;
      }>
    >();

    const claimUniqueOperationId = (
      baseId: string,
      uriVersionTag?: string,
      preferVersionSuffix = false,
    ): string => {
      let candidate =
        preferVersionSuffix && uriVersionTag !== undefined
          ? `${baseId}_v${uriVersionTag}`
          : baseId;
      if (!usedOperationIds.has(candidate)) {
        usedOperationIds.add(candidate);
        return candidate;
      }
      if (uriVersionTag !== undefined) {
        const versioned = `${baseId}_v${uriVersionTag}`;
        if (!usedOperationIds.has(versioned)) {
          usedOperationIds.add(versioned);
          return versioned;
        }
        candidate = versioned;
      }
      let suffix = 2;
      while (usedOperationIds.has(`${candidate}_${suffix}`)) {
        suffix++;
      }
      const unique = `${candidate}_${suffix}`;
      usedOperationIds.add(unique);
      return unique;
    };

    for (let i = 0; i < routes.length; i++) {
      const route = routes[i];
      if (!route) continue;

      const controller = route.controller as Type<unknown>;

      // Check @ApiExcludeController()
      if (
        MetadataRegistry.get<boolean>(
          SWAGGER_METADATA_KEYS.API_EXCLUDE_CONTROLLER,
          controller,
        ) === true
      ) {
        continue;
      }

      const handlerFn = (
        controller.prototype as Record<string | symbol, unknown>
      )[route.handlerKey];
      if (typeof handlerFn !== "function") {
        continue;
      }

      // Check `onlyIncludeDecoratedEndpoints` + `@ApiIncludeEndpoint()`
      if (options.onlyIncludeDecoratedEndpoints) {
        const includeFlag = MetadataRegistry.get<boolean>(
          SWAGGER_METADATA_KEYS.API_INCLUDE_ENDPOINT,
          handlerFn,
        );
        if (includeFlag !== true) {
          continue;
        }
      }

      // Check @ApiExcludeEndpoint()
      if (
        MetadataRegistry.get<boolean>(
          SWAGGER_METADATA_KEYS.API_EXCLUDE_ENDPOINT,
          handlerFn,
        ) === true
      ) {
        continue;
      }

      const scannedVersions = (
        route as RouteDefinition & {
          readonly versions?: readonly (string | typeof VERSION_NEUTRAL)[];
        }
      ).versions;
      const declaredVersions = resolveRouteVersions(
        controller,
        handlerFn,
        versioning,
      );
      const routeVersions =
        scannedVersions && scannedVersions.length > 0
          ? [...scannedVersions]
          : declaredVersions;

      // Filter routes by `options.version` BEFORE touching SchemaExplorer or tags
      let activeVersions: Array<string | typeof VERSION_NEUTRAL> = routeVersions;
      if (requestedVersionSet !== undefined) {
        const effectiveTokens: Array<string | typeof VERSION_NEUTRAL> =
          routeVersions.length > 0 ? routeVersions : [VERSION_NEUTRAL];
        const matched = effectiveTokens.filter((v) =>
          v === VERSION_NEUTRAL
            ? includeVersionNeutral
            : requestedVersionSet.has(v),
        );
        if (matched.length === 0) {
          continue;
        }
        activeVersions = matched;
      }

      // Register @ApiExtraModels() from controller and handler
      const ctrlExtraModels = MetadataRegistry.getMergedClassArray<
        Type<unknown> | Function
      >(SWAGGER_METADATA_KEYS.API_EXTRA_MODELS, controller);
      const methodExtraModels =
        MetadataRegistry.get<readonly (Type<unknown> | Function)[]>(
          SWAGGER_METADATA_KEYS.API_EXTRA_MODELS,
          handlerFn,
        ) ?? [];
      for (const extraModel of [...ctrlExtraModels, ...methodExtraModels]) {
        explorer.resolveTypeSchema(extraModel, false);
      }

      // Collect rich @ApiTags({ name, parent, kind }) metadata
      const ctrlTagOpts = MetadataRegistry.getMergedClassArray<ApiTagOptions>(
        SWAGGER_METADATA_KEYS.API_TAG_OPTIONS,
        controller,
      );
      const methodTagOpts =
        MetadataRegistry.get<readonly ApiTagOptions[]>(
          SWAGGER_METADATA_KEYS.API_TAG_OPTIONS,
          handlerFn,
        ) ?? [];
      for (const tOpt of [...ctrlTagOpts, ...methodTagOpts]) {
        discoveredTagOptions.set(tOpt.name, tOpt);
      }

      const webhookMeta = MetadataRegistry.get<string | boolean>(
        SWAGGER_METADATA_KEYS.API_WEBHOOK,
        handlerFn,
      );
      const isWebhook = Boolean(webhookMeta);
      const webhookName =
        typeof webhookMeta === "string"
          ? webhookMeta
          : String(route.handlerKey);

      const hasMultipleVersions =
        declaredVersions.length > 1 || activeVersions.length > 1;

      const effectivePaths: Array<{
        readonly fullPath: string;
        readonly versionTag?: string;
      }> = [];

      if (
        !isWebhook &&
        versioning &&
        versioning.type === VersioningType.URI &&
        activeVersions.length > 0
      ) {
        const uriPrefix =
          versioning.prefix === false ? "" : (versioning.prefix ?? "v");
        const alreadyExpandedByScanner = scannedVersions !== undefined;
        if (alreadyExpandedByScanner) {
          const singleVersion = activeVersions[0];
          effectivePaths.push({
            fullPath: route.fullPath,
            versionTag:
              singleVersion !== undefined && singleVersion !== VERSION_NEUTRAL
                ? String(singleVersion)
                : undefined,
          });
        } else {
          for (const v of activeVersions) {
            effectivePaths.push({
              fullPath: applyUriVersionToPath(
                route.fullPath,
                globalPrefix,
                uriPrefix,
                v,
              ),
              versionTag: v === VERSION_NEUTRAL ? undefined : String(v),
            });
          }
        }
      } else {
        const activeConcrete = activeVersions.filter(
          (v): v is string => v !== VERSION_NEUTRAL,
        );
        const nonUriVersionTag =
          !isWebhook && versioning && activeConcrete.length > 0
            ? activeConcrete[0]
            : undefined;
        effectivePaths.push({
          fullPath: route.fullPath,
          versionTag: nonUriVersionTag,
        });
      }

      const defaultGetterMeta = MetadataRegistry.get<{
        readonly type: Type<unknown> | Function;
        readonly parameter: string;
      }>(SWAGGER_METADATA_KEYS.API_DEFAULT_GETTER, handlerFn);
      const apiLinksMeta =
        MetadataRegistry.get<readonly ApiLinkOptions[]>(
          SWAGGER_METADATA_KEYS.API_LINKS,
          handlerFn,
        ) ?? [];

      for (const target of effectivePaths) {
        const { openApiPath, pathParams } = convertPathToOpenApi(
          target.fullPath,
        );
        const buildForMethod = (effectiveMethod?: string) =>
          SwaggerModule.buildOperation(
            route,
            controller,
            handlerFn,
            pathParams,
            explorer,
            options,
            builderExtras,
            versioning,
            activeVersions,
            routeVersions,
            target.versionTag,
            hasMultipleVersions,
            effectiveMethod,
          );

        const emitAsWebhook = isWebhook && supportsWebhooks;
        const targetContainer = emitAsWebhook ? webhooks : paths;
        const containerKey = emitAsWebhook ? webhookName : openApiPath;

        const ensurePathItem = (): OpenApiPathItem => {
          if (!targetContainer[containerKey]) {
            targetContainer[containerKey] = {};
          }
          return targetContainer[containerKey]!;
        };

        const registerOpForLinks = (
          finalOp: OpenApiOperation,
          opResponseModels: Map<string, Type<unknown> | Function>,
        ): void => {
          const ctrlKey = controller.name || "Controller";
          const methodKey = String(route.handlerKey);
          trackedOperations.push({
            controller,
            controllerKey: ctrlKey,
            methodKey,
            operation: finalOp,
            responseModels: opResponseModels,
          });
          if (defaultGetterMeta && finalOp.operationId) {
            defaultGetters.set(defaultGetterMeta.type, {
              operationId: finalOp.operationId,
              parameter: defaultGetterMeta.parameter,
              controllerKey: ctrlKey,
              methodKey,
            });
          }
          if (apiLinksMeta.length > 0 && finalOp.operationId) {
            for (const linkOpt of apiLinksMeta) {
              const list = explicitLinksByModel.get(linkOpt.from) ?? [];
              list.push({
                fromField: linkOpt.fromField,
                routeParam: linkOpt.routeParam,
                operationId: finalOp.operationId,
                controllerKey: ctrlKey,
                methodKey,
              });
              explicitLinksByModel.set(linkOpt.from, list);
            }
          }
        };

        const assignOperation = (
          methodUpper: string,
          opIdSuffix?: string,
        ): void => {
          const lowerMethod = methodUpper.toLowerCase();
          const isQuery = lowerMethod === "query";
          const isStandard = STANDARD_OAS_METHODS.has(lowerMethod);

          if (isQuery && !supportsOas32) {
            return;
          }
          if (!isStandard && !isQuery && !supportsOas32) {
            return;
          }

          const { operation, responseModels } = buildForMethod(methodUpper);

          const slotKey = `${containerKey}\0${methodUpper}`;

          // Warn when single-document mode under HEADER/MEDIA_TYPE/CUSTOM versioning has
          // multiple routes with different versions colliding on the same (openApiPath, method).
          if (
            !hasVersionFilter &&
            !emitAsWebhook &&
            !isWebhook &&
            versioning &&
            versioning.type !== VersioningType.URI
          ) {
            const routeVersionSig = activeVersions
              .map((v) => (v === VERSION_NEUTRAL ? "VERSION_NEUTRAL" : v))
              .sort(compareVersionsNaturally)
              .join(",");
            const prevVersionSig = slotRouteVersions.get(slotKey);
            if (
              prevVersionSig !== undefined &&
              prevVersionSig !== routeVersionSig
            ) {
              swaggerLogger.warn(
                `Route "${methodUpper} ${openApiPath}" has multiple API versions (${prevVersionSig} vs ${routeVersionSig}) mapped to the same OpenAPI path under ${versioning.type} versioning; the later version overwrites the earlier one. Use SwaggerModule.createVersionedDocuments() or pass { version } to SwaggerModule.createDocument() to generate separate per-version documents.`,
              );
            }
            slotRouteVersions.set(slotKey, routeVersionSig);
          }

          // For OAS < 3.1, webhooks fall back to `paths` and must yield to regular routes on collision
          if (!emitAsWebhook) {
            if (isWebhook && regularPathMethods.has(slotKey)) {
              swaggerLogger.warn(
                `Webhook "${methodUpper} ${openApiPath}" shares its path and method with a route, so it is left out of the OpenAPI ${openApiVersion} document. Use OpenAPI 3.1 or later to document both.`,
              );
              return;
            }
            if (!isWebhook && webhookPathMethods.has(slotKey)) {
              swaggerLogger.warn(
                `Webhook "${methodUpper} ${openApiPath}" shares its path and method with a route, so it is left out of the OpenAPI ${openApiVersion} document. Use OpenAPI 3.1 or later to document both.`,
              );
              webhookPathMethods.delete(slotKey);
              const existingItem = targetContainer[containerKey];
              if (existingItem) {
                if (isStandard || isQuery) {
                  delete existingItem[lowerMethod as LowerHttpMethod];
                } else if (existingItem.additionalOperations) {
                  delete existingItem.additionalOperations[methodUpper];
                }
              }
            }
          }

          const pathItem = ensurePathItem();
          let baseOpId = operation.operationId;
          if (baseOpId !== undefined && opIdSuffix) {
            baseOpId = `${baseOpId}_${opIdSuffix}`;
          }

          const existingOp =
            isStandard || isQuery
              ? pathItem[lowerMethod as LowerHttpMethod]
              : pathItem.additionalOperations?.[methodUpper];

          const mergedSecurity = mergeSecurityRequirements(
            existingOp?.security,
            operation.security,
          );

          const finalOp: OpenApiOperation = {
            ...operation,
            ...(mergedSecurity !== undefined
              ? { security: mergedSecurity }
              : {}),
            ...(baseOpId !== undefined
              ? {
                  operationId: claimUniqueOperationId(
                    baseOpId,
                    target.versionTag,
                    false,
                  ),
                }
              : {}),
          };

          if (isStandard || isQuery) {
            pathItem[lowerMethod as LowerHttpMethod] = finalOp;
          } else {
            if (!pathItem.additionalOperations) {
              pathItem.additionalOperations = {};
            }
            pathItem.additionalOperations[methodUpper] = finalOp;
          }

          if (!emitAsWebhook) {
            if (isWebhook) {
              webhookPathMethods.add(slotKey);
            } else {
              regularPathMethods.add(slotKey);
            }
          }

          registerOpForLinks(finalOp, responseModels);
        };

        visitedControllers.add(controller);
        visitedRouteHandlers.add(`${controller.name}\0${String(route.handlerKey)}`);

        if (route.method === "ALL") {
          for (const m of ALL_EXPANDED_METHODS) {
            const existingItem = targetContainer[containerKey];
            if (!existingItem?.[m]) {
              assignOperation(m.toUpperCase(), m);
            }
          }
          if (supportsOas32) {
            const existingItem = targetContainer[containerKey];
            if (!existingItem?.query) {
              assignOperation("QUERY", "query");
            }
            if (!existingItem?.additionalOperations?.SEARCH) {
              assignOperation("SEARCH", "search");
            }
          }
        } else {
          assignOperation(route.method.toUpperCase());
        }
      }
    }

    // For OAS < 3.1, warn about any @ApiWebhook handler that was shadowed at scan time
    // by a regular route with the exact same method and path on the same controller.
    if (!supportsWebhooks) {
      for (const ctrl of visitedControllers) {
        const rawRoutes = MetadataRegistry.getOwn<
          readonly { path: string | readonly string[]; method: string; handlerKey: string | symbol }[]
        >(METADATA_KEYS.ROUTES, ctrl);
        if (!rawRoutes) continue;
        const ctrlMeta = MetadataRegistry.getOwn<ControllerMetadata>(
          METADATA_KEYS.CONTROLLER,
          ctrl,
        );
        const ctrlPaths = Array.isArray(ctrlMeta?.path)
          ? ctrlMeta.path
          : [ctrlMeta?.path ?? ""];
        for (const rr of rawRoutes) {
          const handlerId = `${ctrl.name}\0${String(rr.handlerKey)}`;
          if (visitedRouteHandlers.has(handlerId)) continue;
          const fn = (ctrl.prototype as Record<string | symbol, unknown>)[
            rr.handlerKey
          ];
          if (typeof fn !== "function") continue;
          const whMeta = MetadataRegistry.get<string>(
            SWAGGER_METADATA_KEYS.API_WEBHOOK,
            fn,
          );
          if (!whMeta) continue;
          const rPaths = toArray(rr.path);
          const rawGlobals = globalPrefix ? toArray(globalPrefix) : [];
          const globalPrefixList = rawGlobals.length > 0 ? rawGlobals : [""];
          for (const gp of globalPrefixList) {
            for (const cp of ctrlPaths) {
              for (const rp of rPaths) {
                const joined = normalizePath(
                  ...(gp ? [gp] : []),
                  cp,
                  rp,
                );
                const { openApiPath } = convertPathToOpenApi(joined);
                const methodUpper = rr.method.toUpperCase();
                const slotKey = `${openApiPath}\0${methodUpper}`;
                if (regularPathMethods.has(slotKey)) {
                  swaggerLogger.warn(
                    `Webhook "${methodUpper} ${openApiPath}" shares its path and method with a route, so it is left out of the OpenAPI ${openApiVersion} document. Use OpenAPI 3.1 or later to document both.`,
                  );
                }
              }
            }
          }
        }
      }
    }

    // Wire OpenAPI response `links` from `@ApiLink`, `@ApiDefaultGetter`, and `@ApiProperty({ link })`
    const linkNameFactory =
      options.linkNameFactory ??
      ((controllerKey: string, methodKey: string, fieldKey: string) =>
        controllerKey
          ? `${controllerKey}_${methodKey}_from_${fieldKey}`
          : `${methodKey}_from_${fieldKey}`);

    for (const rec of trackedOperations) {
      for (const [statusKey, modelCtor] of rec.responseModels.entries()) {
        const resp = rec.operation.responses[statusKey];
        if (!resp || resp.$ref) continue;
        const resolvedLinks: LinksObject = { ...(resp.links ?? {}) };

        // 1. Explicit `@ApiLink({ from: Model, fromField, routeParam })`
        const explicitForModel = explicitLinksByModel.get(modelCtor);
        if (explicitForModel) {
          for (const entry of explicitForModel) {
            const fieldKey = entry.fromField ?? entry.routeParam;
            const linkName = linkNameFactory(
              entry.controllerKey,
              entry.methodKey,
              fieldKey,
            );
            resolvedLinks[linkName] = {
              operationId: entry.operationId,
              parameters: {
                [entry.routeParam]: `$response.body#/${fieldKey}`,
              },
            };
          }
        }

        // 2. `@ApiProperty({ link: () => TargetModel })` -> `@ApiDefaultGetter(TargetModel, param)`
        for (const ctor of MetadataRegistry.getPrototypeChain(modelCtor)) {
          const ownProps = MetadataRegistry.getOwn<
            readonly ApiPropertyMetadata[]
          >(SWAGGER_METADATA_KEYS.API_PROPERTIES, ctor);
          if (!ownProps) continue;
          for (const prop of ownProps) {
            if (!prop.link) continue;
            const targetModel = prop.link();
            const getter = defaultGetters.get(targetModel);
            if (!getter) continue;
            const fieldKey = prop.name ?? prop.propertyKey;
            const linkName = linkNameFactory(
              getter.controllerKey,
              getter.methodKey,
              fieldKey,
            );
            resolvedLinks[linkName] = {
              operationId: getter.operationId,
              parameters: {
                [getter.parameter]: `$response.body#/${fieldKey}`,
              },
            };
          }
        }

        if (Object.keys(resolvedLinks).length > 0) {
          resp.links = resolvedLinks;
        }
      }
    }

    // Merge rich `@ApiTags({ name, parent, kind })` into document.tags
    let mergedTags: OpenApiTag[] | undefined = config.tags
      ? config.tags.map((t) => ({ ...t }))
      : undefined;
    if (discoveredTagOptions.size > 0) {
      mergedTags = mergedTags ?? [];
      for (const [name, tagOpt] of discoveredTagOptions.entries()) {
        const existing = mergedTags.find((t) => t.name === name);
        if (existing) {
          if (tagOpt.parent !== undefined && existing.parent === undefined) {
            existing.parent = tagOpt.parent;
          }
          if (tagOpt.kind !== undefined && existing.kind === undefined) {
            existing.kind = tagOpt.kind;
          }
        } else {
          mergedTags.push({
            name: tagOpt.name,
            ...(tagOpt.parent !== undefined ? { parent: tagOpt.parent } : {}),
            ...(tagOpt.kind !== undefined ? { kind: tagOpt.kind } : {}),
          });
        }
      }
    }

    const schemas = explorer.getSchemas();
    const hasSchemas = Object.keys(schemas).length > 0;
    const existingSchemes = config.components?.securitySchemes;
    const hasSecuritySchemes =
      existingSchemes !== undefined && Object.keys(existingSchemes).length > 0;

    // Copy any root vendor extensions (`x-*`) from DocumentBuilder config
    const rootExtensions: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(config)) {
      if (k.startsWith("x-")) {
        rootExtensions[k] = v;
      }
    }

    const document: OpenApiDocument = {
      openapi: config.openapi || "3.1.0",
      info: { ...config.info },
      ...(config.servers ? { servers: config.servers } : {}),
      ...(mergedTags && mergedTags.length > 0 ? { tags: mergedTags } : {}),
      ...(config.externalDocs ? { externalDocs: config.externalDocs } : {}),
      ...(config.security ? { security: config.security } : {}),
      paths,
      ...(Object.keys(webhooks).length > 0 ? { webhooks } : {}),
      ...rootExtensions,
    };

    if (hasSchemas || hasSecuritySchemes || config.components) {
      document.components = {
        ...config.components,
        ...(hasSchemas
          ? { schemas: { ...(config.components?.schemas ?? {}), ...schemas } }
          : {}),
        ...(hasSecuritySchemes
          ? { securitySchemes: { ...existingSchemes } }
          : {}),
      };
    }

    if (options.excludeDynamicDefaults) {
      transformDocumentSchemas(document, (s) =>
        stripDynamicDefaultsFromSchema(s),
      );
    }

    if (supportsWebhooks) {
      transformDocumentSchemas(document, (s) => convertSchemaToOas31(s));
    }

    return document;
  }

  /**
   * Discovers all concrete API versions declared across the application's routes,
   * controllers, and `versioning.defaultVersion` (excluding `VERSION_NEUTRAL`),
   * returned in natural ascending order (e.g. `["1", "2", "10"]`).
   */
  static discoverApiVersions(
    app: BunestApplication | INestApplication,
  ): string[] {
    const bunApp = app as BunestApplication;
    const versioning = bunApp.getVersioningOptions?.();
    const found = new Set<string>();

    const addVersionTokens = (
      tokens: readonly (string | typeof VERSION_NEUTRAL)[] | undefined,
    ): void => {
      if (!tokens) return;
      for (const token of tokens) {
        if (typeof token === "string") {
          const trimmed = token.trim();
          if (trimmed.length > 0) {
            found.add(trimmed);
          }
        }
      }
    };

    if (versioning?.defaultVersion !== undefined) {
      addVersionTokens(normalizeVersionList(versioning.defaultVersion));
    }

    const routes = resolveRoutesForDocument(bunApp, {});
    for (const route of routes) {
      if (!route) continue;
      const controller = route.controller as Type<unknown>;
      if (
        MetadataRegistry.get<boolean>(
          SWAGGER_METADATA_KEYS.API_EXCLUDE_CONTROLLER,
          controller,
        ) === true
      ) {
        continue;
      }

      const handlerFn = (
        controller.prototype as Record<string | symbol, unknown>
      )[route.handlerKey];
      if (typeof handlerFn !== "function") {
        continue;
      }
      if (
        MetadataRegistry.get<boolean>(
          SWAGGER_METADATA_KEYS.API_EXCLUDE_ENDPOINT,
          handlerFn,
        ) === true
      ) {
        continue;
      }

      const scannedVersions = (
        route as RouteDefinition & {
          readonly versions?: readonly (string | typeof VERSION_NEUTRAL)[];
        }
      ).versions;
      if (scannedVersions && scannedVersions.length > 0) {
        addVersionTokens(scannedVersions);
      }

      if (versioning) {
        addVersionTokens(
          resolveRouteVersions(controller, handlerFn, versioning),
        );
      } else {
        addVersionTokens(
          normalizeVersionList(
            MetadataRegistry.get<VersionValue>(
              METADATA_KEYS.VERSION,
              handlerFn,
            ),
          ),
        );
        addVersionTokens(
          normalizeVersionList(
            MetadataRegistry.get<VersionValue>(
              METADATA_KEYS.VERSION,
              controller,
            ),
          ),
        );
        const ctrlMeta = MetadataRegistry.get<ControllerMetadata>(
          METADATA_KEYS.CONTROLLER,
          controller,
        );
        addVersionTokens(normalizeVersionList(ctrlMeta?.version));
      }
    }

    return [...found].sort(compareVersionsNaturally);
  }

  /**
   * Generates a map of per-version OpenAPI documents (one per discovered or explicitly
   * listed API version), setting each document's `info.version` via `infoVersionResolver`
   * (defaulting to the version string itself) while preserving all other `config.info` fields.
   */
  static createVersionedDocuments(
    app: BunestApplication | INestApplication,
    config: SwaggerConfig,
    options?: SwaggerVersionedDocumentOptions,
  ): Record<string, OpenApiDocument> {
    const {
      versions: explicitVersions,
      infoVersionResolver,
      versionLabel: _versionLabel,
      ...docOptions
    } = options ?? {};

    const targetVersions =
      explicitVersions !== undefined
        ? [...explicitVersions]
        : SwaggerModule.discoverApiVersions(app);

    const documents: Record<string, OpenApiDocument> = {};
    for (const version of targetVersions) {
      const doc = SwaggerModule.createDocument(app, config, {
        ...docOptions,
        version,
      });
      doc.info = {
        ...doc.info,
        version: infoVersionResolver ? infoVersionResolver(version) : version,
      };
      documents[version] = doc;
    }

    return documents;
  }

  protected static serveStatic(
    _finalPath: string,
    _app: INestApplication,
    _customStaticPath?: string,
  ): void {
    // Bunest renders a zero-CDN self-contained UI; custom static mounts are optional no-ops by default.
  }

  protected static serveDocuments(
    finalPath: string,
    urlLastSubdirectory: string,
    httpAdapter: HttpServer,
    documentOrFactory: OpenAPIObject | (() => OpenAPIObject),
    options: {
      ui: boolean;
      raw: boolean | Array<"json" | "yaml">;
      jsonDocumentUrl: string;
      yamlDocumentUrl: string;
      swaggerOptions: SwaggerCustomOptions;
    },
  ): void {
    const getBuiltDocument = () =>
      typeof documentOrFactory === "function"
        ? documentOrFactory()
        : documentOrFactory;

    if (options.ui) {
      SwaggerModule.serveSwaggerUi(
        finalPath,
        urlLastSubdirectory,
        httpAdapter,
        getBuiltDocument,
        options.swaggerOptions,
      );
    }

    const serveJson =
      options.raw === true ||
      (Array.isArray(options.raw) && options.raw.includes("json"));
    const serveYaml =
      options.raw === true ||
      (Array.isArray(options.raw) && options.raw.includes("yaml"));

    if (serveJson || serveYaml) {
      SwaggerModule.serveDefinitions(
        httpAdapter,
        getBuiltDocument,
        {
          jsonDocumentUrl: options.jsonDocumentUrl,
          yamlDocumentUrl: options.yamlDocumentUrl,
          swaggerOptions: options.swaggerOptions,
        },
        { serveJson, serveYaml },
      );
    }
  }

  protected static serveSwaggerUi(
    _finalPath: string,
    _urlLastSubdirectory: string,
    _httpAdapter: HttpServer,
    _getBuiltDocument: () => OpenAPIObject,
    _swaggerOptions: SwaggerCustomOptions,
  ): void {
    // Subclassable hook matching `@nestjs/swagger`; Bunest mounts routes via `SwaggerModule.setup`.
  }

  protected static serveDefinitions(
    _httpAdapter: HttpServer,
    _getBuiltDocument: () => OpenAPIObject,
    _options: {
      jsonDocumentUrl: string;
      yamlDocumentUrl: string;
      swaggerOptions: SwaggerCustomOptions;
    },
    _serveOptions: {
      serveJson: boolean;
      serveYaml: boolean;
    },
  ): void {
    // Subclassable hook matching `@nestjs/swagger`; Bunest mounts JSON/YAML routes via `SwaggerModule.setup`.
  }

  /**
   * Mounts Swagger API Explorer HTML at `<path>`, raw OpenAPI JSON at `<path>-json`
   * (or `options.jsonDocumentUrl`), and raw OpenAPI YAML at `<path>-yaml`
   * (or `options.yamlDocumentUrl`) on the given `BunestApplication`.
   */
  static setup(
    path: string,
    app: BunestApplication | INestApplication,
    documentOrFactory:
      | OpenApiDocument
      | (() => OpenApiDocument)
      | SwaggerVersionedDocuments,
    options: SwaggerSetupOptions = {},
  ): void {
    const bunApp = app as BunestApplication;
    const docsPath = normalizePath(path);
    const jsonPath = normalizePath(
      options.jsonDocumentUrl ??
        (docsPath === "/" ? "/openapi-json" : `${docsPath}-json`),
    );
    const yamlPath = normalizePath(
      options.yamlDocumentUrl ??
        (docsPath === "/" ? "/openapi-yaml" : `${docsPath}-yaml`),
    );

    const serveUi = options.swaggerUiEnabled !== false && options.ui !== false;
    const rawOption = options.raw ?? true;
    const serveJson =
      rawOption === true ||
      (Array.isArray(rawOption) && rawOption.includes("json"));
    const serveYaml =
      rawOption === true ||
      (Array.isArray(rawOption) && rawOption.includes("yaml"));

    const adapter = bunApp.getHttpAdapter();
    const registry = getOrInstallAdapterRegistry(bunApp, adapter);

    const resolveEffectiveUrl = (rawPath: string): string => {
      if (options.useGlobalPrefix === true) {
        const { prefix } = readAdapterGlobalPrefix(adapter);
        if (prefix) {
          return normalizePath(prefix, rawPath);
        }
      }
      return rawPath;
    };

    const isMultiVersion =
      typeof documentOrFactory !== "function" &&
      isVersionedDocuments(documentOrFactory);

    const versionEntries: Array<[string, OpenApiDocument]> = isMultiVersion
      ? extractVersionedEntries(documentOrFactory)
      : [];

    const emptyFallbackDoc: OpenApiDocument = {
      openapi: "3.1.0",
      info: { title: "API", version: "1.0.0" },
      paths: {},
    };

    let defaultVersionKey: string | undefined;
    let resolvedDefaultDoc: OpenApiDocument | (() => OpenApiDocument);
    if (isMultiVersion) {
      const requestedDefault = options.defaultVersion;
      const matchedDefault =
        requestedDefault !== undefined
          ? (versionEntries.find(([k]) => k === requestedDefault) ??
            versionEntries.find(
              ([k]) => formatVersionSegment(k) === requestedDefault,
            ))
          : undefined;
      const selectedEntry =
        matchedDefault ?? versionEntries[versionEntries.length - 1];
      defaultVersionKey = selectedEntry?.[0];
      resolvedDefaultDoc = selectedEntry?.[1] ?? emptyFallbackDoc;
    } else {
      resolvedDefaultDoc = documentOrFactory;
    }

    const resolveEffectiveOptions = (): SwaggerSetupOptions => {
      if (!isMultiVersion || versionEntries.length === 0) {
        return options;
      }
      const basePrefix = docsPath === "/" ? "" : docsPath;
      const generatedUrls = versionEntries.map(([v]) => {
        const segment = formatVersionSegment(v);
        const vJson = normalizePath(`${basePrefix}/${segment}-json`);
        const vYaml = normalizePath(`${basePrefix}/${segment}-yaml`);
        return {
          name: segment,
          url: resolveEffectiveUrl(vJson),
          ...(serveYaml ? { yamlUrl: resolveEffectiveUrl(vYaml) } : {}),
          version: v,
        };
      });
      return {
        ...options,
        urls: options.urls ?? generatedUrls,
        defaultVersion: options.defaultVersion ?? defaultVersionKey,
      };
    };

    const isDynamic =
      typeof resolvedDefaultDoc === "function" ||
      typeof options.patchDocumentOnRequest === "function";

    const resolveDocument = async (
      req: Request,
      res: ResponseContext,
    ): Promise<OpenApiDocument> => {
      const baseDoc =
        typeof resolvedDefaultDoc === "function"
          ? resolvedDefaultDoc()
          : resolvedDefaultDoc;
      if (options.patchDocumentOnRequest) {
        return await options.patchDocumentOnRequest(req, res, baseDoc);
      }
      return baseDoc;
    };

    const staticDoc =
      typeof resolvedDefaultDoc === "function" ? undefined : resolvedDefaultDoc;
    const cachedJsonBody =
      !isDynamic && staticDoc ? JSON.stringify(staticDoc, null, 2) : undefined;
    const cachedYamlBody =
      !isDynamic && staticDoc ? serializeToYaml(staticDoc) : undefined;
    let cachedJsonUrl = resolveEffectiveUrl(jsonPath);
    let cachedYamlUrl = serveYaml ? resolveEffectiveUrl(yamlPath) : undefined;
    let cachedHtml =
      !isDynamic && staticDoc && serveUi
        ? renderSwaggerHtml(
            staticDoc,
            cachedJsonUrl,
            resolveEffectiveOptions(),
            cachedYamlUrl,
          )
        : undefined;

    @ApiExcludeController()
    @Version(VERSION_NEUTRAL)
    @Controller({ version: VERSION_NEUTRAL })
    class SwaggerUiController {
      async serveUi(
        @Req() req: Request,
        @Res() res: ResponseContext,
      ): Promise<Response> {
        const currentJsonUrl = resolveEffectiveUrl(jsonPath);
        const currentYamlUrl = serveYaml
          ? resolveEffectiveUrl(yamlPath)
          : undefined;

        if (!isDynamic && staticDoc) {
          if (
            cachedHtml === undefined ||
            currentJsonUrl !== cachedJsonUrl ||
            currentYamlUrl !== cachedYamlUrl
          ) {
            cachedJsonUrl = currentJsonUrl;
            cachedYamlUrl = currentYamlUrl;
            cachedHtml = renderSwaggerHtml(
              staticDoc,
              cachedJsonUrl,
              resolveEffectiveOptions(),
              cachedYamlUrl,
            );
          }
          return new Response(cachedHtml, {
            status: 200,
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "X-Content-Type-Options": "nosniff",
            },
          });
        }

        const doc = await resolveDocument(req, res);
        const html = renderSwaggerHtml(
          doc,
          currentJsonUrl,
          resolveEffectiveOptions(),
          currentYamlUrl,
        );
        return new Response(html, {
          status: 200,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }

      async serveJson(
        @Req() req: Request,
        @Res() res: ResponseContext,
      ): Promise<Response> {
        const body =
          cachedJsonBody !== undefined
            ? cachedJsonBody
            : JSON.stringify(await resolveDocument(req, res), null, 2);
        return new Response(body, {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }

      async serveYaml(
        @Req() req: Request,
        @Res() res: ResponseContext,
      ): Promise<Response> {
        const body =
          cachedYamlBody !== undefined
            ? cachedYamlBody
            : serializeToYaml(await resolveDocument(req, res));
        return new Response(body, {
          status: 200,
          headers: {
            "Content-Type": "text/yaml; charset=utf-8",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }
    }

    // Conditionally apply `@Get(...)` only for enabled endpoints so disabled routes return 404
    const indexHtmlPath =
      docsPath === "/" ? "/index.html" : `${docsPath}/index.html`;
    if (serveUi) {
      const desc = Object.getOwnPropertyDescriptor(
        SwaggerUiController.prototype,
        "serveUi",
      )!;
      Get([docsPath, indexHtmlPath])(
        SwaggerUiController.prototype,
        "serveUi",
        desc,
      );
    }
    if (serveJson) {
      const desc = Object.getOwnPropertyDescriptor(
        SwaggerUiController.prototype,
        "serveJson",
      )!;
      Get(jsonPath)(SwaggerUiController.prototype, "serveJson", desc);
    }
    if (serveYaml) {
      const desc = Object.getOwnPropertyDescriptor(
        SwaggerUiController.prototype,
        "serveYaml",
      )!;
      Get(yamlPath)(SwaggerUiController.prototype, "serveYaml", desc);
    }

    // Register per-version `<docsPath>/<segment>-json` and `<docsPath>/<segment>-yaml` endpoints
    const perVersionExcludedPaths: string[] = [];
    if (isMultiVersion && (serveJson || serveYaml)) {
      const basePrefix = docsPath === "/" ? "" : docsPath;
      for (let idx = 0; idx < versionEntries.length; idx++) {
        const [vKey, vDoc] = versionEntries[idx]!;
        const segment = formatVersionSegment(vKey);
        const vJsonPath = normalizePath(`${basePrefix}/${segment}-json`);
        const vYamlPath = normalizePath(`${basePrefix}/${segment}-yaml`);
        const cachedVJson = !options.patchDocumentOnRequest
          ? JSON.stringify(vDoc, null, 2)
          : undefined;
        const cachedVYaml = !options.patchDocumentOnRequest
          ? serializeToYaml(vDoc)
          : undefined;

        if (serveJson) {
          const methodName = `serveVersionJson_${idx}`;
          const handler = async function (
            req: Request,
            res: ResponseContext,
          ): Promise<Response> {
            const body =
              cachedVJson !== undefined
                ? cachedVJson
                : JSON.stringify(
                    await options.patchDocumentOnRequest!(req, res, vDoc),
                    null,
                    2,
                  );
            return new Response(body, {
              status: 200,
              headers: {
                "Content-Type": "application/json; charset=utf-8",
                "X-Content-Type-Options": "nosniff",
              },
            });
          };
          Object.defineProperty(SwaggerUiController.prototype, methodName, {
            value: handler,
            writable: true,
            configurable: true,
          });
          Req()(SwaggerUiController.prototype, methodName, 0);
          Res()(SwaggerUiController.prototype, methodName, 1);
          const desc = Object.getOwnPropertyDescriptor(
            SwaggerUiController.prototype,
            methodName,
          )!;
          Get(vJsonPath)(SwaggerUiController.prototype, methodName, desc);
          perVersionExcludedPaths.push(vJsonPath);
        }

        if (serveYaml) {
          const methodName = `serveVersionYaml_${idx}`;
          const handler = async function (
            req: Request,
            res: ResponseContext,
          ): Promise<Response> {
            const body =
              cachedVYaml !== undefined
                ? cachedVYaml
                : serializeToYaml(
                    await options.patchDocumentOnRequest!(req, res, vDoc),
                  );
            return new Response(body, {
              status: 200,
              headers: {
                "Content-Type": "text/yaml; charset=utf-8",
                "X-Content-Type-Options": "nosniff",
              },
            });
          };
          Object.defineProperty(SwaggerUiController.prototype, methodName, {
            value: handler,
            writable: true,
            configurable: true,
          });
          Req()(SwaggerUiController.prototype, methodName, 0);
          Res()(SwaggerUiController.prototype, methodName, 1);
          const desc = Object.getOwnPropertyDescriptor(
            SwaggerUiController.prototype,
            methodName,
          )!;
          Get(vYamlPath)(SwaggerUiController.prototype, methodName, desc);
          perVersionExcludedPaths.push(vYamlPath);
        }
      }
    }

    // If useGlobalPrefix !== true, exclude Swagger paths from any current or future global prefix
    if (options.useGlobalPrefix !== true) {
      if (serveUi) {
        registry.excludedPaths.add(docsPath);
        registry.excludedPaths.add(indexHtmlPath);
      }
      if (serveJson) registry.excludedPaths.add(jsonPath);
      if (serveYaml) registry.excludedPaths.add(yamlPath);
      for (const p of perVersionExcludedPaths) {
        registry.excludedPaths.add(p);
      }
      const { rawPrefix, options: prefixOptions } =
        readAdapterGlobalPrefix(adapter);
      const hasPrefix =
        typeof rawPrefix === "string"
          ? rawPrefix.length > 0
          : Array.isArray(rawPrefix) && rawPrefix.length > 0;
      if (hasPrefix && rawPrefix !== undefined) {
        registry.originalSetGlobalPrefix(
          rawPrefix,
          mergeExcludedGlobalPrefixOptions(
            prefixOptions,
            registry.excludedPaths,
          ),
        );
      }
    }

    const uiControllerInstance = new SwaggerUiController();
    registry.controllers.push(SwaggerUiController);
    registry.instances.set(SwaggerUiController, uiControllerInstance);
    registry.dirty = true;

    // Serve Swagger UI on trailing-slash `<docsPath>/` (and with query strings)
    // even when the app's router has ignoreTrailingSlash = false.
    if (serveUi && docsPath !== "/") {
      adapter.get(async (req, res, next) => {
        const pathname = new URL(req.url).pathname;
        const effectiveDocs = resolveEffectiveUrl(docsPath);
        if (effectiveDocs !== "/" && pathname === `${effectiveDocs}/`) {
          return uiControllerInstance.serveUi(req, res);
        }
        next?.();
      });
    }

    // Mark BunestApplication routes dirty so next fetch() / init() / listen() recompiles cleanly
    bunApp.useGlobalPipes();
  }

  private static buildOperation(
    route: RouteDefinition,
    controller: Type<unknown>,
    handlerFn: Function,
    urlPathParams: ConvertedPathInfo["pathParams"],
    explorer: SchemaExplorer,
    options: SwaggerDocumentOptions,
    builderExtras?: DocumentBuilderExtras,
    versioning?: VersioningOptions,
    versions: readonly (string | typeof VERSION_NEUTRAL)[] = [],
    routeVersions: readonly (string | typeof VERSION_NEUTRAL)[] = versions,
    versionTag?: string,
    hasMultipleVersions = false,
    effectiveMethod?: string,
  ): {
    operation: OpenApiOperation;
    responseModels: Map<string, Type<unknown> | Function>;
  } {
    const pluginAction = getPluginControllerActionMetadata(
      controller,
      String(route.handlerKey),
    );

    // Operation metadata
    const opMeta = MetadataRegistry.get<ApiOperationOptions>(
      SWAGGER_METADATA_KEYS.API_OPERATION,
      handlerFn,
    );

    // Tags (method + controller inheritance chain + opMeta.tags, deduplicated, optional autoTagControllers)
    const ctrlTags = MetadataRegistry.getMergedClassArray<string>(
      SWAGGER_METADATA_KEYS.API_TAGS,
      controller,
    );
    const methodTags =
      MetadataRegistry.get<readonly string[]>(
        SWAGGER_METADATA_KEYS.API_TAGS,
        handlerFn,
      ) ?? [];
    const opMetaTags = opMeta?.tags ?? [];
    const combinedTags = unique([...ctrlTags, ...methodTags, ...opMetaTags]);
    const autoTag = options.autoTagControllers !== false;
    let tags: string[] | undefined;
    if (combinedTags.length > 0) {
      tags = combinedTags;
    } else if (autoTag) {
      tags = [defaultTagForController(controller)];
    }

    const controllerName = controller.name || "Controller";
    const handlerName = String(route.handlerKey);
    const baseOperationId =
      opMeta?.operationId ??
      (options.operationIdFactory
        ? options.operationIdFactory(controllerName, handlerName, versionTag)
        : `${controllerName}_${handlerName}`);
    const operationId =
      !options.operationIdFactory &&
      versioning?.type === VersioningType.URI &&
      versionTag !== undefined &&
      (hasMultipleVersions || versions.length > 1)
        ? `${baseOperationId}_v${versionTag}`
        : baseOperationId;

    // Security requirements (controller + method + opMeta.security; @Public() overrides global/controller security)
    const ctrlSecurity =
      MetadataRegistry.getMergedClassArray<OpenApiSecurityRequirement>(
        SWAGGER_METADATA_KEYS.API_SECURITY,
        controller,
      );
    const methodSecurity =
      MetadataRegistry.get<readonly OpenApiSecurityRequirement[]>(
        SWAGGER_METADATA_KEYS.API_SECURITY,
        handlerFn,
      ) ?? [];
    const methodAuthNextPublic = MetadataRegistry.get<boolean>(
      AUTH_NEXT_PUBLIC_KEY,
      handlerFn,
    );
    const ctrlAuthNextPublic = MetadataRegistry.get<boolean>(
      AUTH_NEXT_PUBLIC_KEY,
      controller,
    );
    const isAuthNextPublic =
      methodAuthNextPublic !== undefined
        ? methodAuthNextPublic === true
        : ctrlAuthNextPublic === true;
    const isLegacyPublic =
      MetadataRegistry.get<boolean>(SECURITY_IS_PUBLIC_KEY, handlerFn) ===
        true ||
      MetadataRegistry.get<boolean>(SECURITY_IS_PUBLIC_KEY, controller) ===
        true;
    const isPublicRoute =
      methodAuthNextPublic === false
        ? false
        : isAuthNextPublic || isLegacyPublic;

    let operationSecurity: OpenApiSecurityRequirement[] | undefined;
    if (
      isPublicRoute &&
      methodSecurity.length === 0 &&
      opMeta?.security === undefined
    ) {
      operationSecurity = [];
    } else {
      const combinedSecurity = [
        ...ctrlSecurity,
        ...methodSecurity,
        ...(opMeta?.security ?? []),
      ];
      if (combinedSecurity.length > 0) {
        operationSecurity = combinedSecurity;
      }
    }

    // Parameters (globalParameters + URL path + param decorators + @ApiParam/@ApiQuery/@ApiHeader + opMeta.parameters)
    const parameters: OpenApiParameter[] = SwaggerModule.buildParameters(
      route.parameters,
      urlPathParams,
      controller,
      handlerFn,
      explorer,
      builderExtras?.globalParameters,
    );

    if (opMeta?.parameters && opMeta.parameters.length > 0) {
      parameters.push(...opMeta.parameters);
    }

    const concreteVersions = versions.filter(
      (v): v is string => v !== VERSION_NEUTRAL,
    );
    const isVersionOptional =
      routeVersions.includes(VERSION_NEUTRAL) ||
      defaultVersionMatchesRoute(versioning, concreteVersions);

    if (
      versioning &&
      versioning.type === VersioningType.HEADER &&
      concreteVersions.length > 0 &&
      !parameters.some(
        (p) =>
          p.in === "header" &&
          p.name.toLowerCase() === versioning.header.toLowerCase(),
      )
    ) {
      parameters.push({
        name: versioning.header,
        in: "header",
        required: !isVersionOptional,
        description: "API version header",
        schema: {
          type: "string",
          enum: concreteVersions,
          ...(concreteVersions.length === 1
            ? { default: concreteVersions[0] }
            : {}),
        },
      });
    } else if (
      versioning &&
      versioning.type === VersioningType.MEDIA_TYPE &&
      concreteVersions.length > 0 &&
      !parameters.some(
        (p) => p.in === "header" && p.name.toLowerCase() === "accept",
      )
    ) {
      const normalizedKey = versioning.key.endsWith("=")
        ? versioning.key
        : `${versioning.key}=`;
      const examples = concreteVersions.map(
        (v) => `application/json;${normalizedKey}${v}`,
      );
      parameters.push({
        name: "Accept",
        in: "header",
        required: !isVersionOptional,
        description: `API version media type parameter (${normalizedKey}<version>)`,
        schema: {
          type: "string",
          enum: examples,
          ...(examples.length === 1 ? { default: examples[0] } : {}),
        },
      });
    } else if (
      versioning &&
      versioning.type === VersioningType.CUSTOM &&
      options.customVersionParameter !== undefined &&
      concreteVersions.length > 0 &&
      !parameters.some(
        (p) =>
          p.in === options.customVersionParameter!.in &&
          p.name.toLowerCase() ===
            options.customVersionParameter!.name.toLowerCase(),
      )
    ) {
      const customParam = options.customVersionParameter;
      parameters.push({
        name: customParam.name,
        in: customParam.in,
        required: customParam.required ?? !isVersionOptional,
        description: customParam.description ?? "API version parameter",
        schema: {
          type: "string",
          enum: concreteVersions,
          ...(concreteVersions.length === 1
            ? { default: concreteVersions[0] }
            : {}),
        },
      });
    }

    // Request Body (respects @ApiConsumes() and opMeta.requestBody)
    const requestBody =
      opMeta?.requestBody ??
      SwaggerModule.buildRequestBody(
        route.parameters,
        controller,
        handlerFn,
        explorer,
      );

    // Responses (respects @ApiProduces(), globalResponses, plugin action, opMeta.responses)
    const { responses, responseModels } = SwaggerModule.buildResponses(
      route,
      controller,
      handlerFn,
      explorer,
      builderExtras?.globalResponses,
      pluginAction,
      opMeta?.responses,
      effectiveMethod,
    );

    // Callbacks (@ApiCallbacks + opMeta.callbacks)
    const callbacks = SwaggerModule.buildCallbacks(
      controller,
      handlerFn,
      explorer,
      opMeta?.callbacks,
    );

    // Vendor extensions (@ApiExtension)
    const ctrlExtensions = MetadataRegistry.getMergedClassArray<{
      readonly key: string;
      readonly value: unknown;
    }>(SWAGGER_METADATA_KEYS.API_EXTENSIONS, controller);
    const methodExtensions =
      MetadataRegistry.get<
        readonly { readonly key: string; readonly value: unknown }[]
      >(SWAGGER_METADATA_KEYS.API_EXTENSIONS, handlerFn) ?? [];

    const summary = opMeta?.summary ?? pluginAction?.summary;
    const description = opMeta?.description ?? pluginAction?.description;

    const operation: OpenApiOperation & Record<string, unknown> = {
      ...(tags !== undefined ? { tags } : {}),
      operationId,
      ...(summary !== undefined ? { summary } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(opMeta?.deprecated !== undefined
        ? { deprecated: opMeta.deprecated }
        : {}),
      ...(opMeta?.externalDocs !== undefined
        ? { externalDocs: opMeta.externalDocs }
        : {}),
      ...(opMeta?.servers !== undefined ? { servers: opMeta.servers } : {}),
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(requestBody !== undefined ? { requestBody } : {}),
      responses,
      ...(callbacks !== undefined ? { callbacks } : {}),
      ...(operationSecurity !== undefined
        ? { security: operationSecurity }
        : {}),
    };

    for (const ext of [...ctrlExtensions, ...methodExtensions]) {
      operation[ext.key] = ext.value;
    }

    return { operation, responseModels };
  }

  private static buildCallbacks(
    controller: Type<unknown>,
    handlerFn: Function,
    explorer: SchemaExplorer,
    opCallbacks?: CallbacksObject,
  ): CallbacksObject | undefined {
    const ctrlCallbacks = MetadataRegistry.getMergedClassArray<
      CallBackObject<any>
    >(SWAGGER_METADATA_KEYS.API_CALLBACKS, controller);
    const methodCallbacks =
      MetadataRegistry.get<readonly CallBackObject<any>[]>(
        SWAGGER_METADATA_KEYS.API_CALLBACKS,
        handlerFn,
      ) ?? [];

    const combined = [...ctrlCallbacks, ...methodCallbacks];
    if (combined.length === 0 && !opCallbacks) {
      return undefined;
    }

    const result: CallbacksObject = { ...(opCallbacks ?? {}) };
    for (const cb of combined) {
      const methodKey = cb.method.toLowerCase() as LowerHttpMethod;
      const bodySchema =
        cb.requestBody?.type !== undefined
          ? explorer.resolveTypeSchema(cb.requestBody.type, false)
          : { type: "object" as const };
      const statusKey = String(cb.expectedResponse?.status ?? 200);
      const callbackItem: CallbackObject = {
        [cb.callbackUrl]: {
          [methodKey]: {
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: bodySchema,
                },
              },
            },
            responses: {
              [statusKey]: {
                description: cb.expectedResponse?.description ?? "",
              },
            },
          },
        },
      };
      result[cb.name] = callbackItem;
    }

    return Object.keys(result).length > 0 ? result : undefined;
  }

  private static buildParameters(
    routeParams: readonly ParameterMetadata[],
    urlPathParams: ConvertedPathInfo["pathParams"],
    controller: Type<unknown>,
    handlerFn: Function,
    explorer: SchemaExplorer,
    globalParameters?: ReadonlyArray<
      Omit<ParameterObject, "example" | "examples">
    >,
  ): OpenApiParameter[] {
    const paramMap = new Map<string, OpenApiParameter>();
    const put = (param: OpenApiParameter) => {
      paramMap.set(`${param.in}:${param.name}`, param);
    };

    // 0. Seed DocumentBuilder global parameters (lowest precedence)
    if (globalParameters) {
      for (const gp of globalParameters) {
        put({ ...gp });
      }
    }

    // 1. Seed path parameters from URL template
    for (let i = 0; i < urlPathParams.length; i++) {
      const pp = urlPathParams[i]!;
      const schema: OpenApiSchema = { type: "string" };
      if (pp.pattern) {
        schema.pattern = pp.pattern;
      }
      put({
        name: pp.name,
        in: "path",
        required: !pp.optional,
        schema,
      });
    }

    // 2. Inspect @Param(), @Query(), @Headers() parameter decorators
    const standardSchemaParamKeys = new Set<string>();
    for (let i = 0; i < routeParams.length; i++) {
      const rp = routeParams[i];
      if (!rp) continue;

      const rawParamSchema = (rp as ParameterMetadata & { schema?: unknown })
        .schema;

      if (rp.source === "param") {
        if (rp.key) {
          const existing = paramMap.get(`path:${rp.key}`);
          const stdSchema =
            rawParamSchema !== undefined
              ? explorer.resolveStandardSchema(rawParamSchema, "input")
              : undefined;
          if (stdSchema) {
            standardSchemaParamKeys.add(`path:${rp.key}`);
          }
          const schema =
            stdSchema ??
            (rp.metatype !== undefined
              ? explorer.resolveTypeSchema(rp.metatype, false)
              : (existing?.schema ?? { type: "string" }));
          const existingSchemaObj =
            existing?.schema && !("$ref" in existing.schema)
              ? existing.schema
              : undefined;
          const promotedDesc =
            stdSchema && !("$ref" in stdSchema)
              ? stdSchema.description
              : undefined;
          const description = promotedDesc ?? existing?.description;
          put({
            name: rp.key,
            in: "path",
            required: existing?.required ?? true,
            ...(description !== undefined ? { description } : {}),
            schema:
              existingSchemaObj?.pattern &&
              !("$ref" in schema) &&
              !schema.pattern
                ? { ...schema, pattern: existingSchemaObj.pattern }
                : schema,
          });
        } else if (rawParamSchema !== undefined) {
          const stdSchema = explorer.resolveStandardSchema(
            rawParamSchema,
            "input",
          );
          if (stdSchema?.properties) {
            for (const [propName, propSchema] of Object.entries(
              stdSchema.properties,
            )) {
              standardSchemaParamKeys.add(`path:${propName}`);
              const existing = paramMap.get(`path:${propName}`);
              const existingSchemaObj =
                existing?.schema && !("$ref" in existing.schema)
                  ? existing.schema
                  : undefined;
              const resolvedSchema =
                existingSchemaObj?.pattern &&
                !("$ref" in propSchema) &&
                !propSchema.pattern
                  ? { ...propSchema, pattern: existingSchemaObj.pattern }
                  : propSchema;
              const propDesc =
                propSchema && !("$ref" in propSchema)
                  ? propSchema.description
                  : undefined;
              const description = propDesc ?? existing?.description;
              put({
                name: propName,
                in: "path",
                required: existing?.required ?? true,
                ...(description !== undefined ? { description } : {}),
                schema: resolvedSchema,
              });
            }
          }
        } else if (rp.metatype && isDtoConstructor(rp.metatype)) {
          const dtoName = explorer.registerDtoSchema(rp.metatype);
          const dtoSchema = explorer.getSchemas()[dtoName];
          if (dtoSchema?.properties) {
            for (const [propName, propSchema] of Object.entries(
              dtoSchema.properties,
            )) {
              const existing = paramMap.get(`path:${propName}`);
              const existingSchemaObj =
                existing?.schema && !("$ref" in existing.schema)
                  ? existing.schema
                  : undefined;
              const resolvedSchema =
                existingSchemaObj?.pattern &&
                !("$ref" in propSchema) &&
                !propSchema.pattern
                  ? { ...propSchema, pattern: existingSchemaObj.pattern }
                  : propSchema;
              put({
                name: propName,
                in: "path",
                required: existing?.required ?? true,
                description:
                  "$ref" in propSchema ? undefined : propSchema.description,
                schema: resolvedSchema,
              });
            }
          }
        }
      } else if (rp.source === "query") {
        if (rp.key) {
          const stdSchema =
            rawParamSchema !== undefined
              ? explorer.resolveStandardSchema(rawParamSchema, "input")
              : undefined;
          if (stdSchema) {
            standardSchemaParamKeys.add(`query:${rp.key}`);
          }
          const schema =
            stdSchema ??
            (rp.metatype !== undefined
              ? explorer.resolveTypeSchema(rp.metatype, false)
              : { type: "string" as const });
          const promotedDesc =
            stdSchema && !("$ref" in stdSchema)
              ? stdSchema.description
              : undefined;
          put({
            name: rp.key,
            in: "query",
            required: false,
            ...(promotedDesc !== undefined
              ? { description: promotedDesc }
              : {}),
            schema,
          });
        } else if (rawParamSchema !== undefined) {
          const stdSchema = explorer.resolveStandardSchema(
            rawParamSchema,
            "input",
          );
          if (stdSchema?.properties) {
            const reqSet = new Set(stdSchema.required ?? []);
            for (const [propName, propSchema] of Object.entries(
              stdSchema.properties,
            )) {
              standardSchemaParamKeys.add(`query:${propName}`);
              const propDesc =
                propSchema && !("$ref" in propSchema)
                  ? propSchema.description
                  : undefined;
              put({
                name: propName,
                in: "query",
                required: reqSet.has(propName),
                ...(propDesc !== undefined ? { description: propDesc } : {}),
                schema: propSchema,
              });
            }
          }
        } else if (rp.metatype && isDtoConstructor(rp.metatype)) {
          const dtoName = explorer.registerDtoSchema(rp.metatype);
          const dtoSchema = explorer.getSchemas()[dtoName];
          if (dtoSchema?.properties) {
            const reqSet = new Set(dtoSchema.required ?? []);
            for (const [propName, propSchema] of Object.entries(
              dtoSchema.properties,
            )) {
              put({
                name: propName,
                in: "query",
                required: reqSet.has(propName),
                description:
                  "$ref" in propSchema ? undefined : propSchema.description,
                schema: propSchema,
              });
            }
          }
        }
      } else if (rp.source === "header") {
        if (rp.key) {
          const stdSchema =
            rawParamSchema !== undefined
              ? explorer.resolveStandardSchema(rawParamSchema, "input")
              : undefined;
          if (stdSchema) {
            standardSchemaParamKeys.add(`header:${rp.key}`);
          }
          const schema =
            stdSchema ??
            (rp.metatype !== undefined
              ? explorer.resolveTypeSchema(rp.metatype, false)
              : { type: "string" as const });
          const promotedDesc =
            stdSchema && !("$ref" in stdSchema)
              ? stdSchema.description
              : undefined;
          put({
            name: rp.key,
            in: "header",
            required: false,
            ...(promotedDesc !== undefined
              ? { description: promotedDesc }
              : {}),
            schema,
          });
        } else if (rawParamSchema !== undefined) {
          const stdSchema = explorer.resolveStandardSchema(
            rawParamSchema,
            "input",
          );
          if (stdSchema?.properties) {
            const reqSet = new Set(stdSchema.required ?? []);
            for (const [propName, propSchema] of Object.entries(
              stdSchema.properties,
            )) {
              standardSchemaParamKeys.add(`header:${propName}`);
              const propDesc =
                propSchema && !("$ref" in propSchema)
                  ? propSchema.description
                  : undefined;
              put({
                name: propName,
                in: "header",
                required: reqSet.has(propName),
                ...(propDesc !== undefined ? { description: propDesc } : {}),
                schema: propSchema,
              });
            }
          }
        } else if (rp.metatype && isDtoConstructor(rp.metatype)) {
          const dtoName = explorer.registerDtoSchema(rp.metatype);
          const dtoSchema = explorer.getSchemas()[dtoName];
          if (dtoSchema?.properties) {
            const reqSet = new Set(dtoSchema.required ?? []);
            for (const [propName, propSchema] of Object.entries(
              dtoSchema.properties,
            )) {
              put({
                name: propName,
                in: "header",
                required: reqSet.has(propName),
                description:
                  "$ref" in propSchema ? undefined : propSchema.description,
                schema: propSchema,
              });
            }
          }
        }
      } else if (rp.source === "cookies" || rp.source === "signedCookies") {
        if (rp.key) {
          const stdSchema =
            rawParamSchema !== undefined
              ? explorer.resolveStandardSchema(rawParamSchema, "input")
              : undefined;
          if (stdSchema) {
            standardSchemaParamKeys.add(`cookie:${rp.key}`);
          }
          const schema =
            stdSchema ??
            (rp.metatype !== undefined
              ? explorer.resolveTypeSchema(rp.metatype, false)
              : { type: "string" as const });
          const promotedDesc =
            stdSchema && !("$ref" in stdSchema)
              ? stdSchema.description
              : undefined;
          put({
            name: rp.key,
            in: "cookie",
            required: false,
            ...(promotedDesc !== undefined
              ? { description: promotedDesc }
              : {}),
            schema,
          });
        } else if (rawParamSchema !== undefined) {
          const stdSchema = explorer.resolveStandardSchema(
            rawParamSchema,
            "input",
          );
          if (stdSchema?.properties) {
            const reqSet = new Set(stdSchema.required ?? []);
            for (const [propName, propSchema] of Object.entries(
              stdSchema.properties,
            )) {
              standardSchemaParamKeys.add(`cookie:${propName}`);
              const propDesc =
                propSchema && !("$ref" in propSchema)
                  ? propSchema.description
                  : undefined;
              put({
                name: propName,
                in: "cookie",
                required: reqSet.has(propName),
                ...(propDesc !== undefined ? { description: propDesc } : {}),
                schema: propSchema,
              });
            }
          }
        } else if (rp.metatype && isDtoConstructor(rp.metatype)) {
          const dtoName = explorer.registerDtoSchema(rp.metatype);
          const dtoSchema = explorer.getSchemas()[dtoName];
          if (dtoSchema?.properties) {
            const reqSet = new Set(dtoSchema.required ?? []);
            for (const [propName, propSchema] of Object.entries(
              dtoSchema.properties,
            )) {
              put({
                name: propName,
                in: "cookie",
                required: reqSet.has(propName),
                description:
                  "$ref" in propSchema ? undefined : propSchema.description,
                schema: propSchema,
              });
            }
          }
        }
      }
    }

    // 3. Merge explicit @ApiParam(), @ApiQuery(), @ApiHeader() metadata (highest precedence)
    const ctrlParams = MetadataRegistry.getMergedClassArray<ApiParamOptions>(
      SWAGGER_METADATA_KEYS.API_PARAMS,
      controller,
    );
    const methodParams =
      MetadataRegistry.get<readonly ApiParamOptions[]>(
        SWAGGER_METADATA_KEYS.API_PARAMS,
        handlerFn,
      ) ?? [];
    for (const p of [...ctrlParams, ...methodParams]) {
      const existing = paramMap.get(`path:${p.name}`);
      let schema: OpenApiSchema;
      if (standardSchemaParamKeys.has(`path:${p.name}`) && existing?.schema) {
        schema = { ...existing.schema };
      } else if (p.schema) {
        schema = { ...p.schema };
      } else if (p.enumName && p.enum !== undefined) {
        schema = explorer.registerEnumSchema(p.enumName, p.enum, p.enumSchema);
      } else if (p.type !== undefined) {
        schema = explorer.resolveTypeSchema(p.type, false);
      } else {
        schema = { ...(existing?.schema ?? { type: "string" }) };
      }
      if (p.format) schema.format = p.format;
      if (p.enum && !p.enumName) schema.enum = normalizeEnumValues(p.enum);

      const paramObj: OpenApiParameter & Record<string, unknown> = {
        name: p.name,
        in: "path",
        required: p.required ?? existing?.required ?? true,
        ...(p.description !== undefined ? { description: p.description } : {}),
        ...(p.deprecated !== undefined ? { deprecated: p.deprecated } : {}),
        ...(p.allowEmptyValue !== undefined
          ? { allowEmptyValue: p.allowEmptyValue }
          : {}),
        ...(p.style !== undefined ? { style: p.style } : {}),
        ...(p.explode !== undefined ? { explode: p.explode } : {}),
        ...(p.allowReserved !== undefined
          ? { allowReserved: p.allowReserved }
          : {}),
        ...(p.example !== undefined ? { example: p.example } : {}),
        ...(p.examples !== undefined ? { examples: p.examples } : {}),
        ...(p.content !== undefined ? { content: p.content } : { schema }),
      };
      applyExtensions(paramObj, p.extensions);
      put(paramObj);
    }

    const ctrlQueries = MetadataRegistry.getMergedClassArray<ApiQueryOptions>(
      SWAGGER_METADATA_KEYS.API_QUERIES,
      controller,
    );
    const methodQueries =
      MetadataRegistry.get<readonly ApiQueryOptions[]>(
        SWAGGER_METADATA_KEYS.API_QUERIES,
        handlerFn,
      ) ?? [];
    for (const q of [...ctrlQueries, ...methodQueries]) {
      // Whole-DTO `@ApiQuery({ type: FilterDto })` without `name` expands DTO properties as query params
      if (!q.name && q.type !== undefined && isDtoConstructor(q.type)) {
        const dtoName = explorer.registerDtoSchema(q.type);
        const dtoSchema = explorer.getSchemas()[dtoName];
        if (dtoSchema?.properties) {
          const reqSet = new Set(dtoSchema.required ?? []);
          for (const [propName, propSchema] of Object.entries(
            dtoSchema.properties,
          )) {
            put({
              name: propName,
              in: "query",
              required: reqSet.has(propName),
              description:
                "$ref" in propSchema ? undefined : propSchema.description,
              schema: propSchema,
            });
          }
        }
        continue;
      }

      const qName = q.name ?? "query";
      const existing = paramMap.get(`query:${qName}`);
      let schema: OpenApiSchema;
      let moveExampleToSchema = false;

      if (standardSchemaParamKeys.has(`query:${qName}`) && existing?.schema) {
        schema = { ...existing.schema };
      } else if (q.schema && q.type !== undefined) {
        if (q.isArray) {
          const itemResolved = explorer.resolveTypeSchema(q.type, false);
          const itemSchema: OpenApiSchema = { ...(q.schema as OpenApiSchema) };
          if (itemResolved.$ref) {
            if (itemSchema.allOf) {
              itemSchema.allOf = [...itemSchema.allOf, { $ref: itemResolved.$ref }];
            } else if (Object.keys(itemSchema).length > 0) {
              itemSchema.allOf = [{ $ref: itemResolved.$ref }];
            } else {
              itemSchema.$ref = itemResolved.$ref;
            }
          } else {
            Object.assign(itemSchema, itemResolved);
          }
          schema = { type: "array", items: itemSchema };
        } else {
          const resolved = explorer.resolveTypeSchema(q.type, false);
          schema = { ...(q.schema as OpenApiSchema) };
          applyQuerySchemaExtras(schema, q);
          if (resolved.$ref) {
            if (schema.allOf) {
              schema.allOf = [...schema.allOf, { $ref: resolved.$ref }];
            } else if (Object.keys(schema).length > 0) {
              schema.allOf = [{ $ref: resolved.$ref }];
            } else {
              schema.$ref = resolved.$ref;
            }
          } else {
            Object.assign(schema, resolved);
          }
        }
        if (q.isArray) {
          applyQuerySchemaExtras(schema, q);
        }
      } else if (q.schema) {
        schema = { ...(q.schema as OpenApiSchema) };
        applyQuerySchemaExtras(schema, q);
      } else if (q.enumName && q.enum !== undefined) {
        const enumRef = explorer.registerEnumSchema(
          q.enumName,
          q.enum,
          q.enumSchema,
          q["x-enumNames"],
        );
        schema = q.isArray ? { type: "array", items: enumRef } : enumRef;
        applyQuerySchemaExtras(schema, q);
      } else if (q.type !== undefined) {
        schema = explorer.resolveTypeSchema(q.type, q.isArray === true);
        if (schema.$ref && (q.example !== undefined || q.allOf !== undefined)) {
          const refVal = schema.$ref;
          delete schema.$ref;
          applyQuerySchemaExtras(schema, q);
          schema.allOf = [...(schema.allOf ?? []), { $ref: refVal }];
          if (q.example !== undefined) {
            schema.example = q.example;
            moveExampleToSchema = true;
          }
        } else {
          applyQuerySchemaExtras(schema, q);
        }
      } else {
        schema = { ...(existing?.schema ?? { type: "string" }) };
        applyQuerySchemaExtras(schema, q);
      }
      if (q.enum && !q.enumName) schema.enum = normalizeEnumValues(q.enum);

      const queryDescription = q.description ?? existing?.description;
      const paramObj: OpenApiParameter & Record<string, unknown> = {
        name: qName,
        in: "query",
        required: q.required ?? true,
        ...(queryDescription !== undefined
          ? { description: queryDescription }
          : {}),
        ...(q.deprecated !== undefined ? { deprecated: q.deprecated } : {}),
        ...(q.allowEmptyValue !== undefined
          ? { allowEmptyValue: q.allowEmptyValue }
          : {}),
        ...(q.style !== undefined ? { style: q.style } : {}),
        ...(q.explode !== undefined ? { explode: q.explode } : {}),
        ...(q.allowReserved !== undefined
          ? { allowReserved: q.allowReserved }
          : {}),
        ...(q.example !== undefined && !moveExampleToSchema
          ? { example: q.example }
          : {}),
        ...(q.examples !== undefined ? { examples: q.examples } : {}),
        ...(q.content !== undefined ? { content: q.content } : { schema }),
      };
      applyExtensions(paramObj, q.extensions);
      put(paramObj);
    }

    const ctrlHeaders = MetadataRegistry.getMergedClassArray<ApiHeaderOptions>(
      SWAGGER_METADATA_KEYS.API_HEADERS,
      controller,
    );
    const methodHeaders =
      MetadataRegistry.get<readonly ApiHeaderOptions[]>(
        SWAGGER_METADATA_KEYS.API_HEADERS,
        handlerFn,
      ) ?? [];
    for (const h of [...ctrlHeaders, ...methodHeaders]) {
      const schema: OpenApiSchema = h.schema
        ? { ...(h.schema as OpenApiSchema) }
        : { type: "string" };
      if (h.enum) schema.enum = normalizeEnumValues(h.enum);
      if (h.example !== undefined && h.content === undefined) {
        schema.example = h.example;
      }

      const headerObj: OpenApiParameter & Record<string, unknown> = {
        name: h.name,
        in: "header",
        required: h.required ?? false,
        ...(h.description !== undefined ? { description: h.description } : {}),
        ...(h.deprecated !== undefined ? { deprecated: h.deprecated } : {}),
        ...(h.allowEmptyValue !== undefined
          ? { allowEmptyValue: h.allowEmptyValue }
          : {}),
        ...(h.style !== undefined ? { style: h.style } : {}),
        ...(h.explode !== undefined ? { explode: h.explode } : {}),
        ...(h.allowReserved !== undefined
          ? { allowReserved: h.allowReserved }
          : {}),
        ...(h.example !== undefined && h.content !== undefined
          ? { example: h.example }
          : {}),
        ...(h.examples !== undefined ? { examples: h.examples } : {}),
        ...(h.content !== undefined ? { content: h.content } : { schema }),
      };
      applyExtensions(headerObj, h.extensions);
      put(headerObj);
    }

    return [...paramMap.values()];
  }

  private static buildRequestBody(
    routeParams: readonly ParameterMetadata[],
    controller: Type<unknown>,
    handlerFn: Function,
    explorer: SchemaExplorer,
  ): OpenApiRequestBody | undefined {
    const apiBody = MetadataRegistry.get<ApiBodyOptions>(
      SWAGGER_METADATA_KEYS.API_BODY,
      handlerFn,
    );

    if (apiBody) {
      const contentType = apiBody.contentType ?? "application/json";
      const wholeBodyParam = routeParams.find(
        (p) => p.source === "body" && p.key === undefined,
      );
      const rawBodyParamSchema = (
        wholeBodyParam as (ParameterMetadata & { schema?: unknown }) | undefined
      )?.schema;
      const bodyParamStdSchema =
        rawBodyParamSchema !== undefined
          ? explorer.resolveStandardSchema(rawBodyParamSchema, "input")
          : undefined;

      let schema: OpenApiSchema;
      if (bodyParamStdSchema) {
        schema = bodyParamStdSchema;
      } else if (apiBody.schema) {
        schema = { ...(apiBody.schema as OpenApiSchema) };
      } else if (apiBody.type !== undefined) {
        schema = explorer.resolveTypeSchema(
          apiBody.type,
          apiBody.isArray === true,
        );
      } else if (apiBody.enum !== undefined) {
        const enumVals = normalizeEnumValues(apiBody.enum);
        const enumType =
          enumVals.length > 0 && enumVals.every((v) => typeof v === "number")
            ? "number"
            : "string";
        schema = apiBody.isArray
          ? { type: "array", items: { type: enumType, enum: enumVals } }
          : { enum: enumVals };
      } else {
        schema = { type: "object" as const };
      }
      if (
        apiBody.enum !== undefined &&
        !schema.enum &&
        schema.type !== "array"
      ) {
        schema.enum = normalizeEnumValues(apiBody.enum);
      }
      const mediaType: OpenApiMediaType = {
        schema,
        ...(apiBody.examples !== undefined
          ? { examples: apiBody.examples }
          : {}),
        ...(apiBody.encoding !== undefined
          ? { encoding: apiBody.encoding }
          : {}),
      };
      return {
        ...(apiBody.description !== undefined
          ? { description: apiBody.description }
          : {}),
        required: apiBody.required ?? true,
        content: { [contentType]: mediaType },
      };
    }

    const consumes = [
      ...MetadataRegistry.getMergedClassArray<string>(
        SWAGGER_METADATA_KEYS.API_CONSUMES,
        controller,
      ),
      ...(MetadataRegistry.get<readonly string[]>(
        SWAGGER_METADATA_KEYS.API_CONSUMES,
        handlerFn,
      ) ?? []),
    ];

    const bodyParams = routeParams.filter((p) => p.source === "body");

    // Check multipart uploads (@UploadedFile / @UploadedFiles), merging any @Body() fields/DTO properties
    const uploadParams = routeParams.filter(
      (p) => p.source === "uploadedFile" || p.source === "uploadedFiles",
    );
    if (uploadParams.length > 0) {
      const properties: Record<string, OpenApiSchema> = {};
      const requiredSet = new Set<string>();

      const wholeBody = bodyParams.find((p) => p.key === undefined);
      if (wholeBody) {
        const rawParamSchema = (
          wholeBody as ParameterMetadata & { schema?: unknown }
        ).schema;
        if (rawParamSchema !== undefined) {
          const stdSchema = explorer.resolveStandardSchema(
            rawParamSchema,
            "input",
          );
          if (stdSchema?.properties) {
            for (const [propName, propSchema] of Object.entries(
              stdSchema.properties,
            )) {
              properties[propName] = propSchema;
            }
            for (const reqField of stdSchema.required ?? []) {
              requiredSet.add(reqField);
            }
          }
        } else if (wholeBody.metatype && isDtoConstructor(wholeBody.metatype)) {
          const dtoName = explorer.registerDtoSchema(wholeBody.metatype);
          const dtoSchema = explorer.getSchemas()[dtoName];
          if (dtoSchema?.properties) {
            for (const [propName, propSchema] of Object.entries(
              dtoSchema.properties,
            )) {
              properties[propName] = propSchema;
            }
            for (const reqField of dtoSchema.required ?? []) {
              requiredSet.add(reqField);
            }
          }
        }
      }

      for (const bp of bodyParams) {
        if (!bp.key) continue;
        const rawFieldSchema = (bp as ParameterMetadata & { schema?: unknown })
          .schema;
        const stdSchema =
          rawFieldSchema !== undefined
            ? explorer.resolveStandardSchema(rawFieldSchema, "input")
            : undefined;
        properties[bp.key] =
          stdSchema ??
          (bp.metatype !== undefined
            ? explorer.resolveTypeSchema(bp.metatype, false)
            : {});
      }

      for (const up of uploadParams) {
        const fieldName = up.key ?? "file";
        properties[fieldName] =
          up.source === "uploadedFiles"
            ? { type: "array", items: { type: "string", format: "binary" } }
            : { type: "string", format: "binary" };
      }

      const multipartSchema: OpenApiSchema = {
        type: "object",
        properties,
        ...(requiredSet.size > 0 ? { required: [...requiredSet] } : {}),
      };
      const uploadMediaTypes =
        consumes.length > 0 ? [...new Set(consumes)] : ["multipart/form-data"];
      const content: Record<string, OpenApiMediaType> = {};
      for (const mt of uploadMediaTypes) {
        content[mt] = { schema: multipartSchema };
      }
      return {
        required: true,
        content,
      };
    }

    // Check @RawBody() / @RawBody(schema) when no @Body() is present
    if (bodyParams.length === 0) {
      const rawBodyParam = routeParams.find((p) => p.source === "rawBody");
      if (!rawBodyParam) {
        return undefined;
      }
      const rawParamSchema = (
        rawBodyParam as ParameterMetadata & { schema?: unknown }
      ).schema;
      const stdSchema =
        rawParamSchema !== undefined
          ? explorer.resolveStandardSchema(rawParamSchema, "input")
          : undefined;
      const schema: OpenApiSchema = stdSchema ?? {
        type: "string",
        format: "binary",
      };
      const rawMediaTypes =
        consumes.length > 0
          ? [...new Set(consumes)]
          : ["application/octet-stream"];
      const content: Record<string, OpenApiMediaType> = {};
      for (const mt of rawMediaTypes) {
        content[mt] = { schema };
      }
      return {
        required: true,
        content,
      };
    }

    const mediaTypes =
      consumes.length > 0 ? unique(consumes) : ["application/json"];

    const wholeBody = bodyParams.find((p) => p.key === undefined);
    if (wholeBody) {
      const rawParamSchema = (
        wholeBody as ParameterMetadata & { schema?: unknown }
      ).schema;
      let schema: OpenApiSchema;
      if (rawParamSchema !== undefined) {
        schema = explorer.resolveStandardSchema(rawParamSchema, "input") ?? {
          type: "object" as const,
        };
      } else if (wholeBody.metatype !== undefined) {
        schema = explorer.resolveTypeSchema(wholeBody.metatype, false);
      } else {
        schema = { type: "object" as const };
      }
      const content: Record<string, OpenApiMediaType> = {};
      for (const mt of mediaTypes) {
        content[mt] = { schema };
      }
      return {
        required: true,
        content,
      };
    }

    const properties: Record<string, OpenApiSchema> = {};
    for (const bp of bodyParams) {
      if (!bp.key) continue;
      const rawFieldSchema = (bp as ParameterMetadata & { schema?: unknown })
        .schema;
      const stdSchema =
        rawFieldSchema !== undefined
          ? explorer.resolveStandardSchema(rawFieldSchema, "input")
          : undefined;
      properties[bp.key] =
        stdSchema ??
        (bp.metatype !== undefined
          ? explorer.resolveTypeSchema(bp.metatype, false)
          : {});
    }
    const content: Record<string, OpenApiMediaType> = {};
    for (const mt of mediaTypes) {
      content[mt] = { schema: { type: "object", properties } };
    }
    return {
      required: true,
      content,
    };
  }

  private static buildResponses(
    route: RouteDefinition,
    controller: Type<unknown>,
    handlerFn: Function,
    explorer: SchemaExplorer,
    globalResponses?: readonly ApiResponseOptions[],
    pluginAction?: {
      readonly type?: unknown;
      readonly isArray?: boolean;
      readonly status?: number;
    },
    opResponses?: Record<
      string,
      OpenApiResponse | { $ref: string } | undefined
    >,
    effectiveMethod?: string,
  ): {
    responses: Record<string, OpenApiResponse>;
    responseModels: Map<string, Type<unknown> | Function>;
  } {
    const produces = [
      ...MetadataRegistry.getMergedClassArray<string>(
        SWAGGER_METADATA_KEYS.API_PRODUCES,
        controller,
      ),
      ...(MetadataRegistry.get<readonly string[]>(
        SWAGGER_METADATA_KEYS.API_PRODUCES,
        handlerFn,
      ) ?? []),
    ];
    const headerContentType = route.headers?.find(
      (h) => h.name.toLowerCase() === "content-type",
    )?.value;
    let fallbackContentType = "application/json";
    if (route.isSse) {
      fallbackContentType = "text/event-stream";
    } else if (route.renderTemplate !== undefined) {
      fallbackContentType = "text/html";
    }
    const defaultContentType =
      produces[0] ?? headerContentType ?? fallbackContentType;
    const ctrlResponses =
      MetadataRegistry.getMergedClassArray<ApiResponseOptions>(
        SWAGGER_METADATA_KEYS.API_RESPONSES,
        controller,
      );
    const methodResponses =
      MetadataRegistry.get<readonly ApiResponseOptions[]>(
        SWAGGER_METADATA_KEYS.API_RESPONSES,
        handlerFn,
      ) ?? [];

    const combined: ApiResponseOptions[] = [
      ...(globalResponses ?? []),
      ...[...ctrlResponses].reverse(),
      ...[...methodResponses].reverse(),
    ];
    const hasExplicitLocalResponses =
      ctrlResponses.length > 0 ||
      methodResponses.length > 0 ||
      (opResponses !== undefined && Object.keys(opResponses).length > 0);
    const responses: Record<string, OpenApiResponse> = {};
    const responseModels = new Map<string, Type<unknown> | Function>();

    if (opResponses) {
      for (const [k, v] of Object.entries(opResponses)) {
        if (v && !("$ref" in v)) {
          responses[k] = { ...v };
        }
      }
    }

    for (let i = 0; i < combined.length; i++) {
      const entry = combined[i];
      if (!entry) continue;
      const statusKey =
        entry.status !== undefined
          ? String(entry.status)
          : defaultStatusForRoute(route, effectiveMethod);

      const response: OpenApiResponse = {
        description: entry.description ?? "",
        ...(entry.summary !== undefined ? { summary: entry.summary } : {}),
        ...(entry.headers !== undefined ? { headers: entry.headers } : {}),
        ...(entry.links !== undefined ? { links: { ...entry.links } } : {}),
      };

      const schemaHost = entry as Partial<ApiResponseSchemaHost>;
      const metaEntry = entry as Partial<ApiResponseCommonMetadata> & {
        example?: unknown;
        examples?: Record<string, { summary: string; value: unknown }>;
      };

      let schema: OpenApiSchema | undefined;
      if (schemaHost.schema) {
        schema = { ...schemaHost.schema };
      } else if (metaEntry.standardSchema !== undefined) {
        schema = explorer.resolveStandardSchema(
          metaEntry.standardSchema,
          "output",
        );
        if (schema && metaEntry.isArray) {
          schema = { type: "array", items: schema };
        }
      } else if (metaEntry.type !== undefined) {
        schema = explorer.resolveTypeSchema(
          metaEntry.type,
          metaEntry.isArray === true,
          "output",
        );
        if (isDtoConstructor(metaEntry.type)) {
          responseModels.set(statusKey, metaEntry.type);
        }
      }

      if (schema && metaEntry.nullable) {
        schema = applyNullable30(schema, metaEntry.nullable);
      }

      if (entry.content !== undefined) {
        response.content = { ...entry.content };
      } else if (
        schema !== undefined ||
        metaEntry.example !== undefined ||
        metaEntry.examples !== undefined
      ) {
        const contentType = entry.contentType ?? defaultContentType;
        response.content = {
          [contentType]: {
            ...(schema !== undefined ? { schema } : {}),
            ...(metaEntry.example !== undefined
              ? { example: metaEntry.example }
              : {}),
            ...(metaEntry.examples !== undefined
              ? { examples: metaEntry.examples }
              : {}),
          },
        };
      }

      const prev = responses[statusKey];
      if (prev) {
        const mergedDesc =
          prev.description && response.description
            ? `${prev.description}\n\n${response.description}`
            : response.description || prev.description;
        let mergedContent = prev.content;
        if (response.content) {
          mergedContent = { ...(prev.content ?? {}) };
          for (const [ct, media] of Object.entries(response.content)) {
            const existingMedia = mergedContent[ct];
            if (existingMedia) {
              mergedContent[ct] = {
                ...existingMedia,
                ...media,
                ...(existingMedia.examples || media.examples
                  ? {
                      examples: {
                        ...(existingMedia.examples ?? {}),
                        ...(media.examples ?? {}),
                      },
                    }
                  : {}),
              };
            } else {
              mergedContent[ct] = media;
            }
          }
        }
        responses[statusKey] = {
          ...prev,
          ...response,
          description: mergedDesc,
          ...(mergedContent !== undefined ? { content: mergedContent } : {}),
          ...(prev.headers || response.headers
            ? { headers: { ...(prev.headers ?? {}), ...(response.headers ?? {}) } }
            : {}),
          ...(prev.links || response.links
            ? { links: { ...(prev.links ?? {}), ...(response.links ?? {}) } }
            : {}),
        };
      } else {
        responses[statusKey] = response;
      }
    }

    const fallbackStatus =
      pluginAction?.status !== undefined
        ? String(pluginAction.status)
        : defaultStatusForRoute(route, effectiveMethod);
    const isRedirectStatus = /^3\d\d$/.test(fallbackStatus);
    const hasAny2xxResponse = Object.keys(responses).some((k) =>
      /^2\d\d$|^2XX$/i.test(k),
    );
    const needsInferredReturnSchema =
      fallbackStatus !== "204" &&
      !isRedirectStatus &&
      (!hasAny2xxResponse ||
        (responses[fallbackStatus] !== undefined &&
          responses[fallbackStatus]!.content === undefined));

    let inferredReturnSchema: OpenApiSchema | undefined;

    if (needsInferredReturnSchema) {
      // 1. Core Serializer metadata (@UseStandardSchema / @SerializeOptions({ schema, type }))
      const handlerUseStd = MetadataRegistry.get<{ readonly schema?: unknown }>(
        STANDARD_SCHEMA_SERIALIZER_METADATA_KEY,
        handlerFn,
      );
      const handlerSerOpts = MetadataRegistry.get<{
        readonly schema?: unknown;
        readonly type?: Type<unknown>;
      }>(CLASS_SERIALIZER_OPTIONS_KEY, handlerFn);
      const ctrlUseStd = MetadataRegistry.get<{ readonly schema?: unknown }>(
        STANDARD_SCHEMA_SERIALIZER_METADATA_KEY,
        controller,
      );
      const ctrlSerOpts = MetadataRegistry.get<{
        readonly schema?: unknown;
        readonly type?: Type<unknown>;
      }>(CLASS_SERIALIZER_OPTIONS_KEY, controller);

      const serializerStdSchema =
        handlerUseStd?.schema ??
        handlerSerOpts?.schema ??
        ctrlUseStd?.schema ??
        ctrlSerOpts?.schema;
      const serializerType = handlerSerOpts?.type ?? ctrlSerOpts?.type;

      if (serializerStdSchema !== undefined) {
        inferredReturnSchema = explorer.resolveStandardSchema(
          serializerStdSchema,
          "output",
        );
      } else if (serializerType !== undefined) {
        inferredReturnSchema = explorer.resolveTypeSchema(
          serializerType,
          false,
          "output",
        );
        if (
          isDtoConstructor(serializerType) &&
          !responseModels.has(fallbackStatus)
        ) {
          responseModels.set(fallbackStatus, serializerType);
        }
      }
    }

    if (needsInferredReturnSchema && inferredReturnSchema === undefined) {
      const reflectedReturnType = MetadataRegistry.getReturnType(
        controller.prototype as object,
        route.handlerKey,
      );
      if (
        isDtoConstructor(reflectedReturnType) &&
        isSchemaDecoratedClass(reflectedReturnType)
      ) {
        inferredReturnSchema = explorer.resolveTypeSchema(
          reflectedReturnType,
          false,
          "output",
        );
        if (!responseModels.has(fallbackStatus)) {
          responseModels.set(fallbackStatus, reflectedReturnType);
        }
      } else if (pluginAction?.type !== undefined) {
        inferredReturnSchema = explorer.resolveTypeSchema(
          pluginAction.type,
          pluginAction.isArray === true,
          "output",
        );
        if (
          isDtoConstructor(pluginAction.type) &&
          !responseModels.has(fallbackStatus)
        ) {
          responseModels.set(fallbackStatus, pluginAction.type);
        }
      } else if (route.isSse || route.renderTemplate !== undefined) {
        inferredReturnSchema = { type: "string" };
      }
    }

    const defaultStatusDescription =
      defaultStatusDescriptionForCode(fallbackStatus);

    if (
      Object.keys(responses).length === 0 ||
      (!hasExplicitLocalResponses && !hasAny2xxResponse && !responses["default"])
    ) {
      responses[fallbackStatus] = {
        description: defaultStatusDescription,
        ...(inferredReturnSchema !== undefined &&
        fallbackStatus !== "204" &&
        !isRedirectStatus
          ? {
              content: {
                [defaultContentType]: { schema: inferredReturnSchema },
              },
            }
          : {}),
      };
    } else if (
      !hasAny2xxResponse &&
      inferredReturnSchema !== undefined &&
      fallbackStatus !== "204" &&
      !isRedirectStatus
    ) {
      responses[fallbackStatus] = {
        description: defaultStatusDescription,
        content: {
          [defaultContentType]: { schema: inferredReturnSchema },
        },
      };
    } else if (
      inferredReturnSchema !== undefined &&
      fallbackStatus !== "204" &&
      !isRedirectStatus &&
      responses[fallbackStatus] !== undefined &&
      responses[fallbackStatus]!.content === undefined
    ) {
      responses[fallbackStatus] = {
        ...responses[fallbackStatus]!,
        content: {
          [defaultContentType]: { schema: inferredReturnSchema },
        },
      };
    }

    // Attach @Header(name, value) and @Redirect(url, statusCode) Location headers to primary response
    const primaryResponse = responses[fallbackStatus];
    if (primaryResponse && !primaryResponse.$ref) {
      const extraHeaders: Record<string, { description?: string; schema: OpenApiSchema }> = {};
      if (route.headers && route.headers.length > 0) {
        for (const h of route.headers) {
          const alreadyDefined =
            primaryResponse.headers &&
            Object.keys(primaryResponse.headers).some(
              (k) => k.toLowerCase() === h.name.toLowerCase(),
            );
          if (!alreadyDefined) {
            extraHeaders[h.name] = {
              schema: { type: "string", default: h.value },
            };
          }
        }
      }
      if (route.redirect) {
        const hasLocationHeader =
          (primaryResponse.headers &&
            Object.keys(primaryResponse.headers).some(
              (k) => k.toLowerCase() === "location",
            )) ||
          Object.keys(extraHeaders).some((k) => k.toLowerCase() === "location");
        if (!hasLocationHeader) {
          extraHeaders["Location"] = {
            description: route.redirect.url
              ? `Redirect target: ${route.redirect.url}`
              : "Redirect target URL",
            schema: {
              type: "string",
              format: "uri-reference",
              ...(route.redirect.url ? { default: route.redirect.url } : {}),
            },
          };
        }
      }
      if (Object.keys(extraHeaders).length > 0) {
        responses[fallbackStatus] = {
          ...primaryResponse,
          headers: {
            ...extraHeaders,
            ...(primaryResponse.headers ?? {}),
          },
        };
      }
    }

    // @bunest/security @Throttle() without @SkipThrottle() -> document 429 Too Many Requests
    const methodSkipThrottle = MetadataRegistry.get<
      boolean | Record<string, boolean>
    >(SECURITY_SKIP_THROTTLE_KEY, handlerFn);
    const ctrlSkipThrottle = MetadataRegistry.get<
      boolean | Record<string, boolean>
    >(SECURITY_SKIP_THROTTLE_KEY, controller);
    const effectiveSkipThrottle =
      methodSkipThrottle !== undefined ? methodSkipThrottle : ctrlSkipThrottle;
    const isThrottleSkipped = effectiveSkipThrottle === true;
    const hasThrottle =
      !isThrottleSkipped &&
      (MetadataRegistry.get<unknown>(SECURITY_THROTTLE_KEY, handlerFn) !==
        undefined ||
        MetadataRegistry.get<unknown>(SECURITY_THROTTLE_KEY, controller) !==
          undefined);
    if (hasThrottle && responses["429"] === undefined) {
      responses["429"] = {
        description: "Too Many Requests",
      };
    }

    return { responses, responseModels };
  }
}
