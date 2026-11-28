# Server-Sent Events (`28-sse`)

Bunest counterpart of NestJS's [`sample/28-sse`](https://github.com/nestjs/nest/tree/master/sample/28-sse), using native `AsyncGenerator` streams (no RxJS):

- **`@Sse("sse")`**: Streams `MessageEvent` payloads (`id`, `type`, `data`, `retry`) over `text/event-stream`
- **`@SseSignal()`**: Automatically cleans up streams when clients disconnect
- **Live Push Channel (`POST /notifications` → `@Sse("notifications")`)**: Broadcasts events to connected `EventSource` subscribers
- **Built-in Demo UI (`GET /`)**: Minimal HTML page subscribing via `new EventSource("/sse")`

## Run

```bash
bun run --cwd examples/sse dev
bun run --cwd examples/sse test
```
