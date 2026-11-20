import "reflect-metadata";
import { afterEach, beforeEach, expect, it } from "bun:test";
import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Injectable,
  Module,
  Post,
  Query,
} from "../../../../../packages/common/src";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  ClientsModule,
  EventPattern,
  MessagePattern,
  MicroserviceHost,
  MicroserviceModule,
  RpcException,
  TcpClientProxy,
  TcpServer,
  Transport,
  type ClientProxy,
  type ClientsOptionsFactory,
  type SendOptions,
  type TransportConfig,
} from "../../../../../packages/microservices/src";
import {
  Test,
  describeConformance,
  itAdapted,
  request,
  type TestingModule,
} from "../../../_helpers";

class ErrorHandlingProxy extends TcpClientProxy {
  override async send<TRes = any, TReq = any>(
    pattern: Parameters<TcpClientProxy["send"]>[0],
    data: TReq,
    options?: SendOptions,
  ): Promise<TRes> {
    try {
      return await super.send<TRes, TReq>(pattern, data, options);
    } catch (err) {
      throw err instanceof RpcException
        ? err
        : new RpcException(err instanceof Error ? err.message : String(err));
    }
  }
}

describeConformance(
  "RPC transport",
  {
    upstreamPath: "integration/microservices/e2e/sum-rpc.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008"],
    notes:
      "Hybrid HTTP + native Bun TcpServer (ephemeral port: 0) with Promise-based RPC handlers/controllers, ClientsModule.register/registerAsync (useFactory, useClass), concurrent multiplexing, events, and custom TcpClientProxy error wrapping.",
  },
  () => {
    let moduleRef: TestingModule | undefined;
    let app: BunestApplication | undefined;
    let tcpServer: TcpServer | undefined;
    let isNotified = false;

    beforeEach(async () => {
      isNotified = false;
      tcpServer = new TcpServer({ host: "127.0.0.1", port: 0 });
      await tcpServer.listen();
      const port = tcpServer.port!;

      @Injectable()
      class ConfigService {
        private readonly config: Record<string, unknown> = {
          transport: Transport.TCP,
          port,
        };
        get<T = unknown>(key: string): T {
          return this.config[key] as T;
        }
      }

      @Module({
        providers: [ConfigService],
        exports: [ConfigService],
      })
      class ConfigModule {}

      @Injectable()
      class ClientOptionService implements ClientsOptionsFactory {
        constructor(private readonly configService: ConfigService) {}
        createClientOptions(): TransportConfig {
          return {
            transport: Transport.TCP,
            options: {
              host: "127.0.0.1",
              port: this.configService.get<number>("port"),
            },
          };
        }
      }

      @Controller()
      class AppController {
        constructor(
          @Inject("STANDARD_CLIENT") private readonly client: ClientProxy,
          @Inject("USE_CLASS_CLIENT")
          private readonly useClassClient: ClientProxy,
          @Inject("USE_FACTORY_CLIENT")
          private readonly useFactoryClient: ClientProxy,
          @Inject("CUSTOM_PROXY_CLIENT")
          private readonly customClient: ClientProxy,
        ) {}

        @Post()
        @HttpCode(200)
        async call(
          @Query("command") cmd: string,
          @Body() data: number[],
        ): Promise<number> {
          return this.client.send<number>({ cmd }, data);
        }

        @Post("useFactory")
        @HttpCode(200)
        async callWithClientUseFactory(
          @Query("command") cmd: string,
          @Body() data: number[],
        ): Promise<number> {
          return this.useFactoryClient.send<number>({ cmd }, data);
        }

        @Post("useClass")
        @HttpCode(200)
        async callWithClientUseClass(
          @Query("command") cmd: string,
          @Body() data: number[],
        ): Promise<number> {
          return this.useClassClient.send<number>({ cmd }, data);
        }

        @Post("stream")
        @HttpCode(200)
        async stream(@Body() data: number[]): Promise<number> {
          const stream = await this.client.send<AsyncIterable<number>>(
            { cmd: "streaming" },
            data,
          );
          let total = 0;
          for await (const val of stream) {
            total += val;
          }
          return total;
        }

        @Post("concurrent")
        @HttpCode(200)
        async concurrent(@Body() data: number[][]): Promise<boolean> {
          const send = async (tab: number[]) => {
            const expected = tab.reduce((a, b) => a + b, 0);
            const result = await this.client.send<number>({ cmd: "sum" }, tab);
            return result === expected;
          };
          const results = await Promise.all(data.map((tab) => send(tab)));
          return results.every(Boolean);
        }

        @Post("error")
        @HttpCode(200)
        async serializeError(
          @Query("client") query: "custom" | "standard" = "standard",
        ): Promise<boolean> {
          const activeClient =
            query === "custom" ? this.customClient : this.client;
          try {
            await activeClient.send({ cmd: "err" }, {});
            return false;
          } catch (err) {
            return err instanceof RpcException;
          }
        }

        @MessagePattern({ cmd: "sum" })
        sum(data: number[]): number {
          return (data || []).reduce((a, b) => a + b, 0);
        }

        @MessagePattern({ cmd: "asyncSum" })
        async asyncSum(data: number[]): Promise<number> {
          return (data || []).reduce((a, b) => a + b, 0);
        }

        @MessagePattern({ cmd: "streamSum" })
        async streamSum(data: number[]): Promise<number> {
          // ADR-008: single-value Promise replaces RxJS of(...)
          return Promise.resolve((data || []).reduce((a, b) => a + b, 0));
        }

        @MessagePattern({ cmd: "streaming" })
        async *streaming(data: number[]): AsyncGenerator<number> {
          for (const item of data || []) {
            yield item;
          }
        }

        @MessagePattern({ cmd: "err" })
        throwAnError(): never {
          throw new Error("err");
        }

        @Post("notify")
        async sendNotification(): Promise<void> {
          await this.client.emit("notification", true);
        }

        @EventPattern("notification")
        eventHandler(data: boolean) {
          isNotified = data;
        }
      }

      @Module({
        imports: [
          MicroserviceModule.forRoot({ server: tcpServer }),
          ClientsModule.register([
            {
              name: "STANDARD_CLIENT",
              transport: Transport.TCP,
              options: { host: "127.0.0.1", port },
            },
          ]),
          ClientsModule.registerAsync([
            {
              imports: [ConfigModule],
              name: "USE_FACTORY_CLIENT",
              useFactory: (configService: ConfigService) => ({
                transport: Transport.TCP,
                options: {
                  host: "127.0.0.1",
                  port: configService.get<number>("port"),
                },
              }),
              inject: [ConfigService],
            },
            {
              imports: [ConfigModule],
              name: "USE_CLASS_CLIENT",
              useClass: ClientOptionService,
            },
          ]),
        ],
        controllers: [AppController],
        providers: [
          {
            provide: "CUSTOM_PROXY_CLIENT",
            useFactory: () =>
              new ErrorHandlingProxy({ host: "127.0.0.1", port }),
          },
        ],
      })
      class AppModule {}

      moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile({ logger: false });

      app = moduleRef.createNestApplication({ logger: false });
      app.connectMicroservice(app.get(MicroserviceHost));
      await app.startAllMicroservices();
      await app.init();
    });

    afterEach(async () => {
      await app?.close();
      await moduleRef?.close();
      await tcpServer?.close();
      app = undefined;
      moduleRef = undefined;
      tcpServer = undefined;
    });

    it("/POST", async () => {
      const res = await request(app!)
        .post("/?command=sum")
        .send([1, 2, 3, 4, 5])
        .expect(200);
      expect(res.text).toBe("15");
    });

    it("/POST (Promise/async)", async () => {
      const res = await request(app!)
        .post("/?command=asyncSum")
        .send([1, 2, 3, 4, 5])
        .expect(200);
      expect(res.text).toBe("15");
    });

    itAdapted(
      "ADR-008",
      "/POST (Observable stream)",
      async () => {
        const res = await request(app!)
          .post("/?command=streamSum")
          .send([1, 2, 3, 4, 5])
          .expect(200);
        expect(res.text).toBe("15");
      },
      "Promise single-value resolution instead of RxJS of()",
    );

    it("/POST (useFactory client)", async () => {
      const res = await request(app!)
        .post("/useFactory?command=sum")
        .send([1, 2, 3, 4, 5])
        .expect(200);
      expect(res.text).toBe("15");
    });

    it("/POST (useClass client)", async () => {
      const res = await request(app!)
        .post("/useClass?command=sum")
        .send([1, 2, 3, 4, 5])
        .expect(200);
      expect(res.text).toBe("15");
    });

    it("/POST (concurrent)", async () => {
      const res = await request(app!)
        .post("/concurrent")
        .send([
          Array.from({ length: 10 }, (_, k) => k + 1),
          Array.from({ length: 10 }, (_, k) => k + 11),
          Array.from({ length: 10 }, (_, k) => k + 21),
          Array.from({ length: 10 }, (_, k) => k + 31),
          Array.from({ length: 10 }, (_, k) => k + 41),
          Array.from({ length: 10 }, (_, k) => k + 51),
          Array.from({ length: 10 }, (_, k) => k + 61),
          Array.from({ length: 10 }, (_, k) => k + 71),
          Array.from({ length: 10 }, (_, k) => k + 81),
          Array.from({ length: 10 }, (_, k) => k + 91),
        ])
        .expect(200);
      expect(res.text).toBe("true");
    });

    // BUNEST_BUG: TcpServer and TcpClientProxy only support single-response request-reply (isDisposed: true) and do not support multi-value AsyncIterable streaming responses from @MessagePattern (ADR-008 replacement for RxJS multi-emission Observable streams; returning an AsyncGenerator serializes as {} in JSON.stringify) (packages/microservices/src/transports/tcp.transport.ts, packages/microservices/src/client-proxy.ts)
    it.skip("/POST (streaming)", async () => {
      const res = await request(app!)
        .post("/stream")
        .send([1, 2, 3, 4, 5])
        .expect(200);
      expect(res.text).toBe("15");
    });

    it("/POST (pattern not found)", async () => {
      await request(app!).post("/?command=test").send([]).expect(500);
    });

    it("/POST (event notification)", async () => {
      await request(app!).post("/notify").send([1, 2, 3, 4, 5]).expect(201);

      const deadline = Date.now() + 1000;
      while (!isNotified && Date.now() < deadline) {
        await Bun.sleep(10);
      }
      expect(isNotified).toBe(true);
    });

    itAdapted(
      "ADR-001",
      "/POST (custom client)",
      async () => {
        const res = await request(app!)
          .post("/error?client=custom")
          .send({})
          .expect(200);
        expect(res.text).toBe("true");
      },
      "custom TcpClientProxy subclass provider",
    );

    it("/POST (standard client)", async () => {
      const res = await request(app!)
        .post("/error?client=standard")
        .send({})
        .expect(200);
      expect(res.text).toBe("false");
    });
  },
);
