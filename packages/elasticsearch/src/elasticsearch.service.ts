import { Inject, Injectable, Optional } from "@bunest/common";
import { ELASTICSEARCH_MODULE_OPTIONS } from "./elasticsearch.constants";
import type { ElasticsearchModuleOptions } from "./interfaces/elasticsearch-module-options.interface";
import type {
  BulkRequest,
  BulkResponse,
  ClearScrollRequest,
  ClearScrollResponse,
  ClientOptions,
  ClosePointInTimeRequest,
  ClosePointInTimeResponse,
  CountRequest,
  CountResponse,
  CreateRequest,
  CreateResponse,
  DeleteByQueryRequest,
  DeleteByQueryResponse,
  DeleteRequest,
  DeleteResponse,
  EsParams,
  ExistsRequest,
  ExistsResponse,
  ExistsSourceRequest,
  ExistsSourceResponse,
  GetRequest,
  GetResponse,
  GetSourceRequest,
  GetSourceResponse,
  IndexRequest,
  IndexResponse,
  InfoRequest,
  InfoResponse,
  MgetRequest,
  MgetResponse,
  MsearchRequest,
  MsearchResponse,
  OpenPointInTimeRequest,
  OpenPointInTimeResponse,
  PingRequest,
  PingResponse,
  ReindexRequest,
  ReindexResponse,
  ScrollRequest,
  ScrollResponse,
  SearchRequest,
  SearchResponse,
  TransportRequestOptions,
  TransportRequestOptionsWithMeta,
  TransportRequestOptionsWithOutMeta,
  TransportResult,
  UpdateByQueryRequest,
  UpdateByQueryResponse,
  UpdateRequest,
  UpdateResponse,
} from "./interfaces/elasticsearch-types.interface";
import {
  AsyncSearchApi,
  CatApi,
  ClusterApi,
  ElasticsearchHelpers,
  EsqlApi,
  IlmApi,
  IndicesApi,
  IngestApi,
  NodesApi,
  RestNamespaceApi,
  SecurityApi,
  SnapshotApi,
  SqlApi,
  TasksApi,
  dispatchRequest,
  encodeSegment,
  splitParams,
} from "./namespaces/elasticsearch-namespaces";
import type { ElasticsearchConnectionPool } from "./transport/connection-pool";
import type { ElasticsearchDiagnostic } from "./transport/diagnostic";
import { ElasticsearchTransport } from "./transport/elasticsearch-transport";
import type { ElasticsearchSerializer } from "./transport/serializer";

const SEARCH_BODY_KEYS = [
  "aggs",
  "aggregations",
  "collapse",
  "docvalue_fields",
  "explain",
  "ext",
  "fields",
  "from",
  "highlight",
  "indices_boost",
  "knn",
  "min_score",
  "pit",
  "post_filter",
  "profile",
  "query",
  "rank",
  "rescore",
  "retriever",
  "runtime_mappings",
  "script_fields",
  "search_after",
  "seq_no_primary_term",
  "size",
  "slice",
  "sort",
  "_source",
  "stats",
  "stored_fields",
  "suggest",
  "terminate_after",
  "timeout",
  "track_scores",
  "track_total_hits",
  "version",
] as const;

const SHARED_INTERNALS = Symbol.for("@bunest/elasticsearch.sharedInternals");

interface SharedTransportInternals {
  connectionPool?: ElasticsearchConnectionPool;
  serializer?: ElasticsearchSerializer;
  diagnostic?: ElasticsearchDiagnostic;
}

@Injectable()
export class ElasticsearchService {
  readonly name: string | symbol;
  readonly connectionPool: ElasticsearchConnectionPool;
  readonly transport: ElasticsearchTransport;
  readonly serializer: ElasticsearchSerializer;
  readonly diagnostic: ElasticsearchDiagnostic;
  readonly helpers: ElasticsearchHelpers;

  // Core & extended Elasticsearch API namespaces (exact @elastic/elasticsearch v9 surface)
  readonly asyncSearch: AsyncSearchApi;
  readonly autoscaling: RestNamespaceApi;
  readonly cat: CatApi;
  readonly ccr: RestNamespaceApi;
  readonly cluster: ClusterApi;
  readonly connector: RestNamespaceApi;
  readonly danglingIndices: RestNamespaceApi;
  readonly encryption: RestNamespaceApi;
  readonly enrich: RestNamespaceApi;
  readonly eql: RestNamespaceApi;
  readonly esql: EsqlApi;
  readonly features: RestNamespaceApi;
  readonly fleet: RestNamespaceApi;
  readonly graph: RestNamespaceApi;
  readonly ilm: IlmApi;
  readonly indices: IndicesApi;
  readonly inference: RestNamespaceApi;
  readonly ingest: IngestApi;
  readonly license: RestNamespaceApi;
  readonly logstash: RestNamespaceApi;
  readonly migration: RestNamespaceApi;
  readonly ml: RestNamespaceApi;
  readonly monitoring: RestNamespaceApi;
  readonly nodes: NodesApi;
  readonly profiling: RestNamespaceApi;
  readonly project: RestNamespaceApi;
  readonly queryRules: RestNamespaceApi;
  readonly rollup: RestNamespaceApi;
  readonly searchableSnapshots: RestNamespaceApi;
  readonly searchApplication: RestNamespaceApi;
  readonly security: SecurityApi;
  readonly shutdown: RestNamespaceApi;
  readonly simulate: RestNamespaceApi;
  readonly slm: RestNamespaceApi;
  readonly snapshot: SnapshotApi;
  readonly sql: SqlApi;
  readonly ssl: RestNamespaceApi;
  readonly streams: RestNamespaceApi;
  readonly synonyms: RestNamespaceApi;
  readonly tasks: TasksApi;
  readonly textStructure: RestNamespaceApi;
  readonly transform: RestNamespaceApi;
  readonly watcher: RestNamespaceApi;
  readonly xpack: RestNamespaceApi;

