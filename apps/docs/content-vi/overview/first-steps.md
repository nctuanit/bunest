# Các bước đầu tiên

Trong hướng dẫn này, bạn sẽ thiết lập một workspace Bunest, cấu hình các tùy chọn decorator bắt buộc trong `tsconfig.json` và tìm hiểu các thành phần cốt lõi của một ứng dụng Bunest.

## Yêu cầu hệ thống

Bunest chỉ hỗ trợ **Bun `>= 1.4.5`**. Hãy kiểm tra phiên bản Bun trên máy của bạn trước:

```bash
bun --version
# 1.4.5 or higher
```

## Cài đặt các dependency

Cài đặt `@bunest/core` và `@bunest/validation` (không có runtime dependency ngoài — đã tích hợp sẵn Reflect Metadata shim của Bunest và bộ validate/transform DTO biên dịch một lần):

```bash
bun add @bunest/core @bunest/validation
bun add -d @types/bun typescript
```

> info **Gợi ý** `@bunest/core` export các decorator, pipe tích hợp sẵn, các lớp `HttpException`, `Logger`, `Reflector` cùng các subpath lõi HTTP/DI/Config/WS/I18n, và tự động cài đặt ECMAScript Reflect Metadata shim không dependency ([ADR-017](/architecture/adrs)).

## Cấu hình TypeScript (`tsconfig.json`)

Bunest sử dụng **Legacy TypeScript Decorators** ([ADR-002](/architecture/adrs)) để hỗ trợ constructor dependency injection (`design:paramtypes`), parameter decorator (`@Body()`, `@Param()`, `@Query()`) và DTO của `@bunest/validation` (hoặc `class-validator`).

@@filename(tsconfig.json)

```json
{
  "compilerOptions": {
    "lib": ["ESNext"],
    "target": "ESNext",
    "module": "Preserve",
    "moduleDetection": "force",
    "moduleResolution": "bundler",
    "types": ["bun"],
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "verbatimModuleSyntax": true,
    "strict": true,
    "noEmit": true
  }
}
```

> warning **Quy tắc `verbatimModuleSyntax` quan trọng (ADR-002)** Luôn giữ `verbatimModuleSyntax: true`. Hãy dùng **value-import** cho các class runtime xuất hiện trong chữ ký có decorator (`import { UsersService }` và `import { CreateUserDto }`), và luôn dùng **`import type`** cho TypeScript interface hoặc type alias (`import type { UserRecord }`). Dùng `import type` cho một DI service hoặc DTO sẽ làm metadata runtime bị xóa thành `Object`, còn value-import một interface sẽ khiến transpiler của Bun lỗi khi chạy.

## Điểm khởi chạy ứng dụng (Entrypoint)

`@bunest/core` tự động nạp Reflect Metadata shim không dependency ([ADR-017](/architecture/adrs)), nên bạn không cần viết dòng `import "reflect-metadata"` nữa:

@@filename(src/main.ts)

```ts
import { BunestFactory } from "@bunest/core";
import { ValidationPipe } from "@bunest/validation";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await BunestFactory.create(AppModule);

  // Enable secure-by-default DTO validation globally (ADR-009)
  app.useGlobalPipes(new ValidationPipe());

  const port = Number(Bun.env.PORT ?? 3000);
  await app.listen(port);
}

bootstrap();
```

## Cấu trúc dự án tối thiểu

Một ứng dụng Bunest theo phong cách NestJS gọn gàng sẽ tổ chức các tính năng nghiệp vụ thành những module độc lập:

```text
src/
├── main.ts                  # Application entrypoint
├── app.module.ts            # Root @Module() assembling feature modules
└── users/
    ├── users.module.ts      # Feature @Module()
    ├── users.controller.ts  # HTTP @Controller("/users")
    ├── users.service.ts     # @Injectable() business logic
    └── dto/
        └── create-user.dto.ts
```

@@filename(src/app.module.ts)

```ts
import { Module } from "@bunest/core";
import { UsersModule } from "./users/users.module";

@Module({
  imports: [UsersModule],
})
export class AppModule {}
```

## Chạy ứng dụng & Kiểm tra kiểu (Typechecking)

Bunest tận dụng bộ công cụ gốc của Bun để chạy, kiểm thử và typecheck đa luồng tốc độ cao:

```bash
# Run application in watch mode
bun --watch src/main.ts

# Fast multi-threaded typecheck (Bun 1.4.5+)
bun check

# Run unit & integration tests via bun:test
bun test
```

> tip **Lưu ý khi kiểm thử** Kiểm tra kiểu tĩnh (`bun check`) chỉ xác minh kiểu dữ liệu, không kiểm tra việc phát sinh decorator metadata lúc chạy. Hãy luôn kiểm chứng decorator reflection và các HTTP route trong `bun test` với `@bunest/testing` (xem [Kiểm thử](/fundamentals/testing) và [ADR-002](/architecture/adrs)).
