import type { ObjectId } from "../driver/object-id";

export type AnyObject = Record<string, any>;

export interface CollationOptions {
  locale: string;
  caseLevel?: boolean;
  caseFirst?: string;
  strength?: number;
  numericOrdering?: boolean;
  alternate?: string;
  maxVariable?: string;
  backwards?: boolean;
  normalization?: boolean;
}

export interface WriteConcernSettings {
  w?: number | "majority" | string;
  wtimeout?: number;
  wtimeoutMS?: number;
  j?: boolean;
  journal?: boolean;
}

export interface SchemaTimestampsConfig {
  createdAt?: boolean | string;
  updatedAt?: boolean | string;
  currentTime?: () => Date | number;
}

export interface ToObjectOptions<T = any> {
  getters?: boolean;
  virtuals?: boolean | string[];
  minimize?: boolean;
  transform?: (doc: T, ret: Record<string, any>, options: Record<string, any>) => any;
  depopulate?: boolean;
  versionKey?: boolean;
  flattenMaps?: boolean;
  flattenObjectIds?: boolean;
  useProjection?: boolean;
  aliases?: boolean;
  schemaFieldsOnly?: boolean;
}

export interface TimeSeriesCollectionOptions {
  timeField: string;
  metaField?: string;
  granularity?: "seconds" | "minutes" | "hours";
  bucketMaxSpanSeconds?: number;
  bucketRoundingSeconds?: number;
}

export interface LeanOptions {
  virtuals?: boolean | string[];
  getters?: boolean;
  defaults?: boolean;
  versionKey?: boolean;
  transform?: (doc: any) => any;
}

export interface CreateCollectionOptions {
  capped?: boolean;
  size?: number;
  max?: number;
  autoIndexId?: boolean;
  collation?: CollationOptions;
  expireAfterSeconds?: number;
  timeseries?: TimeSeriesCollectionOptions;
  [key: string]: any;
}

export interface EncryptSchemaTypeOptions {
  keyId?: string | Uint8Array | Array<string | Uint8Array>;
  algorithm?: string;
  queries?: string | Record<string, any>;
}

export interface IndexOptions {
  unique?: boolean;
  sparse?: boolean;
  background?: boolean;
  expireAfterSeconds?: number;
  name?: string;
  partialFilterExpression?: Record<string, any>;
  collation?: CollationOptions;
  weights?: Record<string, number>;
  default_language?: string;
  [key: string]: any;
}

export type IndexDefinition = Record<string, 1 | -1 | "text" | "2d" | "2dsphere" | "hashed" | boolean | string>;

export interface SearchIndexDescription {
  name?: string;
  type?: string;
  definition: Record<string, any>;
}

export type ValidatorMessageFn = (props: {
  value: any;
  path: string;
  type?: string;
  reason?: any;
}) => string;

export type ValidatorFunction<T = any> = (
  value: T,
  props?: Record<string, any>,
) => boolean | Promise<boolean>;

export interface Validator<T = any> {
  validator: ValidatorFunction<T>;
  message?: string | ValidatorMessageFn;
  type?: string;
  propsParameter?: boolean;
}

export interface VirtualTypeOptions<T = any> {
  ref?: string | ((doc: T) => string);
  localField?: string | ((doc: T) => string);
  foreignField?: string | ((doc: T) => string);
  justOne?: boolean;
  options?: Record<string, any>;
  count?: boolean;
  match?: Record<string, any> | ((doc: T) => Record<string, any>);
  limit?: number;
  skip?: number;
  perDocumentLimit?: number;
  get?: (value: any, virtual: any, doc: T) => any;
  set?: (value: any, virtual: any, doc: T) => void;
  [key: string]: any;
}

export interface VirtualOptions {
  options?: VirtualTypeOptions;
  subPath?: string;
  get?: (...args: any[]) => any;
  set?: (...args: any[]) => any;
}

export interface VirtualTypeLike<T = any> {
  path: string;
  options: VirtualTypeOptions<T>;
  getters: Array<(...args: any[]) => any>;
  setters: Array<(...args: any[]) => any>;
  get(fn: (...args: any[]) => any): this;
  set(fn: (...args: any[]) => any): this;
  applyGetters(value: any, scope: T): any;
  applySetters(value: any, scope: T): any;
}

