# HTTP Client & Axios

Bunest offers two zero-dependency outbound HTTP client packages built directly on Bun's native `fetch()`:

- **`@bunest/http-client`** — Modern Bun-native HTTP client with named clients, typed errors, automatic retries, timeouts, request/response interceptors, and DI integration.
- **`@bunest/axios`** — Drop-in `@nestjs/axios` v12 migration package (`HttpModule` & `HttpService`) backed by native `fetch()` with **zero Axios and zero RxJS** (methods return native `Promise<AxiosResponse<T>>`, [ADR-013](/architecture/adrs)).

## Installation

@@tab(@bunest/http-client)
```bash
bun add @bunest/http-client
```
@@switch
@@tab(@bunest/axios)
```bash
bun add @bunest/axios
```

## Using `@bunest/http-client`

Register default or named HTTP clients via `HttpClientModule.forRoot()` / `forFeature()`:

@@filename(app.module.ts)
```ts
import { Module } from "@bunest/core";
import { HttpClientModule } from "@bunest/http-client";

@Module({
  imports: [
    HttpClientModule.forRoot({
      baseUrl: "https://api.github.com",
      timeout: 5_000,
      headers: { Accept: "application/vnd.github+json" },
      retry: { maxAttempts: 3 },
    }),
  ],
})
export class AppModule {}
```

Inject `HttpClient` and make strongly typed requests:

@@filename(github.service.ts)
```ts
import { Injectable } from "@bunest/core";
import { HttpClient, HttpResponseError } from "@bunest/http-client";

@Injectable()
export class GithubService {
  constructor(private readonly http: HttpClient) {}

  async getRepo(owner: string, repo: string) {
    try {
      return await this.http.get<{ full_name: string; stargazers_count: number }>(
        `/repos/${owner}/${repo}`,
      );
    } catch (err) {
      if (err instanceof HttpResponseError && err.status === 404) {
        return null;
      }
      throw err;
    }
  }
}
```

## Drop-In `@bunest/axios`

Replace `@nestjs/axios` imports with `@bunest/axios` to use `HttpModule` and `HttpService` with `AbortSignal.timeout`, interceptors, form helpers (`postForm`, `putForm`, `patchForm`), and `axiosRef`:

@@filename(payments.service.ts)
```ts
import { Injectable, Module } from "@bunest/core";
import { HttpModule, HttpService } from "@bunest/axios";

@Injectable()
export class PaymentsService {
  constructor(private readonly http: HttpService) {}

  async fetchStatus(id: string) {
    const res = await this.http.get<{ status: string }>(`https://api.example.com/payments/${id}`);
    return res.data;
  }
}

@Module({
  imports: [HttpModule.register({ timeout: 5_000 })],
  providers: [PaymentsService],
})
export class PaymentsModule {}
```
