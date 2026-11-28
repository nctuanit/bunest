# Why Bunest? Solving NestJS's Top 10 Community Pain Points

NestJS popularized modular, DI-driven backend architecture in TypeScript (`@Module`, `@Controller`, Guards, Pipes, Interceptors, Exception Filters, `TestingModule`). Over the years, however, production teams running NestJS on Node.js have repeatedly reported the same ten friction points.

Bunest preserves the NestJS mental model (including 100% NestJS v12 core conformance) while systematically eliminating those pain points from first principles on **Bun >= 1.4.5**.

## Pain-Point Matrix

| # | NestJS Community Pain Point | How Bunest Solves It |
| --- | --- | --- |
| 1 | Heavy boilerplate for small APIs / lambdas | `defineRoutes()`, `BunestFactory.createRoutes()`, `BunestFactory.createAuto({ routes })`, `createFetchHandler()` |
| 2 | DI wiring bugs only surface at runtime | Fail-fast `BUNEST_E*` codes with ordered fixes, `bunest check` static analyzer, and `ScopeLeakException` at bootstrap |
| 3 | Slow cold starts & bloated `node_modules` | **0 external runtime dependencies** across all 19 packages (`ADR-017`), `~0.11 ms` bootstrap, native `Bun.serve` |
| 4 | Forced RxJS in Interceptors, SSE & Microservices | Native `Promise<T>` onion interceptors and `AsyncGenerator` SSE streams — zero RxJS |
| 5 | `Scope.REQUEST` silently bubbles up the DI tree | Fail-fast `ScopeLeakException` (`BUNEST_E003`) + zero-overhead `ClsModule` (`AsyncLocalStorage`) |
| 6 | Duplicated DTOs, Swagger decorators, and frontend types | Single-source `defineContract()` &rarr; `implementContract()` + auto OpenAPI 3.1 + `createContractClient()` |
| 7 | Testing boilerplate & slow Supertest TCP sockets | Zero-socket `request(app)`, `app.fetch()`, and typed `mod.createContractClient(contract)` |
| 8 | Decorator metadata breaks under bundlers / single binaries | `bunest build` & `bunest build --compile` enable AOT DI metadata (`aotDiMetadata: true`) automatically |
| 9 | Fragile Passport.js glue for real-world auth & authz | Native `@bunest/security/auth` (JWT + refresh rotation + TOTP MFA + API keys) & `@bunest/security/authz` (`@Policy` / `@Can`) |
| 10 | Microservices, resilience & storage require heavy third-party stacks | Built-in `@bunest/microservices` (with CLS propagation & DLQ), `@bunest/resilience` (`@Retry`, `@CircuitBreaker`, `@Idempotent`), and `@bunest/storage` |

---

## 1. Zero Boilerplate When You Want It, Full DI When You Grow

Small microservices and edge handlers do not need `@Module` and `@Controller` ceremony. Bunest lets you start with functional routes and seamlessly inject `@Injectable()` services as your app grows:

```ts
import { BunestFactory, Injectable, defineRoutes } from "@bunest/core";
import { s } from "@bunest/validation/schema";

@Injectable()
class GreetingService {
  greet(name: string) {
    return `Hello, ${name}!`;
  }
}

const routes = defineRoutes("/api", { tags: ["Greeting"] })
  .get("/hello/:name", {
    params: s.object({ name: s.string().min(1) }),
    responseSchema: s.object({ message: s.string() }),
    handler: ({ params }, app) => ({
      message: app.get(GreetingService).greet(params.name),
    }),
  });

const app = await BunestFactory.createRoutes(routes, {
  providers: [GreetingService],
});
await app.listen(3000);
```

