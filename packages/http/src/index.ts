import "reflect-metadata";

// Re-export canonical HttpServer interface from @bunest/common
export type { HttpServer } from "@bunest/common";

// Bridge & Adapter Contracts
export type {
  BunHttpAdapterOptions,
  BunServerLike,
  BunSocketAddress,
  CompiledMiddlewareConfig,
  DiskUploadedFileInfo,
  EnhancerKind,
  GlobalPrefixOptions,
  HttpRuntimeBridge,
  ListeningServerInfo,
  ListenOptions,
  MultipartStorageOptions,
  RequestScopeContainer,
  WebSocketHandlerRegistration,
  WebSocketUpgradeHandler,
} from "./interfaces/http-bridge.interface";

// Routing Errors
export {
  DuplicateRouteException,
  InvalidControllerException,
  InvalidRouteException,
} from "./errors/routing.errors";

// Request / Response / Execution Context
export { HttpResponseContext } from "./context/response-context";
export {
  getCurrentRequestContext,
  RequestContext,
  requestContextStorage,
  type RequestContextOptions,
} from "./context/request-context";
export { HttpExecutionContext } from "./context/execution-context";

// Security & Body Parsing
export {
  isDangerousKey,
  sanitizeObject,
  sanitizeRecord,
} from "./security/prototype-sanitizer";
export {
  CookieSigner,
  SIGNED_COOKIE_PREFIX,
  extractRequestCookies,
  extractSignedCookies,
  normalizeCookieSecrets,
  parseCookieHeader,
  serializeCookie,
  signCookieValue,
  unsignCookieValue,
} from "./security/cookie";
export {
  compileCsrfProtection,
  type CompiledCsrfProtection,
} from "./security/csrf-protection";
export {
  applySecurityHeaders,
  compileSecurityHeaders,
  type CompiledSecurityHeaders,
} from "./security/security-headers";
export { extractClientIp } from "./security/ip";
export {
  createPreflightResponse,
  evaluateCors,
  isCorsPreflightRequest,
  mergeCorsHeaders,
  normalizeCorsOptions,
  type CorsEvaluationResult,
  type NormalizedCorsOptions,
} from "./security/cors";
export {
  assertBodySizeHeader,
  parseRequestBody,
  type ParsedBodyResult,
  type ParseRequestBodyOptions,
} from "./parsers/body-parser";

// Scanner, Path Normalization & API Versioning
export {
  canonicalizePath,
  isNativeBunRoutePath,
  matchesGlobalPrefixExclude,
  matchesMiddlewareForRoute,
  matchesPathPattern,
  matchesRouteInfo,
  normalizePath,
} from "./scanner/path-normalizer";
export {
  extractRequestVersions,
  formatUriVersionSegment,
  formatVersionCollisionKey,
  formatVersionLabel,
  isRuntimeVersioning,
  normalizeVersionValue,
  resolveRouteVersions,
  selectVersionedCandidate,
  type NormalizedVersionToken,
} from "./scanner/version-resolver";

// Compression Middleware
export {
  CompressionMiddleware,
  createCompressionMiddleware,
  type CompressionOptions,
  type SupportedCompressionEncoding,
} from "./middleware/compression.middleware";
export {
  scanControllers,
  type ScanControllersOptions,
  type ScannedRoute,
} from "./scanner/controller-scanner";

// Static Assets & ServeStaticModule (Bun-native, ADR-001)
export {
  createStaticAssetsMount,
  parseMaxAgeSeconds,
  tryServeStaticAsset,
  type ExtendedStaticAssetsOptions,
  type StaticAssetsMount,
} from "./static/static-assets";
export {
  AbstractLoader,
  BUNEST_APPLICATION_CONFIG_TOKEN,
  BUNEST_HTTP_ADAPTER_HOST_TOKEN,
  BunStaticLoader,
  DEFAULT_EXPRESS_RENDER_PATH,
  DEFAULT_FASTIFY_RENDER_PATH,
  DEFAULT_RENDER_PATH,
  DEFAULT_ROOT_PATH,
  NoopLoader,
  SERVE_STATIC_MODULE_OPTIONS,
  ServeStaticModule,
  serveStaticProviders,
  type ServeStaticApplicationConfigLike,
  type ServeStaticHttpAdapterHostLike,
  type ServeStaticModuleAsyncOptions,
  type ServeStaticModuleOptions,
  type ServeStaticModuleOptionsFactory,
} from "./static/serve-static.module";

// Pipeline & Response Serialization
export {
  formatSseEvent,
  mergeHeadersOntoNativeResponse,
  serializeResponse,
  type RouteResponseMeta,
} from "./pipeline/response-serializer";
export {
  DefaultExceptionFilter,
  executeExceptionFilters,
  extractFilterCatchTypes,
  type CompiledExceptionFilter,
  type DefaultExceptionFilterOptions,
} from "./pipeline/exception-handler";
export {
  compileParameters,
  hasStandardSchemaValidationPipe,
  resolveRouteArguments,
  type CompiledParameter,
  type ParameterExtractorFn,
} from "./pipeline/param-extractor";
export {
  buildFilterSpec,
  executeCompiledRoute,
  executeFallbackException,
  executeFastSingletonRoute,
  type CompiledRoute,
  type MiddlewareEntry,
  type PipelineRuntimeConfig,
  type ResolvedMiddleware,
} from "./pipeline/execution-pipeline";

// Router & Route Compiler
export {
  computeAllowHeader,
  FallbackRadixRouter,
  NativePathMatcher,
  type FallbackMatchResult,
} from "./router/fallback-radix-router";
export {
  compileRoutes,
  type CompiledPathDispatcher,
  type CompiledRouteTable,
  type RouteCompilerInput,
} from "./router/route-compiler";

// HTTP Adapters
export { AbstractHttpAdapter } from "./adapter/abstract-http.adapter";
export {
  BunHttpAdapter,
  DefaultHttpRuntimeBridge,
} from "./adapter/bun-http.adapter";
