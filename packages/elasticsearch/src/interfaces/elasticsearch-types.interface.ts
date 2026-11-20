export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface BasicAuth {
  username: string;
  password: string;
}

export interface ApiKeyAuth {
  apiKey: string | { id: string; api_key: string };
}

export interface BearerAuth {
  bearer: string;
}

export type ElasticsearchAuth = BasicAuth | ApiKeyAuth | BearerAuth;

export type Context = Record<string, unknown>;

export interface HttpAgentOptions {
  keepAlive?: boolean;
  keepAliveMsecs?: number;
  maxSockets?: number;
  maxFreeSockets?: number;
  timeout?: number;
  [key: string]: unknown;
}

export interface UndiciAgentOptions {
  connections?: number;
  pipelining?: number;
  keepAliveTimeout?: number;
  keepAliveMaxTimeout?: number;
  [key: string]: unknown;
}

export interface TlsConnectionOptions {
  ca?: string | Uint8Array | Array<string | Uint8Array>;
  cert?: string | Uint8Array | Array<string | Uint8Array>;
  key?: string | Uint8Array | Array<string | Uint8Array>;
  passphrase?: string;
  pfx?: string | Uint8Array;
  rejectUnauthorized?: boolean;
  servername?: string;
  [key: string]: unknown;
}

export interface NodeRoles {
  master: boolean;
  data: boolean;
  ingest: boolean;
  ml: boolean;
}

export interface NodeOptions {
  url: URL | string;
  id?: string;
  agent?: HttpAgentOptions | UndiciAgentOptions;
  ssl?: TlsConnectionOptions;
  headers?: Record<string, any>;
  roles?: NodeRoles;
}

export interface RedactionOptions {
  type?: "replace" | "remove" | "custom";
  replaceWith?: string;
  additionalKeys?: string[];
  headers?: {
    sensitive?: string[];
  };
  [key: string]: unknown;
}

export type AgentFn = (opts: NodeOptions) => unknown;
export type NodeFilterFn = (node: NodeConnectionState) => boolean;
export type NodeSelectorFn = (
  connections: NodeConnectionState[],
) => NodeConnectionState | null;
export type GenerateRequestIdFn = (
  params: TransportRequestParams,
  options: TransportRequestOptions,
) => string | number;

export interface NodeConnectionState {
  id: string;
  url: URL;
  headers: Record<string, string>;
  roles: NodeRoles;
  status: "alive" | "dead";
  deadCount: number;
  resurrectAt: number;
}

export interface ClientOptions {
  node?: string | string[] | NodeOptions | NodeOptions[];
  nodes?: string | string[] | NodeOptions | NodeOptions[];
  Connection?: new (...args: any[]) => any;
  ConnectionPool?: new (...args: any[]) => any;
  Transport?: new (...args: any[]) => any;
  Serializer?: new (...args: any[]) => any;
  maxRetries?: number;
  requestTimeout?: number;
  pingTimeout?: number;
  sniffInterval?: number | boolean;
  sniffOnStart?: boolean;
  sniffEndpoint?: string;
  sniffOnConnectionFault?: boolean;
  resurrectStrategy?: "ping" | "optimistic" | "none";
  compression?: boolean;
  tls?: TlsConnectionOptions;
  agent?: false | HttpAgentOptions | UndiciAgentOptions | AgentFn;
  nodeFilter?: NodeFilterFn;
  nodeSelector?: NodeSelectorFn;
  headers?: Record<string, any>;
  opaqueIdPrefix?: string;
  generateRequestId?: GenerateRequestIdFn;
  name?: string | symbol;
  auth?: ElasticsearchAuth;
  context?: Context;
  proxy?: string | URL;
  enableMetaHeader?: boolean;
  cloud?: { id: string };
  disablePrototypePoisoningProtection?: boolean | "proto" | "constructor";
  caFingerprint?: string;
  maxResponseSize?: number;
  maxCompressedResponseSize?: number;
  maxPathLength?: number | null;
  redaction?: RedactionOptions;
  serverMode?: "stack" | "serverless";
  /** Bunest-native optional custom fetch implementation (great for unit testing). */
  fetch?: FetchLike;
}

export interface TransportRequestParams {
  method: string;
  path: string;
  querystring?: Record<string, any> | string;
  body?: unknown;
  ndjson?: boolean;
  headers?: Record<string, any>;
}

export interface TransportRequestOptions {
  ignore?: number[];
  requestTimeout?: number;
  maxRetries?: number;
  headers?: Record<string, any>;
  querystring?: Record<string, any>;
  context?: Context;
  opaqueId?: string;
  meta?: boolean;
  compression?: boolean;
  signal?: AbortSignal;
}

export interface TransportRequestOptionsWithOutMeta
  extends TransportRequestOptions {
  meta?: false;
}

export interface TransportRequestOptionsWithMeta
  extends TransportRequestOptions {
  meta: true;
}

