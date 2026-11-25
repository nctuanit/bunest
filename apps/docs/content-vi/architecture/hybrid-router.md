# Hybrid `Bun.serve` Router

`Bun.serve({ routes, fetch, websocket })` cung cấp một router Zig gốc siêu nhanh, nhưng kiểm thử thực nghiệm trên **Bun 1.4.5** cho thấy một số khoảng trống cụ thể (như `405 + Allow`, route ràng buộc host, tham số tùy chọn/regex và wildcard giữa đường dẫn). **[ADR-011](/architecture/adrs)** đặc tả chiến lược biên dịch lai (hybrid) của Bunest giúp giữ hơn 95% REST route trên fast path gốc của Bun trong khi vẫn xử lý gọn mọi trường hợp biên.

@@component(router-architecture)

## Ma trận hỗ trợ `routes` được kiểm chứng trên Bun 1.4.5

Thứ tự ưu tiên khớp gốc bên trong `Bun.serve({ routes })` tuân thủ nghiêm ngặt **`static > :param > * > fetch`**.

| Tính năng định tuyến | Hành vi gốc trên Bun 1.4.5 | Chiến lược của Bunest |
| --- | --- | --- |
| Đường dẫn tĩnh (`/`, `/users`, `/api/health`) | Hỗ trợ gốc | Biên dịch vào `Bun.serve({ routes })` |
| Tham số có tên (`/users/:id`, `/:org/repos/:id`) | Hỗ trợ gốc; `req.params` tự giải mã URL | Biên dịch vào `Bun.serve({ routes })` |
| Wildcard cuối đường dẫn (`/files/*`) | Hỗ trợ gốc (bỏ sót `/files` trần) | Biên dịch vào `Bun.serve({ routes })` |
| `req.cookies` (`CookieMap`) & `server.requestIP(req)` | Hỗ trợ gốc | Dùng trực tiếp bởi `@Cookies()` & `@Ip()` |
| Nâng cấp WebSocket (`server.upgrade`) | Hỗ trợ từ `routes` và `fetch()` | Điều phối gọn cho các WS gateway |
| **HTTP verb không khớp &rarr; `405` + `Allow`** | Rơi xuống `fetch()` theo mặc định gốc | Xử lý trong **O(1)** bên trong dispatcher `routes[path]` theo từng path |
| **CORS `OPTIONS` preflight** | `OPTIONS` không khớp rơi xuống `fetch()` | Xử lý trong dispatcher theo từng path & fallback `fetch()` |
| **Dấu gạch chéo cuối (`/users/` vs `/users`)** | Bỏ lỡ nghiêm ngặt theo mặc định gốc | Nghiêm ngặt mặc định; tùy chọn bật `ignoreTrailingSlash: true` trong `fetch()` |
| **Wildcard giữa đường dẫn (`/files/*/meta`)** | Không hỗ trợ gốc | Biên dịch vào **Fallback Radix Router** |
| **Tham số tùy chọn (`/users/:id?`)** | Bị coi như chuỗi ký tự theo mặc định gốc | Biên dịch vào **Fallback Radix Router** |
| **Tham số Regex (`/users/:id(\\d+)`)** | Bị coi như chuỗi ký tự theo mặc định gốc | Biên dịch vào **Fallback Radix Router** |
| **Ràng buộc Host (`@Controller({ host })`)** | Không hỗ trợ gốc | Biên dịch vào **Fallback Radix Router** |

## Tại sao dùng một Dispatcher Closure cho mỗi đường dẫn?

Thay vì đăng ký một map đối tượng `{ GET, POST }` thô cho từng path trong `Bun.serve({ routes })`, Bunest đăng ký **một closure đã biên dịch duy nhất `(req, server) => ...`** cho mọi canonical path đủ điều kiện chạy gốc:

1. Giữ nguyên tra cứu radix Zig gốc của Bun, `req.params`, `req.cookies`, và thứ tự ưu tiên `static > :param > * > fetch`.
2. Điều phối `methods[req.method]` trong **O(1)** (ánh xạ `HEAD` sang `GET` với body rỗng khi không có route `HEAD` tường minh, và fallback về `@All()` nếu có định nghĩa).
3. Trả lời **CORS `OPTIONS` preflight** ngay lập tức trên các path đã khớp mà không rơi xuống `fetch()`.
4. Trả về **`405 Method Not Allowed`** kèm header `Allow` đã sắp xếp và tính trước (ví dụ: `"GET, HEAD, POST"`) đi trực tiếp qua Global Exception Filters với header CORS được giữ nguyên.
5. Thực thi các chuỗi `MiddlewareConsumer` đã ràng buộc trước lúc khởi động—không tốn chi phí khớp regex middleware trên mỗi request.

## Thứ tự Fallback có kiểm soát của `fetch(req, server)`

Các request không khớp với `Bun.serve({ routes })` sẽ đi vào hàm `fetch()` của Bunest theo đúng thứ tự sau:

```text
fetch(req, server)
  1. WebSocket Upgrade Check (if WS gateway registered on pathname)
  2. Trailing-Slash Normalization (only if ignoreTrailingSlash === true)
  3. Fallback Radix Router Match (host, mid-path wildcard, optional/regex params)
       -> method match: run compiled ExecutionPlan closure
       -> CORS preflight OPTIONS: return 204 with CORS headers
       -> method mismatch: throw MethodNotAllowedException (405) + Allow header
  4. Unmatched CORS Preflight Check (if CORS enabled & OPTIONS + Origin + ACRM)
  5. 404 Not Found -> NotFoundException(`Cannot ${req.method} ${pathname}`)
       -> routed through Global Exception Filters with CORS headers
```

> tip **Kiểm thử E2E song song** `@bunest/core/http` hỗ trợ `app.listen(0)` (cổng tạm do hệ điều hành cấp phát) và cung cấp `app.getUrl()`, giúp các bộ test `bun test` chạy song song hoàn toàn không xung đột cổng—hoặc sử dụng `request(app)` / `TestClient` / `app.inject()` không cần mở socket của `@bunest/testing` (xem [hướng dẫn Kiểm thử](/fundamentals/testing)).
