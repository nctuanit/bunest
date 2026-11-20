# @bunest/http-client

Zero-dependency Promise-based HTTP client for Bunest built on Bun's native `fetch()`, with 100% `@nestjs/http-client` API parity, named clients, retries, timeouts, interceptors, and typed errors.

## Features

- **Named & Default Clients**: `HttpClientModule.forRoot()`, `forRootAsync()`, `register()`, `registerAsync()`, and `@InjectHttpClient(name)` for managing multiple upstream APIs.
- **Typed Verb Methods**: `request`, `get`, `post`, `put`, `patch`, `delete`, `head`, and `options` with typed response parsing.
- **Path Params & Query Serialization**: `params: { id: "42" }` with dot-segment protection and `query` array/Date serialization.
- **Resilient Retries & Timeouts**: Exponential backoff with `full`/`equal`/`none` jitter, `Retry-After` (seconds & HTTP-date) support, custom `retryIf`, replayable body guards, and per-attempt `Duration` timeouts combined with caller `AbortSignal`.
- **Interceptors & Redirect Safety**: Ordered function, instance, or DI-resolved class interceptors (`HttpClientInterceptor`), plus same-origin redirect safety to prevent credential leakage when `baseUrl` is configured.
- **Typed Error Hierarchy**: `HttpClientError`, `HttpNetworkError`, `HttpTimeoutError`, `HttpResponseError`, `HttpParseError`, and `toHttpException()`.

## Installation

```bash
bun add @bunest/http-client
```

## Quick Start

```ts
import { Injectable, Module } from "@bunest/common";
import {
  HttpClient,
  HttpClientModule,
  InjectHttpClient,
} from "@bunest/http-client";

@Module({
  imports: [
    HttpClientModule.register({
      name: "github",
      baseUrl: "https://api.github.com",
      timeout: "5s",
      retry: { attempts: 3 },
    }),
  ],
})
export class AppModule {}

@Injectable()
export class GitHubService {
  constructor(
    @InjectHttpClient("github") private readonly http: HttpClient,
  ) {}

  getRepo(owner: string, repo: string) {
    return this.http.get<{ full_name: string }>("/repos/:owner/:repo", {
      params: { owner, repo },
    });
  }
}
```

## Key Exports

- **Module & Client**: `HttpClientModule` (`forRoot`, `forRootAsync`, `register`, `registerAsync`), `HttpClient`, `@InjectHttpClient()`, `getHttpClientToken`, `HTTP_CLIENT_MODULE_OPTIONS`
- **Errors & Utilities**: `HttpClientError`, `HttpNetworkError`, `HttpTimeoutError`, `HttpResponseError`, `HttpParseError`, `toHttpException`

## Documentation

- [Bunest Documentation](../../README.md)
- [ADR Index](../../docs/adr/README.md)
