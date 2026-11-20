import "reflect-metadata";

// Constants & Enums
export {
  DESIGN_METADATA_KEYS,
  METADATA_KEYS,
  type MetadataKey,
} from "./constants/metadata-keys";
export {
  APP_FILTER,
  APP_GUARD,
  APP_INTERCEPTOR,
  APP_PIPE,
  BODY_SANITIZED_SYMBOL,
  INQUIRER,
  REQUEST,
  REQUEST_CONTEXT,
  SSE_ABORT_CONTROLLER,
} from "./constants/tokens";
export {
  HttpStatus,
  RequestMethod,
  Scope,
  type HttpMethod,
  type RouteHttpMethod,
} from "./enums/scope.enum";
export { ShutdownSignal } from "./enums/shutdown-signal.enum";
export {
  VERSION_NEUTRAL,
  VersioningType,
} from "./enums/versioning.enum";

// Core Interfaces & Types
export {
  forwardRef,
  isForwardReference,
  type Abstract,
  type ForwardReference,
  type InjectionToken,
  type Type,
} from "./interfaces/type.interface";
export type {
  ClassProvider,
  ExistingProvider,
  FactoryDependency,
  FactoryProvider,
  InjectableMetadata,
  InjectableOptions,
  InjectTokenMetadata,
  OptionalFactoryDependency,
  PropertyInjectMetadata,
  Provider,
  ValueProvider,
} from "./interfaces/provider.interface";
export {
  isDynamicModule,
  type AutoDiscoverOptions,
  type DynamicModule,
  type ModuleExport,
  type ModuleImport,
  type ModuleMetadata,
} from "./interfaces/module.interface";
export type {
  BeforeApplicationShutdown,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  OnModuleDestroy,
  OnModuleInit,
  OnRequestDestroy,
} from "./interfaces/lifecycle.interface";
export type {
  ArgumentsHost,
  BunestInterceptor,
  BunestMiddleware,
  BunestModule,
  CallHandler,
  CanActivate,
  ContextType,
  ExceptionFilter,
  ExecutionContext,
  HttpArgumentsHost,
  MiddlewareConsumer,
  MiddlewareFunction,
  MiddlewareProxy,
  NextFunction,
  ResponseContext,
  RouteInfo,
  RpcArgumentsHost,
  WsArgumentsHost,
} from "./interfaces/pipeline.interface";
export type {
  ArgumentMetadata,
  ControllerMetadata,
  ControllerOptions,
  CustomParamFactory,
  HeaderMetadata,
  HttpRedirectResponse,
  ParamData,
  ParamDecoratorEnhancer,
  ParameterDecoratorOptions,
  ParameterMetadata,
  ParameterSource,
  Paramtype,
  PipeLike,
  PipeTransform,
  PlainLiteralObject,
  RawBodyRequest,
  RedirectMetadata,
  RequestMappingMetadata,
  ResponseDecoratorOptions,
  RouteDefinition,
  RouteMetadata,
  RouteMethodMetadata,
  RouteParamMetadata,
  SseOptions,
  UploadedFileInfo,
} from "./interfaces/http.interface";
export type {
  BunestApplicationOptions,
  ContentSecurityPolicyDirectiveValue,
  ContentSecurityPolicyOptions,
  CookieOptions,
  CookieSerializeOptions,
  CookiesOptions,
  CorsOptions,
  CorsOrigin,
  CsrfProtectionOptions,
  HttpSecurityHeadersOptions,
  HttpsOptions,
  InstrumentOptions,
  IntrospectionResult,
  MessageEvent,
  PreRequestHook,
  ReferrerPolicyToken,
  RouteConflictPolicy,
  RouteConflictPolicyLevel,
  RouteConflictPolicyObject,
  RouteResolutionStrategy,
  ScopeOptions,
  SseMessageEvent,
  StaticAssetsOptions,
  ValidationErrorFormat,
  ViewEngineRenderer,
} from "./interfaces/application.interface";
export type {
  ErrorHandler,
  HttpServer,
  INestApplication,
  INestApplicationContext,
  INestMicroservice,
  ITransportServer,
  NestApplicationOptions,
  NestHybridApplicationOptions,
  NestInterceptor,
  NestMiddleware,
  NestModule,
  RequestHandler,
  RouteMatchingOptions,
  RpcExceptionFilter,
  SecurityHeadersOptions,
  SecurityRequestHook,
  ValidationError,
  WebSocketAdapter,
  WsExceptionFilter,
  WsMessageHandler,
} from "./interfaces/nest-compat.interface";
export type {
  ClassTransformOptions,
  ErrorHttpStatusCode,
  TransformerPackage,
  TransformerPackageLike,
  ValidatorOptions,
  ValidatorPackage,
  ValidatorPackageLike,
} from "./interfaces/validation.interface";
export type {
  CustomVersioningOptions,
  HeaderVersioningOptions,
  MediaTypeVersioningOptions,
  UriVersioningOptions,
  VersionValue,
  VersioningCommonOptions,
  VersioningOptions,
} from "./interfaces/versioning.interface";
export type {
  ContextId,
  ContextIdResolver,
  ContextIdResolverFn,
  ContextIdStrategy,
  HostComponentInfo,
} from "./interfaces/durable-context.interface";
export type { MicroserviceInstance } from "./interfaces/microservice.interface";
export {
  isStandardSchema,
  type StandardSchemaV1,
  type StandardSchemaV1FailureResult,
  type StandardSchemaV1InferInput,
  type StandardSchemaV1InferOutput,
  type StandardSchemaV1Issue,
  type StandardSchemaV1Options,
  type StandardSchemaV1PathSegment,
  type StandardSchemaV1Props,
  type StandardSchemaV1Result,
  type StandardSchemaV1SuccessResult,
  type StandardSchemaV1Types,
} from "./interfaces/standard-schema.interface";

