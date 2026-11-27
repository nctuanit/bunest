import { afterEach, describe, expect, test } from "bun:test";
import {
  APP_FILTER,
  type ArgumentsHost,
  type BunestInterceptor,
  type CallHandler,
  type CanActivate,
  Catch,
  type ExceptionFilter,
  type ExecutionContext,
  Inject,
  Injectable,
  Module,
  ParseIntPipe,
  type PipeTransform,
  Scope,
  type StandardSchemaV1,
  UseFilters,
  UseGuards,
  UseInterceptors,
  UsePipes,
} from "../../src/common/index";
import { ContextStorage } from "../../src/common/runtime/async-context";
import { BunestFactory } from "../../src/index";
import {
  Ack,
  BunWebSocketAdapter,
  type BunWsClient,
  compileWsPathPattern,
  ConnectedSocket,
  isDynamicWsPath,
  matchWsPath,
  MessageBody,
  type OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketModule,
  WsAdapter,
  type WsAckCallback,
  WsException,
  type WsMessageFrame,
  WsParam,
} from "../../src/ws/index";

interface TestWsClient {
  readonly ws: WebSocket;
  nextMessage(
    predicate?: (msg: WsMessageFrame) => boolean,
    timeoutMs?: number,
  ): Promise<WsMessageFrame>;
  waitForClose(timeoutMs?: number): Promise<{ code: number; reason: string }>;
  sendEvent(event: string, data?: unknown, id?: string): void;
  close(): void;
}

function connectWs(url: string): Promise<TestWsClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const queue: WsMessageFrame[] = [];
    const waiters: Array<{
      predicate?: (m: WsMessageFrame) => boolean;
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
        nextMessage(predicate, timeoutMs = 3000) {
          const idx = queue.findIndex((m) => !predicate || predicate(m));
          if (idx >= 0) {
            return Promise.resolve(queue.splice(idx, 1)[0]!);
          }
          return new Promise<WsMessageFrame>((res, rej) => {
            const entry = {
              predicate,
              resolve: (m: WsMessageFrame) => {
                clearTimeout(timer);
                res(m);
              },
            };
            const timer = setTimeout(() => {
              const i = waiters.indexOf(entry);
              if (i >= 0) waiters.splice(i, 1);
              rej(new Error(`Timed out waiting for WS frame on ${url}`));
            }, timeoutMs);
            waiters.push(entry);
          });
        },
        waitForClose(timeoutMs = 3000) {
          if (closedInfo) {
            return Promise.resolve(closedInfo);
          }
          return new Promise((res, rej) => {
            const timer = setTimeout(
              () => rej(new Error(`Timed out waiting for WS close on ${url}`)),
              timeoutMs,
            );
            closeWaiters.push((info) => {
              clearTimeout(timer);
              res(info);
            });
          });
        },
        sendEvent(event, data, id) {
          const frame: Record<string, unknown> = { event };
          if (data !== undefined) frame.data = data;
          if (id !== undefined) frame.id = id;
          ws.send(JSON.stringify(frame));
        },
        close() {
          if (
            ws.readyState === WebSocket.OPEN ||
            ws.readyState === WebSocket.CONNECTING
          ) {
            ws.close();
          }
        },
      });
    });

    ws.addEventListener("message", (ev) => {
      if (typeof ev.data !== "string") return;
      const parsed = JSON.parse(ev.data) as WsMessageFrame;
      for (let i = 0; i < waiters.length; i++) {
        const w = waiters[i]!;
        if (!w.predicate || w.predicate(parsed)) {
          waiters.splice(i, 1);
          w.resolve(parsed);
          return;
        }
      }
      queue.push(parsed);
    });

    ws.addEventListener("close", (ev) => {
      closedInfo = { code: ev.code, reason: ev.reason };
      while (closeWaiters.length > 0) {
        closeWaiters.shift()!(closedInfo);
      }
    });

    ws.addEventListener("error", () => {
      clearTimeout(openTimer);
      reject(new Error(`WebSocket connection error for ${url}`));
    });
  });
}

