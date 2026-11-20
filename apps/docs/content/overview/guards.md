# Guards

A guard is an `@Injectable()` class implementing the `CanActivate` interface. Guards execute at **Stage 5** of the [11-Stage Execution Pipeline](/architecture/execution-pipeline)—after middleware, and **strictly before** interceptors, body parsing, and validation pipes.

> tip **Security & Performance Benefit (ADR-008)** Because guards run before Stage 7 (Parameter Extraction) and Stage 8 (Pipes), unauthorized requests are rejected immediately without paying JSON body buffering or DTO validation costs.

## Writing an Authorization Guard

Implement `canActivate(context: ExecutionContext): boolean | Promise<boolean>`:

@@filename(auth.guard.ts)
```ts
import {
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from "@bunest/core";

@Injectable()
export class BearerAuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const authHeader = req.headers.get("authorization");

    if (!authHeader?.startsWith("Bearer ")) {
      throw new UnauthorizedException("Missing bearer token");
    }

    const token = authHeader.slice(7).trim();
    return token.length > 0;
  }
}
```

- Returning `true` allows the request to proceed to Interceptors and the handler.
- Returning `false` automatically throws **`ForbiddenException` (403)**.
- Throwing an explicit `HttpException` (such as `UnauthorizedException` 401) propagates that status code directly to Exception Filters.

## Role-Based Access Control (RBAC) with `Reflector`

Combine `@SetMetadata()` (or `Reflector.createDecorator()`) with `Reflector.getAllAndOverride()` so method-level roles override controller-level defaults:

@@filename(roles.decorator.ts)
```ts
import { Reflector } from "@bunest/core";

export const Roles = Reflector.createDecorator<string[]>();
```

@@filename(roles.guard.ts)
```ts
import {
  Injectable,
  Reflector,
  type CanActivate,
  type ExecutionContext,
} from "@bunest/core";
import { Roles } from "./roles.decorator";

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride(Roles, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const req = context.switchToHttp().getRequest();
    const userRole = req.headers.get("x-user-role") ?? "";
    return requiredRoles.includes(userRole);
  }
}
```

## Binding Guards (Method, Controller, Global)

@@filename(admin.controller.ts)
@@tab(Controller / Method)
```ts
import { Controller, Get, UseGuards } from "@bunest/core";
import { BearerAuthGuard } from "./auth.guard";
import { Roles } from "./roles.decorator";
import { RolesGuard } from "./roles.guard";

@UseGuards(BearerAuthGuard, RolesGuard)
@Controller("admin")
export class AdminController {
  @Get("metrics")
  @Roles(["admin", "ops"])
  getMetrics() {
    return { uptime: process.uptime() };
  }
}
```
@@switch
@@tab(Global via APP_GUARD)
```ts
import { APP_GUARD, Module } from "@bunest/core";
import { BearerAuthGuard } from "./auth.guard";

@Module({
  providers: [
    {
      provide: APP_GUARD,
      useClass: BearerAuthGuard,
    },
  ],
})
export class AppModule {}
```

Guards execute sequentially in `Global -> Controller -> Method` order. Class tokens passed to `@UseGuards()` or `APP_GUARD` are resolved through the module's DI container at bootstrap (or per-request if request-scoped).
