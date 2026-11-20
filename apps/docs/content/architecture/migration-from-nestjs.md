# Migration from NestJS

Bunest deliberately mirrors NestJS's mental model—`@Module`, `@Controller`, `@Get/@Post`, `@Body/@Param/@Query`, `@Injectable`, Guards, Pipes, Interceptors, Exception Filters, and `ValidationPipe`—while shedding Node.js, Express/Fastify, and mandatory RxJS baggage.

## Side-by-Side Comparison

| Area | NestJS (Node.js) | Bunest (Bun Native) |
|---|---|---|
| **Runtime** | Node.js (+ Express / Fastify adapters) | **Bun only** (`>= 1.4.3`, native `Bun.serve()`) |
| **HTTP Objects** | Express `req`/`res` or Fastify `request`/`reply` | Native Web **`Request`** & **`Response`** + `ResponseContext` |
| **Interceptors** | RxJS `Observable<T>` (`next.handle().pipe(...)`) | **Native `Promise<T>`** (`await next.handle()`) — zero RxJS |
| **SSE (`@Sse`)** | RxJS `Observable<MessageEvent>` | Native **`AsyncIterable<SseMessageEvent>`** / `AsyncGenerator` |
| **File Streaming** | `StreamableFile` + `fs.createReadStream()` | Return **`Bun.file(path)`** directly (zero-copy `sendfile`) |
| **`Scope.REQUEST` DI** | Silent scope bubbling up the tree | **Fail-fast `ScopeLeakException`** at bootstrap (explicit opt-in) |
| **`ValidationPipe` defaults** | `whitelist: false`, `forbidNonWhitelisted: false` | **`whitelist: true`, `forbidNonWhitelisted: true`, `transform: true`** + prototype-pollution guard |
| **Error Format** | Varies by adapter / raw `class-validator` messages | Uniform `{ statusCode, error, message, details, timestamp, path }` |
| **TypeScript Imports** | Often relies on `emitDecoratorMetadata` without `verbatimModuleSyntax` | **`verbatimModuleSyntax: true`** (value-import classes, `import type` interfaces) |
| **Testing & E2E** | `@nestjs/testing` + Jest + Supertest | **`@bunest/testing`** + native **`bun:test`** + zero-socket **`request(app)`** / `TestClient` / `app.inject()` / `app.listen(0)` |

## Converting Common Patterns

### 1. Imports & Factory

@@filename(main.ts)
@@tab(Bunest)
```ts
import "reflect-metadata";
import { BunestFactory } from "@bunest/core";
import { ValidationPipe } from "@bunest/validation";
import { AppModule } from "./app.module";

const app = await BunestFactory.create(AppModule);
app.useGlobalPipes(new ValidationPipe());
await app.listen(3000);
```
@@switch
@@tab(NestJS)
```ts
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { AppModule } from "./app.module";

const app = await NestFactory.create(AppModule);
app.useGlobalPipes(
  new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
);
await app.listen(3000);
```

### 2. Interceptors (RxJS &rarr; `async/await`)

@@filename(timing.interceptor.ts)
@@tab(Bunest (Native Promise))
```ts
import { Injectable, type BunestInterceptor, type CallHandler, type ExecutionContext } from "@bunest/core";

@Injectable()
export class TimingInterceptor implements BunestInterceptor {
  async intercept(_ctx: ExecutionContext, next: CallHandler) {
    const start = performance.now();
    const data = await next.handle();
    return { data, tookMs: +(performance.now() - start).toFixed(2) };
  }
}
```
@@switch
@@tab(NestJS (RxJS))
```ts
import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from "@nestjs/common";
import { map } from "rxjs/operators";

@Injectable()
export class TimingInterceptor implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler) {
    const start = performance.now();
    return next.handle().pipe(
      map((data) => ({ data, tookMs: +(performance.now() - start).toFixed(2) })),
    );
  }
}
```

### 3. `@Res()` Response Handling

In Express-based NestJS, injecting `@Res()` puts the route into library-specific manual mode (`res.status(200).json(...)`). In Bunest, `@Res()` injects a lightweight **`ResponseContext`** builder (like NestJS `@Res({ passthrough: true })`), so you mutate status/headers/cookies and still **return** your value normally—or return `new Response(...)` directly for full control.

### 4. Testing & E2E (`@nestjs/testing` + Supertest &rarr; `@bunest/testing` + `bun:test`)

Official `@nestjs/testing` ties into `@nestjs/core`'s internal `NestContainer`, Node `http.Server`, and RxJS. Swap the import to **`@bunest/testing`** to keep the same `Test.createTestingModule()`, `overrideProvider`/`Guard`/`Pipe`/`Interceptor`/`Filter`/`Module`, `useMocker`, `ContextIdFactory`, and `createNestApplication()` workflow—with zero-socket Supertest-style `request(app)` built in (or `createNodeHttpServer(app)` if you still want npm `supertest`):

@@filename(users.e2e.spec.ts)
@@tab(Bunest (@bunest/testing + bun:test))
```ts
import "reflect-metadata";
import { describe, it } from "bun:test";
import { ValidationPipe } from "@bunest/core";
import { Test, createAutoMocker, request } from "@bunest/testing";
import { UsersModule } from "../src/users/users.module";

describe("Users (E2E)", () => {
  it("GET /users", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [UsersModule],
    })
      .useMocker(createAutoMocker())
      .compile();

    const app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe());
    await app.init();

    await request(app).get("/users").expect(200).expect([{ id: "1" }]);
    await app.close();
  });
});
```
@@switch
@@tab(NestJS (@nestjs/testing + Jest + Supertest))
```ts
import { Test } from "@nestjs/testing";
import { ValidationPipe } from "@nestjs/common";
import * as request from "supertest";
import { UsersModule } from "../src/users/users.module";

describe("Users (E2E)", () => {
  it("GET /users", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [UsersModule],
    }).compile();

    const app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe());
    await app.init();

    await request(app.getHttpServer()).get("/users").expect(200).expect([{ id: "1" }]);
    await app.close();
  });
});
```

See the full [Testing & E2E guide](/fundamentals/testing) for auto-mocking, stateful `request.agent(app)`, `TestClient`, `app.inject()`, SSE testing (`readSseEvents`), and `createNodeHttpServer(app)`.

## Migration Checklist

- [x] Update imports from `@nestjs/common` & `@nestjs/core` to `@bunest/core` (and `@bunest/validation` for `ValidationPipe` / `ClassSerializerInterceptor`).
- [x] Update test imports from `@nestjs/testing` & `supertest` to `@bunest/testing` (`Test`, `request`, `TestClient`, `createAutoMocker`, `CapturingLogger`) running on `bun:test`, and rename E2E files from `*.e2e-spec.ts` to `*.e2e.spec.ts` so `bun test` discovers them automatically.
- [x] Ensure `import "reflect-metadata";` is the first line of `src/main.ts` and test entrypoints.
- [x] Enable `verbatimModuleSyntax: true` in `tsconfig.json`; use `import type` for interfaces and value imports for DI services & DTO classes.
- [x] Replace RxJS `.pipe(map(...))` interceptors with `async/await next.handle()`.
- [x] Replace Express `res.status().send()` calls with `ResponseContext` or native `new Response(...)`.
- [x] Check any `Scope.REQUEST` providers—annotate intermediate consumers explicitly to satisfy Bunest's fail-fast `ScopeLeakException` gate.