See the [Functional Routes recipe](/recipes/functional-routes) and [`examples/functional-minimal`](https://github.com/nctuanit/bunest/tree/main/examples/functional-minimal).

## 2. Fail-Fast DI & Actionable `BUNEST_E*` Diagnostics

Instead of cryptic runtime `undefined` crashes, Bunest validates the entire dependency graph, circular chains, and scope boundaries during `app.init()`. Every bootstrap error emits a stable code (`BUNEST_E001`–`BUNEST_E205`), the exact resolution path, and ordered fix instructions. Run `bunest check` in CI to catch issues statically before code ever executes.

## 3. Zero External Runtime Dependencies & Single Binaries

Every `@bunest/*` package has **zero** external runtime dependencies (`ADR-017`). Bunest builds directly on `Bun.serve`, `Bun.SQL`, `bun:sqlite`, `Bun.RedisClient`, `Bun.password`, `Bun.CryptoHasher`, and WebCrypto. Combined with `bunest build --compile` (which automatically injects AOT DI metadata), you can ship an entire DI-powered backend as a single executable binary with instant cold starts.

## 4. Native `Promise<T>` & `AsyncGenerator` (No RxJS)

Interceptors use plain `async/await`:

```ts
@Injectable()
export class TimingInterceptor implements BunestInterceptor {
  async intercept(ctx: ExecutionContext, next: CallHandler) {
    const start = performance.now();
    const result = await next.handle();
    console.log(`${(performance.now() - start).toFixed(2)} ms`);
    return result;
  }
}
```

Server-Sent Events (`@Sse()`) use standard `async *` generators with `@SseSignal()` cancellation instead of RxJS `Observable` pipelines.

## 5. No Silent `Scope.REQUEST` Performance Cliffs

In NestJS, marking one leaf provider `Scope.REQUEST` silently forces every ancestor service and controller to be re-instantiated per HTTP request. Bunest refuses silent scope bubbling with `ScopeLeakException` at startup and recommends `ClsModule` (`ClsService`) for request-scoped context while keeping singletons hot at >5M ops/s.

## 6. Single-Source Contracts: Server + Auto OpenAPI 3.1 + Typed Client

Define your API once with `defineContract()` and Standard Schema (`s.*`, Zod, Valibot, or ArkType). Bunest automatically drives:

1. **Server routing, validation & response serialization** via `implementContract()` / `FunctionalModule.forContract()`
2. **OpenAPI 3.1 & Swagger UI** via `@bunest/swagger` (no duplicated `@ApiProperty()` / `@ApiResponse()` decorators)
3. **End-to-end typed runtime & test clients** via `createContractClient()` and `mod.createContractClient()`

See the [Typed Contracts & RPC Client guide](/apis/contracts-typed-client) and [`examples/fullstack-contract-rpc`](https://github.com/nctuanit/bunest/tree/main/examples/fullstack-contract-rpc).

## 7. Zero-Socket, Type-Safe Testing

No ephemeral port juggling or Supertest overhead. Test both classic controllers and contract-first APIs directly in-process via `app.fetch()`, `request(app)`, or `mod.createContractClient(contract)`:

```ts
const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
const client = await mod.createContractClient(tasksContract);

const created = await client.tasks.create({ body: { title: "Ship v1" } });
expect(created.title).toBe("Ship v1");
```

## 8. Bulletproof Bundling & Standalone Executables

Legacy `emitDecoratorMetadata` often breaks when bundled by esbuild/Bun without plugin configuration. `bunest build` and `bunest build --compile` enable `createBunestPlugin({ aotDiMetadata: true })` out of the box so constructor DI metadata is emitted statically at build time.

## 9. Native Identity & ABAC Authorization (Zero Passport)

`@bunest/security/auth` and `@bunest/security/authz` replace sprawling Passport strategies with first-class Bun-native primitives: Argon2id `PasswordHasher`, JWT access tokens with rotating opaque refresh-token families (with automatic reuse detection & family revocation), encrypted TOTP MFA (`MfaService`), prefixed `ApiKeyProvider`, and deny-by-default ABAC `@Policy()` / `@Can()` guards.

Explore [`examples/multi-auth-security`](https://github.com/nctuanit/bunest/tree/main/examples/multi-auth-security).

## 10. Built-In Distributed Reliability & Object Storage

Production backends need more than HTTP controllers:

- **Resilient Microservices**: `@bunest/microservices` automatically propagates `ClsService` context and W3C `traceparent` across RPC hops and provides poison-message `deadLetterHandler` support.
- **Resilience & Idempotency**: `@bunest/resilience` ships `@Retry`, `@CircuitBreaker`, `@Fallback`, `@Timeout`, `@Bulkhead`, distributed `@WithLock`, and `@Idempotent()` deduplication.
- **Signed Object Storage**: `@bunest/storage` delivers unified `InMemoryDisk`, `LocalDisk`, and `S3Disk` (AWS S3 / R2 / MinIO) with presigned uploads/downloads, Range `206`, ETag `304`, and `inspectImage()`.

Explore [`examples/broker-microservices`](https://github.com/nctuanit/bunest/tree/main/examples/broker-microservices) and [`examples/storage-signed-uploads`](https://github.com/nctuanit/bunest/tree/main/examples/storage-signed-uploads).
