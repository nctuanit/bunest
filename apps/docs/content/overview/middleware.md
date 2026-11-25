# Middleware

Middleware executes at **Stage 4** of the [11-Stage Execution Pipeline](/architecture/execution-pipeline)—after CORS/security pre-processing and **before** guards, interceptors, parameter extraction, and route handlers.

Unlike Express middleware, Bunest middleware operates natively on Web `Request` and Bunest's `ResponseContext`—with zero Node HTTP shims.

## Class-Based Middleware (`BunestMiddleware`)

Implement the `BunestMiddleware` interface on an `@Injectable()` class when your middleware needs constructor DI:

@@filename(logger.middleware.ts)

```ts
import {
  Injectable,
  Logger,
  type BunestMiddleware,
  type NextFunction,
  type ResponseContext,
} from "@bunest/core";

@Injectable()
export class RequestLoggerMiddleware implements BunestMiddleware {
  private readonly logger = new Logger("HTTP");

  async use(req: Request, res: ResponseContext, next: NextFunction) {
    const start = performance.now();
    const requestId = crypto.randomUUID();
    res.header("X-Request-Id", requestId);

    const result = await next();
    const ms = (performance.now() - start).toFixed(2);
    this.logger.log(`${req.method} ${new URL(req.url).pathname} (${ms}ms)`);
    return result;
  }
}
```

## Functional Middleware

When no DI dependencies are required, use a lightweight `MiddlewareFunction`:

@@filename(timing.middleware.ts)

```ts
import type { MiddlewareFunction } from "@bunest/core";

export const poweredByMiddleware: MiddlewareFunction = async (
  _req,
  res,
  next,
) => {
  res.header("X-Runtime", "Bun");
  return next();
};
```

## Applying Middleware in Modules

Modules that attach middleware implement `BunestModule` and its `configure(consumer: MiddlewareConsumer)` method:

@@filename(app.module.ts)

```ts
import {
  Module,
  RequestMethod,
  type BunestModule,
  type MiddlewareConsumer,
} from "@bunest/core";
import { RequestLoggerMiddleware } from "./middleware/logger.middleware";
import { poweredByMiddleware } from "./middleware/timing.middleware";
import { UsersController } from "./users/users.controller";
import { UsersModule } from "./users/users.module";

@Module({
  imports: [UsersModule],
})
export class AppModule implements BunestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(RequestLoggerMiddleware, poweredByMiddleware)
      .exclude({ path: "users/health", method: RequestMethod.GET })
      .forRoutes(UsersController);
  }
}
```

`forRoutes()` accepts route strings (`"users"`, `"users/*"`), `RouteInfo` objects (`{ path: "users", method: RequestMethod.POST }`), or controller classes (`UsersController`).

## Global Middleware

Register middleware that applies to every route globally via `app.use(...)`:

@@filename(main.ts)

```ts
const app = await BunestFactory.create(AppModule);
app.use(poweredByMiddleware);
await app.listen(3000);
```

## Short-Circuiting & Bootstrap Pre-Binding

- **Short-circuiting:** Returning a native `new Response(...)` from middleware immediately halts downstream stages (skipping guards, interceptors, pipes, and handler) while still applying configured CORS headers.
- **Exception handling:** Throwing an `HttpException` inside middleware routes directly to Exception Filters.
- **Zero runtime path matching:** Because Bun native routes bypass `fetch()`, Bunest pre-resolves every route's matching middleware chain **at bootstrap** and binds it straight into the compiled route closure.
