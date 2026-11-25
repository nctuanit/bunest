# Elasticsearch

**`@bunest/elasticsearch`** cung cấp khả năng tương thích API `@nestjs/elasticsearch` v12 ở mức 100% kết hợp với REST client dùng `fetch()` thuần Bun (`ElasticsearchService`) — không phụ thuộc bất kỳ thư viện npm runtime ngoài nào.

## Cài đặt

```bash
bun add @bunest/elasticsearch
```

## Thiết lập Module

Đăng ký `ElasticsearchModule.register()` hoặc `registerAsync()`:

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

## Đánh chỉ mục & Tìm kiếm tài liệu

Tiêm `ElasticsearchService` để đánh chỉ mục, tìm kiếm, nạp dữ liệu hàng loạt (bulk-load), hoặc quản lý các chỉ mục (index) và tình trạng cụm (cluster health):

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
