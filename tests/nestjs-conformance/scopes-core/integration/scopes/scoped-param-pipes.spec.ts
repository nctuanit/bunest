import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  Controller,
  Inject,
  Injectable,
  Module,
  REQUEST,
  Scope,
  UsePipes,
  createParamDecorator,
  type ExecutionContext,
  type PipeTransform,
  type Type,
} from "../../../../../packages/common/src";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  MessagePattern,
  MicroserviceHost,
  MicroserviceModule,
  Payload,
  RpcException,
  TcpClientProxy,
  TcpServer,
  Transport,
} from "../../../../../packages/microservices/src";
import {
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketModule,
} from "../../../../../packages/websockets/src";
import { Test, describeConformance } from "../../../_helpers";

@Injectable({ scope: Scope.REQUEST })
class Seen {
  static n = 0;
  readonly id = ++Seen.n;
}

@Injectable({ scope: Scope.REQUEST })
class CountingPipe implements PipeTransform {
  static n = 0;
  readonly id = ++CountingPipe.n;
  hits = 0;

  constructor(
    @Inject(REQUEST) private readonly ctx: any,
    private readonly seen: Seen,
  ) {}

  transform(value: { label: string }) {
    return {
      label: value.label,
      pipeId: this.id,
      hits: ++this.hits,
      seenId: this.seen?.id,
      data: this.ctx?.getData?.() ?? this.ctx?.data,
    };
  }
}

@Injectable({ scope: Scope.REQUEST })
class RejectingPipe implements PipeTransform {
  transform = (value: { ok: boolean }) => {
    if (!value.ok) {
      throw new RpcException("rejected");
    }
    return value;
  };
}

@Injectable()
class SuffixPipe implements PipeTransform {
  static n = 0;

  constructor() {
    SuffixPipe.n++;
  }

  transform(value: { label: string }) {
    return { label: value.label, suffix: "ok" };
  }
}

const instancePipe = {
  hits: 0,
  transform(value: { label: string }) {
    return { label: value.label, inst: ++this.hits };
  },
};

@Injectable({ scope: Scope.REQUEST })
class MethodPipe implements PipeTransform {
  static n = 0;
  readonly id = ++MethodPipe.n;

  constructor(@Inject(REQUEST) private readonly ctx: any) {}

  transform(value: { label: string }) {
    return {
      label: value.label,
      methodId: this.id,
      data: this.ctx?.getData?.() ?? this.ctx?.data,
    };
  }
}

const Label = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) =>
    ctx.switchToRpc().getData<{ label: string }>().label,
);

@Injectable({ scope: Scope.REQUEST })
class PatternPipe implements PipeTransform {
  static n = 0;
  readonly id = ++PatternPipe.n;

  constructor(@Inject(REQUEST) private readonly ctx: any) {}

  transform(label: string) {
    return {
      label,
      pipeId: this.id,
      pattern: this.ctx?.getPattern?.() ?? this.ctx?.pattern,
    };
  }
}

let releaseGate: () => void;
let markEntered: () => void;
let gate: Promise<void>;
let entered: Promise<void>;

@Injectable({ scope: Scope.REQUEST })
class GatedPipe implements PipeTransform {
  static n = 0;
  readonly id = ++GatedPipe.n;

  constructor(@Inject(REQUEST) private readonly ctx: any) {}

  async transform(value: { label: string }) {
    if (value.label === "hold") {
      markEntered();
      await gate;
    }
    return {
      label: value.label,
      pipeId: this.id,
      data: this.ctx?.getData?.() ?? this.ctx?.data,
    };
  }
}

@Injectable({ scope: Scope.TRANSIENT })
class TransientPipe implements PipeTransform {
  static n = 0;
  readonly id = ++TransientPipe.n;
  hits = 0;

  transform(value: { label: string }) {
    return { label: value.label, pipeId: this.id, hits: ++this.hits };
  }
}

@Controller()
class RpcController {
  @MessagePattern("count")
  count(@Payload(CountingPipe) data: unknown) {
    return data;
  }

