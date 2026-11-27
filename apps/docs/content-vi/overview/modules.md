# Modules

Module là một class được gắn decorator `@Module()`. Module giúp tổ chức ứng dụng thành các ranh giới nghiệp vụ mạch lạc và thiết lập quy tắc hiển thị provider chặt chẽ.

## Giao ước Metadata của `@Module()`

```ts
export interface ModuleMetadata {
  imports?: Array<
    Type<any> | DynamicModule | Promise<DynamicModule> | ForwardReference
  >;
  controllers?: Type<any>[];
  providers?: Provider[];
  exports?: Array<
    | DynamicModule
    | Promise<DynamicModule>
    | Type<any>
    | Provider
    | string
    | symbol
    | ForwardReference
  >;
}
```

| Thuộc tính    | Mục đích                                                                                                        |
| ------------- | --------------------------------------------------------------------------------------------------------------- |
| `providers`   | Các service và custom provider được khởi tạo bởi DI container và **mặc định chỉ dùng nội bộ trong module này**  |
| `controllers` | Các class `@Controller()` thuộc về module này                                                                   |
| `imports`     | Các module khác mà các provider được **export** của chúng sẽ trở nên khả dụng trong module này                  |
| `exports`     | Tập con của `providers` (hoặc các module đã import được re-export) được công khai cho các module import nó      |

## Feature Modules & Tính đóng gói

Các provider được khai báo trong một module **mặc định được đóng gói (private)**. Để chia sẻ `UsersService` cho `OrdersModule`, `UsersModule` phải liệt kê rõ nó trong `exports`:

@@filename(users.module.ts)

```ts
import { Module } from "@bunest/core";
import { UsersController } from "./users.controller";
import { UsersService } from "./users.service";
import { UsersRepository } from "./users.repository";

@Module({
  controllers: [UsersController],
  providers: [UsersService, UsersRepository],
  exports: [UsersService], // UsersRepository stays private to UsersModule!
})
export class UsersModule {}
```

@@filename(orders.module.ts)

```ts
import { Module } from "@bunest/core";
import { UsersModule } from "../users/users.module";
import { OrdersController } from "./orders.controller";
import { OrdersService } from "./orders.service";

@Module({
  imports: [UsersModule],
  controllers: [OrdersController],
  providers: [OrdersService], // Can inject UsersService, NOT UsersRepository
})
export class OrdersModule {}
```

## Re-Export Module & Khử trùng lặp (Deduplication)

- **Khử trùng lặp static module:** Các class `@Module()` tĩnh được khử trùng lặp theo định danh class trên toàn bộ đồ thị. Việc import `DatabaseModule` ở cả `UsersModule` và `OrdersModule` sẽ phân giải thành **một instance module duy nhất** và các singleton provider dùng chung.
- **Re-export module:** Đưa một module đã import vào `exports` sẽ bắc cầu re-export toàn bộ token mà nó export. Việc re-export một module chưa có trong `imports` sẽ báo lỗi fail-fast lúc bootstrap với `InvalidExportException`.
- **Không rò rỉ bắc cầu ngoài ý muốn:** Nếu `AppModule` import `OrdersModule` và `OrdersModule` import `UsersModule` mà không re-export nó, `AppModule` sẽ không thể inject `UsersService`.

@@filename(core.module.ts)

```ts
import { Module } from "@bunest/core";
import { DatabaseModule } from "./database.module";

@Module({
  imports: [DatabaseModule],
  exports: [DatabaseModule], // Transitive re-export
})
export class CoreModule {}
```

## Global Modules (`@Global()`)

Khi một module cung cấp các tiện ích dùng chung khắp nơi (database pool, config, caching), hãy gắn `@Global()` để các provider được **export** của nó khả dụng ở mọi nơi sau khi được import vào root module:

@@filename(config.module.ts)

```ts
import { Global, Module } from "@bunest/core";
import { ConfigService } from "./config.service";

@Global()
@Module({
  providers: [ConfigService],
  exports: [ConfigService],
})
export class ConfigModule {}
```

> info **Tính đóng gói vẫn được giữ nguyên** Các provider không được export bên trong một `@Global()` module vẫn là private đối với module đó. Những class `@Global()` không bao giờ được import ở đâu trong đồ thị sẽ không được nạp.

## Dynamic Modules (`forRoot` / `registerAsync`)

Dynamic module trả về một `DynamicModule` (hoặc `Promise<DynamicModule>`) từ một static method để tham số hóa các provider lúc khởi động:

