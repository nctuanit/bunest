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

@Policy()
export class ArticlePolicy {
  read() {
    return true;
  }

  update(user: UserPrincipal | null, article: Article) {
    return user !== null && (user.role === "admin" || article.authorId === user.id);
  }
}
```

## Registering & Enforcing Policies

Register `AuthorizationModule.forRoot({ policies: [ArticlePolicy] })` and enforce rules declaratively with `@Can()` or imperatively with `AuthorizationService`:

@@filename(articles.controller.ts)

```ts
import { Controller, Get, Param, Patch } from "@bunest/core";
import { findArticleOrThrow } from "./articles.store";
import { ArticlePolicy } from "./article.policy";
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
  @Can(ArticlePolicy, "update", async (ctx) => {
    const url = new URL(ctx.switchToHttp().getRequest().url);
    const id = url.pathname.split("/").filter(Boolean).pop()!;
    return [await findArticleOrThrow(id)] as const;
  })
  update(@Param("id") id: string) {
    return { id, updated: true };
  }
}
```
