import { afterEach, describe, expect, test } from "bun:test";
import {
  type ArgumentsHost,
  type BunestInterceptor,
  type CallHandler,
  type CanActivate,
  Catch,
  Controller,
  type ExceptionFilter,
  type ExecutionContext,
  Get,
  Module,
  ParseIntPipe,
  UnauthorizedException,
  UseFilters,
  UseGuards,
  UseInterceptors,
  UsePipes,
} from "../../src/common/index";
import { BunestFactory, ValidationPipe } from "../../src/index";
import { IsString, MinLength } from "@bunest/validation/validator";
import {
  type BunWebSocketAdapter,
  type BunWsClient,
  type BunWsServer,
  ConnectedSocket,
  MessageBody,
  type OnGatewayAuthenticate,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  type OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketModule,
  WebSocketServer,
  WsException,
  type WsMessageFrame,
  type WsResponse,
} from "../../src/ws/index";

class ChatMessageDto {
  @IsString()
  @MinLength(2)
  text!: string;
}

class CustomWsError extends Error {}

@Catch(CustomWsError)
class CustomWsErrorFilter implements ExceptionFilter<CustomWsError> {
  catch(err: CustomWsError, _host: ArgumentsHost) {
    return { event: "custom_error", data: { reason: err.message } };
  }
}

class RoleWsGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    expect(context.getType()).toBe("ws");
    const wsCtx = context.switchToWs();
    const client = wsCtx.getClient<BunWsClient>();
    expect(wsCtx.getPattern()).toBe("admin_only");
    return client.data.role === "admin";
  }
}

class WrapInterceptor implements BunestInterceptor {
  async intercept(_ctx: ExecutionContext, next: CallHandler) {
    const out = await next.handle();
    return { wrapped: true, payload: out };
  }
}

interface TestWsHandle {
  ws: WebSocket;
  messages: WsMessageFrame[];
  waitFor(
    predicate: (msg: WsMessageFrame) => boolean,
    timeoutMs?: number,
  ): Promise<WsMessageFrame>;
  waitForClose(timeoutMs?: number): Promise<{ code: number; reason: string }>;
  sendEvent(event: string, data?: unknown, id?: string): void;
  close(): void;
}

function connectWs(url: string): Promise<TestWsHandle> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const messages: WsMessageFrame[] = [];
    const waiters: Array<{
      predicate: (m: WsMessageFrame) => boolean;
      resolve: (m: WsMessageFrame) => void;
    }> = [];
    let closedInfo: { code: number; reason: string } | undefined;
    const closeWaiters: Array<
      (info: { code: number; reason: string }) => void
    > = [];

    const openTimer = setTimeout(() => {
      ws.close();
      reject(new Error(`Timed out opening WebSocket ${url}`));
    }, 3000);

    ws.addEventListener("open", () => {
      clearTimeout(openTimer);
      resolve({
        ws,
        messages,
        waitFor(predicate, timeoutMs = 2000) {
          const existing = messages.find(predicate);
          if (existing) {
            return Promise.resolve(existing);
          }
          return new Promise<WsMessageFrame>((res, rej) => {
            const timer = setTimeout(() => {
              rej(
                new Error(
                  `Timed out waiting for WS frame; received: ${JSON.stringify(messages)}`,
                ),
              );
            }, timeoutMs);
            waiters.push({
              predicate,
              resolve: (m) => {
                clearTimeout(timer);
                res(m);
              },
            });
          });
        },
        waitForClose(timeoutMs = 2000) {
          if (closedInfo) {
            return Promise.resolve(closedInfo);
          }
          return new Promise((res, rej) => {
            const timer = setTimeout(
              () => rej(new Error("Timed out waiting for WS close")),
              timeoutMs,
            );
            closeWaiters.push((info) => {
              clearTimeout(timer);
              res(info);
            });
          });
        },
        sendEvent(event: string, data?: unknown, id?: string) {
          ws.send(JSON.stringify({ event, data, ...(id ? { id } : {}) }));
        },
        close() {
          if (ws.readyState === WebSocket.OPEN) {
            ws.close();
          }
        },
      });
    });

    ws.addEventListener("message", (evt) => {
      if (typeof evt.data === "string") {
        const parsed = JSON.parse(evt.data) as WsMessageFrame;
        messages.push(parsed);
        for (let i = waiters.length - 1; i >= 0; i--) {
          const w = waiters[i]!;
          if (w.predicate(parsed)) {
            waiters.splice(i, 1);
            w.resolve(parsed);
          }
        }
      }
    });

    ws.addEventListener("close", (evt) => {
      closedInfo = { code: evt.code, reason: evt.reason };
      while (closeWaiters.length > 0) {
        closeWaiters.shift()!(closedInfo);
      }
    });

    ws.addEventListener("error", (err) => {
      clearTimeout(openTimer);
      reject(err);
    });
  });
}

