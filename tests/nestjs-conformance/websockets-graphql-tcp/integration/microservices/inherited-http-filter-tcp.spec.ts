import "reflect-metadata";
import { afterEach, expect } from "bun:test";
import {
  BadRequestException,
  Catch,
  Controller,
  HttpException,
  HttpStatus,
  Injectable,
  Module,
  UseFilters,
  UseGuards,
  UseInterceptors,
  UsePipes,
  type ArgumentsHost,
  type BunestInterceptor,
  type CallHandler,
  type CanActivate,
  type ExceptionFilter,
  type ExecutionContext,
  type PipeTransform,
} from "../../../../../packages/common/src";
import {
  BaseExceptionFilter,
  HttpAdapterHost,
  type BunestApplication,
} from "../../../../../packages/core/src";
import {
  MessagePattern,
  MicroserviceHost,
  MicroserviceModule,
  Payload,
  RpcException,
  TcpClientProxy,
  TcpServer,
} from "../../../../../packages/microservices/src";
import {
  Test,
  describeConformance,
  itAdapted,
  type TestingModule,
} from "../../../_helpers";

// The two catch-everything filters of the exception filters chapter. On RPC,
// calling switchToHttp() throws on RpcExecutionContext; every request must still
// be answered without hanging or breaking the TCP connection.
@Catch()
class CatchEverythingFilter implements ExceptionFilter {
  constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.httpAdapterHost;
    const ctx = host.switchToHttp();
    const httpStatus =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;
    const responseBody = {
      statusCode: httpStatus,
      timestamp: new Date().toISOString(),
      path: httpAdapter!.getRequestUrl(ctx.getRequest()),
    };
    httpAdapter!.reply(ctx.getResponse(), responseBody, httpStatus);
  }
}

@Catch()
class AllExceptionsFilter extends BaseExceptionFilter {
  override catch(exception: unknown, host: ArgumentsHost) {
    return super.catch(exception, host);
  }
}

@Catch()
class RpcStyleFilter implements ExceptionFilter {
  catch(exception: unknown) {
    const message =
      exception instanceof RpcException ? exception.getError() : "filtered";
    throw new RpcException(
      typeof message === "string"
        ? { status: "error", message }
        : (message as Record<string, unknown>),
    );
  }
}

class DenyGuard implements CanActivate {
  canActivate() {
    return false;
  }
}

@Injectable()
class BoomPipe implements PipeTransform {
  transform() {
    throw new BadRequestException("pipe");
  }
}

// With an interceptor bound, the handler runs inside the interceptor promise chain,
// so its error reaches the filters through the onion pipeline.
@Injectable()
class PassThroughInterceptor implements BunestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler) {
    return next.handle();
  }
}

@Controller()
class Svc {
  @MessagePattern("ok")
  ok(@Payload() data: { n: number }) {
    return { n: data.n + 1 };
  }

  @MessagePattern("throw")
  throwErr() {
    throw new Error("boom");
  }

  @MessagePattern("async")
  async asyncThrow() {
    throw new Error("async boom");
  }

  @MessagePattern("reject")
  reject() {
    return Promise.reject(new Error("rejected"));
  }

  @MessagePattern("http")
  http() {
    throw new BadRequestException("bad input");
  }

  @MessagePattern("rpc")
  rpc() {
    throw new RpcException("nope");
  }

  @UseGuards(DenyGuard)
  @MessagePattern("guard")
  guard() {
    return "nope";
  }

  @UsePipes(BoomPipe)
  @MessagePattern("pipe")
  pipe(@Payload() data: unknown) {
    return data;
  }

  @UseFilters(RpcStyleFilter)
  @MessagePattern("rpc-filter")
  rpcFilter() {
    throw new RpcException("kept");
  }

  @UseInterceptors(PassThroughInterceptor)
  @MessagePattern("intercepted")
  intercepted() {
    throw new Error("intercepted boom");
  }

  @MessagePattern("stream")
  async stream() {
    // ADR-008: Promise-based deferred rejection in place of RxJS defer(() => throwError(...))
    await Promise.resolve();
    throw new Error("stream boom");
  }
}

