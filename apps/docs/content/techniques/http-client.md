# HTTP Client

**`@bunest/core/client`** is Bunest's zero-dependency outbound HTTP client built directly on Bun's native `fetch()`—with named clients, typed errors, automatic retries, timeouts, request/response interceptors, and DI integration.

## Installation

```bash
bun add @bunest/core
```

## Using `@bunest/core/client`

Register default or named HTTP clients via `HttpClientModule.forRoot()` / `forFeature()`:

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

Inject `HttpClient` and make strongly typed requests:

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
