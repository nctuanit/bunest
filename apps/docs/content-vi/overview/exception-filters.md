# Exception filters

Bunest tích hợp sẵn một tầng xử lý ngoại lệ tập trung để bắt mọi ngoại lệ chưa được xử lý phát sinh qua các giai đoạn 3–11 của [Execution Pipeline 11 giai đoạn](/architecture/execution-pipeline) cũng như các lỗi dự phòng `404` và `405`, biến chúng thành các JSON response nhất quán và an toàn.

## Ném các Exception chuẩn

Bunest cung cấp `HttpException` và 16 lớp HTTP exception dựng sẵn:

@@filename(users.controller.ts)

```ts
import {
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpException,
  HttpStatus,
  NotFoundException,
  Param,
} from "@bunest/core";

@Controller("users")
export class UsersController {
  @Get(":id")
  findOne(@Param("id") id: string) {
    if (id === "0") {
      throw new NotFoundException(`User #${id} does not exist`);
    }
    if (id === "admin") {
      throw new ForbiddenException("Admin profile is restricted");
    }
    if (id === "teapot") {
      throw new HttpException("I'm a teapot", HttpStatus.I_AM_A_TEAPOT);
    }
    return { id };
  }
}
```

### Các HTTP Exception dựng sẵn

| Lớp Exception                   | Status | Thông điệp mặc định    |
| ------------------------------- | ------ | ---------------------- |
| `BadRequestException`           | `400`  | Bad Request            |
| `UnauthorizedException`         | `401`  | Unauthorized           |
| `ForbiddenException`            | `403`  | Forbidden              |
| `NotFoundException`             | `404`  | Not Found              |
| `MethodNotAllowedException`     | `405`  | Method Not Allowed     |
| `ConflictException`             | `409`  | Conflict               |
| `GoneException`                 | `410`  | Gone                   |
| `PayloadTooLargeException`      | `413`  | Payload Too Large      |
| `UnsupportedMediaTypeException` | `415`  | Unsupported Media Type |
| `UnprocessableEntityException`  | `422`  | Unprocessable Entity   |
| `TooManyRequestsException`      | `429`  | Too Many Requests      |
| `InternalServerErrorException`  | `500`  | Internal Server Error  |
| `NotImplementedException`       | `501`  | Not Implemented        |
| `BadGatewayException`           | `502`  | Bad Gateway            |
| `ServiceUnavailableException`   | `503`  | Service Unavailable    |
| `GatewayTimeoutException`       | `504`  | Gateway Timeout        |

## Cấu trúc JSON lỗi chuẩn hóa

Mọi exception trong Bunest đều dùng chung một cấu trúc JSON response đồng nhất ([ADR-009](/architecture/adrs)):

```json
{
  "statusCode": 404,
  "error": "Not Found",
  "message": "User #0 does not exist",
  "timestamp": "2026-11-20T03:00:00.000Z",
  "path": "/users/0"
}
```

> warning **Bất biến an toàn Production** Với các lỗi không xác định hoặc không phải `HttpException`, `DefaultExceptionFilter` tích hợp sẵn sẽ ghi log lỗi nội bộ qua `Logger` và trả về `500 Internal Server Error` (`"Internal server error"`). Nó **không bao giờ làm lộ stack trace hay thông điệp nội bộ** khi `NODE_ENV === "production"`, và luôn giữ nguyên các CORS header đã cấu hình.

## Custom Exception Filters (`@Catch`)

Tạo một filter tùy chỉnh bằng cách triển khai `ExceptionFilter` và gắn decorator `@Catch(...exceptionTypes)`. Trả về một Web `Response` gốc (hoặc sử dụng `ResponseContext`) để xử lý lỗi gọn gàng:

@@filename(http-exception.filter.ts)

```ts
import {
  Catch,
  HttpException,
  type ArgumentsHost,
  type ExceptionFilter,
} from "@bunest/core";

@Catch(HttpException)
export class CustomHttpExceptionFilter implements ExceptionFilter<HttpException> {
  catch(exception: HttpException, host: ArgumentsHost): Response {
    const http = host.switchToHttp();
    const req = http.getRequest();
    const status = exception.getStatus();

    return Response.json(
      {
        statusCode: status,
        message: exception.message,
        path: new URL(req.url).pathname,
        timestamp: new Date().toISOString(),
      },
      { status },
    );
  }
}
```

> info **Filter bắt mọi lỗi (Catch-All)** Gắn `@Catch()` không tham số lên class để bắt **mọi** giá trị bị ném ra ở phạm vi tương ứng.

## Gắn Filter & Thứ tự ưu tiên

Gắn filter ở cấp method, controller hoặc global—thông qua `@UseFilters(...)` hoặc DI token `APP_FILTER`:

@@filename(binding-filters.ts)
@@tab(Controller / Method)

```ts
import { Controller, Get, UseFilters } from "@bunest/core";
import { CustomHttpExceptionFilter } from "./http-exception.filter";

@UseFilters(CustomHttpExceptionFilter)
@Controller("orders")
export class OrdersController {
  @Get(":id")
  findOne() {
    // Covered by CustomHttpExceptionFilter
  }
}
```

@@switch
@@tab(Global DI Token)

```ts
import { APP_FILTER, Module } from "@bunest/core";
import { CustomHttpExceptionFilter } from "./http-exception.filter";

@Module({
  providers: [
    {
      provide: APP_FILTER,
      useClass: CustomHttpExceptionFilter,
    },
  ],
})
export class AppModule {}
```

Khác với middleware, guard và pipe, **Exception Filters chạy từ phạm vi hẹp nhất đến rộng nhất**:

```text
Method (@UseFilters) -> Controller (@UseFilters) -> Global (APP_FILTER / useGlobalFilters) -> DefaultExceptionFilter
```

Filter đầu tiên có `@Catch(...)` khớp với `error instanceof ExceptionType` sẽ xử lý lỗi đó.