  private readonly clientOptions: ElasticsearchModuleOptions;

  constructor(
    @Optional()
    @Inject(ELASTICSEARCH_MODULE_OPTIONS)
    options: ElasticsearchModuleOptions = {},
  ) {
    const shared = (
      options as ElasticsearchModuleOptions & {
        [SHARED_INTERNALS]?: SharedTransportInternals;
      }
    )[SHARED_INTERNALS];
    this.clientOptions = { ...options };
    this.transport = new ElasticsearchTransport(this.clientOptions, shared);
    this.connectionPool = this.transport.connectionPool;
    this.serializer = this.transport.serializer;
    this.diagnostic = this.transport.diagnostic;
    this.name = this.transport.name;
    this.helpers = new ElasticsearchHelpers(this.transport);

    this.asyncSearch = new AsyncSearchApi(this.transport);
    this.autoscaling = new RestNamespaceApi(this.transport, "/_autoscaling");
    this.cat = new CatApi(this.transport);
    this.ccr = new RestNamespaceApi(this.transport, "/_ccr");
    this.cluster = new ClusterApi(this.transport);
    this.connector = new RestNamespaceApi(this.transport, "/_connector");
    this.danglingIndices = new RestNamespaceApi(this.transport, "/_dangling");
    this.encryption = new RestNamespaceApi(this.transport, "/_encryption");
    this.enrich = new RestNamespaceApi(this.transport, "/_enrich");
    this.eql = new RestNamespaceApi(this.transport, "/_eql");
    this.esql = new EsqlApi(this.transport);
    this.features = new RestNamespaceApi(this.transport, "/_features");
    this.fleet = new RestNamespaceApi(this.transport, "/_fleet");
    this.graph = new RestNamespaceApi(this.transport, "/_graph");
    this.ilm = new IlmApi(this.transport);
    this.indices = new IndicesApi(this.transport);
    this.inference = new RestNamespaceApi(this.transport, "/_inference");
    this.ingest = new IngestApi(this.transport);
    this.license = new RestNamespaceApi(this.transport, "/_license");
    this.logstash = new RestNamespaceApi(this.transport, "/_logstash");
    this.migration = new RestNamespaceApi(this.transport, "/_migration");
    this.ml = new RestNamespaceApi(this.transport, "/_ml");
    this.monitoring = new RestNamespaceApi(this.transport, "/_monitoring");
    this.nodes = new NodesApi(this.transport);
    this.profiling = new RestNamespaceApi(this.transport, "/_profiling");
    this.project = new RestNamespaceApi(this.transport, "/_project");
    this.queryRules = new RestNamespaceApi(this.transport, "/_query_rules");
    this.rollup = new RestNamespaceApi(this.transport, "/_rollup");
    this.searchableSnapshots = new RestNamespaceApi(
      this.transport,
      "/_searchable_snapshots",
    );
    this.searchApplication = new RestNamespaceApi(
      this.transport,
      "/_application/search_application",
    );
    this.security = new SecurityApi(this.transport);
    this.shutdown = new RestNamespaceApi(this.transport, "/_nodes/shutdown");
    this.simulate = new RestNamespaceApi(this.transport, "/_simulate");
    this.slm = new RestNamespaceApi(this.transport, "/_slm");
    this.snapshot = new SnapshotApi(this.transport);
    this.sql = new SqlApi(this.transport);
    this.ssl = new RestNamespaceApi(this.transport, "/_ssl");
    this.streams = new RestNamespaceApi(this.transport, "/_streams");
    this.synonyms = new RestNamespaceApi(this.transport, "/_synonyms");
    this.tasks = new TasksApi(this.transport);
    this.textStructure = new RestNamespaceApi(
      this.transport,
      "/_text_structure",
    );
    this.transform = new RestNamespaceApi(this.transport, "/_transform");
    this.watcher = new RestNamespaceApi(this.transport, "/_watcher");
    this.xpack = new RestNamespaceApi(this.transport, "/_xpack");
  }

  /**
   * Creates a child client sharing this client's connection pool while
   * allowing scoped headers, auth, context, or name overrides.
   */
  child(opts: ClientOptions): ElasticsearchService {
    const merged: ElasticsearchModuleOptions = {
      ...this.clientOptions,
      ...opts,
      headers: {
        ...(this.clientOptions.headers ?? {}),
        ...(opts.headers ?? {}),
      },
      context:
        this.clientOptions.context || opts.context
          ? { ...(this.clientOptions.context ?? {}), ...(opts.context ?? {}) }
          : undefined,
    };
    const childOptions: ElasticsearchModuleOptions & {
      [SHARED_INTERNALS]?: SharedTransportInternals;
    } = {
      ...merged,
      [SHARED_INTERNALS]: {
        connectionPool: this.connectionPool,
        serializer: this.serializer,
        diagnostic: this.diagnostic,
      },
    };
    return new ElasticsearchService(childOptions);
  }

