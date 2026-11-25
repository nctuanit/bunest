# Phân quyền (Authorization)

**`@bunest/security/authz`** cung cấp cơ chế phân quyền khai báo dựa trên policy với các class `@Policy()`, thực thi trên route bằng `@Can()` và `@Can.Anyone()`, kiểm tra mệnh lệnh qua `AuthorizationService`, và các sự kiện kiểm toán có cấu trúc — không phụ thuộc thư viện runtime ngoài.

## Cài đặt

```bash
bun add @bunest/security/authz
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

## Đăng ký & Áp dụng Policy

Đăng ký `AuthorizationModule.forRoot()` và áp dụng các quy tắc một cách khai báo với `@Can()` hoặc theo lối mệnh lệnh với `AuthorizationService`:

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
