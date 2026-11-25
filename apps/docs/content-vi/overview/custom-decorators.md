# Custom decorators

Bunest coi decorator là một cơ chế mở rộng hạng nhất. Bạn có thể tự tạo parameter decorator với `createParamDecorator()` và metadata decorator có kiểu dữ liệu chặt chẽ với `Reflector.createDecorator()`.

## Custom Parameter Decorators (`createParamDecorator`)

Dùng `createParamDecorator<Data, Output>(factory)` để trích xuất các khái niệm nghiệp vụ—như người dùng đã xác thực, tenant ID hoặc trace correlation header—trực tiếp vào tham số của controller:

@@filename(current-user.decorator.ts)

```ts
import { createParamDecorator, type ExecutionContext } from "@bunest/core";

export interface AuthUser {
  id: string;
  email: string;
  role: string;
}

export const CurrentUser = createParamDecorator<
  keyof AuthUser | undefined,
  unknown
>((property, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest();
  // Example: read user headers or RequestContext attached by an AuthGuard
  const user: AuthUser = {
    id: req.headers.get("x-user-id") ?? "anonymous",
    email: req.headers.get("x-user-email") ?? "",
    role: req.headers.get("x-user-role") ?? "guest",
  };
  return property ? user[property] : user;
});
```

Giờ bạn có thể dùng `@CurrentUser()` ở bất kỳ đâu trong controller—kèm tùy chọn truyền dữ liệu đầu vào hoặc pipe ở cấp tham số!

@@filename(profile.controller.ts)

```ts
import { Controller, Get } from "@bunest/core";
import { CurrentUser, type AuthUser } from "./current-user.decorator";

@Controller("profile")
export class ProfileController {
  @Get("me")
  getProfile(@CurrentUser() user: AuthUser) {
    return user;
  }

  @Get("email")
  getEmail(@CurrentUser("email") email: string) {
    return { email };
  }
}
```

> info **Hành vi của Pipe trên Custom Decorators** Mặc định, global `ValidationPipe` sẽ bỏ qua các tham số có `metadata.type === "custom"` trừ khi bạn bật `validateCustomDecorators: true` hoặc truyền trực tiếp pipe vào `@CurrentUser(undefined, MyPipe)`.

## Typed Metadata Decorators (`Reflector.createDecorator`)

Thay vì dùng chuỗi key thô với `@SetMetadata("roles", [...])`, hãy dùng `Reflector.createDecorator<T>()` để tạo các decorator an toàn kiểu dữ liệu dựa trên symbol duy nhất:

@@filename(public.decorator.ts)

```ts
import { Reflector } from "@bunest/core";

export const Public = Reflector.createDecorator<boolean>();
export const CacheTtl = Reflector.createDecorator<number>({
  transform: (seconds) => Math.max(0, seconds),
});
```

Đọc metadata bên trong Guard hoặc Interceptor với suy luận kiểu đầy đủ:

@@filename(cache-ttl.interceptor.ts)

```ts
import {
  Injectable,
  Reflector,
  type BunestInterceptor,
  type CallHandler,
  type ExecutionContext,
} from "@bunest/core";
import { CacheTtl } from "./public.decorator";

@Injectable()
export class CacheHeaderInterceptor implements BunestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  async intercept(context: ExecutionContext, next: CallHandler) {
    const ttl = this.reflector.getAllAndOverride(CacheTtl, [
      context.getHandler(),
      context.getClass(),
    ]);

    const res = context.switchToHttp().getResponse();
    if (ttl !== undefined) {
      res.header("Cache-Control", `public, max-age=${ttl}`);
    }
    return next.handle();
  }
}
```

## Kết hợp nhiều Decorator

Vì legacy decorator chỉ là các hàm TypeScript thuần, bạn có thể gom nhiều guard, metadata và response header vào một decorator mang tính ngữ nghĩa duy nhất:

@@filename(auth.decorator.ts)

```ts
import { UseGuards } from "@bunest/core";
import { BearerAuthGuard } from "./auth.guard";
import { Roles } from "./roles.decorator";
import { RolesGuard } from "./roles.guard";

export function Auth(...roles: string[]): MethodDecorator & ClassDecorator {
  return (
    target: object,
    propertyKey?: string | symbol,
    descriptor?: PropertyDescriptor,
  ) => {
    const rolesDec = Roles(roles);
    const guardsDec = UseGuards(BearerAuthGuard, RolesGuard);
    if (propertyKey !== undefined && descriptor !== undefined) {
      rolesDec(target, propertyKey, descriptor);
      guardsDec(target, propertyKey, descriptor);
    } else {
      rolesDec(target as Function);
      guardsDec(target as Function);
    }
  };
}
```