  async close(): Promise<void> {
    await this.transport.close();
  }

  ping(
    params?: PingRequest,
    options?: TransportRequestOptionsWithOutMeta,
  ): Promise<PingResponse>;
  ping(
    params: PingRequest | undefined,
    options: TransportRequestOptionsWithMeta,
  ): Promise<TransportResult<PingResponse>>;
  async ping(
    params: PingRequest = {},
    options?: TransportRequestOptions,
  ): Promise<PingResponse | TransportResult<PingResponse>> {
    const { querystring } = splitParams(params, []);
    const res = await this.transport.request(
      { method: "HEAD", path: "/", querystring },
      {
        requestTimeout: options?.requestTimeout ?? this.transport.pingTimeout,
        ...options,
      },
    );
    const ok = res.statusCode >= 200 && res.statusCode < 300;
    return options?.meta ? { ...res, body: ok } : ok;
  }

  info(
    params?: InfoRequest,
    options?: TransportRequestOptionsWithOutMeta,
  ): Promise<InfoResponse>;
  info(
    params: InfoRequest | undefined,
    options: TransportRequestOptionsWithMeta,
  ): Promise<TransportResult<InfoResponse>>;
  info(
    params: InfoRequest = {},
    options?: TransportRequestOptions,
  ): Promise<InfoResponse | TransportResult<InfoResponse>> {
    const { querystring } = splitParams(params, []);
    return dispatchRequest<InfoResponse>(
      this.transport,
      { method: "GET", path: "/", querystring },
      options,
    );
  }

  search<TDocument = unknown, TAggregations = Record<string, any>>(
    params?: SearchRequest,
    options?: TransportRequestOptionsWithOutMeta,
  ): Promise<SearchResponse<TDocument, TAggregations>>;
  search<TDocument = unknown, TAggregations = Record<string, any>>(
    params: SearchRequest | undefined,
    options: TransportRequestOptionsWithMeta,
  ): Promise<TransportResult<SearchResponse<TDocument, TAggregations>>>;
  search<TDocument = unknown, TAggregations = Record<string, any>>(
    params: SearchRequest = {},
    options?: TransportRequestOptions,
  ): Promise<
    | SearchResponse<TDocument, TAggregations>
    | TransportResult<SearchResponse<TDocument, TAggregations>>
  > {
    const { querystring, body } = splitParams(
      params,
      ["index"],
      SEARCH_BODY_KEYS,
    );
    const path = params.index
      ? `/${encodeSegment(params.index)}/_search`
      : "/_search";
    return dispatchRequest<SearchResponse<TDocument, TAggregations>>(
      this.transport,
      { method: "POST", path, querystring, body },
      options,
    );
  }

  index<TDocument = unknown>(
    params: IndexRequest<TDocument>,
    options?: TransportRequestOptionsWithOutMeta,
  ): Promise<IndexResponse>;
  index<TDocument = unknown>(
    params: IndexRequest<TDocument>,
    options: TransportRequestOptionsWithMeta,
  ): Promise<TransportResult<IndexResponse>>;
  index<TDocument = unknown>(
    params: IndexRequest<TDocument>,
    options?: TransportRequestOptions,
  ): Promise<IndexResponse | TransportResult<IndexResponse>> {
    const { querystring } = splitParams(params, ["index", "id", "document"]);
    const docBody = params.document ?? params.body;
    const hasId = params.id !== undefined && params.id !== "";
    const method = hasId ? "PUT" : "POST";
    const path = hasId
      ? `/${encodeSegment(params.index)}/_doc/${encodeSegment(params.id!)}`
      : `/${encodeSegment(params.index)}/_doc`;
    return dispatchRequest<IndexResponse>(
      this.transport,
      { method, path, querystring, body: docBody },
      options,
    );
  }

  create<TDocument = unknown>(
    params: CreateRequest<TDocument>,
    options?: TransportRequestOptionsWithOutMeta,
  ): Promise<CreateResponse>;
  create<TDocument = unknown>(
    params: CreateRequest<TDocument>,
    options: TransportRequestOptionsWithMeta,
  ): Promise<TransportResult<CreateResponse>>;
  create<TDocument = unknown>(
    params: CreateRequest<TDocument>,
    options?: TransportRequestOptions,
  ): Promise<CreateResponse | TransportResult<CreateResponse>> {
    const { querystring } = splitParams(params, ["index", "id", "document"]);
    const docBody = params.document ?? params.body;
    return dispatchRequest<CreateResponse>(
      this.transport,
      {
        method: "PUT",
        path: `/${encodeSegment(params.index)}/_create/${encodeSegment(params.id)}`,
        querystring,
        body: docBody,
      },
      options,
    );
  }

  get<TDocument = unknown>(
    params: GetRequest,
    options?: TransportRequestOptionsWithOutMeta,
  ): Promise<GetResponse<TDocument>>;
  get<TDocument = unknown>(
    params: GetRequest,
    options: TransportRequestOptionsWithMeta,
  ): Promise<TransportResult<GetResponse<TDocument>>>;
  get<TDocument = unknown>(
    params: GetRequest,
    options?: TransportRequestOptions,
  ): Promise<GetResponse<TDocument> | TransportResult<GetResponse<TDocument>>> {
    const { querystring } = splitParams(params, ["index", "id"]);
    return dispatchRequest<GetResponse<TDocument>>(
      this.transport,
      {
        method: "GET",
        path: `/${encodeSegment(params.index)}/_doc/${encodeSegment(params.id)}`,
        querystring,
      },
      options,
    );
  }

