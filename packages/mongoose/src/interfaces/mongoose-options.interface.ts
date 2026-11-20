import type { ModuleMetadata, Type } from "@bunest/common";
import type { MongooseError } from "../errors/mongoose.error";
import type { ObjectId } from "../driver/object-id";
import type {
  MongooseSchemaLike,
  WriteConcernSettings,
} from "./schema-types.interface";

export interface Auth {
  username?: string;
  password?: string;
}

export type AuthMechanism =
  | "DEFAULT"
  | "GSSAPI"
  | "MONGODB-AWS"
  | "MONGODB-CR"
  | "MONGODB-OIDC"
  | "MONGODB-X509"
  | "PLAIN"
  | "SCRAM-SHA-1"
  | "SCRAM-SHA-256"
  | (string & {});

export type AuthMechanismProperties = Record<string, any>;

export interface AutoEncryptionOptions {
  keyVaultNamespace?: string;
  kmsProviders?: Record<string, any>;
  schemaMap?: Record<string, any>;
  bypassAutoEncryption?: boolean;
  extraOptions?: Record<string, any>;
  [key: string]: any;
}

export interface DriverInfo {
  name?: string;
  version?: string;
  platform?: string;
}

export interface PkFactory {
  createPk(): any;
}

export type ReadConcernLevel =
  | "local"
  | "majority"
  | "linearizable"
  | "available"
  | "snapshot";

export interface ReadConcernLike {
  level: ReadConcernLevel;
}

export type ReadPreferenceMode =
  | "primary"
  | "primaryPreferred"
  | "secondary"
  | "secondaryPreferred"
  | "nearest";

export type TagSet = Record<string, string>;

export interface ServerApi {
  version: "1" | (string & {});
  strict?: boolean;
  deprecationErrors?: boolean;
}

export type ServerMonitoringMode = "auto" | "poll" | "stream";

export type W = number | "majority" | string;

export interface LogComponentSeveritiesClientOptions {
  command?: string;
  topology?: string;
  serverSelection?: string;
  connection?: string;
  default?: string;
  [key: string]: string | undefined;
}

export interface MongoDBLogWritable {
  write(entry: Record<string, any>): void;
}

export interface RuntimeAdapters {
  [key: string]: any;
}

export interface PxfObject {
  buf: string | Uint8Array;
  passphrase?: string;
}

export type LookupFunction = (
  hostname: string,
  options: Record<string, any>,
  callback: (err: Error | null, address: string, family: number) => void,
) => void;