/**
 * A hybrid application whose TCP microservice inherits a global HTTP
 * exception filter (`inheritAppConfig`). The filter throws on the RPC
 * context, and every request must still be answered without timing out.
 */
describeConformance(
  "Inherited HTTP exception filter (TCP)",
  {
    upstreamPath:
      "integration/microservices/e2e/inherited-http-filter-tcp.spec.ts",
    category: "ADAPTED_PORT",
    adrs: ["ADR-001", "ADR-008"],
    notes:
      "Uses native TcpServer/TcpClientProxy (port: 0) with MicroserviceHost + inheritAppConfig: true and Promise-based RpcStyleFilter/deferred stream rejection instead of RxJS.",
  },
  () => {
    let moduleRef: TestingModule | undefined;
    let app: BunestApplication | undefined;
    let client: TcpClientProxy | undefined;

    afterEach(async () => {
      await client?.close();
      client = undefined;
      await app?.close();
      await moduleRef?.close();
      app = undefined;
      moduleRef = undefined;
    });

    async function connect(
      createFilter: (app: BunestApplication) => ExceptionFilter,
    ) {
      const tcpServer = new TcpServer({ host: "127.0.0.1", port: 0 });

      @Module({
        imports: [MicroserviceModule.forRoot({ server: tcpServer })],
        controllers: [Svc],
      })
      class AppModule {}

      moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile({ logger: false });

      app = moduleRef.createNestApplication({ logger: false });
      app.useGlobalFilters(createFilter(app));

      const host = app.get(MicroserviceHost);
      app.connectMicroservice(host, { inheritAppConfig: true });

      await app.startAllMicroservices();
      await app.init();

      const port = tcpServer.port!;
      expect(port).toBeGreaterThan(0);

      client = new TcpClientProxy({
        host: "127.0.0.1",
        port,
        defaultTimeoutMs: 1000,
      });
      await client.connect();
    }

    function call(pattern: string, data: unknown = { n: 1 }) {
      return client!.send(pattern, data, { timeoutMs: 1000 });
    }

    async function expectRejectsPromptly(pattern: string) {
      let caught: unknown;
      try {
        await call(pattern);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      // Must be answered by the server rather than hanging until client timeout
      expect((caught as Error).name).not.toBe("RpcTimeoutException");
    }

    async function expectEveryRequestAnswered() {
      await expect(call("ok")).resolves.toEqual({ n: 2 });
      await expectRejectsPromptly("throw");
      await expectRejectsPromptly("async");
      await expectRejectsPromptly("reject");
      await expectRejectsPromptly("http");
      await expectRejectsPromptly("rpc");
      await expectRejectsPromptly("guard");
      await expectRejectsPromptly("pipe");
      await expectRejectsPromptly("intercepted");
      await expectRejectsPromptly("stream");

      let rpcFilterErr: unknown;
      try {
        await call("rpc-filter");
      } catch (err) {
        rpcFilterErr = err;
      }
      expect(rpcFilterErr).toBeInstanceOf(RpcException);
      expect((rpcFilterErr as RpcException).getError()).toEqual({
        status: "error",
        message: "kept",
      });

      await expect(call("ok", { n: 4 })).resolves.toEqual({ n: 5 });
    }

    itAdapted(
      ["ADR-001", "ADR-008"],
      "answers the requests an inherited CatchEverythingFilter cannot",
      async () => {
        await connect(
          (a) => new CatchEverythingFilter(a.get(HttpAdapterHost)),
        );
        await expectEveryRequestAnswered();
      },
      "Bunest TCP error serialization + Promise pipeline",
    );

    itAdapted(
      ["ADR-001", "ADR-008"],
      "answers the requests an inherited AllExceptionsFilter cannot",
      async () => {
        await connect(
          (a) =>
            new AllExceptionsFilter(a.get(HttpAdapterHost).httpAdapter as any),
        );
        await expectEveryRequestAnswered();
      },
      "Bunest TCP error serialization + Promise pipeline",
    );
  },
);
