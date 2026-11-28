import "../common/metadata/reflect-shim";

export { HttpClientModule } from "./http-client.module";
export {
  HTTP_CLIENT_MODULE_OPTIONS,
  getHttpClientToken,
  type HttpClientAsyncOptions,
  type HttpClientFactoryOptions,
  type HttpClientModuleAsyncOptions,
  type HttpClientModuleFactoryOptions,
  type HttpClientModuleOptionsFactory,
  type HttpClientOptionsFactory,
} from "./http-client.module-definition";
export * from "./decorators/index";
export {
  HTTP_CLIENT_REQUEST_CHANNEL,
  HttpClient,
  type HttpClientRequestDiagnosticEvent,
  type HttpMethodCall,
} from "./http-client";
export type {
  BunFetchSessionLike,
  HttpBackoffOptions,
  HttpClientModuleOptions,
  HttpClientOptions,
  HttpFetchProxyOption,
  HttpFetchSessionOptions,
  HttpHeadersInit,
  HttpQuery,
  HttpRequestBody,
  HttpRequestOptions,
  HttpResponse,
  HttpResponseType,
  HttpRetryOptions,
} from "./interfaces/index";
export type { Duration } from "./types/index";
export type {
  HttpClientInterceptor,
  HttpClientInterceptorFn,
  HttpHandler,
  HttpRequest,
} from "./interfaces/index";
export * from "./errors/index";
export {
  createRpcClient,
  createTypedClient,
  type ControllerHandlerNames,
  type RouteControllerNames,
  type RouteDefBody,
  type RouteDefParams,
  type RouteDefQuery,
  type RouteDefResponse,
  type RouteDefinition,
  type RouteEntryFor,
  type RouteManifestEntry,
  type RouteManifestLike,
  type RoutePathsForMethod,
  type RouteRegistryLike,
  type RpcClient,
  type RpcClientOptions,
  type TypedClient,
  type TypedClientHttpMethod,
  type TypedClientOptions,
  type TypedHttpMethodFn,
  type TypedRequestBaseOptions,
  type TypedRouteCall,
  type TypedRouteCallArgs,
  type TypedRouteCallOptions,
  type TypedRouteCallOptionsWithSchema,
} from "./typed-client";
export {
  CONTRACT_MARKER,
  CONTRACT_ROUTE_MARKER,
  createContractClient,
  defineContract,
  defineRoute,
  isContractDefinition,
  isContractRoute,
  type AnyContractRoute,
  type ContractCallArgs,
  type ContractCallOptions,
  type ContractClient,
  type ContractClientOptions,
  type ContractDefinition,
  type ContractHttpMethod,
  type ContractRoute,
  type ContractRouteInvoker,
  type ContractRouteSpec,
  type ContractTree,
  type DefineContractOptions,
  type InferContractRouteBody,
  type InferContractRouteParams,
  type InferContractRouteQuery,
  type InferContractRouteResponse,
} from "./contract";
export {
  toHttpException,
  type ToHttpExceptionOptions,
} from "./utils/to-http-exception.util";
