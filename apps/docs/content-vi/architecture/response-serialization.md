# Hợp đồng Tuần tự hóa Phản hồi (Response Serialization)

**[ADR-010](/architecture/adrs)** chốt ma trận tuần tự hóa giá trị trả về của Bunest, các mã trạng thái HTTP mặc định, quy tắc body rỗng theo RFC 9110 và thứ tự ưu tiên gộp header trên mọi kiểu trả về của handler.

## Thứ tự ưu tiên phân giải mã trạng thái

Được đánh giá từ độ ưu tiên cao nhất đến thấp nhất:

1. **`Response.status`** gốc được trả về (khi handler/interceptor trả về `value instanceof Response`).
2. Mã trạng thái thiết lập động qua **`@Res()`** (`ResponseContext.status(code)`).
3. Mã trạng thái chuyển hướng động trả về từ handler **`@Redirect()`** (`{ url, statusCode }`).
4. Decorator **`@HttpCode(code)`** trên phương thức handler.
5. Mặc định của decorator **`@Redirect(url, statusCode)`** (`302 Found`).
6. Mặc định theo phương thức HTTP:
   - **`POST` &rarr; `201 Created`**
   - **`GET`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`, `HEAD` &rarr; `200 OK`**

## Ma trận Tuần tự hóa Giá trị Trả về

Được đánh giá nghiêm ngặt từ trên xuống dưới sau khi toàn bộ interceptor đã hoàn tất (unwind):

| Độ ưu tiên | Kiểu giá trị trả về | HTTP Body | `Content-Type` mặc định | Ghi chú |
| --- | --- | --- | --- | --- |
| 1 | `value instanceof Response` | **Passthrough** (giữ nguyên) | Giữ nguyên từ `Response` | Gộp CORS, `Set-Cookie`, và các header `@Header()` còn thiếu mà không ghi đè header tường minh |
| 2 | Route `@Redirect()` | Rỗng (`null`) | Không có | Đặt header `Location` từ giá trị trả về động hoặc URL trong decorator |
| 3 | Route `@Sse()` (`AsyncIterable` / `ReadableStream`) | Luồng SSE UTF-8 | `text/event-stream; charset=utf-8` | Đặt `Cache-Control: no-cache, no-transform`; hủy iterator khi bị abort |
| 4 | `value instanceof ReadableStream` | Stream trực tiếp | `application/octet-stream` | Truyền thẳng Web stream gốc không qua bộ đệm (zero-buffering) |
| 5 | `value instanceof Blob` (gồm `Bun.file()`) | `new Response(blob)` | `blob.type \|\| "application/octet-stream"` | Giữ nguyên tối ưu hóa zero-copy `sendfile` của Bun |
| 6 | `Uint8Array` / `ArrayBuffer` / `ArrayBufferView` | Byte nhị phân thô | `application/octet-stream` | Phản hồi nhị phân trực tiếp không qua mã hóa JSON |
| 7 | `null` hoặc `undefined` | Rỗng (`null`) | Không có | Trả về `new Response(null, { status, headers })` |
| 8 | `string` | Văn bản UTF-8 | `text/plain; charset=utf-8` | Ghi đè bằng `@Header("Content-Type", "text/html; charset=utf-8")` |
| 9 | `number` hoặc `boolean` | `JSON.stringify(value)` | `application/json; charset=utf-8` | Giá trị nguyên thủy JSON hợp lệ đọc lại được qua `res.json()` |
| 10 | Plain object / Array / Class instance | `JSON.stringify(value)` | `application/json; charset=utf-8` | Tôn trọng `toJSON()`; cấu trúc vòng lặp ném lỗi `500` do Exception Filters bắt |

## Thực thi Body Rỗng theo RFC 9110

Với các phản hồi có mã trạng thái **`204 No Content`**, **`304 Not Modified`**, **`1xx`**, hoặc request có phương thức HTTP **`HEAD`**, Bunest luôn khởi tạo `new Response(null, { status, headers })` với body rỗng bất kể handler trả về giá trị gì.

## Thứ tự Gộp Header & `Set-Cookie`

Header được gộp theo độ ưu tiên tăng dần (các lớp sau ghi đè header đơn giá trị của lớp trước):

1. `Content-Type` mặc định của serializer
2. Các header CORS đã cấu hình
3. Các mục tĩnh `@Header(name, value)` (theo thứ tự khai báo)
4. Các header động từ `@Res()` (`ResponseContext.header(...)`)
5. Các header tường minh đã có sẵn trên đối tượng `Response` gốc được trả về

Các mục `Set-Cookie` **luôn được nối thêm** (`headers.append("Set-Cookie", ...)`) để nhiều cookie không bao giờ ghi đè lẫn nhau.
