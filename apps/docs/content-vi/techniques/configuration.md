# Cấu hình (Configuration)

Ứng dụng thường chạy trên nhiều môi trường như development, staging, test và production. **`@bunest/core/config`** cung cấp tầng cấu hình định kiểu chặt chẽ và có kiểm chứng (validation), hỗ trợ nạp tệp `.env`, mở rộng biến `${VAR}`, các factory theo namespace `registerAs()`, kiểm chứng bằng DTO hoặc Standard Schema v1, cùng các decorator khai báo `@InjectConfig()` / `@ConfigValue()`.

## Cài đặt

```bash
bun add @bunest/core
```

## Bắt đầu

Đăng ký `ConfigModule.forRoot()` trong module gốc của bạn. Đặt `isGlobal: true` để `ConfigService` có sẵn trên mọi feature module mà không cần import lại `ConfigModule`.

@@filename(app.module.ts)

```ts
import { Module } from "@bunest/core";
import { ConfigModule } from "@bunest/core/config";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [".env.local", ".env"],
      expandVariables: true,
    }),
  ],
})
export class AppModule {}
```

## Sử dụng `ConfigService`

Inject `ConfigService` vào bất kỳ provider hoặc controller nào để đọc giá trị theo kiểu dữ liệu với giá trị mặc định tùy chọn hoặc `getOrThrow()` để báo lỗi ngay lập tức:

@@filename(database.service.ts)

```ts
import { Injectable } from "@bunest/core";
import { ConfigService } from "@bunest/core/config";

@Injectable()
export class DatabaseService {
  constructor(private readonly config: ConfigService) {}

  getConnectionUrl(): string {
    return this.config.getOrThrow<string>("DATABASE_URL");
  }

  getPoolSize(): number {
    return this.config.get<number>("DB_POOL_SIZE", 10);
  }
}
```

## Cấu hình theo Namespace (`registerAs`)

Nhóm các thiết lập liên quan thành các namespace định kiểu chặt chẽ bằng `registerAs()` và inject chúng qua `@Inject(dbConfig.KEY)` hoặc `@InjectConfig(dbConfig)`:

@@filename(database.config.ts)

```ts
import { registerAs } from "@bunest/core/config";

export const databaseConfig = registerAs("database", () => ({
  host: process.env.DB_HOST ?? "localhost",
  port: Number(process.env.DB_PORT ?? 5432),
  name: process.env.DB_NAME ?? "bunest",
}));
```

@@filename(app.module.ts)

```ts
import { Module } from "@bunest/core";
import { ConfigModule } from "@bunest/core/config";
import { databaseConfig } from "./database.config";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig],
    }),
  ],
})
export class AppModule {}
```

## Khai báo `@InjectConfig()` và `@ConfigValue()`

Loại bỏ mã lặp `ConfigService.get()` thủ công bằng các decorator tham số và thuộc tính mang tính khai báo:

@@filename(mail.service.ts)

```ts
import { Injectable } from "@bunest/core";
import { ConfigValue, InjectConfig } from "@bunest/core/config";
import { databaseConfig } from "./database.config";

@Injectable()
export class MailService {
  @ConfigValue("SMTP_HOST", "localhost")
  readonly smtpHost: string;

  constructor(
    @InjectConfig(databaseConfig)
    private readonly db: ReturnType<typeof databaseConfig>,
    @InjectConfig("APP_NAME", "Bunest")
    private readonly appName: string,
  ) {}
}
```

## Kiểm chứng & Module có điều kiện

Kiểm chứng các biến môi trường khi khởi động bằng DTO của `@bunest/validation` (hoặc `class-validator`) (`validate`), trình kiểm chứng Standard Schema v1 (`validationSchema`, ví dụ Zod/Valibot), hoặc một hàm tùy chỉnh. Nếu kiểm chứng thất bại, `ConfigValidationError` sẽ được ném ra trước khi `Bun.serve()` khởi chạy.

Bạn cũng có thể nạp có điều kiện các feature module dựa trên cờ môi trường bằng `ConditionalModule.registerWhen()`:

@@filename(app.module.ts)

```ts
import { Module } from "@bunest/core";
import { ConditionalModule, ConfigModule } from "@bunest/core/config";
import { MetricsModule } from "@bunest/observability";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ConditionalModule.registerWhen(MetricsModule, "ENABLE_METRICS"),
  ],
})
export class AppModule {}
```

> info **Ẩn thông tin nhạy cảm** `@bunest/core/config` tích hợp sẵn bộ ẩn bí mật giúp che các khóa nhạy cảm (`SECRET`, `TOKEN`, `PASSWORD`, `API_KEY`) khi ghi log cấu hình đã phân giải.
