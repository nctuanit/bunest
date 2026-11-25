# Tham chiếu Module (ModuleRef)

Bunest cung cấp `ModuleRef` từ `@bunest/core` để các service có thể chủ động tra cứu các singleton provider hiện có, resolve các instance transient/request-scoped, hoặc khởi tạo động các class với đầy đủ cơ chế DI qua constructor.

## Inject `ModuleRef`

`ModuleRef` tự động có sẵn bên trong mọi module mà không cần đăng ký thêm:

@@filename(plugin-runner.service.ts)

```ts
import { Injectable, ModuleRef, type OnModuleInit } from "@bunest/core";
import { EmailNotifier } from "./email-notifier.service";
import { TransientJobHandler } from "./transient-job.handler";

@Injectable()
export class PluginRunnerService implements OnModuleInit {
  private notifier!: EmailNotifier;

  constructor(private readonly moduleRef: ModuleRef) {}

  onModuleInit() {
    // Synchronous lookup for an existing singleton visible to this module
    this.notifier = this.moduleRef.get(EmailNotifier);
  }

  async runDynamicJob() {
    // Async resolution for TRANSIENT or REQUEST-scoped providers
    const job = await this.moduleRef.resolve(TransientJobHandler);
    await job.execute();
    this.notifier.notify("Job complete");
  }
}
```

## Các phương thức của `ModuleRef`

| Phương thức                                      | Đồng bộ / Bất đồng bộ | Hành vi                                                                                                                                                                     |
| ------------------------------------------------ | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get(token, { strict? })`                        | Đồng bộ (Sync)        | Lấy một singleton đã được khởi tạo. Với `strict: true` _(mặc định)_, tuân theo quy tắc phạm vi hiển thị của module sở hữu. Với `strict: false`, tìm kiếm trên toàn bộ đồ thị ứng dụng. |
| `resolve(token, requestContainer?, { strict? })` | Bất đồng bộ (Async)   | Resolve các provider `SINGLETON`, `TRANSIENT` (instance mới mỗi lần gọi), hoặc `REQUEST` (gắn với `RequestContainer` truyền vào).                                          |
| `create(ClassType, requestContainer?)`           | Bất đồng bộ (Async)   | Khởi tạo một class **chưa** được đăng ký trong `providers`, tự động inject toàn bộ dependency ở constructor từ container.                                                   |

## Tra cứu Strict so với Toàn cục

@@filename(global-lookup.service.ts)

```ts
// Respects module encapsulation (default: strict = true)
const localService = this.moduleRef.get(LocalService);

// Cross-module lookup (strict = false)
const analytics = this.moduleRef.get(AnalyticsService, { strict: false });
```

> info **Gợi ý** Hãy ưu tiên constructor injection tiêu chuẩn bất cứ khi nào các dependency được biết trước ở thời điểm tĩnh — cách này tham gia vào quá trình kiểm tra lúc bootstrap (kiểm tra thiếu token, vòng phụ thuộc và rò rỉ scope). Chỉ dùng `ModuleRef` cho plugin registry, chiến lược động và điều phối lười (lazy orchestration).
