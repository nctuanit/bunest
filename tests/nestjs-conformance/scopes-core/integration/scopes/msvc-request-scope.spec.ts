import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  Scope,
  UseGuards,
  UseInterceptors,
  type CallHandler,
  type CanActivate,
  type DynamicModule,
  type ExecutionContext,
  type NestInterceptor,
  type Provider,
} from "../../../../../packages/common/src";
import type { BunestApplication } from "../../../../../packages/core/src";
import {
  MessagePattern,
  MicroserviceHost,
  MicroserviceModule,
  TcpClientProxy,
  TcpServer,
  Transport,
} from "../../../../../packages/microservices/src";
import {
  Test,
  describeConformance,
  expectScopeLeak,
  itAdapted,
  request,
} from "../../../_helpers";

class Meta {
  static COUNTER = 0;
  constructor() {
    Meta.COUNTER++;
  }
}

@Injectable({ scope: Scope.REQUEST })
class RequestGuard implements CanActivate {
  static COUNTER = 0;
  static REQUEST_SCOPED_DATA: number[] = [];

  constructor(@Inject("REQUEST_ID") private readonly requestId: number) {
    RequestGuard.COUNTER++;
  }

  canActivate(_context: ExecutionContext): boolean {
    RequestGuard.REQUEST_SCOPED_DATA.push(this.requestId);
    return true;
  }
}

@Injectable({ scope: Scope.REQUEST })
class RequestInterceptor implements NestInterceptor {
  static COUNTER = 0;
  static REQUEST_SCOPED_DATA: number[] = [];

  constructor(@Inject("REQUEST_ID") private readonly requestId: number) {
    RequestInterceptor.COUNTER++;
  }

  intercept(_context: ExecutionContext, call: CallHandler) {
    RequestInterceptor.REQUEST_SCOPED_DATA.push(this.requestId);
    return call.handle();
  }
}

@Injectable({ scope: Scope.REQUEST })
class HelloService {
  constructor(@Inject("META") public readonly meta: unknown) {}

  greeting(): string {
    return "Hello world!";
  }
}

@Injectable({ scope: Scope.REQUEST })
class UsersService {
  static COUNTER = 0;
  constructor(@Inject("META") public readonly meta: unknown) {
    UsersService.COUNTER++;
  }

  findById(id: string) {
    return { id };
  }
}

@Controller({ scope: Scope.REQUEST })
class HelloController {
  static COUNTER = 0;
  constructor(
    private readonly helloService: HelloService,
    private readonly usersService: UsersService,
  ) {
    HelloController.COUNTER++;
  }

  @UseGuards(RequestGuard)
  @UseInterceptors(RequestInterceptor)
  @MessagePattern("test")
  greeting(): string {
    return this.helloService.greeting();
  }
}

describeConformance(
  "Request scope (microservices)",
  {
    upstreamPath: "integration/scopes/e2e/msvc-request-scope.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008", "ADR-012"],
    notes:
      "Tests hybrid HTTP + TCP microservice request-scoped controllers, services, guards, and interceptors, plus ADR-012 fail-fast ScopeLeakException.",
  },
  () => {
    itAdapted(
      "ADR-012",
      "should throw ScopeLeakException when singleton microservice controller injects Scope.REQUEST service",
      async () => {
        @Controller()
        class LeakyMsvcController {
          constructor(private readonly helloService: HelloService) {}

          @MessagePattern("test")
          greeting() {
            return this.helloService.greeting();
          }
        }

        await expectScopeLeak(() =>
          Test.createTestingModule({
            controllers: [LeakyMsvcController],
            providers: [
              HelloService,
              { provide: "META", useClass: Meta },
            ],
          }).compile(),
        );
      },
    );

    // BUNEST_BUG: MicroserviceHost.collectLoadedInstances() skips Scope.REQUEST controllers (wrapper.instance is undefined) and compileHandler() does not create a per-message RequestContainer or resolve request-scoped controllers/guards/interceptors (packages/microservices/src/microservice-host.ts:59-78,318-395); GET /hello returns 500 ("No @MessagePattern() handler found for pattern \"test\"").
    describe.skip("when one service is request scoped (explicit Scope.REQUEST)", () => {
      let app: BunestApplication;
      let client: TcpClientProxy;

      beforeAll(async () => {
        Meta.COUNTER = 0;
        HelloController.COUNTER = 0;
        UsersService.COUNTER = 0;
        RequestInterceptor.COUNTER = 0;
        RequestInterceptor.REQUEST_SCOPED_DATA = [];
        RequestGuard.COUNTER = 0;
        RequestGuard.REQUEST_SCOPED_DATA = [];

        @Controller()
        class HttpController {
          @Get("hello")
          async testMsvc() {
            return client.send("test", { test: true });
          }
        }

        @Module({
          imports: [
            MicroserviceModule.forRoot({
              transport: Transport.TCP,
              options: { host: "127.0.0.1", port: 0 },
            }),
          ],
          controllers: [HelloController, HttpController],
          providers: [
            HelloService,
            UsersService,
            {
              provide: "REQUEST_ID",
              useFactory: () => 1,
              scope: Scope.REQUEST,
            },
          ],
        })
        class HelloModule {
          constructor(@Inject("META") public readonly meta: unknown) {}

          static forRoot(meta: Provider): DynamicModule {
            return {
              module: HelloModule,
              providers: [meta],
            };
          }
        }

        const moduleRef = await Test.createTestingModule({
          imports: [
            HelloModule.forRoot({
              provide: "META",
              useClass: Meta,
            }),
          ],
        }).compile();

        app = moduleRef.createNestApplication({ logger: false });
        const host = moduleRef.get(MicroserviceHost);
        app.connectMicroservice(host);
        await app.init();
        await app.startAllMicroservices();

        const tcpServer = host.getServers()[0] as TcpServer;
        client = new TcpClientProxy({
          host: "127.0.0.1",
          port: tcpServer.port!,
        });
        await client.connect();

        await request(app).get("/hello").expect(200);
        await request(app).get("/hello").expect(200);
        await request(app).get("/hello").expect(200);
      });

      afterAll(async () => {
        await client?.close();
        await app?.close();
      });

      it("should create controller for each request", () => {
        expect(HelloController.COUNTER).toEqual(3);
      });

      it("should create service for each request", () => {
        expect(UsersService.COUNTER).toEqual(3);
      });

      it("should share static provider across requests", () => {
        expect(Meta.COUNTER).toEqual(1);
      });

      it("should create request scoped interceptor for each request", () => {
        expect(RequestInterceptor.COUNTER).toEqual(3);
        expect(RequestInterceptor.REQUEST_SCOPED_DATA).toEqual([1, 1, 1]);
      });

      it("should create request scoped guard for each request", () => {
        expect(RequestGuard.COUNTER).toEqual(3);
        expect(RequestGuard.REQUEST_SCOPED_DATA).toEqual([1, 1, 1]);
      });
    });
  },
);
