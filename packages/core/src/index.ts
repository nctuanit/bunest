import "./common/metadata/reflect-shim";

// Re-export @bunest/common (includes canonical runtime `ShutdownSignal` enum & `ConfigurableModuleBuilder`)
export * from "./common/index";

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
  FUNCTIONAL_ROUTE_GROUP_MARKER,
  FileInterceptor,
  FilesInterceptor,
  FunctionalModule,
  HttpExecutionContext,
  HttpResponseContext,
  InvalidControllerException,
  InvalidRouteException,
  NoopLoader,
  RequestContext,
  SERVE_STATIC_MODULE_OPTIONS,
  SIGNED_COOKIE_PREFIX,
  ServeStaticModule,
  UploadedFileStream,
  applySecurityHeaders,
  compileCsrfProtection,
  compileSecurityHeaders,
  createCompressionMiddleware,
  createStaticAssetsMount,
  defineRoutes,
  extractMultipartStreamBoundary,
  extractSignedCookies,
  getCurrentRequestContext,
  implementContract,
  isFunctionalRouteGroup,
  normalizeCookieSecrets,
  parseMaxAgeSeconds,
  parseMultipartStream,
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
  type ContractHandlers,
  type ContractRouteHandler,
  type ContractRouteHandlerConfig,
  type ContractRouteImplementation,
  type DiskUploadedFileInfo,
  type ExtendedStaticAssetsOptions,
  type FileInterceptorOptions,
  type FileUploadMode,
  type FunctionalContractModuleOptions,
  type FunctionalModuleOptions,
  type FunctionalRouteBuilder,
  type FunctionalRouteContext,
  type FunctionalRouteEntry,
  type FunctionalRouteGroup,
  type FunctionalRouteGroupOptions,
  type FunctionalRouteHandler,
  type FunctionalRouteOptions,
  type GlobalPrefixOptions,
  type HttpIncomingHeaders,
  type HttpIncomingMessageLike,
  type HttpRuntimeBridge,
  type HttpServerResponseLike,
  type ImplementContractOptions,
  type InferContractServerBody,
  type InferContractServerParams,
  type InferContractServerQuery,
  type InferContractServerResponse,
  type ListenOptions,
  type ListeningServerInfo,
  type MiddlewareEntry,
  type MultipartFieldPart,
  type MultipartFilePart,
  type MultipartStorageOptions,
  type MultipartStreamOptions,
  type MultipartStreamPart,
  type RequestScopeContainer,
  type ServeStaticApplicationConfigLike,
  type ServeStaticHttpAdapterHostLike,
  type ServeStaticModuleAsyncOptions,
  type ServeStaticModuleOptions,
  type ServeStaticModuleOptionsFactory,
  type StaticAssetsMount,
  type StoredUploadedFile,
  type SupportedCompressionEncoding,
  type UploadStorageEngineFile,
  type UploadStorageEngineLike,
  type WebSocketHandlerRegistration,
  type WebSocketUpgradeHandler,
} from "./http/index";

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
export {
  BUNEST_ERROR_CATALOG,
  BUNEST_ERROR_DOCS_BASE_URL,
  formatBunestErrorForAgent,
  getErrorCatalogEntry,
  getErrorDocsUrl,
  isBunestErrorCode,
  toBunestErrorReport,
  type BunestErrorCatalogEntry,
  type BunestErrorCode,
  type BunestErrorReport,
} from "./errors/error-catalog";
export {
  AgentErrorTraceStore,
  buildAgentErrorTrace,
  extractAppStackFrames,
  formatAgentErrorTrace,
  generateTraceRequestId,
  readAgentErrorTracesFromFile,
  type AgentErrorTrace,
  type AgentStackFrame,
  type AgentTraceStoreOptions,
  type BuildAgentErrorTraceInput,
  type PipelineTraceStage,
} from "./errors/agent-trace";

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
  expandAutoModules,
  expandSingleAutoModule,
  getInjectableScope,
  isInjectableDurable,
  isProviderObject,
  normalizeProvider,
  type ModuleScanOptions,
  type ScannedModuleGraph,
} from "./module/module-scanner";

// Smart @AutoModule Extended Metadata
export {
  AUTO_MODULE_METADATA_KEY,
  DEFAULT_AUTO_MODULE_EXCLUDES,
  extractCallerDir,
  getAutoModuleMetadata,
  type AutoModuleManifestLoader,
  type AutoModuleMetadata,
  type StoredAutoModuleMetadata,
} from "./common/decorators/core.decorators";

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
export { ExecutionContextHost } from "./helpers/execution-context-host";
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
  type BunestReplServer,
  type ReplContextFunctions,
  type ReplOptions,
} from "./repl/repl";