  getSource<TDocument = unknown>(
    params: GetSourceRequest,
    options?: TransportRequestOptionsWithOutMeta,
  ): Promise<GetSourceResponse<TDocument>>;
  getSource<TDocument = unknown>(
    params: GetSourceRequest,
    options: TransportRequestOptionsWithMeta,
  ): Promise<TransportResult<GetSourceResponse<TDocument>>>;
  getSource<TDocument = unknown>(
    params: GetSourceRequest,
    options?: TransportRequestOptions,
  ): Promise<
    GetSourceResponse<TDocument> | TransportResult<GetSourceResponse<TDocument>>
  > {
    const { querystring } = splitParams(params, ["index", "id"]);
    return dispatchRequest<GetSourceResponse<TDocument>>(
      this.transport,
      {
        method: "GET",
        path: `/${encodeSegment(params.index)}/_source/${encodeSegment(params.id)}`,
        querystring,
      },
      options,
    );
  }

  update<
    TDocument = unknown,
    TPartialDocument = Partial<TDocument>,
    TDocumentR = TDocument,
  >(
    params: UpdateRequest<TDocument, TPartialDocument>,
    options?: TransportRequestOptionsWithOutMeta,
  ): Promise<UpdateResponse<TDocumentR>>;
  update<
    TDocument = unknown,
    TPartialDocument = Partial<TDocument>,
    TDocumentR = TDocument,
  >(
    params: UpdateRequest<TDocument, TPartialDocument>,
    options: TransportRequestOptionsWithMeta,
  ): Promise<TransportResult<UpdateResponse<TDocumentR>>>;
  update<
    TDocument = unknown,
    TPartialDocument = Partial<TDocument>,
    TDocumentR = TDocument,
  >(
    params: UpdateRequest<TDocument, TPartialDocument>,
    options?: TransportRequestOptions,
  ): Promise<
    UpdateResponse<TDocumentR> | TransportResult<UpdateResponse<TDocumentR>>
  > {
    const { querystring, body } = splitParams(
      params,
      ["index", "id"],
      ["doc", "doc_as_upsert", "script", "scripted_upsert", "upsert", "_source", "detect_noop"],
    );
    return dispatchRequest<UpdateResponse<TDocumentR>>(
      this.transport,
      {
        method: "POST",
        path: `/${encodeSegment(params.index)}/_update/${encodeSegment(params.id)}`,
        querystring,
        body,
      },
      options,
    );
  }

  delete(
    params: DeleteRequest,
    options?: TransportRequestOptionsWithOutMeta,
  ): Promise<DeleteResponse>;
  delete(
    params: DeleteRequest,
    options: TransportRequestOptionsWithMeta,
  ): Promise<TransportResult<DeleteResponse>>;
  delete(
    params: DeleteRequest,
    options?: TransportRequestOptions,
  ): Promise<DeleteResponse | TransportResult<DeleteResponse>> {
    const { querystring } = splitParams(params, ["index", "id"]);
    return dispatchRequest<DeleteResponse>(
      this.transport,
      {
        method: "DELETE",
        path: `/${encodeSegment(params.index)}/_doc/${encodeSegment(params.id)}`,
        querystring,
      },
      options,
    );
  }

  bulk<TDocument = unknown, TPartialDocument = Partial<TDocument>>(
    params: BulkRequest<TDocument, TPartialDocument>,
    options?: TransportRequestOptionsWithOutMeta,
  ): Promise<BulkResponse>;
  bulk<TDocument = unknown, TPartialDocument = Partial<TDocument>>(
    params: BulkRequest<TDocument, TPartialDocument>,
    options: TransportRequestOptionsWithMeta,
  ): Promise<TransportResult<BulkResponse>>;
  bulk<TDocument = unknown, TPartialDocument = Partial<TDocument>>(
    params: BulkRequest<TDocument, TPartialDocument>,
    options?: TransportRequestOptions,
  ): Promise<BulkResponse | TransportResult<BulkResponse>> {
    const { querystring } = splitParams(params, ["index", "operations"]);
    const ops = params.operations ?? params.body ?? [];
    const path = params.index
      ? `/${encodeSegment(params.index)}/_bulk`
      : "/_bulk";
    return dispatchRequest<BulkResponse>(
      this.transport,
      { method: "POST", path, querystring, body: ops, ndjson: true },
      options,
    );
  }

  count(
    params?: CountRequest,
    options?: TransportRequestOptionsWithOutMeta,
  ): Promise<CountResponse>;
  count(
    params: CountRequest | undefined,
    options: TransportRequestOptionsWithMeta,
  ): Promise<TransportResult<CountResponse>>;
  count(
    params: CountRequest = {},
    options?: TransportRequestOptions,
  ): Promise<CountResponse | TransportResult<CountResponse>> {
    const { querystring, body } = splitParams(params, ["index"], ["query"]);
    const path = params.index
      ? `/${encodeSegment(params.index)}/_count`
      : "/_count";
    return dispatchRequest<CountResponse>(
      this.transport,
      { method: "POST", path, querystring, body },
      options,
    );
  }

