import type {
  BulkResponse,
  EsParams,
  SearchRequest,
  SearchResponse,
  TransportRequestOptions,
  TransportResult,
} from "../interfaces/elasticsearch-types.interface";
import type { ElasticsearchTransport } from "../transport/elasticsearch-transport";

export function encodeSegment(value: string | string[]): string {
  if (Array.isArray(value)) {
    return value.map((v) => encodeURIComponent(v)).join(",");
  }
  return encodeURIComponent(value);
}

export function splitParams(
  params: Record<string, any> | undefined,
  pathKeys: readonly string[],
  bodyKeys?: readonly string[],
): { querystring: Record<string, any>; body?: Record<string, any> } {
  const querystring: Record<string, any> = {};
  const pathSet = new Set(pathKeys);
  const bodySet = bodyKeys ? new Set(bodyKeys) : null;
  let body: Record<string, any> | undefined;

  if (!params) {
    return { querystring };
  }

  if (params.body !== undefined) {
    body = params.body;
  }

  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || k === "body" || pathSet.has(k)) {
      continue;
    }
    if (bodySet && bodySet.has(k)) {
      if (!body) body = {};
      body[k] = v;
    } else {
      querystring[k] = v;
    }
  }

  return { querystring, body };
}

export async function dispatchRequest<T = any>(
  transport: ElasticsearchTransport,
  req: {
    method: string;
    path: string;
    querystring?: Record<string, any>;
    body?: unknown;
    ndjson?: boolean;
    headers?: Record<string, any>;
  },
  options?: TransportRequestOptions,
): Promise<any> {
  const res = await transport.request<T>(req, options);
  return options?.meta ? res : res.body;
}

export class IndicesApi {
  constructor(private readonly transport: ElasticsearchTransport) {}

  create(params: EsParams, options?: TransportRequestOptions): Promise<any> {
    const { querystring, body } = splitParams(
      params,
      ["index"],
      ["aliases", "mappings", "settings"],
    );
    return dispatchRequest(
      this.transport,
      { method: "PUT", path: `/${encodeSegment(params.index)}`, querystring, body },
      options,
    );
  }

  delete(params: EsParams, options?: TransportRequestOptions): Promise<any> {
    const { querystring } = splitParams(params, ["index"]);
    return dispatchRequest(
      this.transport,
      { method: "DELETE", path: `/${encodeSegment(params.index)}`, querystring },
      options,
    );
  }

  async exists(
    params: EsParams,
    options?: TransportRequestOptions,
  ): Promise<boolean | TransportResult<boolean>> {
    const { querystring } = splitParams(params, ["index"]);
    const res = await this.transport.request(
      { method: "HEAD", path: `/${encodeSegment(params.index)}`, querystring },
      { ...options, ignore: [...(options?.ignore ?? []), 404] },
    );
    const exists = res.statusCode >= 200 && res.statusCode < 300;
    return options?.meta ? { ...res, body: exists } : exists;
  }

  get(params: EsParams, options?: TransportRequestOptions): Promise<any> {
    const { querystring } = splitParams(params, ["index"]);
    return dispatchRequest(
      this.transport,
      { method: "GET", path: `/${encodeSegment(params.index)}`, querystring },
      options,
    );
  }

  refresh(params: EsParams = {}, options?: TransportRequestOptions): Promise<any> {
    const { querystring } = splitParams(params, ["index"]);
    const path = params.index
      ? `/${encodeSegment(params.index)}/_refresh`
      : "/_refresh";
    return dispatchRequest(
      this.transport,
      { method: "POST", path, querystring },
      options,
    );
  }

  flush(params: EsParams = {}, options?: TransportRequestOptions): Promise<any> {
    const { querystring } = splitParams(params, ["index"]);
    const path = params.index
      ? `/${encodeSegment(params.index)}/_flush`
      : "/_flush";
    return dispatchRequest(
      this.transport,
      { method: "POST", path, querystring },
      options,
    );
  }

  putMapping(params: EsParams, options?: TransportRequestOptions): Promise<any> {
    const { querystring, body } = splitParams(
      params,
      ["index"],
      [
        "properties",
        "dynamic",
        "dynamic_templates",
        "dynamic_date_formats",
        "date_detection",
        "numeric_detection",
        "_source",
        "_routing",
        "_meta",
        "runtime",
      ],
    );
    return dispatchRequest(
      this.transport,
      {
        method: "PUT",
        path: `/${encodeSegment(params.index)}/_mapping`,
        querystring,
        body,
      },
      options,
    );
  }

