# @bunest/authorization

Next-generation NestJS v12 policy-based authorization for Bunest — deny-by-default route protection, composable `@Policy()` / `@Can()` / `@Can.Anyone()` decorators, `AuthorizationService`, and zero-RxJS audit events with zero external runtime dependencies.

## Features

- **Policies & Abilities**: Injectable `@Policy()` classes, optional `PolicyBefore` hook, and strongly typed `Ability` contracts.
- **Deny-by-Default Guard**: `AuthorizationModule.forRoot()` / `forRootAsync()`, global `AuthorizationGuard`, `@Can()` (class and method stacking), `@Can.Anyone()`, and automatic integration with `@bunest/authentication`'s `@Public()` and guard ordering checks.
- **Imperative Checks & Error Translation**: `AuthorizationService.can()` and `.authorize()`, `AuthorizationError` (`unauthenticated` 401 vs `forbidden` 403), and automatic error translation across HTTP, GraphQL, WebSockets, and RPC.
- **Audit Events**: Zero-RxJS `AuthorizationEvents` (`events$` supporting `.subscribe()` and `for await`) plus the `nestjs:authorization:denied` diagnostics channel.

## Installation

```bash
bun add @bunest/authorization
```

> Optional peer dependency: `@bunest/authentication` for seamless `@Public()` and session/user resolution.

## Quick Start

```ts
import { Controller, Delete, Module, Param } from "@bunest/common";
import {
  AuthorizationModule,
  Can,
  Policy,
} from "@bunest/authorization";

@Policy()
export class PostPolicy {
  delete(user: { id: string; role: string }, post: { authorId: string }) {
    return user.role === "admin" || user.id === post.authorId;
  }
}

@Controller("posts")
export class PostsController {
  @Delete(":id")
  @Can(PostPolicy, "delete", (req) => ({ authorId: req.params.id }))
  remove(@Param("id") id: string) {
    return { deleted: id };
  }
}

@Module({
  imports: [AuthorizationModule.forRoot()],
  controllers: [PostsController],
  providers: [PostPolicy],
})
export class AppModule {}
```

## Key Exports

- **Module & Options**: `AuthorizationModule` (`forRoot`, `forRootAsync`), `AUTHORIZATION_MODULE_OPTIONS`
- **Decorators**: `@Policy()`, `@Can()` (including `@Can.Anyone()`)
- **Services, Guard & Utilities**: `AuthorizationService`, `AuthorizationGuard`, `defaultGetUser`
- **Errors & Events**: `AuthorizationError`, `AuthorizationEvents`

## Documentation

- [Bunest Documentation](../../README.md)
- [ADR Index](../../docs/adr/README.md)
