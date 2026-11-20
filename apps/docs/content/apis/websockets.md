# WebSockets

**`@bunest/websockets`** integrates Bun's native C++/Zig `Bun.serve({ websocket })` engine directly into Bunest with `@WebSocketGateway`, `@SubscribeMessage`, `@MessageBody`, `@ConnectedSocket`, `@Ack()`, rooms/pub-sub, handshake authentication, `maxConcurrentMessages`, and full WebSocket guards, pipes, interceptors, and exception filters.

## Installation

```bash
bun add @bunest/websockets
```

## Creating a Gateway

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
} from "@bunest/websockets";

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

## Enhancers & Custom Adapters

- Decorate gateways or `@SubscribeMessage()` handlers with `@UseGuards()`, `@UsePipes()`, `@UseInterceptors()`, and `@UseFilters()` (extending `BaseWsExceptionFilter` for structured `WsException` error frames).
- Use `app.useWebSocketAdapter(new BunWebSocketAdapter())` or plug in a custom `AbstractWsAdapter` for multi-instance Redis pub/sub fan-out.
