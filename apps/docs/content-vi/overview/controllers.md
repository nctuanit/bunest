# Controllers

Controller chịu trách nhiệm tiếp nhận các **HTTP request** gửi đến và trả **response** về cho client. Tuân theo quy ước của NestJS ([ADR-003](/architecture/adrs), [RFC-001](/architecture/adrs)), mỗi class `@Controller()` gom nhóm các endpoint liên quan dưới dạng các method được gắn decorator—không cần kế thừa `BaseMethod` hay tạo mỗi endpoint một class riêng rườm rà.

## Định tuyến (Routing)

Gắn class decorator `@Controller()` để khai báo tiền tố route (tùy chọn), và gắn các decorator HTTP verb (`@Get`, `@Post`, `@Put`, `@Patch`, `@Delete`, `@Options`, `@Head`, `@All`, `@Sse`) lên các method xử lý:

@@filename(cats.controller.ts)

```ts
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from "@bunest/core";
import { CreateCatDto } from "./dto/create-cat.dto";
import { UpdateCatDto } from "./dto/update-cat.dto";

@Controller("cats")
export class CatsController {
  @Get()
  findAll(@Query("breed") breed?: string) {
    return { action: "findAll", breed: breed ?? null };
  }

  @Get(":id")
  findOne(@Param("id") id: string) {
    return { action: "findOne", id };
  }

  @Post()
  create(@Body() dto: CreateCatDto) {
    // POST automatically returns 201 Created (ADR-010)
    return { created: true, data: dto };
  }

  @Patch(":id")
  update(@Param("id") id: string, @Body() dto: UpdateCatDto) {
    return { updated: true, id, data: dto };
  }

  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param("id") id: string) {
    // 204 No Content enforces an empty body per RFC 9110
  }
}
```

> info **Gợi ý** Hãy đăng ký mọi controller vào mảng `@Module({ controllers: [CatsController] })` của module. Các class không có decorator nhưng được đưa vào `controllers` sẽ báo lỗi fail-fast lúc bootstrap với `InvalidControllerException`.

## Nhiều tiền tố & Ràng buộc Host

`@Controller()` chấp nhận một chuỗi, một mảng các tiền tố route hoặc một object `ControllerOptions` đầy đủ:

@@filename(versioned.controller.ts)

```ts
import { Controller, Get, HostParam, Scope } from "@bunest/core";

// Mount identical routes under both /v1/users and /v2/users
@Controller(["/v1/users", "/v2/users"])
export class VersionedUsersController {
  @Get()
  list() {
    return [];
  }
}

// Host-constrained controller (dispatched via Fallback Radix Router — ADR-011)
@Controller({
  path: "accounts",
  host: ":tenant.example.com",
  scope: Scope.SINGLETON,
})
export class TenantAccountsController {
  @Get()
  getTenant(@HostParam("tenant") tenant: string) {
    return { tenant };
  }
}
```

## Các Request Parameter Decorator

Bunest cung cấp các legacy parameter decorator tương thích NestJS, được đánh chỉ mục theo vị trí tham số ([ADR-004](/architecture/adrs)). Các tham số có thể đặt theo **bất kỳ thứ tự nào** và Bunest không bao giờ phân tích chuỗi mã nguồn của hàm.

| Decorator                          | Dữ liệu trích xuất                         | Ghi chú                                                         |
| ---------------------------------- | ------------------------------------------ | --------------------------------------------------------------- |
| `@Body(key?, ...pipes)`            | Request body đã parse hoặc `body[key]`     | Parse lười (lazy) và cache một lần mỗi request                  |
| `@Query(key?, ...pipes)`           | Object query string hoặc giá trị đơn/mảng  | Luôn có kiểu `string` / `string[]`                              |
| `@Param(key?, ...pipes)`           | Object route param hoặc `params[key]`      | Được Bun giải mã URL gốc (native)                               |
| `@Headers(key?, ...pipes)`         | Map header chữ thường hoặc header cụ thể   | Tra cứu không phân biệt hoa/thường                              |
| `@Cookies(key?, ...pipes)`         | Cookie được parse qua `CookieMap` của Bun  | Dự phòng đọc từ header `Cookie`                                 |
| `@Req()`                           | Web `Request` gốc                          | Bao gồm các `params` đã khớp                                    |
| `@Res()`                           | Builder `ResponseContext` có thể thay đổi  | Đặt status, header, cookie trong khi vẫn trả về body bình thường|
| `@Ip()`                            | IP client qua `server.requestIP(req)`      | Tuân thủ cấu hình `trustProxy`                                  |
| `@HostParam(key?, ...pipes)`       | Tham số host đã khớp                       | Dành cho controller có ràng buộc host                           |
| `@UploadedFile(field?, ...pipes)`  | Một `UploadedFileInfo`                     | Parse từ `multipart/form-data`                                  |
| `@UploadedFiles(field?, ...pipes)` | `UploadedFileInfo[]`                       | Parse từ `multipart/form-data`                                  |

