import "reflect-metadata";

// Constants
export {
  DEFAULT_DB_CONNECTION,
  MONGOOSE_CONNECTION_NAME,
  MONGOOSE_MODULE_OPTIONS,
  RAW_OBJECT_DEFINITION,
} from "./mongoose.constants";

// Common Decorators & Utilities
export { InjectConnection, InjectModel } from "./common/mongoose.decorators";
export {
  getConnectionToken,
  getModelToken,
  handleRetry,
} from "./common/mongoose.utils";

// Schema / Prop / Virtual Decorators
export { Prop } from "./decorators/prop.decorator";
export { Schema } from "./decorators/schema.decorator";
export { Virtual } from "./decorators/virtual.decorator";

// Errors
export { CannotDetermineTypeError } from "./errors/cannot-determine-type.error";
export { MongooseError } from "./errors/mongoose.error";

// Factories
export { DefinitionsFactory } from "./factories/definitions.factory";
export { SchemaFactory } from "./factories/schema.factory";
export { VirtualsFactory } from "./factories/virtuals.factory";

// Metadata Storage
export {
  TypeMetadataStorage,
  TypeMetadataStorageHost,
} from "./storages/type-metadata.storage";

// Module & Providers
export { MongooseCoreModule } from "./mongoose-core.module";
export { MongooseModule } from "./mongoose.module";
export {
  createMongooseAsyncProviders,
  createMongooseProviders,
} from "./mongoose.providers";

// Pipes
export { IsObjectIdPipe } from "./pipes/is-object-id.pipe";
export { ParseObjectIdPipe } from "./pipes/parse-object-id.pipe";

// Utilities
export { raw } from "./utils/raw.util";

// Zero-Dependency Bun-Native Structural Driver
export { ObjectId } from "./driver/object-id";
export {
  MongooseSchema,
  MongooseSchemaType,
  MongooseVirtualType,
  SchemaTypes,
  type RegisteredHook,
} from "./driver/schema";
export {
  MongooseCollection,
  MongooseConnection,
  MongooseDocument,
  MongooseModel,
  MongooseQuery,
  createConnection,
  type DeleteResult,
  type PopulateOptions,
  type QueryOptions,
  type UpdateWriteOpResult,
} from "./driver/connection";

// Interfaces & Types
export type { AsyncModelFactory } from "./interfaces/async-model-factory.interface";
export type {
  DiscriminatorOptions,
  ModelDefinition,
} from "./interfaces/model-definition.interface";
export type {
  Auth,
  AuthMechanism,
  AuthMechanismProperties,
  AutoEncryptionOptions,
  ConnectionLike,
  ConnectOptions,
  DriverInfo,
  HydratedDocument,
  LogComponentSeveritiesClientOptions,
  LookupFunction,
  MongoDBLogWritable,
  MongooseModuleAsyncOptions,
  MongooseModuleFactoryOptions,
  MongooseModuleOptions,
  MongooseOptionsFactory,
  PkFactory,
  PxfObject,
  ReadConcernLevel,
  ReadConcernLike,
  ReadPreferenceMode,
  RuntimeAdapters,
  ServerApi,
  ServerMonitoringMode,
  TagSet,
  W,
} from "./interfaces/mongoose-options.interface";
export type {
  AnyObject,
  CollationOptions,
  CreateCollectionOptions,
  DocumentId,
  EncryptSchemaTypeOptions,
  HookMethod,
  IndexDefinition,
  IndexOptions,
  LeanOptions,
  MiddlewareOptions,
  MongooseSchemaLike,
  MongooseSchemaTypeLike,
  PluginFunction,
  PropOptions,
  SchemaDefinition,
  SchemaDefinitionProperty,
  SchemaOptions,
  SchemaTimestampsConfig,
  SchemaTypeConstructorLike,
  SchemaTypeOptions,
  SearchIndexDescription,
  TimeSeriesCollectionOptions,
  ToObjectOptions,
  Validator,
  ValidatorFunction,
  ValidatorMessageFn,
  VirtualOptions,
  VirtualTypeLike,
  VirtualTypeOptions,
  WriteConcernSettings,
} from "./interfaces/schema-types.interface";
export type { PropertyMetadata } from "./metadata/property-metadata.interface";
export type { SchemaMetadata } from "./metadata/schema-metadata.interface";
export type { VirtualMetadataInterface } from "./metadata/virtual-metadata.interface";
