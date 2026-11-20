# @bunest/http

Native `Bun.serve` HTTP engine for Bunest featuring a hybrid native/radix router, compiled 11-stage execution pipeline, response serializer, security middleware, static asset serving, and zero external runtime dependencies.

## Features

- **Native `Bun.serve` Adapter**: `BunHttpAdapter` (extending `AbstractHttpAdapter`) bridges Bunest controllers and middleware directly to `Bun.serve()` with fast-path dispatch for singleton routes.
- **Hybrid Routing & API Versioning**: Combines native Bun route tables with `FallbackRadixRouter`, path normalization, and URI/header/media-type/custom versioning (`extractRequestVersions`, `selectVersionedCandidate`).
- **Compiled Execution Pipeline**: Precompiles parameter extraction (`compileParameters`), guards, interceptors, pipes, exception filters (`DefaultExceptionFilter`), SSE formatting (`formatSseEvent`), and response serialization (`serializeResponse`).
- **Built-In Security & Utilities**: Prototype-pollution sanitization (`sanitizeObject`), signed cookies (`CookieSigner`), CSRF protection (`compileCsrfProtection`), security headers (`compileSecurityHeaders`), CORS (`evaluateCors`), response compression (`CompressionMiddleware`), and `ServeStaticModule`.

## Installation

```bash
bun add @bunest/http
```

> Note: `@bunest/core` includes and re-exports `@bunest/http` automatically for standard Bunest applications.

## Quick Start

```ts
import { BunHttpAdapter, RequestContext, getCurrentRequestContext } from "@bunest/http";

const adapter = new BunHttpAdapter({
  cors: { origin: true },
  securityHeaders: true,
});

// Inside an active request handled by Bunest:
const ctx: RequestContext | undefined = getCurrentRequestContext();
console.log(ctx?.method, ctx?.path);
```

## Key Exports

- **Adapters & Static Serving**: `BunHttpAdapter`, `AbstractHttpAdapter`, `DefaultHttpRuntimeBridge`, `ServeStaticModule`, `BunStaticLoader`, `AbstractLoader`, `NoopLoader`, `CompressionMiddleware`, `createCompressionMiddleware`
- **Context & Pipeline**: `RequestContext`, `requestContextStorage`, `getCurrentRequestContext`, `HttpExecutionContext`, `HttpResponseContext`, `compileRoutes`, `compileParameters`, `executeCompiledRoute`, `executeFastSingletonRoute`, `DefaultExceptionFilter`, `serializeResponse`, `formatSseEvent`
- **Routing & Versioning**: `FallbackRadixRouter`, `NativePathMatcher`, `scanControllers`, `canonicalizePath`, `extractRequestVersions`, `selectVersionedCandidate`, `DuplicateRouteException`, `InvalidControllerException`, `InvalidRouteException`
- **Security & Parsing**: `CookieSigner`, `signCookieValue`, `unsignCookieValue`, `compileCsrfProtection`, `compileSecurityHeaders`, `applySecurityHeaders`, `evaluateCors`, `sanitizeObject`, `parseRequestBody`, `extractClientIp`

## Documentation

- [Bunest Documentation](../../README.md)
- [ADR Index](../../docs/adr/README.md)
