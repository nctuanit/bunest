# Providers

Provider là khối xây dựng nền tảng của hệ thống Dependency Injection (DI) trong Bunest. Service, repository, factory, helper và configuration client đều có thể được xem là provider để inject vào controller hoặc các provider khác thông qua tham số constructor.

## Tạo một Service

Gắn decorator `@Injectable()` lên một class để đánh dấu nó được quản lý bởi IoC container của Bunest:

@@filename(cats.service.ts)

```ts
import { Injectable, NotFoundException } from "@bunest/core";

export interface Cat {
  id: string;
  name: string;
  age: number;
}

@Injectable()
export class CatsService {
  private readonly cats = new Map<string, Cat>();

  create(cat: Cat): Cat {
    this.cats.set(cat.id, cat);
    return cat;
  }

  findAll(): Cat[] {
    return [...this.cats.values()];
  }

  findOne(id: string): Cat {
    const cat = this.cats.get(id);
    if (!cat) {
      throw new NotFoundException(`Cat #${id} not found`);
    }
    return cat;
  }
}
```

## Constructor Dependency Injection

Inject `CatsService` vào `CatsController` bằng constructor injection tiêu chuẩn của TypeScript. Bunest đọc `design:paramtypes` lúc bootstrap và tự động phân giải các dependency:

@@filename(cats.controller.ts)

```ts
import { Body, Controller, Get, Param, Post } from "@bunest/core";
import { CatsService } from "./cats.service";
import type { Cat } from "./cats.service";

@Controller("cats")
export class CatsController {
  constructor(private readonly catsService: CatsService) {}

  @Get()
  findAll(): Cat[] {
    return this.catsService.findAll();
  }

  @Get(":id")
  findOne(@Param("id") id: string): Cat {
    return this.catsService.findOne(id);
  }

  @Post()
  create(@Body() cat: Cat): Cat {
    return this.catsService.create(cat);
  }
}
```

> info **Value Import và `import type`** Lưu ý rằng `CatsService` dùng value import (`import { CatsService }`) để TypeScript phát sinh nó vào `design:paramtypes`, trong khi interface `Cat` dùng `import type { Cat }` để transpiler của Bun loại bỏ nó sạch sẽ.

## Token tường minh & Optional Injection

Khi inject một interface, string token hoặc `Symbol` token (những thứ bị TypeScript xóa khi biên dịch), hãy dùng `@Inject(token)`. Để cho phép một dependency nhận giá trị `undefined` nếu chưa được đăng ký, hãy kết hợp thêm `@Optional()`:

@@filename(http-client.service.ts)

```ts
import { Inject, Injectable, Optional } from "@bunest/core";

export const HTTP_OPTIONS = Symbol("HTTP_OPTIONS");

export interface HttpClientOptions {
  baseUrl: string;
  timeoutMs?: number;
}

@Injectable()
export class HttpClientService {
  constructor(
    @Optional()
    @Inject(HTTP_OPTIONS)
    private readonly options?: HttpClientOptions,
  ) {}

  getBaseUrl(): string {
    return this.options?.baseUrl ?? "http://localhost:3000";
  }
}
```

## Property-Based Injection

Mặc dù constructor injection được khuyến khích sử dụng, Bunest vẫn hỗ trợ property injection với `@Inject(token)` (hữu ích khi kế thừa các class cha có constructor phức tạp):

@@filename(audit.service.ts)

```ts
import { Inject, Injectable, Logger } from "@bunest/core";

export const AUDIT_WRITER = Symbol("AUDIT_WRITER");

@Injectable()
export class AuditService {
  @Inject(AUDIT_WRITER)
  private readonly writer!: (event: string) => void;

  private readonly logger = new Logger(AuditService.name);

  record(event: string) {
    this.logger.log(`Audit event: ${event}`);
    this.writer(event);
  }
}
```

## Đăng ký Providers

Mọi provider đều phải được đăng ký trong mảng `providers` của một module để `ModuleScanner` và `DIContainer` của Bunest có thể khám phá và khởi tạo nó lúc bootstrap:

@@filename(cats.module.ts)

```ts
import { Module } from "@bunest/core";
import { CatsController } from "./cats.controller";
import { CatsService } from "./cats.service";

@Module({
  controllers: [CatsController],
  providers: [CatsService],
  exports: [CatsService],
})
export class CatsModule {}
```

> warning **Chẩn đoán lỗi Fail-Fast** Nếu một provider token không thể tìm thấy trong phạm vi hiển thị của module sở hữu, Bunest sẽ ném ra **`UnknownDependencyException`** lúc bootstrap—in rõ class đang yêu cầu, chỉ mục chính xác của tham số constructor, tên token bị thiếu và tên module sở hữu.

Bạn cần dùng factory, alias hoặc async provider? Hãy khám phá [Custom providers](/fundamentals/custom-providers).