  exists(
    params: ExistsRequest,
    options?: TransportRequestOptionsWithOutMeta,
  ): Promise<ExistsResponse>;
  exists(
    params: ExistsRequest,
    options: TransportRequestOptionsWithMeta,
  ): Promise<TransportResult<ExistsResponse>>;
  async exists(
    params: ExistsRequest,
    options?: TransportRequestOptions,
  ): Promise<ExistsResponse | TransportResult<ExistsResponse>> {
    const { querystring } = splitParams(params, ["index", "id"]);
    const res = await this.transport.request(
      {
        method: "HEAD",
        path: `/${encodeSegment(params.index)}/_doc/${encodeSegment(params.id)}`,
        querystring,
      },
      { ...options, ignore: [...(options?.ignore ?? []), 404] },
    );
    const found = res.statusCode >= 200 && res.statusCode < 300;
    return options?.meta ? { ...res, body: found } : found;
  }

  existsSource(
    params: ExistsSourceRequest,
    options?: TransportRequestOptionsWithOutMeta,
  ): Promise<ExistsSourceResponse>;
  existsSource(
    params: ExistsSourceRequest,
    options: TransportRequestOptionsWithMeta,
  ): Promise<TransportResult<ExistsSourceResponse>>;
  async existsSource(
    params: ExistsSourceRequest,
    options?: TransportRequestOptions,
  ): Promise<ExistsSourceResponse | TransportResult<ExistsSourceResponse>> {
    const { querystring } = splitParams(params, ["index", "id"]);
    const res = await this.transport.request(
      {
        method: "HEAD",
        path: `/${encodeSegment(params.index)}/_source/${encodeSegment(params.id)}`,
        querystring,
      },
      { ...options, ignore: [...(options?.ignore ?? []), 404] },
    );
    const found = res.statusCode >= 200 && res.statusCode < 300;
    return options?.meta ? { ...res, body: found } : found;
  }

  mget<TDocument = unknown>(
    params?: MgetRequest,
    options?: TransportRequestOptionsWithOutMeta,
  ): Promise<MgetResponse<TDocument>>;
  mget<TDocument = unknown>(
    params: MgetRequest | undefined,
    options: TransportRequestOptionsWithMeta,
  ): Promise<TransportResult<MgetResponse<TDocument>>>;
  mget<TDocument = unknown>(
    params: MgetRequest = {},
    options?: TransportRequestOptions,
  ): Promise<
    MgetResponse<TDocument> | TransportResult<MgetResponse<TDocument>>
  > {
    const { querystring, body } = splitParams(
      params,
      ["index"],
      ["docs", "ids"],
    );
    const path = params.index
      ? `/${encodeSegment(params.index)}/_mget`
      : "/_mget";
    return dispatchRequest<MgetResponse<TDocument>>(
      this.transport,
      { method: "POST", path, querystring, body },
      options,
    );
  }

  msearch<TDocument = unknown, TAggregations = Record<string, any>>(
    params: MsearchRequest,
    options?: TransportRequestOptionsWithOutMeta,
  ): Promise<MsearchResponse<TDocument, TAggregations>>;
  msearch<TDocument = unknown, TAggregations = Record<string, any>>(
    params: MsearchRequest,
    options: TransportRequestOptionsWithMeta,
  ): Promise<TransportResult<MsearchResponse<TDocument, TAggregations>>>;
  msearch<TDocument = unknown, TAggregations = Record<string, any>>(
    params: MsearchRequest,
    options?: TransportRequestOptions,
  ): Promise<
    | MsearchResponse<TDocument, TAggregations>
    | TransportResult<MsearchResponse<TDocument, TAggregations>>
  > {
    const { querystring } = splitParams(params, ["index", "searches"]);
    const searches = params.searches ?? params.body ?? [];
    const path = params.index
      ? `/${encodeSegment(params.index)}/_msearch`
      : "/_msearch";
    return dispatchRequest<MsearchResponse<TDocument, TAggregations>>(
      this.transport,
      { method: "POST", path, querystring, body: searches, ndjson: true },
      options,
    );
  }

  msearchTemplate<TDocument = unknown, TAggregations = Record<string, any>>(
    params: EsParams,
    options?: TransportRequestOptions,
  ): Promise<MsearchResponse<TDocument, TAggregations>> {
    const { querystring } = splitParams(params, ["index", "search_templates"]);
    const items = params.search_templates ?? params.body ?? [];
    const path = params.index
      ? `/${encodeSegment(params.index)}/_msearch/template`
      : "/_msearch/template";
    return dispatchRequest(
      this.transport,
      { method: "POST", path, querystring, body: items, ndjson: true },
      options,
    );
  }

  scroll<TDocument = unknown, TAggregations = Record<string, any>>(
    params: ScrollRequest,
    options?: TransportRequestOptionsWithOutMeta,
  ): Promise<ScrollResponse<TDocument, TAggregations>>;
  scroll<TDocument = unknown, TAggregations = Record<string, any>>(
    params: ScrollRequest,
    options: TransportRequestOptionsWithMeta,
  ): Promise<TransportResult<ScrollResponse<TDocument, TAggregations>>>;
  scroll<TDocument = unknown, TAggregations = Record<string, any>>(
    params: ScrollRequest,
    options?: TransportRequestOptions,
  ): Promise<
    | ScrollResponse<TDocument, TAggregations>
    | TransportResult<ScrollResponse<TDocument, TAggregations>>
  > {
    const { querystring, body } = splitParams(
      params,
      [],
      ["scroll", "scroll_id"],
    );
    return dispatchRequest<ScrollResponse<TDocument, TAggregations>>(
      this.transport,
      { method: "POST", path: "/_search/scroll", querystring, body },
      options,
    );
  }

