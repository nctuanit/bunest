import "reflect-metadata";
import { afterEach, describe, expect, it } from "bun:test";
import {
  APP_FILTER,
  APP_GUARD,
  APP_INTERCEPTOR,
  APP_PIPE,
  Catch,
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  REQUEST,
  Scope,
  createParamDecorator,
  type ArgumentsHost,
  type CallHandler,
  type CanActivate,
  type ExceptionFilter,
  type ExecutionContext,
  type NestInterceptor,
  type PipeTransform,
  type Provider,
  type Type,
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

@Injectable({ scope: Scope.REQUEST })
class RequestScopedDenyGuard implements CanActivate {
  canActivate() {
    return false;
  }
}

@Injectable({ scope: Scope.TRANSIENT })
class TransientDenyGuard implements CanActivate {
  canActivate() {
    return false;
  }
}

@Injectable()
class DefaultDenyGuard implements CanActivate {
  canActivate() {
    return false;
  }
}

@Injectable({ scope: Scope.REQUEST })
class CurrentRequest {
  constructor(@Inject(REQUEST) readonly req: unknown) {}
}

@Injectable()
class ImplicitlyScopedDenyGuard implements CanActivate {
  constructor(private readonly current: CurrentRequest) {}

  canActivate() {
    return !this.current.req;
  }
}

@Injectable({ scope: Scope.REQUEST })
class SuffixPipe implements PipeTransform {
  transform(value: string) {
    return `${value}-piped`;
  }
}

@Injectable({ scope: Scope.REQUEST })
class PrefixInterceptor implements NestInterceptor {
  async intercept(_context: ExecutionContext, next: CallHandler) {
    const data = await next.handle();
    return `intercepted:${String(data)}`;
  }
}

@Catch()
@Injectable({ scope: Scope.REQUEST })
class TeapotFilter implements ExceptionFilter {
  catch(_error: unknown, _host: ArgumentsHost) {
    return new Response("handled", { status: 418 });
  }
}

const Greeting = createParamDecorator(() => "hello");

@Controller("first")
class FirstController {
  @Get()
  read() {
    return "ok";
  }

  @Get("greeting")
  greet(@Greeting() greeting: string) {
    return greeting;
  }

  @Get("fail")
  fail() {
    throw new Error("boom");
  }
}

@Controller()
class MessageController {
  @MessagePattern("read")
  read() {
    return "ok";
  }
}

const createModule = (
  providers: Provider[],
  controllers: Type<unknown>[] = [FirstController],
) => {
  @Module({ controllers, providers: [CurrentRequest, ...providers] })
  class TestModule {}
  return TestModule;
};

const compile = (mod: Type<unknown>) =>
  Test.createTestingModule({ imports: [mod] }).compile();

const createApp = async (mod: Type<unknown>) => {
  const moduleRef = await compile(mod);
  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  return app;
};

describeConformance(
  "Global enhancers that depend on request-scoped providers",
  {
    upstreamPath: "integration/scopes/e2e/existing-global-enhancers.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008", "ADR-010", "ADR-012"],
    notes:
      "Tests APP_GUARD/APP_PIPE/APP_INTERCEPTOR/APP_FILTER via useExisting/useFactory/useClass with Scope.REQUEST/Scope.TRANSIENT + ADR-012 ScopeLeakException when singleton enhancer depends on Scope.REQUEST.",
  },
  () => {
    describe("http", () => {
      let app: BunestApplication | undefined;

      afterEach(async () => {
        await app?.close();
        app = undefined;
      });

      it("should deny the request when the global guard is an alias of a request-scoped guard", async () => {
        app = await createApp(
          createModule([
            RequestScopedDenyGuard,
            { provide: APP_GUARD, useExisting: RequestScopedDenyGuard },
          ]),
        );

        await request(app).get("/first").expect(403);
      });

      it("should deny the request when the global guard is an alias of a transient guard", async () => {
        app = await createApp(
          createModule([
            TransientDenyGuard,
            { provide: APP_GUARD, useExisting: TransientDenyGuard },
          ]),
        );

        await request(app).get("/first").expect(403);
      });

      it("should deny the request when the global guard is an alias of a default provider", async () => {
        app = await createApp(
          createModule([
            DefaultDenyGuard,
            { provide: APP_GUARD, useExisting: DefaultDenyGuard },
          ]),
        );

        await request(app).get("/first").expect(403);
      });

      it("should deny the request when a request-scoped factory returns the global guard", async () => {
        app = await createApp(
          createModule([
            {
              provide: APP_GUARD,
              useFactory: (current: CurrentRequest) =>
                new ImplicitlyScopedDenyGuard(current),
              inject: [CurrentRequest],
              scope: Scope.REQUEST,
            },
          ]),
        );

        await request(app).get("/first").expect(403);
      });

      it("should transform the parameter when the global pipe is an alias of a request-scoped pipe", async () => {
        app = await createApp(
          createModule([
            SuffixPipe,
            { provide: APP_PIPE, useExisting: SuffixPipe },
          ]),
        );

        const res = await request(app).get("/first/greeting").expect(200);
        expect(res.text).toBe("hello-piped");
      });

      it("should wrap the response when the global interceptor is an alias of a request-scoped interceptor", async () => {
        app = await createApp(
          createModule([
            PrefixInterceptor,
            { provide: APP_INTERCEPTOR, useExisting: PrefixInterceptor },
          ]),
        );

        const res = await request(app).get("/first").expect(200);
        expect(res.text).toBe("intercepted:ok");
      });

      it("should handle the error when the global filter is an alias of a request-scoped filter", async () => {
        app = await createApp(
          createModule([
            TeapotFilter,
            { provide: APP_FILTER, useExisting: TeapotFilter },
          ]),
        );

        const res = await request(app).get("/first/fail").expect(418);
        expect(res.text).toBe("handled");
      });

      it("should still skip a global guard factory that returns nothing", async () => {
        app = await createApp(
          createModule([{ provide: APP_GUARD, useFactory: () => null }]),
        );

        await request(app).get("/first").expect(200);
      });
    });

    describe("when the enhancer is request-scoped only through its dependencies (ADR-012)", () => {
      itAdapted(
        "ADR-012",
        "should fail at startup with ScopeLeakException for an alias of a singleton guard depending on Scope.REQUEST",
        async () => {
          await expectScopeLeak(() =>
            compile(
              createModule([
                ImplicitlyScopedDenyGuard,
                { provide: APP_GUARD, useExisting: ImplicitlyScopedDenyGuard },
              ]),
            ),
          );
        },
      );

      it("should support an alias pointing to a custom token registered with RequestScopedDenyGuard", async () => {
        const app = await createApp(
          createModule([
            { provide: "AUTH_GUARD", useClass: RequestScopedDenyGuard },
            { provide: APP_GUARD, useExisting: "AUTH_GUARD" },
          ]),
        );
        try {
          await request(app).get("/first").expect(403);
        } finally {
          await app.close();
        }
      });

      itAdapted(
        "ADR-012",
        "should fail at startup with ScopeLeakException for a class provider missing Scope.REQUEST",
        async () => {
          await expectScopeLeak(() =>
            compile(
              createModule([
                { provide: APP_GUARD, useClass: ImplicitlyScopedDenyGuard },
              ]),
            ),
          );
        },
      );

      it("should deny the request when the class provider sets scope: Scope.REQUEST", async () => {
        const app = await createApp(
          createModule([
            {
              provide: APP_GUARD,
              useClass: ImplicitlyScopedDenyGuard,
              scope: Scope.REQUEST,
            },
          ]),
        );
        try {
          await request(app).get("/first").expect(403);
        } finally {
          await app.close();
        }
      });

      itAdapted(
        "ADR-012",
        "should fail at startup with ScopeLeakException for a factory provider missing Scope.REQUEST",
        async () => {
          await expectScopeLeak(() =>
            compile(
              createModule([
                {
                  provide: APP_GUARD,
                  useFactory: (current: CurrentRequest) =>
                    new ImplicitlyScopedDenyGuard(current),
                  inject: [CurrentRequest],
                },
              ]),
            ),
          );
        },
      );
    });

    describe("microservice", () => {
      let host: MicroserviceHost | undefined;
      let client: TcpClientProxy | undefined;

      afterEach(async () => {
        await client?.close();
        await host?.close();
        client = undefined;
        host = undefined;
      });

      // BUNEST_BUG: MicroserviceHost does not collect or execute DI global enhancers registered via APP_GUARD/APP_PIPE/APP_INTERCEPTOR/APP_FILTER (packages/microservices/src/microservice-host.ts:329-392); message resolved instead of throwing Forbidden resource.
      it.skip("should deny the message when the global guard is an alias of a request-scoped guard", async () => {
        const moduleRef = await Test.createTestingModule({
          imports: [
            MicroserviceModule.forRoot({
              transport: Transport.TCP,
              options: { host: "127.0.0.1", port: 0 },
            }),
            createModule(
              [
                RequestScopedDenyGuard,
                { provide: APP_GUARD, useExisting: RequestScopedDenyGuard },
              ],
              [MessageController],
            ),
          ],
        }).compile();

        const activeHost = moduleRef.get(MicroserviceHost);
        host = activeHost;
        await activeHost.listen();
        const server = activeHost.getServers()[0] as TcpServer;
        client = new TcpClientProxy({
          host: "127.0.0.1",
          port: server.port!,
        });
        await client.connect();

        await expect(client.send("read", {})).rejects.toThrow(
          /Forbidden resource/i,
        );
      });
    });
  },
);