describe("Live Bun.serve({ port: 0 }) WebSocket Gateways E2E", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      if (fn) {
        await fn().catch(() => {});
      }
    }
  });

  test("handles lifecycle hooks, request/reply acks, rooms pub/sub (sender exclusion vs inclusion), binary frames, guards/pipes/interceptors/filters, auth, and graceful shutdown", async () => {
    const lifecycleEvents: string[] = [];

    @WebSocketGateway({
      path: "/ws/chat",
      cors: { origin: ["https://allowed.app"] },
    })
    class ChatGateway
      implements
        OnGatewayInit,
        OnGatewayConnection,
        OnGatewayDisconnect,
        OnGatewayAuthenticate
    {
      @WebSocketServer()
      server!: BunWsServer;

      afterInit(server: BunWsServer) {
        expect(server).toBe(this.server);
        lifecycleEvents.push(`init:${server.path}`);
      }

      authenticate(req: Request) {
        const url = new URL(req.url);
        const token = url.searchParams.get("token");
        if (token === "alice-admin") {
          return { user: "alice", role: "admin" };
        }
        if (token === "bob-member") {
          return { user: "bob", role: "member" };
        }
        throw new UnauthorizedException("Invalid WS token");
      }

      handleConnection(client: BunWsClient) {
        lifecycleEvents.push(`connect:${String(client.data.user)}`);
        client.emit("welcome", { user: client.data.user, id: client.id });
      }

      handleDisconnect(client: BunWsClient) {
        lifecycleEvents.push(`disconnect:${String(client.data.user)}`);
      }

      @SubscribeMessage("ping")
      ping(@MessageBody() data: { seq: number }): WsResponse<{ pong: number }> {
        return { event: "pong", data: { pong: data.seq } };
      }

      @SubscribeMessage("double")
      double(@MessageBody("value", ParseIntPipe) value: number) {
        return { doubled: value * 2 };
      }

      @SubscribeMessage("join_room")
      joinRoom(
        @ConnectedSocket() client: BunWsClient,
        @MessageBody("room") room: string,
      ) {
        client.join(room);
        return { joined: room, count: this.server.subscriberCount(room) };
      }

      @SubscribeMessage("leave_room")
      leaveRoom(
        @ConnectedSocket() client: BunWsClient,
        @MessageBody("room") room: string,
      ) {
        client.leave(room);
        return { left: room, count: this.server.subscriberCount(room) };
      }

      @SubscribeMessage("room_whisper")
      roomWhisper(
        @ConnectedSocket() client: BunWsClient,
        @MessageBody() payload: { room: string; msg: string },
      ) {
        // client.to(room).emit -> excludes sender natively via ws.publish()
        client.to(payload.room).emit("room_msg", {
          from: client.data.user,
          msg: payload.msg,
        });
      }

      @SubscribeMessage("room_announce")
      roomAnnounce(@MessageBody() payload: { room: string; msg: string }) {
        // server.to(room).emit -> includes ALL subscribers including sender via server.publish()
        this.server.to(payload.room).emit("room_announcement", {
          msg: payload.msg,
        });
      }

      @UseGuards(RoleWsGuard)
      @UseInterceptors(WrapInterceptor)
      @SubscribeMessage("admin_only")
      adminOnly(@ConnectedSocket() client: BunWsClient) {
        return { secretBy: client.data.user };
      }

      @UsePipes(new ValidationPipe())
      @SubscribeMessage("validated_msg")
      validated(@MessageBody() dto: ChatMessageDto) {
        return { accepted: dto.text };
      }

      @SubscribeMessage("throw_ws")
      throwWs() {
        throw new WsException({
          code: "E_CUSTOM",
          message: "controlled failure",
        });
      }

      @UseFilters(CustomWsErrorFilter)
      @SubscribeMessage("throw_filtered")
      throwFiltered() {
        throw new CustomWsError("caught-by-custom-filter");
      }

      @SubscribeMessage("binary")
      handleBinary(
        @ConnectedSocket() client: BunWsClient,
        @MessageBody() bytes: Uint8Array,
      ) {
        client.emit("binary_ack", { len: bytes.byteLength, first: bytes[0] });
      }
    }

    @Controller("/health")
    class HealthController {
      @Get()
      ok() {
        return { status: "ok" };
      }
    }

    @Module({
      imports: [WebSocketModule.forRoot()],
      controllers: [HealthController],
      providers: [ChatGateway],
    })
    class AppModule {}

    const app = await BunestFactory.create(AppModule, { logger: false });
    const wsAdapter: BunWebSocketAdapter = await WebSocketModule.attach(app);
    const info = await app.listen({ port: 0, hostname: "127.0.0.1" });
    cleanups.push(async () => {
      await wsAdapter.closeAll();
      await app.getHttpAdapter().close(true);
    });

    const httpBase = `http://127.0.0.1:${info.port}`;
    const wsBase = `ws://127.0.0.1:${info.port}`;

    // Regular HTTP endpoint coexists cleanly on the same Bun.serve instance
    const healthRes = await fetch(`${httpBase}/health`);
    expect(healthRes.status).toBe(200);
    expect(await healthRes.json()).toEqual({ status: "ok" });

    // Handshake auth rejection (401 BEFORE upgrading!)
    const unauthRes = await fetch(`${httpBase}/ws/chat?token=bad`, {
      headers: {
        Upgrade: "websocket",
        Connection: "Upgrade",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version": "13",
      },
    });
    expect(unauthRes.status).toBe(401);
    const unauthJson = (await unauthRes.json()) as { message: string };
    expect(unauthJson.message).toBe("Invalid WS token");

    // CORS disallowed origin rejected with 403 BEFORE upgrading
    const badOriginRes = await fetch(`${httpBase}/ws/chat?token=alice-admin`, {
      headers: {
        Origin: "https://evil.attacker",
        Upgrade: "websocket",
        Connection: "Upgrade",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version": "13",
      },
    });
    expect(badOriginRes.status).toBe(403);

    // Connect two authenticated clients: alice (admin) & bob (member)
    const alice = await connectWs(`${wsBase}/ws/chat?token=alice-admin`);
    const bob = await connectWs(`${wsBase}/ws/chat?token=bob-member`);
    cleanups.push(async () => {
      alice.close();
      bob.close();
    });

    const aliceWelcome = await alice.waitFor((m) => m.event === "welcome");
    const bobWelcome = await bob.waitFor((m) => m.event === "welcome");
    expect((aliceWelcome.data as { user: string }).user).toBe("alice");
    expect((bobWelcome.data as { user: string }).user).toBe("bob");
    expect(lifecycleEvents).toContain("init:/ws/chat");
    expect(lifecycleEvents).toContain("connect:alice");
    expect(lifecycleEvents).toContain("connect:bob");

    // Request/reply with WsResponse + ack id
    alice.sendEvent("ping", { seq: 7 }, "ack-7");
    const pong = await alice.waitFor(
      (m) => m.event === "pong" && m.id === "ack-7",
    );
    expect(pong.data).toEqual({ pong: 7 });

    // Parameter pipe (ParseIntPipe) on keyed @MessageBody("value")
    alice.sendEvent("double", { value: "21" }, "dbl-1");
    const doubled = await alice.waitFor(
      (m) => m.event === "double" && m.id === "dbl-1",
    );
    expect(doubled.data).toEqual({ doubled: 42 });

    // Rooms: both join "lobby"
    alice.sendEvent("join_room", { room: "lobby" }, "j1");
    await alice.waitFor((m) => m.id === "j1");
    bob.sendEvent("join_room", { room: "lobby" }, "j2");
    const join2 = await bob.waitFor((m) => m.id === "j2");
    expect(join2.data).toEqual({ joined: "lobby", count: 2 });

    // client.to("lobby").emit() -> delivers ONLY to bob (excludes sender alice!)
    alice.sendEvent("room_whisper", { room: "lobby", msg: "hello-others" });
    const bobWhisper = await bob.waitFor((m) => m.event === "room_msg");
    expect(bobWhisper.data).toEqual({ from: "alice", msg: "hello-others" });

    // server.to("lobby").emit() -> delivers to BOTH alice AND bob (includes sender!)
    alice.sendEvent("room_announce", { room: "lobby", msg: "global-notice" });
    const [aliceAnnounce, bobAnnounce] = await Promise.all([
      alice.waitFor((m) => m.event === "room_announcement"),
      bob.waitFor((m) => m.event === "room_announcement"),
    ]);
    expect(aliceAnnounce.data).toEqual({ msg: "global-notice" });
    expect(bobAnnounce.data).toEqual({ msg: "global-notice" });

    // Verify alice NEVER received her own room_whisper!
    expect(alice.messages.some((m) => m.event === "room_msg")).toBe(false);

    // Leave room updates subscriberCount
    bob.sendEvent("leave_room", { room: "lobby" }, "l1");
    const leftRes = await bob.waitFor((m) => m.id === "l1");
    expect(leftRes.data).toEqual({ left: "lobby", count: 1 });

    // Guard + Interceptor: alice (admin) succeeds wrapped; bob (member) gets FORBIDDEN error frame without disconnect
    alice.sendEvent("admin_only", {}, "adm-ok");
    const admOk = await alice.waitFor((m) => m.id === "adm-ok");
    expect(admOk.data).toEqual({
      wrapped: true,
      payload: { secretBy: "alice" },
    });

    bob.sendEvent("admin_only", {}, "adm-deny");
    const admDeny = await bob.waitFor((m) => m.id === "adm-deny");
    expect(admDeny.event).toBe("error");
    expect(admDeny.data).toMatchObject({ status: "error", code: "FORBIDDEN" });

    // ValidationPipe on @MessageBody() DTO: invalid fails with 400 error frame; valid succeeds
    bob.sendEvent("validated_msg", { text: "x" }, "val-bad");
    const valBad = await bob.waitFor((m) => m.id === "val-bad");
    expect(valBad.event).toBe("error");
    expect(valBad.data).toMatchObject({ status: "error", statusCode: 400 });

    bob.sendEvent("validated_msg", { text: "valid text" }, "val-ok");
    const valOk = await bob.waitFor((m) => m.id === "val-ok");
    expect(valOk.data).toEqual({ accepted: "valid text" });

    // WsException & custom @UseFilters
    alice.sendEvent("throw_ws", {}, "err-ws");
    const errWs = await alice.waitFor((m) => m.id === "err-ws");
    expect(errWs.event).toBe("error");
    expect(errWs.data).toMatchObject({
      status: "error",
      code: "E_CUSTOM",
      message: "controlled failure",
    });

    alice.sendEvent("throw_filtered", {}, "err-filt");
    const errFilt = await alice.waitFor((m) => m.id === "err-filt");
    expect(errFilt.event).toBe("custom_error");
    expect(errFilt.data).toEqual({ reason: "caught-by-custom-filter" });

    // Binary frame routing
    alice.ws.send(new Uint8Array([99, 100, 101]));
    const binAck = await alice.waitFor((m) => m.event === "binary_ack");
    expect(binAck.data).toEqual({ len: 3, first: 99 });

    // Graceful teardown disconnects open clients cleanly with close code 1001
    const aliceClosePromise = alice.waitForClose();
    const bobClosePromise = bob.waitForClose();
    await wsAdapter.closeAll();

    const [aliceClose, bobClose] = await Promise.all([
      aliceClosePromise,
      bobClosePromise,
    ]);
    expect(aliceClose.code).toBe(1001);
    expect(bobClose.code).toBe(1001);

    await new Promise((r) => setTimeout(r, 30));
    expect(lifecycleEvents).toContain("disconnect:alice");
    expect(lifecycleEvents).toContain("disconnect:bob");
  });

  test("isolates multiple gateways on one Bun.serve(), distinguishes client.broadcast vs server.emit, handles invalid JSON without disconnect, and tears down on app.close()", async () => {
    const disconnectedRooms: string[][] = [];

    @WebSocketGateway({ path: "/ws/alpha" })
    class AlphaGateway implements OnGatewayDisconnect {
      @WebSocketServer()
      server!: BunWsServer;

      handleDisconnect(client: BunWsClient) {
        disconnectedRooms.push([...client.rooms]);
      }

      @SubscribeMessage("join")
      join(
        @ConnectedSocket() c: BunWsClient,
        @MessageBody("room") room: string,
      ) {
        c.join(room);
        return { ok: true };
      }

      @SubscribeMessage("bcast")
      bcast(
        @ConnectedSocket() c: BunWsClient,
        @MessageBody("msg") msg: string,
      ) {
        c.broadcast("bcast_evt", { msg });
      }

      @SubscribeMessage("emit_all")
      emitAll(@MessageBody("msg") msg: string) {
        this.server.emit("all_evt", { msg });
      }

      @SubscribeMessage("room_emit")
      roomEmit(@MessageBody() payload: { room: string; msg: string }) {
        this.server.to(payload.room).emit("shared_room_evt", {
          gw: "alpha",
          msg: payload.msg,
        });
      }
    }

    @WebSocketGateway({ path: "/ws/beta" })
    class BetaGateway {
      @WebSocketServer()
      server!: BunWsServer;

      @SubscribeMessage("join")
      join(
        @ConnectedSocket() c: BunWsClient,
        @MessageBody("room") room: string,
      ) {
        c.join(room);
        return { ok: true };
      }
    }

    @Module({
      imports: [WebSocketModule.forRoot()],
      providers: [AlphaGateway, BetaGateway],
    })
    class MultiGatewayModule {}

    const app = await BunestFactory.create(MultiGatewayModule, {
      logger: false,
    });
    await WebSocketModule.attach(app);
    const info = await app.listen({ port: 0, hostname: "127.0.0.1" });
    cleanups.push(async () => {
      await app.close();
    });

    const base = `ws://127.0.0.1:${info.port}`;
    const a1 = await connectWs(`${base}/ws/alpha`);
    const a2 = await connectWs(`${base}/ws/alpha`);
    const b1 = await connectWs(`${base}/ws/beta`);
    cleanups.push(async () => {
      a1.close();
      a2.close();
      b1.close();
    });

    // Both gateways join room named "general" -> topics MUST be isolated per gateway!
    a1.sendEvent("join", { room: "general" }, "j-a1");
    b1.sendEvent("join", { room: "general" }, "j-b1");
    await Promise.all([
      a1.waitFor((m) => m.id === "j-a1"),
      b1.waitFor((m) => m.id === "j-b1"),
    ]);

    a1.sendEvent("room_emit", { room: "general", msg: "alpha-only" });
    const a1RoomMsg = await a1.waitFor((m) => m.event === "shared_room_evt");
    expect(a1RoomMsg.data).toEqual({ gw: "alpha", msg: "alpha-only" });

    // client.broadcast excludes sender (a2 gets it, a1 does NOT); server.emit includes both
    a1.sendEvent("bcast", { msg: "others-only" });
    const a2Bcast = await a2.waitFor((m) => m.event === "bcast_evt");
    expect(a2Bcast.data).toEqual({ msg: "others-only" });

    a1.sendEvent("emit_all", { msg: "everyone" });
    const [a1All, a2All] = await Promise.all([
      a1.waitFor((m) => m.event === "all_evt"),
      a2.waitFor((m) => m.event === "all_evt"),
    ]);
    expect(a1All.data).toEqual({ msg: "everyone" });
    expect(a2All.data).toEqual({ msg: "everyone" });
    expect(a1.messages.some((m) => m.event === "bcast_evt")).toBe(false);
    expect(b1.messages.some((m) => m.event === "shared_room_evt")).toBe(false);

    // Invalid JSON emits error frame without tearing down the socket
    a1.ws.send("<<<not valid json>>>");
    const parseErr = await a1.waitFor((m) => m.event === "error");
    expect(parseErr.data).toMatchObject({ status: "error" });

    // Socket still alive after parse error
    a1.sendEvent("join", { room: "after-error" }, "still-alive");
    expect((await a1.waitFor((m) => m.id === "still-alive")).data).toEqual({
      ok: true,
    });

    // Disconnect a1 -> handleDisconnect can still inspect client.rooms before cleanup
    const a1Closed = a1.waitForClose();
    a1.close();
    await a1Closed;
    await new Promise((r) => setTimeout(r, 30));
    expect(disconnectedRooms.some((rooms) => rooms.includes("general"))).toBe(
      true,
    );

    // Full app.close() cleanly disconnects remaining connected clients
    const a2Closed = a2.waitForClose();
    const b1Closed = b1.waitForClose();
    await app.close();
    await Promise.all([a2Closed, b1Closed]);
  });
});
