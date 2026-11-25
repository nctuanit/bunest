# Execution context

Bunest cung cấp `ArgumentsHost` và `ExecutionContext` (kế thừa từ `ArgumentsHost`) nhằm mang lại cho **guards**, **interceptors**, **exception filters** và **custom parameter decorators** quyền truy cập thống nhất vào request hiện tại, ngữ cảnh response, class controller và phương thức handler.

## `ArgumentsHost`

`ArgumentsHost` trừu tượng hóa các đối số truyền vào một handler qua nhiều loại transport khác nhau (`"http" | "ws" | "rpc"`):

```ts
export interface ArgumentsHost {
  getArgs<T extends unknown[] = unknown[]>(): T;
  getArgByIndex<T = unknown>(index: number): T;
  switchToHttp(): HttpArgumentsHost;
  switchToWs(): WsArgumentsHost;
  switchToRpc(): RpcArgumentsHost;
  getType<TContext extends string = ContextType>(): TContext;
}
```

Bên trong các HTTP Exception Filter, gọi `host.switchToHttp()` để lấy đối tượng Web `Request` gốc và `ResponseContext` có thể thay đổi:

@@filename(audit-error.filter.ts)

```ts
import {
  Catch,
  HttpException,
  type ArgumentsHost,
  type ExceptionFilter,
} from "@bunest/core";

@Catch(HttpException)
export class AuditErrorFilter implements ExceptionFilter<HttpException> {
  catch(exception: HttpException, host: ArgumentsHost) {
    if (host.getType() !== "http") return;

    const http = host.switchToHttp();
    const request: Request = http.getRequest();
    const response = http.getResponse();

    response.header("X-Error-Handled-By", "AuditErrorFilter");
    return Response.json(
      {
        statusCode: exception.getStatus(),
        message: exception.message,
        method: request.method,
        path: new URL(request.url).pathname,
      },
      { status: exception.getStatus() },
    );
  }
}
```

## `ExecutionContext`

`ExecutionContext` mở rộng `ArgumentsHost` với hai helper reflection:

- **`context.getClass()`** — trả về constructor của `@Controller()` đang hoạt động (ví dụ: `UsersController`).
- **`context.getHandler()`** — trả về tham chiếu phương thức route handler đang hoạt động (ví dụ: `UsersController.prototype.create`).

## Đọc Metadata với `Reflector`

`Reflector` đọc metadata được gắn thông qua `@SetMetadata()` hoặc `Reflector.createDecorator()`:

| Phương thức                       | Hành vi trên `[handler, controllerClass]`                                  |
| --------------------------------- | -------------------------------------------------------------------------- |
| `get(key, target)`                | Đọc metadata từ một target duy nhất                                        |
| `getAll(key, targets)`            | Trả về mảng các giá trị metadata cho từng target                           |
| `getAllAndOverride(key, targets)` | Trả về giá trị **được định nghĩa đầu tiên** (method ghi đè controller)     |
| `getAllAndMerge(key, targets)`    | Kết hợp mảng hoặc gộp object trên tất cả các target                        |

@@filename(feature-flag.guard.ts)

```ts
import {
  Injectable,
  Reflector,
  type CanActivate,
  type ExecutionContext,
} from "@bunest/core";

export const FeatureFlag = Reflector.createDecorator<string>();

@Injectable()
export class FeatureFlagGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const flag = this.reflector.getAllAndOverride(FeatureFlag, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!flag) return true;
    return Bun.env[`FEATURE_${flag.toUpperCase()}`] === "true";
  }
}
```
