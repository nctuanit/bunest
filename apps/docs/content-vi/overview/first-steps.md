# Các bước đầu tiên

Trong hướng dẫn này, bạn sẽ khởi tạo hoặc cấu hình một workspace Bunest, thiết lập các tùy chọn decorator bắt buộc trong `tsconfig.json`, định nghĩa DTO có kiểm tra dữ liệu và tìm hiểu các thành phần cốt lõi của một ứng dụng Bunest.

## Yêu cầu hệ thống

Bunest chỉ hỗ trợ **Bun `>= 1.4.5`**. Hãy kiểm tra phiên bản Bun trên máy của bạn trước:

```bash
bun --version
# 1.4.5 or higher
```

## Khởi tạo dự án mới (Khuyến nghị)

Dùng `@bunest/cli` để tạo sẵn dự án đầy đủ cấu hình legacy decorator, `bunest.json`, `bunfig.toml`, `preload.ts` và bài kiểm thử E2E mẫu:

```bash
bunx @bunest/cli new my-app
cd my-app
bun run dev
```

Dự án vừa tạo mở sẵn hai endpoint `GET /` và `GET /health` (đối với probe liveness/readiness như `/live` và `/ready` trên production Kubernetes/reverse proxy, hãy bổ sung endpoint health qua [`@bunest/observability`](/observability/observability) hoặc tham khảo `examples/production-rest-postgres`).

### Preload & `bunfig.toml`

`bunest new` tạo sẵn `bunfig.toml` và `preload.ts` để Bun tự động đăng ký plugin runtime của Bunest (hỗ trợ class macro, suy luận `@Repository<Entity>()` và chuyển đổi metadata không cần boilerplate) cho cả `bun run` lẫn `bun test`:

@@filename(bunfig.toml)

```toml
preload = ["./preload.ts"]
```

@@filename(preload.ts)

```ts
import { registerBunestPlugin } from "@bunest/cli";

registerBunestPlugin();
```

## Cài đặt thủ công

Nếu muốn tự cấu hình dự án từ đầu, hãy cài đặt `@bunest/core` và `@bunest/validation` (không có runtime dependency ngoài — đã tích hợp sẵn Reflect Metadata shim của Bunest và bộ validate/transform DTO biên dịch một lần):

```bash
bun add @bunest/core @bunest/validation
bun add -d @types/bun typescript
```

> info **Gợi ý** `@bunest/core` export các decorator, pipe tích hợp sẵn, các lớp `HttpException`, `Logger`, `Reflector` cùng các subpath lõi HTTP/DI/Config/WS/I18n, và tự động cài đặt ECMAScript Reflect Metadata shim không dependency.

## Cấu hình TypeScript (`tsconfig.json`)

Bunest sử dụng **Legacy TypeScript Decorators** để hỗ trợ constructor dependency injection (`design:paramtypes`), parameter decorator (`@Body()`, `@Param()`, `@Query()`) và DTO của `@bunest/validation` (hoặc `class-validator`).

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
    "strictPropertyInitialization": false,
    "noEmit": true
  }
}
```

> warning **Quy tắc `verbatimModuleSyntax` quan trọng** Luôn giữ `verbatimModuleSyntax: true`. Hãy dùng **value-import** cho các class runtime xuất hiện trong chữ ký có decorator (`import { UsersService }` và `import { CreateUserDto }`), và luôn dùng **`import type`** cho TypeScript interface hoặc type alias (`import type { UserRecord }`). Dùng `import type` cho một DI service hoặc DTO sẽ làm metadata runtime bị xóa thành `Object`, còn value-import một interface sẽ khiến transpiler của Bun lỗi khi chạy.

## Điểm khởi chạy ứng dụng (Entrypoint)

`@bunest/core` tự động nạp Reflect Metadata shim không dependency, nên bạn không cần viết dòng `import "reflect-metadata"` nữa:

@@filename(src/main.ts)

```ts
import { BunestFactory } from "@bunest/core";
import { ValidationPipe } from "@bunest/validation";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await BunestFactory.create(AppModule);

  // Enable secure-by-default DTO validation globally
  app.useGlobalPipes(new ValidationPipe());
  app.enableShutdownHooks();

  const port = Number(Bun.env.PORT ?? 3000);
  await app.listen(port);
}

bootstrap();
```

## Định nghĩa DTO có Kiểm tra Dữ liệu

Import các validation decorator từ `@bunest/validation/validator` (không có dependency bên ngoài) và dùng value-import cho class DTO trong controller:

@@filename(src/users/dto/create-user.dto.ts)

```ts
import {
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  Min,
  MinLength,
} from "@bunest/validation/validator";

export class CreateUserDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(2)
  name!: string;

  @IsOptional()
  @IsInt()
  @Min(18)
  age?: number;
}
```

Khi bật `ValidationPipe` toàn cục, payload sai định dạng hoặc chứa thuộc tính không khai báo sẽ tự động bị từ chối với mã HTTP `400` và định dạng lỗi chuẩn hóa `{ statusCode, error, message, details }` (xem [Xác thực dữ liệu](/techniques/validation)).

## Cấu trúc dự án tối thiểu

Một ứng dụng Bunest theo phong cách NestJS gọn gàng sẽ tổ chức các tính năng nghiệp vụ thành những module độc lập:

```text
my-app/
├── bunfig.toml              # Đăng ký ./preload.ts cho bun run & bun test
├── preload.ts               # Gọi registerBunestPlugin()
├── tsconfig.json            # Legacy decorators + verbatimModuleSyntax
└── src/
    ├── main.ts              # Application entrypoint
    ├── app.module.ts        # Root @Module() assembling feature modules
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
# Hoặc qua CLI:
bun run dev

# Fast multi-threaded typecheck (Bun 1.4.5+)
bun check

# Run unit & integration tests via bun:test
bun test

# Kiểm tra tổng thể (typecheck + chẩn đoán tĩnh + test)
bun run verify
```

> tip **Lưu ý khi kiểm thử** Kiểm tra kiểu tĩnh (`bun check`) chỉ xác minh kiểu dữ liệu, không kiểm tra việc phát sinh decorator metadata lúc chạy. Hãy luôn kiểm chứng decorator reflection và các HTTP route trong `bun test` với `@bunest/testing` (xem [Kiểm thử](/fundamentals/testing) và [ADR-002](/architecture/adrs)).