  @MessagePattern("count-again")
  countAgain(@Payload(CountingPipe) data: unknown) {
    return data;
  }

  @MessagePattern("checked")
  checked(@Payload(RejectingPipe) data: unknown) {
    return data;
  }

  @MessagePattern("suffix")
  suffix(@Payload(SuffixPipe) data: unknown) {
    return data;
  }

  @MessagePattern("instance")
  instance(@Payload(instancePipe) data: unknown) {
    return data;
  }

  @UsePipes(MethodPipe)
  @MessagePattern("method")
  method(@Payload() data: unknown) {
    return data;
  }

  @MessagePattern("gated")
  gated(@Payload(GatedPipe) data: unknown) {
    return data;
  }

  @MessagePattern("custom")
  custom(@Label(undefined, PatternPipe) data: unknown) {
    return data;
  }
}

@Controller()
class TransientController {
  @MessagePattern("transient")
  transient(@Payload(TransientPipe) data: unknown) {
    return data;
  }
}

@Module({ controllers: [RpcController], providers: [Seen] })
class RpcModule {}

@Module({ controllers: [TransientController] })
class TransientModule {}

@Injectable({ scope: Scope.REQUEST })
class SocketPipe implements PipeTransform {
  static n = 0;
  readonly id = ++SocketPipe.n;
  hits = 0;

  constructor(@Inject(REQUEST) private readonly client: { id?: string }) {}

  transform(value: { label: string }) {
    return {
      label: value.label,
      pipeId: this.id,
      hits: ++this.hits,
      clientId: this.client?.id,
    };
  }
}

@WebSocketGateway({ path: "/pipes" })
class PipeGateway {
  @SubscribeMessage("tick")
  tick(@MessageBody(SocketPipe) data: unknown) {
    return { event: "tick", data };
  }
}

@WebSocketGateway({ path: "/pipes" })
class TransientGateway {
  @SubscribeMessage("transient")
  transient(@MessageBody(TransientPipe) data: unknown) {
    return { event: "transient", data };
  }
}

async function createTcpApp(mod: Type<unknown>) {
  const moduleRef = await Test.createTestingModule({
    imports: [
      MicroserviceModule.forRoot({
        transport: Transport.TCP,
        options: { host: "127.0.0.1", port: 0 },
      }),
      mod,
    ],
  }).compile();
  const host = moduleRef.get(MicroserviceHost);
  await host.listen();
  const server = host.getServers()[0] as TcpServer;
  const client = new TcpClientProxy({
    host: "127.0.0.1",
    port: server.port!,
  });
  await client.connect();
  return { host, client, moduleRef };
}