  getMapping(params: EsParams = {}, options?: TransportRequestOptions): Promise<any> {
    const { querystring } = splitParams(params, ["index"]);
    const path = params.index
      ? `/${encodeSegment(params.index)}/_mapping`
      : "/_mapping";
    return dispatchRequest(
      this.transport,
      { method: "GET", path, querystring },
      options,
    );
  }

  putSettings(params: EsParams = {}, options?: TransportRequestOptions): Promise<any> {
    const { querystring, body } = splitParams(params, ["index"], ["settings"]);
    const path = params.index
      ? `/${encodeSegment(params.index)}/_settings`
      : "/_settings";
    return dispatchRequest(
      this.transport,
      { method: "PUT", path, querystring, body },
      options,
    );
  }

  getSettings(params: EsParams = {}, options?: TransportRequestOptions): Promise<any> {
    const { querystring } = splitParams(params, ["index", "name"]);
    let path = params.index
      ? `/${encodeSegment(params.index)}/_settings`
      : "/_settings";
    if (params.name) {
      path += `/${encodeSegment(params.name)}`;
    }
    return dispatchRequest(
      this.transport,
      { method: "GET", path, querystring },
      options,
    );
  }

  stats(params: EsParams = {}, options?: TransportRequestOptions): Promise<any> {
    const { querystring } = splitParams(params, ["index", "metric"]);
    let path = params.index
      ? `/${encodeSegment(params.index)}/_stats`
      : "/_stats";
    if (params.metric) {
      path += `/${encodeSegment(params.metric)}`;
    }
    return dispatchRequest(
      this.transport,
      { method: "GET", path, querystring },
      options,
    );
  }

  open(params: EsParams, options?: TransportRequestOptions): Promise<any> {
    const { querystring } = splitParams(params, ["index"]);
    return dispatchRequest(
      this.transport,
      { method: "POST", path: `/${encodeSegment(params.index)}/_open`, querystring },
      options,
    );
  }

  close(params: EsParams, options?: TransportRequestOptions): Promise<any> {
    const { querystring } = splitParams(params, ["index"]);
    return dispatchRequest(
      this.transport,
      { method: "POST", path: `/${encodeSegment(params.index)}/_close`, querystring },
      options,
    );
  }

  forcemerge(params: EsParams = {}, options?: TransportRequestOptions): Promise<any> {
    const { querystring } = splitParams(params, ["index"]);
    const path = params.index
      ? `/${encodeSegment(params.index)}/_forcemerge`
      : "/_forcemerge";
    return dispatchRequest(
      this.transport,
      { method: "POST", path, querystring },
      options,
    );
  }

  clearCache(params: EsParams = {}, options?: TransportRequestOptions): Promise<any> {
    const { querystring } = splitParams(params, ["index"]);
    const path = params.index
      ? `/${encodeSegment(params.index)}/_cache/clear`
      : "/_cache/clear";
    return dispatchRequest(
      this.transport,
      { method: "POST", path, querystring },
      options,
    );
  }

  putAlias(params: EsParams, options?: TransportRequestOptions): Promise<any> {
    const { querystring, body } = splitParams(
      params,
      ["index", "name"],
      ["filter", "index_routing", "is_hidden", "is_write_index", "routing", "search_routing"],
    );
    return dispatchRequest(
      this.transport,
      {
        method: "PUT",
        path: `/${encodeSegment(params.index)}/_alias/${encodeSegment(params.name)}`,
        querystring,
        body,
      },
      options,
    );
  }

  deleteAlias(params: EsParams, options?: TransportRequestOptions): Promise<any> {
    const { querystring } = splitParams(params, ["index", "name"]);
    return dispatchRequest(
      this.transport,
      {
        method: "DELETE",
        path: `/${encodeSegment(params.index)}/_alias/${encodeSegment(params.name)}`,
        querystring,
      },
      options,
    );
  }

  getAlias(params: EsParams = {}, options?: TransportRequestOptions): Promise<any> {
    const { querystring } = splitParams(params, ["index", "name"]);
    const prefix = params.index ? `/${encodeSegment(params.index)}` : "";
    const suffix = params.name ? `/${encodeSegment(params.name)}` : "";
    return dispatchRequest(
      this.transport,
      { method: "GET", path: `${prefix}/_alias${suffix}`, querystring },
      options,
    );
  }

  async existsAlias(
    params: EsParams,
    options?: TransportRequestOptions,
  ): Promise<boolean | TransportResult<boolean>> {
    const { querystring } = splitParams(params, ["index", "name"]);
    const prefix = params.index ? `/${encodeSegment(params.index)}` : "";
    const suffix = params.name ? `/${encodeSegment(params.name)}` : "";
    const res = await this.transport.request(
      { method: "HEAD", path: `${prefix}/_alias${suffix}`, querystring },
      { ...options, ignore: [...(options?.ignore ?? []), 404] },
    );
    const exists = res.statusCode >= 200 && res.statusCode < 300;
    return options?.meta ? { ...res, body: exists } : exists;
  }

