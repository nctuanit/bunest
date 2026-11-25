# Authorization

**`@bunest/security/authz`** provides declarative, policy-based authorization with `@Policy()` classes, `@Can()` and `@Can.Anyone()` route enforcement, imperative `AuthorizationService` checks, and structured audit events—with zero external runtime dependencies.

## Installation

```bash
bun add @bunest/security
```

## Defining a Policy

Create a `@Policy()` provider encapsulating resource-level permission rules:

@@filename(article.policy.ts)

```ts
import { Policy } from "@bunest/security/authz";

export interface UserPrincipal {
  id: string;
  role: "admin" | "member";
}

export interface Article {
  id: string;
  authorId: string;
}

@Policy("article")
export class ArticlePolicy {
  read() {
    return true;
  }

  update(user: UserPrincipal, article: Article) {
    return user.role === "admin" || article.authorId === user.id;
  }
}
```

## Registering & Enforcing Policies

Register `AuthorizationModule.forRoot()` and enforce rules declaratively with `@Can()` or imperatively with `AuthorizationService`:

@@filename(articles.controller.ts)

```ts
import { Controller, Get, Param, Patch } from "@bunest/core";
import { AuthorizationService, Can } from "@bunest/security/authz";

@Controller("articles")
export class ArticlesController {
  constructor(private readonly authz: AuthorizationService) {}

  @Get()
  @Can.Anyone()
  findAll() {
    return [];
  }

  @Patch(":id")
  @Can("update", "article")
  update(@Param("id") id: string) {
    return { id, updated: true };
  }
}
```