@@filename(database.module.ts)

```ts
import { Module, type DynamicModule } from "@bunest/core";

export const DB_OPTIONS = Symbol("DB_OPTIONS");

export interface DatabaseOptions {
  url: string;
  poolSize?: number;
}

@Module({})
export class DatabaseModule {
  static forRoot(options: DatabaseOptions): DynamicModule {
    return {
      module: DatabaseModule,
      global: true,
      providers: [
        { provide: DB_OPTIONS, useValue: options },
        // Additional connection providers...
      ],
      exports: [DB_OPTIONS],
    };
  }
}
```

Mỗi object `DynamicModule` trả về khác nhau sẽ nhận một ID đăng ký riêng để nhiều lần gọi `forFeature(...)` không bao giờ ghi đè lẫn nhau, trong khi tái sử dụng đúng cùng một tham chiếu object `DynamicModule` sẽ được khử trùng lặp gọn gàng.

## Thứ tự ưu tiên phân giải Token nghiêm ngặt

Khi phân giải token `T` bên trong module `M`, Bunest kiểm tra theo một thứ tự xác định:

1. **`providers` cục bộ của chính `M`** (provider cục bộ luôn ghi đè token được import hoặc global).
2. **`exports` từ các `imports` trực tiếp của `M`** (bao gồm các re-export). Nếu hai module được import cùng export token `T` mà không có override cục bộ, Bunest báo lỗi fail-fast với **`AmbiguousProviderException`**.
3. **`exports` của các module `@Global()`**. Hai global export xung đột nhau cũng ném ra **`AmbiguousProviderException`**.
4. **Thiếu token:** Trả về `undefined` nếu có `@Optional()`, nếu không sẽ báo lỗi fail-fast với **`UnknownDependencyException`**.

## `@AutoModule` thông minh (Quét thư mục bằng Glob & Manifest tĩnh)

`@AutoModule()` không tham số tự động khám phá các class từ `DecoratorRegistry` của Bunest. Được mở rộng trong **[ADR-018](/architecture/adrs)**, `@AutoModule()` còn hỗ trợ quét thư mục bằng **`Bun.Glob`** gốc (`scan`), cô lập phạm vi module nghiêm ngặt (không rò rỉ ra global), bộ lọc (`filter`) và bộ nạp `manifest` tĩnh lúc biên dịch:

```ts
export interface AutoModuleMetadata extends ModuleMetadata {
  readonly scan?: string | readonly string[];
  readonly exclude?: readonly string[]; // defaults: ["**/*.spec.ts", "**/*.test.ts", "**/*.d.ts"]
  readonly cwd?: string;
  readonly manifest?: readonly (() => Promise<Record<string, unknown> | object>)[];
  readonly filter?: (target: Type<unknown>) => boolean;
}
```

@@filename(orders.module.ts)

```ts
import { AutoModule } from "@bunest/core";

@AutoModule({
  scan: ["./controllers/**/*.ts", "./services/**/*.ts"],
  exclude: ["**/*.mock.ts"],
  filter: (target) => !target.name.startsWith("Internal"),
})
export class OrdersModule {}
```

- **Cô lập nghiêm ngặt theo từng module:** Các class được nạp bởi `scan` chỉ được đăng ký vào chính `@AutoModule` khai báo nó — không bao giờ rò rỉ sang các module không liên quan.
- **Hỗ trợ file thực thi đơn lẻ (`bun build --compile`):** Khi đóng gói qua [`createBunestPlugin()`](/observability/cli) hợp nhất của `@bunest/cli`, Stage 2 (`autoModuleManifest`) mở rộng `scan` lúc build thành mảng tĩnh `manifest: [() => import("./...")]`. Khi có `manifest`, nó được ưu tiên thay cho việc glob lúc chạy để binary biên dịch hoạt động mà không cần quét hệ thống tập tin.
- **`BunestFactory.createAuto()`** cũng hỗ trợ `scan`, `exclude`, `cwd`, `manifest`, và `filter`.

### Chọn provider theo cấu hình

Gắn một token với implementation được chọn khi khai báo module.

```ts
import { Module } from "@bunest/core";
import { LocalMailTransport, SmtpMailTransport } from "./transports";

@Module({
  providers: [{
    provide: "MAIL_TRANSPORT",
    useClass: Bun.env.SMTP_HOST ? SmtpMailTransport : LocalMailTransport,
  }],
  exports: ["MAIL_TRANSPORT"],
})
export class MailTransportModule {}
```
