import type { RequestMethod, RouteHttpMethod, Scope } from "../enums/scope.enum";
import type { ExecutionContext } from "./pipeline.interface";
import type { StandardSchemaV1 } from "./standard-schema.interface";
import type { InjectionToken, Type } from "./type.interface";
import type { VersionValue } from "./versioning.interface";

export interface UploadedFileInfo {
  readonly fieldname: string;
  readonly originalname: string;
  readonly encoding?: string;
  readonly mimetype: string;
  readonly size: number;
  readonly buffer: Uint8Array;
  readonly file: File;
  /**
   * Returns a Web `ReadableStream<Uint8Array>` over the uploaded file bytes.
   */
  readonly stream?: () => ReadableStream<Uint8Array>;
}

export type ParameterSource =
  | "body"
  | "rawBody"
  | "query"
  | "param"
  | "header"
  | "request"
  | "response"
  | "next"
  | "ip"
  | "hostParam"
  | "cookies"
  | "signedCookies"
  | "session"
  | "sseSignal"
  | "uploadedFile"
  | "uploadedFiles"
  | "custom";

export type Paramtype =
  | "body"
  | "query"
  | "param"
  | "custom"
  | "header"
  | "cookies"
  | "signedCookies"
  | "session"
  | "uploadedFile"
  | "uploadedFiles"
  | "hostParam";

export type ParamData = object | string | number;

export type ParamDecoratorEnhancer = ParameterDecorator;

export interface ParameterDecoratorOptions {
  readonly schema?: StandardSchemaV1;
  readonly property?: string;
  readonly pipes?: (PipeTransform<any, any> | Type<PipeTransform<any, any>>)[];
}

export interface ResponseDecoratorOptions {
  /**
   * Accepted for NestJS drop-in compatibility. Bunest's `@Res()` (`ResponseContext`)
   * always supports returning serialized values without disabling the framework pipeline.
   * @default true
   */
  passthrough?: boolean;
}

export interface RequestMappingMetadata {
  path?: string | string[];
  method?: RequestMethod | RouteHttpMethod;
}

export interface RouteParamMetadata {
  index: number;
  data?: ParamData;
}

export interface HttpRedirectResponse {
  url: string;
  statusCode?: number;
}

export interface PlainLiteralObject {
  [key: string]: any;
}

export type RawBodyRequest<T = Request> = T & {
  rawBody?: Uint8Array | Buffer;
};

export interface SseOptions {
  /**
   * HTTP request method of the SSE route.
   * @default RequestMethod.GET
   */
  method?: RequestMethod | RouteHttpMethod;
  /**
   * Maximum number of pending event characters buffered before disconnecting
   * a slow client (`0` or `Infinity` disables the limit).
   * @default 4_194_304 (4 MiB)
   */
  maxPendingDataLength?: number;
}

export interface ArgumentMetadata {
  readonly type: Paramtype;
  readonly metatype?: Type<any> | Function;
  readonly data?: string;
  readonly schema?: StandardSchemaV1<unknown, unknown>;
}

export interface PipeTransform<T = any, R = any> {
  transform(value: T, metadata: ArgumentMetadata): R | Promise<R>;
}

export type PipeLike = PipeTransform | Type<PipeTransform>;

export type CustomParamFactory<
  TData = any,
  TContext = ExecutionContext,
  TResult = any,
> = (data: TData, ctx: TContext) => TResult | Promise<TResult>;

export interface ParameterMetadata {
  readonly index: number;
  readonly source: ParameterSource;
  readonly key?: string;
  readonly data?: unknown;
  readonly pipes?: readonly PipeLike[];
  readonly metatype?: Function;
  readonly factory?: CustomParamFactory;
  readonly schema?: StandardSchemaV1;
  readonly passthrough?: boolean;
}

export interface HeaderMetadata {
  readonly name: string;
  readonly value: string;
}

export interface RedirectMetadata {
  readonly url: string;
  readonly statusCode?: number;
}

export interface ControllerOptions {
  path?: string | string[];
  host?: string | RegExp | Array<string | RegExp>;
  scope?: Scope;
  version?: VersionValue;
  durable?: boolean;
}

export interface ControllerMetadata {
  readonly path: string | string[];
  readonly host?: string | RegExp | Array<string | RegExp>;
  readonly scope?: Scope;
  readonly version?: VersionValue;
  readonly durable?: boolean;
}

export interface RouteMethodMetadata {
  readonly method: RouteHttpMethod;
  readonly path: string | string[];
  readonly handlerKey: string | symbol;
  readonly isSse?: boolean;
  readonly sseOptions?: SseOptions;
}

export interface RouteMetadata {
  readonly method: RouteHttpMethod;
  readonly path: string;
  readonly controller: Type<any>;
  readonly handlerKey: string | symbol;
  readonly parameters: readonly ParameterMetadata[];
  readonly httpCode?: number;
  readonly headers?: readonly HeaderMetadata[];
  readonly redirect?: RedirectMetadata;
  readonly renderTemplate?: string;
  readonly isSse?: boolean;
  readonly sseOptions?: SseOptions;
  readonly version?: VersionValue;
}

export interface RouteDefinition extends RouteMetadata {
  readonly fullPath: string;
  readonly controllerToken?: InjectionToken;
}
