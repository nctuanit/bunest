# Frequently Asked Questions (FAQ)

Practical answers to common architectural and operational questions when building applications with Bunest.

## How do I access the raw request body (e.g. for Stripe or GitHub webhooks)?

Use the `@RawBody()` parameter decorator directly on your controller handler—no extra body-parser middleware required:

@@filename(webhooks.controller.ts)

```ts
import { Controller, Headers, Post, RawBody } from "@bunest/core";

@Controller("webhooks")
export class WebhooksController {
  @Post("stripe")
  handleStripe(
    @RawBody() rawBody: Uint8Array,
    @Headers("stripe-signature") signature: string,
  ) {
    // Verify HMAC directly against rawBody bytes
    return { bytes: rawBody.byteLength, hasSig: Boolean(signature) };
  }
}
```

> tip For built-in HMAC signature verification (Standard Webhooks, Stripe, GitHub, custom), use `@IncomingWebhook()` and `@WebhookPayload()` from [`@bunest/messaging/webhooks`](/distributed/outbox-webhooks).

## How do I set a global route prefix (with exclusions)?

Call `app.setGlobalPrefix("api")` before `app.listen()`. You can exclude health or metrics routes from the prefix:

@@filename(main.ts)

```ts
app.setGlobalPrefix("api", {
  exclude: ["health/live", "health/ready", "metrics"],
});
```

## Can I run HTTP, WebSockets, and Microservices in the same process (Hybrid App)?

Yes. Create a standard HTTP app with `BunestFactory.create(AppModule)`, attach one or more microservices via `app.connectMicroservice(...)`, and start both:

@@filename(main.ts)

```ts
import { BunestFactory } from "@bunest/core";
import { Transport } from "@bunest/microservices";
import { AppModule } from "./app.module";

const app = await BunestFactory.create(AppModule);
app.connectMicroservice({
  transport: Transport.TCP,
  options: { host: "127.0.0.1", port: 4001 },
});

await app.startAllMicroservices();
await app.listen(3000);
```

See [Microservices](/distributed/microservices) and [WebSockets](/apis/websockets) for full guides.

## What is the exact request execution order?

Every HTTP request flows through Bunest's 11-stage compiled pipeline:

1. **Route Match** (`Bun.serve` Zig router / fallback radix router)
2. **RequestContext Init** (+ `AsyncLocalStorage` if `Scope.REQUEST`)
3. **Security & CORS** (preflight, `bodyLimit`, trust-proxy IP)
4. **Middleware** (Global → Module → Controller → Method)
5. **Guards** (Global → Controller → Method) — *runs before body parsing!*
6. **Interceptors (Before)** (Global → Controller → Method)
7. **Parameter Extraction** (`@Param`, `@Query`, `@Body`, custom decorators)
8. **Pipes & Validation** (Global → Controller → Method → Parameter)
9. **Controller Handler**
10. **Interceptors (After)** (Method → Controller → Global)
11. **Response Serialization** (status, headers, cookies, streams, JSON)
- **Exception Filters** wrap stages 3–11 (Method → Controller → Global → Default).

Explore the interactive stage diagram in [Execution pipeline](/architecture/execution-pipeline).

## Why did constructor injection break with `import type`?

Because TypeScript erases `import type` at compile time, `emitDecoratorMetadata` cannot emit the runtime constructor token into `design:paramtypes`. Always **value-import** DI classes, DTOs, and entities:

```ts
// Good — emits runtime constructor metadata
import { UsersService } from "./users.service";

// Bad — erased at runtime, triggers BUNEST_E001
import type { UsersService } from "./users.service";
```

## How do I connect to multiple databases?

Register multiple named `OrmModule.forRoot({ name: "analytics", ... })` connections and inject each repository or data source by connection name:

```ts
@Injectable()
export class ReportsService {
  constructor(
    @InjectDataSource("analytics") private readonly analyticsDb: DataSource,
  ) {}
}
```

## Why does Bunest not use RxJS in Interceptors?

Bunest targets Bun's native Promise runtime and avoids shipping RxJS as a mandatory dependency. Interceptors implement `intercept(ctx, next)` where `next.handle()` returns a standard `Promise<T>`, making async/await composition simpler and faster with zero observable allocation overhead. See [Interceptors](/overview/interceptors) and [Migration from NestJS](/architecture/migration-from-nestjs).
