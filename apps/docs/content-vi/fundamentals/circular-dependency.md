# Phụ thuộc vòng (Circular dependency)

Phụ thuộc vòng (circular dependency) xảy ra khi hai class (hoặc hai module) phụ thuộc lẫn nhau (`A -> B -> A`). Mặc dù bạn nên tránh vòng phụ thuộc bất cứ khi nào có thể bằng cách tách logic dùng chung sang một service thứ ba, Bunest vẫn cung cấp cơ chế **phát hiện vòng lặp xác định khi bootstrap** và giải quyết tường minh bằng **`forwardRef()`** khi vòng phụ thuộc là có chủ đích.

## Chẩn đoán vòng lặp Fail-Fast

Trong quá trình bootstrap, Bunest kiểm tra cả **đồ thị import module** và **đồ thị phụ thuộc provider** bằng thuật toán Tìm kiếm theo Chiều sâu (DFS). Các vòng lặp chưa được bọc sẽ ném ngay **`CircularDependencyException`** trước khi `Bun.serve()` khởi chạy, hiển thị đầy đủ chuỗi gây lỗi:

```text
CircularDependencyException: Circular dependency detected:
  AuthService -> UsersService -> AuthService
```

## Giải quyết vòng phụ thuộc Provider với `forwardRef()`

Bọc cả hai phía của vòng phụ thuộc class singleton bằng `@Inject(forwardRef(() => Target))`:

@@filename(auth.service.ts)

```ts
import { Inject, Injectable, forwardRef } from "@bunest/core";
import { UsersService } from "./users.service";

@Injectable()
export class AuthService {
  constructor(
    @Inject(forwardRef(() => UsersService))
    private readonly usersService: UsersService,
  ) {}

  validateUser(id: string) {
    return this.usersService.findById(id);
  }
}
```

@@filename(users.service.ts)

```ts
import { Inject, Injectable, forwardRef } from "@bunest/core";
import { AuthService } from "./auth.service";

@Injectable()
export class UsersService {
  constructor(
    @Inject(forwardRef(() => AuthService))
    private readonly authService: AuthService,
  ) {}

  findById(id: string) {
    return { id, active: true };
  }

  checkAccess(id: string) {
    return this.authService.validateUser(id);
  }
}
```

## Giải quyết vòng import Module

Nếu `AuthModule` import `UsersModule` và `UsersModule` import `AuthModule`, hãy bọc `forwardRef(() => ...)` bên trong `imports`:

@@filename(auth.module.ts)

```ts
import { Module, forwardRef } from "@bunest/core";
import { UsersModule } from "../users/users.module";
import { AuthService } from "./auth.service";

@Module({
  imports: [forwardRef(() => UsersModule)],
  providers: [AuthService],
  exports: [AuthService],
})
export class AuthModule {}
```

> warning **Giới hạn của `forwardRef()`**
>
> - Không bao giờ gọi trực tiếp phương thức trên đối tượng `forwardRef` bên trong thân `constructor()` — hãy dùng `onModuleInit()` để cả hai singleton hoàn tất việc cấp phát trước.
> - Các lệnh gọi provider `useFactory` bị vòng phụ thuộc không thể trì hoãn và vẫn sẽ báo lỗi fail-fast khi bootstrap.
