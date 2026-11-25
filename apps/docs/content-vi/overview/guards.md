# Guards

Guard là một class `@Injectable()` triển khai interface `CanActivate`. Guard thực thi ở **Giai đoạn 5 (Stage 5)** của [Execution Pipeline 11 giai đoạn](/architecture/execution-pipeline)—sau middleware và **hoàn toàn trước** interceptor, bước parse body và các validation pipe.

> tip **Lợi ích về Bảo mật & Hiệu năng (ADR-008)** Vì guard chạy trước Giai đoạn 7 (Trích xuất tham số) và Giai đoạn 8 (Pipes), các request không có quyền bị từ chối ngay lập tức mà không tốn chi phí đọc đệm JSON body hay validate DTO.

## Viết một Authorization Guard

Triển khai `canActivate(context: ExecutionContext): boolean | Promise<boolean>`:

@@filename(auth.guard.ts)

```ts
import {
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from "@bunest/core";

@Injectable()
export class BearerAuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const authHeader = req.headers.get("authorization");

    if (!authHeader?.startsWith("Bearer ")) {
      throw new UnauthorizedException("Missing bearer token");
    }

    const token = authHeader.slice(7).trim();
    return token.length > 0;
  }
}
```

- Trả về `true` cho phép request đi tiếp tới Interceptors và handler.
- Trả về `false` tự động ném ra **`ForbiddenException` (403)**.
- Ném một `HttpException` tường minh (chẳng hạn `UnauthorizedException` 401) sẽ truyền thẳng mã trạng thái đó tới Exception Filters.

## Phân quyền theo vai trò (RBAC) với `Reflector`

Kết hợp `@SetMetadata()` (hoặc `Reflector.createDecorator()`) với `Reflector.getAllAndOverride()` để các role ở cấp method ghi đè cấu hình mặc định ở cấp controller:

@@filename(roles.decorator.ts)

```ts
import { Reflector } from "@bunest/core";

export const Roles = Reflector.createDecorator<string[]>();
```

@@filename(roles.guard.ts)

```ts
import {
  Injectable,
  Reflector,
  type CanActivate,
  type ExecutionContext,
} from "@bunest/core";
import { Roles } from "./roles.decorator";

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride(Roles, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const req = context.switchToHttp().getRequest();
    const userRole = req.headers.get("x-user-role") ?? "";
    return requiredRoles.includes(userRole);
  }
}
```

## Gắn Guard (Method, Controller, Global)

@@filename(admin.controller.ts)
@@tab(Controller / Method)

```ts
import { Controller, Get, UseGuards } from "@bunest/core";
import { BearerAuthGuard } from "./auth.guard";
import { Roles } from "./roles.decorator";
import { RolesGuard } from "./roles.guard";

@UseGuards(BearerAuthGuard, RolesGuard)
@Controller("admin")
export class AdminController {
  @Get("metrics")
  @Roles(["admin", "ops"])
  getMetrics() {
    return { uptime: process.uptime() };
  }
}
```

@@switch
@@tab(Global qua APP_GUARD)

```ts
import { APP_GUARD, Module } from "@bunest/core";
import { BearerAuthGuard } from "./auth.guard";

@Module({
  providers: [
    {
      provide: APP_GUARD,
      useClass: BearerAuthGuard,
    },
  ],
})
export class AppModule {}
```

Guard thực thi tuần tự theo thứ tự `Global -> Controller -> Method`. Các class token truyền vào `@UseGuards()` hoặc `APP_GUARD` được phân giải qua DI container của module lúc bootstrap (hoặc trên mỗi request nếu là request-scoped).