describeConformance(
  "Scoped parameter pipes",
  {
    upstreamPath: "integration/scopes/e2e/scoped-param-pipes.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008", "ADR-012"],
    notes:
      "Adapted from socket.io-client + RxJS ClientProxy to Bunest native WebSocket + Promise TcpClientProxy.",
  },
  () => {
    describe("microservice", () => {
      let host: MicroserviceHost;
      let client: TcpClientProxy;

      beforeAll(async () => {
        SuffixPipe.n = 0;
        instancePipe.hits = 0;
        ({ host, client } = await createTcpApp(RpcModule));
      });

      afterAll(async () => {
        await client?.close();
        await host?.close();
      });

      const send = (pattern: string, data: object): Promise<any> =>
        client.send(pattern, data);

      // BUNEST_BUG: MicroserviceHost.compileHandler() does not create a per-message RequestContainer or register REQUEST (packages/microservices/src/microservice-host.ts:318-395,479-489); throws "Request-scoped token Symbol(bunest:token:request) requested by CountingPipe requires an active RequestContainer".
      it.skip("should build a request-scoped @Payload() pipe for each message", async () => {
        const first = await send("count", { label: "one" });
        const second = await send("count", { label: "two" });

        expect(first).toEqual({
          label: "one",
          pipeId: expect.any(Number),
          hits: 1,
          seenId: expect.any(Number),
          data: { label: "one" },
        });
        expect(second).toEqual({
          label: "two",
          pipeId: expect.any(Number),
          hits: 1,
          seenId: expect.any(Number),
          data: { label: "two" },
        });
        expect(second.pipeId).not.toBe(first.pipeId);
        expect(second.seenId).not.toBe(first.seenId);
      });

      // BUNEST_BUG: MicroserviceHost.compileHandler() does not create a per-message RequestContainer or register REQUEST (packages/microservices/src/microservice-host.ts:318-395,479-489).
      it.skip("should not share a request-scoped pipe between handlers", async () => {
        const first = await send("count", { label: "one" });
        const other = await send("count-again", { label: "two" });

        expect(other).toMatchObject({ hits: 1, data: { label: "two" } });
        expect(other.pipeId).not.toBe(first.pipeId);
      });

      it("should run a request-scoped pipe whose transform is an instance property", async () => {
        await expect(send("checked", { ok: false })).rejects.toThrow(
          /rejected/,
        );
        await expect(send("checked", { ok: true })).resolves.toEqual({
          ok: true,
        });
      });

      // BUNEST_BUG: MicroserviceHost.compileHandler() does not create a per-message RequestContainer or register REQUEST (packages/microservices/src/microservice-host.ts:318-395,479-489).
      it.skip("should keep request-scoped pipes of overlapping messages apart", async () => {
        gate = new Promise((resolve) => (releaseGate = resolve));
        entered = new Promise((resolve) => (markEntered = resolve));

        const held = send("gated", { label: "hold" });
        await entered;
        const next = await send("gated", { label: "next" });
        releaseGate();
        const first = await held;

        expect(first).toEqual({
          label: "hold",
          pipeId: expect.any(Number),
          data: { label: "hold" },
        });
        expect(next).toEqual({
          label: "next",
          pipeId: expect.any(Number),
          data: { label: "next" },
        });
        expect(next.pipeId).not.toBe(first.pipeId);
      });

      // BUNEST_BUG: MicroserviceHost.resolveArgs() only inspects RPC_PARAM_METADATA (@Payload/@Ctx) and ignores createParamDecorator() custom parameter decorators and their pipes (packages/microservices/src/microservice-host.ts:398-455).
      it.skip("should build a request-scoped pipe of a custom decorator for each message", async () => {
        const first = await send("custom", { label: "one" });
        const second = await send("custom", { label: "two" });

        expect(first).toEqual({
          label: "one",
          pipeId: expect.any(Number),
          pattern: "custom",
        });
        expect(second).toEqual({
          label: "two",
          pipeId: expect.any(Number),
          pattern: "custom",
        });
        expect(second.pipeId).not.toBe(first.pipeId);
      });

      // BUNEST_BUG: MicroserviceHost.resolveEnhancer() calls moduleRef.create(cls) on every message for unregistered default-scoped pipe classes without caching (packages/microservices/src/microservice-host.ts:479-489); expected SuffixPipe.n === 1, received 2.
      it.skip("should construct a default-scoped class pipe once", async () => {
        expect(await send("suffix", { label: "one" })).toEqual({
          label: "one",
          suffix: "ok",
        });
        expect(await send("suffix", { label: "two" })).toEqual({
          label: "two",
          suffix: "ok",
        });
        expect(SuffixPipe.n).toBe(1);
      });

      it("should use a pipe instance as passed", async () => {
        expect(await send("instance", { label: "one" })).toEqual({
          label: "one",
          inst: 1,
        });
        expect(await send("instance", { label: "two" })).toEqual({
          label: "two",
          inst: 2,
        });
      });

      // BUNEST_BUG: MicroserviceHost.compileHandler() does not create a per-message RequestContainer or register REQUEST (packages/microservices/src/microservice-host.ts:318-395,479-489).
      it.skip("should build a request-scoped @UsePipes() pipe for each message", async () => {
        const first = await send("method", { label: "one" });
        const second = await send("method", { label: "two" });

        expect(first.data).toEqual({ label: "one" });
        expect(second.data).toEqual({ label: "two" });
        expect(second.methodId).not.toBe(first.methodId);
      });
    });

    describe("transient pipe on a static controller", () => {
      let host: MicroserviceHost;
      let client: TcpClientProxy;

      beforeAll(async () => {
        TransientPipe.n = 0;
        ({ host, client } = await createTcpApp(TransientModule));
      });

      afterAll(async () => {
        await client?.close();
        await host?.close();
      });

      // BUNEST_BUG: MicroserviceHost.resolveEnhancer() re-instantiates Scope.TRANSIENT pipes on every RPC message instead of caching one instance per static controller (packages/microservices/src/microservice-host.ts:479-489); received pipeId=2, hits=1 instead of pipeId=1, hits=2.
      it.skip("should use the instance created for that controller", async () => {
        const first = await client.send<any>("transient", { label: "one" });
        const second = await client.send<any>("transient", { label: "two" });

        expect(first).toEqual({
          label: "one",
          pipeId: expect.any(Number),
          hits: 1,
        });
        expect(second).toEqual({
          label: "two",
          pipeId: first.pipeId,
          hits: 2,
        });
      });
    });

    // BUNEST_BUG: WsGatewayExplorer / BunWebSocketAdapter eagerly resolves @MessageBody(SocketPipe) at gateway registration time without a per-connection RequestContainer (packages/websockets/src/explorer/ws-gateway.explorer.ts:78 & packages/websockets/src/adapter/bun-ws.adapter.ts:355); throws "Request-scoped token Symbol(bunest:token:request) requested by SocketPipe requires an active RequestContainer".
    describe.skip("gateway", () => {
      let app: BunestApplication;
      const sockets: WebSocket[] = [];

      beforeAll(async () => {
        TransientPipe.n = 0;
        const moduleRef = await Test.createTestingModule({
          imports: [WebSocketModule.forRoot()],
          providers: [PipeGateway, TransientGateway],
        }).compile();
        app = moduleRef.createNestApplication({ logger: false });
        await WebSocketModule.attach(app);
        await app.listen(0, "127.0.0.1");
      });

      afterAll(async () => {
        for (const s of sockets) {
          s.close();
        }
        await app?.close();
      });

      const connect = async () => {
        const ws = new WebSocket(
          `${app.getUrl()!.replace("http", "ws")}/pipes`,
        );
        sockets.push(ws);
        await new Promise<void>((resolve, reject) => {
          ws.addEventListener("open", () => resolve(), { once: true });
          ws.addEventListener("error", reject, { once: true });
        });
        return ws;
      };

      const sendWs = async (ws: WebSocket, event: string, label: string) => {
        const reply = new Promise<any>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("WS timeout")),
            2000,
          );
          ws.addEventListener(
            "message",
            (e) => {
              clearTimeout(timer);
              resolve(JSON.parse(String(e.data)));
            },
            { once: true },
          );
        });
        ws.send(JSON.stringify({ event, data: { label } }));
        return (await reply).data;
      };

      it("should use one request-scoped pipe per connection", async () => {
        const a = await connect();
        const b = await connect();
        const a1 = await sendWs(a, "tick", "a1");
        const a2 = await sendWs(a, "tick", "a2");
        const b1 = await sendWs(b, "tick", "b1");

        expect(a1.label).toBe("a1");
        expect(a2.pipeId).toBe(a1.pipeId);
        expect(a2.hits).toBe(2);
        expect(b1.pipeId).not.toBe(a1.pipeId);
      });

      it("should use the transient pipe created for a static gateway", async () => {
        const first = await sendWs(await connect(), "transient", "a");
        const second = await sendWs(await connect(), "transient", "b");

        expect(first).toEqual({
          label: "a",
          pipeId: expect.any(Number),
          hits: 1,
        });
        expect(second).toEqual({
          label: "b",
          pipeId: first.pipeId,
          hits: 2,
        });
      });
    });
  },
);
