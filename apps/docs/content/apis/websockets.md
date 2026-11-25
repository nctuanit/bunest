# WebSockets

**`@bunest/core/ws`** integrates Bun's native C++/Zig `Bun.serve({ websocket })` engine directly into Bunest—delivering `@WebSocketGateway`, `@SubscribeMessage`, `@MessageBody`, `@ConnectedSocket`, `@Ack()`, rooms/pub-sub, handshake authentication, backpressure (`maxConcurrentMessages`), and full WebSocket guards, pipes, interceptors, and exception filters with zero external dependencies.

## Installation

```bash
bun add @bunest/core
```

## Creating a Gateway

Register your gateway class in a module's `providers` array. Implement `OnGatewayInit`, `OnGatewayConnection`, or `OnGatewayDisconnect` to hook into socket lifecycle events:

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
    console.log("Chat WebSocket gateway initialized");
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

WebSocket handlers support the exact same enhancer model as HTTP controllers:

@@filename(ws-auth.guard.ts)

```ts
import {
  Injectable,
  UseFilters,
  UseGuards,
  UsePipes,
  type CanActivate,
  type ExecutionContext,
} from "@bunest/core";
import { BaseWsExceptionFilter, WsException } from "@bunest/core/ws";
import { ValidationPipe } from "@bunest/validation";

@Injectable()
export class WsAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const client = context.switchToWs().getClient<{ data?: { userId?: string } }>();
    if (!client.data?.userId) {
      throw new WsException("Unauthorized WebSocket connection");
    }
    return true;
  }
}
```

Attach `@UseGuards(WsAuthGuard)`, `@UsePipes(new ValidationPipe())`, and `@UseFilters(new BaseWsExceptionFilter())` to your gateway class or individual `@SubscribeMessage()` methods.

## Backpressure & Handshake Security

- **Backpressure (`maxConcurrentMessages`)**: Caps in-flight async handlers per socket so a flooding client cannot exhaust server memory.
- **Handshake validation**: Validate `Origin`, cookies, or Bearer tokens during the HTTP upgrade phase before upgrading the connection.

## Custom Adapters & Multi-Instance Scaling

By default, Bunest uses `BunWebSocketAdapter` backed by `Bun.serve({ websocket })`. For multi-node deployments, call `app.useWebSocketAdapter(customAdapter)` with an `AbstractWsAdapter` subclass backed by Redis Pub/Sub (`Bun.RedisClient`) to fan out `server.to(room).emit(...)` across instances.