  updateAliases(params: EsParams, options?: TransportRequestOptions): Promise<any> {
    const { querystring, body } = splitParams(params, [], ["actions"]);
    return dispatchRequest(
      this.transport,
      { method: "POST", path: "/_aliases", querystring, body },
      options,
    );
  }

  analyze(params: EsParams = {}, options?: TransportRequestOptions): Promise<any> {
    const { querystring, body } = splitParams(
      params,
      ["index"],
      ["analyzer", "attributes", "char_filter", "explain", "field", "filter", "normalizer", "text", "tokenizer"],
    );
    const path = params.index
      ? `/${encodeSegment(params.index)}/_analyze`
      : "/_analyze";
    return dispatchRequest(
      this.transport,
      { method: "POST", path, querystring, body },
      options,
    );
  }

  putIndexTemplate(params: EsParams, options?: TransportRequestOptions): Promise<any> {
    const { querystring, body } = splitParams(
      params,
      ["name"],
      ["index_patterns", "template", "composed_of", "priority", "version", "_meta", "data_stream", "allow_auto_create"],
    );
    return dispatchRequest(
      this.transport,
      {
        method: "PUT",
        path: `/_index_template/${encodeSegment(params.name)}`,
        querystring,
        body,
      },
      options,
    );
  }

  getIndexTemplate(params: EsParams = {}, options?: TransportRequestOptions): Promise<any> {
    const { querystring } = splitParams(params, ["name"]);
    const path = params.name
      ? `/_index_template/${encodeSegment(params.name)}`
      : "/_index_template";
    return dispatchRequest(
      this.transport,
      { method: "GET", path, querystring },
      options,
    );
  }

  deleteIndexTemplate(params: EsParams, options?: TransportRequestOptions): Promise<any> {
    const { querystring } = splitParams(params, ["name"]);
    return dispatchRequest(
      this.transport,
      {
        method: "DELETE",
        path: `/_index_template/${encodeSegment(params.name)}`,
        querystring,
      },
      options,
    );
  }
}

export class ClusterApi {
  constructor(private readonly transport: ElasticsearchTransport) {}

  health(params: EsParams = {}, options?: TransportRequestOptions): Promise<any> {
    const { querystring } = splitParams(params, ["index"]);
    const path = params.index
      ? `/_cluster/health/${encodeSegment(params.index)}`
      : "/_cluster/health";
    return dispatchRequest(
      this.transport,
      { method: "GET", path, querystring },
      options,
    );
  }

  state(params: EsParams = {}, options?: TransportRequestOptions): Promise<any> {
    const { querystring } = splitParams(params, ["metric", "index"]);
    let path = "/_cluster/state";
    if (params.metric) path += `/${encodeSegment(params.metric)}`;
    if (params.index) path += `/${encodeSegment(params.index)}`;
    return dispatchRequest(
      this.transport,
      { method: "GET", path, querystring },
      options,
    );
  }

  stats(params: EsParams = {}, options?: TransportRequestOptions): Promise<any> {
    const { querystring } = splitParams(params, ["node_id"]);
    const path = params.node_id
      ? `/_cluster/stats/nodes/${encodeSegment(params.node_id)}`
      : "/_cluster/stats";
    return dispatchRequest(
      this.transport,
      { method: "GET", path, querystring },
      options,
    );
  }

  getSettings(params: EsParams = {}, options?: TransportRequestOptions): Promise<any> {
    const { querystring } = splitParams(params, []);
    return dispatchRequest(
      this.transport,
      { method: "GET", path: "/_cluster/settings", querystring },
      options,
    );
  }

  putSettings(params: EsParams = {}, options?: TransportRequestOptions): Promise<any> {
    const { querystring, body } = splitParams(
      params,
      [],
      ["persistent", "transient"],
    );
    return dispatchRequest(
      this.transport,
      { method: "PUT", path: "/_cluster/settings", querystring, body },
      options,
    );
  }

  pendingTasks(params: EsParams = {}, options?: TransportRequestOptions): Promise<any> {
    const { querystring } = splitParams(params, []);
    return dispatchRequest(
      this.transport,
      { method: "GET", path: "/_cluster/pending_tasks", querystring },
      options,
    );
  }

