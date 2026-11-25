# WebSockets

**`@bunest/core/ws`** tích hợp trực tiếp engine C++/Zig `Bun.serve({ websocket })` native của Bun vào Bunest với `@WebSocketGateway`, `@SubscribeMessage`, `@MessageBody`, `@ConnectedSocket`, `@Ack()`, room/pub-sub, xác thực khi handshake, `maxConcurrentMessages` cùng đầy đủ guard, pipe, interceptor và exception filter cho WebSocket.

## Cài đặt

```bash
bun add @bunest/core/ws
```

## Tạo Gateway

@@filename(chat.gateway.ts)

```ts
import {
  Ack,
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  type BunWsClient,
  type BunWsServer,
} from "@bunest/core/ws";

@WebSocketGateway({ path: "/ws/chat" })
export class ChatGateway {
  @WebSocketServer()
  server!: BunWsServer;

  @SubscribeMessage("join")
  handleJoin(
    @ConnectedSocket() client: BunWsClient,
    @MessageBody() payload: { room: string },
  ) {
    client.join(payload.room);
    return { joined: payload.room };
  }

  @SubscribeMessage("message")
  handleMessage(
    @MessageBody() payload: { room: string; text: string },
    @Ack() ack?: (res: unknown) => void,
  ) {
    this.server.to(payload.room).emit("message", payload);
    ack?.({ delivered: true });
  }
}
```

## Enhancer & Custom Adapter

- Gắn `@UseGuards()`, `@UsePipes()`, `@UseInterceptors()` và `@UseFilters()` (kế thừa `BaseWsExceptionFilter` để trả về frame lỗi `WsException` có cấu trúc) cho gateway hoặc handler `@SubscribeMessage()`.
- Dùng `app.useWebSocketAdapter(new BunWebSocketAdapter())` hoặc gắn một `AbstractWsAdapter` tùy chỉnh để phân phát pub/sub qua Redis trên nhiều instance.
