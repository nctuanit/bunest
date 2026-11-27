# Các bước đầu tiên

Chạy HTTP API đầu tiên với Bunest từ một môi trường sạch chỉ trong vài phút. Sau khi hoàn thành phần mở đầu này, bạn sẽ đạt được:

- `GET /health` trả về HTTP `200` với `{"status":"ok"}`
- `GET /?name=Dev` trả về HTTP `200` với `{"message":"Hello, Dev!","runtime":"Bun <version>"}`
- Bộ kiểm thử của example đạt với lệnh `bun run --cwd examples/hello-world test`

> info **Lưu ý giai đoạn Preview** Trong giai đoạn preview, các package `@bunest/*` chưa được phát hành lên npm công khai. Cách nhanh nhất để chạy thử Bunest lúc này là chạy trực tiếp `examples/hello-world` từ kho mã nguồn công khai trên GitHub bên dưới.

## Yêu cầu hệ thống

Đảm bảo máy của bạn đã cài **Git** và **Bun `>= 1.4.5`**:

```bash
git --version
bun --version
# Bun 1.4.5 trở lên
```

## Chạy API đầu tiên (Từ mã nguồn Preview)

### 1. Clone repo và cài dependency

Clone kho mã nguồn công khai và cài dependency cho workspace từ thư mục gốc của repo (`bunest`). Không cần bước build riêng trước khi khởi chạy example.

```bash
git clone https://github.com/nctuanit/bunest.git
cd bunest
bun install --frozen-lockfile
```

### 2. Khởi chạy server `hello-world`

Chạy lệnh sau từ thư mục gốc `bunest`:

```bash
bun run --cwd examples/hello-world start
```

Bạn sẽ thấy dòng log:

```text
Bunest hello-world listening on http://localhost:3000
```

Giữ terminal này đang chạy. Nhấn `Ctrl+C` trong terminal này bất cứ khi nào bạn muốn dừng server.

Nếu cổng `3000` đang bận, hãy đổi biến môi trường `PORT` trước khi chạy:

**macOS / Linux:**

```bash
PORT=3001 bun run --cwd examples/hello-world start
```

**Windows PowerShell:**

```powershell
$env:PORT="3001"; bun run --cwd examples/hello-world start
```

### 3. Kiểm tra endpoint ở terminal thứ hai

Mở một **terminal thứ hai** và gửi hai request (thay `3000` nếu bạn đã chọn `PORT` khác):

**macOS / Linux (`curl`):**

```bash
curl -i http://localhost:3000/health
curl -i "http://localhost:3000/?name=Dev"
```

**Windows PowerShell (`curl.exe`):**

```powershell
curl.exe -i http://localhost:3000/health
curl.exe -i "http://localhost:3000/?name=Dev"
```

Kết quả mong đợi:

- `GET /health` trả về HTTP `200` với nội dung:

```json
{"status":"ok"}
```

- `GET /?name=Dev` trả về HTTP `200` với `message` là `"Hello, Dev!"` và trường `runtime` theo phiên bản Bun thực tế trên máy của bạn:

```json
{"message":"Hello, Dev!","runtime":"Bun 1.4.5"}
```

### 4. Chạy bộ kiểm thử của example

Từ thư mục gốc `bunest` (ở terminal thứ hai, hoặc sau khi dừng server bằng `Ctrl+C`), chạy bộ test tự động của example:

```bash
bun run --cwd examples/hello-world test
```

Kết quả pass xác nhận `TestingModule` và `app.fetch()` kiểm thử thành công cả `GET /` lẫn `GET /health` mà không cần mở cổng mạng.

## Lộ trình tiếp theo

Sau khi request đầu tiên và bài test đều đạt, bạn có thể chọn bước tiếp theo phù hợp:

- **Tạo dự án bằng CLI** — xem mục **Tạo dự án bằng CLI** ngay bên dưới (yêu cầu package `@bunest/*` đã có trên npm hoặc registry nội bộ).
- **Tích hợp vào dự án hiện có** — xem mục **Tích hợp vào dự án hiện có** bên dưới để cài thủ công, cấu hình decorator metadata trong `tsconfig.json` và nắm quy tắc value-import với `verbatimModuleSyntax`.
- **Thêm validation** — xem mục **Thêm validation (DTO)** bên dưới hoặc đọc đầy đủ tại [Xác thực dữ liệu](/techniques/validation).

---

## Tạo dự án bằng CLI

> warning **Điều kiện registry** Luồng `bunx @bunest/cli` bên dưới yêu cầu các package `@bunest/*` đã được phát hành lên npm hoặc có sẵn trên registry bạn cấu hình. Trong giai đoạn preview, hãy dùng luồng chạy từ mã nguồn ở trên hoặc chạy CLI trực tiếp từ bản clone monorepo.

Khi package đã có trên registry, dùng `@bunest/cli` để tạo sẵn dự án đầy đủ cấu hình legacy decorator, `bunest.json`, `bunfig.toml`, `preload.ts` và bài kiểm thử E2E mẫu:

```bash
bunx @bunest/cli new my-app
cd my-app
bun run dev
```

Dự án vừa tạo mở sẵn hai endpoint `GET /` và `GET /health` (đối với probe liveness/readiness như `/live` và `/ready` trên production Kubernetes/reverse proxy, hãy bổ sung endpoint health qua [`@bunest/observability`](/observability/observability) hoặc tham khảo `examples/production-rest-postgres`).

### Preload & `bunfig.toml`

`bunest new` tạo sẵn `bunfig.toml` và `preload.ts` để Bun tự động đăng ký plugin runtime của Bunest (hỗ trợ suy luận `@Repository<Entity>()` và chuyển đổi metadata không cần boilerplate) cho cả `bun run` lẫn `bun test`:

@@filename(bunfig.toml)

```toml
preload = ["./preload.ts"]
```

@@filename(preload.ts)

```ts
import { registerBunestPlugin } from "@bunest/cli";

registerBunestPlugin();
```

## Tích hợp vào dự án hiện có

Nếu muốn tự cấu hình Bunest vào một dự án sẵn có (khi `@bunest/*` đã sẵn sàng qua npm hoặc workspace link), hãy cài đặt `@bunest/core` và `@bunest/validation` (không có runtime dependency ngoài — đã tích hợp sẵn Reflect Metadata shim của Bunest và bộ validate/transform DTO biên dịch một lần):

```bash
bun add @bunest/core @bunest/validation
bun add -d @types/bun typescript
```

> info **Gợi ý** `@bunest/core` export các decorator, pipe tích hợp sẵn, các lớp `HttpException`, `Logger`, `Reflector` cùng các subpath lõi HTTP/DI/Config/WS/I18n, và tự động cài đặt ECMAScript Reflect Metadata shim không dependency.

### Cấu hình TypeScript (`tsconfig.json`)

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

### Điểm khởi chạy ứng dụng (Entrypoint)

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

## Thêm validation (DTO)

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