  allocationExplain(
    params: EsParams = {},
    options?: TransportRequestOptions,
  ): Promise<any> {
    const { querystring, body } = splitParams(
      params,
      [],
      ["index", "shard", "primary", "current_node"],
    );
    return dispatchRequest(
      this.transport,
      { method: "POST", path: "/_cluster/allocation/explain", querystring, body },
      options,
    );
  }
}

export class CatApi {
  constructor(private readonly transport: ElasticsearchTransport) {}

  indices(params: EsParams = {}, options?: TransportRequestOptions): Promise<any> {
    const { querystring } = splitParams(params, ["index"]);
    const path = params.index
      ? `/_cat/indices/${encodeSegment(params.index)}`
      : "/_cat/indices";
    return dispatchRequest(
      this.transport,
      { method: "GET", path, querystring },
      options,
    );
  }

  health(params: EsParams = {}, options?: TransportRequestOptions): Promise<any> {
    const { querystring } = splitParams(params, []);
    return dispatchRequest(
      this.transport,
      { method: "GET", path: "/_cat/health", querystring },
      options,
    );
  }

  nodes(params: EsParams = {}, options?: TransportRequestOptions): Promise<any> {
    const { querystring } = splitParams(params, []);
    return dispatchRequest(
      this.transport,
      { method: "GET", path: "/_cat/nodes", querystring },
      options,
    );
  }

  shards(params: EsParams = {}, options?: TransportRequestOptions): Promise<any> {
    const { querystring } = splitParams(params, ["index"]);
    const path = params.index
      ? `/_cat/shards/${encodeSegment(params.index)}`
      : "/_cat/shards";
    return dispatchRequest(
      this.transport,
      { method: "GET", path, querystring },
      options,
    );
  }

  count(params: EsParams = {}, options?: TransportRequestOptions): Promise<any> {
    const { querystring } = splitParams(params, ["index"]);
    const path = params.index
      ? `/_cat/count/${encodeSegment(params.index)}`
      : "/_cat/count";
    return dispatchRequest(
      this.transport,
      { method: "GET", path, querystring },
      options,
    );
  }

  aliases(params: EsParams = {}, options?: TransportRequestOptions): Promise<any> {
    const { querystring } = splitParams(params, ["name"]);
    const path = params.name
      ? `/_cat/aliases/${encodeSegment(params.name)}`
      : "/_cat/aliases";
    return dispatchRequest(
      this.transport,
      { method: "GET", path, querystring },
      options,
    );
  }

  tasks(params: EsParams = {}, options?: TransportRequestOptions): Promise<any> {
    const { querystring } = splitParams(params, []);
    return dispatchRequest(
      this.transport,
      { method: "GET", path: "/_cat/tasks", querystring },
      options,
    );
  }
}

export class IngestApi {
  constructor(private readonly transport: ElasticsearchTransport) {}

  putPipeline(params: EsParams, options?: TransportRequestOptions): Promise<any> {
    const { querystring, body } = splitParams(
      params,
      ["id"],
      ["description", "processors", "on_failure", "version", "_meta"],
    );
    return dispatchRequest(
      this.transport,
      {
        method: "PUT",
        path: `/_ingest/pipeline/${encodeSegment(params.id)}`,
        querystring,
        body,
      },
      options,
    );
  }

  getPipeline(params: EsParams = {}, options?: TransportRequestOptions): Promise<any> {
    const { querystring } = splitParams(params, ["id"]);
    const path = params.id
      ? `/_ingest/pipeline/${encodeSegment(params.id)}`
      : "/_ingest/pipeline";
    return dispatchRequest(
      this.transport,
      { method: "GET", path, querystring },
      options,
    );
  }

  deletePipeline(params: EsParams, options?: TransportRequestOptions): Promise<any> {
    const { querystring } = splitParams(params, ["id"]);
    return dispatchRequest(
      this.transport,
      {
        method: "DELETE",
        path: `/_ingest/pipeline/${encodeSegment(params.id)}`,
        querystring,
      },
      options,
    );
  }

  simulate(params: EsParams = {}, options?: TransportRequestOptions): Promise<any> {
    const { querystring, body } = splitParams(
      params,
      ["id"],
      ["docs", "pipeline"],
    );
    const path = params.id
      ? `/_ingest/pipeline/${encodeSegment(params.id)}/_simulate`
      : "/_ingest/pipeline/_simulate";
    return dispatchRequest(
      this.transport,
      { method: "POST", path, querystring, body },
      options,
    );
  }
}

export class TasksApi {
  constructor(private readonly transport: ElasticsearchTransport) {}