export interface MiddlewareOptions {
  document?: boolean;
  query?: boolean;
  errorHandler?: boolean;
}

export type HookMethod =
  | "save"
  | "validate"
  | "init"
  | "deleteOne"
  | "deleteMany"
  | "updateOne"
  | "updateMany"
  | "replaceOne"
  | "find"
  | "findOne"
  | "findOneAndUpdate"
  | "findOneAndReplace"
  | "findOneAndDelete"
  | "countDocuments"
  | "estimatedDocumentCount"
  | "distinct"
  | "aggregate"
  | "insertMany"
  | "bulkWrite"
  | (string & {});

export type PluginFunction<T = any, POptions = any> = (
  schema: MongooseSchemaLike<T>,
  options?: POptions,
) => void;

export interface SchemaOptions {
  _id?: boolean;
  autoCreate?: boolean;
  autoIndex?: boolean;
  autoSearchIndex?: boolean;
  bufferCommands?: boolean;
  bufferTimeoutMS?: number;
  capped?: number | boolean | { size?: number; max?: number; autoIndexId?: boolean };
  castNonArrays?: boolean;
  collation?: CollationOptions;
  collection?: string;
  collectionOptions?: CreateCollectionOptions;
  discriminatorKey?: string;
  encryptionType?: "csfle" | "queryableEncryption";
  excludeIndexes?: boolean;
  expireAfterSeconds?: number;
  expires?: string | number;
  id?: boolean;
  lean?: boolean | LeanOptions;
  methods?: Record<string, (this: any, ...args: any[]) => unknown>;
  minimize?: boolean;
  optimisticConcurrency?: boolean | string[] | { exclude: string[] };
  overwriteModels?: boolean;
  pluginTags?: string[];
  query?: Record<string, (this: any, ...args: any[]) => any>;
  read?: string;
  readConcern?: {
    level: "local" | "available" | "majority" | "snapshot" | "linearizable";
  };
  safe?: boolean | { w?: number | string; wtimeout?: number; j?: boolean };
  selectPopulatedPaths?: boolean;
  shardKey?: Record<string, unknown>;
  skipVersioning?: { [key: string]: boolean };
  statics?: Record<string, (this: any, ...args: any[]) => unknown>;
  storeSubdocValidationError?: boolean;
  strict?: boolean | "throw";
  strictQuery?: boolean | "throw";
  strictRead?: boolean | "throw";
  suppressReservedKeysWarning?: boolean;
  timeseries?: TimeSeriesCollectionOptions;
  timestamps?: boolean | SchemaTimestampsConfig;
  toJSON?: ToObjectOptions;
  toObject?: ToObjectOptions;
  typeKey?: string;
  validateBeforeSave?: boolean;
  validateModifiedOnly?: boolean;
  versionKey?: string | false;
  virtuals?: Record<string, VirtualTypeOptions>;
  writeConcern?: WriteConcernSettings;
}

export interface SchemaTypeOptions<T = any> {
  type?: any;
  required?: boolean | [boolean, string] | ((this: any) => boolean) | [((this: any) => boolean), string];
  default?: T | ((this: any, doc?: any) => T);
  select?: boolean | number;
  validate?:
    | RegExp
    | ValidatorFunction<T>
    | Validator<T>
    | Array<Validator<T> | ValidatorFunction<T> | RegExp>;
  get?: (value: any, schematype?: any) => any;
  set?: (value: any, priorVal?: any, schematype?: any) => any;
  alias?: string | string[];
  immutable?: boolean | ((this: any, doc?: any) => boolean);
  transform?: (value: any) => any;
  index?: boolean | number | string | IndexOptions;
  unique?: boolean | [boolean, string];
  sparse?: boolean;
  text?: boolean;
  expires?: string | number;
  enum?:
    | Array<string | number | null>
    | ReadonlyArray<string | number | null>
    | { values: Array<string | number | null> | ReadonlyArray<string | number | null>; message?: string }
    | Record<string, string | number>;
  min?: number | Date | [number | Date, string | ValidatorMessageFn] | readonly [number | Date, string | ValidatorMessageFn];
  max?: number | Date | [number | Date, string | ValidatorMessageFn] | readonly [number | Date, string | ValidatorMessageFn];
  minlength?: number | [number, string | ValidatorMessageFn] | readonly [number, string | ValidatorMessageFn];
  minLength?: number | [number, string | ValidatorMessageFn] | readonly [number, string | ValidatorMessageFn];
  maxlength?: number | [number, string | ValidatorMessageFn] | readonly [number, string | ValidatorMessageFn];
  maxLength?: number | [number, string | ValidatorMessageFn] | readonly [number, string | ValidatorMessageFn];
  match?: RegExp | [RegExp, string] | readonly [RegExp, string];
  lowercase?: boolean;
  uppercase?: boolean;
  trim?: boolean;
  ref?: string | boolean | Function | AnyObject;
  refPath?: string | ((this: any, doc: any) => string);
  of?: any;
  auto?: boolean;
  encrypt?: EncryptSchemaTypeOptions;
  excludeIndexes?: boolean;
  minimize?: boolean;
  subtype?: number;
  allowNull?: boolean;
  checkRequired?: (v: any) => boolean;
  defaultOptions?: Record<string, any>;
  schema?: MongooseSchemaLike<any>;
  [key: string]: any;
}

