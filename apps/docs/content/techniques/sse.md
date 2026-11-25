# Server-Sent Events (SSE)

Server-Sent Events allow a server to push real-time updates to browser clients over standard HTTP. In Bunest, SSE endpoints use **native `AsyncGenerator` / `AsyncIterable<SseMessageEvent>`**—no RxJS `Observable` required.

## Creating an `@Sse()` Endpoint

Decorate a controller method with `@Sse(path?)` and return an `AsyncIterable<SseMessageEvent>` (or `ReadableStream<SseMessageEvent>`):

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

## `SseMessageEvent` Contract

```ts
export interface SseMessageEvent {
  data: string | object;
  id?: string;
  type?: string;
  retry?: number;
}
```

### Automatic Wire Formatting & Headers

When a route is decorated with `@Sse()`, Bunest's serializer automatically:

1. Sets `Content-Type: text/event-stream; charset=utf-8`.
2. Sets `Cache-Control: no-cache, no-transform` and `Connection: keep-alive`.
3. Serializes object `data` via `JSON.stringify(event.data)` and emits multi-line strings as one `data: <line>\n` per line.
4. Terminates each frame with `\n\n`.
5. **Cancels the upstream async iterator immediately** when the client disconnects (`request.signal` abort), preventing leaked timers or database cursors.

## Consuming from the Browser

```ts
const source = new EventSource("/events/clock");

source.addEventListener("tick", (event) => {
  const payload = JSON.parse(event.data);
  console.log("Tick:", payload.seq, payload.timestamp);
});
```
