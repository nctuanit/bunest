import "reflect-metadata";

// Re-export @bunest/common (includes canonical runtime `ShutdownSignal` enum & `ConfigurableModuleBuilder`)
export * from "@bunest/common";

// Re-export @bunest/http public APIs (includes `AbstractHttpAdapter` -> 54/54 @nestjs/core parity!)
export {
  AbstractHttpAdapter,
  AbstractLoader,
  BUNEST_APPLICATION_CONFIG_TOKEN,
  BUNEST_HTTP_ADAPTER_HOST_TOKEN,
  BunHttpAdapter,
  BunStaticLoader,
  CompressionMiddleware,
  CookieSigner,
  DEFAULT_EXPRESS_RENDER_PATH,
  DEFAULT_FASTIFY_RENDER_PATH,
  DEFAULT_RENDER_PATH,
  DEFAULT_ROOT_PATH,
  DefaultExceptionFilter,
  DefaultHttpRuntimeBridge,
  DuplicateRouteException,
  HttpExecutionContext,
  HttpResponseContext,
  InvalidControllerException,
  InvalidRouteException,
  NoopLoader,
  RequestContext,
  SERVE_STATIC_MODULE_OPTIONS,
  SIGNED_COOKIE_PREFIX,
  ServeStaticModule,
  applySecurityHeaders,
  compileCsrfProtection,
  compileSecurityHeaders,
  createCompressionMiddleware,
  createStaticAssetsMount,
  extractSignedCookies,
  getCurrentRequestContext,
  normalizeCookieSecrets,
  parseMaxAgeSeconds,
  requestContextStorage,
  serveStaticProviders,
  signCookieValue,
  tryServeStaticAsset,
  unsignCookieValue,
  type BunHttpAdapterOptions,
  type BunServerLike,
  type BunSocketAddress,
  type CompiledCsrfProtection,
  type CompiledMiddlewareConfig,
  type CompiledSecurityHeaders,
  type CompressionOptions,
  type DiskUploadedFileInfo,
  type ExtendedStaticAssetsOptions,
  type GlobalPrefixOptions,
  type HttpRuntimeBridge,
  type ListenOptions,
  type ListeningServerInfo,
  type MiddlewareEntry,
  type MultipartStorageOptions,
  type RequestScopeContainer,
  type ServeStaticApplicationConfigLike,
  type ServeStaticHttpAdapterHostLike,
  type ServeStaticModuleAsyncOptions,
  type ServeStaticModuleOptions,
  type ServeStaticModuleOptionsFactory,
  type StaticAssetsMount,
  type SupportedCompressionEncoding,
  type WebSocketHandlerRegistration,
  type WebSocketUpgradeHandler,
} from "@bunest/http";

// Re-export @bunest/validation public APIs (only validation-specific symbols to avoid duplicate re-export conflicts with @bunest/common)
export {
  SchemaValidationPipe,
  type SchemaSafeParseFailure,
  type SchemaSafeParseResult,
  type SchemaSafeParseSuccess,
  type SchemaValidationErrorLike,
  type SchemaValidationIssue,
  type SchemaValidationPipeOptions,
  type SchemaValidator,
} from "@bunest/validation";

// Core Errors
export {
  AmbiguousProviderException,
  CircularDependencyException,
  CoreBootstrapException,
  DuplicateProviderException,
  InvalidExportException,
  InvalidModuleException,
  ScopeLeakException,
  UnknownDependencyException,
  type AmbiguousProviderDetails,
  type CircularDependencyDetails,
  type ScopeChainNode,
  type UnknownDependencyDetails,
} from "./errors/core.exceptions";
export { formatToken } from "./errors/token-formatter";

// Core Interfaces, ContextId & Enhancer Override Markers
export {
  ENHANCER_OVERRIDE_MARKER,
  isContextId,
  isEnhancerOverrideEntry,
  type BunestApplicationContextOptions,
  type ConflictKind,
  type ContainerOverrides,
  type ContextId,
  type EnhancerClassOverrideEntry,
  type EnhancerExistingOverrideEntry,
  type EnhancerFactoryOverrideEntry,
  type EnhancerKind,
  type EnhancerOverrideEntry,
  type EnhancerOverrideValue,
  type EnhancerValueOverrideEntry,
  type IEntryNestModule,
  type InjectBody,
  type InjectOptions,
  type InjectResponse,
  type LifecycleManagerLike,
  type LifecycleModuleGroupLike,
  type MiddlewareConfigEntry,
  type MockFactory,
  type ModuleRefGetOptions,
  type ModuleRefGetOrResolveOpts,
  type ModuleRefHost,
  type NormalizedProvider,
  type ProviderKind,
  type ResolvedRoute,
  type ResolvedRouteHandler,
  type RouteConflict,
  type RouteResolutionOptions,
  type ShutdownSignalInput,
  type Subscribable,
  type SubscribableObserver,
  type Unsubscribable,
} from "./interfaces/core-types.interface";