export interface MongooseSchemaTypeLike<T = any> {
  path: string;
  instance: string;
  options: AnyObject;
  OptionsConstructor: SchemaTypeOptions<T>;
  validators: Validator<T>[];
  setters?: Array<(val?: unknown, priorVal?: unknown, doc?: any, options?: Record<string, any> | null) => unknown>;
  isRequired?: boolean;
  $conditionalHandlers: Record<string, (val: any, context: any) => any>;
  schema?: MongooseSchemaLike<any>;
  default(val: any): any;
  required(required: boolean, message?: string): MongooseSchemaTypeLike<T>;
  index(options: any): MongooseSchemaTypeLike<T>;
  unique(bool: boolean): MongooseSchemaTypeLike<T>;
  sparse(bool: boolean): MongooseSchemaTypeLike<T>;
  text(bool: boolean): MongooseSchemaTypeLike<T>;
  select(val: boolean): MongooseSchemaTypeLike<T>;
  immutable(bool: boolean): MongooseSchemaTypeLike<T>;
  allowNull(allowNull: boolean): MongooseSchemaTypeLike<T>;
  ref(ref: string | boolean | any): MongooseSchemaTypeLike<T>;
  get(fn: Function): MongooseSchemaTypeLike<T>;
  set(fn: Function): MongooseSchemaTypeLike<T>;
  transform(fn: (value: any) => any): MongooseSchemaTypeLike<T>;
  validate(
    obj: RegExp | Validator<T> | ValidatorFunction<T>,
    errorMsg?: string,
    type?: string,
  ): MongooseSchemaTypeLike<T>;
  validateAll(
    validators: Array<RegExp | Validator<T> | ValidatorFunction<T>>,
  ): MongooseSchemaTypeLike<T>;
  cast(val: any, doc?: any, init?: boolean, prev?: any, options?: any): any;
  checkRequired(checkRequired?: (v: any) => boolean): (v: any) => boolean;
  getEmbeddedSchemaType<TEmbedded = any>(): MongooseSchemaTypeLike<TEmbedded> | undefined;
  toJSONSchema(options?: { useBsonType?: boolean }): Record<string, any>;
}

export interface MongooseSchemaLike<TClass = any> {
  obj: Record<string, any>;
  paths: Record<string, MongooseSchemaTypeLike<any>>;
  options: SchemaOptions;
  methods: Record<string, (this: any, ...args: any[]) => unknown>;
  statics: Record<string, (this: any, ...args: any[]) => unknown>;
  query: Record<string, (this: any, ...args: any[]) => any>;
  virtuals: Record<string, VirtualTypeLike<TClass>>;
  discriminators?: Record<string, MongooseSchemaLike<any>>;
  childSchemas: Array<{ schema: MongooseSchemaLike<any>; model: any }>;

