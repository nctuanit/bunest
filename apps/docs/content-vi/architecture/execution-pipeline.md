# Pipeline Thực thi 11 Giai đoạn

Mọi HTTP request do Bunest xử lý đều đi qua **một pipeline thực thi 11 giai đoạn tất định duy nhất** được chốt trong **[ADR-008](/architecture/adrs)**. Dù request khớp với bảng Zig gốc `Bun.serve({ routes })` của Bun hay Fallback Radix Router có kiểm soát, nó đều thực thi đúng cùng một closure `CompiledExecutionPlan`.

## Trình khám phá Pipeline tương tác

Nhấp vào bất kỳ giai đoạn nào bên dưới để xem chính xác thứ tự thực thi, quy tắc ngắt mạch (short-circuit) và hợp đồng kiến trúc của nó:

@@component(pipeline-diagram)

## Trình tự chuẩn

```text
Incoming Request
  1. Route Match (Bun.serve native routes OR fallback dispatcher -> 404/405)
  2. RequestContext Init (+ AsyncLocalStorage / RequestContainer if scoped)
  ── Exception Filter Boundary begins ──────────────────────────────────────────
  3. Security / CORS Pre-Processing (preflight short-circuit, payload limits, IP)
  4. Middleware (Global -> Module-bound matching path/method)
  5. Guards (Global -> Controller -> Method)
  6. Interceptors [Before] (Global -> Controller -> Method)    ──┐
  7. Parameter Extraction (by ascending ParameterMetadata.index)│ Onion wrapped
  8. Pipes & Validation (Global -> Controller -> Method -> Param)│ by CallHandler
  9. Controller Handler (await controller[handlerKey](...args)) │ .handle()
 10. Interceptors [After] (Method -> Controller -> Global)     ──┘
 11. Response Serialization (ADR-010 + CORS/cookies/headers merge)
  ── Exception Filter Boundary catches throws from stages 3–11 (and 404/405) ──
  -> Exception Filters (Method -> Controller -> Global -> DefaultExceptionFilter)
  -> Native Web Response (with CORS headers preserved)
```

## Ma trận Quy tắc Ưu tiên

| Cơ chế | Thứ tự thực thi | Ngữ nghĩa Ngắt mạch / Ghi đè |
| --- | --- | --- |
| **Middleware** | Global &rarr; Module (thứ tự topo) | Trả về `Response` hoặc ném lỗi sẽ dừng các giai đoạn phía sau |
| **Guards** | Global &rarr; Controller &rarr; Method | Tất cả phải vượt qua; kết quả `false` đầu tiên (403) hoặc ném lỗi sẽ dừng pipeline trước khi phân tích body |
| **Interceptors (before)** | Global &rarr; Controller &rarr; Method | Lớp ngoài bọc lớp trong; bỏ qua `next.handle()` sẽ bỏ qua handler |
| **Pipes** | Global &rarr; Controller &rarr; Method &rarr; Parameter | Nối chuỗi tuần tự theo từng tham số (`v0 -> p1 -> p2 -> ... -> vn`) |
| **Interceptors (after)** | Method &rarr; Controller &rarr; Global | Lớp trong mở ngược (unwind) và biến đổi kết quả trước lớp ngoài |
| **Exception Filters** | **Method &rarr; Controller &rarr; Global &rarr; Default** | **Cụ thể nhất trước**; filter khớp `instanceof` của `@Catch(...)` đầu tiên sẽ thắng |

## Hot Path biên dịch lúc khởi động (Compile-at-Bootstrap)

Khi khởi động, Bunest phân giải toàn bộ enhancer gắn DI (`@UseGuards(AuthGuard)`, `APP_GUARD`, `APP_PIPE`, `APP_INTERCEPTOR`, `APP_FILTER`), ràng buộc trước các chuỗi `MiddlewareConsumer` phù hợp, hợp nhất `design:paramtypes` với `ParameterMetadata` và đóng băng một route closure.

- **Không có lời gọi `Reflect.getMetadata()` nào trên mỗi request** ở hot path.
- **Không cấp phát `RequestContainer`** trên các route thuần singleton (`requiresRequestScope === false`).
- **Đảm bảo giữ nguyên CORS** trên cả response bình thường lẫn response lỗi từ Exception Filter.
