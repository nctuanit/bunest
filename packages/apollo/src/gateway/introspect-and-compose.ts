import type {
  FetcherFn,
  GraphQLDataSource,
} from "./graphql-data-source";
import { RemoteGraphQLDataSource } from "./graphql-data-source";

export interface ServiceEndpointDefinition {
  name: string;
  url?: string;
}

export interface IntrospectAndComposeOptions {
  subgraphs: ServiceEndpointDefinition[];
  pollIntervalInMs?: number;
  subgraphHealthCheck?: boolean;
  introspectionHeaders?: Record<string, string>;
  fetcher?: FetcherFn;
}

export interface SubgraphSdlEntry {
  readonly name: string;
  readonly url?: string;
  readonly sdl: string;
}

export interface SupergraphManager {
  initialize(options: {
    getDataSource: (serviceDef: ServiceEndpointDefinition) => GraphQLDataSource;
    update: (supergraphSdl: string) => void;
    healthCheck?: (supergraphSdl: string) => Promise<void>;
  }): Promise<{
    supergraphSdl: string;
    subgraphs?: SubgraphSdlEntry[];
    cleanup?: () => Promise<void> | void;
  }>;
}

const SERVICE_SDL_QUERY = `query __ApolloGetServiceDefinition__ { _service { sdl } }`;

/**
 * Introspects federated subgraphs via `{ _service { sdl } }` over native `fetch()`
 * (or custom `getDataSource`) and returns their SDLs for gateway composition.
 */
export class IntrospectAndCompose implements SupergraphManager {
  public readonly subgraphs: ServiceEndpointDefinition[];
  public readonly pollIntervalInMs?: number;
  private readonly introspectionHeaders?: Record<string, string>;
  private readonly fetcher?: FetcherFn;

  constructor(options: IntrospectAndComposeOptions) {
    this.subgraphs = [...options.subgraphs];
    this.pollIntervalInMs = options.pollIntervalInMs;
    this.introspectionHeaders = options.introspectionHeaders;
    this.fetcher = options.fetcher;
  }

  async loadSubgraphSdls(
    getDataSource: (serviceDef: ServiceEndpointDefinition) => GraphQLDataSource,
  ): Promise<SubgraphSdlEntry[]> {
    const entries: SubgraphSdlEntry[] = [];
    for (const def of this.subgraphs) {
      const ds =
        this.fetcher && def.url
          ? new RemoteGraphQLDataSource({
              url: def.url,
              fetcher: this.fetcher,
            })
          : getDataSource(def);
      const res = await ds.process({
        request: {
          query: SERVICE_SDL_QUERY,
          ...(this.introspectionHeaders
            ? {
                http: {
                  method: "POST",
                  headers: new Map(
                    Object.entries(this.introspectionHeaders),
                  ) as any,
                },
              }
            : {}),
        },
        context: {},
        kind: "loading schema",
      });
      const sdl = (res.data as { _service?: { sdl?: string } } | undefined)
        ?._service?.sdl;
      if (!sdl) {
        const msg = res.errors?.[0]?.message ?? "Missing _service.sdl response";
        throw new Error(
          `Failed to introspect subgraph "${def.name}" (${def.url ?? "no url"}): ${msg}`,
        );
      }
      entries.push({ name: def.name, url: def.url, sdl });
    }
    return entries;
  }

  async initialize(options: {
    getDataSource: (serviceDef: ServiceEndpointDefinition) => GraphQLDataSource;
    update: (supergraphSdl: string) => void;
  }): Promise<{
    supergraphSdl: string;
    subgraphs: SubgraphSdlEntry[];
    cleanup?: () => Promise<void> | void;
  }> {
    const entries = await this.loadSubgraphSdls(options.getDataSource);
    const combined = entries.map((e) => e.sdl).join("\n\n");
    return {
      supergraphSdl: combined,
      subgraphs: entries,
    };
  }
}
