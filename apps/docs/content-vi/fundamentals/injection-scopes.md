# Injection scopes

Mọi provider và controller trong Bunest đều có vòng đời DI được xác định rõ ràng thông qua enum `Scope` (`@bunest/core`, [ADR-012](/architecture/adrs)).

## Các Scope được hỗ trợ

| Scope                         | Vòng đời (Lifetime)                       | Thời điểm khởi tạo                                                                                    | Chia sẻ giữa các Request?                                               |
| ----------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `Scope.SINGLETON` _(mặc định)_ | Toàn bộ vòng đời ứng dụng                | Khởi tạo sớm (eager) khi bootstrap                                                                    | Có — BẮT BUỘC phải là stateless                                         |
| `Scope.TRANSIENT`             | Theo từng điểm inject / lệnh resolve      | Mỗi lần resolve (khi bootstrap đối với consumer singleton; theo từng request đối với consumer request-scoped) | Chỉ khi thuộc sở hữu của một singleton                                  |
| `Scope.REQUEST`               | Vòng đời của một HTTP request duy nhất    | Khởi tạo lười (lazy) theo từng request bên trong `RequestContainer`                                   | **Không bao giờ** — cô lập theo từng request, dùng chung trong cùng một request |

## Phát hiện rò rỉ Scope nghiêm ngặt (Fail-Fast)

Trong NestJS, việc inject một provider `Scope.REQUEST` vào một singleton sẽ âm thầm "lan truyền" (bubble) request scope lên toàn bộ cây dependency — thường làm giảm thông lượng một cách ngoài ý muốn mà lập trình viên không hề hay biết.

**Bunest áp dụng cách tiếp cận chặt chẽ và an toàn hơn:** một consumer `Scope.SINGLETON` **KHÔNG BAO GIỜ ĐƯỢC PHÉP** phụ thuộc (trực tiếp hay bắc cầu) vào một provider `Scope.REQUEST`. Mọi vi phạm sẽ thất bại ngay khi bootstrap (fail-fast) với ngoại lệ **`ScopeLeakException`** trước khi `Bun.serve()` khởi động!

@@component(scope-matrix)

Khi phát hiện rò rỉ scope ở bước bootstrap, Bunest sẽ in ra chính xác chuỗi vi phạm cùng gợi ý khắc phục:

```text
ScopeLeakException: SINGLETON "UsersController" cannot depend on REQUEST-scoped "TenantContext".
Chain: UsersController [SINGLETON] -> UsersService [SINGLETON] -> TenantContext [REQUEST]
Fix: Mark "UsersController" and "UsersService" with { scope: Scope.REQUEST }, or read ambient RequestContext inside request handlers.
```

## Sử dụng `Scope.REQUEST` đúng cách

Hãy khai báo tường minh `scope: Scope.REQUEST` dọc theo chuỗi consumer, và inject các token dựng sẵn `REQUEST` hoặc `REQUEST_CONTEXT` của Bunest:

@@filename(tenant-context.service.ts)

```ts
import {
  Inject,
  Injectable,
  REQUEST,
  Scope,
  type OnRequestDestroy,
} from "@bunest/core";

@Injectable({ scope: Scope.REQUEST })
export class TenantContext implements OnRequestDestroy {
  readonly tenantId: string;
  readonly correlationId: string;

  constructor(@Inject(REQUEST) req: Request) {
    this.tenantId = req.headers.get("x-tenant-id") ?? "public";
    this.correlationId =
      req.headers.get("x-correlation-id") ?? crypto.randomUUID();
  }

  onRequestDestroy(): void {
    // Runs in a finally block when the request finishes or client aborts
  }
}
```

@@filename(tenant-orders.controller.ts)

```ts
import { Controller, Get, Scope } from "@bunest/core";
import { TenantContext } from "./tenant-context.service";

@Controller({ path: "orders", scope: Scope.REQUEST })
export class TenantOrdersController {
  constructor(private readonly tenant: TenantContext) {}

  @Get()
  list() {
    return {
      tenantId: this.tenant.tenantId,
      correlationId: this.tenant.correlationId,
    };
  }
}
```

## Fast Path không chi phí cho các Route Singleton

Khi bootstrap, Bunest tính toán tĩnh thuộc tính `requiresRequestScope: boolean` cho mọi route đã biên dịch bằng cách kiểm tra controller, guards, pipes, interceptors và exception filters của route đó:

- Nếu `requiresRequestScope === false`: toàn bộ instance được resolve **một lần duy nhất khi bootstrap** và gắn trực tiếp vào closure của route. Không phát sinh bất kỳ cấp phát `RequestContainer` hay bước chuyển `AsyncLocalStorage` nào trên mỗi request.
- Nếu `requiresRequestScope === true`: route sẽ chạy bên trong `AsyncLocalStorage.run(...)` với một `RequestContainer` cô lập, chia sẻ từng instance `Scope.REQUEST` trong phạm vi request đó và tự động dọn dẹp trong khối `finally` (thông qua `onRequestDestroy()` hoặc `Symbol.asyncDispose` / `Symbol.dispose`).