// Configurable Module Builder
export {
  CONFIGURABLE_MODULE_ID,
  ConfigurableModuleBuilder,
  type ConfigurableModuleAsyncOptions,
  type ConfigurableModuleBuilderOptions,
  type ConfigurableModuleCls,
  type ConfigurableModuleHost,
  type ConfigurableModuleOptionsFactory,
} from "./module/configurable-module.builder";

// Metadata Registry, Decorator Registry & Reflector
export {
  DecoratorRegistry,
  type BuiltInDecoratorKind,
  type DecoratorKind,
  type DecoratorRegistryEntry,
  type DecoratorRegistrySnapshot,
} from "./metadata/decorator-registry";
export {
  MetadataRegistry,
  getPrecompiledController,
  invalidateControllerCache,
  precompileController,
  wrapMethodDescriptor,
  type PrecompiledControllerDescriptor,
  type PrecompiledRouteDescriptor,
} from "./metadata/metadata-registry";
export {
  Reflector,
  type CreateDecoratorOptions,
  type CustomDecorator,
  type KeyedMetadataSource,
  type MetadataKeyInput,
  type ReflectableDecorator,
} from "./metadata/reflector";

// Exceptions
export {
  HttpException,
  IntrinsicException,
  type DescriptionAndOptions,
  type HttpExceptionBody,
  type HttpExceptionBodyMessage,
  type HttpExceptionOptions,
  type HttpExceptionResponse,
  type ValidationErrorDetail,
  type ValidationErrorResponse,
} from "./exceptions/http.exception";
export {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GatewayTimeoutException,
  GoneException,
  HttpVersionNotSupportedException,
  ImATeapotException,
  InternalServerErrorException,
  MethodNotAllowedException,
  MisdirectedException,
  NotAcceptableException,
  NotFoundException,
  NotImplementedException,
  PayloadTooLargeException,
  PreconditionFailedException,
  RequestTimeoutException,
  ServiceUnavailableException,
  TooManyRequestsException,
  UnauthorizedException,
  UnprocessableEntityException,
  UnsupportedMediaTypeException,
  type HttpExceptionInput,
} from "./exceptions/built-in.exceptions";

// Decorators
export {
  applyDecorators,
  type AnyDecorator,
  type ComposedDecorator,
} from "./decorators/apply-decorators";
export {
  AutoModule,
  Catch,
  Dependencies,
  Global,
  Inject,
  Injectable,
  Module,
  Optional,
  SetMetadata,
} from "./decorators/core.decorators";
export {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  PrimaryKey,
  Unique,
  UpdateDateColumn,
  getEntityColumns,
  getEntityIndexes,
  getEntitySchema,
  hasEntitySchema,
  type ColumnDataType,
  type ColumnGenerationStrategy,
  type ColumnOptions,
  type ColumnTransformer,
  type EntityColumnMetadata,
  type EntityIndexMetadata,
  type EntitySchemaMetadata,
  type EntitySchemaOptions,
  type IndexOptions,
  type UniqueOptions,
} from "./decorators/entity-schema.decorators";
export {
  All,
  Controller,
  Copy,
  Delete,
  Get,
  Head,
  Header,
  HttpCode,
  Lock,
  Mkcol,
  Move,
  Options,
  Patch,
  Post,
  Propfind,
  Proppatch,
  Put,
  QueryMethod,
  Redirect,
  Render,
  RequestMapping,
  Search,
  Sse,
  Unlock,
} from "./decorators/http.decorators";
export { Version } from "./decorators/version.decorator";
export {
  InheritMethodEnhancers,
  UseFilters,
  UseGuards,
  UseInterceptors,
  UseMiddleware,
  UsePipes,
  type ExceptionFilterLike,
  type GuardLike,
  type InterceptorLike,
  type MiddlewareLike,
} from "./decorators/enhancers.decorators";
export {
  createMethodAspectDecorator,
  getMethodAspects,
  hasMethodAspects,
  type MethodAspectContext,
  type MethodAspectFn,
  type MethodAspectHandler,
  type MethodAspectMetadata,
  type MethodAspectToken,
} from "./decorators/method-aspect.decorator";
export {
  Bind,
  Body,
  Cookies,
  createParamDecorator,
  Headers,
  HostParam,
  Ip,
  Next,
  Param,
  Query,
  RawBody,
  Req,
  Request,
  Res,
  Response,
  Session,
  SignedCookies,
  SseSignal,
  UploadedFile,
  UploadedFiles,
  type KeyedParamSchemaOptions,
} from "./decorators/params.decorators";