describe("WebSocket Wave 1 Features", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop()!;
      try {
        await fn();
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 1. Dynamic path parameters & @WsParam()
  // ───────────────────────────────────────────────────────────────────────────
  describe("Feature 1: Dynamic path parameters & @WsParam()", () => {
    test("compileWsPathPattern & matchWsPath support static, named, regex, optional, wildcard, and URL-decoded params", () => {
      expect(isDynamicWsPath("/ws/chat")).toBe(false);
      expect(isDynamicWsPath("/chat/:roomId/socket")).toBe(true);
      expect(isDynamicWsPath("/files/*path")).toBe(true);

      const staticPat = compileWsPathPattern("/ws/chat");
      expect(staticPat.isDynamic).toBe(false);
      expect(matchWsPath(staticPat, "/ws/chat")).toEqual({});
      expect(matchWsPath(staticPat, "/ws/other")).toBeNull();

      const dynPat = compileWsPathPattern("/chat/:roomId/socket");
      expect(dynPat.isDynamic).toBe(true);
      expect(dynPat.paramNames).toEqual(["roomId"]);
      const matched = matchWsPath(dynPat, "/chat/room%2042%2Falpha/socket");
      expect(matched).toEqual({ roomId: "room 42/alpha" });
      expect(Object.isFrozen(matched)).toBe(true);
      expect(matchWsPath(dynPat, "/chat/42")).toBeNull();
      expect(matchWsPath(dynPat, "/chat/42/socket/extra")).toBeNull();

      // Malformed percent encoding falls back safely without throwing
      expect(matchWsPath(dynPat, "/chat/%E0%A4%A/socket")).toEqual({
        roomId: "%E0%A4%A",
      });

      // Regex-constrained param
      const numericPat = compileWsPathPattern("/rooms/:id([0-9]+)");
      expect(matchWsPath(numericPat, "/rooms/123")).toEqual({ id: "123" });
      expect(matchWsPath(numericPat, "/rooms/abc")).toBeNull();

      // Optional param
      const optPat = compileWsPathPattern("/rooms/:roomId?");
      expect(matchWsPath(optPat, "/rooms")).toEqual({});
      expect(matchWsPath(optPat, "/rooms/lobby")).toEqual({ roomId: "lobby" });

      // Wildcard param
      const wildPat = compileWsPathPattern("/files/*filepath");
      expect(matchWsPath(wildPat, "/files/docs/hello%20world.txt")).toEqual({
        filepath: "docs/hello world.txt",
      });
    });

    test("extracts URL-decoded params onto client.params and @WsParam() with pipes & Standard Schema (BunestApplication)", async () => {
      const connectionParams: Array<Readonly<Record<string, string>>> = [];

      const positiveIntSchema: StandardSchemaV1<unknown, number> = {
        "~standard": {
          version: 1,
          vendor: "test",
          validate(value) {
            const num = Number(value);
            if (!Number.isInteger(num) || num <= 0) {
              return {
                issues: [{ message: "roomId must be a positive integer" }],
              };
            }
            return { value: num };
          },
        },
      };

      @WebSocketGateway({ path: "/chat/:roomId/socket" })
      class ChatRoomGateway implements OnGatewayConnection {
        handleConnection(client: BunWsClient): void {
          connectionParams.push(client.params);
        }

        @SubscribeMessage("info")
        handleInfo(
          @WsParam() allParams: Readonly<Record<string, string>>,
          @WsParam("roomId") roomId: string,
          @ConnectedSocket() client: BunWsClient,
        ) {
          return {
            allParams,
            roomId,
            fromClient: client.params.roomId,
            frozen: Object.isFrozen(allParams),
          };
        }

        @SubscribeMessage("numeric")
        handleNumeric(@WsParam("roomId", ParseIntPipe) roomId: number) {
          return { roomId, type: typeof roomId };
        }

        @SubscribeMessage("schema")
        handleSchema(
          @WsParam("roomId", { schema: positiveIntSchema }) roomId: number,
        ) {
          return { validatedRoomId: roomId };
        }
      }

      @WebSocketGateway("/orgs/:orgId/rooms/:roomId")
      class ShorthandGateway {
        @SubscribeMessage("who")
        handleWho(
          @WsParam("orgId") orgId: string,
          @WsParam("roomId") roomId: string,
        ) {
          return { orgId, roomId };
        }
      }

      @Module({
        imports: [WebSocketModule.forRoot()],
        providers: [ChatRoomGateway, ShorthandGateway],
      })
      class AppModule {}

      const app = await BunestFactory.create(AppModule);
      await WebSocketModule.attach(app);
      const info = await app.listen({ port: 0, hostname: "127.0.0.1" });
      cleanups.push(async () => {
        await app.close();
      });

      const wsBase = info.url.replace(/^http/, "ws").replace(/\/$/, "");

      // 1. Dynamic path with URL-encoded roomId
      const c1 = await connectWs(`${wsBase}/chat/room%2042/socket`);
      cleanups.push(() => c1.close());

      c1.sendEvent("info", {}, "m1");
      const infoRes = await c1.nextMessage((m) => m.id === "m1");
      expect(infoRes.data).toEqual({
        allParams: { roomId: "room 42" },
        roomId: "room 42",
        fromClient: "room 42",
        frozen: true,
      });
      expect(connectionParams[0]).toEqual({ roomId: "room 42" });

      // Invalid Standard Schema on non-numeric roomId emits structured error frame
      c1.sendEvent("schema", {}, "m-bad");
      const badRes = await c1.nextMessage((m) => m.id === "m-bad");
      expect(badRes.event).toBe("error");
      expect((badRes.data as Record<string, unknown>).statusCode).toBe(400);

      // 2. Numeric roomId with ParseIntPipe & Standard Schema
      const c2 = await connectWs(`${wsBase}/chat/77/socket`);
      cleanups.push(() => c2.close());

      c2.sendEvent("numeric", {}, "m2");
      const numRes = await c2.nextMessage((m) => m.id === "m2");
      expect(numRes.data).toEqual({ roomId: 77, type: "number" });

      c2.sendEvent("schema", {}, "m3");
      const schemaRes = await c2.nextMessage((m) => m.id === "m3");
      expect(schemaRes.data).toEqual({ validatedRoomId: 77 });

      // 3. String shorthand @WebSocketGateway('/orgs/:orgId/rooms/:roomId')
      const c3 = await connectWs(`${wsBase}/orgs/acme%20corp/rooms/eng`);
      cleanups.push(() => c3.close());

      c3.sendEvent("who", {}, "m4");
      const whoRes = await c3.nextMessage((m) => m.id === "m4");
      expect(whoRes.data).toEqual({ orgId: "acme corp", roomId: "eng" });
    });

    test("preserves registration-order precedence for overlapping dynamic patterns", async () => {
      @WebSocketGateway({ path: "/items/:id" })
      class FirstDynamicGateway {
        @SubscribeMessage("which")
        which(@WsParam("id") id: string) {
          return { gw: "first-dynamic", id };
        }
      }

      @WebSocketGateway({ path: "/items/special" })
      class SecondStaticGateway {
        @SubscribeMessage("which")
        which() {
          return { gw: "second-static" };
        }
      }

      @WebSocketGateway({ path: "/chat/vip/socket" })
      class VipStaticFirstGateway {
        @SubscribeMessage("which")
        which() {
          return { gw: "vip-static-first" };
        }
      }

      @WebSocketGateway({ path: "/chat/:roomId/socket" })
      class RoomDynamicSecondGateway {
        @SubscribeMessage("which")
        which(@WsParam("roomId") roomId: string) {
          return { gw: "room-dynamic-second", roomId };
        }
      }

      const adapter = new BunWebSocketAdapter();
      await adapter.registerGateway(new FirstDynamicGateway());
      await adapter.registerGateway(new SecondStaticGateway());
      await adapter.registerGateway(new VipStaticFirstGateway());
      await adapter.registerGateway(new RoomDynamicSecondGateway());

      const info = await adapter.listen({ port: 0, hostname: "127.0.0.1" });
      cleanups.push(() => adapter.closeAll());

      const wsBase = info.url.replace(/^http/, "ws").replace(/\/$/, "");

      // First-registered dynamic pattern wins over later-registered overlapping static pattern
      const c1 = await connectWs(`${wsBase}/items/special`);
      cleanups.push(() => c1.close());
      c1.sendEvent("which", {}, "1");
      const r1 = await c1.nextMessage((m) => m.id === "1");
      expect(r1.data).toEqual({ gw: "first-dynamic", id: "special" });

      // First-registered static pattern wins over later-registered overlapping dynamic pattern
      const c2 = await connectWs(`${wsBase}/chat/vip/socket`);
      cleanups.push(() => c2.close());
      c2.sendEvent("which", {}, "2");
      const r2 = await c2.nextMessage((m) => m.id === "2");
      expect(r2.data).toEqual({ gw: "vip-static-first" });

      // Non-vip falls through to second-registered dynamic pattern
      const c3 = await connectWs(`${wsBase}/chat/general/socket`);
      cleanups.push(() => c3.close());
      c3.sendEvent("which", {}, "3");
      const r3 = await c3.nextMessage((m) => m.id === "3");
      expect(r3.data).toEqual({ gw: "room-dynamic-second", roomId: "general" });
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Opt-in graceful shutdown
  // ───────────────────────────────────────────────────────────────────────────
  describe("Feature 2: Opt-in graceful shutdown", () => {
    test("drains in-flight handlers and deferred @Ack() replies, rejects new upgrades/messages, and sends 1001 Going Away", async () => {
      let ignoredMessageReceived = false;
      let slowStartedResolve!: () => void;
      const slowStarted = new Promise<void>((r) => {
        slowStartedResolve = r;
      });
      let ackStartedResolve!: () => void;
      const ackStarted = new Promise<void>((r) => {
        ackStartedResolve = r;
      });

      @WebSocketGateway({ path: "/ws/drain" })
      class DrainGateway {
        @SubscribeMessage("slow")
        async handleSlow(@MessageBody() data: { val: number }) {
          slowStartedResolve();
          await new Promise((r) => setTimeout(r, 80));
          return { done: data.val };
        }

        @SubscribeMessage("deferred-ack")
        handleDeferredAck(
          @MessageBody() data: { tag: string },
          @Ack() ack: WsAckCallback,
        ): void {
          ackStartedResolve();
          setTimeout(() => {
            ack({ acked: data.tag });
          }, 80);
        }

        @SubscribeMessage("after-close")
        handleAfterClose() {
          ignoredMessageReceived = true;
          return { shouldNotRun: true };
        }
      }

      const adapter = new WsAdapter(undefined, {
        gracefulShutdown: true,
        gracePeriod: 2000,
      });
      await adapter.registerGateway(new DrainGateway());
      const info = await adapter.listen({ port: 0, hostname: "127.0.0.1" });
      cleanups.push(() => adapter.closeAll());

      const wsBase = info.url.replace(/^http/, "ws").replace(/\/$/, "");
      const httpBase = info.url.replace(/\/$/, "");

      const client = await connectWs(`${wsBase}/ws/drain`);
      cleanups.push(() => client.close());

      // Kick off an in-flight async handler AND a deferred @Ack() handler
      client.sendEvent("slow", { val: 42 }, "slow-1");
      client.sendEvent("deferred-ack", { tag: "hello" }, "ack-1");
      await Promise.all([slowStarted, ackStarted]);

      // Start graceful shutdown while both are in-flight
      const closePromise = client.waitForClose();
      const shutdownPromise = adapter.closeAll();

      // New HTTP upgrade must be rejected with 503 during shutdown
      const upgradeRes = await fetch(`${httpBase}/ws/drain`, {
        headers: {
          Upgrade: "websocket",
          Connection: "Upgrade",
        },
      });
      expect(upgradeRes.status).toBe(503);

      // New WS messages sent during shutdown must be ignored
      client.sendEvent("after-close", {}, "ignored-1");

      // Both in-flight replies MUST arrive before connection closes
      const slowReply = await client.nextMessage((m) => m.id === "slow-1");
      const ackReply = await client.nextMessage((m) => m.id === "ack-1");
      expect(slowReply.data).toEqual({ done: 42 });
      expect(ackReply.data).toEqual({ acked: "hello" });

      await shutdownPromise;
      const closeInfo = await closePromise;
      expect(closeInfo.code).toBe(1001);
      expect(closeInfo.reason).toBe("Going Away");
      expect(ignoredMessageReceived).toBe(false);
    });

    test("force-closes remaining connections after gracePeriod deadline expires", async () => {
      let stuckStartedResolve!: () => void;
      const stuckStarted = new Promise<void>((r) => {
        stuckStartedResolve = r;
      });
      let releaseStuck!: () => void;
      const stuckGate = new Promise<void>((r) => {
        releaseStuck = r;
      });

      @WebSocketGateway({ path: "/ws/stuck" })
      class StuckGateway {
        @SubscribeMessage("hang")
        async handleHang() {
          stuckStartedResolve();
          await stuckGate;
          return { never: true };
        }
      }

      const adapter = new BunWebSocketAdapter({
        gracefulShutdown: true,
        gracePeriod: 80,
      });
      await adapter.registerGateway(new StuckGateway());
      const info = await adapter.listen({ port: 0, hostname: "127.0.0.1" });
      cleanups.push(async () => {
        releaseStuck();
        await adapter.closeAll();
      });

      const wsBase = info.url.replace(/^http/, "ws").replace(/\/$/, "");
      const client = await connectWs(`${wsBase}/ws/stuck`);
      cleanups.push(() => client.close());

      client.sendEvent("hang", {}, "h1");
      await stuckStarted;

      const closePromise = client.waitForClose();
      const t0 = Date.now();
      await adapter.closeAll();
      const elapsed = Date.now() - t0;

      const closeInfo = await closePromise;
      expect(closeInfo.code).toBe(1001);
      expect(closeInfo.reason).toBe("Going Away");
      expect(elapsed).toBeGreaterThanOrEqual(60);
      expect(elapsed).toBeLessThan(1000);
      releaseStuck();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Global registerPreRequestHook()
  // ───────────────────────────────────────────────────────────────────────────
  describe("Feature 3: Global registerPreRequestHook()", () => {
    test("wraps guards, pipes, interceptors, handler, and exception filters with AsyncLocalStorage context", async () => {
      const als = new ContextStorage<{ traceId: string; event: string }>();
      const traceLog: string[] = [];

      class TraceGuard implements CanActivate {
        canActivate(_ctx: ExecutionContext): boolean {
          traceLog.push(`guard:${als.getStore()?.traceId}`);
          return true;
        }
      }

      class TracePipe implements PipeTransform {
        transform(value: unknown): unknown {
          traceLog.push(`pipe:${als.getStore()?.traceId}`);
          return value;
        }
      }

      class TraceInterceptor implements BunestInterceptor {
        async intercept(
          _ctx: ExecutionContext,
          next: CallHandler,
        ): Promise<unknown> {
          traceLog.push(`interceptor-before:${als.getStore()?.traceId}`);
          const res = await next.handle();
          traceLog.push(`interceptor-after:${als.getStore()?.traceId}`);
          return res;
        }
      }

      @Catch(WsException)
      class TraceFilter implements ExceptionFilter {
        catch(exception: WsException) {
          traceLog.push(`filter:${als.getStore()?.traceId}`);
          return {
            caught: exception.message,
            traceId: als.getStore()?.traceId,
          };
        }
      }

      @WebSocketGateway({ path: "/ws/trace" })
      @UseGuards(TraceGuard)
      @UseInterceptors(TraceInterceptor)
      @UseFilters(TraceFilter)
      class TraceGateway {
        @SubscribeMessage("ok")
        @UsePipes(TracePipe)
        handleOk(@MessageBody() body: { msg: string }) {
          traceLog.push(`handler:${als.getStore()?.traceId}`);
          return { echo: body.msg, traceId: als.getStore()?.traceId };
        }

        @SubscribeMessage("fail")
        handleFail() {
          traceLog.push(`handler-fail:${als.getStore()?.traceId}`);
          throw new WsException("boom");
        }
      }

      const adapter = new BunWebSocketAdapter();
      let seq = 0;

      // 1-arg hook (microservices PreRequestHook style) + 2-arg wrapping ALS hook
      adapter
        .registerPreRequestHook((ctx) => {
          traceLog.push(`pre-1arg:${ctx.event}`);
        })
        .registerPreRequestHook(async (ctx, next) => {
          const traceId = `tr-${++seq}`;
          traceLog.push(`pre-wrap-enter:${traceId}`);
          await als.run({ traceId, event: ctx.event }, async () => {
            await next!();
          });
          traceLog.push(`pre-wrap-exit:${traceId}`);
        });

      await adapter.registerGateway(new TraceGateway());
      const info = await adapter.listen({ port: 0, hostname: "127.0.0.1" });
      cleanups.push(() => adapter.closeAll());

      const wsBase = info.url.replace(/^http/, "ws").replace(/\/$/, "");
      const client = await connectWs(`${wsBase}/ws/trace`);
      cleanups.push(() => client.close());

      client.sendEvent("ok", { msg: "hi" }, "t1");
      const okRes = await client.nextMessage((m) => m.id === "t1");
      expect(okRes.data).toEqual({ echo: "hi", traceId: "tr-1" });
      expect(traceLog).toEqual([
        "pre-1arg:ok",
        "pre-wrap-enter:tr-1",
        "guard:tr-1",
        "interceptor-before:tr-1",
        "pipe:tr-1",
        "handler:tr-1",
        "interceptor-after:tr-1",
        "pre-wrap-exit:tr-1",
      ]);

      traceLog.length = 0;
      client.sendEvent("fail", {}, "t2");
      const failRes = await client.nextMessage((m) => m.id === "t2");
      expect(failRes.event).toBe("error");
      expect(failRes.data).toEqual({ caught: "boom", traceId: "tr-2" });
      expect(traceLog).toEqual([
        "pre-1arg:fail",
        "pre-wrap-enter:tr-2",
        "guard:tr-2",
        "interceptor-before:tr-2",
        "handler-fail:tr-2",
        "filter:tr-2",
        "pre-wrap-exit:tr-2",
      ]);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. APP_FILTER (including Scope.REQUEST global filters)
  // ───────────────────────────────────────────────────────────────────────────
  describe("Feature 4: APP_FILTER (singleton + Scope.REQUEST) in WS exception handling", () => {
    test("appends global APP_FILTER after method/gateway filters and resolves Scope.REQUEST filters per connection", async () => {
      class MethodSpecificError extends Error {}
      class GatewaySpecificError extends Error {}
      class GlobalHandledError extends Error {}

      @Catch(MethodSpecificError)
      class MethodFilter implements ExceptionFilter {
        catch(err: MethodSpecificError) {
          return { source: "method", message: err.message };
        }
      }

      @Catch(GatewaySpecificError)
      class GatewayFilter implements ExceptionFilter {
        catch(err: GatewaySpecificError) {
          return { source: "gateway", message: err.message };
        }
      }

      let requestFilterInstances = 0;

      @Injectable({ scope: Scope.REQUEST })
      class RequestScopedTracker {
        readonly instanceId = ++requestFilterInstances;
      }

      @Catch(GlobalHandledError)
      @Injectable({ scope: Scope.REQUEST })
      class RequestScopedGlobalWsFilter implements ExceptionFilter {
        constructor(
          @Inject(RequestScopedTracker)
          private readonly tracker: RequestScopedTracker,
        ) {}

        catch(err: GlobalHandledError, host: ArgumentsHost) {
          const client = host.switchToWs().getClient<BunWsClient>();
          return {
            source: "global-request-scoped",
            message: err.message,
            filterInstanceId: this.tracker.instanceId,
            clientId: client.id,
          };
        }
      }

      @Catch()
      @Injectable()
      class CatchAllGlobalWsFilter implements ExceptionFilter {
        catch(err: unknown) {
          return {
            source: "global-singleton-catchall",
            message: err instanceof Error ? err.message : String(err),
          };
        }
      }

      @WebSocketGateway({ path: "/ws/filters" })
      @UseFilters(GatewayFilter)
      class FilterGateway {
        @SubscribeMessage("throw-method")
        @UseFilters(MethodFilter)
        throwMethod() {
          throw new MethodSpecificError("method-err");
        }

        @SubscribeMessage("throw-gateway")
        @UseFilters(MethodFilter)
        throwGateway() {
          throw new GatewaySpecificError("gateway-err");
        }

        @SubscribeMessage("throw-global-req")
        @UseFilters(MethodFilter)
        throwGlobalReq() {
          throw new GlobalHandledError("global-req-err");
        }

        @SubscribeMessage("throw-catchall")
        throwCatchAll() {
          throw new Error("catchall-err");
        }
      }

      @Module({
        imports: [WebSocketModule.forRoot()],
        providers: [
          RequestScopedTracker,
          FilterGateway,
          {
            provide: APP_FILTER,
            useClass: RequestScopedGlobalWsFilter,
          },
          {
            provide: APP_FILTER,
            useClass: CatchAllGlobalWsFilter,
          },
        ],
      })
      class FilterAppModule {}

      const app = await BunestFactory.create(FilterAppModule);
      await WebSocketModule.attach(app);
      const info = await app.listen({ port: 0, hostname: "127.0.0.1" });
      cleanups.push(() => app.close());

      const wsBase = info.url.replace(/^http/, "ws").replace(/\/$/, "");
      const c1 = await connectWs(`${wsBase}/ws/filters`);
      const c2 = await connectWs(`${wsBase}/ws/filters`);
      cleanups.push(() => {
        c1.close();
        c2.close();
      });

      // Precedence: Method -> Gateway -> Global (Request-scoped) -> Global (Singleton catch-all)
      c1.sendEvent("throw-method", {}, "f1");
      const r1 = await c1.nextMessage((m) => m.id === "f1");
      expect(r1.data).toEqual({ source: "method", message: "method-err" });

      c1.sendEvent("throw-gateway", {}, "f2");
      const r2 = await c1.nextMessage((m) => m.id === "f2");
      expect(r2.data).toEqual({ source: "gateway", message: "gateway-err" });

      c1.sendEvent("throw-global-req", {}, "f3");
      const r3 = await c1.nextMessage((m) => m.id === "f3");
      const d3 = r3.data as {
        source: string;
        message: string;
        filterInstanceId: number;
        clientId: string;
      };
      expect(d3.source).toBe("global-request-scoped");
      expect(d3.message).toBe("global-req-err");

      // Same connection reuses its cached RequestContainer filter instance
      c1.sendEvent("throw-global-req", {}, "f3b");
      const r3b = await c1.nextMessage((m) => m.id === "f3b");
      const d3b = r3b.data as { filterInstanceId: number; clientId: string };
      expect(d3b.filterInstanceId).toBe(d3.filterInstanceId);
      expect(d3b.clientId).toBe(d3.clientId);

      // Second connection gets a distinct Scope.REQUEST filter instance
      c2.sendEvent("throw-global-req", {}, "f4");
      const r4 = await c2.nextMessage((m) => m.id === "f4");
      const d4 = r4.data as {
        source: string;
        filterInstanceId: number;
        clientId: string;
      };
      expect(d4.source).toBe("global-request-scoped");
      expect(d4.filterInstanceId).not.toBe(d3.filterInstanceId);
      expect(d4.clientId).not.toBe(d3.clientId);

      // Catch-all singleton APP_FILTER catches unmatched errors
      c1.sendEvent("throw-catchall", {}, "f5");
      const r5 = await c1.nextMessage((m) => m.id === "f5");
      expect(r5.data).toEqual({
        source: "global-singleton-catchall",
        message: "catchall-err",
      });
    });
  });
});
