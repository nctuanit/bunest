# Execution context

Bunest provides `ArgumentsHost` and `ExecutionContext` (extending `ArgumentsHost`) to give **guards**, **interceptors**, **exception filters**, and **custom parameter decorators** unified access to the current request, response context, controller class, and handler method.

## `ArgumentsHost`

`ArgumentsHost` abstracts the arguments passed to a handler across transport types (`"http" | "ws" | "rpc"`):

```ts
export interface ArgumentsHost {
  getArgs<T extends unknown[] = unknown[]>(): T;
  getArgByIndex<T = unknown>(index: number): T;
  switchToHttp(): HttpArgumentsHost;
  switchToWs(): WsArgumentsHost;
  switchToRpc(): RpcArgumentsHost;
  getType<TContext extends string = ContextType>(): TContext;
}
```

Inside HTTP Exception Filters, call `host.switchToHttp()` to obtain the native Web `Request` and mutable `ResponseContext`:

@@filename(audit-error.filter.ts)

```ts
import {
  Catch,
  HttpException,
  type ArgumentsHost,
  type ExceptionFilter,
} from "@bunest/core";

@Catch(HttpException)
export class AuditErrorFilter implements ExceptionFilter<HttpException> {
  catch(exception: HttpException, host: ArgumentsHost) {
    if (host.getType() !== "http") return;

    const http = host.switchToHttp();
    const request: Request = http.getRequest();
    const response = http.getResponse();

    response.header("X-Error-Handled-By", "AuditErrorFilter");
    return Response.json(
      {
        statusCode: exception.getStatus(),
        message: exception.message,
        method: request.method,
        path: new URL(request.url).pathname,
      },
      { status: exception.getStatus() },
    );
  }
}
```

## `ExecutionContext`

`ExecutionContext` extends `ArgumentsHost` with two reflection helpers:

- **`context.getClass()`** — returns the active `@Controller()` constructor (e.g., `UsersController`).
- **`context.getHandler()`** — returns the active route handler method reference (e.g., `UsersController.prototype.create`).

## Reading Metadata with `Reflector`

`Reflector` (`@bunest/core`, re-exported by `@bunest/core`) reads metadata attached via `@SetMetadata()` or `Reflector.createDecorator()`:

| Method                            | Behavior across `[handler, controllerClass]`                      |
| --------------------------------- | ----------------------------------------------------------------- |
| `get(key, target)`                | Reads metadata from a single target                               |
| `getAll(key, targets)`            | Returns array of metadata values for each target                  |
| `getAllAndOverride(key, targets)` | Returns the **first defined** value (method overrides controller) |
| `getAllAndMerge(key, targets)`    | Combines arrays or merges objects across all targets              |

@@filename(feature-flag.guard.ts)

```ts
import {
  Injectable,
  Reflector,
  type CanActivate,
  type ExecutionContext,
} from "@bunest/core";

export const FeatureFlag = Reflector.createDecorator<string>();

@Injectable()
export class FeatureFlagGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const flag = this.reflector.getAllAndOverride(FeatureFlag, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!flag) return true;
    return Bun.env[`FEATURE_${flag.toUpperCase()}`] === "true";
  }
}
```