  get(params: EsParams, options?: TransportRequestOptions): Promise<any> {
    const { querystring } = splitParams(params, ["task_id"]);
    return dispatchRequest(
      this.transport,
      { method: "GET", path: `/_tasks/${encodeSegment(params.task_id)}`, querystring },
      options,
    );
  }

  list(params: EsParams = {}, options?: TransportRequestOptions): Promise<any> {
    const { querystring } = splitParams(params, []);
    return dispatchRequest(
      this.transport,
      { method: "GET", path: "/_tasks", querystring },
      options,
    );
  }

  cancel(params: EsParams = {}, options?: TransportRequestOptions): Promise<any> {
    const { querystring } = splitParams(params, ["task_id"]);
    const path = params.task_id
      ? `/_tasks/${encodeSegment(params.task_id)}/_cancel`
      : "/_tasks/_cancel";
    return dispatchRequest(
      this.transport,
      { method: "POST", path, querystring },
      options,
    );
  }
}

export class NodesApi {
  constructor(private readonly transport: ElasticsearchTransport) {}

  info(params: EsParams = {}, options?: TransportRequestOptions): Promise<any> {
    const { querystring } = splitParams(params, ["node_id", "metric"]);
    let path = "/_nodes";
    if (params.node_id) path += `/${encodeSegment(params.node_id)}`;
    if (params.metric) path += `/${encodeSegment(params.metric)}`;
    return dispatchRequest(
      this.transport,
      { method: "GET", path, querystring },
      options,
    );
  }

  stats(params: EsParams = {}, options?: TransportRequestOptions): Promise<any> {
    const { querystring } = splitParams(params, ["node_id", "metric"]);
    let path = params.node_id
      ? `/_nodes/${encodeSegment(params.node_id)}/stats`
      : "/_nodes/stats";
    if (params.metric) path += `/${encodeSegment(params.metric)}`;
    return dispatchRequest(
      this.transport,
      { method: "GET", path, querystring },
      options,
    );
  }
}

export class SnapshotApi {
  constructor(private readonly transport: ElasticsearchTransport) {}

  createRepository(params: EsParams, options?: TransportRequestOptions): Promise<any> {
    const { querystring, body } = splitParams(
      params,
      ["repository"],
      ["type", "settings", "verify"],
    );
    return dispatchRequest(
      this.transport,
      {
        method: "PUT",
        path: `/_snapshot/${encodeSegment(params.repository)}`,
        querystring,
        body,
      },
      options,
    );
  }

  getRepository(params: EsParams = {}, options?: TransportRequestOptions): Promise<any> {
    const { querystring } = splitParams(params, ["repository"]);
    const path = params.repository
      ? `/_snapshot/${encodeSegment(params.repository)}`
      : "/_snapshot";
    return dispatchRequest(
      this.transport,
      { method: "GET", path, querystring },
      options,
    );
  }

  create(params: EsParams, options?: TransportRequestOptions): Promise<any> {
    const { querystring, body } = splitParams(
      params,
      ["repository", "snapshot"],
      ["indices", "ignore_unavailable", "include_global_state", "metadata", "partial"],
    );
    return dispatchRequest(
      this.transport,
      {
        method: "PUT",
        path: `/_snapshot/${encodeSegment(params.repository)}/${encodeSegment(params.snapshot)}`,
        querystring,
        body,
      },
      options,
    );
  }

  get(params: EsParams, options?: TransportRequestOptions): Promise<any> {
    const { querystring } = splitParams(params, ["repository", "snapshot"]);
    return dispatchRequest(
      this.transport,
      {
        method: "GET",
        path: `/_snapshot/${encodeSegment(params.repository)}/${encodeSegment(params.snapshot)}`,
        querystring,
      },
      options,
    );
  }

  delete(params: EsParams, options?: TransportRequestOptions): Promise<any> {
    const { querystring } = splitParams(params, ["repository", "snapshot"]);
    return dispatchRequest(
      this.transport,
      {
        method: "DELETE",
        path: `/_snapshot/${encodeSegment(params.repository)}/${encodeSegment(params.snapshot)}`,
        querystring,
      },
      options,
    );
  }

  restore(params: EsParams, options?: TransportRequestOptions): Promise<any> {
    const { querystring, body } = splitParams(
      params,
      ["repository", "snapshot"],
      ["indices", "ignore_unavailable", "include_global_state", "rename_pattern", "rename_replacement"],
    );
    return dispatchRequest(
      this.transport,
      {
        method: "POST",
        path: `/_snapshot/${encodeSegment(params.repository)}/${encodeSegment(params.snapshot)}/_restore`,
        querystring,
        body,
      },
      options,
    );
  }
}