// Utilities
export {
  assignMetadata,
  flatten,
  mixin,
  stripProtoKeys,
} from "./utils/common.utils";

// HTTP Streaming
export {
  StreamableFile,
  type StreamableFileHeaders,
  type StreamableFileOptions,
  type StreamableFileSource,
  type StreamableHandlerResponse,
} from "./http/streamable-file";

// Mapped DTO Types
export {
  CompositionType,
  IntersectionType,
  OmitType,
  PartialType,
  PickType,
  applyIsOptionalDecorator,
  applyValidateIfDefinedDecorator,
  inheritPropertyInitializers,
  inheritTransformationMetadata,
  inheritValidationMetadata,
  registerMappedTypeMetadataHook,
  type MappedType,
  type MappedTypeMetadataHook,
  type MappedTypeOperation,
  type RemoveFieldsWithType,
} from "./mapped-types";

// Built-in Pipes, Validation & File Validators
export {
  DEFAULT_MAX_ERROR_MESSAGES_LENGTH,
  OMITTED_ERRORS_MESSAGE,
  resolveMaxErrorMessagesLength,
} from "./pipes/validation-errors.constants";
export {
  VALIDATION_PIPE_OPTIONS,
  ValidationPipe,
  type ValidationPipeOptions,
} from "./pipes/validation.pipe";
export {
  StandardSchemaValidationPipe,
  formatStandardSchemaIssues,
  formatStandardSchemaPath,
  type StandardSchemaValidationPipeOptions,
} from "./pipes/standard-schema-validation.pipe";
export {
  DefaultValuePipe,
  ParseArrayPipe,
  ParseBoolPipe,
  ParseDatePipe,
  ParseEnumPipe,
  ParseFloatPipe,
  ParseIntPipe,
  ParseUUIDPipe,
  type ParseArrayOptions,
  type ParseArrayPipeOptions,
  type ParseBoolPipeOptions,
  type ParseDatePipeOptions,
  type ParseEnumPipeOptions,
  type ParseFloatPipeOptions,
  type ParseIntPipeOptions,
  type ParsePipeOptions,
  type ParseUUIDPipeOptions,
  type UUIDVersion,
} from "./pipes/built-in.pipes";
export {
  FileTypeValidator,
  FileValidator,
  MaxFileSizeValidator,
  detectMagicMimeType,
  type FileTypeValidatorContext,
  type FileTypeValidatorOptions,
  type FileValidatorContext,
  type MaxFileSizeValidatorContext,
  type MaxFileSizeValidatorOptions,
} from "./pipes/file-validators";
export {
  ParseFilePipe,
  ParseFilePipeBuilder,
  type ParseFileOptions,
} from "./pipes/parse-file.pipe";

// Serialization
export {
  CLASS_SERIALIZER_OPTIONS,
  SerializeOptions,
  type ClassSerializerContextOptions,
  type StandardSchemaSerializerContextOptions,
  type StandardSchemaSerializerOptions,
} from "./serializer/serialize-options.decorator";
export {
  ClassSerializerInterceptor,
  type ClassSerializerInterceptorOptions,
} from "./serializer/class-serializer.interceptor";
export {
  STANDARD_SCHEMA_SERIALIZER_METADATA,
  StandardSchemaSerializerInterceptor,
  UseStandardSchema,
  type StandardSchemaSerializerInterceptorOptions,
  type StandardSchemaSerializerMetadata,
} from "./serializer/standard-schema-serializer.interceptor";

// Logger
export { type LogLevel, type LoggerService } from "./logger/logger.interface";
export {
  ALL_LOG_LEVELS,
  DEFAULT_REDACT_KEYS,
  Logger,
  type LogBufferRecord,
  type LoggerOptions,
} from "./logger/logger";
export {
  ConsoleLogger,
  LOG_LEVELS,
  filterLogLevels,
  type ConsoleLoggerOptions,
} from "./logger/console-logger";
