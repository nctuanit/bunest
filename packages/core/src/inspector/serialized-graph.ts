import { MultiMap, type InjectionToken, type Scope } from "../common/index";

export type SerializedGraphStatus = "partial" | "complete";

export interface SerializedGraphMetadata {
  cause?: {
    type: string;
    error?: unknown;
    moduleId?: string;
    nodeId?: string;
  };
}

export interface GraphNodeDefinition {
  id: string;
  label: string;
  parent?: string;
  metadata: {
    type: "module" | "provider" | "controller" | "injectable" | "middleware";
    sourceModuleName?: string;
    durable?: boolean;
    static?: boolean;
    transient?: boolean;
    exported?: boolean;
    global?: boolean;
    dynamic?: boolean;
    internal?: boolean;
    token?: string;
    scope?: Scope;
    initTime?: number;
    enhancer?: boolean;
  };
}

export interface GraphEdgeDefinition {
  id: string;
  source: string;
  target: string;
  metadata:
    | {
        type: "module-to-module";
        sourceModuleName: string;
        targetModuleName: string;
      }
    | {
        type: "class-to-class";
        sourceClassName: string;
        targetClassName: string;
        sourceClassToken?: InjectionToken;
        targetClassToken?: InjectionToken;
        sourceModuleName: string;
        targetModuleName: string;
        injectionType: "constructor" | "property" | "decorator";
        keyOrIndex?: string | number | symbol;
        internal?: boolean;
      };
}

export interface GraphEntrypoint<T = Record<string, unknown>> {
  id: string;
  type: string;
  methodName: string;
  className: string;
  classNodeId: string;
  metadata: T;
}

export interface OrphanedEnhancerDefinition {
  subtype: "guard" | "interceptor" | "pipe" | "filter";
  ref: unknown;
}

export interface SerializedGraphJson {
  nodes: Record<string, GraphNodeDefinition>;
  edges: Record<string, GraphEdgeDefinition>;
  entrypoints: Record<string, GraphEntrypoint[]>;
  extras: {
    orphanedEnhancers: OrphanedEnhancerDefinition[];
    attachedEnhancers: Array<{ nodeId: string }>;
  };
  status: SerializedGraphStatus;
  metadata?: SerializedGraphMetadata;
}

type WithOptionalId<T extends { id: string }> = Omit<T, "id"> &
  Partial<Pick<T, "id">>;

/**
 * Serializable application dependency graph matching NestJS `SerializedGraph`
 * (compatible with `snapshot: true`, `PartialGraphHost`, and Devtools inspection).
 */
export class SerializedGraph {
  private readonly nodes = new Map<string, GraphNodeDefinition>();
  private readonly edges = new Map<string, GraphEdgeDefinition>();
  private readonly entrypoints = new MultiMap<string, GraphEntrypoint>();
  private readonly extras: {
    orphanedEnhancers: OrphanedEnhancerDefinition[];
    attachedEnhancers: Array<{ nodeId: string }>;
  } = {
    orphanedEnhancers: [],
    attachedEnhancers: [],
  };
  private _status: SerializedGraphStatus = "complete";
  private _metadata?: SerializedGraphMetadata;

  set status(status: SerializedGraphStatus) {
    this._status = status;
  }

  get status(): SerializedGraphStatus {
    return this._status;
  }

  set metadata(metadata: SerializedGraphMetadata | undefined) {
    this._metadata = metadata;
  }

  get metadata(): SerializedGraphMetadata | undefined {
    return this._metadata;
  }

  insertNode(nodeDefinition: GraphNodeDefinition): GraphNodeDefinition {
    const existing = this.nodes.get(nodeDefinition.id);
    if (existing) {
      return existing;
    }
    this.nodes.set(nodeDefinition.id, nodeDefinition);
    return nodeDefinition;
  }

  insertEdge(
    edgeDefinition: WithOptionalId<GraphEdgeDefinition>,
  ): GraphEdgeDefinition {
    const id =
      edgeDefinition.id ?? this.generateUuidByEdgeDefinition(edgeDefinition);
    const fullEdge: GraphEdgeDefinition = {
      ...edgeDefinition,
      id,
    } as GraphEdgeDefinition;
    this.edges.set(id, fullEdge);
    return fullEdge;
  }

  insertEntrypoint<T = Record<string, unknown>>(
    definition: GraphEntrypoint<T>,
    parentId: string,
  ): void {
    this.entrypoints.add(parentId, definition as GraphEntrypoint);
  }

  insertOrphanedEnhancer(entry: OrphanedEnhancerDefinition): void {
    this.extras.orphanedEnhancers.push(entry);
  }

  insertAttachedEnhancer(nodeId: string): void {
    this.extras.attachedEnhancers.push({ nodeId });
  }

  getNodeById(id: string): GraphNodeDefinition | undefined {
    return this.nodes.get(id);
  }

  toJSON(): SerializedGraphJson {
    const json: SerializedGraphJson = {
      nodes: Object.fromEntries(this.nodes.entries()),
      edges: Object.fromEntries(this.edges.entries()),
      entrypoints: Object.fromEntries(this.entrypoints.entries()),
      extras: {
        orphanedEnhancers: [...this.extras.orphanedEnhancers],
        attachedEnhancers: [...this.extras.attachedEnhancers],
      },
      status: this._status,
      ...(this._metadata !== undefined ? { metadata: this._metadata } : {}),
    };
    return json;
  }

  toString(): string {
    return JSON.stringify(
      this.toJSON(),
      (_key, value) => {
        if (typeof value === "symbol") {
          return value.toString();
        }
        if (typeof value === "function") {
          return value.name || "Function";
        }
        return value;
      },
      2,
    );
  }

  private generateUuidByEdgeDefinition(
    edgeDefinition: WithOptionalId<GraphEdgeDefinition>,
  ): string {
    const payload = `${edgeDefinition.source}|${edgeDefinition.target}|${edgeDefinition.metadata.type}|${
      edgeDefinition.metadata.type === "class-to-class"
        ? String(edgeDefinition.metadata.keyOrIndex ?? "")
        : ""
    }`;
    return new Bun.CryptoHasher("sha256")
      .update(payload)
      .digest("hex")
      .slice(0, 16);
  }
}
