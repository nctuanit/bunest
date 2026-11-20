# @bunest/websockets

Native `Bun.serve` WebSocket gateways, rooms/pub-sub, handshake authentication, and full Bunest execution pipeline for **Bunest** with zero external runtime dependencies.

## Features

- **Native `Bun.serve` WebSockets**: Powered directly by Bun's built-in WebSocket engine via `BunWebSocketAdapter` (`WsAdapter`) with zero Socket.IO or `ws` runtime overhead.
- **Declarative Gateways**: Define gateways with `@WebSocketGateway()`, inject the server via `@WebSocketServer()`, and handle events with `@SubscribeMessage()`, `@MessageBody()`, `@ConnectedSocket()`, and `@Ack()`.
- **Rooms & Pub/Sub**: Built-in room broadcasting (`buildGatewayRoomTopic()`, `buildGatewayAllTopic()`) over Bun's native pub/sub topics.
- **Lifecycle & Handshake Auth**: Supports `OnGatewayInit`, `OnGatewayAuthenticate`, `OnGatewayConnection`, and `OnGatewayDisconnect`.
- **Full Enhancer Pipeline**: Guards, Interceptors, Pipes, and `BaseWsExceptionFilter` (`WsException`) with `WsExecutionContext`.

## Installation

```bash
bun add @bunest/websockets
```

## Quick Start

```ts
import { Module } from "@bunest/common";
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketModule,
  WebSocketServer,
  type BunWsClient,
  type BunWsServer,
} from "@bunest/websockets";

@WebSocketGateway({ path: "/ws/chat" })
export class ChatGateway {
  @WebSocketServer()
  server!: BunWsServer;

  @SubscribeMessage("chat.send")
  handleMessage(
    @ConnectedSocket() client: BunWsClient,
    @MessageBody() payload: { room: string; text: string },
  ) {
    this.server.to(payload.room).emit("chat.message", {
      from: client.id,
      text: payload.text,
    });
    return { delivered: true };
  }
}

@Module({
  imports: [WebSocketModule.forRoot()],
  providers: [ChatGateway],
})
export class AppModule {}
```

## Key Exports

- **Module, Adapter & Explorer**: `WebSocketModule`, `BunWebSocketAdapter`, `WsAdapter`, `AbstractWsAdapter`, `WsGatewayExplorer`, `WS_HTTP_ADAPTER`, `WS_MODULE_OPTIONS`, `WS_METADATA_KEYS`
- **Decorators**: `WebSocketGateway`, `WebSocketServer`, `SubscribeMessage`, `MessageBody`, `ConnectedSocket`, `Ack`
- **Context, Exceptions & Filters**: `WsExecutionContext`, `WsException`, `BaseWsExceptionFilter`
- **Client, Server & Framing**: `BunWsClientImpl`, `BunWsServerImpl`, `parseWsFrame`, `serializeWsFrame`, `buildGatewayRoomTopic`, `buildGatewayAllTopic`

## Documentation

- [Bunest Documentation](../../README.md)
- [ADR Index](../../docs/adr/README.md)
