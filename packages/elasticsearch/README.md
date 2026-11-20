# @bunest/elasticsearch

NestJS v12-compatible Elasticsearch module and full native Bun `fetch()` REST client with zero external npm runtime dependencies.

## Features

- **Full `@nestjs/elasticsearch@12` Parity**: `ElasticsearchModule.register()` and `registerAsync()` (`useFactory`, `useClass`, `useExisting`), `ElasticsearchService`, `ELASTICSEARCH_MODULE_OPTIONS`, and all REST API namespaces.
- **Native Bun `fetch()` Transport**: Multi-node failover (`ElasticsearchConnectionPool`), round-robin or custom node selection, Basic / ApiKey / Bearer authentication, gzip request compression, `AbortSignal.timeout()` timeouts, automatic retries, and Elastic Cloud ID decoding (`parseCloudId`).
- **Complete REST Namespaces**: `indices`, `cluster`, `cat`, `nodes`, `ingest`, `ilm`, `security`, `snapshot`, `tasks`, `sql`, `esql`, `asyncSearch`, and `helpers` (including bulk indexing).
- **Security & Testing**: Prototype-poisoning protection, `meta: true` full response envelopes, `child()` scoped clients, diagnostics (`ElasticsearchDiagnostic`), and injectable custom `fetch`.

## Installation

```bash
bun add @bunest/elasticsearch
```

## Quick Start

```ts
import { Injectable, Module } from "@bunest/common";
import {
  ElasticsearchModule,
  ElasticsearchService,
} from "@bunest/elasticsearch";

@Module({
  imports: [
    ElasticsearchModule.register({
      node: process.env.ELASTICSEARCH_URL ?? "http://localhost:9200",
    }),
  ],
})
export class AppModule {}

@Injectable()
export class SearchService {
  constructor(private readonly es: ElasticsearchService) {}

  searchProducts(query: string) {
    return this.es.search({
      index: "products",
      query: { match: { title: query } },
    });
  }
}
```

## Key Exports

- **Module & Service**: `ElasticsearchModule` (`register`, `registerAsync`), `ElasticsearchService`, `ELASTICSEARCH_MODULE_OPTIONS`
- **Transport & Utilities**: `ElasticsearchTransport`, `ElasticsearchConnectionPool`, `ElasticsearchSerializer`, `ElasticsearchDiagnostic`, `ElasticsearchHelpers`, `parseCloudId`
- **Namespace APIs**: `IndicesApi`, `ClusterApi`, `CatApi`, `NodesApi`, `IngestApi`, `IlmApi`, `SecurityApi`, `SnapshotApi`, `TasksApi`, `SqlApi`, `EsqlApi`, `AsyncSearchApi`, `RestNamespaceApi`
- **Errors**: `ElasticsearchError`, `ElasticsearchResponseError`, `ElasticsearchConnectionError`, `ElasticsearchTimeoutError`, `ElasticsearchAbortError`

## Documentation

- [Bunest Documentation](../../README.md)
- [ADR Index](../../docs/adr/README.md)
