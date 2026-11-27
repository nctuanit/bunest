# Phân quyền (Authorization)

**`@bunest/security/authz`** cung cấp cơ chế phân quyền khai báo dựa trên policy với các class `@Policy()`, thực thi trên route bằng `@Can()` và `@Can.Anyone()`, kiểm tra mệnh lệnh qua `AuthorizationService`, và các sự kiện kiểm toán có cấu trúc — không phụ thuộc thư viện runtime ngoài.

## Cài đặt

```bash
bun add @bunest/security
```

## Định nghĩa Policy

Tạo một provider `@Policy()` đóng gói các quy tắc cấp quyền ở mức tài nguyên:

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

## Đăng ký & Áp dụng Policy

Đăng ký `AuthorizationModule.forRoot({ policies: [ArticlePolicy] })` và áp dụng các quy tắc một cách khai báo với `@Can()` hoặc theo lối mệnh lệnh với `AuthorizationService`:

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