export interface TransportResult<TBody = any> {
  body: TBody;
  statusCode: number;
  headers: Record<string, string>;
  warnings: string[];
  meta: {
    context: Context | null;
    name: string | symbol;
    request: {
      params: TransportRequestParams;
      options: TransportRequestOptions;
      id: string | number;
    };
    connection: {
      url: string;
      id: string;
    };
    attempts: number;
    aborted: boolean;
  };
}

// Common Elasticsearch REST Request & Response Types
export type EsParams = Record<string, any>;

export interface PingRequest extends EsParams {
  error_trace?: boolean;
  human?: boolean;
  pretty?: boolean;
}
export type PingResponse = boolean;

export interface InfoRequest extends EsParams {
  error_trace?: boolean;
  human?: boolean;
  pretty?: boolean;
}
export interface InfoResponse {
  name: string;
  cluster_name: string;
  cluster_uuid: string;
  version: {
    number: string;
    build_flavor?: string;
    build_type?: string;
    build_hash?: string;
    build_date?: string;
    build_snapshot?: boolean;
    lucene_version?: string;
    minimum_wire_compatibility_version?: string;
    minimum_index_compatibility_version?: string;
  };
  tagline: string;
  [key: string]: any;
}

export interface ShardsResponse {
  total: number;
  successful: number;
  skipped?: number;
  failed: number;
  failures?: Array<Record<string, any>>;
}

export interface SearchHit<TDocument = unknown> {
  _index: string;
  _id?: string;
  _score?: number | null;
  _source?: TDocument;
  _version?: number;
  _seq_no?: number;
  _primary_term?: number;
  fields?: Record<string, any>;
  highlight?: Record<string, string[]>;
  sort?: Array<string | number | boolean | null>;
  [key: string]: any;
}

export interface SearchTotalHits {
  value: number;
  relation: "eq" | "gte";
}

export interface SearchRequest extends EsParams {
  index?: string | string[];
  query?: Record<string, any>;
  aggs?: Record<string, any>;
  aggregations?: Record<string, any>;
  from?: number;
  size?: number;
  sort?: any;
  _source?: boolean | string | string[] | { includes?: string[]; excludes?: string[] };
  highlight?: Record<string, any>;
  scroll?: string;
  pit?: { id: string; keep_alive?: string };
  search_after?: any[];
  track_total_hits?: boolean | number;
  routing?: string;
  preference?: string;
  q?: string;
  body?: Record<string, any>;
}

export interface SearchResponse<
  TDocument = unknown,
  TAggregations = Record<string, any>,
> {
  took: number;
  timed_out: boolean;
  _shards: ShardsResponse;
  hits: {
    total?: SearchTotalHits | number;
    max_score?: number | null;
    hits: Array<SearchHit<TDocument>>;
  };
  aggregations?: TAggregations;
  _scroll_id?: string;
  pit_id?: string;
  [key: string]: any;
}

export interface IndexRequest<TDocument = unknown> extends EsParams {
  index: string;
  id?: string;
  document?: TDocument;
  body?: TDocument;
  refresh?: boolean | "wait_for";
  routing?: string;
  pipeline?: string;
  op_type?: "index" | "create";
  timeout?: string;
  version?: number;
  version_type?: string;
  if_seq_no?: number;
  if_primary_term?: number;
}

export interface IndexResponse {
  _index: string;
  _id: string;
  _version: number;
  result: "created" | "updated" | "noop";
  _shards: ShardsResponse;
  _seq_no: number;
  _primary_term: number;
  [key: string]: any;
}

export interface CreateRequest<TDocument = unknown> extends EsParams {
  index: string;
  id: string;
  document?: TDocument;
  body?: TDocument;
  refresh?: boolean | "wait_for";
  routing?: string;
  pipeline?: string;
  timeout?: string;
}

export type CreateResponse = IndexResponse;

export interface GetRequest extends EsParams {
  index: string;
  id: string;
  _source?: boolean | string | string[];
  _source_includes?: string[];
  _source_excludes?: string[];
  routing?: string;
  realtime?: boolean;
  refresh?: boolean;
  stored_fields?: string[];
  version?: number;
}

export interface GetResponse<TDocument = unknown> {
  _index: string;
  _id: string;
  _version?: number;
  _seq_no?: number;
  _primary_term?: number;
  found: boolean;
  _source?: TDocument;
  fields?: Record<string, any>;
  [key: string]: any;
}

export interface GetSourceRequest extends GetRequest {}
export type GetSourceResponse<TDocument = unknown> = TDocument;

export interface UpdateRequest<
  TDocument = unknown,
  TPartialDocument = Partial<TDocument>,
> extends EsParams {
  index: string;
  id: string;
  doc?: TPartialDocument;
  script?: string | Record<string, any>;
  upsert?: TDocument;
  doc_as_upsert?: boolean;
  _source?: boolean | string | string[];
  refresh?: boolean | "wait_for";
  routing?: string;
  retry_on_conflict?: number;
  body?: Record<string, any>;
}