export class SecurityApi {
  constructor(private readonly transport: ElasticsearchTransport) {}

  authenticate(options?: TransportRequestOptions): Promise<any> {
    return dispatchRequest(
      this.transport,
      { method: "GET", path: "/_security/_authenticate" },
      options,
    );
  }

  createApiKey(params: EsParams, options?: TransportRequestOptions): Promise<any> {
    const { querystring, body } = splitParams(
      params,
      [],
      ["name", "expiration", "role_descriptors", "metadata"],
    );
    return dispatchRequest(
      this.transport,
      { method: "POST", path: "/_security/api_key", querystring, body },
      options,
    );
  }

  getApiKey(params: EsParams = {}, options?: TransportRequestOptions): Promise<any> {
    const { querystring } = splitParams(params, []);
    return dispatchRequest(
      this.transport,
      { method: "GET", path: "/_security/api_key", querystring },
      options,
    );
  }

  invalidateApiKey(params: EsParams, options?: TransportRequestOptions): Promise<any> {
    const { querystring, body } = splitParams(
      params,
      [],
      ["id", "ids", "name", "owner", "realm_name", "username"],
    );
    return dispatchRequest(
      this.transport,
      { method: "DELETE", path: "/_security/api_key", querystring, body },
      options,
    );
  }
}

export class SqlApi {
  constructor(private readonly transport: ElasticsearchTransport) {}

  query(params: EsParams, options?: TransportRequestOptions): Promise<any> {
    const { querystring, body } = splitParams(
      params,
      [],
      ["query", "cursor", "fetch_size", "filter", "params", "time_zone", "columnar"],
    );
    return dispatchRequest(
      this.transport,
      { method: "POST", path: "/_sql", querystring, body },
      options,
    );
  }

  clearCursor(params: EsParams, options?: TransportRequestOptions): Promise<any> {
    const { querystring, body } = splitParams(params, [], ["cursor"]);
    return dispatchRequest(
      this.transport,
      { method: "POST", path: "/_sql/close", querystring, body },
      options,
    );
  }

  translate(params: EsParams, options?: TransportRequestOptions): Promise<any> {
    const { querystring, body } = splitParams(
      params,
      [],
      ["query", "fetch_size", "filter", "params"],
    );
    return dispatchRequest(
      this.transport,
      { method: "POST", path: "/_sql/translate", querystring, body },
      options,
    );
  }
}

export class EsqlApi {
  constructor(private readonly transport: ElasticsearchTransport) {}

  query(params: EsParams, options?: TransportRequestOptions): Promise<any> {
    const { querystring, body } = splitParams(
      params,
      [],
      ["query", "filter", "params", "columnar", "locale"],
    );
    return dispatchRequest(
      this.transport,
      { method: "POST", path: "/_query", querystring, body },
      options,
    );
  }

  asyncQuery(params: EsParams, options?: TransportRequestOptions): Promise<any> {
    const { querystring, body } = splitParams(
      params,
      [],
      ["query", "filter", "params", "wait_for_completion_timeout", "keep_alive"],
    );
    return dispatchRequest(
      this.transport,
      { method: "POST", path: "/_query/async", querystring, body },
      options,
    );
  }

  asyncQueryGet(params: EsParams, options?: TransportRequestOptions): Promise<any> {
    const { querystring } = splitParams(params, ["id"]);
    return dispatchRequest(
      this.transport,
      { method: "GET", path: `/_query/async/${encodeSegment(params.id)}`, querystring },
      options,
    );
  }

  asyncQueryDelete(params: EsParams, options?: TransportRequestOptions): Promise<any> {
    const { querystring } = splitParams(params, ["id"]);
    return dispatchRequest(
      this.transport,
      { method: "DELETE", path: `/_query/async/${encodeSegment(params.id)}`, querystring },
      options,
    );
  }
}

export class AsyncSearchApi {
  constructor(private readonly transport: ElasticsearchTransport) {}

  submit(params: EsParams = {}, options?: TransportRequestOptions): Promise<any> {
    const { querystring, body } = splitParams(
      params,
      ["index"],
      ["query", "aggs", "size", "from", "sort", "_source"],
    );
    const path = params.index
      ? `/${encodeSegment(params.index)}/_async_search`
      : "/_async_search";
    return dispatchRequest(
      this.transport,
      { method: "POST", path, querystring, body },
      options,
    );
  }

  get(params: EsParams, options?: TransportRequestOptions): Promise<any> {
    const { querystring } = splitParams(params, ["id"]);
    return dispatchRequest(
      this.transport,
      { method: "GET", path: `/_async_search/${encodeSegment(params.id)}`, querystring },
      options,
    );
  }

