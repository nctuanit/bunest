import type {
  NodeConnectionState,
  NodeFilterFn,
  NodeOptions,
  NodeSelectorFn,
} from "../interfaces/elasticsearch-types.interface";

const DEFAULT_ROLES = {
  master: true,
  data: true,
  ingest: true,
  ml: true,
};

/**
 * Decodes an Elastic Cloud ID (`<name>:<base64(domain$esUuid[$kibanaUuid])>`)
 * into its HTTPS Elasticsearch endpoint URL.
 */
export function parseCloudId(cloudId: string): string {
  const parts = cloudId.split(":");
  const encoded = parts.length > 1 ? parts.slice(1).join(":") : parts[0]!;
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const segments = decoded.split("$");
  const domain = segments[0];
  const esId = segments[1];
  if (!domain || !esId) {
    throw new Error(`Invalid Elastic Cloud ID: "${cloudId}"`);
  }
  return `https://${esId}.${domain}`;
}

function normalizeNode(entry: string | NodeOptions): NodeConnectionState {
  if (typeof entry === "string") {
    const url = new URL(entry);
    return {
      id: url.href,
      url,
      headers: {},
      roles: { ...DEFAULT_ROLES },
      status: "alive",
      deadCount: 0,
      resurrectAt: 0,
    };
  }
  const url = entry.url instanceof URL ? entry.url : new URL(entry.url);
  const headers: Record<string, string> = {};
  if (entry.headers) {
    for (const [k, v] of Object.entries(entry.headers)) {
      if (v !== undefined && v !== null) {
        headers[k] = String(v);
      }
    }
  }
  return {
    id: entry.id ?? url.href,
    url,
    headers,
    roles: entry.roles ? { ...entry.roles } : { ...DEFAULT_ROLES },
    status: "alive",
    deadCount: 0,
    resurrectAt: 0,
  };
}

export class ElasticsearchConnectionPool {
  readonly connections: NodeConnectionState[] = [];
  readonly resurrectStrategy: "ping" | "optimistic" | "none";
  private readonly nodeFilter?: NodeFilterFn;
  private readonly nodeSelector?: NodeSelectorFn;
  private rrIndex = 0;
  private closed = false;

  constructor(options: {
    node?: string | string[] | NodeOptions | NodeOptions[];
    nodes?: string | string[] | NodeOptions | NodeOptions[];
    cloud?: { id: string };
    resurrectStrategy?: "ping" | "optimistic" | "none";
    nodeFilter?: NodeFilterFn;
    nodeSelector?: NodeSelectorFn;
  }) {
    this.resurrectStrategy = options.resurrectStrategy ?? "ping";
    this.nodeFilter = options.nodeFilter;
    this.nodeSelector = options.nodeSelector;

    const rawNodes = options.nodes ?? options.node;
    if (rawNodes) {
      const list = Array.isArray(rawNodes) ? rawNodes : [rawNodes];
      for (const item of list) {
        this.addConnection(item);
      }
    } else if (options.cloud?.id) {
      this.addConnection(parseCloudId(options.cloud.id));
    } else {
      this.addConnection("http://localhost:9200");
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  addConnection(node: string | NodeOptions): NodeConnectionState {
    const conn = normalizeNode(node);
    const existing = this.connections.find((c) => c.id === conn.id);
    if (existing) {
      return existing;
    }
    this.connections.push(conn);
    return conn;
  }

  removeConnection(idOrUrl: string): boolean {
    const idx = this.connections.findIndex(
      (c) => c.id === idOrUrl || c.url.href === idOrUrl,
    );
    if (idx === -1) return false;
    this.connections.splice(idx, 1);
    return true;
  }

  markDead(connection: NodeConnectionState): void {
    if (this.connections.length <= 1) {
      // Never starve the only configured node
      return;
    }
    connection.status = "dead";
    connection.deadCount += 1;
    const backoffMs = Math.min(60_000 * Math.pow(2, connection.deadCount - 1), 1_800_000);
    connection.resurrectAt = Date.now() + backoffMs;
  }

  markAlive(connection: NodeConnectionState): void {
    connection.status = "alive";
    connection.deadCount = 0;
    connection.resurrectAt = 0;
  }

  getConnection(): NodeConnectionState | null {
    if (this.closed || this.connections.length === 0) {
      return null;
    }

    const now = Date.now();
    // Resurrect nodes whose cooldown expired when optimistic/ping
    if (this.resurrectStrategy !== "none") {
      for (const conn of this.connections) {
        if (conn.status === "dead" && conn.resurrectAt <= now) {
          conn.status = "alive";
        }
      }
    }

    let candidates = this.connections.filter((c) => c.status === "alive");
    if (this.nodeFilter) {
      candidates = candidates.filter(this.nodeFilter);
    }

    if (candidates.length === 0) {
      // Fallback to all connections (pick earliest resurrectAt) so requests can recover
      const sorted = [...this.connections].sort(
        (a, b) => a.resurrectAt - b.resurrectAt,
      );
      candidates = sorted;
    }

    if (this.nodeSelector) {
      return this.nodeSelector(candidates);
    }

    const chosen = candidates[this.rrIndex % candidates.length] ?? null;
    this.rrIndex = (this.rrIndex + 1) % Math.max(candidates.length, 1);
    return chosen;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
