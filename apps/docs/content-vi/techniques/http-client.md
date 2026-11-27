# HTTP Client

**`@bunest/core/client`** là HTTP client gọi ra ngoài không phụ thuộc ngoài của Bunest, được xây dựng trực tiếp trên `fetch()` gốc của Bun—hỗ trợ client định danh, lỗi có kiểu dữ liệu, tự động thử lại, timeout, interceptor cho request/response và tích hợp DI.

## Cài đặt

```bash
bun add @bunest/core
```

## Sử dụng `@bunest/core/client`

Đăng ký HTTP client mặc định hoặc định danh qua `HttpClientModule.forRoot()` / `forFeature()`:

@@filename(app.module.ts)

```ts
import { Module } from "@bunest/core";
import { HttpClientModule } from "@bunest/core/client";

@Module({
  imports: [
    HttpClientModule.register({
      baseUrl: "https://api.github.com",
      timeout: 5_000,
      headers: { Accept: "application/vnd.github+json" },
      retry: { attempts: 3 },
    }),
  ],
})
export class AppModule {}
```

Inject `HttpClient` và thực hiện các yêu cầu định kiểu chặt chẽ:

@@filename(github.service.ts)

```ts
import { Injectable } from "@bunest/core";
import { HttpClient, HttpResponseError } from "@bunest/core/client";

@Injectable()
export class GithubService {
  constructor(private readonly http: HttpClient) {}

  async getRepo(owner: string, repo: string) {
    try {
      return await this.http.get<{
        full_name: string;
        stargazers_count: number;
      }>(`/repos/${owner}/${repo}`);
    } catch (err) {
      if (err instanceof HttpResponseError && err.status === 404) {
        return null;
      }
      throw err;
    }
  }
}
```