  status(params: EsParams, options?: TransportRequestOptions): Promise<any> {
    const { querystring } = splitParams(params, ["id"]);
    return dispatchRequest(
      this.transport,
      { method: "GET", path: `/_async_search/status/${encodeSegment(params.id)}`, querystring },
      options,
    );
  }

  delete(params: EsParams, options?: TransportRequestOptions): Promise<any> {
    const { querystring } = splitParams(params, ["id"]);
    return dispatchRequest(
      this.transport,
      { method: "DELETE", path: `/_async_search/${encodeSegment(params.id)}`, querystring },
      options,
    );
  }
}

export class IlmApi {
  constructor(private readonly transport: ElasticsearchTransport) {}

  putLifecycle(params: EsParams, options?: TransportRequestOptions): Promise<any> {
    const { querystring, body } = splitParams(params, ["policy"], ["policy"]);
    return dispatchRequest(
      this.transport,
      { method: "PUT", path: `/_ilm/policy/${encodeSegment(params.policy)}`, querystring, body: params.body ?? params },
      options,
    );
  }

  getLifecycle(params: EsParams = {}, options?: TransportRequestOptions): Promise<any> {
    const { querystring } = splitParams(params, ["policy"]);
    const path = params.policy
      ? `/_ilm/policy/${encodeSegment(params.policy)}`
      : "/_ilm/policy";
    return dispatchRequest(this.transport, { method: "GET", path, querystring }, options);
  }

  deleteLifecycle(params: EsParams, options?: TransportRequestOptions): Promise<any> {
    const { querystring } = splitParams(params, ["policy"]);
    return dispatchRequest(
      this.transport,
      { method: "DELETE", path: `/_ilm/policy/${encodeSegment(params.policy)}`, querystring },
      options,
    );
  }

  getStatus(options?: TransportRequestOptions): Promise<any> {
    return dispatchRequest(this.transport, { method: "GET", path: "/_ilm/status" }, options);
  }
}

export class RestNamespaceApi {
  constructor(
    protected readonly transport: ElasticsearchTransport,
    readonly basePath: string,
  ) {}

  request<T = any>(
    method: string,
    subPath = "",
    params?: EsParams,
    options?: TransportRequestOptions,
  ): Promise<T> {
    const normalizedSub = subPath
      ? subPath.startsWith("/")
        ? subPath
        : `/${subPath}`
      : "";
    const { querystring, body } = splitParams(params, []);
    return dispatchRequest<T>(
      this.transport,
      {
        method,
        path: `${this.basePath}${normalizedSub}`,
        querystring,
        body,
      },
      options,
    );
  }
}

export interface BulkHelperOptions<T = any> {
  datasource: Iterable<T> | AsyncIterable<T>;
  onDocument: (doc: T) => Record<string, any> | Array<Record<string, any>>;
  flushBytes?: number;
  refreshOnCompletion?: boolean | string;
  onDrop?: (doc: T) => void;
}

export interface BulkHelperResult {
  total: number;
  failed: number;
  retry: number;
  successful: number;
  time: number;
  bytes: number;
  aborted: boolean;
}

export class ElasticsearchHelpers {
  constructor(private readonly transport: ElasticsearchTransport) {}

  async bulk<T = any>(options: BulkHelperOptions<T>): Promise<BulkHelperResult> {
    const started = performance.now();
    const flushBytes = options.flushBytes ?? 5 * 1024 * 1024;
    let total = 0;
    let successful = 0;
    let failed = 0;
    let bytes = 0;
    let batch: any[] = [];
    let batchBytes = 0;

    const flush = async () => {
      if (batch.length === 0) return;
      const toSend = batch;
      batch = [];
      batchBytes = 0;
      const res = await this.transport.request<BulkResponse>({
        method: "POST",
        path: "/_bulk",
        body: toSend,
        ndjson: true,
        querystring: options.refreshOnCompletion
          ? { refresh: options.refreshOnCompletion }
          : undefined,
      });
      const items = res.body?.items ?? [];
      for (const item of items) {
        const opResult = Object.values(item)[0] as Record<string, any> | undefined;
        if (opResult?.error) {
          failed += 1;
        } else {
          successful += 1;
        }
      }
    };

    for await (const doc of options.datasource) {
      total += 1;
      const actionOrPair = options.onDocument(doc);
      if (Array.isArray(actionOrPair)) {
        for (const entry of actionOrPair) {
          const line = JSON.stringify(entry);
          batchBytes += Buffer.byteLength(line, "utf8") + 1;
          bytes += Buffer.byteLength(line, "utf8") + 1;
          batch.push(entry);
        }
      } else {
        const actionLine = JSON.stringify(actionOrPair);
        const docLine = JSON.stringify(doc);
        const size =
          Buffer.byteLength(actionLine, "utf8") +
          Buffer.byteLength(docLine, "utf8") +
          2;
        batchBytes += size;
        bytes += size;
        batch.push(actionOrPair, doc);
      }

      if (batchBytes >= flushBytes) {
        await flush();
      }
    }

    await flush();

    return {
      total,
      failed,
      retry: 0,
      successful,
      time: Math.round(performance.now() - started),
      bytes,
      aborted: false,
    };
  }

