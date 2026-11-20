import "reflect-metadata";

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
export { HttpClient } from "./http-client";
export type {
  HttpBackoffOptions,
  HttpClientModuleOptions,
  HttpClientOptions,
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
  toHttpException,
  type ToHttpExceptionOptions,
} from "./utils/to-http-exception.util";