// Lifecycle Manager
export {
  LifecycleManager,
  type ModuleInstanceGroup,
} from "./lifecycle/lifecycle-manager";

// Service-Layer AOP Phases, Pipelines, Typed Aspects, Pointcuts & Weaver
export {
  AspectPhase,
  collectPrototypeMethodNames,
  resolveAspectOrder,
  stableSortMethodAspects,
  type AspectOrderInput,
  type AspectOrderOptions,
  type AspectPhaseName,
  type AspectPhaseValue,
} from "./common/decorators/method-aspect.decorator";
export {
  AOP_POINTCUTS_TOKEN,
  AopModule,
  clearGlobalPointcuts,
  createTypedAspect,
  defineAspectPipeline,
  getAllEffectiveMethodAspects,
  getEffectiveMethodAspects,
  getGlobalPointcuts,
  getGlobalPointcutsVersion,
  getMatchingPointcutAspects,
  hasMatchingPointcuts,
  matchesPointcutClass,
  matchesPointcutMethod,
  registerGlobalPointcuts,
  unregisterGlobalPointcut,
  type AopModuleOptions,
  type AspectPipelineStep,
  type AspectPipelineStepSpec,
  type AsyncTypedAspectConfig,
  type AsyncTypedMethodDecorator,
  type PointcutAspectEntry,
  type PointcutMatcher,
  type PointcutRule,
  type TypedAspectConfig,
  type TypedAspectConfigBase,
  type TypedAspectDecoratorFactory,
  type TypedMethodAspectContext,
  type TypedMethodDecorator,
} from "./aop/aop-pipeline";
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
export {
  AMBIENT_CLS_STORE_GETTER_SYMBOL,
  AMBIENT_TRACEPARENT_PROVIDER_SYMBOL,
  CLS_ID,
  CLS_MODULE_OPTIONS,
  CLS_PROXY_MARKER,
  ClsContextPropagator,
  ClsInterceptor,
  ClsMiddleware,
  ClsModule,
  ClsService,
  DEFAULT_CLS_HEADER_MAP,
  DEFAULT_CLS_PROPAGATION_KEYS,
  WithCls,
  WithClsAspect,
  captureClsContext,
  clsToHeaders,
  createClsProxyProvider,
  getAmbientClsStore,
  getAmbientTraceparent,
  headersToCls,
  registerAmbientTraceparentProvider,
  restoreClsContext,
  type AmbientClsStoreGetter,
  type AmbientTraceparentProvider,
  type ClsCarrierInput,
  type ClsContextCarrier,
  type ClsContextPropagatorOptions,
  type ClsFeatureOptions,
  type ClsInterceptorMountOptions,
  type ClsKnownKeys,
  type ClsMiddlewareMountOptions,
  type ClsModuleAsyncOptions,
  type ClsModuleOptions,
  type ClsProxyFactory,
  type ClsProxyProviderOptions,
  type ClsServiceLike,
  type ClsStore,
  type WithClsOptions,
} from "./cls/index";

// Bootstrap Typed Config
export {
  PRELOADED_CONFIG_MARKER,
  isLoadedConfig,
  loadConfig,
  type LoadConfigOptions,
  type LoadedConfig,
} from "./config/load-config";

// Application & Factory (including 1:1 NestJS Compatibility Aliases & Serverless Adapter)
export {
  BunestApplicationContext,
  BunestApplicationContext as NestApplicationContext,
} from "./application/bunest-application-context";
export {
  BunestApplication,
  BunestApplication as NestApplication,
  type DevDiagnosticsOptions,
} from "./application/bunest-application";
export {
  BunestFactory,
  BunestFactory as NestFactory,
  BunestMicroserviceApplication,
  type BunestCreateAutoOptions,
  type BunestCreateOptions,
  type BunestCreateRoutesOptions,
  type BunestFetchHandler,
  type BunestFetchHandlerOptions,
  type MicroserviceServerFactory,
} from "./application/bunest-factory";
export {
  createBunestServer,
  createFetchHandler,
  type BunestServerHandler,
  type BunestServerOptions,
  type WinterTcFetchHandler,
} from "./application/serverless";