  async *scrollDocuments<TDocument = unknown>(
    params: SearchRequest & { scroll?: string },
  ): AsyncGenerator<TDocument, void, unknown> {
    const scrollTtl = params.scroll ?? "1m";
    const { querystring, body } = splitParams(
      { ...params, scroll: scrollTtl },
      ["index"],
      ["query", "aggs", "aggregations", "from", "size", "sort", "_source", "highlight"],
    );
    const searchPath = params.index
      ? `/${encodeSegment(params.index)}/_search`
      : "/_search";

    let res = await dispatchRequest<SearchResponse<TDocument>>(this.transport, {
      method: "POST",
      path: searchPath,
      querystring,
      body,
    });

    let scrollId: string | undefined = res._scroll_id;
    try {
      while (res.hits?.hits && res.hits.hits.length > 0) {
        for (const hit of res.hits.hits) {
          if (hit._source !== undefined) {
            yield hit._source;
          }
        }
        if (!scrollId) break;
        res = await dispatchRequest<SearchResponse<TDocument>>(this.transport, {
          method: "POST",
          path: "/_search/scroll",
          body: { scroll: scrollTtl, scroll_id: scrollId },
        });
        scrollId = res._scroll_id ?? scrollId;
      }
    } finally {
      if (scrollId) {
        await this.transport
          .request({
            method: "DELETE",
            path: "/_search/scroll",
            body: { scroll_id: scrollId },
          })
          .catch(() => {});
      }
    }
  }

  async *scrollSearch<TDocument = unknown>(
    params: SearchRequest & { scroll?: string },
  ): AsyncGenerator<
    { documents: TDocument[]; total: number; scrollId?: string },
    void,
    unknown
  > {
    const scrollTtl = params.scroll ?? "1m";
    const { querystring, body } = splitParams(
      { ...params, scroll: scrollTtl },
      ["index"],
      ["query", "aggs", "aggregations", "from", "size", "sort", "_source", "highlight"],
    );
    const searchPath = params.index
      ? `/${encodeSegment(params.index)}/_search`
      : "/_search";

    let res = await dispatchRequest<SearchResponse<TDocument>>(this.transport, {
      method: "POST",
      path: searchPath,
      querystring,
      body,
    });
    let scrollId: string | undefined = res._scroll_id;
    try {
      while (res.hits?.hits && res.hits.hits.length > 0) {
        const total =
          typeof res.hits.total === "number"
            ? res.hits.total
            : (res.hits.total?.value ?? res.hits.hits.length);
        const documents = res.hits.hits
          .map((h: { _source?: TDocument }) => h._source)
          .filter((s: TDocument | undefined): s is TDocument => s !== undefined);
        yield { documents, total, scrollId };
        if (!scrollId) break;
        res = await dispatchRequest<SearchResponse<TDocument>>(this.transport, {
          method: "POST",
          path: "/_search/scroll",
          body: { scroll: scrollTtl, scroll_id: scrollId },
        });
        scrollId = res._scroll_id ?? scrollId;
      }
    } finally {
      if (scrollId) {
        await this.transport
          .request({
            method: "DELETE",
            path: "/_search/scroll",
            body: { scroll_id: scrollId },
          })
          .catch(() => {});
      }
    }
  }

  async search<TDocument = unknown>(
    params: SearchRequest,
  ): Promise<TDocument[]> {
    const { querystring, body } = splitParams(
      params,
      ["index"],
      ["query", "aggs", "aggregations", "from", "size", "sort", "_source", "highlight"],
    );
    const searchPath = params.index
      ? `/${encodeSegment(params.index)}/_search`
      : "/_search";
    const res = await dispatchRequest<SearchResponse<TDocument>>(this.transport, {
      method: "POST",
      path: searchPath,
      querystring,
      body,
    });
    return (res.hits?.hits ?? [])
      .map((h: { _source?: TDocument }) => h._source)
      .filter((s: TDocument | undefined): s is TDocument => s !== undefined);
  }
}
