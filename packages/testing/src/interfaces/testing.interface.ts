import type {
  BunestApplicationOptions,
  DynamicModule,
  FactoryDependency,
  InjectionToken,
  InstrumentOptions,
  LogLevel,
  LoggerService,
  MicroserviceInstance,
  NestHybridApplicationOptions,
  Scope,
  Type,
} from "@bunest/common";
import type { BunHttpAdapter } from "@bunest/http";

export interface OverrideByFactoryOptions<T = unknown> {
  factory: (...args: any[]) => T | Promise<T>;
  inject?: FactoryDependency[];
  scope?: Scope;
}

export type OverrideFactoryOptions<T = unknown> = OverrideByFactoryOptions<T>;

export interface OverrideBy<TBuilder> {
  useValue(value: unknown): TBuilder;
  useClass(metatype: Type<unknown>, scope?: Scope): TBuilder;
  useFactory<T = unknown>(options: OverrideFactoryOptions<T>): TBuilder;
  useExisting(existingToken: InjectionToken): TBuilder;
}

export interface OverrideByEnhancer<TBuilder> {
  useValue(value: unknown): TBuilder;
  useClass(metatype: Type<unknown>, scope?: Scope): TBuilder;
  useFactory<T = unknown>(options: OverrideFactoryOptions<T>): TBuilder;
  useExisting(existingToken: InjectionToken): TBuilder;
}

export interface OverrideModule<TBuilder> {
  useModule(newModule: Type<unknown> | DynamicModule): TBuilder;
}

export interface TestingModuleOptions {
  /**
   * NestJS compatibility option accepted by `Test.createTestingModule(metadata, options)`.
   */
  moduleIdGeneratorAlgorithm?: "deep-hash" | "reference";
  logger?: LoggerService | LogLevel[] | false;
  bufferLogs?: boolean;
  autoFlushLogs?: boolean;
  abortOnError?: boolean;
  snapshot?: boolean;
  preview?: boolean;
  instrument?: InstrumentOptions;
}

export interface TestingModuleCompileOptions extends BunestApplicationOptions {
  snapshot?: boolean;
  preview?: boolean;
  instrument?: InstrumentOptions;
  moduleIdGeneratorAlgorithm?: "deep-hash" | "reference";
  bufferLogs?: boolean;
  autoFlushLogs?: boolean;
}

export interface CreateTestingMicroserviceOptions
  extends NestHybridApplicationOptions {
  logger?: LoggerService | LogLevel[] | false;
}

export type TestingMicroserviceTarget = MicroserviceInstance;

export interface CreateTestingAppOptions extends BunestApplicationOptions {
  httpAdapter?: BunHttpAdapter;
  bufferLogs?: boolean;
  autoFlushLogs?: boolean;
}

export type QueryParamPrimitive = string | number | boolean;
export type QueryParamValue =
  | QueryParamPrimitive
  | readonly QueryParamPrimitive[]
  | undefined;

export interface TestClientOptions {
  /**
   * Base origin used when constructing URLs for relative request paths.
   * @default "http://bunest.test"
   */
  baseUrl?: string;
  /**
   * Default headers merged into every request made by this client.
   */
  defaultHeaders?: Record<string, string>;
  /**
   * Default cookies merged into every request made by this client.
   */
  defaultCookies?: Record<string, string>;
}

export type TestRequestRedirect = "follow" | "error" | "manual";

export interface TestRequestOptions {
  query?: Record<string, QueryParamValue>;
  headers?: Record<string, string | string[]> | Headers;
  cookies?: Record<string, string>;
  json?: unknown;
  body?:
    | string
    | Uint8Array
    | ArrayBuffer
    | Blob
    | ReadableStream
    | URLSearchParams
    | FormData
    | null;
  formData?: FormData;
  signal?: AbortSignal;
  /**
   * Redirect behavior. Defaults to `"manual"` for both in-memory and live clients
   * so `@Redirect()` status codes and `Location` headers can be asserted reliably.
   * @default "manual"
   */
  redirect?: TestRequestRedirect;
}

export interface FetchCapable {
  fetch(req: Request): Promise<Response>;
}