> tip **Cache Body Đọc Một Lần** `Request.body` của Web Standard là một stream chỉ đọc được một lần. Bunest cache dữ liệu body đã parse trên từng `RequestContext`, nên việc trích xuất cả `@Body("email")` lẫn `@Body("name")` trong cùng một handler sẽ không bao giờ văng lỗi `Body already used`.

## Mã trạng thái (Status Codes), Header & Chuyển hướng (Redirects)

Mặc định, **`POST` trả về `201 Created`** và mọi HTTP verb khác trả về **`200 OK`** ([ADR-010](/architecture/adrs)). Bạn có thể ghi đè status code, header tĩnh hoặc redirect theo cách khai báo:

@@filename(response-meta.controller.ts)

```ts
import {
  Controller,
  Get,
  Header,
  HttpCode,
  Post,
  Redirect,
  Res,
} from "@bunest/core";
import type { ResponseContext } from "@bunest/core";

@Controller("downloads")
export class DownloadsController {
  @Post("trigger")
  @HttpCode(202)
  @Header("X-Powered-By", "Bunest")
  @Header("Cache-Control", "no-store")
  triggerJob() {
    return { status: "queued" };
  }

  @Get("docs")
  @Redirect("https://bun.sh/docs", 302)
  redirectToDocs() {
    // Return { url, statusCode } dynamically to override decorator args
    return { url: "https://bun.sh/docs/api/http", statusCode: 301 };
  }

  @Get("custom")
  customResponse(@Res() res: ResponseContext) {
    res.status(200).header("X-Request-Mode", "builder").cookie("seen", "1", {
      httpOnly: true,
      sameSite: "lax",
    });
    return { ok: true };
  }
}
```

## Trả thẳng Web `Response` gốc

Vì Bun chạy trực tiếp trên Web Standards, bất kỳ handler nào cũng có thể trả thẳng `new Response(...)`, `Bun.file(...)` hoặc `ReadableStream`:

@@filename(raw.controller.ts)

```ts
import { Controller, Get } from "@bunest/core";

@Controller("raw")
export class RawController {
  @Get("health")
  health(): Response {
    return new Response("OK", {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}
```

## Chuẩn hóa đường dẫn & Kiểm tra trùng lặp Fail-Fast

Lúc bootstrap, Bunest ghép `[globalPrefix, controllerPrefix, methodPath]`, gộp các dấu gạch chéo lặp lại, bỏ dấu gạch chéo cuối ở các route không phải root và chuẩn hóa tên tham số (`:id` -> `:_`).

> warning **Phát hiện trùng Route** Việc đăng ký đồng thời `GET /users/:id` và `GET /users/:userId` sẽ chuẩn hóa về cùng một khóa `GET /users/:_` và ném ra **`DuplicateRouteException`** trước khi `Bun.serve()` bắt đầu lắng nghe.

## Quy tắc Singleton phi trạng thái & Kế thừa

- Controller mặc định dùng **`Scope.SINGLETON`**—không bao giờ lưu trạng thái thay đổi theo từng request trên `this`. Chỉ bật `Scope.REQUEST` khi thật sự cần thiết (xem [Phạm vi Injection](/fundamentals/injection-scopes)).
- Kế thừa một controller sẽ thừa hưởng các route của lớp cha một cách an toàn nhờ metadata copy-on-write—việc gắn decorator lên lớp con không bao giờ làm thay đổi bảng đăng ký route của controller gốc ([ADR-002](/architecture/adrs)).