export interface UpdateResponse<TDocument = unknown> {
  _index: string;
  _id: string;
  _version: number;
  result: "updated" | "created" | "noop" | "deleted";
  _shards: ShardsResponse;
  _seq_no: number;
  _primary_term: number;
  get?: {
    found: boolean;
    _source?: TDocument;
  };
  [key: string]: any;
}

export interface DeleteRequest extends EsParams {
  index: string;
  id: string;
  refresh?: boolean | "wait_for";
  routing?: string;
  timeout?: string;
  version?: number;
  if_seq_no?: number;
  if_primary_term?: number;
}

export interface DeleteResponse {
  _index: string;
  _id: string;
  _version: number;
  result: "deleted" | "not_found";
  _shards: ShardsResponse;
  _seq_no: number;
  _primary_term: number;
  [key: string]: any;
}

export interface BulkRequest<
  TDocument = unknown,
  TPartialDocument = Partial<TDocument>,
> extends EsParams {
  index?: string;
  operations?: Array<Record<string, any> | TDocument | TPartialDocument>;
  body?: Array<Record<string, any> | TDocument | TPartialDocument>;
  refresh?: boolean | "wait_for";
  routing?: string;
  pipeline?: string;
  timeout?: string;
}

export interface BulkResponse {
  took: number;
  errors: boolean;
  items: Array<Record<string, any>>;
  [key: string]: any;
}

export interface CountRequest extends EsParams {
  index?: string | string[];
  query?: Record<string, any>;
  q?: string;
  routing?: string;
  body?: Record<string, any>;
}

export interface CountResponse {
  count: number;
  _shards: ShardsResponse;
}

export interface ExistsRequest extends EsParams {
  index: string;
  id: string;
  routing?: string;
  refresh?: boolean;
}
export type ExistsResponse = boolean;

export interface ExistsSourceRequest extends ExistsRequest {}
export type ExistsSourceResponse = boolean;

export interface MgetRequest extends EsParams {
  index?: string;
  ids?: string[];
  docs?: Array<{ _index?: string; _id: string; _source?: any; routing?: string }>;
  body?: Record<string, any>;
}

export interface MgetResponse<TDocument = unknown> {
  docs: Array<GetResponse<TDocument> & { error?: any }>;
}

export interface MsearchRequest extends EsParams {
  index?: string | string[];
  searches?: Array<Record<string, any>>;
  body?: Array<Record<string, any>>;
  max_concurrent_searches?: number;
}

export interface MsearchResponse<
  TDocument = unknown,
  TAggregations = Record<string, any>,
> {
  took: number;
  responses: Array<SearchResponse<TDocument, TAggregations> & { status?: number; error?: any }>;
}

export interface ScrollRequest extends EsParams {
  scroll_id: string;
  scroll?: string;
}

export type ScrollResponse<
  TDocument = unknown,
  TAggregations = Record<string, any>,
> = SearchResponse<TDocument, TAggregations>;

export interface ClearScrollRequest extends EsParams {
  scroll_id?: string | string[];
}

export interface ClearScrollResponse {
  succeeded: boolean;
  num_freed: number;
}

export interface OpenPointInTimeRequest extends EsParams {
  index: string | string[];
  keep_alive: string;
}

export interface OpenPointInTimeResponse {
  id: string;
}

export interface ClosePointInTimeRequest extends EsParams {
  id: string;
}

export interface ClosePointInTimeResponse {
  succeeded: boolean;
  num_freed: number;
}

export interface DeleteByQueryRequest extends EsParams {
  index: string | string[];
  query?: Record<string, any>;
  conflicts?: "abort" | "proceed";
  refresh?: boolean;
  max_docs?: number;
  scroll_size?: number;
  wait_for_completion?: boolean;
  body?: Record<string, any>;
}

export interface DeleteByQueryResponse {
  took?: number;
  timed_out?: boolean;
  total?: number;
  deleted?: number;
  batches?: number;
  version_conflicts?: number;
  noops?: number;
  failures?: any[];
  task?: string;
  [key: string]: any;
}

export interface UpdateByQueryRequest extends EsParams {
  index: string | string[];
  query?: Record<string, any>;
  script?: string | Record<string, any>;
  conflicts?: "abort" | "proceed";
  refresh?: boolean;
  max_docs?: number;
  wait_for_completion?: boolean;
  body?: Record<string, any>;
}

export interface UpdateByQueryResponse {
  took?: number;
  timed_out?: boolean;
  total?: number;
  updated?: number;
  deleted?: number;
  batches?: number;
  version_conflicts?: number;
  noops?: number;
  failures?: any[];
  task?: string;
  [key: string]: any;
}

export interface ReindexRequest extends EsParams {
  source: Record<string, any>;
  dest: Record<string, any>;
  script?: string | Record<string, any>;
  conflicts?: "abort" | "proceed";
  refresh?: boolean;
  max_docs?: number;
  wait_for_completion?: boolean;
}

export interface ReindexResponse {
  took?: number;
  timed_out?: boolean;
  total?: number;
  created?: number;
  updated?: number;
  deleted?: number;
  batches?: number;
  failures?: any[];
  task?: string;
  [key: string]: any;
}
