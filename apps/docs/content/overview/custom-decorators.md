# Custom decorators

Bunest embraces decorators as a first-class extensibility mechanism. You can compose your own parameter decorators with `createParamDecorator()` and strongly-typed metadata decorators with `Reflector.createDecorator()`.

## Custom Parameter Decorators (`createParamDecorator`)

Use `createParamDecorator<Data, Output>(factory)` to extract domain concepts—such as the authenticated user, tenant ID, or trace correlation header—directly into controller parameters:

@@filename(current-user.decorator.ts)
```ts
import { createParamDecorator, type ExecutionContext } from "@bunest/core";

export interface AuthUser {
  id: string;
  email: string;
  role: string;
}

export const CurrentUser = createParamDecorator<keyof AuthUser | undefined, unknown>(
  (property, ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest();
    // Example: read user headers or RequestContext attached by an AuthGuard
    const user: AuthUser = {
      id: req.headers.get("x-user-id") ?? "anonymous",
      email: req.headers.get("x-user-email") ?? "",
      role: req.headers.get("x-user-role") ?? "guest",
    };
    return property ? user[property] : user;
  },
);
```

Now use `@CurrentUser()` anywhere in a controller—optionally passing data or parameter-level pipes!

@@filename(profile.controller.ts)
```ts
import { Controller, Get } from "@bunest/core";
import { CurrentUser, type AuthUser } from "./current-user.decorator";

@Controller("profile")
export class ProfileController {
  @Get("me")
  getProfile(@CurrentUser() user: AuthUser) {
    return user;
  }

  @Get("email")
  getEmail(@CurrentUser("email") email: string) {
    return { email };
  }
}
```

> info **Pipe Behavior on Custom Decorators** By default, global `ValidationPipe` skips parameters with `metadata.type === "custom"` unless you enable `validateCustomDecorators: true` or pass pipes explicitly inside `@CurrentUser(undefined, MyPipe)`.

## Typed Metadata Decorators (`Reflector.createDecorator`)

Instead of raw string keys with `@SetMetadata("roles", [...])`, use `Reflector.createDecorator<T>()` to create type-safe decorators backed by unique symbols:

@@filename(public.decorator.ts)
```ts
import { Reflector } from "@bunest/core";

export const Public = Reflector.createDecorator<boolean>();
export const CacheTtl = Reflector.createDecorator<number>({
  transform: (seconds) => Math.max(0, seconds),
});
```

Read the metadata inside a Guard or Interceptor with full type inference:

@@filename(cache-ttl.interceptor.ts)
```ts
import {
  Injectable,
  Reflector,
  type BunestInterceptor,
  type CallHandler,
  type ExecutionContext,
} from "@bunest/core";
import { CacheTtl } from "./public.decorator";

@Injectable()
export class CacheHeaderInterceptor implements BunestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  async intercept(context: ExecutionContext, next: CallHandler) {
    const ttl = this.reflector.getAllAndOverride(CacheTtl, [
      context.getHandler(),
      context.getClass(),
    ]);

    const res = context.switchToHttp().getResponse();
    if (ttl !== undefined) {
      res.header("Cache-Control", `public, max-age=${ttl}`);
    }
    return next.handle();
  }
}
```

## Composing Multiple Decorators

Because legacy decorators are plain TypeScript functions, you can bundle multiple guards, metadata, and response headers into a single semantic decorator:

@@filename(auth.decorator.ts)
```ts
import { UseGuards } from "@bunest/core";
import { BearerAuthGuard } from "./auth.guard";
import { Roles } from "./roles.decorator";
import { RolesGuard } from "./roles.guard";

export function Auth(...roles: string[]): MethodDecorator & ClassDecorator {
  return (target: object, propertyKey?: string | symbol, descriptor?: PropertyDescriptor) => {
    const rolesDec = Roles(roles);
    const guardsDec = UseGuards(BearerAuthGuard, RolesGuard);
    if (propertyKey !== undefined && descriptor !== undefined) {
      rolesDec(target, propertyKey, descriptor);
      guardsDec(target, propertyKey, descriptor);
    } else {
      rolesDec(target as Function);
      guardsDec(target as Function);
    }
  };
}
```
