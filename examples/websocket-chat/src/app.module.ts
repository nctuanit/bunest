import "reflect-metadata";
import { Module, UnauthorizedException } from "@bunest/common";
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketModule,
  WebSocketServer,
  WsException,
  type BunWsClient,
  type BunWsServer,
  type OnGatewayAuthenticate,
  type OnGatewayDisconnect,
} from "@bunest/websockets";

export const VALID_CHAT_TOKENS = new Map<string, string>([
  ["token-alice", "alice"],
  ["token-bob", "bob"],
  ["token-carol", "carol"],
]);

interface ChatClientData extends Record<string, unknown> {
  username: string;
}

@WebSocketGateway({ path: "/chat" })
export class ChatGateway implements OnGatewayAuthenticate, OnGatewayDisconnect {
  @WebSocketServer()
  public server!: BunWsServer;

  public readonly disconnectedUsers: string[] = [];

  authenticate(req: Request): ChatClientData {
    const url = new URL(req.url);
    const token =
      url.searchParams.get("token") ??
      req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");

    const username = token ? VALID_CHAT_TOKENS.get(token) : undefined;
    if (!username) {
      throw new UnauthorizedException("Missing or invalid chat token");
    }
    return { username };
  }

  handleDisconnect(client: BunWsClient<ChatClientData>): void {
    const username = client.data.username;
    this.disconnectedUsers.push(username);
    for (const room of client.rooms) {
      client.to(room).emit("system", {
        type: "left",
        room,
        user: username,
      });
    }
  }

  @SubscribeMessage("join")
  handleJoin(
    @ConnectedSocket() client: BunWsClient<ChatClientData>,
    @MessageBody() payload: { room?: string },
  ) {
    const room = payload?.room?.trim();
    if (!room) {
      throw new WsException("Room name is required");
    }
    client.join(room);
    client.to(room).emit("system", {
      type: "joined",
      room,
      user: client.data.username,
    });
    return {
      joined: room,
      user: client.data.username,
      members: this.server.subscriberCount(room),
    };
  }

  @SubscribeMessage("message")
  handleMessage(
    @ConnectedSocket() client: BunWsClient<ChatClientData>,
    @MessageBody() payload: { room?: string; text?: string },
  ) {
    const room = payload?.room?.trim();
    const text = payload?.text?.trim();
    if (!room || !text) {
      throw new WsException("Both room and text are required");
    }
    if (!client.rooms.has(room)) {
      throw new WsException(`Join room "${room}" before sending messages`);
    }

    const message = {
      room,
      from: client.data.username,
      text,
      sentAt: new Date().toISOString(),
    };
    client.to(room).emit("message", message);
    return { delivered: true, room };
  }

  @SubscribeMessage("leave")
  handleLeave(
    @ConnectedSocket() client: BunWsClient<ChatClientData>,
    @MessageBody() payload: { room?: string },
  ) {
    const room = payload?.room?.trim();
    if (!room) {
      throw new WsException("Room name is required");
    }
    client.leave(room);
    client.to(room).emit("system", {
      type: "left",
      room,
      user: client.data.username,
    });
    return { left: room };
  }
}

@Module({
  imports: [WebSocketModule.forRoot()],
  providers: [ChatGateway],
})
export class AppModule {}
