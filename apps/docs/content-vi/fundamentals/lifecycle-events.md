# Sự kiện vòng đời (Lifecycle events)

Bunest quản lý quá trình khởi động và tắt ứng dụng an toàn (graceful shutdown) theo **thứ tự tô-pô xác định** thông qua `LifecycleManager` (`@bunest/core`, [ADR-007](/architecture/adrs)). Các dependency luôn được khởi tạo _trước_ những thành phần phụ thuộc vào chúng và tắt _sau_ những thành phần đó.

## Trình tự các Lifecycle Hook

### Giai đoạn Bootstrap (Thứ tự tô-pô từ dưới lên)

1. Kiểm tra toàn bộ đồ thị module, exports, phạm vi hiển thị token, vòng lặp dependency và rò rỉ scope.
2. Khởi tạo các singleton provider (chờ `useFactory` bất đồng bộ) và các singleton controller.
3. **`onModuleInit()`** — được gọi trên mọi provider, controller và module có triển khai `OnModuleInit` sau khi các dependency của module chủ quản đã được resolve.
4. **`onApplicationBootstrap()`** — được gọi trên mọi instance có triển khai `OnApplicationBootstrap` sau khi tất cả các module đã khởi tạo xong, **trước khi** `Bun.serve()` bắt đầu nhận lưu lượng truy cập.

### Giai đoạn Graceful Shutdown (Thứ tự tô-pô đảo ngược)

1. Ngừng nhận kết nối HTTP mới (`server.stop()`).
2. **`onModuleDestroy()`** — giải phóng tài nguyên thuộc từng module (thành phần phụ thuộc trước, dependency sau).
3. **`beforeApplicationShutdown(signal?)`** — xả bộ đệm (flush buffer), xử lý nốt các job đang chạy (drain in-flight jobs), phát telemetry tắt ứng dụng.
4. **`onApplicationShutdown(signal?)`** — dọn dẹp cuối cùng (đóng các pool SQLite/SQL, giải phóng file handle) sau khi các kết nối đã rút hết.

### Hook dọn dẹp theo từng Request

- **`onRequestDestroy()`** — tự động được gọi trên các provider `Scope.REQUEST` theo thứ tự đảo ngược lúc khởi tạo bên trong khối `finally` khi một HTTP request hoàn tất, ném lỗi hoặc bị hủy qua `request.signal`.

## Triển khai các Lifecycle Interface

@@filename(database.service.ts)

```ts
import {
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@bunest/core";
import { Database } from "bun:sqlite";

@Injectable()
export class DatabaseService
  implements
    OnModuleInit,
    OnApplicationBootstrap,
    OnModuleDestroy,
    BeforeApplicationShutdown,
    OnApplicationShutdown
{
  private readonly logger = new Logger(DatabaseService.name);
  private db: Database;

  async onModuleInit() {
    this.db = new Database(":memory:");
    this.db.run("CREATE TABLE IF NOT EXISTS health (ok INTEGER)");
    this.logger.log("SQLite schema initialized");
  }

  onApplicationBootstrap() {
    this.logger.log("Database ready before HTTP traffic starts");
  }

  onModuleDestroy() {
    this.logger.log("Draining module queries...");
  }

  beforeApplicationShutdown(signal?: string) {
    this.logger.warn(`Preparing shutdown (signal=${signal ?? "manual"})`);
  }

  onApplicationShutdown() {
    this.db.close();
    this.logger.log("SQLite connection closed cleanly");
  }
}
```

## Bật OS Shutdown Hooks

Gọi `app.enableShutdownHooks()` trong lúc bootstrap để tự động móc các tín hiệu `SIGINT` và `SIGTERM` vào `LifecycleManager`:

@@filename(main.ts)

```ts
const app = await BunestFactory.create(AppModule);
app.enableShutdownHooks();
await app.listen(3000);
```

> info **Các Provider Request-Scoped** Các provider được đánh dấu `Scope.REQUEST` KHÔNG được khởi tạo lúc bootstrap nên sẽ không kích hoạt `onModuleInit` hay `onApplicationBootstrap`. Hãy triển khai `OnRequestDestroy` (hoặc `Symbol.dispose` / `Symbol.asyncDispose` chuẩn) để dọn dẹp theo từng request.