  clearScroll(
    params?: ClearScrollRequest,
    options?: TransportRequestOptionsWithOutMeta,
  ): Promise<ClearScrollResponse>;
  clearScroll(
    params: ClearScrollRequest | undefined,
    options: TransportRequestOptionsWithMeta,
  ): Promise<TransportResult<ClearScrollResponse>>;
  clearScroll(
    params: ClearScrollRequest = {},
    options?: TransportRequestOptions,
  ): Promise<ClearScrollResponse | TransportResult<ClearScrollResponse>> {
    const { querystring, body } = splitParams(params, [], ["scroll_id"]);
    const path = params.scroll_id ? "/_search/scroll" : "/_search/scroll/_all";
    return dispatchRequest<ClearScrollResponse>(
      this.transport,
      { method: "DELETE", path, querystring, body },
      options,
    );
  }

  openPointInTime(
    params: OpenPointInTimeRequest,
    options?: TransportRequestOptionsWithOutMeta,
  ): Promise<OpenPointInTimeResponse>;
  openPointInTime(
    params: OpenPointInTimeRequest,
    options: TransportRequestOptionsWithMeta,
  ): Promise<TransportResult<OpenPointInTimeResponse>>;
  openPointInTime(
    params: OpenPointInTimeRequest,
    options?: TransportRequestOptions,
  ): Promise<
    OpenPointInTimeResponse | TransportResult<OpenPointInTimeResponse>
  > {
    const { querystring } = splitParams(params, ["index"]);
    return dispatchRequest<OpenPointInTimeResponse>(
      this.transport,
      {
        method: "POST",
        path: `/${encodeSegment(params.index)}/_pit`,
        querystring,
      },
      options,
    );
  }

  closePointInTime(
    params: ClosePointInTimeRequest,
    options?: TransportRequestOptionsWithOutMeta,
  ): Promise<ClosePointInTimeResponse>;
  closePointInTime(
    params: ClosePointInTimeRequest,
    options: TransportRequestOptionsWithMeta,
  ): Promise<TransportResult<ClosePointInTimeResponse>>;
  closePointInTime(
    params: ClosePointInTimeRequest,
    options?: TransportRequestOptions,
  ): Promise<
    ClosePointInTimeResponse | TransportResult<ClosePointInTimeResponse>
  > {
    const { querystring, body } = splitParams(params, [], ["id"]);
    return dispatchRequest<ClosePointInTimeResponse>(
      this.transport,
      { method: "DELETE", path: "/_pit", querystring, body },
      options,
    );
  }

  deleteByQuery(
    params: DeleteByQueryRequest,
    options?: TransportRequestOptionsWithOutMeta,
  ): Promise<DeleteByQueryResponse>;
  deleteByQuery(
    params: DeleteByQueryRequest,
    options: TransportRequestOptionsWithMeta,
  ): Promise<TransportResult<DeleteByQueryResponse>>;
  deleteByQuery(
    params: DeleteByQueryRequest,
    options?: TransportRequestOptions,
  ): Promise<DeleteByQueryResponse | TransportResult<DeleteByQueryResponse>> {
    const { querystring, body } = splitParams(
      params,
      ["index"],
      ["query", "slice", "max_docs"],
    );
    return dispatchRequest<DeleteByQueryResponse>(
      this.transport,
      {
        method: "POST",
        path: `/${encodeSegment(params.index)}/_delete_by_query`,
        querystring,
        body,
      },
      options,
    );
  }

  deleteByQueryRethrottle(
    params: EsParams,
    options?: TransportRequestOptions,
  ): Promise<any> {
    const { querystring } = splitParams(params, ["task_id"]);
    return dispatchRequest(
      this.transport,
      {
        method: "POST",
        path: `/_delete_by_query/${encodeSegment(params.task_id)}/_rethrottle`,
        querystring,
      },
      options,
    );
  }

  updateByQuery(
    params: UpdateByQueryRequest,
    options?: TransportRequestOptionsWithOutMeta,
  ): Promise<UpdateByQueryResponse>;
  updateByQuery(
    params: UpdateByQueryRequest,
    options: TransportRequestOptionsWithMeta,
  ): Promise<TransportResult<UpdateByQueryResponse>>;
  updateByQuery(
    params: UpdateByQueryRequest,
    options?: TransportRequestOptions,
  ): Promise<UpdateByQueryResponse | TransportResult<UpdateByQueryResponse>> {
    const { querystring, body } = splitParams(
      params,
      ["index"],
      ["query", "script", "slice", "max_docs"],
    );
    return dispatchRequest<UpdateByQueryResponse>(
      this.transport,
      {
        method: "POST",
        path: `/${encodeSegment(params.index)}/_update_by_query`,
        querystring,
        body,
      },
      options,
    );
  }

