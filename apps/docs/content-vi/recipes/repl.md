# REPL (Read-Eval-Print Loop)

Bunest tích hợp sẵn **REPL tương tác** (`repl()` từ `@bunest/core` và `bunest repl` từ `@bunest/cli`) giúp khởi chạy DI container mà không cần mở cổng HTTP — cho phép kiểm tra module, resolve provider và gọi trực tiếp các method của service ngay trên terminal.

## Khởi chạy REPL

Tạo tệp entrypoint `src/repl.ts`:

@@filename(src/repl.ts)

```ts
import { repl } from "@bunest/core";
import { AppModule } from "./app.module";

await repl(AppModule);
```

Chạy trực tiếp bằng Bun:

```bash
bun run src/repl.ts
```

Hoặc dùng Bunest CLI:

```bash
bunest repl
```

## Các hàm tích hợp sẵn trong REPL

| Hàm | Mô tả | Ví dụ |
| --- | --- | --- |
| `get(token)` / `$(token)` | Lấy singleton provider hoặc controller theo class/token. | `get(UsersService)` |
| `resolve(token)` | Resolve bất đồng bộ provider có scope `TRANSIENT` hoặc `REQUEST`. | `await resolve(AuditService)` |
| `select(ModuleClass)` | Giới hạn phạm vi tìm kiếm trong một module cụ thể. | `select(UsersModule).get(UsersService)` |
| `methods(token)` | Liệt kê tất cả method có thể gọi trên provider/controller. | `methods(UsersService)` |
| `debug(module?)` | In toàn bộ cây module, controller và provider đã đăng ký. | `debug()` |
| `help()` | Hiển thị danh sách lệnh và hướng dẫn sử dụng REPL. | `help()` |

## Ví dụ phiên làm việc

```text
> debug()
AppModule
 ├── Controllers: [AppController]
 └── Imports:
      └── UsersModule
           ├── Controllers: [UsersController]
           └── Providers: [UsersService, UserRepository]

> methods(UsersService)
Methods:
 ◻ findAll
 ◻ findOne
 ◻ create

> await get(UsersService).findAll()
[ { id: 'usr_1', email: 'ada@bunest.dev' } ]
```

## Dùng `createReplContext()` trong script nội bộ

@@filename(scripts/inspect.ts)

```ts
import { BunestFactory, createReplContext } from "@bunest/core";
import { AppModule } from "../src/app.module";
import { UsersService } from "../src/users/users.service";

const app = await BunestFactory.createApplicationContext(AppModule);
const ctx = createReplContext(app);

console.log(ctx.methods(UsersService));
await app.close();
```

> warning **Lưu ý Production** Không bao giờ mở REPL qua mạng công cộng. Chỉ chạy REPL trên máy local hoặc trong shell tạm có phân quyền read-only và ghi log kiểm toán.
