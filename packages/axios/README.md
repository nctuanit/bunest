# @bunest/axios

Zero-dependency NestJS-compatible `HttpModule` and `HttpService` built natively on Bun's `fetch()` API (Promise-first per ADR-008, no RxJS or Axios required).

## Features

- **Module Registration**: `HttpModule.register(options)` and `HttpModule.registerAsync({ imports, inject, useFactory | useClass | useExisting })`.
- **HTTP Verb Methods**: `HttpService` provides `request`, `get`, `delete`, `head`, `post`, `put`, `patch`, `postForm`, `putForm`, and `patchForm`.
- **Axios-Compatible Interceptors**: `interceptors.request.use(...)` and `interceptors.response.use(...)`.
- **Native Fetch Enhancements**: Native `AbortSignal.timeout()` timeouts, automatic query parameter serialization, `validateStatus`, retry support, and custom `fetch` injection for zero-socket testing.

## Installation

```bash
bun add @bunest/axios
```

## Quick Start

```ts
import { Injectable, Module } from "@bunest/common";
import { HttpModule, HttpService } from "@bunest/axios";

@Module({
  imports: [
    HttpModule.register({
      baseURL: "https://api.example.com",
      timeout: 5_000,
    }),
  ],
})
export class AppModule {}

@Injectable()
export class UsersClient {
  constructor(private readonly http: HttpService) {}

  async findUser(id: string) {
    const response = await this.http.get<{ id: string; name: string }>(
      `/users/${id}`,
    );
    return response.data;
  }
}
```

## Key Exports

- **Module & Service**: `HttpModule`, `HttpService`
- **Errors**: `HttpError`
- **Tokens**: `HTTP_MODULE_ID`, `HTTP_MODULE_OPTIONS`

## Documentation

- [Bunest Documentation](../../README.md)
- [ADR Index](../../docs/adr/README.md)