  updateByQueryRethrottle(
    params: EsParams,
    options?: TransportRequestOptions,
  ): Promise<any> {
    const { querystring } = splitParams(params, ["task_id"]);
    return dispatchRequest(
      this.transport,
      {
        method: "POST",
        path: `/_update_by_query/${encodeSegment(params.task_id)}/_rethrottle`,
        querystring,
      },
      options,
    );
  }

  reindex(
    params: ReindexRequest,
    options?: TransportRequestOptionsWithOutMeta,
  ): Promise<ReindexResponse>;
  reindex(
    params: ReindexRequest,
    options: TransportRequestOptionsWithMeta,
  ): Promise<TransportResult<ReindexResponse>>;
  reindex(
    params: ReindexRequest,
    options?: TransportRequestOptions,
  ): Promise<ReindexResponse | TransportResult<ReindexResponse>> {
    const { querystring, body } = splitParams(
      params,
      [],
      ["source", "dest", "script", "conflicts", "max_docs", "size"],
    );
    return dispatchRequest<ReindexResponse>(
      this.transport,
      { method: "POST", path: "/_reindex", querystring, body },
      options,
    );
  }

  reindexRethrottle(
    params: EsParams,
    options?: TransportRequestOptions,
  ): Promise<any> {
    const { querystring } = splitParams(params, ["task_id"]);
    return dispatchRequest(
      this.transport,
      {
        method: "POST",
        path: `/_reindex/${encodeSegment(params.task_id)}/_rethrottle`,
        querystring,
      },
      options,
    );
  }

  getReindex(params: EsParams, options?: TransportRequestOptions): Promise<any> {
    const { querystring } = splitParams(params, ["task_id"]);
    return dispatchRequest(
      this.transport,
      {
        method: "GET",
        path: `/_reindex/${encodeSegment(params.task_id)}`,
        querystring,
      },
      options,
    );
  }

  listReindex(
    params: EsParams = {},
    options?: TransportRequestOptions,
  ): Promise<any> {
    const { querystring } = splitParams(params, []);
    return dispatchRequest(
      this.transport,
      { method: "GET", path: "/_reindex", querystring },
      options,
    );
  }

  cancelReindex(
    params: EsParams,
    options?: TransportRequestOptions,
  ): Promise<any> {
    const { querystring } = splitParams(params, ["task_id"]);
    return dispatchRequest(
      this.transport,
      {
        method: "POST",
        path: `/_reindex/${encodeSegment(params.task_id)}/_cancel`,
        querystring,
      },
      options,
    );
  }

  explain<TDocument = unknown>(
    params: EsParams,
    options?: TransportRequestOptions,
  ): Promise<any> {
    const { querystring, body } = splitParams(
      params,
      ["index", "id"],
      ["query"],
    );
    return dispatchRequest<TDocument>(
      this.transport,
      {
        method: "POST",
        path: `/${encodeSegment(params.index)}/_explain/${encodeSegment(params.id)}`,
        querystring,
        body,
      },
      options,
    );
  }

  fieldCaps(
    params: EsParams = {},
    options?: TransportRequestOptions,
  ): Promise<any> {
    const { querystring, body } = splitParams(
      params,
      ["index"],
      ["index_filter", "runtime_mappings"],
    );
    const path = params.index
      ? `/${encodeSegment(params.index)}/_field_caps`
      : "/_field_caps";
    return dispatchRequest(
      this.transport,
      { method: "POST", path, querystring, body },
      options,
    );
  }

  knnSearch<TDocument = unknown>(
    params: EsParams,
    options?: TransportRequestOptions,
  ): Promise<SearchResponse<TDocument>> {
    const { querystring, body } = splitParams(
      params,
      ["index"],
      ["knn", "fields", "filter", "docvalue_fields", "_source", "stored_fields"],
    );
    return dispatchRequest<SearchResponse<TDocument>>(
      this.transport,
      {
        method: "POST",
        path: `/${encodeSegment(params.index)}/_knn_search`,
        querystring,
        body,
      },
      options,
    );
  }

  termvectors<TDocument = unknown>(
    params: EsParams,
    options?: TransportRequestOptions,
  ): Promise<any> {
    const { querystring, body } = splitParams(
      params,
      ["index", "id"],
      ["doc", "fields", "filter", "offsets", "payloads", "positions", "term_statistics", "field_statistics"],
    );
    const path = params.id
      ? `/${encodeSegment(params.index)}/_termvectors/${encodeSegment(params.id)}`
      : `/${encodeSegment(params.index)}/_termvectors`;
    return dispatchRequest<TDocument>(
      this.transport,
      { method: "POST", path, querystring, body },
      options,
    );
  }

  mtermvectors(
    params: EsParams = {},
    options?: TransportRequestOptions,
  ): Promise<any> {
    const { querystring, body } = splitParams(
      params,
      ["index"],
      ["docs", "ids"],
    );
    const path = params.index
      ? `/${encodeSegment(params.index)}/_mtermvectors`
      : "/_mtermvectors";
    return dispatchRequest(
      this.transport,
      { method: "POST", path, querystring, body },
      options,
    );
  }

  putScript(params: EsParams, options?: TransportRequestOptions): Promise<any> {
    const { querystring, body } = splitParams(
      params,
      ["id", "context"],
      ["script"],
    );
    const path = params.context
      ? `/_scripts/${encodeSegment(params.id)}/${encodeSegment(params.context)}`
      : `/_scripts/${encodeSegment(params.id)}`;
    return dispatchRequest(
      this.transport,
      { method: "PUT", path, querystring, body },
      options,
    );
  }