  add(obj: Record<string, any> | MongooseSchemaLike<any>, prefix?: string): this;
  remove(paths: string | string[]): this;
  eachPath(fn: (path: string, type: MongooseSchemaTypeLike<any>) => void): this;
  path(path: string, obj?: any): any;
  pathType(path: string): string;
  requiredPaths(invalidate?: boolean): string[];
  virtual(name: string, options?: VirtualTypeOptions<TClass>): VirtualTypeLike<TClass>;
  virtualpath(name: string): VirtualTypeLike<TClass> | undefined;
  index(fields: IndexDefinition, options?: IndexOptions): this;
  indexes(): Array<[IndexDefinition, IndexOptions]>;
  clearIndexes(): this;
  removeIndex(index: string | AnyObject): this;
  searchIndex(description: SearchIndexDescription): this;
  method(
    nameOrObj: string | Record<string, (this: any, ...args: any[]) => unknown>,
    fn?: (this: any, ...args: any[]) => unknown,
  ): this;
  static(
    nameOrObj: string | Record<string, (this: any, ...args: any[]) => unknown>,
    fn?: (this: any, ...args: any[]) => unknown,
  ): this;
  queryHelper(name: string, fn: (this: any, ...args: any[]) => any): this;
  pre(
    method: HookMethod | HookMethod[] | RegExp,
    optionsOrFn: MiddlewareOptions | ((this: any, ...args: any[]) => any),
    fn?: (this: any, ...args: any[]) => any,
  ): this;
  post(
    method: HookMethod | HookMethod[] | RegExp,
    optionsOrFn: MiddlewareOptions | ((this: any, ...args: any[]) => any),
    fn?: (this: any, ...args: any[]) => any,
  ): this;
  plugin<POptions = any>(fn: PluginFunction<TClass, POptions>, opts?: POptions): this;
  loadClass(model: Function, onlyVirtuals?: boolean): this;
  clone(): MongooseSchemaLike<TClass>;
  pick(paths: string[], options?: SchemaOptions): MongooseSchemaLike<any>;
  omit(paths: string[], options?: SchemaOptions): MongooseSchemaLike<any>;
  discriminator<DisSchema = MongooseSchemaLike<any>>(
    name: string,
    schema: DisSchema,
    value?: string,
  ): this;
  queue(name: string, args: any[]): this;

  // EventEmitter-compatible methods
  on(eventName: string | symbol, listener: (...args: any[]) => void): this;
  once(eventName: string | symbol, listener: (...args: any[]) => void): this;
  off(eventName: string | symbol, listener: (...args: any[]) => void): this;
  emit(eventName: string | symbol, ...args: any[]): boolean;
  addListener(eventName: string | symbol, listener: (...args: any[]) => void): this;
  removeListener(eventName: string | symbol, listener: (...args: any[]) => void): this;
  removeAllListeners(eventName?: string | symbol): this;
  prependListener(eventName: string | symbol, listener: (...args: any[]) => void): this;
  prependOnceListener(eventName: string | symbol, listener: (...args: any[]) => void): this;
  listeners(eventName: string | symbol): Array<(...args: any[]) => void>;
  rawListeners(eventName: string | symbol): Array<(...args: any[]) => void>;
  listenerCount(eventName: string | symbol, listener?: (...args: any[]) => void): number;
  eventNames(): Array<string | symbol>;
  getMaxListeners(): number;
  setMaxListeners(n: number): this;
}

export interface SchemaTypeConstructorLike {
  new (...args: any[]): any;
  prototype?: any;
  schemaName?: string;
  type?: any;
  toString(): string;
  valueOf(): unknown;
}

export type SchemaDefinitionProperty<T = any> =
  | SchemaTypeOptions<T>
  | MongooseSchemaLike<any>
  | MongooseSchemaTypeLike<T>
  | SchemaTypeConstructorLike
  | Array<SchemaDefinitionProperty<T>>
  | Record<string, any>;

export type SchemaDefinition<T = any> = {
  [path in keyof T]?: SchemaDefinitionProperty<T[path]>;
} & Record<string, SchemaDefinitionProperty<any>>;

/**
 * Options accepted by the `@Prop()` decorator.
 * Structurally compatible with upstream `@nestjs/mongoose` `PropOptions<T>`.
 */
export type PropOptions<T = any> =
  | Partial<SchemaTypeOptions<T>>
  | MongooseSchemaLike<any>
  | MongooseSchemaTypeLike<T>
  | SchemaTypeConstructorLike
  | Array<PropOptions<T>>
  | Record<string, any>;

export type DocumentId = ObjectId | string;
