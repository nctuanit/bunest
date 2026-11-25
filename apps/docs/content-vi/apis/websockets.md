# WebSockets

**`@bunest/core/ws`** tích hợp trực tiếp engine `Bun.serve({ websocket })` viết bằng C++/Zig của Bun vào Bunest — hỗ trợ `@WebSocketGateway`, `@SubscribeMessage`, `@MessageBody`, `@ConnectedSocket`, `@Ack()`, phòng chat (rooms/pub-sub), xác thực handshake, kiểm soát áp lực (`maxConcurrentMessages`), cùng đầy đủ guards, pipes, interceptors và exception filters với 0 phụ thuộc ngoài.

## Cài đặt

```bash
bun add @bunest/core
```

## Tạo WebSocket Gateway

Đăng ký gateway trong mảng `providers` của module. Cài đặt `OnGatewayInit`, `OnGatewayConnection` hoặc `OnGatewayDisconnect` để bắt các sự kiện vòng đời kết nối:

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
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  type OnGatewayInit,
} from "@bunest/core/ws";

@WebSocketGateway({
  path: "/ws/chat",
  maxConcurrentMessages: 16,
})
export class ChatGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: BunWsServer;

  afterInit() {
    console.log("Chat WebSocket gateway đã khởi tạo");
  }

  handleConnection(client: BunWsClient) {
    client.emit("welcome", { id: client.id });
  }

  handleDisconnect(client: BunWsClient) {
    this.server.emit("user.left", { id: client.id });
  }

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
    @ConnectedSocket() client: BunWsClient,
    @MessageBody() payload: { room: string; text: string },
    @Ack() ack?: (res: unknown) => void,
  ) {
    this.server.to(payload.room).emit("message", {
      from: client.id,
      text: payload.text,
    });
    ack?.({ delivered: true });
  }
}
```

## Guards, Pipes, Interceptors & Exception Filters

WebSocket handler dùng chung mô hình enhancer giống hệt HTTP controller:

@@filename(ws-auth.guard.ts)

```ts
import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from "@bunest/core";
import { WsException } from "@bunest/core/ws";

@Injectable()
export class WsAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const client = context.switchToWs().getClient<{ data?: { userId?: string } }>();
    if (!client.data?.userId) {
      throw new WsException("Kết nối WebSocket chưa được xác thực");
    }
    return true;
  }
}
```

Gắn `@UseGuards(WsAuthGuard)`, `@UsePipes(new ValidationPipe())` và `@UseFilters(new BaseWsExceptionFilter())` lên gateway hoặc từng `@SubscribeMessage()`.

## Backpressure & Bảo mật Handshake

- **Backpressure (`maxConcurrentMessages`)**: Giới hạn số lượng handler async chạy đồng thời trên mỗi socket để ngăn client spam làm cạn bộ nhớ.
- **Xác thực handshake**: Kiểm tra `Origin`, cookie hoặc Bearer token ngay ở bước HTTP upgrade trước khi nâng cấp kết nối.

## Custom Adapter & Mở rộng nhiều Instance

Mặc định Bunest dùng `BunWebSocketAdapter` trên `Bun.serve({ websocket })`. Khi triển khai nhiều node, hãy gọi `app.useWebSocketAdapter(customAdapter)` kế thừa `AbstractWsAdapter` dùng Redis Pub/Sub (`Bun.RedisClient`) để đồng bộ `server.to(room).emit(...)` giữa các instance.
