# Elasticsearch

**`@bunest/elasticsearch`** provides 100% `@nestjs/elasticsearch` v12 API parity paired with a full Bun-native `fetch()` REST client (`ElasticsearchService`)—zero external npm runtime dependencies.

## Installation

```bash
bun add @bunest/elasticsearch
```

## Module Setup

Register `ElasticsearchModule.register()` or `registerAsync()`:

@@filename(app.module.ts)
```ts
import { Module } from "@bunest/core";
import { ElasticsearchModule } from "@bunest/elasticsearch";

@Module({
  imports: [
    ElasticsearchModule.register({
      node: process.env.ELASTICSEARCH_URL ?? "http://localhost:9200",
      auth: process.env.ELASTIC_API_KEY
        ? { apiKey: process.env.ELASTIC_API_KEY }
        : undefined,
    }),
  ],
})
export class AppModule {}
```

## Indexing & Searching Documents

Inject `ElasticsearchService` to index, search, bulk-load, or manage indices and cluster health:

@@filename(search.service.ts)
```ts
import { Injectable } from "@bunest/core";
import { ElasticsearchService } from "@bunest/elasticsearch";

@Injectable()
export class SearchService {
  constructor(private readonly es: ElasticsearchService) {}

  async indexArticle(id: string, title: string, body: string) {
    return this.es.index({
      index: "articles",
      id,
      document: { title, body },
    });
  }

  async searchArticles(query: string) {
    return this.es.search({
      index: "articles",
      query: {
        multi_match: { query, fields: ["title^2", "body"] },
      },
    });
  }
}
```