// Discovery & Metadata Introspection
export { DiscoveryModule } from "./discovery/discovery.module";
export {
  DiscoveryService,
  type DiscoverableDecorator,
  type DiscoveryFilterOptions,
  type DiscoveryHost,
  type DiscoveryOptions,
  type FilterByInclude,
  type FilterByMetadataKey,
  type InstanceWrapper,
} from "./discovery/discovery.service";
export { MetadataScanner } from "./discovery/metadata-scanner";

// Hierarchical Router Module
export {
  ROUTER_MODULE_ROUTES,
  RouterModule,
  flattenRouteTree,
  joinRoutePaths,
  resolveRouterModulePrefixes,
  type RouteTree,
  type Routes,
} from "./router/router.module";

// Module Graph, LazyModuleLoader & Middleware Consumer
export {
  LazyModuleLoader,
  type LazyModuleHost,
  type LazyModuleLoaderOptions,
} from "./module/lazy-module-loader";
export {
  CoreMiddlewareConsumer,
  CoreMiddlewareConsumer as MiddlewareBuilder,
  type MiddlewareConfiguration,
} from "./module/middleware-consumer";
export { ModuleNode } from "./module/module-node";
export {
  MULTI_PROVIDER_TOKENS,
  ModuleScanner,
  getInjectableScope,
  isInjectableDurable,
  isProviderObject,
  normalizeProvider,
  type ModuleScanOptions,
  type ScannedModuleGraph,
} from "./module/module-scanner";

// DI Container, ContextIdFactory, Request Scope & ModuleRef
export { ContextIdFactory, createContextId } from "./di/context-id.factory";
export {
  DIContainer,
  DIContainer as NestContainer,
  type DIContainerOptions,
} from "./di/di-container";
export { ModuleRef } from "./di/module-ref";
export { ModulesContainer } from "./di/modules-container";
export { RequestContainer } from "./di/request-container";

// NestJS Core Compatibility Helpers & Base Exception Filter
export { ApplicationConfig } from "./application/application-config";
export { HttpAdapterHost } from "./helpers/http-adapter-host";
export {
  ExternalContextCreator,
  type ExternalContextContainerLike,
  type ExternalContextOptions,
  type ExternalHandlerMetadata,
  type ParamProperties,
  type ParamsFactory,
} from "./helpers/external-context-creator";
export { BaseExceptionFilter } from "./exceptions/base-exception-filter";

// Graph Inspector, SerializedGraph, PartialGraphHost & Preview Mode
export {
  SerializedGraph,
  type GraphEdgeDefinition,
  type GraphEntrypoint,
  type GraphNodeDefinition,
  type OrphanedEnhancerDefinition,
  type SerializedGraphJson,
  type SerializedGraphMetadata,
  type SerializedGraphStatus,
} from "./inspector/serialized-graph";
export {
  GraphInspector,
  type EnhancerMetadataCacheEntry,
} from "./inspector/graph-inspector";
export { PartialGraphHost } from "./inspector/partial-graph.host";
export { InitializeOnPreviewAllowlist } from "./inspector/initialize-on-preview.allowlist";

// Interactive REPL
export {
  createReplContext,
  repl,
  type ReplContextFunctions,
} from "./repl/repl";

// Lifecycle Manager
export {
  LifecycleManager,
  type ModuleInstanceGroup,
} from "./lifecycle/lifecycle-manager";

// Service-Layer AOP Method Aspect Weaver
export {
  collectClassAspectTokens,
  isMethodAspectClass,
  isMethodAspectHandlerObject,
  weaveInstanceMethodAspects,
  weaveMethodExecutor,
  weaveProxyMethodAspects,
  type AspectResolutionValue,
  type AspectResolver,
  type AspectResolverFn,
  type AspectResolverObject,
  type MethodAspectResolverHost,
  type ResolvedAspectEntry,
} from "./aop/method-aspect-weaver";

// Continuation-Local Storage (AsyncLocalStorage)
export { ClsModule } from "./cls/cls.module";
export {
  WithCls,
  WithClsAspect,
  type WithClsOptions,
} from "./cls/cls.decorator";
export {
  CLS_ID,
  CLS_MODULE_OPTIONS,
  ClsInterceptor,
  ClsMiddleware,
  ClsService,
  type ClsModuleOptions,
  type ClsStore,
} from "./cls/cls.service";

// Application & Factory (including 1:1 NestJS Compatibility Aliases)
export {
  BunestApplicationContext,
  BunestApplicationContext as NestApplicationContext,
} from "./application/bunest-application-context";
export {
  BunestApplication,
  BunestApplication as NestApplication,
} from "./application/bunest-application";
export {
  BunestFactory,
  BunestFactory as NestFactory,
  BunestMicroserviceApplication,
  type BunestCreateAutoOptions,
  type BunestCreateOptions,
  type MicroserviceServerFactory,
} from "./application/bunest-factory";
