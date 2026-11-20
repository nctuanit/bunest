# Injection scopes

Every provider and controller in Bunest has a well-defined DI lifetime governed by the `Scope` enum (`@bunest/common`, [ADR-012](/architecture/adrs)).

## Available Scopes

| Scope | Lifetime | Instantiation Timing | Shared Across Requests? |
|---|---|---|---|
| `Scope.SINGLETON` *(default)* | Application lifetime | Eager at bootstrap | Yes — MUST remain stateless |
| `Scope.TRANSIENT` | Per injection point / resolve call | On each resolve (at bootstrap for singleton consumers; per request for request-scoped consumers) | Only when owned by a singleton |
| `Scope.REQUEST` | Single HTTP request lifetime | Lazy per request inside `RequestContainer` | **Never** — isolated per request, shared within the same request |

## Strict Fail-Fast Scope-Leak Detection

In NestJS, injecting a `Scope.REQUEST` provider into a singleton silently "bubbles" request scope up the entire dependency tree—often degrading throughput unintentionally without developer awareness.

**Bunest takes a stricter, safer approach:** a `Scope.SINGLETON` consumer **MUST NEVER** depend (directly or transitively) on a `Scope.REQUEST` provider. Violations fail fast at bootstrap with **`ScopeLeakException`** before `Bun.serve()` starts!

@@component(scope-matrix)

When a scope leak is detected at bootstrap, Bunest prints the exact offending chain and remediation hint:

```text
ScopeLeakException: SINGLETON "UsersController" cannot depend on REQUEST-scoped "TenantContext".
Chain: UsersController [SINGLETON] -> UsersService [SINGLETON] -> TenantContext [REQUEST]
Fix: Mark "UsersController" and "UsersService" with { scope: Scope.REQUEST }, or read ambient RequestContext inside request handlers.
```

## Using `Scope.REQUEST` Properly

Declare `scope: Scope.REQUEST` explicitly along the consumer chain, and inject Bunest's built-in `REQUEST` or `REQUEST_CONTEXT` tokens:

@@filename(tenant-context.service.ts)
```ts
import {
  Inject,
  Injectable,
  REQUEST,
  Scope,
  type OnRequestDestroy,
} from "@bunest/core";

@Injectable({ scope: Scope.REQUEST })
export class TenantContext implements OnRequestDestroy {
  readonly tenantId: string;
  readonly correlationId: string;

  constructor(@Inject(REQUEST) req: Request) {
    this.tenantId = req.headers.get("x-tenant-id") ?? "public";
    this.correlationId = req.headers.get("x-correlation-id") ?? crypto.randomUUID();
  }

  onRequestDestroy(): void {
    // Runs in a finally block when the request finishes or client aborts
  }
}
```

@@filename(tenant-orders.controller.ts)
```ts
import { Controller, Get, Scope } from "@bunest/core";
import { TenantContext } from "./tenant-context.service";

@Controller({ path: "orders", scope: Scope.REQUEST })
export class TenantOrdersController {
  constructor(private readonly tenant: TenantContext) {}

  @Get()
  list() {
    return {
      tenantId: this.tenant.tenantId,
      correlationId: this.tenant.correlationId,
    };
  }
}
```

## Zero-Overhead Fast Path for Singleton Routes

At bootstrap, Bunest statically computes `requiresRequestScope: boolean` for every compiled route by inspecting its controller, guards, pipes, interceptors, and exception filters:

- If `requiresRequestScope === false`: all instances are resolved **once at bootstrap** and bound directly into the route closure. Zero `RequestContainer` allocations and zero `AsyncLocalStorage` hops occur per request.
- If `requiresRequestScope === true`: the route enters `AsyncLocalStorage.run(...)` with an isolated `RequestContainer`, sharing each `Scope.REQUEST` instance within the request and cleaning it up automatically in `finally` (via `onRequestDestroy()` or `Symbol.asyncDispose` / `Symbol.dispose`).
