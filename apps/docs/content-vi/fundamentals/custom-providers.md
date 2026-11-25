# Custom providers

Các class provider tiêu chuẩn (`providers: [UsersService]`) đáp ứng được hầu hết các trường hợp, nhưng DI container của Bunest còn hỗ trợ đầy đủ cả bốn dạng custom provider được định nghĩa trong [ADR-007](/architecture/adrs): `useValue`, `useClass`, `useFactory` (đồng bộ hoặc bất đồng bộ), và `useExisting`.

## Tổng quan các dạng Provider

| Loại Provider      | Cú pháp                                                             | Vòng đời (Lifetime)                            |
| ------------------ | ------------------------------------------------------------------- | ---------------------------------------------- |
| Class viết tắt     | `UsersService`                                                      | `@Injectable({ scope })` (mặc định `SINGLETON`) |
| `ClassProvider`    | `{ provide: TOKEN, useClass: ImplClass, scope? }`                   | `scope` tường minh ghi đè scope trên decorator |
| `ValueProvider`    | `{ provide: TOKEN, useValue: constantOrObj }`                       | Luôn là `SINGLETON`                            |
| `FactoryProvider`  | `{ provide: TOKEN, useFactory: (...deps) => ..., inject?, scope? }` | Factory đồng bộ hoặc `async`                   |
| `ExistingProvider` | `{ provide: ALIAS, useExisting: TARGET }`                           | Dùng chung instance của provider đích          |

## Value Providers (`useValue`)

Gắn các đối tượng cấu hình, hằng số hoặc test mock vào một symbol, chuỗi hoặc class token:

@@filename(app.module.ts)

```ts
import { Module } from "@bunest/core";

export const APP_CONFIG = Symbol("APP_CONFIG");

export interface AppConfig {
  env: "development" | "production";
  port: number;
}

@Module({
  providers: [
    {
      provide: APP_CONFIG,
      useValue: {
        env: Bun.env.NODE_ENV === "production" ? "production" : "development",
        port: Number(Bun.env.PORT ?? 3000),
      } satisfies AppConfig,
    },
  ],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
```

## Class Providers (`useClass`)

Hoán đổi implementation một cách linh hoạt dựa trên biến môi trường hoặc feature flag:

@@filename(storage.module.ts)

```ts
import { Module } from "@bunest/core";
import { LocalStorageService } from "./local-storage.service";
import { S3StorageService } from "./s3-storage.service";
import { StorageService } from "./storage.abstract";

@Module({
  providers: [
    {
      provide: StorageService,
      useClass:
        Bun.env.STORAGE_DRIVER === "s3"
          ? S3StorageService
          : LocalStorageService,
    },
  ],
  exports: [StorageService],
})
export class StorageModule {}
```

## Async Factory Providers (`useFactory`)

`useFactory` cho phép bạn tính toán/khởi tạo một provider một cách linh hoạt — bao gồm cả **khởi tạo bất đồng bộ (`async`)** (như mở connection pool cho `bun:sqlite` hoặc `Bun.sql`). Bunest sẽ `await` các async singleton factory theo thứ tự tô-pô (topological order) xác định trong quá trình bootstrap trước khi khởi chạy `Bun.serve()`:

@@filename(database.module.ts)

```ts
import { Module } from "@bunest/core";
import { Database } from "bun:sqlite";
import { APP_CONFIG, type AppConfig } from "./app.module";

export const SQLITE_DB = Symbol("SQLITE_DB");
export const METRICS_CLIENT = Symbol("METRICS_CLIENT");

@Module({
  providers: [
    {
      provide: SQLITE_DB,
      inject: [
        APP_CONFIG,
        { token: METRICS_CLIENT, optional: true }, // OptionalFactoryDependency
      ],
      useFactory: async (
        config: AppConfig,
        metrics?: { track: (k: string) => void },
      ) => {
        const db = new Database(
          config.env === "production" ? "prod.sqlite" : ":memory:",
        );
        db.run("PRAGMA journal_mode = WAL;");
        metrics?.track("db.connected");
        return db;
      },
    },
  ],
  exports: [SQLITE_DB],
})
export class DatabaseModule {}
```

## Alias Providers (`useExisting`)

Hiển thị một provider đã tồn tại dưới một token bổ sung mà không khởi tạo thêm bản sao thứ hai:

@@filename(alias.module.ts)

```ts
import { Module } from "@bunest/core";
import { StructuredLogger } from "./structured-logger.service";

export const LOGGER_TOKEN = Symbol("LOGGER_TOKEN");

@Module({
  providers: [
    StructuredLogger,
    {
      provide: LOGGER_TOKEN,
      useExisting: StructuredLogger,
    },
  ],
  exports: [LOGGER_TOKEN],
})
export class LoggingModule {}
```

## Multi-Provider Enhancer Tokens

Các enhancer token toàn cục **`APP_GUARD`**, **`APP_PIPE`**, **`APP_INTERCEPTOR`**, và **`APP_FILTER`** được đăng ký dưới dạng **multi-provider** bên trong `ModuleScanner` (`MULTI_PROVIDER_TOKENS`). Khi đăng ký nhiều provider `APP_GUARD` trên các module khác nhau, hệ thống sẽ gộp tất cả chúng lại theo thứ tự bootstrap của module thay vì ném ra lỗi `DuplicateProviderException`.
