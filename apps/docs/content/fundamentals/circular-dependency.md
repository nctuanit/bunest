# Circular dependency

A circular dependency occurs when two classes (or two modules) depend on each other (`A -> B -> A`). While you should avoid cycles whenever possible by extracting shared logic into a third service, Bunest provides deterministic **bootstrap cycle detection** and explicit **`forwardRef()`** resolution when a cycle is intentional.

## Fail-Fast Cycle Diagnostics

During bootstrap, Bunest validates both the **module import graph** and the **provider dependency graph** via Depth-First Search (DFS). Unwrapped cycles throw **`CircularDependencyException`** immediately before `Bun.serve()` starts, showing the complete offending chain:

```text
CircularDependencyException: Circular dependency detected:
  AuthService -> UsersService -> AuthService
```

## Resolving Provider Cycles with `forwardRef()`

Wrap both sides of a singleton class dependency cycle using `@Inject(forwardRef(() => Target))`:

@@filename(auth.service.ts)

```ts
import { Inject, Injectable, forwardRef } from "@bunest/core";
import { UsersService } from "./users.service";

@Injectable()
export class AuthService {
  constructor(
    @Inject(forwardRef(() => UsersService))
    private readonly usersService: UsersService,
  ) {}

  validateUser(id: string) {
    return this.usersService.findById(id);
  }
}
```

@@filename(users.service.ts)

```ts
import { Inject, Injectable, forwardRef } from "@bunest/core";
import { AuthService } from "./auth.service";

@Injectable()
export class UsersService {
  constructor(
    @Inject(forwardRef(() => AuthService))
    private readonly authService: AuthService,
  ) {}

  findById(id: string) {
    return { id, active: true };
  }

  checkAccess(id: string) {
    return this.authService.validateUser(id);
  }
}
```

## Resolving Module Import Cycles

If `AuthModule` imports `UsersModule` and `UsersModule` imports `AuthModule`, wrap `forwardRef(() => ...)` inside `imports`:

@@filename(auth.module.ts)

```ts
import { Module, forwardRef } from "@bunest/core";
import { UsersModule } from "../users/users.module";
import { AuthService } from "./auth.service";

@Module({
  imports: [forwardRef(() => UsersModule)],
  providers: [AuthService],
  exports: [AuthService],
})
export class AuthModule {}
```

> warning **Limitations of `forwardRef()`**
>
> - Never eagerly invoke methods on a `forwardRef` peer inside a `constructor()` body—use `onModuleInit()` instead so both singletons finish allocation first.
> - Circular `useFactory` provider invocations cannot be deferred and still fail fast at bootstrap.