  getScript(params: EsParams, options?: TransportRequestOptions): Promise<any> {
    const { querystring } = splitParams(params, ["id"]);
    return dispatchRequest(
      this.transport,
      { method: "GET", path: `/_scripts/${encodeSegment(params.id)}`, querystring },
      options,
    );
  }

  deleteScript(
    params: EsParams,
    options?: TransportRequestOptions,
  ): Promise<any> {
    const { querystring } = splitParams(params, ["id"]);
    return dispatchRequest(
      this.transport,
      {
        method: "DELETE",
        path: `/_scripts/${encodeSegment(params.id)}`,
        querystring,
      },
      options,
    );
  }

  getScriptContext(
    params: EsParams = {},
    options?: TransportRequestOptions,
  ): Promise<any> {
    const { querystring } = splitParams(params, []);
    return dispatchRequest(
      this.transport,
      { method: "GET", path: "/_script_context", querystring },
      options,
    );
  }

  getScriptLanguages(
    params: EsParams = {},
    options?: TransportRequestOptions,
  ): Promise<any> {
    const { querystring } = splitParams(params, []);
    return dispatchRequest(
      this.transport,
      { method: "GET", path: "/_script_language", querystring },
      options,
    );
  }

  scriptsPainlessExecute<TResult = unknown>(
    params: EsParams = {},
    options?: TransportRequestOptions,
  ): Promise<{ result: TResult }> {
    const { querystring, body } = splitParams(
      params,
      [],
      ["script", "context", "context_setup"],
    );
    return dispatchRequest<{ result: TResult }>(
      this.transport,
      { method: "POST", path: "/_scripts/painless/_execute", querystring, body },
      options,
    );
  }

  searchTemplate<TDocument = unknown>(
    params: EsParams,
    options?: TransportRequestOptions,
  ): Promise<SearchResponse<TDocument>> {
    const { querystring, body } = splitParams(
      params,
      ["index"],
      ["id", "source", "params", "explain", "profile"],
    );
    const path = params.index
      ? `/${encodeSegment(params.index)}/_search/template`
      : "/_search/template";
    return dispatchRequest<SearchResponse<TDocument>>(
      this.transport,
      { method: "POST", path, querystring, body },
      options,
    );
  }

  renderSearchTemplate(
    params: EsParams = {},
    options?: TransportRequestOptions,
  ): Promise<any> {
    const { querystring, body } = splitParams(
      params,
      ["id"],
      ["id", "source", "params"],
    );
    const path = params.id
      ? `/_render/template/${encodeSegment(params.id)}`
      : "/_render/template";
    return dispatchRequest(
      this.transport,
      { method: "POST", path, querystring, body },
      options,
    );
  }

  searchShards(
    params: EsParams = {},
    options?: TransportRequestOptions,
  ): Promise<any> {
    const { querystring } = splitParams(params, ["index"]);
    const path = params.index
      ? `/${encodeSegment(params.index)}/_search_shards`
      : "/_search_shards";
    return dispatchRequest(
      this.transport,
      { method: "GET", path, querystring },
      options,
    );
  }

  searchMvt(params: EsParams, options?: TransportRequestOptions): Promise<any> {
    const { querystring, body } = splitParams(
      params,
      ["index", "field", "zoom", "x", "y"],
      ["query", "aggs", "fields", "grid_precision", "grid_type", "size"],
    );
    return dispatchRequest(
      this.transport,
      {
        method: "POST",
        path: `/${encodeSegment(params.index)}/_mvt/${encodeSegment(params.field)}/${encodeSegment(String(params.zoom))}/${encodeSegment(String(params.x))}/${encodeSegment(String(params.y))}`,
        querystring,
        body,
      },
      options,
    );
  }

  rankEval(params: EsParams, options?: TransportRequestOptions): Promise<any> {
    const { querystring, body } = splitParams(
      params,
      ["index"],
      ["metric", "requests", "templates"],
    );
    const path = params.index
      ? `/${encodeSegment(params.index)}/_rank_eval`
      : "/_rank_eval";
    return dispatchRequest(
      this.transport,
      { method: "POST", path, querystring, body },
      options,
    );
  }

  termsEnum(params: EsParams, options?: TransportRequestOptions): Promise<any> {
    const { querystring, body } = splitParams(
      params,
      ["index"],
      ["field", "string", "size", "case_insensitive", "index_filter", "search_after"],
    );
    return dispatchRequest(
      this.transport,
      {
        method: "POST",
        path: `/${encodeSegment(params.index)}/_terms_enum`,
        querystring,
        body,
      },
      options,
    );
  }

  capabilities(
    params: EsParams = {},
    options?: TransportRequestOptions,
  ): Promise<any> {
    const { querystring } = splitParams(params, []);
    return dispatchRequest(
      this.transport,
      { method: "GET", path: "/_capabilities", querystring },
      options,
    );
  }

  healthReport(
    params: EsParams = {},
    options?: TransportRequestOptions,
  ): Promise<any> {
    const { querystring } = splitParams(params, ["feature"]);
    const path = params.feature
      ? `/_health_report/${encodeSegment(params.feature)}`
      : "/_health_report";
    return dispatchRequest(
      this.transport,
      { method: "GET", path, querystring },
      options,
    );
  }
}
