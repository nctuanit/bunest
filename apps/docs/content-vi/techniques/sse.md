# Server-Sent Events (SSE)

Server-Sent Events cho phép máy chủ đẩy các bản cập nhật thời gian thực tới trình duyệt khách qua HTTP tiêu chuẩn. Trong Bunest, các endpoint SSE sử dụng **`AsyncGenerator` / `AsyncIterable<SseMessageEvent>` gốc**—không cần `Observable` của RxJS ([ADR-006](/architecture/adrs), [ADR-010](/architecture/response-serialization)).

## Tạo Endpoint `@Sse()`

Gắn decorator `@Sse(path?)` cho phương thức controller và trả về `AsyncIterable<SseMessageEvent>` (hoặc `ReadableStream<SseMessageEvent>`):

@@filename(events.controller.ts)

```ts
import { Controller, Req, Sse, type SseMessageEvent } from "@bunest/core";

@Controller("events")
export class EventsController {
  @Sse("clock")
  async *streamClock(@Req() req: Request): AsyncGenerator<SseMessageEvent> {
    let seq = 0;

    while (!req.signal.aborted) {
      seq += 1;
      yield {
        id: String(seq),
        type: "tick",
        retry: 3000,
        data: {
          seq,
          timestamp: new Date().toISOString(),
        },
      };

      await Bun.sleep(1000);
    }
  }
}
```

## Hợp đồng `SseMessageEvent`

```ts
export interface SseMessageEvent {
  data: string | object;
  id?: string;
  type?: string;
  retry?: number;
}
```

### Tự động định dạng Wire & Header (ADR-010)

Khi một route được gắn `@Sse()`, bộ tuần tự hóa (serializer) của Bunest tự động:

1. Thiết lập `Content-Type: text/event-stream; charset=utf-8`.
2. Thiết lập `Cache-Control: no-cache, no-transform` và `Connection: keep-alive`.
3. Tuần tự hóa đối tượng `data` qua `JSON.stringify(event.data)` và phát các chuỗi nhiều dòng thành từng dòng `data: <line>\n`.
4. Kết thúc mỗi khung dữ liệu (frame) bằng `\n\n`.
5. **Hủy async iterator nguồn ngay lập tức** khi client ngắt kết nối (`request.signal` abort), ngăn ngừa rò rỉ bộ đếm thời gian (timer) hoặc con trỏ cơ sở dữ liệu.

## Nhận dữ liệu từ trình duyệt

```ts
const source = new EventSource("/events/clock");

source.addEventListener("tick", (event) => {
  const payload = JSON.parse(event.data);
  console.log("Tick:", payload.seq, payload.timestamp);
});
```