export interface ConnectOptions {
  allowPartialTrustChain?: boolean;
  ALPNProtocols?: readonly string[] | ArrayBufferView;
  appName?: string;
  auth?: Auth;
  authMechanism?: AuthMechanism;
  authMechanismProperties?: AuthMechanismProperties;
  authSource?: string;
  autoCreate?: boolean;
  autoEncryption?: AutoEncryptionOptions;
  autoIndex?: boolean;
  autoSelectFamily?: boolean;
  autoSelectFamilyAttemptTimeout?: number;
  bsonRegExp?: boolean;
  bufferCommands?: boolean;
  ca?: string | Uint8Array | Array<string | Uint8Array>;
  cert?: string | Uint8Array | Array<string | Uint8Array>;
  checkKeys?: boolean;
  checkServerIdentity?: (hostname: string, cert: any) => Error | undefined;
  ciphers?: string;
  compressors?: string | Array<"none" | "snappy" | "zlib" | "zstd">;
  connectTimeoutMS?: number;
  crl?: string | Uint8Array | Array<string | Uint8Array>;
  dbName?: string;
  directConnection?: boolean;
  driverInfo?: DriverInfo;
  ecdhCurve?: string;
  enableOverloadRetargeting?: boolean;
  enableUtf8Validation?: boolean;
  family?: number;
  fieldsAsRaw?: Record<string, any>;
  forceServerObjectId?: boolean;
  heartbeatFrequencyMS?: number;
  hints?: number;
  ignoreUndefined?: boolean;
  journal?: boolean;
  keepAliveInitialDelay?: number;
  key?: string | Uint8Array | Array<string | Uint8Array | Record<string, any>>;
  loadBalanced?: boolean;
  localAddress?: string;
  localPort?: number;
  localThresholdMS?: number;
  lookup?: LookupFunction;
  maxAdaptiveRetries?: number;
  maxConnecting?: number;
  maxIdleTimeMS?: number;
  maxPoolSize?: number;
  maxStalenessSeconds?: number;
  minDHSize?: number;
  minHeartbeatFrequencyMS?: number;
  minPoolSize?: number;
  mongodbLogComponentSeverities?: LogComponentSeveritiesClientOptions;
  mongodbLogMaxDocumentLength?: number;
  mongodbLogPath?: "stderr" | "stdout" | MongoDBLogWritable;
  monitorCommands?: boolean;
  noDelay?: boolean;
  pass?: string;
  passphrase?: string;
  pfx?: string | Uint8Array | Array<string | Uint8Array | PxfObject>;
  pkFactory?: PkFactory;
  promoteBuffers?: boolean;
  promoteLongs?: boolean;
  promoteValues?: boolean;
  proxyHost?: string;
  proxyPassword?: string;
  proxyPort?: number;
  proxyUsername?: string;
  raw?: boolean;
  readConcern?: ReadConcernLike;
  readConcernLevel?: ReadConcernLevel;
  readPreference?: ReadPreferenceMode | Record<string, any>;
  readPreferenceTags?: TagSet[];
  rejectUnauthorized?: boolean;
  replicaSet?: string;
  retryReads?: boolean;
  retryWrites?: boolean;
  runtimeAdapters?: RuntimeAdapters;
  sanitizeFilter?: boolean;
  secureContext?: Record<string, any>;
  secureProtocol?: string;
  serializeFunctions?: boolean;
  serverApi?: ServerApi | "1";
  serverMonitoringMode?: ServerMonitoringMode;
  servername?: string;
  serverSelectionTimeoutMS?: number;
  session?: Uint8Array;
  socketTimeoutMS?: number;
  srvAllowedHostsSuffix?: string;
  srvHostValidator?: (host: string) => boolean;
  srvMaxHosts?: number;
  srvServiceName?: string;
  ssl?: boolean;
  timeoutMS?: number;
  tls?: boolean;
  tlsAllowInvalidCertificates?: boolean;
  tlsAllowInvalidHostnames?: boolean;
  tlsCAFile?: string;
  tlsCertificateKeyFile?: string;
  tlsCertificateKeyFilePassword?: string;
  tlsCRLFile?: string;
  tlsInsecure?: boolean;
  useBigInt64?: boolean;
  user?: string;
  w?: W;
  waitQueueTimeoutMS?: number;
  writeConcern?: WriteConcernSettings;
  wtimeoutMS?: number;
  zlibCompressionLevel?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
}

export interface ConnectionLike {
  readonly name: string;
  readonly readyState: number;
  readonly models: Record<string, any>;
  model<T = any>(
    name: string,
    schema?: MongooseSchemaLike<T> | any,
    collection?: string,
  ): any;
  modelNames?(): string[];
  deleteModel?(name: string | RegExp): this;
  plugin?(fn: (schema: any, opts?: any) => void, opts?: any): this;
  asPromise?(): Promise<this>;
  close(force?: boolean): Promise<void>;
  destroy?(force?: boolean): Promise<void>;
}

export type HydratedDocument<T, TMethods = Record<string, unknown>> = T &
  TMethods & {
    _id: ObjectId;
    id: string;
    __v?: number;
    isNew: boolean;
    save(): Promise<HydratedDocument<T, TMethods>>;
    deleteOne(): Promise<{ acknowledged: boolean; deletedCount: number }>;
    toObject(options?: Record<string, any>): T & { _id: ObjectId; id?: string };
    toJSON(options?: Record<string, any>): Record<string, any>;
    validate(): Promise<void>;
    isModified(path?: string): boolean;
    markModified(path: string): void;
    populate(path: string | Record<string, any> | Array<string | Record<string, any>>): Promise<HydratedDocument<T, TMethods>>;
  };

export interface MongooseModuleOptions extends ConnectOptions {
  uri?: string;
  retryAttempts?: number;
  retryDelay?: number;
  connectionName?: string;
  connectionFactory?: (connection: any, name: string) => any;
  connectionErrorFactory?: (error: MongooseError) => MongooseError;
  lazyConnection?: boolean;
  onConnectionCreate?: (connection: ConnectionLike) => void;
  verboseRetryLog?: boolean;
}

export type MongooseModuleFactoryOptions = Omit<
  MongooseModuleOptions,
  "connectionName"
>;

export interface MongooseOptionsFactory {
  createMongooseOptions():
    | Promise<MongooseModuleOptions>
    | MongooseModuleOptions;
}

export interface MongooseModuleAsyncOptions
  extends Pick<ModuleMetadata, "imports"> {
  connectionName?: string;
  useExisting?: Type<MongooseOptionsFactory>;
  useClass?: Type<MongooseOptionsFactory>;
  useFactory?: (
    ...args: any[]
  ) => Promise<MongooseModuleFactoryOptions> | MongooseModuleFactoryOptions;
  inject?: any[];
}
